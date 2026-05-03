/**
 * /token program tests.
 *
 * Pure-function coverage for the token program — classification, replay,
 * op application, and validator. Does NOT spin up the full RivetKit
 * actor system. The integration test (test/chain/integration.test.ts)
 * later ties these against a live store; this file pins the logic.
 *
 * Coverage:
 *   - classifyChange: Deploy vs Op vs Unknown
 *   - validateDeploy: required fields, decimals range, hex pubkey, signer match
 *   - replayState: balances + total_supply derived from blocks
 *   - applyOpToState: each op kind (Mint, Transfer, Approve, TransferFrom,
 *     Burn, RenounceMint), happy path + invariant violations
 *   - BigInt overflow protection (U128_MAX boundary)
 *   - Allowance flow end-to-end
 *
 * Run: npx tsx --test test/chain/token.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import tokenProgram, { __test, OP_CONTENT_TYPE, type TokenOp } from "../../src/programs/handlers/token.js";
import type { Change, Block } from "../../src/proto.js";
import { U128_MAX, BIG_ZERO } from "../../src/det/math.js";

const {
	classifyChange,
	decodeOp,
	encodeOp,
	replayState,
	validateChange,
	applyOpToState,
	buildDeployChange,
	buildOpChange,
	zeroState,
} = __test;

// ── Fixtures ────────────────────────────────────────────────────

const ALICE_PUB = "a".repeat(64);
const BOB_PUB = "b".repeat(64);
const CHARLIE_PUB = "c".repeat(64);

function deployChange(opts?: { initialSupply?: bigint; ownerPubkeyHex?: string }): Change {
	const c = buildDeployChange({
		tokenId: "tok-1",
		timestamp: 1000,
		author: "test",
		name: "TestCoin",
		symbol: "TST",
		decimals: 6,
		ownerPubkeyHex: opts?.ownerPubkeyHex ?? ALICE_PUB,
		initialSupply: opts?.initialSupply ?? 1_000_000n,
	});
	c.authorSig = {
		pubkey: Buffer.from(opts?.ownerPubkeyHex ?? ALICE_PUB, "hex"),
		signature: new Uint8Array(64),
		nonce: 1,
		fee: 100,
	};
	return c;
}

function opChange(op: TokenOp, signerPubkeyHex: string, blockId = "blk-x"): Change {
	const c = buildOpChange({
		tokenId: "tok-1",
		parentIds: [],
		timestamp: 2000,
		author: "test",
		op,
		signerPubkeyHex,
		blockId,
	});
	c.authorSig = {
		pubkey: Buffer.from(signerPubkeyHex, "hex"),
		signature: new Uint8Array(64),
		nonce: 1,
		fee: 10,
	};
	return c;
}

function blockFromOp(op: TokenOp, signerPubkeyHex: string, blockId = "blk-x"): Block {
	const meta = encodeOp(op);
	meta.signer = signerPubkeyHex;
	return {
		id: blockId,
		childrenIds: [],
		content: {
			custom: {
				contentType: OP_CONTENT_TYPE,
				data: new Uint8Array(0),
				meta,
			},
		},
	};
}

function fieldsFromDeploy(c: Change): Record<string, any> {
	const fields: Record<string, any> = {};
	for (const op of c.ops) {
		if (op.fieldSet) fields[op.fieldSet.key] = op.fieldSet.value;
	}
	return fields;
}

// ── classifyChange ──────────────────────────────────────────────

describe("classifyChange", () => {
	it("Deploy: ObjectCreate + FieldSets only", () => {
		const c = deployChange();
		const r = classifyChange(c);
		assert.equal(r.kind, "Deploy");
	});

	it("Op: exactly one BlockAdd with chain.token.op contentType", () => {
		const c = opChange({ kind: "Transfer", to: BOB_PUB, amount: "100" }, ALICE_PUB);
		const r = classifyChange(c);
		assert.equal(r.kind, "Op");
		assert.equal((r as any).op.kind, "Transfer");
		assert.equal((r as any).op.to, BOB_PUB);
		assert.equal((r as any).op.amount, "100");
	});

	it("Unknown: Deploy with stray BlockAdd is rejected", () => {
		const c = deployChange();
		c.ops.push({
			blockAdd: {
				parentId: "", afterId: "",
				block: { id: "x", childrenIds: [], content: { custom: { contentType: OP_CONTENT_TYPE, data: new Uint8Array(), meta: { op: "Mint" } } } },
			},
		});
		const r = classifyChange(c);
		assert.equal(r.kind, "Unknown");
	});

	it("Unknown: Op with multiple BlockAdds is rejected", () => {
		const c = opChange({ kind: "Mint", to: ALICE_PUB, amount: "1" }, ALICE_PUB, "b1");
		c.ops.push({
			blockAdd: {
				parentId: "", afterId: "",
				block: { id: "b2", childrenIds: [], content: { custom: { contentType: OP_CONTENT_TYPE, data: new Uint8Array(), meta: { op: "Burn", amount: "1" } } } },
			},
		});
		const r = classifyChange(c);
		assert.equal(r.kind, "Unknown");
	});

	it("Unknown: Op with mixed BlockAdd + FieldSet is rejected", () => {
		const c = opChange({ kind: "Mint", to: ALICE_PUB, amount: "1" }, ALICE_PUB);
		c.ops.push({ fieldSet: { key: "evil", value: { stringValue: "yes" } } });
		const r = classifyChange(c);
		assert.equal(r.kind, "Unknown");
	});

	it("Unknown: BlockAdd with wrong contentType", () => {
		const c: Change = {
			id: new Uint8Array(0), objectId: "tok-1", parentIds: [],
			ops: [{ blockAdd: {
				parentId: "", afterId: "",
				block: { id: "b", childrenIds: [], content: { custom: {
					contentType: "wrong.type", data: new Uint8Array(), meta: { op: "Mint" },
				} } },
			} }],
			timestamp: 0, author: "t",
		};
		const r = classifyChange(c);
		assert.equal(r.kind, "Unknown");
	});

	it("Unknown: BlockAdd with malformed meta (no op kind)", () => {
		const c: Change = {
			id: new Uint8Array(0), objectId: "tok-1", parentIds: [],
			ops: [{ blockAdd: {
				parentId: "", afterId: "",
				block: { id: "b", childrenIds: [], content: { custom: {
					contentType: OP_CONTENT_TYPE, data: new Uint8Array(), meta: { foo: "bar" },
				} } },
			} }],
			timestamp: 0, author: "t",
		};
		const r = classifyChange(c);
		assert.equal(r.kind, "Unknown");
	});
});

// ── decodeOp / encodeOp ─────────────────────────────────────────

describe("decodeOp", () => {
	it("rejects unknown op kinds", () => {
		assert.equal(decodeOp({ op: "DangerousAlchemy" }), null);
	});
	it("returns null for empty/missing meta", () => {
		assert.equal(decodeOp(undefined), null);
		assert.equal(decodeOp({}), null);
	});
	it("preserves all known fields", () => {
		const op = decodeOp({ op: "TransferFrom", from: "a", to: "b", amount: "5" });
		assert.deepEqual(op, { kind: "TransferFrom", from: "a", to: "b", amount: "5" });
	});
});

// ── validateDeploy via validateChange ───────────────────────────

describe("Deploy validation", () => {
	it("accepts a properly formed Deploy", () => {
		const c = deployChange();
		const r = validateChange(c, {}, []);
		assert.equal(r.valid, true);
	});

	it("rejects when name is missing", () => {
		const c = deployChange();
		c.ops = c.ops.filter((o) => !(o.fieldSet?.key === "name"));
		const r = validateChange(c, {}, []);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /name/);
	});

	it("rejects decimals out of range", () => {
		const c = deployChange();
		for (const op of c.ops) {
			if (op.fieldSet?.key === "decimals") {
				op.fieldSet.value = { intValue: 100 };
			}
		}
		const r = validateChange(c, {}, []);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /decimals/);
	});

	it("rejects bad initial_supply (non-decimal)", () => {
		const c = deployChange();
		for (const op of c.ops) {
			if (op.fieldSet?.key === "initial_supply") {
				op.fieldSet.value = { stringValue: "ten" };
			}
		}
		const r = validateChange(c, {}, []);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /initial_supply/);
	});

	it("rejects when signer != owner_pubkey", () => {
		const c = deployChange();  // owner = ALICE_PUB
		c.authorSig!.pubkey = Buffer.from(BOB_PUB, "hex");
		const r = validateChange(c, {}, []);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /signer must equal owner/);
	});

	it("rejects Deploy when object already has prior state", () => {
		const c = deployChange();
		const r = validateChange(c, { name: { stringValue: "Existing" } }, []);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /genesis/);
	});
});

// ── replayState ─────────────────────────────────────────────────

describe("replayState", () => {
	it("derives balances + total_supply from Deploy fields", () => {
		const c = deployChange({ initialSupply: 1000n });
		const fields = fieldsFromDeploy(c);
		const state = replayState(fields, []);
		assert.equal(state.totalSupply, 1000n);
		assert.equal(state.balances.get(ALICE_PUB), 1000n);
		assert.equal(state.balances.size, 1);
		assert.equal(state.ownerPubkey, ALICE_PUB);
	});

	it("applies a single Transfer op from the block list", () => {
		const fields = fieldsFromDeploy(deployChange({ initialSupply: 1000n }));
		const block = blockFromOp({ kind: "Transfer", to: BOB_PUB, amount: "300" }, ALICE_PUB);
		const state = replayState(fields, [block]);
		assert.equal(state.balances.get(ALICE_PUB), 700n);
		assert.equal(state.balances.get(BOB_PUB), 300n);
		assert.equal(state.totalSupply, 1000n);
	});

	it("applies multiple ops in order — Transfer + Burn", () => {
		const fields = fieldsFromDeploy(deployChange({ initialSupply: 1000n }));
		const blocks = [
			blockFromOp({ kind: "Transfer", to: BOB_PUB, amount: "200" }, ALICE_PUB, "b1"),
			blockFromOp({ kind: "Burn", amount: "100" }, ALICE_PUB, "b2"),
		];
		const state = replayState(fields, blocks);
		assert.equal(state.balances.get(ALICE_PUB), 700n);
		assert.equal(state.balances.get(BOB_PUB), 200n);
		assert.equal(state.totalSupply, 900n);
	});
});

// ── applyOpToState — happy paths ────────────────────────────────

describe("applyOpToState — happy paths", () => {
	function freshState(): ReturnType<typeof zeroState> {
		const s = zeroState();
		s.ownerPubkey = ALICE_PUB;
		s.balances.set(ALICE_PUB, 1000n);
		s.totalSupply = 1000n;
		return s;
	}

	it("Mint: owner credits + supply increases", () => {
		const s = freshState();
		applyOpToState(s, { kind: "Mint", to: BOB_PUB, amount: "500" }, ALICE_PUB);
		assert.equal(s.balances.get(BOB_PUB), 500n);
		assert.equal(s.totalSupply, 1500n);
	});

	it("Transfer: debit signer, credit recipient", () => {
		const s = freshState();
		applyOpToState(s, { kind: "Transfer", to: BOB_PUB, amount: "300" }, ALICE_PUB);
		assert.equal(s.balances.get(ALICE_PUB), 700n);
		assert.equal(s.balances.get(BOB_PUB), 300n);
	});

	it("Burn: debit signer, decrement supply", () => {
		const s = freshState();
		applyOpToState(s, { kind: "Burn", amount: "100" }, ALICE_PUB);
		assert.equal(s.balances.get(ALICE_PUB), 900n);
		assert.equal(s.totalSupply, 900n);
	});

	it("Approve: sets allowance", () => {
		const s = freshState();
		applyOpToState(s, { kind: "Approve", spender: BOB_PUB, amount: "200" }, ALICE_PUB);
		assert.equal(s.allowances.get(ALICE_PUB)?.get(BOB_PUB), 200n);
	});

	it("TransferFrom: requires prior Approve, debits owner, decrements allowance", () => {
		const s = freshState();
		applyOpToState(s, { kind: "Approve", spender: BOB_PUB, amount: "200" }, ALICE_PUB);
		applyOpToState(s, { kind: "TransferFrom", from: ALICE_PUB, to: CHARLIE_PUB, amount: "150" }, BOB_PUB);
		assert.equal(s.balances.get(ALICE_PUB), 850n);
		assert.equal(s.balances.get(CHARLIE_PUB), 150n);
		assert.equal(s.allowances.get(ALICE_PUB)?.get(BOB_PUB), 50n);
	});

	it("RenounceMint: clears owner_pubkey", () => {
		const s = freshState();
		applyOpToState(s, { kind: "RenounceMint" }, ALICE_PUB);
		assert.equal(s.ownerPubkey, "");
	});

	it("Allowance reaching exactly 0 is removed (clean state)", () => {
		const s = freshState();
		applyOpToState(s, { kind: "Approve", spender: BOB_PUB, amount: "100" }, ALICE_PUB);
		applyOpToState(s, { kind: "TransferFrom", from: ALICE_PUB, to: CHARLIE_PUB, amount: "100" }, BOB_PUB);
		assert.equal(s.allowances.get(ALICE_PUB)?.get(BOB_PUB) ?? BIG_ZERO, BIG_ZERO);
	});

	it("Balance reaching exactly 0 is removed (clean state)", () => {
		const s = freshState();
		applyOpToState(s, { kind: "Transfer", to: BOB_PUB, amount: "1000" }, ALICE_PUB);
		assert.equal(s.balances.has(ALICE_PUB), false, "zero balance should be deleted");
	});
});

// ── applyOpToState — invariant violations ───────────────────────

describe("applyOpToState — invariant violations", () => {
	function freshState() {
		const s = zeroState();
		s.ownerPubkey = ALICE_PUB;
		s.balances.set(ALICE_PUB, 100n);
		s.totalSupply = 100n;
		return s;
	}

	it("Mint by non-owner is rejected", () => {
		const s = freshState();
		assert.throws(
			() => applyOpToState(s, { kind: "Mint", to: BOB_PUB, amount: "1" }, BOB_PUB),
			/only owner/,
		);
	});

	it("Mint after RenounceMint is rejected", () => {
		const s = freshState();
		applyOpToState(s, { kind: "RenounceMint" }, ALICE_PUB);
		assert.throws(
			() => applyOpToState(s, { kind: "Mint", to: ALICE_PUB, amount: "1" }, ALICE_PUB),
			/renounced/,
		);
	});

	it("Mint zero is rejected", () => {
		const s = freshState();
		assert.throws(
			() => applyOpToState(s, { kind: "Mint", to: BOB_PUB, amount: "0" }, ALICE_PUB),
			/> 0/,
		);
	});

	it("Mint negative amount is rejected (parseUint)", () => {
		const s = freshState();
		assert.throws(
			() => applyOpToState(s, { kind: "Mint", to: BOB_PUB, amount: "-1" }, ALICE_PUB),
			/decimal-digit/,
		);
	});

	it("Transfer with insufficient balance underflows", () => {
		const s = freshState();
		assert.throws(
			() => applyOpToState(s, { kind: "Transfer", to: BOB_PUB, amount: "200" }, ALICE_PUB),
			/underflow/,
		);
	});

	it("Burn with insufficient balance underflows", () => {
		const s = freshState();
		assert.throws(
			() => applyOpToState(s, { kind: "Burn", amount: "200" }, ALICE_PUB),
			/underflow/,
		);
	});

	it("TransferFrom without allowance underflows", () => {
		const s = freshState();
		assert.throws(
			() => applyOpToState(s, { kind: "TransferFrom", from: ALICE_PUB, to: BOB_PUB, amount: "1" }, BOB_PUB),
			/underflow/,
		);
	});

	it("TransferFrom exceeding allowance underflows", () => {
		const s = freshState();
		applyOpToState(s, { kind: "Approve", spender: BOB_PUB, amount: "50" }, ALICE_PUB);
		assert.throws(
			() => applyOpToState(s, { kind: "TransferFrom", from: ALICE_PUB, to: CHARLIE_PUB, amount: "60" }, BOB_PUB),
			/underflow/,
		);
	});

	it("RenounceMint twice is rejected", () => {
		const s = freshState();
		applyOpToState(s, { kind: "RenounceMint" }, ALICE_PUB);
		assert.throws(
			() => applyOpToState(s, { kind: "RenounceMint" }, ALICE_PUB),
			/already renounced/,
		);
	});
});

// ── BigInt overflow protection ──────────────────────────────────

describe("BigInt boundary", () => {
	it("Mint that would overflow U128_MAX is rejected", () => {
		const s = zeroState();
		s.ownerPubkey = ALICE_PUB;
		s.balances.set(ALICE_PUB, U128_MAX - 10n);
		s.totalSupply = U128_MAX - 10n;
		assert.throws(
			() => applyOpToState(s, { kind: "Mint", to: ALICE_PUB, amount: "100" }, ALICE_PUB),
			/exceeds max/,
		);
	});

	it("Mint up to exactly U128_MAX succeeds", () => {
		const s = zeroState();
		s.ownerPubkey = ALICE_PUB;
		s.balances.set(ALICE_PUB, U128_MAX - 5n);
		s.totalSupply = U128_MAX - 5n;
		applyOpToState(s, { kind: "Mint", to: ALICE_PUB, amount: "5" }, ALICE_PUB);
		assert.equal(s.totalSupply, U128_MAX);
		assert.equal(s.balances.get(ALICE_PUB), U128_MAX);
	});

	it("Transfer that would overflow recipient is rejected", () => {
		const s = zeroState();
		s.ownerPubkey = ALICE_PUB;
		s.balances.set(ALICE_PUB, 10n);
		s.balances.set(BOB_PUB, U128_MAX - 5n);
		s.totalSupply = U128_MAX;
		assert.throws(
			() => applyOpToState(s, { kind: "Transfer", to: BOB_PUB, amount: "10" }, ALICE_PUB),
			/exceeds max/,
		);
	});
});

// ── Integration via validateChange ──────────────────────────────

describe("validateChange end-to-end", () => {
	it("accepts a Deploy then an Op against the resulting state", () => {
		const deploy = deployChange({ initialSupply: 1000n });
		const fields = fieldsFromDeploy(deploy);

		const r1 = validateChange(deploy, {}, []);
		assert.equal(r1.valid, true);

		const transfer = opChange({ kind: "Transfer", to: BOB_PUB, amount: "300" }, ALICE_PUB);
		const r2 = validateChange(transfer, fields, []);
		assert.equal(r2.valid, true);
	});

	it("rejects an Op against an undeployed object", () => {
		const transfer = opChange({ kind: "Transfer", to: BOB_PUB, amount: "1" }, ALICE_PUB);
		const r = validateChange(transfer, {}, []);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /before deploy/);
	});

	it("rejects a Transfer that would underflow", () => {
		const fields = fieldsFromDeploy(deployChange({ initialSupply: 100n }));
		const transfer = opChange({ kind: "Transfer", to: BOB_PUB, amount: "200" }, ALICE_PUB);
		const r = validateChange(transfer, fields, []);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /underflow/);
	});

	it("rejects a Mint signed by someone other than owner", () => {
		const fields = fieldsFromDeploy(deployChange({ initialSupply: 100n }));
		const mint = opChange({ kind: "Mint", to: BOB_PUB, amount: "50" }, BOB_PUB);
		const r = validateChange(mint, fields, []);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /only owner/);
	});

	it("Mint after RenounceMint is rejected even by the original owner", () => {
		const deployFields = fieldsFromDeploy(deployChange({ initialSupply: 100n }));
		const renounce = blockFromOp({ kind: "RenounceMint" }, ALICE_PUB, "renounce-blk");
		const mint = opChange({ kind: "Mint", to: ALICE_PUB, amount: "1" }, ALICE_PUB);
		const r = validateChange(mint, deployFields, [renounce]);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /renounced/);
	});
});

// ── Program registration ────────────────────────────────────────

describe("program registration", () => {
	it("declares chainMode true and registers chain.token without a top-level validator", () => {
		assert.equal(tokenProgram.chainMode, true);
		assert.deepEqual(tokenProgram.validatedTypes, ["chain.token"]);
		// /consensus owns the registered validator. /token exposes its
		// semantic rules via the `validate_op` actor action.
		assert.equal(tokenProgram.validator, undefined);
	});

	it("exposes validate_op as an actor action", () => {
		assert.equal(typeof tokenProgram.actor?.actions?.validate_op, "function");
	});
});
