// Swap — cross-DAG atomic swap coordinator for glon.
//
// Wraps /coin offer operations with ChangeBundle export/import,
// parent-chain validation, and token dependency checking.
//
// Commands:
//   swap offer create <token_id> <amount> <req_token_id> <req_amount> [--key=name] [--export=path]
//   swap offer export <offer_id> [--file=path] [--include-tokens]
//   swap offer import <bundle_path_or_base64> [--key=name]
//   swap offer accept <offer_id> [--key=name]
//   swap offer claim <offer_id> [--key=name]
//   swap offer info <offer_id>
//
// TypedActions:
//   exportOffer({ offerId, includeTokens? }) → { bundleBase64, tokenBundles?, status, escrowed }
//   importOffer({ bundleBase64, keyName? }) → { offerId, status, escrowed?, missingTokens? }

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { decodeChange, encodeChange, encodeChangeBundle, decodeChangeBundle } from "../../proto.js";
import { hexEncode, hexDecode } from "../../crypto.js";
import { dim, bold, cyan, red, green } from "../shared.js";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

const OFFER_TYPE_KEY = "chain.coin.offer";

// ── Helpers ─────────────────────────────────────────────────────

function getChangesDir(offerId: string): string {
	const base = process.env.GLON_DATA ?? join(process.env.HOME ?? "/home/geep", ".glon");
	return join(base, "changes", offerId);
}

function readOfferChanges(offerId: string): Uint8Array[] {
	const dir = getChangesDir(offerId);
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((f) => f.endsWith(".pb"));
	return files.map((f) => new Uint8Array(readFileSync(join(dir, f))));
}

function verifyParentChain(changes: Uint8Array[]): { valid: boolean; error?: string } {
	const decoded = changes.map((c) => decodeChange(c));
	const byId = new Map(decoded.map((c) => [hexEncode(c.id), c]));
	const genesis = decoded.find((c) => c.parentIds.length === 0);
	if (!genesis) return { valid: false, error: "No genesis change (all have parents)" };

	for (const ch of decoded) {
		if (ch.parentIds.length === 0) continue;
		const hasParentInBundle = ch.parentIds.some((p) => byId.has(hexEncode(p)));
		if (!hasParentInBundle) {
			return {
				valid: false,
				error: `Change ${hexEncode(ch.id).slice(0, 16)} has parent(s) not in bundle`,
			};
		}
	}
	return { valid: true };
}

function extractStr(v: any): string {
	if (typeof v === "string") return v;
	if (v?.stringValue) return v.stringValue;
	return "";
}

// ── TypedActions ────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	state: {},

	typedActions: {
		exportOffer: {
			description: "Export a coin offer as a verified ChangeBundle",
			inputSchema: {
				type: "object",
				required: ["offerId"],
				properties: {
					offerId: { type: "string" },
					includeTokens: { type: "boolean" },
				},
			},
			async handler(ctx: ProgramContext, input: any) {
				const { offerId, includeTokens } = input;
				const changes = readOfferChanges(offerId);
				if (changes.length === 0) throw new Error(`Offer ${offerId} not found on disk`);

				const chainCheck = verifyParentChain(changes);
				if (!chainCheck.valid) throw new Error(`Parent chain broken: ${chainCheck.error}`);

				const decoded = changes.map((c) => decodeChange(c));
				const genesis = decoded.find(
					(c) => c.parentIds.length === 0 && c.ops.some((o: any) => o.objectCreate?.typeKey === OFFER_TYPE_KEY),
				);
				if (!genesis) throw new Error("No offer genesis found in changes");

				// Gather token IDs from genesis fields for dependency checking
				const tokenIds = new Set<string>();
				for (const op of genesis.ops) {
					if (op.fieldSet?.key === "terms" && op.fieldSet.value?.stringValue) {
						try {
							const terms = JSON.parse(op.fieldSet.value.stringValue);
							for (const item of terms.offered ?? []) if (item.tokenId) tokenIds.add(item.tokenId);
							for (const item of terms.requested ?? []) if (item.tokenId) tokenIds.add(item.tokenId);
						} catch {}
					}
				}

				// Count escrow blocks (non-genesis changes with blockAdd)
				let escrowCount = 0;
				for (const ch of decoded) {
					if (ch.parentIds.length === 0) continue;
					if (ch.ops.some((o: any) => o.blockAdd)) escrowCount++;
				}

				const bundleBytes = encodeChangeBundle({ changes });
				const bundleB64 = Buffer.from(bundleBytes).toString("base64");

				const tokenBundles: Array<{ tokenId: string; bundleBase64: string }> = [];
				if (includeTokens) {
					for (const tokenId of tokenIds) {
						const tokenChanges = readOfferChanges(tokenId);
						if (tokenChanges.length > 0) {
							const tb = encodeChangeBundle({ changes: tokenChanges });
							tokenBundles.push({ tokenId, bundleBase64: Buffer.from(tb).toString("base64") });
						}
					}
				}

				return { bundleBase64: bundleB64, tokenBundles, escrowCount, tokenCount: tokenIds.size };
			},
		},

		importOffer: {
			description: "Import a coin offer ChangeBundle, checking dependencies",
			inputSchema: {
				type: "object",
				required: ["bundleBase64"],
				properties: {
					bundleBase64: { type: "string" },
					keyName: { type: "string" },
				},
			},
			async handler(ctx: ProgramContext, input: any) {
				const { bundleBase64 } = input;
				const bundleBytes = Buffer.from(bundleBase64, "base64");
				const bundle = decodeChangeBundle(bundleBytes);
				const decoded = bundle.changes.map((c) => decodeChange(c));

				const chainCheck = verifyParentChain(bundle.changes);
				if (!chainCheck.valid) throw new Error(`Parent chain broken: ${chainCheck.error}`);

				const genesis = decoded.find(
					(c) => c.parentIds.length === 0 && c.ops.some((o: any) => o.objectCreate?.typeKey === OFFER_TYPE_KEY),
				);
				if (!genesis) throw new Error("No offer genesis found in bundle");
				const offerId = genesis.objectId;

				// Check token dependencies from genesis fields
				const missingTokens: Array<{ tokenId: string }> = [];
				const allTokens = new Set<string>();
				for (const op of genesis.ops) {
					if (op.fieldSet?.key === "terms" && op.fieldSet.value?.stringValue) {
						try {
							const terms = JSON.parse(op.fieldSet.value.stringValue);
							for (const item of terms.offered ?? []) if (item.tokenId) allTokens.add(item.tokenId);
							for (const item of terms.requested ?? []) if (item.tokenId) allTokens.add(item.tokenId);
						} catch {}
					}
				}
				for (const tokenId of allTokens) {
					try {
						const obj = await (ctx.store as any).get(tokenId);
						if (!obj || !obj.fields) missingTokens.push({ tokenId });
					} catch {
						missingTokens.push({ tokenId });
					}
				}

				if (missingTokens.length > 0) {
					return { offerId, status: "missing_tokens", missingTokens };
				}

				// Push changes via object actor (kernel validators will run)
				const actor = (ctx as any).objectActor(offerId);
				for (const ch of decoded) {
					const chB64 = Buffer.from(encodeChange(ch)).toString("base64");
					await actor.pushChanges(chB64);
				}

				return { offerId, status: "imported", escrowCount: decoded.filter((c) => c.ops.some((o: any) => o.blockAdd)).length };
			},
		},
	},

	actions: {
		exportOffer: async (ctx, args) => {
			const typed = actorDef.typedActions?.exportOffer;
			if (!typed) throw new Error("exportOffer not defined");
			return await typed.handler(ctx, args[0] ?? {});
		},
		importOffer: async (ctx, args) => {
			const typed = actorDef.typedActions?.importOffer;
			if (!typed) throw new Error("importOffer not defined");
			return await typed.handler(ctx, args[0] ?? {});
		},
	},
};

// ── CLI Handler ─────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print, dispatchProgram, style } = ctx;
	const { dim: d, bold: b, cyan: c, red: r, green: g } = style;

	const sub = args[0];
	const rest = args.slice(1);

	if (sub === "offer") {
		const offerSub = rest[0];
		const offerArgs = rest.slice(1);

		if (offerSub === "create") {
			const [tokenId, amount, reqTokenId, reqAmount] = offerArgs.filter((a) => !a.startsWith("--"));
			const keyFlag = offerArgs.find((a) => a.startsWith("--key="));
			const keyName = keyFlag ? keyFlag.slice(6) : "default";
			const exportFlag = offerArgs.find((a) => a.startsWith("--export="));
			const exportPath = exportFlag ? exportFlag.slice(9) : null;

			if (!tokenId || !amount || !reqTokenId || !reqAmount) {
				print(r("Usage: swap offer create <token_id> <amount> <req_token_id> <req_amount> [--key=name] [--export=path]"));
				return;
			}

			// Delegate creation to /coin
			await dispatchProgram("/coin", "offer", ["create", tokenId, amount, reqTokenId, reqAmount, `--key=${keyName}`]);
			if (exportPath) {
				print(d("Use 'swap offer export <offer_id> --file=" + exportPath + "' after creation."));
			}
			return;
		}

		if (offerSub === "export") {
			const [offerId] = offerArgs.filter((a) => !a.startsWith("--"));
			const fileFlag = offerArgs.find((a) => a.startsWith("--file="));
			const filePath = fileFlag ? fileFlag.slice(7) : null;
			const includeTokens = offerArgs.includes("--include-tokens");

			if (!offerId) {
				print(r("Usage: swap offer export <offer_id> [--file=path] [--include-tokens]"));
				return;
			}

			try {
				const result: any = await dispatchProgram("/swap", "exportOffer", [{ offerId, includeTokens }]);
				if (filePath) {
					mkdirSync(dirname(filePath), { recursive: true });
					writeFileSync(filePath, result.bundleBase64);
					print(g(`Bundle exported to ${filePath}`));
					print(`  escrow changes: ${result.escrowCount}`);
					if (result.tokenBundles?.length) {
						print(`  token bundles: ${result.tokenBundles.length}`);
					}
				} else {
					print(b("=== OFFER BUNDLE ==="));
					print(`Offer ID: ${offerId}`);
					print(`Escrow changes: ${result.escrowCount}`);
					print(`Tokens: ${result.tokenCount}`);
					print("\nBase64:");
					print(result.bundleBase64);
				}
			} catch (err: any) {
				print(r(`Export failed: ${err.message}`));
			}
			return;
		}

		if (offerSub === "import") {
			const [pathOrB64] = offerArgs.filter((a) => !a.startsWith("--"));
			const keyFlag = offerArgs.find((a) => a.startsWith("--key="));
			const keyName = keyFlag ? keyFlag.slice(6) : "default";

			if (!pathOrB64) {
				print(r("Usage: swap offer import <bundle_path_or_base64> [--key=name]"));
				return;
			}

			let bundleB64: string;
			if (existsSync(pathOrB64)) {
				bundleB64 = readFileSync(pathOrB64, "utf8").trim();
			} else {
				bundleB64 = pathOrB64;
			}

			try {
				const result: any = await dispatchProgram("/swap", "importOffer", [{ bundleBase64: bundleB64, keyName }]);
				if (result.status === "missing_tokens") {
					print(r("Import blocked — missing token objects:"));
					for (const t of result.missingTokens) {
						print(`  ${t.tokenId}`);
					}
					print(d("Import token genesis bundles first, then re-run import."));
				} else {
					print(g(`Offer ${result.offerId} imported.`));
					print(`  Status: ${result.status}`);
					print(`  Escrow changes: ${result.escrowCount}`);
				}
			} catch (err: any) {
				print(r(`Import failed: ${err.message}`));
			}
			return;
		}

		if (offerSub === "accept") {
			const [offerId] = offerArgs.filter((a) => !a.startsWith("--"));
			const keyFlag = offerArgs.find((a) => a.startsWith("--key="));
			const keyName = keyFlag ? keyFlag.slice(6) : "default";
			if (!offerId) { print(r("Usage: swap offer accept <offer_id> [--key=name]")); return; }
			await dispatchProgram("/coin", "offer", ["accept", offerId, `--key=${keyName}`]);
			return;
		}

		if (offerSub === "claim") {
			const [offerId] = offerArgs.filter((a) => !a.startsWith("--"));
			const keyFlag = offerArgs.find((a) => a.startsWith("--key="));
			const keyName = keyFlag ? keyFlag.slice(6) : "default";
			if (!offerId) { print(r("Usage: swap offer claim <offer_id> [--key=name]")); return; }
			await dispatchProgram("/coin", "offer", ["claim", offerId, `--key=${keyName}`]);
			return;
		}

		if (offerSub === "info") {
			const [offerId] = offerArgs;
			if (!offerId) { print(r("Usage: swap offer info <offer_id>")); return; }
			await dispatchProgram("/coin", "offer", ["info", offerId]);
			return;
		}

		print(b("Swap offer commands:"));
		print(`  ${c("swap offer create")}  ${d("<token> <amt> <req_token> <req_amt> [--key=name] [--export=path]")}`);
		print(`  ${c("swap offer export")}  ${d("<offer_id> [--file=path] [--include-tokens]")}`);
		print(`  ${c("swap offer import")}  ${d("<bundle_path_or_base64> [--key=name]")}`);
		print(`  ${c("swap offer accept")}  ${d("<offer_id> [--key=name]")}`);
		print(`  ${c("swap offer claim")}   ${d("<offer_id> [--key=name]")}`);
		print(`  ${c("swap offer info")}    ${d("<offer_id>")}`);
		return;
	}

	print(b("Swap — cross-DAG atomic swap coordinator"));
	print(`  ${c("swap offer")}  ${d("create, export, import, accept, claim, info")}`);
};

// ── Program Definition ──────────────────────────────────────────

const program: ProgramDef = {
	name: "Swap",
	prefix: "/swap",
	handler,
	actor: actorDef,
};

export default program;
