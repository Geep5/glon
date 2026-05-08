// Coin bucket — UTXO replay, validation, change builders, and SQL index hook.
//
// Given a block array, replayBucket computes the bucket's state.
// validateBucketChange checks a change against that state.
// buildBucketGenesisChange and buildCoinOpChange produce correctly-shaped
// changes for the kernel to validate and store.

import type { Block, Change, ValidationResult } from "../../proto.js";
import type { ValidatorFn, ObjectState } from "../runtime.js";
import { registerIndexHook } from "../runtime.js";
import { parseUint } from "../../det/index.js";
import {
	BUCKET_TYPE_KEY,
	OP_CONTENT_TYPE,
	MAX_COINS_PER_BUCKET,
	decodeCoinOp,
	encodeCoinOp,
	type CoinOp,
	type BucketState,
} from "./coin-types.js";

// Re-export for consumers that only need the bucket layer
export { decodeCoinOp, encodeCoinOp } from "./coin-types.js";

// ── Bucket replay ──────────────────────────────────────────────────

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

// ── Change builders ────────────────────────────────────────────────

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

// ── Validator ──────────────────────────────────────────────────────

	export function classifyBucketChange(change: Change): { kind: "Genesis" } | { kind: "Op"; op: CoinOp } | { kind: "Unknown"; reason: string } {
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
	const classification = classifyBucketChange(change);

	if (classification.kind === "Unknown") {
		return { valid: false, error: `coin: ${classification.reason}` };
	}
	if (classification.kind === "Genesis") {
		if (priorBlocks.length > 0) return { valid: false, error: "coin: bucket genesis must be first change" };
		return { valid: true };
	}

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
			const ops = change.ops ?? [];
			const hasTokenLink = ops.some((o) =>
				o.fieldSet?.key === "token_id" && o.fieldSet.value?.linkValue?.targetId
			);
			if (!hasTokenLink) return { valid: false, error: "coin: bucket genesis missing token_id link" };
		}
	}
	return { valid: true };
};

// ── Index hook ─────────────────────────────────────────────────────

/** Rebuild the SQLite coins index for a single bucket object. */
async function indexCoins(c: any, computed: ObjectState): Promise<void> {
	await c.db.execute("DELETE FROM coins WHERE bucket_id = ?", computed.id);
	const tokenField = computed.fields.get("token_id");
	let tokenId = "";
	if (tokenField?.linkValue?.targetId) {
		tokenId = tokenField.linkValue.targetId;
	} else if (typeof tokenField === "string") {
		tokenId = tokenField;
	}
	const state = replayBucket(computed.blocks);
	for (const [coinId, coin] of state.coins) {
		await c.db.execute(
			`INSERT INTO coins (coin_id, bucket_id, token_id, owner_pubkey, amount, spent, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			coinId, computed.id, tokenId, coin.owner, coin.amount, coin.spent ? 1 : 0, computed.createdAt,
		);
	}
}

// Register at module load so the kernel dispatches without hardcoding.
registerIndexHook([BUCKET_TYPE_KEY], indexCoins);
