import { describe, it } from "node:test";
import assert from "node:assert";
import { __test, ANCHOR_TYPE_KEY } from "../../src/programs/handlers/anchor.js";
import { sha256, hexEncode } from "../../src/crypto.js";

const { leafHash, merkleRoot, verifyMerkleRoot } = __test;

describe("anchor / merkle", () => {
	it("leafHash is deterministic", () => {
		const h1 = leafHash("abc", "def");
		const h2 = leafHash("abc", "def");
		assert.deepStrictEqual(h1, h2);
		const h3 = leafHash("abc", "deg");
		assert.notDeepStrictEqual(h1, h3);
	});

	it("merkleRoot of empty leaves is sha256(0 bytes)", () => {
		const root = merkleRoot([]);
		const expected = sha256(new Uint8Array(0));
		assert.deepStrictEqual(root, expected);
	});

	it("merkleRoot of one leaf is the leaf hash", () => {
		const leaf = leafHash("obj1", "head1");
		const root = merkleRoot([leaf]);
		assert.deepStrictEqual(root, leaf);
	});

	it("merkleRoot of two leaves is sha256(left+right)", () => {
		const a = leafHash("a", "h1");
		const b = leafHash("b", "h2");
		const root = merkleRoot([a, b]);
		const aHex = hexEncode(a);
		const bHex = hexEncode(b);
		const [first, second] = aHex < bHex ? [a, b] : [b, a];
		const combined = new Uint8Array(first.length + second.length);
		combined.set(first);
		combined.set(second, first.length);
		assert.deepStrictEqual(root, sha256(combined));
	});

	it("merkleRoot is deterministic regardless of input order", () => {
		const leaves = [
			leafHash("obj1", "head1"),
			leafHash("obj2", "head2"),
			leafHash("obj3", "head3"),
		];
		const root1 = merkleRoot([...leaves]);
		const root2 = merkleRoot([leaves[2], leaves[0], leaves[1]]);
		assert.deepStrictEqual(root1, root2);
	});

	it("merkleRoot handles odd number of leaves by duplicating last", () => {
		const leaves = [
			leafHash("a", "h1"),
			leafHash("b", "h2"),
			leafHash("c", "h3"),
		];
		const root = merkleRoot(leaves);
		assert.strictEqual(root.length, 32);
	});
});

describe("anchor / verifyMerkleRoot", () => {
	it("returns true for valid commits", () => {
		const commits = [
			{ objectId: "obj1", headId: "head1" },
			{ objectId: "obj2", headId: "head2" },
		];
		const leaves = commits.map((c) => leafHash(c.objectId, c.headId));
		const root = hexEncode(merkleRoot(leaves));
		assert.strictEqual(verifyMerkleRoot(root, commits), true);
	});

	it("returns false for tampered commits", () => {
		const commits = [
			{ objectId: "obj1", headId: "head1" },
			{ objectId: "obj2", headId: "head2" },
		];
		const leaves = commits.map((c) => leafHash(c.objectId, c.headId));
		const root = hexEncode(merkleRoot(leaves));
		const tampered = [
			{ objectId: "obj1", headId: "head1" },
			{ objectId: "obj2", headId: "TAMPERED" },
		];
		assert.strictEqual(verifyMerkleRoot(root, tampered), false);
	});

	it("returns false for wrong root", () => {
		const commits = [{ objectId: "obj1", headId: "head1" }];
		assert.strictEqual(
			verifyMerkleRoot("0000000000000000000000000000000000000000000000000000000000000000", commits),
			false,
		);
	});
});

describe("anchor / inflation rewards", () => {
	it("computeReward returns base reward at height 0", () => {
		const reward = __test.computeReward(0);
		assert.strictEqual(reward, __test.BASE_REWARD_UNITS);
	});

	it("computeReward halves after HALVING_INTERVAL", () => {
		const before = __test.computeReward(__test.HALVING_INTERVAL - 1);
		const after = __test.computeReward(__test.HALVING_INTERVAL);
		assert.strictEqual(before, __test.BASE_REWARD_UNITS);
		assert.strictEqual(after, __test.BASE_REWARD_UNITS / 2);
	});

	it("computeReward halves twice after 2*HALVING_INTERVAL", () => {
		const reward = __test.computeReward(__test.HALVING_INTERVAL * 2);
		assert.strictEqual(reward, __test.BASE_REWARD_UNITS / 4);
	});

	it("computeReward never goes below MIN_REWARD", () => {
		const reward = __test.computeReward(__test.HALVING_INTERVAL * 100);
		assert.strictEqual(reward, 1);
	});
});

describe("anchor / constants", () => {
	it("ANCHOR_TYPE_KEY is chain.anchor", () => {
		assert.strictEqual(ANCHOR_TYPE_KEY, "chain.anchor");
	});
});

