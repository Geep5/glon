// swap-email — drives a full atomic swap end-to-end over email.
//
// User says (from any chat surface): "swap 5 FIG for 10 GOOTECK with bob@x.com".
// We:
//   1. Build the offer locally (escrow maker's coins).
//   2. Export the changes as a ChangeBundle.
//   3. Send via /transport-gmail with content_type=glon/swap-offer.
//   4. Watch the inbox. When bob's agent replies with glon/swap-response,
//      import the changes (which include his payment + signed settlement),
//      then claim our outputs.
//   5. On 48h timeout, on incoming glon/swap-decline, or on manual cancel,
//      cancel the local offer (cancel-return path returns coins to bucket).
//
// The receiver's flow is symmetric: receive offer → surface to human → on
// `swap-email accept <id>`, pay + settle + claim, send glon/swap-response;
// on `swap-email decline <id>` or 20-min approval timeout, send
// glon/swap-decline.
//
// Persistence: per-swap state lives in the /swap-email program object's
// `persisted_state` field, same pattern as /discord. Survives daemon restarts.
//
// Content handlers for glon/swap-offer, glon/swap-response, glon/swap-decline
// are registered with the transport-router at module load.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { registerContentHandler } from "../runtime.js";
import { dim, bold, cyan, green, red, yellow } from "../shared.js";
import { encodeTransportEnvelope, decodeTransportEnvelope, encodeChangeBundle, decodeChangeBundle, encodeChange, decodeChange } from "../../proto.js";
import { hexEncode, hexDecode } from "../../crypto.js";
import { buildCoinOpChange } from "./coin-bucket.js";
import { buildOfferGenesisChange, replayOffer } from "./coin-offer.js";
import { OFFER_TYPE_KEY, BUCKET_TYPE_KEY, type OfferTerms, type CoinOp, extractStr } from "./coin-types.js";
import { randomBytes, randomUUID } from "node:crypto";

// ── Constants ────────────────────────────────────────────────────

export const SWAP_OFFER_CONTENT_TYPE = "glon/swap-offer";
export const SWAP_RESPONSE_CONTENT_TYPE = "glon/swap-response";
export const SWAP_DECLINE_CONTENT_TYPE = "glon/swap-decline";

const DEFAULT_ORIGINATOR_TIMEOUT_S = 172_800;       // 48 h
const DEFAULT_RECEIVER_APPROVAL_TIMEOUT_S = 1_200;  // 20 min
const DEFAULT_STATUS_REPORT_INTERVAL_S = 86_400;    // 24 h
const WATCHER_TICK_MS = 60_000;
const SWAP_ID_BYTES = 4; // 8 hex chars

const PERSISTED_STATE_FIELD = "persisted_state";

// ── Types ────────────────────────────────────────────────────────

export type SwapStatus =
	| "sent"
	| "awaiting_human"
	| "completed"
	| "cancelled"
	| "declined"
	| "timed_out"
	| "error";

export interface SwapTermsCompact {
	offered: Array<{ tokenId: string; amount: string }>;
	requested: Array<{ tokenId: string; amount: string }>;
}

export interface SwapState {
	swap_id: string;
	role: "originator" | "responder";
	status: SwapStatus;
	counterparty_email: string;
	offer_id: string;
	key_name: string;
	terms: SwapTermsCompact;
	created_at: number;
	timeout_seconds: number;
	approval_deadline?: number;
	last_event: number;
	last_status_report?: number;
	error_msg?: string;
}

interface PersistedSwapState {
	swaps: Record<string, SwapState>;
}

interface BlobMeta {
	fromEndpoint?: string;
	receivedAt?: number;
	transportMetadata?: Record<string, string>;
}

// ── Config helpers ───────────────────────────────────────────────

function originatorTimeoutS(): number {
	const raw = process.env.SWAP_ORIGINATOR_TIMEOUT_SECONDS;
	if (!raw) return DEFAULT_ORIGINATOR_TIMEOUT_S;
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 60) return DEFAULT_ORIGINATOR_TIMEOUT_S;
	return n;
}

function receiverApprovalTimeoutS(): number {
	const raw = process.env.SWAP_RECEIVER_APPROVAL_TIMEOUT_SECONDS;
	if (!raw) return DEFAULT_RECEIVER_APPROVAL_TIMEOUT_S;
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 30) return DEFAULT_RECEIVER_APPROVAL_TIMEOUT_S;
	return n;
}

function statusReportIntervalS(): number {
	const raw = process.env.SWAP_STATUS_REPORT_INTERVAL_SECONDS;
	if (raw === undefined) return DEFAULT_STATUS_REPORT_INTERVAL_S;
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0) return DEFAULT_STATUS_REPORT_INTERVAL_S;
	return n;
}

// ── ID generation ────────────────────────────────────────────────

export function generateSwapId(): string {
	return randomBytes(SWAP_ID_BYTES).toString("hex");
}

// ── Persistence ──────────────────────────────────────────────────

function snapshotState(state: Record<string, any>): string {
	const swaps = (state.swaps ?? {}) as Record<string, SwapState>;
	return JSON.stringify({ swaps });
}

async function restoreState(state: Record<string, any>, ctx: ProgramContext): Promise<void> {
	if (!ctx.programId || !ctx.store) return;
	try {
		const obj = await (ctx.store as any).get(ctx.programId);
		const field = obj?.fields?.[PERSISTED_STATE_FIELD];
		const raw = typeof field === "string" ? field : field?.stringValue;
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedSwapState;
		if (parsed.swaps && typeof parsed.swaps === "object") {
			state.swaps = { ...parsed.swaps };
		}
		state._lastPersistedSnapshot = snapshotState(state);
	} catch (err: any) {
		ctx.print?.(dim(`  [swap-email] restore failed: ${err?.message ?? String(err)}`));
	}
}

async function persistIfChanged(state: Record<string, any>, ctx: ProgramContext): Promise<void> {
	if (!ctx.programId) return;
	const snap = snapshotState(state);
	if (state._lastPersistedSnapshot === snap) return;
	try {
		const actor = ctx.objectActor(ctx.programId) as any;
		if (typeof actor?.setField !== "function") return;
		await actor.setField(PERSISTED_STATE_FIELD, JSON.stringify(ctx.stringVal(snap)));
		state._lastPersistedSnapshot = snap;
	} catch (err: any) {
		ctx.print?.(dim(`  [swap-email] persist failed: ${err?.message ?? String(err)}`));
	}
}

function getSwap(state: Record<string, any>, swapId: string): SwapState | undefined {
	return (state.swaps as Record<string, SwapState> | undefined)?.[swapId];
}

function setSwap(state: Record<string, any>, swap: SwapState): void {
	state.swaps = state.swaps ?? {};
	(state.swaps as Record<string, SwapState>)[swap.swap_id] = swap;
}

// ── User notification ───────────────────────────────────────────

async function notifyUser(ctx: ProgramContext, text: string, urgency: "low" | "normal" | "high" = "normal"): Promise<void> {
	try {
		await ctx.dispatchProgram("/user-chat", "notify", [{ text, urgency, source: "swap-email" }]);
	} catch (err: any) {
		// /user-chat not running yet — print directly so the message isn't lost.
		ctx.print?.(`[swap-email${urgency !== "normal" ? ` ${urgency}` : ""}] ${text}`);
	}
}

// ── Terms helpers ────────────────────────────────────────────────

function termsSummary(terms: SwapTermsCompact): string {
	const off = terms.offered.map((t) => `${t.amount} ${t.tokenId.slice(0, 8)}`).join(" + ");
	const req = terms.requested.map((t) => `${t.amount} ${t.tokenId.slice(0, 8)}`).join(" + ");
	return `give ${off} for ${req}`;
}

// ── Orchestration: createOffer (originator side) ─────────────────

async function createOfferOrchestration(ctx: ProgramContext, args: {
	tokenId: string;
	amount: string;
	reqTokenId: string;
	reqAmount: string;
	keyName: string;
}): Promise<{ offerId: string; makerPubkey: string }> {
	const { dispatchProgram, objectActor, store, resolveId, client } = ctx;
	const storeAny = store as any;

	const tokenId = (await resolveId(args.tokenId)) ?? args.tokenId;
	const reqTokenId = (await resolveId(args.reqTokenId)) ?? args.reqTokenId;

	const keyInfo = await dispatchProgram("/wallet", "show", [args.keyName]) as { pubkey: string } | null;
	if (!keyInfo) throw new Error(`Wallet key "${args.keyName}" not found`);
	const makerPubkey = keyInfo.pubkey;

	const selected = await storeAny.coinSelect(tokenId, makerPubkey, args.amount) as Array<{ coin_id: string; bucket_id: string; amount: string }>;
	let sum = 0n;
	for (const c of selected) sum += BigInt(c.amount);
	if (sum < BigInt(args.amount)) {
		throw new Error(`Insufficient balance: have ${sum}, need ${args.amount}`);
	}

	const offerId = randomUUID().replace(/-/g, "").slice(0, 24);
	const batchEntries: Array<{ objectId: string; changesBase64: string }> = [];

	// 1. Spend maker's coins from their bucket(s).
	for (const coin of selected) {
		const bucketActor = objectActor(coin.bucket_id) as any;
		const heads = await bucketActor.getHeads() as string[];
		const spendChange = buildCoinOpChange({
			bucketId: coin.bucket_id,
			parentIds: heads.map(hexDecode),
			timestamp: Date.now(),
			author: "swap-email-create",
			op: { kind: "spend", coinId: coin.coin_id },
			blockId: randomUUID().replace(/-/g, "").slice(0, 16),
		});
		const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
		const nonce = await dispatchProgram("/consensus", "getNonce", [makerPubkey]) as number;
		const { changeB64: signedSpendB64 } = await dispatchProgram("/wallet", "signChange", [{
			name: args.keyName,
			changeB64: spendB64,
			nonce: nonce + 1,
			fee: 10,
		}]) as { changeB64: string };
		batchEntries.push({ objectId: coin.bucket_id, changesBase64: signedSpendB64 });
	}

	// 2. Offer genesis.
	const terms: OfferTerms = {
		offered: [{ tokenId, amount: args.amount }],
		requested: [{ tokenId: reqTokenId, amount: args.reqAmount }],
	};
	const genesisChange = buildOfferGenesisChange({
		offerId,
		timestamp: Date.now(),
		author: "swap-email-create",
		makerPubkey,
		terms: JSON.stringify(terms),
	});
	const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
	const genesisNonce = await dispatchProgram("/consensus", "getNonce", [makerPubkey]) as number;
	const { changeB64: signedGenesisB64 } = await dispatchProgram("/wallet", "signChange", [{
		name: args.keyName,
		changeB64: genesisB64,
		nonce: genesisNonce + 1,
		fee: 100,
	}]) as { changeB64: string };
	batchEntries.push({ objectId: offerId, changesBase64: signedGenesisB64 });

	const signedGenesisChange = decodeChange(Buffer.from(signedGenesisB64, "base64"));
	const genesisId = hexEncode(signedGenesisChange.id);

	// 3. Escrow each coin into the offer.
	for (const coin of selected) {
		const escrowChange = buildCoinOpChange({
			bucketId: offerId,
			parentIds: [hexDecode(genesisId)],
			timestamp: Date.now(),
			author: "swap-email-create",
			op: {
				kind: "offer_escrow",
				coinId: coin.coin_id,
				ownerPubkey: makerPubkey,
				amount: coin.amount,
				tokenId,
			},
			blockId: randomUUID().replace(/-/g, "").slice(0, 16),
		});
		const escrowB64 = Buffer.from(encodeChange(escrowChange)).toString("base64");
		const nonce = await dispatchProgram("/consensus", "getNonce", [makerPubkey]) as number;
		const { changeB64: signedEscrowB64 } = await dispatchProgram("/wallet", "signChange", [{
			name: args.keyName,
			changeB64: escrowB64,
			nonce: nonce + 1,
			fee: 10,
		}]) as { changeB64: string };
		batchEntries.push({ objectId: offerId, changesBase64: signedEscrowB64 });
	}

	const storeActor = (client as any).storeActor.getOrCreate(["root"]);
	await storeActor.pushChangesBatch(JSON.stringify(batchEntries));

	return { offerId, makerPubkey };
}

// ── Orchestration: acceptOffer (responder side) ──────────────────

async function acceptOfferOrchestration(ctx: ProgramContext, args: {
	offerId: string;
	keyName: string;
}): Promise<{ takerPubkey: string }> {
	const { dispatchProgram, objectActor, store, client } = ctx;
	const storeAny = store as any;

	const offerObj = await storeAny.get(args.offerId);
	if (!offerObj || offerObj.typeKey !== OFFER_TYPE_KEY) {
		throw new Error(`Not an offer: ${args.offerId}`);
	}
	const termsJson = extractStr(offerObj.fields?.terms);
	const terms = JSON.parse(termsJson) as OfferTerms;

	const keyInfo = await dispatchProgram("/wallet", "show", [args.keyName]) as { pubkey: string } | null;
	if (!keyInfo) throw new Error(`Wallet key "${args.keyName}" not found`);
	const takerPubkey = keyInfo.pubkey;

	const batchEntries: Array<{ objectId: string; changesBase64: string }> = [];

	// 1. For each requested token: spend taker's coins, pay into offer.
	for (const req of terms.requested) {
		const selected = await storeAny.coinSelect(req.tokenId, takerPubkey, req.amount) as Array<{ coin_id: string; bucket_id: string; amount: string }>;
		let sum = 0n;
		for (const c of selected) sum += BigInt(c.amount);
		if (sum < BigInt(req.amount)) {
			throw new Error(`Insufficient ${req.tokenId} balance: have ${sum}, need ${req.amount}`);
		}
		for (const coin of selected) {
			const bucketActor = objectActor(coin.bucket_id) as any;
			const heads = await bucketActor.getHeads() as string[];
			const spendChange = buildCoinOpChange({
				bucketId: coin.bucket_id,
				parentIds: heads.map(hexDecode),
				timestamp: Date.now(),
				author: "swap-email-accept",
				op: { kind: "spend", coinId: coin.coin_id },
				blockId: randomUUID().replace(/-/g, "").slice(0, 16),
			});
			const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
			const nonce = await dispatchProgram("/consensus", "getNonce", [takerPubkey]) as number;
			const { changeB64: signedSpendB64 } = await dispatchProgram("/wallet", "signChange", [{
				name: args.keyName,
				changeB64: spendB64,
				nonce: nonce + 1,
				fee: 10,
			}]) as { changeB64: string };
			batchEntries.push({ objectId: coin.bucket_id, changesBase64: signedSpendB64 });
		}
		for (const coin of selected) {
			const payChange = buildCoinOpChange({
				bucketId: args.offerId,
				parentIds: [],
				timestamp: Date.now(),
				author: "swap-email-accept",
				op: {
					kind: "offer_pay",
					coinId: coin.coin_id,
					ownerPubkey: takerPubkey,
					amount: coin.amount,
					tokenId: req.tokenId,
				},
				blockId: randomUUID().replace(/-/g, "").slice(0, 16),
			});
			const payB64 = Buffer.from(encodeChange(payChange)).toString("base64");
			const nonce = await dispatchProgram("/consensus", "getNonce", [takerPubkey]) as number;
			const { changeB64: signedPayB64 } = await dispatchProgram("/wallet", "signChange", [{
				name: args.keyName,
				changeB64: payB64,
				nonce: nonce + 1,
				fee: 10,
			}]) as { changeB64: string };
			batchEntries.push({ objectId: args.offerId, changesBase64: signedPayB64 });
		}
	}

	// 2. Build the settle: maker gets requested, taker gets offered.
	const makerPubkey = extractStr(offerObj.fields?.maker_pubkey);
	const outputs: Array<{ coin_id: string; owner_pubkey: string; amount: string; token_id: string }> = [];
	for (const req of terms.requested) {
		outputs.push({
			coin_id: randomUUID().replace(/-/g, "").slice(0, 16),
			owner_pubkey: makerPubkey,
			amount: req.amount,
			token_id: req.tokenId,
		});
	}
	for (const off of terms.offered) {
		outputs.push({
			coin_id: randomUUID().replace(/-/g, "").slice(0, 16),
			owner_pubkey: takerPubkey,
			amount: off.amount,
			token_id: off.tokenId,
		});
	}

	const settleChange = buildCoinOpChange({
		bucketId: args.offerId,
		parentIds: [],
		timestamp: Date.now(),
		author: "swap-email-accept",
		op: {
			kind: "offer_settle",
			coinId: randomUUID().replace(/-/g, "").slice(0, 16),
			outputs: JSON.stringify(outputs),
		},
		blockId: randomUUID().replace(/-/g, "").slice(0, 16),
	});
	const settleB64 = Buffer.from(encodeChange(settleChange)).toString("base64");
	const settleNonce = await dispatchProgram("/consensus", "getNonce", [takerPubkey]) as number;
	const { changeB64: signedSettleB64 } = await dispatchProgram("/wallet", "signChange", [{
		name: args.keyName,
		changeB64: settleB64,
		nonce: settleNonce + 1,
		fee: 10,
	}]) as { changeB64: string };
	batchEntries.push({ objectId: args.offerId, changesBase64: signedSettleB64 });

	// 3. Create output coins inside the offer (these are claimed later).
	for (const out of outputs) {
		const createChange = buildCoinOpChange({
			bucketId: args.offerId,
			parentIds: [],
			timestamp: Date.now(),
			author: "swap-email-accept",
			op: {
				kind: "create",
				coinId: out.coin_id,
				ownerPubkey: out.owner_pubkey,
				amount: out.amount,
				tokenId: out.token_id,
			},
			blockId: out.coin_id,
		});
		const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
		const nonce = await dispatchProgram("/consensus", "getNonce", [takerPubkey]) as number;
		const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
			name: args.keyName,
			changeB64: createB64,
			nonce: nonce + 1,
			fee: 1,
		}]) as { changeB64: string };
		batchEntries.push({ objectId: args.offerId, changesBase64: signedCreateB64 });
	}

	const storeActor = (client as any).storeActor.getOrCreate(["root"]);
	await storeActor.pushChangesBatch(JSON.stringify(batchEntries));

	return { takerPubkey };
}

// ── Orchestration: cancelOffer (return escrow to maker) ──────────

async function cancelOfferOrchestration(ctx: ProgramContext, args: {
	offerId: string;
	keyName: string;
}): Promise<{ returned: number }> {
	const { dispatchProgram, store, client } = ctx;
	const storeAny = store as any;

	const offerObj = await storeAny.get(args.offerId);
	if (!offerObj || offerObj.typeKey !== OFFER_TYPE_KEY) {
		throw new Error(`Not an offer: ${args.offerId}`);
	}
	const makerPubkey = extractStr(offerObj.fields?.maker_pubkey);

	const keyInfo = await dispatchProgram("/wallet", "show", [args.keyName]) as { pubkey: string } | null;
	if (!keyInfo) throw new Error(`Wallet key "${args.keyName}" not found`);
	if (keyInfo.pubkey !== makerPubkey) throw new Error("only maker can cancel");

	const state = replayOffer(offerObj.blocks ?? []);
	if (state.status !== "open" && state.status !== "funded") {
		throw new Error(`Offer is already ${state.status}`);
	}

	const batchEntries: Array<{ objectId: string; changesBase64: string }> = [];
	let returned = 0;

	for (const [, escrow] of state.escrowed) {
		if (escrow.spent) continue;
		returned++;
		const returnChange = buildCoinOpChange({
			bucketId: args.offerId,
			parentIds: [],
			timestamp: Date.now(),
			author: "swap-email-cancel",
			op: {
				kind: "create",
				coinId: randomUUID().replace(/-/g, "").slice(0, 16),
				ownerPubkey: escrow.owner,
				amount: escrow.amount,
				tokenId: escrow.tokenId,
			},
			blockId: randomUUID().replace(/-/g, "").slice(0, 16),
		});
		const returnB64 = Buffer.from(encodeChange(returnChange)).toString("base64");
		const nonce = await dispatchProgram("/consensus", "getNonce", [makerPubkey]) as number;
		const { changeB64: signedB64 } = await dispatchProgram("/wallet", "signChange", [{
			name: args.keyName,
			changeB64: returnB64,
			nonce: nonce + 1,
			fee: 1,
		}]) as { changeB64: string };
		batchEntries.push({ objectId: args.offerId, changesBase64: signedB64 });
	}

	const cancelChange = buildCoinOpChange({
		bucketId: args.offerId,
		parentIds: [],
		timestamp: Date.now(),
		author: "swap-email-cancel",
		op: {
			kind: "offer_cancel",
			coinId: randomUUID().replace(/-/g, "").slice(0, 16),
		},
		blockId: randomUUID().replace(/-/g, "").slice(0, 16),
	});
	const cancelB64 = Buffer.from(encodeChange(cancelChange)).toString("base64");
	const cancelNonce = await dispatchProgram("/consensus", "getNonce", [makerPubkey]) as number;
	const { changeB64: signedCancelB64 } = await dispatchProgram("/wallet", "signChange", [{
		name: args.keyName,
		changeB64: cancelB64,
		nonce: cancelNonce + 1,
		fee: 10,
	}]) as { changeB64: string };
	batchEntries.push({ objectId: args.offerId, changesBase64: signedCancelB64 });

	const storeActor = (client as any).storeActor.getOrCreate(["root"]);
	await storeActor.pushChangesBatch(JSON.stringify(batchEntries));

	return { returned };
}

// ── Orchestration: claimOffer (claim my output coins) ────────────

async function claimOfferOrchestration(ctx: ProgramContext, args: {
	offerId: string;
	keyName: string;
}): Promise<{ claimed: number }> {
	const { dispatchProgram, objectActor, store, client } = ctx;
	const storeAny = store as any;

	const offerObj = await storeAny.get(args.offerId);
	if (!offerObj || offerObj.typeKey !== OFFER_TYPE_KEY) {
		throw new Error(`Not an offer: ${args.offerId}`);
	}
	const keyInfo = await dispatchProgram("/wallet", "show", [args.keyName]) as { pubkey: string } | null;
	if (!keyInfo) throw new Error(`Wallet key "${args.keyName}" not found`);
	const claimerPubkey = keyInfo.pubkey;

	const state = replayOffer(offerObj.blocks ?? []);
	if (state.status !== "settled" && state.status !== "cancelled") {
		throw new Error(`Offer is not ready for claim (status: ${state.status})`);
	}
	// `outputs` holds only unspent claims — replayOffer.delete()s a coin
	// when a spend op replays past it, so we just need to filter by owner.
	const myOutputs = Array.from(state.outputs.entries()).filter(([, o]) => o.owner === claimerPubkey);
	if (myOutputs.length === 0) return { claimed: 0 };

	const batchEntries: Array<{ objectId: string; changesBase64: string }> = [];
	for (const [coinId, out] of myOutputs) {
		// Find a bucket of mine for this token.
		let bucketId: string | null = null;
		const refs = await storeAny.list(BUCKET_TYPE_KEY) as Array<{ id: string }>;
		for (const ref of refs) {
			const b = await storeAny.get(ref.id);
			const tid = b?.fields?.token_id?.linkValue?.targetId as string | undefined;
			if (tid === out.tokenId) { bucketId = ref.id; break; }
		}
		if (!bucketId) {
			throw new Error(`No bucket found for token ${out.tokenId} (mint or receive once first)`);
		}
		const bucketActor = objectActor(bucketId) as any;
		const heads = await bucketActor.getHeads() as string[];

		// Spend the output in the offer.
		const spendChange = buildCoinOpChange({
			bucketId: args.offerId,
			parentIds: [],
			timestamp: Date.now(),
			author: "swap-email-claim",
			op: { kind: "spend", coinId },
			blockId: randomUUID().replace(/-/g, "").slice(0, 16),
		});
		const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
		const nonce1 = await dispatchProgram("/consensus", "getNonce", [claimerPubkey]) as number;
		const { changeB64: signedSpendB64 } = await dispatchProgram("/wallet", "signChange", [{
			name: args.keyName,
			changeB64: spendB64,
			nonce: nonce1 + 1,
			fee: 10,
		}]) as { changeB64: string };
		batchEntries.push({ objectId: args.offerId, changesBase64: signedSpendB64 });

		// Create the coin in the claimer's bucket.
		const createChange = buildCoinOpChange({
			bucketId,
			parentIds: heads.map(hexDecode),
			timestamp: Date.now(),
			author: "swap-email-claim",
			op: { kind: "create", coinId: randomUUID().replace(/-/g, "").slice(0, 16), ownerPubkey: claimerPubkey, amount: out.amount, tokenId: out.tokenId },
			blockId: randomUUID().replace(/-/g, "").slice(0, 16),
		});
		const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
		const nonce2 = await dispatchProgram("/consensus", "getNonce", [claimerPubkey]) as number;
		const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
			name: args.keyName,
			changeB64: createB64,
			nonce: nonce2 + 1,
			fee: 10,
		}]) as { changeB64: string };
		batchEntries.push({ objectId: bucketId, changesBase64: signedCreateB64 });
	}

	const storeActor = (client as any).storeActor.getOrCreate(["root"]);
	await storeActor.pushChangesBatch(JSON.stringify(batchEntries));
	return { claimed: myOutputs.length };
}

// ── Bundle helpers ───────────────────────────────────────────────

async function exportOfferBundle(ctx: ProgramContext, offerId: string): Promise<string> {
	const result = await ctx.dispatchProgram("/swap", "exportOffer", [{ offerId, includeTokens: false }]) as { bundleBase64: string };
	if (!result?.bundleBase64) throw new Error(`exportOffer returned empty bundle for ${offerId}`);
	return result.bundleBase64;
}

async function importOfferBundle(ctx: ProgramContext, bundleB64: string, keyName: string): Promise<{ offerId: string; status: string; missingTokens?: Array<{ tokenId: string }> }> {
	return await ctx.dispatchProgram("/swap", "importOffer", [{ bundleBase64: bundleB64, keyName }]) as { offerId: string; status: string };
}

async function sendEnvelope(ctx: ProgramContext, opts: {
	recipientEmail: string;
	contentType: string;
	payload: Uint8Array;
	subject: string;
	metadata?: Record<string, string>;
}): Promise<void> {
	const envelope = encodeTransportEnvelope({
		contentType: opts.contentType,
		payload: opts.payload,
		senderPubkey: new Uint8Array(0),
		metadata: opts.metadata ?? {},
	});
	const payloadB64 = Buffer.from(envelope).toString("base64");
	await ctx.dispatchProgram("/transport-gmail", "send", [{
		endpoint: `gmail://${opts.recipientEmail}`,
		payload_b64: payloadB64,
		content_type: opts.contentType,
		metadata: { subject: opts.subject, ...(opts.metadata ?? {}) },
	}]);
}

// ── Re-export changes after accept (for response bundle) ─────────

async function exportFreshChanges(ctx: ProgramContext, offerId: string): Promise<string> {
	// /swap exportOffer reads ${GLON_DATA}/changes/<offerId>/*.pb so it'll
	// pick up both the original genesis+escrow and the new pay+settle+create
	// changes. A receiver who imports this bundle will get the full state.
	return await exportOfferBundle(ctx, offerId);
}

// ── High-level flows ─────────────────────────────────────────────

interface StartSwapInput {
	tokenGive: string;
	amountGive: string;
	tokenWant: string;
	amountWant: string;
	recipientEmail: string;
	keyName?: string;
	timeoutSeconds?: number;
}

async function startSwap(ctx: ProgramContext, input: StartSwapInput): Promise<{ swap_id: string; offer_id: string }> {
	const recipient = (input.recipientEmail || "").trim().toLowerCase();
	if (!recipient || !recipient.includes("@")) {
		throw new Error(`Invalid recipient email: ${input.recipientEmail}`);
	}
	const keyName = input.keyName ?? "default";
	const timeoutS = input.timeoutSeconds ?? originatorTimeoutS();
	const swapId = generateSwapId();

	const { offerId, makerPubkey } = await createOfferOrchestration(ctx, {
		tokenId: input.tokenGive,
		amount: input.amountGive,
		reqTokenId: input.tokenWant,
		reqAmount: input.amountWant,
		keyName,
	});

	const terms: SwapTermsCompact = {
		offered: [{ tokenId: input.tokenGive, amount: input.amountGive }],
		requested: [{ tokenId: input.tokenWant, amount: input.amountWant }],
	};

	const bundleB64 = await exportOfferBundle(ctx, offerId);
	const bundleBytes = Buffer.from(bundleB64, "base64");

	await sendEnvelope(ctx, {
		recipientEmail: recipient,
		contentType: SWAP_OFFER_CONTENT_TYPE,
		payload: new Uint8Array(bundleBytes),
		subject: `swap-offer ${swapId}`,
		metadata: {
			swap_id: swapId,
			maker_pubkey: makerPubkey,
			terms_json: JSON.stringify(terms),
		},
	});

	const swap: SwapState = {
		swap_id: swapId,
		role: "originator",
		status: "sent",
		counterparty_email: recipient,
		offer_id: offerId,
		key_name: keyName,
		terms,
		created_at: Date.now(),
		timeout_seconds: timeoutS,
		last_event: Date.now(),
	};
	setSwap(ctx.state, swap);
	await persistIfChanged(ctx.state, ctx);

	await notifyUser(ctx, `Swap ${swapId} → ${recipient}: ${termsSummary(terms)}. Waiting for response (timeout ${Math.round(timeoutS / 60)} min).`);
	return { swap_id: swapId, offer_id: offerId };
}

async function handleIncomingOffer(ctx: ProgramContext, envelope: { contentType: string; payload: Uint8Array; metadata: Record<string, string> }, blobMeta: BlobMeta): Promise<boolean> {
	const swapId = envelope.metadata?.swap_id;
	if (!swapId) {
		ctx.print?.(dim("[swap-email] incoming offer missing swap_id metadata"));
		return false;
	}
	const existing = getSwap(ctx.state, swapId);
	if (existing) {
		// Already saw this swap — idempotent ignore.
		return true;
	}

	const fromEndpoint = blobMeta.fromEndpoint ?? "";
	const counterpartyEmail = fromEndpoint.replace(/^gmail:\/\//, "").toLowerCase();
	if (!counterpartyEmail) {
		ctx.print?.(dim(`[swap-email] incoming offer ${swapId} has no fromEndpoint`));
		return false;
	}

	const bundleB64 = Buffer.from(envelope.payload).toString("base64");
	const keyName = process.env.GLON_DEFAULT_KEY_NAME ?? "default";

	let importResult: { offerId: string; status: string; missingTokens?: Array<{ tokenId: string }> };
	try {
		importResult = await importOfferBundle(ctx, bundleB64, keyName);
	} catch (err: any) {
		ctx.print?.(red(`[swap-email] import of incoming offer ${swapId} failed: ${err?.message ?? String(err)}`));
		return false;
	}

	if (importResult.status === "missing_tokens") {
		await notifyUser(ctx, `Incoming swap ${swapId} from ${counterpartyEmail} references tokens you don't have locally. Import token genesis bundles first. Missing: ${(importResult.missingTokens ?? []).map((t) => t.tokenId.slice(0, 8)).join(", ")}`, "high");
		return false;
	}

	let terms: SwapTermsCompact;
	try {
		terms = JSON.parse(envelope.metadata.terms_json ?? "{}") as SwapTermsCompact;
		if (!terms.offered || !terms.requested) throw new Error("missing fields");
	} catch {
		// Fall back to reading offer object directly.
		const offerObj = await (ctx.store as any).get(importResult.offerId);
		const termsJson = extractStr(offerObj?.fields?.terms);
		try { terms = JSON.parse(termsJson) as SwapTermsCompact; }
		catch { terms = { offered: [], requested: [] }; }
	}

	const now = Date.now();
	const approvalDeadline = now + receiverApprovalTimeoutS() * 1000;
	const swap: SwapState = {
		swap_id: swapId,
		role: "responder",
		status: "awaiting_human",
		counterparty_email: counterpartyEmail,
		offer_id: importResult.offerId,
		key_name: keyName,
		terms,
		created_at: now,
		timeout_seconds: receiverApprovalTimeoutS(),
		approval_deadline: approvalDeadline,
		last_event: now,
	};
	setSwap(ctx.state, swap);
	await persistIfChanged(ctx.state, ctx);

	const minutes = Math.round(receiverApprovalTimeoutS() / 60);
	await notifyUser(
		ctx,
		[
			`Incoming swap ${swapId} from ${counterpartyEmail}`,
			`  they offer: ${terms.offered.map((t) => `${t.amount} ${t.tokenId.slice(0, 8)}`).join(" + ")}`,
			`  they want:  ${terms.requested.map((t) => `${t.amount} ${t.tokenId.slice(0, 8)}`).join(" + ")}`,
			``,
			`To accept: \`/swap-email accept ${swapId}\``,
			`To decline: \`/swap-email decline ${swapId}\``,
			`Auto-declines in ${minutes} min if no response.`,
		].join("\n"),
		"high",
	);

	return true;
}

async function acceptSwap(ctx: ProgramContext, swapId: string): Promise<void> {
	const swap = getSwap(ctx.state, swapId);
	if (!swap) throw new Error(`Unknown swap: ${swapId}`);
	if (swap.role !== "responder") throw new Error(`Swap ${swapId} is not awaiting your decision (role: ${swap.role})`);
	if (swap.status !== "awaiting_human") throw new Error(`Swap ${swapId} is in state ${swap.status}, can't accept`);

	try {
		await acceptOfferOrchestration(ctx, { offerId: swap.offer_id, keyName: swap.key_name });
	} catch (err: any) {
		swap.status = "error";
		swap.error_msg = err?.message ?? String(err);
		swap.last_event = Date.now();
		setSwap(ctx.state, swap);
		await persistIfChanged(ctx.state, ctx);
		await notifyUser(ctx, `Swap ${swapId} accept failed: ${swap.error_msg}`, "high");
		throw err;
	}

	// Build response bundle (the offer's full set of changes now includes
	// our pay/settle/create), send to originator.
	const bundleB64 = await exportFreshChanges(ctx, swap.offer_id);
	const bundleBytes = Buffer.from(bundleB64, "base64");

	await sendEnvelope(ctx, {
		recipientEmail: swap.counterparty_email,
		contentType: SWAP_RESPONSE_CONTENT_TYPE,
		payload: new Uint8Array(bundleBytes),
		subject: `swap-response ${swapId}`,
		metadata: { swap_id: swapId, original_offer_id: swap.offer_id },
	});

	// Claim our outputs locally so the assets land in our bucket.
	let claimed = 0;
	try {
		const r = await claimOfferOrchestration(ctx, { offerId: swap.offer_id, keyName: swap.key_name });
		claimed = r.claimed;
	} catch (err: any) {
		ctx.print?.(yellow(`[swap-email] swap ${swapId} settled but claim failed: ${err?.message ?? String(err)}`));
	}

	swap.status = "completed";
	swap.last_event = Date.now();
	setSwap(ctx.state, swap);
	await persistIfChanged(ctx.state, ctx);

	await notifyUser(ctx, `Swap ${swapId} completed. Claimed ${claimed} output(s); response sent to ${swap.counterparty_email}.`);
}

async function declineSwap(ctx: ProgramContext, swapId: string, reason: "explicit_decline" | "approval_timeout"): Promise<void> {
	const swap = getSwap(ctx.state, swapId);
	if (!swap) throw new Error(`Unknown swap: ${swapId}`);
	if (swap.role !== "responder") throw new Error(`Swap ${swapId} is not yours to decline (role: ${swap.role})`);
	if (swap.status !== "awaiting_human") throw new Error(`Swap ${swapId} is in state ${swap.status}, can't decline`);

	const declinePayload = JSON.stringify({ swap_id: swapId, reason });
	const inner = encodeTransportEnvelope({
		contentType: SWAP_DECLINE_CONTENT_TYPE,
		payload: new TextEncoder().encode(declinePayload),
		senderPubkey: new Uint8Array(0),
		metadata: { swap_id: swapId, reason },
	});

	try {
		await ctx.dispatchProgram("/transport-gmail", "send", [{
			endpoint: `gmail://${swap.counterparty_email}`,
			payload_b64: Buffer.from(inner).toString("base64"),
			content_type: SWAP_DECLINE_CONTENT_TYPE,
			metadata: { subject: `swap-decline ${swapId}`, swap_id: swapId, reason },
		}]);
	} catch (err: any) {
		ctx.print?.(yellow(`[swap-email] decline send failed for ${swapId}: ${err?.message ?? String(err)}`));
	}

	swap.status = "cancelled";
	swap.last_event = Date.now();
	setSwap(ctx.state, swap);
	await persistIfChanged(ctx.state, ctx);

	const userMsg = reason === "approval_timeout"
		? `Swap ${swapId}: auto-declined after the approval window expired.`
		: `Swap ${swapId}: declined and notified ${swap.counterparty_email}.`;
	await notifyUser(ctx, userMsg);
}

async function cancelSwap(ctx: ProgramContext, swapId: string, reason: "manual" | "timeout" | "incoming_decline" = "manual"): Promise<void> {
	const swap = getSwap(ctx.state, swapId);
	if (!swap) throw new Error(`Unknown swap: ${swapId}`);
	if (swap.role !== "originator") throw new Error(`Only originators can cancel; swap ${swapId} role is ${swap.role}`);
	if (swap.status !== "sent") {
		// Already done; just record.
		return;
	}

	let returned = 0;
	try {
		const r = await cancelOfferOrchestration(ctx, { offerId: swap.offer_id, keyName: swap.key_name });
		returned = r.returned;
	} catch (err: any) {
		ctx.print?.(red(`[swap-email] cancel of ${swapId} failed: ${err?.message ?? String(err)}`));
		// Do not flip state — let next tick retry.
		return;
	}

	// Claim the returned coins so they actually land in the bucket.
	try {
		await claimOfferOrchestration(ctx, { offerId: swap.offer_id, keyName: swap.key_name });
	} catch (err: any) {
		ctx.print?.(yellow(`[swap-email] coins returned but claim failed for ${swapId}: ${err?.message ?? String(err)}`));
	}

	swap.status = reason === "timeout" ? "timed_out" : reason === "incoming_decline" ? "declined" : "cancelled";
	swap.last_event = Date.now();
	setSwap(ctx.state, swap);
	await persistIfChanged(ctx.state, ctx);

	const userMsg = reason === "timeout"
		? `Swap ${swapId} timed out after ${Math.round(swap.timeout_seconds / 60)} min. ${returned} coin(s) returned.`
		: reason === "incoming_decline"
		? `Swap ${swapId} declined by ${swap.counterparty_email}. ${returned} coin(s) returned.`
		: `Swap ${swapId} cancelled. ${returned} coin(s) returned.`;
	await notifyUser(ctx, userMsg);
}

async function handleIncomingResponse(ctx: ProgramContext, envelope: { payload: Uint8Array; metadata: Record<string, string> }, blobMeta: BlobMeta): Promise<boolean> {
	const swapId = envelope.metadata?.swap_id;
	if (!swapId) return false;
	const swap = getSwap(ctx.state, swapId);
	if (!swap) {
		ctx.print?.(dim(`[swap-email] response for unknown swap ${swapId}, ignoring`));
		return false;
	}
	if (swap.role !== "originator") return false;
	if (swap.status !== "sent") {
		ctx.print?.(dim(`[swap-email] response for ${swapId} arrived but state is ${swap.status}, ignoring`));
		return false;
	}

	// Verify the response came from the email we sent the offer to.
	const fromEmail = (blobMeta.fromEndpoint ?? "").replace(/^gmail:\/\//, "").toLowerCase();
	if (fromEmail && fromEmail !== swap.counterparty_email) {
		await notifyUser(ctx, `Swap ${swapId} got a response from unexpected email ${fromEmail} (expected ${swap.counterparty_email}); refusing to apply.`, "high");
		return false;
	}

	const bundleB64 = Buffer.from(envelope.payload).toString("base64");
	try {
		await importOfferBundle(ctx, bundleB64, swap.key_name);
	} catch (err: any) {
		ctx.print?.(red(`[swap-email] failed to import response for ${swapId}: ${err?.message ?? String(err)}`));
		return false;
	}

	let claimed = 0;
	try {
		const r = await claimOfferOrchestration(ctx, { offerId: swap.offer_id, keyName: swap.key_name });
		claimed = r.claimed;
	} catch (err: any) {
		ctx.print?.(yellow(`[swap-email] settled but claim failed for ${swapId}: ${err?.message ?? String(err)}`));
	}

	swap.status = "completed";
	swap.last_event = Date.now();
	setSwap(ctx.state, swap);
	await persistIfChanged(ctx.state, ctx);

	await notifyUser(ctx, `Swap ${swapId} completed. Claimed ${claimed} output(s) from ${swap.counterparty_email}.`);
	return true;
}

async function handleIncomingDecline(ctx: ProgramContext, envelope: { payload: Uint8Array; metadata: Record<string, string> }, blobMeta: BlobMeta): Promise<boolean> {
	const swapId = envelope.metadata?.swap_id;
	if (!swapId) return false;
	const swap = getSwap(ctx.state, swapId);
	if (!swap) return false;
	if (swap.role !== "originator") return false;
	if (swap.status !== "sent") return false;

	const fromEmail = (blobMeta.fromEndpoint ?? "").replace(/^gmail:\/\//, "").toLowerCase();
	if (fromEmail && fromEmail !== swap.counterparty_email) {
		ctx.print?.(dim(`[swap-email] decline for ${swapId} from unexpected sender ${fromEmail}, ignoring`));
		return false;
	}

	let reason = envelope.metadata?.reason ?? "explicit_decline";
	try {
		const inner = JSON.parse(new TextDecoder().decode(envelope.payload)) as { reason?: string };
		if (inner?.reason) reason = inner.reason;
	} catch { /* not JSON; metadata-only is fine */ }

	await cancelSwap(ctx, swapId, "incoming_decline");
	const reasonText = reason === "approval_timeout" ? " (their human didn't respond in time)" : "";
	await notifyUser(ctx, `Swap ${swapId} declined by ${swap.counterparty_email}${reasonText}.`);
	return true;
}

// ── Watcher tick ─────────────────────────────────────────────────

async function tickWatcher(ctx: ProgramContext): Promise<void> {
	const state = ctx.state;
	const swaps = (state.swaps ?? {}) as Record<string, SwapState>;
	const now = Date.now();
	const reportIntervalMs = statusReportIntervalS() * 1000;

	for (const swapId of Object.keys(swaps)) {
		const swap = swaps[swapId];
		if (!swap) continue;
		try {
			if (swap.role === "originator" && swap.status === "sent") {
				const deadline = swap.created_at + swap.timeout_seconds * 1000;
				if (now >= deadline) {
					await cancelSwap(ctx, swapId, "timeout");
					continue;
				}
				if (reportIntervalMs > 0) {
					const lastReport = swap.last_status_report ?? swap.created_at;
					if (now - lastReport >= reportIntervalMs) {
						await notifyUser(ctx, `Swap ${swapId} → ${swap.counterparty_email} still pending. ${Math.round((deadline - now) / 60_000)} min until timeout.`, "low");
						swap.last_status_report = now;
						setSwap(state, swap);
					}
				}
			}
			if (swap.role === "responder" && swap.status === "awaiting_human") {
				if (swap.approval_deadline && now >= swap.approval_deadline) {
					await declineSwap(ctx, swapId, "approval_timeout");
				}
			}
		} catch (err: any) {
			ctx.print?.(dim(`[swap-email] tick error on ${swapId}: ${err?.message ?? String(err)}`));
		}
	}

	await persistIfChanged(state, ctx);
}

// ── CLI handler ──────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	if (cmd === "start") {
		// swap-email start <token-give> <amount-give> for <token-want> <amount-want> with <recipient>
		const positional = args.filter((a) => !a.startsWith("--"));
		const flags = args.filter((a) => a.startsWith("--"));
		const keyArg = flags.find((f) => f.startsWith("--key="));
		const timeoutArg = flags.find((f) => f.startsWith("--timeout="));
		const keyName = keyArg ? keyArg.slice(6) : "default";
		const timeoutSeconds = timeoutArg ? parseInt(timeoutArg.slice(10), 10) : undefined;

		// Allow with-prepositions or positional-only:
		//   start <give> <amt> <want> <want_amt> <email>
		//   start <give> <amt> for <want> <want_amt> with <email>
		const cleaned = positional.filter((p) => p !== "for" && p !== "with");
		if (cleaned.length < 5) {
			print(red(`Usage: /swap-email start <token-give> <amount-give> [for] <token-want> <amount-want> [with] <recipient-email> [--key=name] [--timeout=<seconds>]`));
			return;
		}
		const [tokenGive, amountGive, tokenWant, amountWant, recipientEmail] = cleaned;
		try {
			const r = await startSwap(ctx, {
				tokenGive, amountGive, tokenWant, amountWant,
				recipientEmail,
				keyName,
				timeoutSeconds,
			});
			print(green(`Swap ${r.swap_id} sent to ${recipientEmail}`));
			print(dim(`  offer_id: ${r.offer_id}`));
			print(dim(`  status:   sent (waiting for response)`));
		} catch (err: any) {
			print(red(`Error: ${err?.message ?? String(err)}`));
		}
		return;
	}

	if (cmd === "accept") {
		const swapId = args[0];
		if (!swapId) { print(red("Usage: /swap-email accept <swap-id>")); return; }
		try {
			await acceptSwap(ctx, swapId);
			print(green(`Swap ${swapId} accepted.`));
		} catch (err: any) {
			print(red(`Error: ${err?.message ?? String(err)}`));
		}
		return;
	}

	if (cmd === "decline") {
		const swapId = args[0];
		if (!swapId) { print(red("Usage: /swap-email decline <swap-id>")); return; }
		try {
			await declineSwap(ctx, swapId, "explicit_decline");
			print(green(`Swap ${swapId} declined.`));
		} catch (err: any) {
			print(red(`Error: ${err?.message ?? String(err)}`));
		}
		return;
	}

	if (cmd === "cancel") {
		const swapId = args[0];
		if (!swapId) { print(red("Usage: /swap-email cancel <swap-id>")); return; }
		try {
			await cancelSwap(ctx, swapId, "manual");
			print(green(`Swap ${swapId} cancellation processed.`));
		} catch (err: any) {
			print(red(`Error: ${err?.message ?? String(err)}`));
		}
		return;
	}

	if (cmd === "status") {
		const swapId = args[0];
		const swaps = (ctx.state.swaps ?? {}) as Record<string, SwapState>;
		if (swapId) {
			const swap = swaps[swapId];
			if (!swap) { print(red(`No such swap: ${swapId}`)); return; }
			printSwap(ctx, swap);
			return;
		}
		const ids = Object.keys(swaps);
		if (ids.length === 0) { print(dim("(no swaps)")); return; }
		print(bold(`  ${ids.length} swap(s):`));
		for (const id of ids) printSwap(ctx, swaps[id]);
		return;
	}

	if (cmd === "list") {
		const swaps = (ctx.state.swaps ?? {}) as Record<string, SwapState>;
		const ids = Object.keys(swaps).sort((a, b) => swaps[b].created_at - swaps[a].created_at);
		if (ids.length === 0) { print(dim("(no swaps)")); return; }
		for (const id of ids) {
			const s = swaps[id];
			const age = Math.round((Date.now() - s.created_at) / 60_000);
			print(`  ${cyan(id)}  ${s.role.padEnd(10)} ${s.status.padEnd(14)} ${dim(s.counterparty_email)}  ${dim(age + "m ago")}`);
		}
		return;
	}

	if (cmd === "tick") {
		await tickWatcher(ctx);
		print(green("watcher tick complete"));
		return;
	}

	print([
		bold("  swap-email") + dim(" — email-mediated agent-to-agent atomic swaps"),
		`    ${cyan("/swap-email start")} ${dim("<give> <amt> for <want> <amt> with <email> [--key=name] [--timeout=<s>]")}`,
		`    ${cyan("/swap-email accept")}  ${dim("<swap-id>")}    accept an incoming swap (responder)`,
		`    ${cyan("/swap-email decline")} ${dim("<swap-id>")}    decline an incoming swap (responder)`,
		`    ${cyan("/swap-email cancel")}  ${dim("<swap-id>")}    cancel an outgoing swap (originator)`,
		`    ${cyan("/swap-email status")}  ${dim("[<swap-id>]")}  show one swap or all`,
		`    ${cyan("/swap-email list")}                 list all swaps`,
		`    ${cyan("/swap-email tick")}                 manually run the watcher`,
		"",
		dim("    Originator timeout default 48h, receiver-approval default 20min — both env-overridable."),
	].join("\n"));
};

function printSwap(ctx: ProgramContext, swap: SwapState): void {
	const { print } = ctx;
	print(`  ${bold(swap.swap_id)}  ${swap.role}  ${swap.status}`);
	print(dim(`    counterparty: ${swap.counterparty_email}`));
	print(dim(`    offer:        ${swap.offer_id}`));
	print(dim(`    terms:        ${termsSummary(swap.terms)}`));
	print(dim(`    created:      ${new Date(swap.created_at).toISOString()}`));
	if (swap.role === "originator") {
		const deadline = swap.created_at + swap.timeout_seconds * 1000;
		print(dim(`    deadline:     ${new Date(deadline).toISOString()}`));
	}
	if (swap.approval_deadline) {
		print(dim(`    approve by:   ${new Date(swap.approval_deadline).toISOString()}`));
	}
	if (swap.error_msg) print(red(`    error: ${swap.error_msg}`));
}

// ── Actor ────────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({
		swaps: {} as Record<string, SwapState>,
	}),
	onCreate: async (ctx) => {
		await restoreState(ctx.state, ctx);
	},
	tickMs: WATCHER_TICK_MS,
	onTick: async (ctx) => {
		try { await tickWatcher(ctx); }
		catch (err: any) { ctx.print?.(dim(`[swap-email] tick error: ${err?.message ?? String(err)}`)); }
	},
	typedActions: {
		start: {
			description: "Start a new email-mediated swap as the originator.",
			inputSchema: {
				type: "object",
				required: ["tokenGive", "amountGive", "tokenWant", "amountWant", "recipientEmail"],
				properties: {
					tokenGive: { type: "string" },
					amountGive: { type: "string" },
					tokenWant: { type: "string" },
					amountWant: { type: "string" },
					recipientEmail: { type: "string" },
					keyName: { type: "string" },
					timeoutSeconds: { type: "integer" },
				},
			},
			handler: async (ctx, input: StartSwapInput) => startSwap(ctx, input),
		},
		accept: {
			description: "Accept an incoming swap (responder).",
			inputSchema: {
				type: "object",
				required: ["swapId"],
				properties: { swapId: { type: "string" } },
			},
			handler: async (ctx, input: { swapId: string }) => {
				await acceptSwap(ctx, input.swapId);
				return { ok: true };
			},
		},
		decline: {
			description: "Decline an incoming swap (responder).",
			inputSchema: {
				type: "object",
				required: ["swapId"],
				properties: {
					swapId: { type: "string" },
					reason: { type: "string" },
				},
			},
			handler: async (ctx, input: { swapId: string; reason?: "explicit_decline" | "approval_timeout" }) => {
				await declineSwap(ctx, input.swapId, input.reason ?? "explicit_decline");
				return { ok: true };
			},
		},
		cancel: {
			description: "Cancel an outgoing swap (originator). Returns escrowed coins.",
			inputSchema: {
				type: "object",
				required: ["swapId"],
				properties: { swapId: { type: "string" } },
			},
			handler: async (ctx, input: { swapId: string }) => {
				await cancelSwap(ctx, input.swapId, "manual");
				return { ok: true };
			},
		},
		list: {
			description: "List all known swaps with their status.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => {
				const swaps = (ctx.state.swaps ?? {}) as Record<string, SwapState>;
				return Object.values(swaps);
			},
		},
		tick: {
			description: "Manually trigger the timeout/status watcher.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => { await tickWatcher(ctx); return { ok: true }; },
		},
		// Content-handler entry points: invoked from the registered handlers
		// below via /swap-email dispatch. Kept as typed actions so they're
		// testable without going through the router.
		handleIncomingOffer: {
			description: "(internal) Apply an incoming swap-offer envelope.",
			inputSchema: {
				type: "object",
				required: ["envelope_b64", "fromEndpoint"],
				properties: {
					envelope_b64: { type: "string" },
					fromEndpoint: { type: "string" },
					receivedAt: { type: "integer" },
				},
			},
			handler: async (ctx, input: { envelope_b64: string; fromEndpoint: string; receivedAt?: number }) => {
				const env = decodeTransportEnvelope(new Uint8Array(Buffer.from(input.envelope_b64, "base64")));
				const ok = await handleIncomingOffer(ctx, env, { fromEndpoint: input.fromEndpoint, receivedAt: input.receivedAt });
				return { handled: ok };
			},
		},
		handleIncomingResponse: {
			description: "(internal) Apply an incoming swap-response envelope.",
			inputSchema: {
				type: "object",
				required: ["envelope_b64", "fromEndpoint"],
				properties: {
					envelope_b64: { type: "string" },
					fromEndpoint: { type: "string" },
					receivedAt: { type: "integer" },
				},
			},
			handler: async (ctx, input: { envelope_b64: string; fromEndpoint: string; receivedAt?: number }) => {
				const env = decodeTransportEnvelope(new Uint8Array(Buffer.from(input.envelope_b64, "base64")));
				const ok = await handleIncomingResponse(ctx, env, { fromEndpoint: input.fromEndpoint, receivedAt: input.receivedAt });
				return { handled: ok };
			},
		},
		handleIncomingDecline: {
			description: "(internal) Apply an incoming swap-decline envelope.",
			inputSchema: {
				type: "object",
				required: ["envelope_b64", "fromEndpoint"],
				properties: {
					envelope_b64: { type: "string" },
					fromEndpoint: { type: "string" },
					receivedAt: { type: "integer" },
				},
			},
			handler: async (ctx, input: { envelope_b64: string; fromEndpoint: string; receivedAt?: number }) => {
				const env = decodeTransportEnvelope(new Uint8Array(Buffer.from(input.envelope_b64, "base64")));
				const ok = await handleIncomingDecline(ctx, env, { fromEndpoint: input.fromEndpoint, receivedAt: input.receivedAt });
				return { handled: ok };
			},
		},
	},
};

// ── Content handlers (transport-router → /swap-email actions) ────

registerContentHandler(SWAP_OFFER_CONTENT_TYPE, async (envelope, ctx, blobMeta) => {
	try {
		const env_b64 = Buffer.from(encodeTransportEnvelope({
			contentType: envelope.contentType,
			payload: envelope.payload,
			senderPubkey: envelope.senderPubkey,
			metadata: envelope.metadata,
		})).toString("base64");
		const result = await ctx.dispatchProgram("/swap-email", "handleIncomingOffer", [{
			envelope_b64: env_b64,
			fromEndpoint: blobMeta?.fromEndpoint ?? "",
			receivedAt: blobMeta?.receivedAt ?? Date.now(),
		}]) as { handled: boolean };
		return !!result?.handled;
	} catch (err: any) {
		ctx.print?.(dim(`[router→swap-email/offer] dispatch failed: ${err?.message ?? String(err)}`));
		return false;
	}
});

registerContentHandler(SWAP_RESPONSE_CONTENT_TYPE, async (envelope, ctx, blobMeta) => {
	try {
		const env_b64 = Buffer.from(encodeTransportEnvelope({
			contentType: envelope.contentType,
			payload: envelope.payload,
			senderPubkey: envelope.senderPubkey,
			metadata: envelope.metadata,
		})).toString("base64");
		const result = await ctx.dispatchProgram("/swap-email", "handleIncomingResponse", [{
			envelope_b64: env_b64,
			fromEndpoint: blobMeta?.fromEndpoint ?? "",
			receivedAt: blobMeta?.receivedAt ?? Date.now(),
		}]) as { handled: boolean };
		return !!result?.handled;
	} catch (err: any) {
		ctx.print?.(dim(`[router→swap-email/response] dispatch failed: ${err?.message ?? String(err)}`));
		return false;
	}
});

registerContentHandler(SWAP_DECLINE_CONTENT_TYPE, async (envelope, ctx, blobMeta) => {
	try {
		const env_b64 = Buffer.from(encodeTransportEnvelope({
			contentType: envelope.contentType,
			payload: envelope.payload,
			senderPubkey: envelope.senderPubkey,
			metadata: envelope.metadata,
		})).toString("base64");
		const result = await ctx.dispatchProgram("/swap-email", "handleIncomingDecline", [{
			envelope_b64: env_b64,
			fromEndpoint: blobMeta?.fromEndpoint ?? "",
			receivedAt: blobMeta?.receivedAt ?? Date.now(),
		}]) as { handled: boolean };
		return !!result?.handled;
	} catch (err: any) {
		ctx.print?.(dim(`[router→swap-email/decline] dispatch failed: ${err?.message ?? String(err)}`));
		return false;
	}
});

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Test exports ─────────────────────────────────────────────────

export const __test = {
	startSwap,
	handleIncomingOffer,
	handleIncomingResponse,
	handleIncomingDecline,
	acceptSwap,
	declineSwap,
	cancelSwap,
	tickWatcher,
	createOfferOrchestration,
	acceptOfferOrchestration,
	cancelOfferOrchestration,
	claimOfferOrchestration,
	exportOfferBundle,
	importOfferBundle,
	sendEnvelope,
	notifyUser,
	generateSwapId,
	termsSummary,
	getSwap,
	setSwap,
	snapshotState,
	restoreState,
	persistIfChanged,
	originatorTimeoutS,
	receiverApprovalTimeoutS,
	statusReportIntervalS,
	PERSISTED_STATE_FIELD,
};
