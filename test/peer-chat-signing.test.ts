/**
 * Peer-chat envelope signing tests.
 *
 * Covers the transport-level auth contract:
 *   - canonicalJSON is byte-stable across key insertion order
 *   - sign + verify round-trip succeeds
 *   - tampered body, sig, or pubkey causes verify to throw
 *   - missing sig or pubkey causes verify to throw
 *
 * Does not cross the wallet boundary — we sign with raw ed25519 here so
 * the test stays a pure function-level check.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import peerChatProgram, { __test } from "../src/programs/handlers/peer-chat.js";
import { generateKeyPair, sign as ed25519Sign } from "../src/det/ed25519.js";
import { hexEncode } from "../src/crypto.js";

const { canonicalJSON, verifyEnvelopeSignature } = __test;

function makeEnvelope(overrides: Record<string, unknown> = {}): any {
	return {
		v: 1,
		from_agent_uuid: "11111111-2222-4333-8444-555555555555",
		from_display_name: "Mikey",
		to_agent_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		to_display_name: "Tarzan",
		body: "Hey Tarzan",
		...overrides,
	};
}

function signEnv(env: any, privateKey: Uint8Array, pubkeyHex: string): any {
	const envWithoutSig = { ...env };
	delete envWithoutSig.sig;
	envWithoutSig.from_pubkey = pubkeyHex;
	const bytes = new Uint8Array(Buffer.from(canonicalJSON(envWithoutSig), "utf8"));
	const sig = ed25519Sign(privateKey, bytes);
	return { ...envWithoutSig, sig: hexEncode(sig) };
}

describe("peer-chat program", () => {
	it("exports a program definition", () => {
		assert.ok(peerChatProgram);
		assert.ok(peerChatProgram.actor);
	});
});

describe("canonicalJSON", () => {
	it("produces byte-stable output regardless of key insertion order", () => {
		const a = canonicalJSON({ b: 2, a: 1, c: { y: 9, x: 8 } });
		const b = canonicalJSON({ c: { x: 8, y: 9 }, a: 1, b: 2 });
		assert.equal(a, b);
		assert.equal(a, `{"a":1,"b":2,"c":{"x":8,"y":9}}`);
	});

	it("preserves array order", () => {
		const out = canonicalJSON({ items: [3, 1, 2] });
		assert.equal(out, `{"items":[3,1,2]}`);
	});
});

describe("verifyEnvelopeSignature", () => {
	it("verifies a correctly signed envelope and returns the pubkey", () => {
		const kp = generateKeyPair();
		const pubHex = hexEncode(kp.publicKey);
		const env = signEnv(makeEnvelope(), kp.privateKey, pubHex);
		const recovered = verifyEnvelopeSignature(env);
		assert.equal(recovered.toLowerCase(), pubHex.toLowerCase());
	});

	it("rejects a tampered body", () => {
		const kp = generateKeyPair();
		const env = signEnv(makeEnvelope(), kp.privateKey, hexEncode(kp.publicKey));
		const tampered = { ...env, body: "different message" };
		assert.throws(() => verifyEnvelopeSignature(tampered), /verify failed/);
	});

	it("rejects a tampered signature", () => {
		const kp = generateKeyPair();
		const env = signEnv(makeEnvelope(), kp.privateKey, hexEncode(kp.publicKey));
		// flip a hex digit
		const sig = env.sig as string;
		const flipped = sig.slice(0, -1) + (sig[sig.length - 1] === "0" ? "1" : "0");
		assert.throws(() => verifyEnvelopeSignature({ ...env, sig: flipped }), /verify failed/);
	});

	it("rejects a swapped pubkey (signature was made by a different key)", () => {
		const kp = generateKeyPair();
		const other = generateKeyPair();
		const env = signEnv(makeEnvelope(), kp.privateKey, hexEncode(kp.publicKey));
		const swapped = { ...env, from_pubkey: hexEncode(other.publicKey) };
		assert.throws(() => verifyEnvelopeSignature(swapped), /verify failed/);
	});

	it("rejects an envelope missing sig", () => {
		const env = makeEnvelope({ from_pubkey: "00".repeat(32) });
		assert.throws(() => verifyEnvelopeSignature(env), /missing sig/);
	});

	it("rejects an envelope missing from_pubkey", () => {
		const env = makeEnvelope({ sig: "00".repeat(64) });
		assert.throws(() => verifyEnvelopeSignature(env), /missing from_pubkey/);
	});

	it("rejects a pubkey of the wrong length", () => {
		const kp = generateKeyPair();
		const env = signEnv(makeEnvelope(), kp.privateKey, hexEncode(kp.publicKey));
		const badPubkey = "00".repeat(31); // 31 bytes instead of 32
		assert.throws(() => verifyEnvelopeSignature({ ...env, from_pubkey: badPubkey }), /must be 32 bytes/);
	});

	it("rejects a signature of the wrong length", () => {
		const kp = generateKeyPair();
		const env = signEnv(makeEnvelope(), kp.privateKey, hexEncode(kp.publicKey));
		const badSig = "00".repeat(63); // 63 bytes instead of 64
		assert.throws(() => verifyEnvelopeSignature({ ...env, sig: badSig }), /must be 64 bytes/);
	});

	it("is robust to envelope key reordering between sign and verify", () => {
		const kp = generateKeyPair();
		const env = signEnv(makeEnvelope(), kp.privateKey, hexEncode(kp.publicKey));
		// Rebuild the object with keys in a different order.
		const reordered = {
			sig: env.sig,
			body: env.body,
			v: env.v,
			to_display_name: env.to_display_name,
			from_pubkey: env.from_pubkey,
			from_agent_uuid: env.from_agent_uuid,
			from_display_name: env.from_display_name,
			to_agent_uuid: env.to_agent_uuid,
		};
		const recovered = verifyEnvelopeSignature(reordered);
		assert.equal(recovered.toLowerCase(), hexEncode(kp.publicKey).toLowerCase());
	});
});
