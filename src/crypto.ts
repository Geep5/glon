/**
 * Content-addressing for the change DAG.
 *
 * Every Change is identified by the SHA-256 hash of its protobuf
 * encoding with the id field zeroed. Same mutation → same hash.
 * Tamper-evident: any byte change produces a different hash.
 */

import { createHash, randomUUID } from "node:crypto";

export function sha256(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(data).digest());
}

export function hexEncode(hash: Uint8Array): string {
	return Buffer.from(hash).toString("hex");
}

export function hexDecode(hex: string): Uint8Array {
	return new Uint8Array(Buffer.from(hex, "hex"));
}

export function generateObjectId(): string {
	return randomUUID();
}
