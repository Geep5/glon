/**
 * /consensus program tests.
 *
 * Coverage:
 *   - classifyForFee: Deploy / Mint / Other recognition
 *   - minimumFee: 100x / 10x / 1x multipliers
 *   - consensusGate: signature presence, nonce replay, nonce > last,
 *     fee minimums per kind, state advancement, purity
 *   - validator (batch form): rejects on first invalid change in a batch,
 *     advances state across multiple changes
 *   - validateFully: dispatches to /token.validate_op via mock dispatchProgram
 *   - actor actions: status / getNonce / recordAccepted / setBaseFee
 *
 * Run: npx tsx --test test/chain/consensus.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import consensusProgram, { __test, DEFAULT_BASE_FEE, DEPLOY_FEE_MULTIPLIER, MINT_FEE_MULTIPLIER } from "../../src/programs/handlers/consensus.js";
import type { Change } from "../../src/proto.js";
import { __test as tokenTest, OP_CONTENT_TYPE } from "../../src/programs/handlers/token.js";

const {
	classifyForFee,
	minimumFee,
	consensusGate,
	loadState,
	makeValidator,
	validateFully,
	resetMirror,
} = __test;

const { buildDeployChange, buildOpChange } = tokenTest;

// ── Fixtures ────────────────────────────────────────────────────

const ALICE_PUB_HEX = "a".repeat(64);
const BOB_PUB_HEX = "b".repeat(64);

function alicePub(): Uint8Array {
	return Buffer.from(ALICE_PUB_HEX, "hex");
}

function deployChange(opts?: { nonce?: number; fee?: number }): Change {
	const c = buildDeployChange({
		tokenId: "tok-1", timestamp: 1, author: "test",
		name: "TestCoin", symbol: "TST", decimals: 6,
		ownerPubkeyHex: ALICE_PUB_HEX, initialSupply: 1000n,
	});
	c.authorSig = {
		pubkey: alicePub(),
		signature: new Uint8Array(64),
		nonce: opts?.nonce ?? 1,
		fee: opts?.fee ?? Number(DEFAULT_BASE_FEE * DEPLOY_FEE_MULTIPLIER),
	};
	return c;
}

function transferChange(opts?: { nonce?: number; fee?: number }): Change {
	const c = buildOpChange({
		tokenId: "tok-1", parentIds: [], timestamp: 2, author: "test",
		op: { kind: "Transfer", to: BOB_PUB_HEX, amount: "10" },
		signerPubkeyHex: ALICE_PUB_HEX,
		blockId: "blk-x",
	});
	c.authorSig = {
		pubkey: alicePub(),
		signature: new Uint8Array(64),
		nonce: opts?.nonce ?? 2,
		fee: opts?.fee ?? Number(DEFAULT_BASE_FEE),
	};
	return c;
}

function mintChange(opts?: { nonce?: number; fee?: number }): Change {
	const c = buildOpChange({
		tokenId: "tok-1", parentIds: [], timestamp: 3, author: "test",
		op: { kind: "Mint", to: BOB_PUB_HEX, amount: "5" },
		signerPubkeyHex: ALICE_PUB_HEX,
		blockId: "blk-mint",
	});
	c.authorSig = {
		pubkey: alicePub(),
		signature: new Uint8Array(64),
		nonce: opts?.nonce ?? 3,
		fee: opts?.fee ?? Number(DEFAULT_BASE_FEE * MINT_FEE_MULTIPLIER),
	};
	return c;
}

function emptyState() {
	return loadState({});
}

beforeEach(() => {
	resetMirror();
});

// ── classifyForFee ──────────────────────────────────────────────

describe("classifyForFee", () => {
	it("Deploy when ObjectCreate is present", () => {
		assert.equal(classifyForFee(deployChange()), "Deploy");
	});

	it("Mint when BlockAdd carries chain.token.op meta.op=Mint", () => {
		assert.equal(classifyForFee(mintChange()), "Mint");
	});

	it("Other for Transfer/Burn/etc", () => {
		assert.equal(classifyForFee(transferChange()), "Other");
	});

	it("Other for changes whose meta is malformed", () => {
		const c: Change = {
			id: new Uint8Array(0), objectId: "x", parentIds: [],
			ops: [{ blockAdd: {
				parentId: "", afterId: "",
				block: { id: "b", childrenIds: [], content: { custom: {
					contentType: OP_CONTENT_TYPE, data: new Uint8Array(), meta: { foo: "bar" },
				} } },
			} }],
			timestamp: 0, author: "t",
		};
		assert.equal(classifyForFee(c), "Other");
	});
});

// ── minimumFee ──────────────────────────────────────────────────

describe("minimumFee", () => {
	it("applies the documented multipliers", () => {
		const policy = { baseFee: 7n };
		assert.equal(minimumFee("Deploy", policy), 700n);
		assert.equal(minimumFee("Mint", policy), 70n);
		assert.equal(minimumFee("Other", policy), 7n);
	});

	it("default policy uses base fee 1", () => {
		assert.equal(DEFAULT_BASE_FEE, 1n);
	});
});

// ── consensusGate ───────────────────────────────────────────────

describe("consensusGate — happy path", () => {
	it("accepts a properly signed Deploy with default fee policy", () => {
		const r = consensusGate(deployChange(), emptyState());
		assert.equal(r.ok, true);
		assert.equal((r as any).kind, "Deploy");
		assert.equal((r as any).nextState.nonces[ALICE_PUB_HEX], 1);
	});

	it("advances the nonce on the next valid change", () => {
		const s1 = consensusGate(deployChange(), emptyState());
		assert.equal(s1.ok, true);
		const s2 = consensusGate(transferChange({ nonce: 2 }), (s1 as any).nextState);
		assert.equal(s2.ok, true);
		assert.equal((s2 as any).nextState.nonces[ALICE_PUB_HEX], 2);
	});
});

describe("consensusGate — rejections", () => {
	it("rejects a Change with no author_sig", () => {
		const c = deployChange();
		c.authorSig = undefined;
		const r = consensusGate(c, emptyState());
		assert.equal(r.ok, false);
		assert.match((r as any).reason, /not signed/);
	});

	it("rejects nonce replay (nonce equal to last seen)", () => {
		const s = emptyState();
		s.nonces[ALICE_PUB_HEX] = 5;
		const r = consensusGate(deployChange({ nonce: 5 }), s);
		assert.equal(r.ok, false);
		assert.match((r as any).reason, /nonce replay/);
	});

	it("rejects out-of-order nonce (nonce below last seen)", () => {
		const s = emptyState();
		s.nonces[ALICE_PUB_HEX] = 10;
		const r = consensusGate(deployChange({ nonce: 7 }), s);
		assert.equal(r.ok, false);
		assert.match((r as any).reason, /nonce replay/);
	});

	it("accepts nonce strictly greater than last", () => {
		const s = emptyState();
		s.nonces[ALICE_PUB_HEX] = 5;
		const r = consensusGate(deployChange({ nonce: 6 }), s);
		assert.equal(r.ok, true);
	});

	it("rejects Deploy with fee below 100x base", () => {
		const r = consensusGate(deployChange({ fee: 50 }), emptyState());
		assert.equal(r.ok, false);
		assert.match((r as any).reason, /fee 50 below minimum 100/);
	});

	it("rejects Mint with fee below 10x base", () => {
		const r = consensusGate(mintChange({ nonce: 1, fee: 5 }), emptyState());
		assert.equal(r.ok, false);
		assert.match((r as any).reason, /fee 5 below minimum 10/);
	});

	it("accepts Other with fee at the base minimum", () => {
		const r = consensusGate(transferChange({ nonce: 1, fee: 1 }), emptyState());
		assert.equal(r.ok, true);
	});

	it("Deploy fee minimum scales with base fee", () => {
		const s = emptyState();
		s.feePolicy.baseFee = "5";
		const tooLow = consensusGate(deployChange({ fee: 499 }), s);
		assert.equal(tooLow.ok, false);
		const justRight = consensusGate(deployChange({ fee: 500 }), s);
		assert.equal(justRight.ok, true);
	});

	it("does not mutate the input state", () => {
		const s = emptyState();
		const before = JSON.parse(JSON.stringify(s));
		consensusGate(deployChange(), s);
		const after = JSON.parse(JSON.stringify(s));
		assert.deepEqual(before, after, "consensusGate must be pure");
	});
});

// ── Registered validator (batch form) ──────────────────────────

describe("registered validator", () => {
	it("accepts a batch with monotonically increasing nonces from one pubkey", () => {
		const v = makeValidator(() => emptyState());
		const r = v([
			deployChange({ nonce: 1 }),
			transferChange({ nonce: 2 }),
		]);
		assert.equal(r.valid, true);
	});

	it("rejects a batch where the second change replays the first's nonce", () => {
		const v = makeValidator(() => emptyState());
		const r = v([
			deployChange({ nonce: 1 }),
			transferChange({ nonce: 1 }),
		]);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /nonce replay/);
	});

	it("rejects a batch on the first low-fee change", () => {
		const v = makeValidator(() => emptyState());
		const r = v([
			deployChange({ nonce: 1, fee: 50 }),
			transferChange({ nonce: 2 }),
		]);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /fee 50/);
	});

	it("uses the snapshot of state at validator-creation time", () => {
		const seeded = emptyState();
		seeded.nonces[ALICE_PUB_HEX] = 100;
		const v = makeValidator(() => seeded);
		const r = v([deployChange({ nonce: 5 })]);
		assert.equal(r.valid, false);
		assert.match(r.error ?? "", /nonce replay/);
	});
});

// ── validateFully (async, dispatches to type validator) ────────

describe("validateFully", () => {
	function makeCtx(opts: {
		typeKey?: string;
		dispatchHandler?: (input: any) => any;
	}) {
		const dispatchCalls: any[] = [];
		const ctx = {
			store: {
				get: async (_id: string) => ({ typeKey: opts.typeKey ?? "chain.token", fields: {}, blocks: [] }),
			},
			dispatchProgram: async (prefix: string, action: string, args: any[]) => {
				dispatchCalls.push({ prefix, action, args });
				if (opts.dispatchHandler) return opts.dispatchHandler(args[0]);
				return { valid: true };
			},
		} as any;
		return { ctx, dispatchCalls };
	}

	it("dispatches to /token.validate_op for chain.token", async () => {
		const { ctx, dispatchCalls } = makeCtx({});
		const r = await validateFully(deployChange(), "tok-1", emptyState(), ctx);
		assert.equal(r.ok, true);
		assert.equal(dispatchCalls.length, 1);
		assert.equal(dispatchCalls[0].prefix, "/token");
		assert.equal(dispatchCalls[0].action, "validate_op");
		assert.equal(dispatchCalls[0].args[0].tokenId, "tok-1");
	});

	it("returns the consensus failure WITHOUT dispatching when gate fails", async () => {
		const { ctx, dispatchCalls } = makeCtx({});
		const c = deployChange({ fee: 0 });
		const r = await validateFully(c, "tok-1", emptyState(), ctx);
		assert.equal(r.ok, false);
		assert.equal(dispatchCalls.length, 0, "must not dispatch when gate fails");
	});

	it("propagates the type-validator's reason on semantic rejection", async () => {
		const { ctx } = makeCtx({
			dispatchHandler: () => ({ valid: false, error: "token op: insufficient balance" }),
		});
		const r = await validateFully(transferChange(), "tok-1", emptyState(), ctx);
		assert.equal(r.ok, false);
		assert.match((r as any).reason, /insufficient balance/);
	});

	it("rejects when no dispatch is registered for the typeKey", async () => {
		const { ctx } = makeCtx({ typeKey: "chain.unknown" });
		const r = await validateFully(deployChange(), "tok-1", emptyState(), ctx);
		assert.equal(r.ok, false);
		assert.match((r as any).reason, /no dispatch/);
	});

	it("falls back to the change's objectCreate typeKey when the object is missing", async () => {
		const ctx = {
			store: { get: async () => null },
			dispatchProgram: async () => ({ valid: true }),
		} as any;
		const r = await validateFully(deployChange(), "tok-1", emptyState(), ctx);
		assert.equal(r.ok, true);
	});
});

// ── Program registration ────────────────────────────────────────

describe("program registration", () => {
	it("declares chain.token in validatedTypes", () => {
		assert.deepEqual(consensusProgram.validatedTypes, ["chain.token"]);
		assert.equal(typeof consensusProgram.validator, "function");
	});

	it("does NOT declare chainMode (that's the type-owning programs' job)", () => {
		assert.equal(consensusProgram.chainMode, undefined);
	});

	it("registered validator wires through to consensusGate logic", () => {
		const r = consensusProgram.validator!([deployChange()]);
		assert.equal(r.valid, true);
	});
});

// ── Actor actions ───────────────────────────────────────────────

describe("actor actions", () => {
	function ctxWithState() {
		const state: Record<string, any> = consensusProgram.actor!.createState!();
		return {
			ctx: { state } as any,
			state,
		};
	}

	it("status returns nonces + minimums", async () => {
		const { ctx } = ctxWithState();
		const r = await consensusProgram.actor!.actions!.status!(ctx) as any;
		assert.deepEqual(r.nonces, {});
		assert.equal(r.feePolicy.baseFee, "1");
		assert.equal(r.minimums.deploy, "100");
		assert.equal(r.minimums.mint, "10");
		assert.equal(r.minimums.other, "1");
	});

	it("getNonce returns 0 for unseen pubkey", async () => {
		const { ctx } = ctxWithState();
		const n = await consensusProgram.actor!.actions!.getNonce!(ctx, ALICE_PUB_HEX);
		assert.equal(n, 0);
	});

	it("recordAccepted advances and getNonce reflects it", async () => {
		const { ctx } = ctxWithState();
		await consensusProgram.actor!.actions!.recordAccepted!(ctx, ALICE_PUB_HEX, 5);
		const n = await consensusProgram.actor!.actions!.getNonce!(ctx, ALICE_PUB_HEX);
		assert.equal(n, 5);
	});

	it("recordAccepted rejects non-monotonic nonce", async () => {
		const { ctx } = ctxWithState();
		await consensusProgram.actor!.actions!.recordAccepted!(ctx, ALICE_PUB_HEX, 5);
		await assert.rejects(
			() => consensusProgram.actor!.actions!.recordAccepted!(ctx, ALICE_PUB_HEX, 4),
			/<= last seen/,
		);
	});

	it("setBaseFee updates policy and is reflected in status", async () => {
		const { ctx } = ctxWithState();
		await consensusProgram.actor!.actions!.setBaseFee!(ctx, "10");
		const s = await consensusProgram.actor!.actions!.status!(ctx) as any;
		assert.equal(s.feePolicy.baseFee, "10");
		assert.equal(s.minimums.deploy, "1000");
	});

	it("setBaseFee rejects negative or out-of-range values", async () => {
		const { ctx } = ctxWithState();
		await assert.rejects(() => consensusProgram.actor!.actions!.setBaseFee!(ctx, "-1"), /out of range/);
	});
});
