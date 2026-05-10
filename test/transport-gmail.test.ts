/**
 * transport-gmail tests.
 *
 * Pure helpers (RFC822 build/parse, base64url, header parsing) are tested
 * directly. Send + inbox_drain are exercised with the gcloud token resolver
 * and Gmail fetch both replaced by `globalThis.__GMAIL_TOKEN_FN` /
 * `globalThis.__GMAIL_FETCH` injectors so no network or external CLI is hit.
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import gmailProgram, { __test } from "../src/programs/handlers/transport-gmail.js";
import {
	stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
	encodeTransportEnvelope,
} from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

const {
	buildRfc822, extractEnvelopeFromBody, extractEmailAddress,
	flattenPayloadText, base64UrlEncode, base64UrlDecode,
	doSend, doInboxDrain, ENVELOPE_BEGIN, ENVELOPE_END, SUBJECT_PREFIX,
} = __test;

interface FetchCall { method: string; url: string; headers: Record<string, string>; body?: string; }

function clearMocks() {
	delete (globalThis as any).__GMAIL_FETCH;
	delete (globalThis as any).__GMAIL_TOKEN_FN;
}

function makeCtx(state: Record<string, any> = {}): ProgramContext {
	return {
		client: {},
		store: {} as any,
		resolveId: async () => null,
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		style: {} as any,
		randomUUID: () => "uuid",
		state,
		emit: () => {},
		programId: "test-gmail",
		objectActor: () => ({}) as any,
		dispatchProgram: async () => null,
		dispatchTypedAction: async () => null,
	};
}

afterEach(clearMocks);

describe("base64url", () => {
	it("round-trips arbitrary bytes", () => {
		const inputs = [
			Buffer.from(""),
			Buffer.from("a"),
			Buffer.from("ab"),
			Buffer.from("hello"),
			Buffer.from([0, 1, 2, 3, 4, 5, 0xff, 0xfe]),
		];
		for (const inp of inputs) {
			const enc = base64UrlEncode(inp);
			assert.equal(/^[A-Za-z0-9_-]*$/.test(enc), true, `not base64url-clean: ${enc}`);
			const dec = base64UrlDecode(enc);
			assert.deepEqual(Buffer.from(dec), inp);
		}
	});

	it("strips padding", () => {
		assert.equal(base64UrlEncode(Buffer.from("a")).endsWith("="), false);
	});
});

describe("buildRfc822 + extractEnvelopeFromBody", () => {
	it("round-trips an envelope payload", () => {
		const payloadB64 = Buffer.from("hello-glon").toString("base64");
		const rfc = buildRfc822({
			from: "alice@example.com",
			to: "bob@example.com",
			subject: `${SUBJECT_PREFIX} swap-offer abc12345`,
			preamble: "this is a glon message",
			payloadB64,
		});
		assert.match(rfc, /From: alice@example.com/);
		assert.match(rfc, /To: bob@example.com/);
		assert.match(rfc, new RegExp(`Subject: \\${SUBJECT_PREFIX.replace(/\[\]/g, "")}.*swap-offer abc12345`));
		const extracted = extractEnvelopeFromBody(rfc);
		assert.equal(extracted, payloadB64);
	});

	it("handles wrapped lines inside markers", () => {
		const long = "x".repeat(500);
		const payloadB64 = Buffer.from(long).toString("base64");
		const rfc = buildRfc822({
			from: "a@b.c",
			to: "x@y.z",
			subject: "[GLON] message",
			preamble: "hi",
			payloadB64,
		});
		const extracted = extractEnvelopeFromBody(rfc);
		assert.equal(extracted, payloadB64);
	});

	it("returns null when markers are missing", () => {
		assert.equal(extractEnvelopeFromBody("hello world"), null);
		assert.equal(extractEnvelopeFromBody(`${ENVELOPE_BEGIN} but no end`), null);
		assert.equal(extractEnvelopeFromBody(`only end ${ENVELOPE_END}`), null);
	});
});

describe("extractEmailAddress", () => {
	it("extracts bracketed email", () => {
		assert.equal(extractEmailAddress("Alice Smith <alice@example.com>"), "alice@example.com");
	});
	it("returns bare email lowercased", () => {
		assert.equal(extractEmailAddress("BOB@EXAMPLE.COM"), "bob@example.com");
	});
	it("handles empty/missing", () => {
		assert.equal(extractEmailAddress(""), "");
	});
});

describe("flattenPayloadText", () => {
	it("decodes a single text/plain part", () => {
		const data = base64UrlEncode(Buffer.from("hello"));
		const text = flattenPayloadText({ body: { data } });
		assert.equal(text, "hello");
	});
	it("walks multipart trees", () => {
		const a = base64UrlEncode(Buffer.from("aaa"));
		const b = base64UrlEncode(Buffer.from("bbb"));
		const text = flattenPayloadText({
			parts: [
				{ body: { data: a } },
				{ parts: [{ body: { data: b } }] },
			],
		});
		assert.match(text, /aaa/);
		assert.match(text, /bbb/);
	});
});

describe("doSend", () => {
	it("constructs the right Gmail send call", async () => {
		const calls: FetchCall[] = [];
		(globalThis as any).__GMAIL_TOKEN_FN = async () => "tok-123";
		(globalThis as any).__GMAIL_FETCH = async (req: FetchCall) => {
			calls.push(req);
			if (req.url.endsWith("/users/me/profile")) {
				return { ok: true, status: 200, json: async () => ({ emailAddress: "me@example.com" }), text: async () => "" };
			}
			if (req.url.endsWith("/users/me/messages/send")) {
				return { ok: true, status: 200, json: async () => ({ id: "sent-1" }), text: async () => "" };
			}
			return { ok: false, status: 404, json: async () => null, text: async () => "" };
		};

		const ctx = makeCtx({});
		const r = await doSend(ctx, {
			endpoint: "gmail://bob@example.com",
			payload_b64: Buffer.from("hi").toString("base64"),
			content_type: "glon/text",
			metadata: { subject: "test 123" },
		});

		assert.equal(r.delivery_id, "sent-1");
		assert.equal(calls.length, 2);
		assert.match(calls[0].url, /\/users\/me\/profile$/);
		assert.match(calls[1].url, /\/users\/me\/messages\/send$/);
		assert.equal(calls[1].headers["Authorization"], "Bearer tok-123");

		const sentBody = JSON.parse(calls[1].body!);
		const decoded = base64UrlDecode(sentBody.raw).toString("utf-8");
		assert.match(decoded, /From: me@example\.com/);
		assert.match(decoded, /To: bob@example\.com/);
		assert.match(decoded, /Subject: \[GLON\] test 123/);
		const inner = extractEnvelopeFromBody(decoded);
		assert.equal(inner, Buffer.from("hi").toString("base64"));
	});

	it("rejects malformed endpoint", async () => {
		(globalThis as any).__GMAIL_TOKEN_FN = async () => "tok";
		const ctx = makeCtx({});
		await assert.rejects(
			doSend(ctx, { endpoint: "discord://x", payload_b64: "QQ==", content_type: "x" }),
			/invalid endpoint/,
		);
	});

	it("surfaces gcloud auth failures with a setup hint", async () => {
		(globalThis as any).__GMAIL_TOKEN_FN = async () => { throw new Error("boom"); };
		const ctx = makeCtx({});
		await assert.rejects(
			doSend(ctx, { endpoint: "gmail://x@y.z", payload_b64: "QQ==", content_type: "x" }),
			/boom/,
		);
	});
});

describe("doInboxDrain", () => {
	it("respects the internal poll interval", async () => {
		(globalThis as any).__GMAIL_TOKEN_FN = async () => "tok";
		const ctx = makeCtx({ lastPolledAt: Date.now() }); // just polled
		const blobs = await doInboxDrain(ctx);
		assert.deepEqual(blobs, []);
	});

	it("returns empty when the inbox has no Glon messages", async () => {
		(globalThis as any).__GMAIL_TOKEN_FN = async () => "tok";
		(globalThis as any).__GMAIL_FETCH = async (req: FetchCall) => {
			if (req.url.includes("/messages?")) return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
			return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
		};
		const ctx = makeCtx({});
		const blobs = await doInboxDrain(ctx);
		assert.deepEqual(blobs, []);
		assert.equal(ctx.state.consecutiveErrors, 0);
	});

	it("parses a Glon message and marks it processed", async () => {
		// Construct an outbound RFC822 with a real envelope inside.
		const envelopeBytes = encodeTransportEnvelope({
			contentType: "glon/text",
			payload: new TextEncoder().encode("hello"),
			senderPubkey: new Uint8Array(0),
			metadata: { foo: "bar" },
		});
		const envelopeB64 = Buffer.from(envelopeBytes).toString("base64");
		const rfc = buildRfc822({
			from: "alice@example.com",
			to: "me@example.com",
			subject: `${SUBJECT_PREFIX} test-subject`,
			preamble: "preamble",
			payloadB64: envelopeB64,
		});
		const bodyData = base64UrlEncode(Buffer.from(rfc, "utf-8"));

		const calls: FetchCall[] = [];
		(globalThis as any).__GMAIL_TOKEN_FN = async () => "tok";
		(globalThis as any).__GMAIL_FETCH = async (req: FetchCall): Promise<any> => {
			calls.push(req);
			if (req.url.includes("/messages?")) {
				return { ok: true, status: 200, json: async () => ({ messages: [{ id: "msg-1" }] }), text: async () => "" };
			}
			if (req.url.endsWith("/labels")) {
				return { ok: true, status: 200, json: async () => ({ labels: [{ id: "lbl-existing", name: "Glon/Processed" }] }), text: async () => "" };
			}
			if (req.url.includes("/messages/msg-1?") || req.url.endsWith("/messages/msg-1")) {
				return {
					ok: true, status: 200,
					json: async () => ({
						id: "msg-1",
						payload: {
							headers: [
								{ name: "Subject", value: `${SUBJECT_PREFIX} test-subject` },
								{ name: "From", value: "Alice <alice@example.com>" },
							],
							body: { data: bodyData },
						},
					}),
					text: async () => "",
				};
			}
			if (req.url.includes("/messages/msg-1/modify")) {
				return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
			}
			return { ok: false, status: 404, json: async () => null, text: async () => "" };
		};

		const ctx = makeCtx({});
		const blobs = await doInboxDrain(ctx);
		assert.equal(blobs.length, 1);
		assert.equal(blobs[0].from_endpoint, "gmail://alice@example.com");
		assert.equal(blobs[0].content_type, "glon/text");
		assert.equal(blobs[0].metadata.foo, "bar");
		assert.equal(blobs[0].metadata.subject, "test-subject");
		assert.equal(blobs[0].metadata.gmail_id, "msg-1");
		assert.equal(blobs[0].payload_b64, envelopeB64);

		const modifyCall = calls.find((c) => c.url.includes("/modify"));
		assert.ok(modifyCall, "should have called modify to mark processed");
		const body = JSON.parse(modifyCall!.body!);
		assert.deepEqual(body.removeLabelIds, ["UNREAD"]);
		assert.ok(body.addLabelIds.includes("lbl-existing"));
	});

	it("backs off on auth errors", async () => {
		(globalThis as any).__GMAIL_TOKEN_FN = async () => { throw new Error("auth dead"); };
		const ctx = makeCtx({});
		const blobs = await doInboxDrain(ctx);
		assert.deepEqual(blobs, []);
		assert.ok(ctx.state.backoffUntil > Date.now());
		assert.equal(ctx.state.consecutiveErrors, 1);
	});
});

describe("program shape", () => {
	it("registers send + inbox_drain typed actions", () => {
		const t = (gmailProgram.actor!.typedActions ?? {}) as any;
		assert.ok(t.send);
		assert.ok(t.inbox_drain);
		assert.ok(t.ping);
	});
});
