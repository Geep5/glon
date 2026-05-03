/**
 * Ed25519 signing and verification with raw 32-byte keys.
 *
 * Node's `crypto` module supports Ed25519 but requires keys in SPKI/PKCS8
 * DER form, not the raw 32-byte representation that signs/encodes naturally
 * on the wire. This module bridges the two: every public function takes
 * raw bytes; the SPKI/PKCS8 wrapping happens internally.
 *
 * Why not @noble/ed25519 or tweetnacl? Node's built-in is FIPS-routable,
 * has native-speed verify, and ships with the runtime (no new dep). For
 * a chain stack the dependency surface matters — every package between
 * us and the signature math is one we're trusting with the safety
 * assumption.
 */

import {
	createPublicKey,
	createPrivateKey,
	generateKeyPairSync,
	sign as cryptoSign,
	verify as cryptoVerify,
} from "node:crypto";

// ── SPKI/PKCS8 wrappers for raw Ed25519 keys ─────────────────────

/** SPKI prefix for a 32-byte Ed25519 public key. RFC 8410 fixed. */
const SPKI_PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** PKCS8 prefix for a 32-byte Ed25519 private key. RFC 8410 fixed. */
const PKCS8_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function rawPublicToSpki(raw: Uint8Array): Buffer {
	if (raw.length !== 32) throw new Error(`ed25519: public key must be 32 bytes, got ${raw.length}`);
	return Buffer.concat([SPKI_PUBLIC_PREFIX, Buffer.from(raw)]);
}

function rawPrivateToPkcs8(raw: Uint8Array): Buffer {
	if (raw.length !== 32) throw new Error(`ed25519: private key seed must be 32 bytes, got ${raw.length}`);
	return Buffer.concat([PKCS8_PRIVATE_PREFIX, Buffer.from(raw)]);
}

// ── Public API ───────────────────────────────────────────────────

export interface KeyPair {
	/** 32-byte raw Ed25519 public key. */
	publicKey: Uint8Array;
	/** 32-byte raw Ed25519 private key seed. */
	privateKey: Uint8Array;
}

/**
 * Generate a fresh Ed25519 keypair. Backed by `crypto.generateKeyPairSync`,
 * which uses the OS's CSPRNG.
 */
export function generateKeyPair(): KeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const spki = publicKey.export({ format: "der", type: "spki" });
	const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
	// Last 32 bytes of SPKI are the raw key; last 32 of PKCS8 are the raw seed.
	return {
		publicKey: new Uint8Array(spki.slice(spki.byteLength - 32)),
		privateKey: new Uint8Array(pkcs8.slice(pkcs8.byteLength - 32)),
	};
}

/**
 * Sign `message` with a raw 32-byte Ed25519 private key. Returns a 64-byte
 * signature.
 */
export function sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
	const key = createPrivateKey({
		key: rawPrivateToPkcs8(privateKey),
		format: "der",
		type: "pkcs8",
	});
	const sig = cryptoSign(null, Buffer.from(message), key);
	return new Uint8Array(sig);
}

/**
 * Verify a 64-byte signature against `message` using a raw 32-byte Ed25519
 * public key. Returns `true` on valid, `false` on any failure (wrong key,
 * tampered message, malformed signature).
 *
 * Never throws on bad signature data — all failures collapse to `false` so
 * the caller can branch cleanly.
 */
export function verify(
	publicKey: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array,
): boolean {
	try {
		if (publicKey.length !== 32) return false;
		if (signature.length !== 64) return false;
		const key = createPublicKey({
			key: rawPublicToSpki(publicKey),
			format: "der",
			type: "spki",
		});
		return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signature));
	} catch {
		return false;
	}
}
