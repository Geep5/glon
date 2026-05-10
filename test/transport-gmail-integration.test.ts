/**
 * transport-gmail integration test — gated behind RUN_EMAIL_TESTS=1.
 *
 * Exercises a real round-trip through Gmail using whatever account the
 * local `gcloud auth login` is bound to. Sends a self-addressed message
 * and verifies inbox_drain picks it up with the correct from_endpoint
 * and payload.
 *
 * Run:
 *   RUN_EMAIL_TESTS=1 npx tsx --test test/transport-gmail-integration.test.ts
 *
 * Optional: GMAIL_TEST_RECIPIENT=other@you.com to send to a different
 * address (must also be reachable from the same gcloud token).
 *
 * The test cleans up after itself by leaving the Glon/Processed label
 * applied — no inbox spam.
 */

import { describe, it, before } from "node:test";
import { strict as assert } from "node:assert";
import { __test } from "../src/programs/handlers/transport-gmail.js";
import {
	stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
	encodeTransportEnvelope,
} from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

const RUN = process.env.RUN_EMAIL_TESTS === "1";

const { doSend, doInboxDrain } = __test;

function makeCtx(state: Record<string, any> = {}): ProgramContext {
	return {
		client: {} as any,
		store: {} as any,
		resolveId: async () => null,
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: (msg: string) => { if (process.env.GMAIL_TEST_VERBOSE) console.log(msg); },
		style: {} as any,
		randomUUID: () => "test-uuid",
		state,
		emit: () => {},
		programId: "test-gmail-int",
		objectActor: () => ({}) as any,
		dispatchProgram: async () => null,
		dispatchTypedAction: async () => null,
	};
}

describe("transport-gmail integration", { skip: !RUN }, () => {
	let recipient: string;
	const sharedState: Record<string, any> = {};
	const probe = `glon-int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

	before(async () => {
		recipient = process.env.GMAIL_TEST_RECIPIENT ?? "";
		if (!recipient) {
			// Default to self-loop: Gmail accepts mail to its own address.
			// We'll resolve self via the same `whoAmI` path doSend uses.
			// First send needs a recipient — use the gcloud profile email.
			const { execFileSync } = await import("node:child_process");
			const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf-8" }).trim();
			const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
				headers: { "Authorization": `Bearer ${token}` },
			});
			const body = await resp.json() as { emailAddress?: string };
			recipient = body.emailAddress ?? "";
			assert.ok(recipient, "could not resolve gcloud profile email; set GMAIL_TEST_RECIPIENT");
		}
	});

	it("send + inbox_drain round-trip", async () => {
		const ctx = makeCtx(sharedState);
		const innerEnvelope = encodeTransportEnvelope({
			contentType: "glon/text",
			payload: new TextEncoder().encode(`probe:${probe}`),
			senderPubkey: new Uint8Array(0),
			metadata: { probe },
		});
		const payloadB64 = Buffer.from(innerEnvelope).toString("base64");

		await doSend(ctx, {
			endpoint: `gmail://${recipient}`,
			payload_b64: payloadB64,
			content_type: "glon/text",
			metadata: { subject: `int-test ${probe}` },
		});

		// Allow the message to settle in the inbox before polling. Gmail
		// is usually fast for self-sends but not instant.
		await new Promise((r) => setTimeout(r, 5_000));

		// inbox_drain has an internal poll-interval gate; force a poll by
		// resetting lastPolledAt.
		sharedState.lastPolledAt = 0;

		// Try a few times in case the message hasn't shown up yet.
		let blobs: any[] = [];
		for (let attempt = 0; attempt < 12; attempt++) {
			sharedState.lastPolledAt = 0;
			blobs = await doInboxDrain(ctx);
			if (blobs.some((b) => b.metadata?.probe === probe || b.metadata?.subject?.includes(probe))) break;
			await new Promise((r) => setTimeout(r, 5_000));
		}
		const ours = blobs.find((b) => b.metadata?.probe === probe || b.metadata?.subject?.includes(probe));
		assert.ok(ours, `did not find probe ${probe} in inbox after polling 12 times`);
		assert.equal(ours.content_type, "glon/text");
		assert.match(ours.from_endpoint, /^gmail:\/\//);
		assert.equal(ours.payload_b64, payloadB64);
	});
});

if (!RUN) {
	// Surface the skip reason so it's obvious why nothing ran.
	console.log("[transport-gmail-integration] skipped — set RUN_EMAIL_TESTS=1 to run");
}
