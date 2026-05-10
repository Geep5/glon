// Coin offer — atomic-swap replay, validation, and change builders.
//
// Offers are peer-to-peer atomic swaps mediated by chain.coin.offer objects.
// The state machine: open → funded → settled | cancelled.

import type { Block, Change, ValidationResult } from "../../proto.js";
import { parseUint } from "../../det/index.js";
import {
	OFFER_TYPE_KEY,
	decodeCoinOp,
	type CoinOp,
	type OfferState,
} from "./coin-types.js";

// Re-export for consumers that only need the offer layer
export { decodeCoinOp } from "./coin-types.js";

// ── Offer replay ───────────────────────────────────────────────────

export function replayOffer(blocks: Block[]): OfferState {
	const escrowed = new Map<string, { owner: string; amount: string; tokenId: string; spent: boolean }>();
	const payments = new Map<string, { owner: string; amount: string; tokenId: string; spent: boolean }>();
	const outputs = new Map<string, { owner: string; amount: string; tokenId: string }>();
	let status: OfferState["status"] = "open";

	// First pass: collect escrow and payment coins regardless of block order.
	// computeState topologically sorts changes, so settle may appear before escrow.
	for (const block of blocks) {
		const op = decodeCoinOp(block);
		if (!op) continue;
		if (op.kind === "offer_escrow") {
			escrowed.set(op.coinId, {
				owner: op.ownerPubkey ?? "",
				amount: op.amount ?? "0",
				tokenId: op.tokenId ?? "",
				spent: false,
			});
		} else if (op.kind === "offer_pay") {
			payments.set(op.coinId, {
				owner: op.ownerPubkey ?? "",
				amount: op.amount ?? "0",
				tokenId: op.tokenId ?? "",
				spent: false,
			});
		}
	}

	// Second pass: process state transitions (settle, cancel, outputs, claims).
	for (const block of blocks) {
		const op = decodeCoinOp(block);
		if (!op) continue;
		if (op.kind === "offer_settle") {
			for (const c of escrowed.values()) c.spent = true;
			for (const c of payments.values()) c.spent = true;
			if (op.outputs) {
				try {
					const parsed = JSON.parse(op.outputs) as Array<{ coin_id: string; owner_pubkey: string; amount: string; token_id: string }>;
					for (const o of parsed) {
						outputs.set(o.coin_id, {
							owner: o.owner_pubkey,
							amount: o.amount,
							tokenId: o.token_id,
						});
					}
				} catch {
					// ignore malformed outputs
				}
			}
			status = "settled";
		} else if (op.kind === "offer_cancel") {
			for (const c of escrowed.values()) c.spent = true;
			status = "cancelled";
		} else if (op.kind === "create") {
			outputs.set(op.coinId, {
				owner: op.ownerPubkey ?? "",
				amount: op.amount ?? "0",
				tokenId: op.tokenId ?? "",
			});
		} else if (op.kind === "spend") {
			outputs.delete(op.coinId);
		}
	}

	// Determine status: if escrowed and payments exist, it's funded
	if (status === "open" && payments.size > 0) {
		status = "funded";
	}

	return { status, escrowed, payments, outputs };
}

// ── Change builder ─────────────────────────────────────────────────

export function buildOfferGenesisChange(args: {
	offerId: string;
	timestamp: number;
	author: string;
	makerPubkey: string;
	terms: string;
}): Change {
	return {
		id: new Uint8Array(0),
		objectId: args.offerId,
		parentIds: [],
		ops: [
			{ objectCreate: { typeKey: OFFER_TYPE_KEY } },
			{ fieldSet: { key: "maker_pubkey", value: { stringValue: args.makerPubkey } } },
			{ fieldSet: { key: "terms", value: { stringValue: args.terms } } },
			{ fieldSet: { key: "status", value: { stringValue: "open" } } },
		],
		timestamp: args.timestamp,
		author: args.author,
	};
}

// ── Offer validator ────────────────────────────────────────────────

	export function classifyOfferChange(change: Change): { kind: "Genesis" } | { kind: "Op"; ops: CoinOp[] } | { kind: "Unknown"; reason: string } {
	const ops = change.ops ?? [];
	const hasCreate = ops.some((o) => !!o.objectCreate);
	const blockAdds = ops.filter((o) => !!o.blockAdd);

	if (hasCreate) {
		if (blockAdds.length > 0) return { kind: "Unknown", reason: "Genesis must not contain blocks" };
		return { kind: "Genesis" };
	}

	const coinOps: CoinOp[] = [];
	for (const ba of blockAdds) {
		const op = decodeCoinOp(ba.blockAdd!.block);
		if (!op) return { kind: "Unknown", reason: "Invalid chain.coin.op block in offer" };
		coinOps.push(op);
	}
	return { kind: "Op", ops: coinOps };
}

	export function validateOfferChange(
		change: Change,
		priorBlocks: Block[],
		_signerPubkey?: string,
		fields?: Record<string, any>,
	): ValidationResult {
		const classification = classifyOfferChange(change);

		if (classification.kind === "Unknown") {
			return { valid: false, error: `offer: ${classification.reason}` };
		}
		if (classification.kind === "Genesis") {
			if (priorBlocks.length > 0) return { valid: false, error: "offer: genesis must be first change" };
			const ops = change.ops ?? [];
			const hasMaker = ops.some((o) => o.fieldSet?.key === "maker_pubkey");
			const hasTerms = ops.some((o) => o.fieldSet?.key === "terms");
			if (!hasMaker) return { valid: false, error: "offer: genesis missing maker_pubkey" };
			if (!hasTerms) return { valid: false, error: "offer: genesis missing terms" };
			const termsOp = ops.find((o) => o.fieldSet?.key === "terms");
			if (termsOp?.fieldSet?.value?.stringValue) {
				try {
					const terms = JSON.parse(termsOp.fieldSet.value.stringValue) as { requested?: any[] };
					if (!terms.requested || terms.requested.length === 0) {
						return { valid: false, error: "offer: must request at least one token" };
					}
				} catch { /* ignore malformed terms */ }
			}
			return { valid: true };
		}

		const state = replayOffer(priorBlocks);
		const ops = classification.ops;

		// Only one offer state-changing op per change
		const stateOps = ops.filter((o) => o.kind === "offer_escrow" || o.kind === "offer_pay" || o.kind === "offer_settle" || o.kind === "offer_cancel");
		if (stateOps.length > 1) {
			return { valid: false, error: "offer: only one state op per change" };
		}

		// Helper to read terms from fields
		let terms: { offered: Array<{ tokenId: string; amount: string }>; requested: Array<{ tokenId: string; amount: string }> } | null = null;
		if (fields?.terms?.stringValue) {
			try { terms = JSON.parse(fields.terms.stringValue); } catch { /* ignore */ }
		}
		const makerPubkey = fields?.maker_pubkey?.stringValue ?? "";

		for (const op of ops) {
			if (op.kind === "offer_escrow") {
				if (state.status !== "open") return { valid: false, error: "offer: escrow only when open" };
				if (!op.ownerPubkey || !op.amount) {
					return { valid: false, error: "offer: escrow missing owner_pubkey or amount" };
				}
				try {
					parseUint(op.amount);
				} catch (e: any) {
					return { valid: false, error: `offer: escrow bad amount: ${e.message}` };
				}
				if (state.escrowed.has(op.coinId)) {
					return { valid: false, error: "offer: duplicate escrow coin_id" };
				}
			}

			if (op.kind === "offer_pay") {
				if (state.status !== "open" && state.status !== "funded") {
					return { valid: false, error: "offer: pay only when open or funded" };
				}
				if (!op.ownerPubkey || !op.amount) {
					return { valid: false, error: "offer: pay missing owner_pubkey or amount" };
				}
				try {
					parseUint(op.amount);
				} catch (e: any) {
					return { valid: false, error: `offer: pay bad amount: ${e.message}` };
				}
				if (state.payments.has(op.coinId)) {
					return { valid: false, error: "offer: duplicate payment coin_id" };
				}
			}

			if (op.kind === "offer_settle") {
				// v1: allow settle when open because payments may be in the same batch.
				if (state.status !== "open" && state.status !== "funded") {
					return { valid: false, error: "offer: settle only when open or funded" };
				}
				if (!op.outputs) {
					return { valid: false, error: "offer: settle missing outputs" };
				}
				let parsedOutputs: Array<{ coin_id: string; owner_pubkey: string; amount: string; token_id: string }>;
				try {
					parsedOutputs = JSON.parse(op.outputs);
				} catch {
					return { valid: false, error: "offer: settle outputs invalid JSON" };
				}
				if (!Array.isArray(parsedOutputs) || parsedOutputs.length === 0) {
					return { valid: false, error: "offer: settle outputs must be non-empty array" };
				}
				for (const out of parsedOutputs) {
					try {
						parseUint(out.amount);
					} catch (e: any) {
						return { valid: false, error: `offer: settle output bad amount: ${e.message}` };
					}
				}

				// Conservation of value: requested tokens go to maker, offered tokens go to payers.
				if (terms) {
					// Reject zero-requested offers (offers must have something requested)
					if (terms.requested.length === 0) {
						return { valid: false, error: "offer: must request at least one token" };
					}

					// Maker must receive exactly the requested amount for each requested token.
					for (const req of terms.requested) {
						const totalToMaker = parsedOutputs
							.filter((o) => o.token_id === req.tokenId && o.owner_pubkey === makerPubkey)
							.reduce((a, b) => a + BigInt(b.amount), 0n);
						if (totalToMaker !== BigInt(req.amount)) {
							return { valid: false, error: `offer: settle does not pay maker ${req.amount} ${req.tokenId}` };
						}
					}

					// Offered tokens: outputs to non-maker must equal escrowed amount.
					for (const off of terms.offered) {
						const escrowSum = Array.from(state.escrowed.values())
							.filter((c) => c.tokenId === off.tokenId)
							.reduce((a, b) => a + BigInt(b.amount), 0n);
						const outputSum = parsedOutputs
							.filter((o) => o.token_id === off.tokenId && o.owner_pubkey !== makerPubkey)
							.reduce((a, b) => a + BigInt(b.amount), 0n);
						if (escrowSum !== outputSum || outputSum !== BigInt(off.amount)) {
							return { valid: false, error: `offer: settle output mismatch for ${off.tokenId}` };
						}
					}
				}
			}

			if (op.kind === "offer_cancel") {
				if (state.status !== "open" && state.status !== "funded") {
					return { valid: false, error: "offer: cancel only when open or funded" };
				}
				if (_signerPubkey && makerPubkey && _signerPubkey !== makerPubkey) {
					return { valid: false, error: "offer: only maker can cancel" };
				}
			}

			if (op.kind === "create") {
				// Output coins after settlement — standard create validation
				if (!op.ownerPubkey || !op.amount) {
					return { valid: false, error: "offer: create output missing owner_pubkey or amount" };
				}
				try {
					parseUint(op.amount);
				} catch (e: any) {
					return { valid: false, error: `offer: create output bad amount: ${e.message}` };
				}
			}

			if (op.kind === "spend") {
				// Spending an output coin (claim)
				const out = state.outputs.get(op.coinId);
				if (!out) return { valid: false, error: "offer: spend of unknown output coin" };
				if (_signerPubkey && out.owner !== _signerPubkey) {
					return { valid: false, error: "offer: spend signer does not own output" };
				}
			}
		}

		return { valid: true };
	}
