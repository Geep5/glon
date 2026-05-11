/**
 * transport-hyperswarm unit tests.
 *
 * The swarm-host module is dynamically imported inside the program, so we
 * can't trivially swap it. Instead these tests exercise the pure helpers
 * (endpoint parser, topic parser, envelope builder) and verify the
 * program-def shape. End-to-end behaviour is covered by the Phase 0
 * spike + a live integration test (Phase 1 acceptance).
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import transportHyperswarm, { __test } from "../src/programs/handlers/transport-hyperswarm.js";
import { decodeTransportEnvelope } from "../src/proto.js";

const { parseEndpoint, parseTopicHex, buildEnvelope } = __test;

describe("transport-hyperswarm helpers", () => {
	it("parseEndpoint extracts hex pubkey", () => {
		const pk = "a".repeat(64);
		assert.equal(parseEndpoint(`swarm://${pk}`), pk);
	});

	it("parseEndpoint rejects wrong prefix", () => {
		assert.throws(() => parseEndpoint(`gmail://a@b.c`), /invalid endpoint/);
	});

	it("parseEndpoint rejects wrong length", () => {
		assert.throws(() => parseEndpoint(`swarm://abc`), /invalid endpoint/);
	});

	it("parseEndpoint lowercases mixed-case hex", () => {
		const pk = "AbCdEf".padEnd(64, "0");
		assert.equal(parseEndpoint(`swarm://${pk}`), pk.toLowerCase());
	});

	it("parseTopicHex returns a 32-byte buffer", () => {
		const t = parseTopicHex("c".repeat(64));
		assert.equal(t.length, 32);
		assert.equal(t.toString("hex"), "c".repeat(64));
	});

	it("parseTopicHex rejects non-64-char input", () => {
		assert.throws(() => parseTopicHex("c".repeat(63)), /invalid topic/);
	});
});

describe("transport-hyperswarm envelope build", () => {
	it("buildEnvelope produces a decodable TransportEnvelope", () => {
		const innerPayload = Buffer.from("inner-bundle-bytes").toString("base64");
		const frame = buildEnvelope("glon/test", innerPayload, { swap_id: "abc" });
		const env = decodeTransportEnvelope(new Uint8Array(frame));
		assert.equal(env.contentType, "glon/test");
		assert.equal(env.metadata.swap_id, "abc");
		assert.equal(Buffer.from(env.payload).toString("base64"), innerPayload);
	});

	it("buildEnvelope handles missing metadata", () => {
		const frame = buildEnvelope("glon/test", Buffer.from("x").toString("base64"));
		const env = decodeTransportEnvelope(new Uint8Array(frame));
		assert.deepEqual(env.metadata, {});
	});
});

describe("transport-hyperswarm program shape", () => {
	it("declares the expected typed actions", () => {
		const t = (transportHyperswarm.actor!.typedActions ?? {}) as Record<string, unknown>;
		assert.ok(t.send);
		assert.ok(t.broadcast);
		assert.ok(t.joinTopic);
		assert.ok(t.leaveTopic);
		assert.ok(t.inbox_drain);
		assert.ok(t.status);
	});
});
