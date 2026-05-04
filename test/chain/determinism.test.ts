/**
 * Determinism harness for chain-mode encoding.
 *
 * The single most important chain-layer test. If it ever fails on CI,
 * every consensus assumption is suspect: two nodes computing different
 * bytes for the same logical Change cannot agree on the chain.
 *
 * What it verifies:
 *   1. `canonicalEncodeChange` is byte-stable across repeated calls in
 *      the same process — the obvious sanity check.
 *   2. The same Change with semantically identical `map<>` fields whose
 *      keys were inserted in different orders produces byte-identical
 *      output. This is the actual canonicalization claim.
 *   3. Subprocess agreement: spawning a fresh Node process to encode the
 *      same Change yields the same bytes, simulating two nodes on the
 *      network.
 *   4. `canonicalEncodeChangeForSigning` zeroes both `id` and
 *      `authorSig.signature` while preserving pubkey/nonce/fee — the
 *      contract the signature gate depends on.
 *
 * Run: npx tsx --test test/chain/determinism.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as childProcess from "node:child_process";
import { sha256, hexEncode } from "../../src/crypto.js";
import { canonicalEncodeChange, canonicalEncodeChangeForSigning } from "../../src/det/canonical.js";
import { stringVal, intVal, mapVal, listVal, type Change, type Value } from "../../src/proto.js";

// ── Fixtures ────────────────────────────────────────────────────

/** A Change exercising every map-bearing op variant. */
function makeRichChange(mapInsertOrder: string[] = ["a", "b", "c"]): Change {
	const fields: Record<string, Value> = {};
	for (const k of mapInsertOrder) {
		fields[k] = stringVal(`v-${k}`);
	}
	return {
		id: new Uint8Array(0),
		objectId: "obj-1",
		parentIds: [new Uint8Array([1, 2, 3])],
		ops: [
			{ objectCreate: { typeKey: "chain.coin.bucket" } },
			{
				fieldSet: {
					key: "metadata",
					value: mapVal(fields),
				},
			},
			{
				fieldSet: {
					key: "nested_list",
					value: listVal([
						mapVal({ x: stringVal("1"), y: stringVal("2") }),
						mapVal({ y: stringVal("4"), x: stringVal("3") }),  // different order
					]),
				},
			},
			{
				blockAdd: {
					parentId: "",
					afterId: "",
					block: {
						id: "blk-1",
						childrenIds: [],
						content: {
							custom: {
								contentType: "chain.coin.bucket.op",
								data: new Uint8Array(),
								meta: { op: "Mint", to: "alice", amount: "1000" },
							},
						},
					},
				},
			},
		],
		timestamp: 1700000000000,
		author: "test",
		authorSig: {
			pubkey: new Uint8Array(32).fill(0xab),
			signature: new Uint8Array(64).fill(0xcd),
			nonce: 1,
			fee: 100,
		},
	};
}

// ── Tests ───────────────────────────────────────────────────────

describe("canonicalEncodeChange", () => {
	it("is stable across repeated calls in the same process", () => {
		const c = makeRichChange();
		const a = canonicalEncodeChange(c);
		const b = canonicalEncodeChange(c);
		assert.equal(hexEncode(a), hexEncode(b));
	});

	it("produces identical bytes regardless of map-key insertion order", () => {
		const c1 = makeRichChange(["a", "b", "c"]);
		const c2 = makeRichChange(["c", "a", "b"]);
		const c3 = makeRichChange(["b", "c", "a"]);
		const e1 = canonicalEncodeChange(c1);
		const e2 = canonicalEncodeChange(c2);
		const e3 = canonicalEncodeChange(c3);
		assert.equal(hexEncode(e1), hexEncode(e2));
		assert.equal(hexEncode(e2), hexEncode(e3));
	});

	it("produces identical bytes regardless of CustomContent.meta key order", () => {
		const make = (meta: Record<string, string>): Change => ({
			id: new Uint8Array(0),
			objectId: "obj-1",
			parentIds: [],
			ops: [{
				blockAdd: {
					parentId: "",
					afterId: "",
					block: {
						id: "blk",
						childrenIds: [],
						content: {
							custom: { contentType: "x", data: new Uint8Array(), meta },
						},
					},
				},
			}],
			timestamp: 0,
			author: "t",
		});
		const e1 = canonicalEncodeChange(make({ a: "1", b: "2", c: "3" }));
		const e2 = canonicalEncodeChange(make({ c: "3", a: "1", b: "2" }));
		assert.equal(hexEncode(e1), hexEncode(e2));
	});

	it("zeroes the id field even if a non-zero id is passed in", () => {
		const c = makeRichChange();
		const withId: Change = { ...c, id: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) };
		const a = canonicalEncodeChange(c);
		const b = canonicalEncodeChange(withId);
		assert.equal(hexEncode(a), hexEncode(b), "id is zeroed; encoding ignores incoming value");
	});

	it("DOES include authorSig in the encoding (id commits to signature)", () => {
		const c = makeRichChange();
		const withDifferentSig: Change = {
			...c,
			authorSig: c.authorSig ? { ...c.authorSig, signature: new Uint8Array(64).fill(0xff) } : undefined,
		};
		const a = canonicalEncodeChange(c);
		const b = canonicalEncodeChange(withDifferentSig);
		assert.notEqual(
			hexEncode(a),
			hexEncode(b),
			"different signatures must produce different ids",
		);
	});

	it("hashes to the same content-address as a parallel subprocess", () => {
		// Spawn a fresh Node process, encode the same Change, compare hashes.
		// This is the "two nodes on the network" scenario.
		const c = makeRichChange();
		const expected = hexEncode(sha256(canonicalEncodeChange(c)));

		const script = `
			import { sha256, hexEncode } from "./src/crypto.ts";
			import { canonicalEncodeChange } from "./src/det/canonical.ts";
			import { stringVal, mapVal, listVal } from "./src/proto.ts";
			const fields = {};
			for (const k of ["a", "b", "c"]) fields[k] = stringVal("v-" + k);
			const change = ${JSON.stringify({
				placeholder: "rebuild below",
			})};
			// We rebuild the Change inline because Uint8Array doesn't survive JSON.
			const c = {
				id: new Uint8Array(0),
				objectId: "obj-1",
				parentIds: [new Uint8Array([1, 2, 3])],
				ops: [
					{ objectCreate: { typeKey: "chain.coin.bucket" } },
					{ fieldSet: { key: "metadata", value: mapVal(fields) } },
					{ fieldSet: { key: "nested_list", value: listVal([
						mapVal({ x: stringVal("1"), y: stringVal("2") }),
						mapVal({ y: stringVal("4"), x: stringVal("3") }),
					]) } },
					{ blockAdd: { parentId: "", afterId: "", block: {
						id: "blk-1", childrenIds: [],
						content: { custom: { contentType: "chain.coin.bucket.op", data: new Uint8Array(),
							meta: { op: "Mint", to: "alice", amount: "1000" } } },
					} } },
				],
				timestamp: 1700000000000,
				author: "test",
				authorSig: {
					pubkey: new Uint8Array(32).fill(0xab),
					signature: new Uint8Array(64).fill(0xcd),
					nonce: 1,
					fee: 100,
				},
			};
			process.stdout.write(hexEncode(sha256(canonicalEncodeChange(c))));
		`;
		const result = childProcess.spawnSync(
			"npx",
			["tsx", "-e", script],
			{ encoding: "utf-8", cwd: process.cwd(), timeout: 30000 },
		);
		if (result.status !== 0) {
			throw new Error(`subprocess failed: ${result.stderr}`);
		}
		const subprocessHash = result.stdout.trim();
		assert.equal(subprocessHash, expected, "subprocess and parent must compute the same hash");
	});
});

describe("canonicalEncodeChangeForSigning", () => {
	it("zeroes authorSig.signature but preserves pubkey/nonce/fee", () => {
		const c1 = makeRichChange();
		const c2: Change = {
			...c1,
			authorSig: c1.authorSig
				? { ...c1.authorSig, signature: new Uint8Array(64).fill(0xff) }
				: undefined,
		};
		// Different signature bytes → SAME signing payload (signature is what's
		// being computed, so it can't be in its own input).
		const a = canonicalEncodeChangeForSigning(c1);
		const b = canonicalEncodeChangeForSigning(c2);
		assert.equal(hexEncode(a), hexEncode(b));
	});

	it("differs from canonicalEncodeChange (signature is excluded)", () => {
		const c = makeRichChange();
		const signing = canonicalEncodeChangeForSigning(c);
		const idding = canonicalEncodeChange(c);
		assert.notEqual(hexEncode(signing), hexEncode(idding));
	});

	it("changing nonce or fee changes the signing payload", () => {
		const c1 = makeRichChange();
		const c2: Change = {
			...c1,
			authorSig: c1.authorSig ? { ...c1.authorSig, nonce: c1.authorSig.nonce + 1 } : undefined,
		};
		const c3: Change = {
			...c1,
			authorSig: c1.authorSig ? { ...c1.authorSig, fee: c1.authorSig.fee + 1 } : undefined,
		};
		const a = canonicalEncodeChangeForSigning(c1);
		const b = canonicalEncodeChangeForSigning(c2);
		const d = canonicalEncodeChangeForSigning(c3);
		assert.notEqual(hexEncode(a), hexEncode(b), "nonce must commit to the signature");
		assert.notEqual(hexEncode(a), hexEncode(d), "fee must commit to the signature");
	});
});
