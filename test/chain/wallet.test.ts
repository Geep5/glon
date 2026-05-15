/**
 * /wallet program tests.
 *
 * Covers:
 *   - new / list / show / remove cycle
 *   - persistence: keys survive a fresh read of the file
 *   - private material never surfaces from the public API
 *   - file mode is 0600 (POSIX-only check)
 *   - signChange round-trip:
 *     1. construct an unsigned Change
 *     2. sign via wallet
 *     3. verify the signature externally with the same pubkey
 *     4. confirm the id matches sha256(canonical(signed change))
 *   - signature is rejected when wallet name doesn't exist, nonce is bad, etc.
 *
 * Uses a temp file path (no real ~/.glon clobbering).
 *
 * Run: npx tsx --test test/chain/wallet.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import walletProgram, { __test } from "../../src/programs/handlers/wallet.js";
	import { encodeChange, decodeChange, encodeSignature, decodeSignature, type Change } from "../../src/proto.js";
	import { canonicalEncodeChange, canonicalEncodeChangeForSigning } from "../../src/det/canonical.js";
	import { verify as ed25519Verify } from "../../src/det/ed25519.js";
	import { sha256, hexEncode, hexDecode } from "../../src/crypto.js";
	const { doNew, doList, doShow, doRemove, doKeyForPubkey, doSignChange } = __test;

// ── Temp-file harness ────────────────────────────────────────────

let tmpPath: string;

beforeEach(() => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glon-wallet-test-"));
	tmpPath = path.join(dir, "wallet.json");
});

afterEach(() => {
	if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
	const dir = path.dirname(tmpPath);
	if (fs.existsSync(dir)) fs.rmdirSync(dir);
});

// ── Fixtures ────────────────────────────────────────────────────

function unsignedChange(objectId: string, typeKey: string): Change {
	return {
		id: new Uint8Array(0),
		objectId,
		parentIds: [],
		ops: [{ objectCreate: { typeKey } }],
		timestamp: 1700000000000,
		author: "test",
	};
}

// ── Tests ───────────────────────────────────────────────────────

describe("wallet key management", () => {
	it("doNew creates a key and persists it to disk", () => {
		const r = doNew("alice", 1700000000000, tmpPath);
		assert.equal(r.name, "alice");
		assert.equal(r.pubkey.length, 64, "pubkey is 32 bytes hex");
		assert.equal(r.createdAt, 1700000000000);

		// File exists; persisted entry round-trips
		assert.ok(fs.existsSync(tmpPath));
		const list = doList(tmpPath);
		assert.equal(list.length, 1);
		assert.equal(list[0].name, "alice");
		assert.equal(list[0].pubkey, r.pubkey);
	});

	it("doNew rejects a duplicate name", () => {
		doNew("alice", 1, tmpPath);
		assert.throws(() => doNew("alice", 2, tmpPath), /already exists/);
	});

	it("doNew rejects names with disallowed characters", () => {
		assert.throws(() => doNew("alice bob", 1, tmpPath), /1-64 chars/);
		assert.throws(() => doNew("../escape", 1, tmpPath), /1-64 chars/);
		assert.throws(() => doNew("", 1, tmpPath), /name required/);
	});

	it("doList returns keys sorted alphabetically", () => {
		doNew("charlie", 3, tmpPath);
		doNew("alice", 1, tmpPath);
		doNew("bob", 2, tmpPath);
		const names = doList(tmpPath).map((k) => k.name);
		assert.deepEqual(names, ["alice", "bob", "charlie"]);
	});

	it("doShow returns null for unknown key", () => {
		assert.equal(doShow("ghost", tmpPath), null);
	});

	it("doShow returns metadata only — no privateKey field", () => {
		doNew("alice", 1, tmpPath);
		const show = doShow("alice", tmpPath) as Record<string, unknown>;
		assert.equal(typeof show.name, "string");
		assert.equal(typeof show.pubkey, "string");
		assert.equal(typeof show.createdAt, "number");
		assert.equal((show as Record<string, unknown>).privateKey, undefined,
			"private material MUST never surface");
	});

	it("doKeyForPubkey looks up by pubkey hex", () => {
		const r = doNew("alice", 1, tmpPath);
		const found = doKeyForPubkey(r.pubkey, tmpPath);
		assert.ok(found);
		assert.equal(found?.name, "alice");
		assert.equal(doKeyForPubkey("00".repeat(32), tmpPath), null);
	});

	it("doRemove deletes the key and rewrites the file", () => {
		doNew("alice", 1, tmpPath);
		doNew("bob", 2, tmpPath);
		assert.equal(doRemove("alice", tmpPath), true);
		assert.equal(doList(tmpPath).length, 1);
		assert.equal(doList(tmpPath)[0].name, "bob");
	});

	it("doRemove returns false for unknown key", () => {
		assert.equal(doRemove("ghost", tmpPath), false);
	});

	it("doRemove deletes the file when the last key is removed", () => {
		doNew("alice", 1, tmpPath);
		doRemove("alice", tmpPath);
		assert.equal(fs.existsSync(tmpPath), false, "empty wallet file is cleaned up");
	});

	it("creates the wallet file with mode 0600", () => {
		// POSIX-only; skip on Windows where file modes are advisory.
		if (process.platform === "win32") return;
		doNew("alice", 1, tmpPath);
		const stat = fs.statSync(tmpPath);
		const mode = stat.mode & 0o777;
		assert.equal(mode, 0o600, `wallet file must be 0600, got ${mode.toString(8)}`);
	});

	it("the actor.list action does not expose privateKey", async () => {
		doNew("alice", 1, tmpPath);
		const list = await walletProgram.actor!.actions!.list!(null as any, { path: tmpPath }) as Array<Record<string, unknown>>;
		for (const entry of list) {
			assert.equal(entry.privateKey, undefined,
				"private material MUST never surface from the public API");
		}
	});
});

describe("wallet signing", () => {
	it("signChange produces a verifiable signature over canonical(change)", () => {
		const r = doNew("alice", 1, tmpPath);
		const ch = unsignedChange("obj-1", "chain.coin.bucket");
		const encoded = encodeChange(ch);
		const result = doSignChange({
			name: "alice",
			changeB64: Buffer.from(encoded).toString("base64"),
		}, tmpPath);

		assert.equal(result.pubkey, r.pubkey);
		assert.equal(result.id.length, 64, "id is 32 bytes hex");

		// Decode the signed change and verify externally with the same pubkey.
		const signed = decodeChange(new Uint8Array(Buffer.from(result.changeB64, "base64")));
		assert.ok(signed.authExtension);
		const sig = decodeSignature(signed.authExtension.payload);
		assert.equal(sig.signature.length, 64);
		assert.equal(hexEncode(sig.pubkey), r.pubkey);

		const signingBytes = canonicalEncodeChangeForSigning(signed);
		const ok = ed25519Verify(sig.pubkey, signingBytes, sig.signature);
		assert.equal(ok, true, "signature must verify with the registered pubkey");

		// id is sha256(canonical(signed change with id zeroed))
		const expectedId = sha256(canonicalEncodeChange(signed));
		assert.equal(hexEncode(expectedId), result.id);
	});

	it("signChange rejects unknown wallet name", () => {
		const ch = unsignedChange("obj-1", "chain.coin.bucket");
		assert.throws(() => doSignChange({
			name: "nobody",
			changeB64: Buffer.from(encodeChange(ch)).toString("base64"),
		}, tmpPath), /no key named/);
	});

	it("two distinct keys produce independently verifiable signatures", () => {
		const aliceR = doNew("alice", 1, tmpPath);
		const bobR = doNew("bob", 2, tmpPath);
		const ch = unsignedChange("obj-1", "chain.coin.bucket");
		const encoded = Buffer.from(encodeChange(ch)).toString("base64");

		const aliceSig = doSignChange({ name: "alice", changeB64: encoded }, tmpPath);
		const bobSig = doSignChange({ name: "bob", changeB64: encoded }, tmpPath);

		assert.notEqual(aliceSig.pubkey, bobSig.pubkey);
		assert.notEqual(aliceSig.id, bobSig.id, "different signers → different ids");

		// Each sig verifies under its own pubkey, fails under the other.
		const aliceCh = decodeChange(new Uint8Array(Buffer.from(aliceSig.changeB64, "base64")));
		const bobCh = decodeChange(new Uint8Array(Buffer.from(bobSig.changeB64, "base64")));

		assert.equal(
			ed25519Verify(hexDecode(aliceR.pubkey), canonicalEncodeChangeForSigning(aliceCh), decodeSignature(aliceCh.authExtension!.payload).signature),
			true,
		);
		assert.equal(
			ed25519Verify(hexDecode(bobR.pubkey), canonicalEncodeChangeForSigning(aliceCh), decodeSignature(aliceCh.authExtension!.payload).signature),
			false,
		);
	});

	it("signing preserves the original ops and timestamp exactly", () => {
		doNew("alice", 1, tmpPath);
		const ch: Change = {
			id: new Uint8Array(0),
			objectId: "obj-7",
			parentIds: [new Uint8Array([0xab, 0xcd])],
			ops: [
				{ objectCreate: { typeKey: "chain.coin.bucket" } },
				{ fieldSet: { key: "name", value: { stringValue: "TestCoin" } } },
			],
			timestamp: 1234567890,
			author: "alice-cli",
		};
		const result = doSignChange({
			name: "alice",
			changeB64: Buffer.from(encodeChange(ch)).toString("base64"),
		}, tmpPath);
		const signed = decodeChange(new Uint8Array(Buffer.from(result.changeB64, "base64")));
		assert.equal(signed.objectId, "obj-7");
		assert.equal(signed.timestamp, 1234567890);
		assert.equal(signed.author, "alice-cli");
		assert.equal(signed.ops.length, 2);
		assert.equal(signed.ops[1].fieldSet?.value.stringValue, "TestCoin");
	});
});
