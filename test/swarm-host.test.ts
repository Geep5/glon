/**
 * swarm-host tests.
 *
 * Focus on the pure pieces — frame protocol, topic derivation. The
 * connection / swarm-event machinery requires a live Hyperswarm and is
 * covered by Phase 0's spike script, not these unit tests.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { __test, topicFor, pairTopic } from "../src/swarm-host.js";

const { makeFrameReader, writeFrame } = __test;

// Mock connection that records every chunk it would have sent over the wire.
function recorder() {
	const written: Buffer[] = [];
	const conn = {
		destroyed: false,
		write(data: Buffer) { written.push(Buffer.from(data)); return true; },
		on() { return this; },
		once() { return this; },
		destroy() { (this as any).destroyed = true; },
	};
	return { conn: conn as any, written };
}

describe("topic derivation", () => {
	it("topicFor is deterministic and 32 bytes", () => {
		const a = topicFor("glon:test");
		const b = topicFor("glon:test");
		assert.equal(a.length, 32);
		assert.equal(a.toString("hex"), b.toString("hex"));
	});

	it("pairTopic is order-independent", () => {
		const t1 = pairTopic("aaaa", "bbbb");
		const t2 = pairTopic("bbbb", "aaaa");
		assert.equal(t1.toString("hex"), t2.toString("hex"));
	});

	it("pairTopic differs across inputs", () => {
		const t1 = pairTopic("aaaa", "bbbb");
		const t2 = pairTopic("aaaa", "cccc");
		assert.notEqual(t1.toString("hex"), t2.toString("hex"));
	});
});

describe("frame protocol", () => {
	it("writeFrame produces 4-byte BE length + payload", () => {
		const { conn, written } = recorder();
		writeFrame(conn, Buffer.from("hello"));
		assert.equal(written.length, 1);
		const out = written[0];
		assert.equal(out.length, 4 + 5);
		assert.equal(out.readUInt32BE(0), 5);
		assert.equal(out.subarray(4).toString(), "hello");
	});

	it("reader assembles a single frame from one chunk", () => {
		const got: Uint8Array[] = [];
		const read = makeFrameReader((frame) => got.push(frame));
		const payload = Buffer.from("abcdefg");
		const header = Buffer.allocUnsafe(4); header.writeUInt32BE(payload.length, 0);
		read(Buffer.concat([header, payload]));
		assert.equal(got.length, 1);
		assert.equal(Buffer.from(got[0]).toString(), "abcdefg");
	});

	it("reader assembles a frame split across chunks", () => {
		const got: Uint8Array[] = [];
		const read = makeFrameReader((f) => got.push(f));
		const payload = Buffer.from("split-frame");
		const header = Buffer.allocUnsafe(4); header.writeUInt32BE(payload.length, 0);
		const full = Buffer.concat([header, payload]);
		// 1-byte chunks: ensure boundary handling is robust.
		for (const byte of full) read(Buffer.from([byte]));
		assert.equal(got.length, 1);
		assert.equal(Buffer.from(got[0]).toString(), "split-frame");
	});

	it("reader handles multiple frames in one chunk", () => {
		const got: Uint8Array[] = [];
		const read = makeFrameReader((f) => got.push(f));
		const a = Buffer.from("one"); const b = Buffer.from("two-frames");
		const ha = Buffer.allocUnsafe(4); ha.writeUInt32BE(a.length, 0);
		const hb = Buffer.allocUnsafe(4); hb.writeUInt32BE(b.length, 0);
		read(Buffer.concat([ha, a, hb, b]));
		assert.equal(got.length, 2);
		assert.equal(Buffer.from(got[0]).toString(), "one");
		assert.equal(Buffer.from(got[1]).toString(), "two-frames");
	});

	it("reader survives an oversized header by resetting", () => {
		const got: Uint8Array[] = [];
		const read = makeFrameReader((f) => got.push(f));
		const bogus = Buffer.alloc(4);
		bogus.writeUInt32BE(64 * 1024 * 1024, 0); // > MAX_FRAME_BYTES (16MB)
		read(bogus);
		// Then a valid frame should still work since we reset.
		const payload = Buffer.from("after-reset");
		const hdr = Buffer.allocUnsafe(4); hdr.writeUInt32BE(payload.length, 0);
		read(Buffer.concat([hdr, payload]));
		assert.equal(got.length, 1);
		assert.equal(Buffer.from(got[0]).toString(), "after-reset");
	});

	it("round-trips a binary payload (envelopes can contain anything)", () => {
		const got: Uint8Array[] = [];
		const read = makeFrameReader((f) => got.push(f));
		const { conn, written } = recorder();
		const random = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) & 0xff));
		writeFrame(conn, random);
		read(written[0]);
		assert.equal(got.length, 1);
		assert.deepEqual(Buffer.from(got[0]), random);
	});
});
