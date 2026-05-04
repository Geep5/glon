import { describe, it } from "node:test";
import assert from "node:assert";
import { __test } from "../../src/programs/handlers/plot.js";
import { hexEncode } from "../../src/crypto.js";

const { findPlot, verifyProof, DEFAULT_K, MIN_K, MAX_K } = __test;

describe("plot / constants", () => {
	it("DEFAULT_K is 25", () => {
		assert.strictEqual(DEFAULT_K, 25);
	});

	it("MIN_K is 18", () => {
		assert.strictEqual(MIN_K, 18);
	});

	it("MAX_K is 36", () => {
		assert.strictEqual(MAX_K, 36);
	});
});

describe("plot / registry", () => {
	it("findPlot returns undefined for unknown plot", () => {
		const plot = findPlot("nonexistent-plot-" + Date.now());
		assert.strictEqual(plot, undefined);
	});
});

describe("plot / verifyProof (requires chiapos binary)", () => {
	it("verifyProof rejects invalid proof", () => {
		const challenge = new Uint8Array(32);
		crypto.getRandomValues(challenge);
		const fakePlot = {
			name: "fake",
			path: "/dev/null",
			k: 25,
			id: "00".repeat(32),
			pubkeyHex: "test",
			memo: "0x00",
			createdAt: 0,
		};
		const fakeProof = {
			plotName: "fake",
			challengeHex: hexEncode(challenge),
			proofs: ["00".repeat(100)],
			quality: 0,
			k: 25,
			plotId: "00".repeat(32),
		};
		const valid = verifyProof(fakeProof, challenge, fakePlot);
		assert.strictEqual(valid, false);
	});
});
