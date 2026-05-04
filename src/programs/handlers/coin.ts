// Coin — UTXO-based fungible token program for glon.
//
// Architecture:
//   - chain.token: metadata only (name, symbol, decimals, owner, total_supply, mint_renounced)
//   - chain.coin.bucket: holds up to 1000 coins as BlockAdd ops with contentType="chain.coin.op"
//   - SQLite coins table: index for O(1) balance queries
//
// Each coin is a block:
//   create: { coin_id, owner_pubkey, amount }
//   spend:  { coin_id }
//
// Bucket state is derived by replaying block trees in DAG order.
// The SQL index is rebuilt from buckets on every object index.

import type { ProgramDef, ProgramContext, ProgramActorDef, ValidatorFn, ValidationResult } from "../runtime.js";
import type { Change, Block } from "../../proto.js";
import {
	parseUint,
	addBounded,
	subChecked,
	U128_MAX,
	BIG_ZERO,
	bigToString,
} from "../../det/math.js";
import { hexEncode, hexDecode } from "../../crypto.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }

// ── Constants ────────────────────────────────────────────────────

export const TOKEN_TYPE_KEY = "chain.token";
export const BUCKET_TYPE_KEY = "chain.coin.bucket";
export const OP_CONTENT_TYPE = "chain.coin.op";
export const MAX_COINS_PER_BUCKET = 1000;

// ── Types ────────────────────────────────────────────────────────

export interface TokenMeta {
	name: string;
	symbol: string;
	decimals: number;
	ownerPubkey: string;
	totalSupply: bigint;
	mintRenounced: boolean;
}

export interface CoinOp {
	kind: "create" | "spend";
	coinId: string;
	ownerPubkey?: string;
	amount?: string;
}

export interface BucketState {
	tokenId: string;
	coins: Map<string, { owner: string; amount: string; spent: boolean }>;
}

// ── Op decoding ──────────────────────────────────────────────────

export function decodeCoinOp(block: Block): CoinOp | null {
	const custom = block.content?.custom;
	if (!custom || custom.contentType !== OP_CONTENT_TYPE) return null;
	const meta = custom.meta as Record<string, string> | undefined;
	if (!meta) return null;
	const kind = meta.op as "create" | "spend" | undefined;
	if (!kind || (kind !== "create" && kind !== "spend")) return null;
	const op: CoinOp = { kind, coinId: meta.coin_id ?? "" };
	if (kind === "create") {
		op.ownerPubkey = meta.owner_pubkey;
		op.amount = meta.amount;
	}
	return op;
}

export function encodeCoinOp(op: CoinOp): Record<string, string> {
	const out: Record<string, string> = { op: op.kind, coin_id: op.coinId };
	if (op.ownerPubkey !== undefined) out.owner_pubkey = op.ownerPubkey;
	if (op.amount !== undefined) out.amount = op.amount;
	return out;
}

// ── Bucket replay ────────────────────────────────────────────────

export function replayBucket(blocks: Block[]): BucketState {
	const coins = new Map<string, { owner: string; amount: string; spent: boolean }>();
	for (const block of blocks) {
		const op = decodeCoinOp(block);
		if (!op) continue;
		if (op.kind === "create") {
			coins.set(op.coinId, {
				owner: op.ownerPubkey ?? "",
				amount: op.amount ?? "0",
				spent: false,
			});
		} else if (op.kind === "spend") {
			const existing = coins.get(op.coinId);
			if (existing) existing.spent = true;
		}
	}
	return { tokenId: "", coins };
}

// ── Token metadata helpers ───────────────────────────────────────

function extractStr(v: any): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return "";
}

function extractInt(v: any, fallback: number): number {
	if (v === null || v === undefined) return fallback;
	if (typeof v === "number") return v;
	if (v.intValue !== undefined) {
		const n = v.intValue;
		return typeof n === "number" ? n : Number(n) | 0;
	}
	return fallback;
}

function extractBool(v: any): boolean {
	if (v === null || v === undefined) return false;
	if (typeof v === "boolean") return v;
	if (v.boolValue !== undefined) return !!v.boolValue;
	return false;
}

export async function loadTokenMeta(
	tokenId: string,
	ctx: ProgramContext,
): Promise<TokenMeta> {
	const store = ctx.store as any;
	const obj = await store.get(tokenId);
	if (!obj) throw new Error(`coin: token ${tokenId} not found`);
	if (obj.typeKey !== TOKEN_TYPE_KEY) throw new Error(`coin: ${tokenId} is not a token`);
	const f = obj.fields ?? {};
	return {
		name: extractStr(f.name),
		symbol: extractStr(f.symbol),
		decimals: extractInt(f.decimals, 0),
		ownerPubkey: extractStr(f.owner_pubkey),
		totalSupply: parseUint(extractStr(f.total_supply) || "0"),
		mintRenounced: extractBool(f.mint_renounced),
	};
}

// ── Change builders ──────────────────────────────────────────────

export function buildBucketGenesisChange(args: {
	bucketId: string;
	timestamp: number;
	author: string;
	tokenId: string;
	capacity?: number;
}): Change {
	return {
		id: new Uint8Array(0),
		objectId: args.bucketId,
		parentIds: [],
		ops: [
			{ objectCreate: { typeKey: BUCKET_TYPE_KEY } },
			{ fieldSet: { key: "token_id", value: { linkValue: { targetId: args.tokenId, relationKey: "token" } } } },
			{ fieldSet: { key: "capacity", value: { intValue: args.capacity ?? MAX_COINS_PER_BUCKET } } },
		],
		timestamp: args.timestamp,
		author: args.author,
	};
}

export function buildCoinOpChange(args: {
	bucketId: string;
	parentIds: Uint8Array[];
	timestamp: number;
	author: string;
	op: CoinOp;
	blockId: string;
}): Change {
	const meta = encodeCoinOp(args.op);
	return {
		id: new Uint8Array(0),
		objectId: args.bucketId,
		parentIds: args.parentIds,
		ops: [{
			blockAdd: {
				parentId: "",
				afterId: "",
				block: {
					id: args.blockId,
					childrenIds: [],
					content: {
						custom: {
							contentType: OP_CONTENT_TYPE,
							data: new Uint8Array(0),
							meta,
						},
					},
				},
			},
		}],
		timestamp: args.timestamp,
		author: args.author,
	};
}

// ── Validator ────────────────────────────────────────────────────

function classifyBucketChange(change: Change): { kind: "Genesis" } | { kind: "Op"; op: CoinOp } | { kind: "Unknown"; reason: string } {
	const ops = change.ops ?? [];
	const hasCreate = ops.some((o) => !!o.objectCreate);
	const blockAdds = ops.filter((o) => !!o.blockAdd);

	if (hasCreate) {
		if (blockAdds.length > 0) return { kind: "Unknown", reason: "Genesis must not contain blocks" };
		return { kind: "Genesis" };
	}

	if (blockAdds.length !== 1) {
		return { kind: "Unknown", reason: "Bucket op must contain exactly one BlockAdd" };
	}
	const block = blockAdds[0].blockAdd!.block;
	const op = decodeCoinOp(block);
	if (!op) return { kind: "Unknown", reason: "Invalid chain.coin.op block" };
	return { kind: "Op", op };
}

export function validateBucketChange(
	change: Change,
	priorBlocks: Block[],
): ValidationResult {
	// This validator focuses on semantic rules.
	const classification = classifyBucketChange(change);

	if (classification.kind === "Unknown") {
		return { valid: false, error: `coin: ${classification.reason}` };
	}
	if (classification.kind === "Genesis") {
		if (priorBlocks.length > 0) return { valid: false, error: "coin: bucket genesis must be first change" };
		return { valid: true };
	}

	// Op semantic validation: replay prior state and check invariants
	const state = replayBucket(priorBlocks);
	const op = classification.op;

	if (op.kind === "create") {
		if (!op.ownerPubkey || !op.amount) {
			return { valid: false, error: "coin: create missing owner_pubkey or amount" };
		}
		try {
			parseUint(op.amount);
		} catch (e: any) {
			return { valid: false, error: `coin: create bad amount: ${e.message}` };
		}
		if (state.coins.size >= MAX_COINS_PER_BUCKET) {
			return { valid: false, error: "coin: bucket at capacity" };
		}
		if (state.coins.has(op.coinId)) {
			return { valid: false, error: "coin: duplicate coin_id in bucket" };
		}
		return { valid: true };
	}

	if (op.kind === "spend") {
		const coin = state.coins.get(op.coinId);
		if (!coin) return { valid: false, error: "coin: spend of unknown coin" };
		if (coin.spent) return { valid: false, error: "coin: double spend" };
		return { valid: true };
	}

	return { valid: false, error: "coin: unreachable" };
}

export const validator: ValidatorFn = (changes: Change[]): ValidationResult => {
	for (const change of changes) {
		const c = classifyBucketChange(change);
		if (c.kind === "Unknown") return { valid: false, error: `coin: ${c.reason}` };
		if (c.kind === "Genesis") {
			// Genesis shape check only; semantic check needs prior state
			const ops = change.ops ?? [];
			const hasTokenLink = ops.some((o) =>
				o.fieldSet?.key === "token_id" && o.fieldSet.value?.linkValue?.targetId
			);
			if (!hasTokenLink) return { valid: false, error: "coin: bucket genesis missing token_id link" };
		}
		// Op semantic validation defers to actor's validate_op (same v1 compromise as token)
	}
	return { valid: true };
};

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print, resolveId, randomUUID, dispatchProgram, objectActor, store } = ctx;

	switch (cmd) {
		case "balance": {
			const rawToken = args[0];
			const pubkey = args[1];
			if (!rawToken || !pubkey) { print(red("Usage: coin balance <token_id> <pubkey_hex>")); break; }
			try {
				const tokenId = (await resolveId(rawToken)) ?? rawToken;
				const bal = await (store as any).coinBalance(tokenId, pubkey) as string;
				const meta = await loadTokenMeta(tokenId, ctx);
				print(`  ${cyan(meta.symbol || "?")}  ${bold(bal)} ` + dim(`(decimals=${meta.decimals})`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "holders": {
			const rawToken = args[0];
			if (!rawToken) { print(red("Usage: coin holders <token_id>")); break; }
			try {
				const tokenId = (await resolveId(rawToken)) ?? rawToken;
				const holders = await (store as any).coinHolders(tokenId) as { pubkey: string; balance: string }[];
				const meta = await loadTokenMeta(tokenId, ctx);
				if (holders.length === 0) {
					print(dim("  (no holders)"));
				} else {
					for (const h of holders) {
						print(`  ${dim(h.pubkey.slice(0, 16) + "...")}  ${bold(h.balance)} ${cyan(meta.symbol)}`);
					}
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "info": {
			const rawToken = args[0];
			if (!rawToken) { print(red("Usage: coin info <token_id>")); break; }
			try {
				const tokenId = (await resolveId(rawToken)) ?? rawToken;
				const meta = await loadTokenMeta(tokenId, ctx);
				const holders = await (store as any).coinHolders(tokenId) as { pubkey: string; balance: string }[];
				let total = 0n;
				for (const h of holders) total += BigInt(h.balance);
				print(bold(`  ${meta.name} (${meta.symbol})`));
				print(dim(`    id:       `) + tokenId);
				print(dim(`    decimals: `) + String(meta.decimals));
				print(dim(`    supply:   `) + total.toString());
				print(dim(`    holders:  `) + String(holders.length));
				print(dim(`    owner:    `) + (meta.ownerPubkey || yellow("(renounced)")));
				print(dim(`    mint:     `) + (meta.mintRenounced ? red("renounced") : green("active")));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "deploy": {
			const name = args[0];
			const symbol = args[1];
			const supplyStr = args[2];
			const decimalsArg = args.find((a) => a.startsWith("--decimals="));
			const decimals = decimalsArg ? Number(decimalsArg.split("=")[1]) : 0;
			const keyArg = args.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (!name || !symbol || !supplyStr) {
				print(red("Usage: coin deploy <name> <symbol> <supply> [--decimals=N] [--key=name]"));
				break;
			}
			if (Number.isNaN(decimals) || decimals < 0 || decimals > 30) {
				print(red("decimals must be in [0, 30]"));
				break;
			}
			try {
				let keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
				if (!keyInfo) {
					print(dim(`Creating wallet key "${keyName}"...`));
					keyInfo = await dispatchProgram("/wallet", "new", [keyName]);
				}
				const pubkey = keyInfo.pubkey as string;
				const supply = parseUint(supplyStr);

				// Create token metadata object
				const tokenId = randomUUID().replace(/-/g, "").slice(0, 24);
				const tokenFields = {
					name: ctx.stringVal(name),
					symbol: ctx.stringVal(symbol),
					decimals: ctx.intVal(decimals),
					owner_pubkey: ctx.stringVal(pubkey),
					total_supply: ctx.stringVal(supplyStr),
					mint_renounced: ctx.boolVal(false),
				};

				const unsignedToken = {
					id: new Uint8Array(0),
					objectId: tokenId,
					parentIds: [],
					ops: [
						{ objectCreate: { typeKey: TOKEN_TYPE_KEY } },
						...Object.entries(tokenFields).map(([key, value]) => ({ fieldSet: { key, value } })),
					],
					timestamp: Date.now(),
					author: "coin-deploy",
				};

				const { encodeChange } = await import("../../proto.js");
				const tokenB64 = Buffer.from(encodeChange(unsignedToken)).toString("base64");
				const { changeB64: signedTokenB64 } = await dispatchProgram("/wallet", "signChange", [{
					name: keyName,
					changeB64: tokenB64,
					nonce: 1,
					fee: 100,
				}]) as { changeB64: string };

				const tokenActor = objectActor(tokenId, { createWithInput: { id: tokenId } });
				await tokenActor.pushChanges(signedTokenB64);

				// Create initial bucket with full supply as one coin
				const bucketId = randomUUID().replace(/-/g, "").slice(0, 24);
				const genesisChange = buildBucketGenesisChange({
					bucketId,
					timestamp: Date.now(),
					author: "coin-deploy",
					tokenId,
				});
				const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
				const { changeB64: signedGenesisB64 } = await dispatchProgram("/wallet", "signChange", [{
					name: keyName,
					changeB64: genesisB64,
					nonce: 2,
					fee: 100,
				}]) as { changeB64: string };

				const bucketActor = objectActor(bucketId, { createWithInput: { id: bucketId } });
				await bucketActor.pushChanges(signedGenesisB64);

				// Mint the initial supply into the bucket
				const coinId = randomUUID().replace(/-/g, "").slice(0, 16);
				const createOp: CoinOp = {
					kind: "create",
					coinId,
					ownerPubkey: pubkey,
					amount: supplyStr,
				};
				const mintChange = buildCoinOpChange({
					bucketId,
					parentIds: [hexDecode(await bucketActor.getHeadIds().then((h: any) => h[0]))],
					timestamp: Date.now(),
					author: "coin-deploy",
					op: createOp,
					blockId: randomUUID().replace(/-/g, "").slice(0, 16),
				});
				const mintB64 = Buffer.from(encodeChange(mintChange)).toString("base64");
				const nonce3: number = await dispatchProgram("/consensus", "getNonce", [pubkey]) as number;
				const { changeB64: signedMintB64 } = await dispatchProgram("/wallet", "signChange", [{
					name: keyName,
					changeB64: mintB64,
					nonce: nonce3 + 1,
					fee: 10,
				}]) as { changeB64: string };
				await bucketActor.pushChanges(signedMintB64);

				print(green("Coin deployed!"));
				print(dim("  token:  ") + tokenId);
				print(dim("  bucket: ") + bucketId);
				print(dim("  name:   ") + name);
				print(dim("  symbol: ") + symbol);
				print(dim("  supply: ") + supplyStr);
				print(dim("  owner:  ") + pubkey);
			} catch (err: any) {
				print(red("Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "transfer": {
			const rawTokenId = args[0];
			const toPubkey = args[1];
			const amount = args[2];
			const keyArg = args.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (!rawTokenId || !toPubkey || !amount) {
				print(red("Usage: coin transfer <token_id> <to_pubkey> <amount> [--key=name]"));
				break;
			}
			if (!/^[0-9a-f]{64}$/.test(toPubkey)) {
				print(red("recipient pubkey must be 64 hex chars"));
				break;
			}
			try {
				const tokenId = (await resolveId(rawTokenId)) ?? rawTokenId;
				const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
				if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
				const senderPubkey = keyInfo.pubkey as string;

				// Select coins
				const selected = await (store as any).coinSelect(tokenId, senderPubkey, amount) as { coin_id: string; bucket_id: string; amount: string }[];
				let sum = 0n;
				for (const c of selected) sum += BigInt(c.amount);
				if (sum < BigInt(amount)) {
					print(red(`Insufficient balance: have ${sum.toString()}, need ${amount}`));
					break;
				}

				// Build spend changes for each input coin
				const { encodeChange } = await import("../../proto.js");
				const { hexDecode } = await import("../../crypto.js");
				const changesToPush: { actor: any; signedB64: string }[] = [];

				for (const coin of selected) {
					const bucketActor = objectActor(coin.bucket_id);
					const heads = await bucketActor.getHeadIds() as string[];
					const spendChange = buildCoinOpChange({
						bucketId: coin.bucket_id,
						parentIds: heads.map(hexDecode),
						timestamp: Date.now(),
						author: "coin-transfer",
						op: { kind: "spend", coinId: coin.coin_id },
						blockId: randomUUID().replace(/-/g, "").slice(0, 16),
					});
					const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
					const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
					const { changeB64: signedB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: spendB64,
						nonce: nonce + 1,
						fee: 1,
					}]) as { changeB64: string };
					changesToPush.push({ actor: bucketActor, signedB64 });
				}

				// Create output coins
				const changeAmount = subChecked(sum, parseUint(amount));
				const outputs: { coinId: string; owner: string; amount: string }[] = [
					{ coinId: randomUUID().replace(/-/g, "").slice(0, 16), owner: toPubkey, amount },
				];
				if (changeAmount > BIG_ZERO) {
					outputs.push({
						coinId: randomUUID().replace(/-/g, "").slice(0, 16),
						owner: senderPubkey,
						amount: bigToString(changeAmount),
					});
				}

				// Find or create output bucket
				let outputBucketId: string | null = null;
				const allBuckets = await (store as any).list(BUCKET_TYPE_KEY) as { id: string }[];
				for (const ref of allBuckets) {
					const bucket = await (store as any).get(ref.id) as any;
					if (bucket?.fields?.token_id?.linkValue?.targetId !== tokenId) continue;
					const bState = replayBucket(bucket.blocks ?? []);
					let unspentCount = 0;
					for (const c of bState.coins.values()) if (!c.spent) unspentCount++;
					if (unspentCount + outputs.length <= MAX_COINS_PER_BUCKET) {
						outputBucketId = ref.id;
						break;
					}
				}

				if (!outputBucketId) {
					outputBucketId = randomUUID().replace(/-/g, "").slice(0, 24);
					const genesisChange = buildBucketGenesisChange({
						bucketId: outputBucketId,
						timestamp: Date.now(),
						author: "coin-transfer",
						tokenId,
					});
					const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
					const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
					const { changeB64: signedGenesisB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: genesisB64,
						nonce: nonce + 1,
						fee: 1,
					}]) as { changeB64: string };
					const bucketActor = objectActor(outputBucketId, { createWithInput: { id: outputBucketId } });
					await bucketActor.pushChanges(signedGenesisB64);
				}

				const outBucketActor = objectActor(outputBucketId);
				for (const out of outputs) {
					const heads = await outBucketActor.getHeadIds() as string[];
					const createChange = buildCoinOpChange({
						bucketId: outputBucketId,
						parentIds: heads.map(hexDecode),
						timestamp: Date.now(),
						author: "coin-transfer",
						op: { kind: "create", coinId: out.coinId, ownerPubkey: out.owner, amount: out.amount },
						blockId: randomUUID().replace(/-/g, "").slice(0, 16),
					});
					const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
					const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
					const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: createB64,
						nonce: nonce + 1,
						fee: 1,
					}]) as { changeB64: string };
					changesToPush.push({ actor: outBucketActor, signedB64: signedCreateB64 });
				}

				// Push all changes
				for (const { actor, signedB64 } of changesToPush) {
					await actor.pushChanges(signedB64);
				}

				print(green(`Transferred ${amount} to ${toPubkey.slice(0, 16)}...`));
				print(dim("  token: ") + tokenId);
				if (changeAmount > BIG_ZERO) {
					print(dim("  change: ") + bigToString(changeAmount) + " back to sender");
				}
			} catch (err: any) {
				print(red("Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "mint": {
			const rawTokenId = args[0];
			const toPubkey = args[1];
			const amount = args[2];
			const keyArg = args.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (!rawTokenId || !toPubkey || !amount) {
				print(red("Usage: coin mint <token_id> <to_pubkey> <amount> [--key=name]"));
				break;
			}
			try {
				const tokenId = (await resolveId(rawTokenId)) ?? rawTokenId;
				const meta = await loadTokenMeta(tokenId, ctx);
				const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
				if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
				const senderPubkey = keyInfo.pubkey as string;

				if (meta.mintRenounced) { print(red("Mint has been renounced")); break; }
				if (senderPubkey !== meta.ownerPubkey) { print(red("Only owner can mint")); break; }

				// Find or create bucket
				let bucketId: string | null = null;
				const allBuckets = await (store as any).list(BUCKET_TYPE_KEY) as { id: string }[];
				for (const ref of allBuckets) {
					const bucket = await (store as any).get(ref.id) as any;
					if (bucket?.fields?.token_id?.linkValue?.targetId !== tokenId) continue;
					const bState = replayBucket(bucket.blocks ?? []);
					let unspentCount = 0;
					for (const c of bState.coins.values()) if (!c.spent) unspentCount++;
					if (unspentCount < MAX_COINS_PER_BUCKET) {
						bucketId = ref.id;
						break;
					}
				}

				const { encodeChange } = await import("../../proto.js");
				const { hexDecode } = await import("../../crypto.js");

				if (!bucketId) {
					bucketId = randomUUID().replace(/-/g, "").slice(0, 24);
					const genesisChange = buildBucketGenesisChange({
						bucketId,
						timestamp: Date.now(),
						author: "coin-mint",
						tokenId,
					});
					const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
					const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
					const { changeB64: signedGenesisB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: genesisB64,
						nonce: nonce + 1,
						fee: 10,
					}]) as { changeB64: string };
					const bucketActor = objectActor(bucketId, { createWithInput: { id: bucketId } });
					await bucketActor.pushChanges(signedGenesisB64);
				}

				const bucketActor = objectActor(bucketId);
				const heads = await bucketActor.getHeadIds() as string[];
				const createChange = buildCoinOpChange({
					bucketId,
					parentIds: heads.map(hexDecode),
					timestamp: Date.now(),
					author: "coin-mint",
					op: { kind: "create", coinId: randomUUID().replace(/-/g, "").slice(0, 16), ownerPubkey: toPubkey, amount },
					blockId: randomUUID().replace(/-/g, "").slice(0, 16),
				});
				const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
				const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
				const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
					name: keyName,
					changeB64: createB64,
					nonce: nonce + 1,
					fee: 10,
				}]) as { changeB64: string };
				await bucketActor.pushChanges(signedCreateB64);

				print(green(`Minted ${amount} to ${toPubkey.slice(0, 16)}...`));
				print(dim("  token:  ") + tokenId);
				print(dim("  bucket: ") + bucketId);
			} catch (err: any) {
				print(red("Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "burn": {
			const rawTokenId = args[0];
			const amount = args[1];
			const keyArg = args.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (!rawTokenId || !amount) {
				print(red("Usage: coin burn <token_id> <amount> [--key=name]"));
				break;
			}
			try {
				const tokenId = (await resolveId(rawTokenId)) ?? rawTokenId;
				const meta = await loadTokenMeta(tokenId, ctx);
				const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
				if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
				const senderPubkey = keyInfo.pubkey as string;

				if (senderPubkey !== meta.ownerPubkey) { print(red("Only owner can burn")); break; }

				const selected = await (store as any).coinSelect(tokenId, senderPubkey, amount) as { coin_id: string; bucket_id: string; amount: string }[];
				let sum = 0n;
				for (const c of selected) sum += BigInt(c.amount);
				if (sum < BigInt(amount)) {
					print(red(`Insufficient balance: have ${sum.toString()}, need ${amount}`));
					break;
				}

				// Partial burn: if the last selected coin is larger than needed, we need to
				// spend it and create change back to owner for the remainder.
				const { encodeChange } = await import("../../proto.js");
				const { hexDecode } = await import("../../crypto.js");
				const burnAmount = parseUint(amount);
				let remaining = burnAmount;

				for (const coin of selected) {
					const coinAmount = BigInt(coin.amount);
					const bucketActor = objectActor(coin.bucket_id);
					const heads = await bucketActor.getHeadIds() as string[];

					if (coinAmount > remaining) {
						// Spend the whole coin
						const spendChange = buildCoinOpChange({
							bucketId: coin.bucket_id,
							parentIds: heads.map(hexDecode),
							timestamp: Date.now(),
							author: "coin-burn",
							op: { kind: "spend", coinId: coin.coin_id },
							blockId: randomUUID().replace(/-/g, "").slice(0, 16),
						});
						const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
						const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
						const { changeB64: signedSpendB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: spendB64,
							nonce: nonce + 1,
							fee: 1,
						}]) as { changeB64: string };
						await bucketActor.pushChanges(signedSpendB64);

						// Create change coin for remainder in same bucket
						const changeAmount = bigToString(coinAmount - remaining);
						const newHeads = await bucketActor.getHeadIds() as string[];
						const createChange = buildCoinOpChange({
							bucketId: coin.bucket_id,
							parentIds: newHeads.map(hexDecode),
							timestamp: Date.now(),
							author: "coin-burn",
							op: { kind: "create", coinId: randomUUID().replace(/-/g, "").slice(0, 16), ownerPubkey: senderPubkey, amount: changeAmount },
							blockId: randomUUID().replace(/-/g, "").slice(0, 16),
						});
						const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
						const nonce2: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
						const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: createB64,
							nonce: nonce2 + 1,
							fee: 1,
						}]) as { changeB64: string };
						await bucketActor.pushChanges(signedCreateB64);
						remaining = BIG_ZERO;
						break;
					} else {
						// Spend exact or partial from this coin
						const spendChange = buildCoinOpChange({
							bucketId: coin.bucket_id,
							parentIds: heads.map(hexDecode),
							timestamp: Date.now(),
							author: "coin-burn",
							op: { kind: "spend", coinId: coin.coin_id },
							blockId: randomUUID().replace(/-/g, "").slice(0, 16),
						});
						const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
						const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
						const { changeB64: signedSpendB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: spendB64,
							nonce: nonce + 1,
							fee: 1,
						}]) as { changeB64: string };
						await bucketActor.pushChanges(signedSpendB64);
						remaining -= coinAmount;
					}
				}

				print(green(`Burned ${amount}`));
				print(dim("  token: ") + tokenId);
			} catch (err: any) {
				print(red("Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Coin") + dim(" — UTXO fungible token (chain.coin.bucket / chain.token)"),
				`    ${cyan("coin deploy")} ${dim("<name> <symbol> <supply> [--decimals=N] [--key=name]")}  deploy a new token`,
				`    ${cyan("coin transfer")} ${dim("<token_id> <to_pubkey> <amount> [--key=name]")}  send coins`,
				`    ${cyan("coin mint")} ${dim("<token_id> <to_pubkey> <amount> [--key=name]")}     mint new coins (owner only)`,
				`    ${cyan("coin burn")} ${dim("<token_id> <amount> [--key=name]")}            burn coins (owner only)`,
				`    ${cyan("coin balance")} ${dim("<token_id> <pubkey>")}            balance for one holder`,
				`    ${cyan("coin holders")} ${dim("<token_id>")}                  all balances, descending`,
				`    ${cyan("coin info")} ${dim("<token_id>")}                     metadata + supply + owner`,
				dim(`  Each token is backed by chain.coin.bucket objects (max ${MAX_COINS_PER_BUCKET} coins each).`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ─────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		validate_op: async (
			ctx: ProgramContext,
			input: { bucketId: string; changeB64: string },
		): Promise<ValidationResult> => {
			const store = ctx.store as any;
			const obj = await store.get(input.bucketId);
			const priorBlocks = obj?.blocks ?? [];
			const { decodeChange } = await import("../../proto.js");
			const change = decodeChange(new Uint8Array(Buffer.from(input.changeB64, "base64")));
			return validateBucketChange(change, priorBlocks);
		},

		buildBucketGenesis: async (_ctx: ProgramContext, args: {
			bucketId: string;
			timestamp: number;
			author: string;
			tokenId: string;
			capacity?: number;
		}): Promise<{ changeB64: string }> => {
			const { encodeChange } = await import("../../proto.js");
			const change = buildBucketGenesisChange(args);
			return { changeB64: Buffer.from(encodeChange(change)).toString("base64") };
		},

		buildCoinOp: async (_ctx: ProgramContext, args: {
			bucketId: string;
			parentIds: string[];
			timestamp: number;
			author: string;
			op: CoinOp;
			blockId: string;
		}): Promise<{ changeB64: string }> => {
			const { encodeChange } = await import("../../proto.js");
			const { hexDecode } = await import("../../crypto.js");
			const change = buildCoinOpChange({
				bucketId: args.bucketId,
				parentIds: args.parentIds.map(hexDecode),
				timestamp: args.timestamp,
				author: args.author,
				op: args.op,
				blockId: args.blockId,
			});
			return { changeB64: Buffer.from(encodeChange(change)).toString("base64") };
		},

		replayBucket: async (_ctx: ProgramContext, blocks: Block[]): Promise<BucketState> => {
			return replayBucket(blocks);
		},
	},
};

const program: ProgramDef = {
	handler,
	actor: actorDef,
	validator,
	validatedTypes: [BUCKET_TYPE_KEY],
	chainMode: true,
};

export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	decodeCoinOp,
	encodeCoinOp,
	replayBucket,
	validateBucketChange,
	classifyBucketChange,
	buildBucketGenesisChange,
	buildCoinOpChange,
	MAX_COINS_PER_BUCKET,
};
