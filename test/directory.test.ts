/**
 * /directory tests.
 *
 * Focus on the state machine: announce upserts, dedupe of incoming
 * requests, accept/decline state transitions, TTL pruning. Heavy
 * dispatch interactions (to /peer, /wallet, /agent, /transport-hyperswarm)
 * are mocked via a harness ctx.
 *
 * The swarm-host module is dynamically imported by /directory; we don't
 * stub it, but the relevant code paths gate on `isReady()` and we don't
 * call doTick() in tests that would require the swarm.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import directoryProgram, { __test } from "../src/programs/handlers/directory.js";
import {
	stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
} from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

const { handleAnnounce, handlePeerRequest, acceptRequest, declineRequest, requestPeering } = __test;

interface DispatchCall { prefix: string; action: string; args: unknown[]; }

function makeHarness(opts: { walletPubkey?: string; mockDiscovered?: Record<string, any> } = {}) {
	const dispatchCalls: DispatchCall[] = [];
	const notifyCalls: string[] = [];
	const peerSetFieldCalls: Array<{ id: string; key: string; value: string }> = [];
	const transportSendCalls: Array<{ endpoint: string; content_type: string; payload_b64: string }> = [];

	const dispatch = async (prefix: string, action: string, args: unknown[]) => {
		dispatchCalls.push({ prefix, action, args });
		if (prefix === "/wallet" && action === "show") return { pubkey: opts.walletPubkey ?? "self-identity-pubkey-hex" };
		if (prefix === "/agent" && action === "list") return [{ name: "test-agent" }];
		if (prefix === "/user-chat" && action === "notify") {
			notifyCalls.push((args[0] as { text?: string })?.text ?? "");
			return { delivered: ["test"] };
		}
		if (prefix === "/peer" && action === "add") return { id: "peer-obj-" + Math.random().toString(36).slice(2, 8) };
		if (prefix === "/peer" && action === "setField") {
			peerSetFieldCalls.push({ id: args[0] as string, key: args[1] as string, value: args[2] as string });
			return { ok: true };
		}
		if (prefix === "/peer" && action === "setTrust") return { ok: true };
		if (prefix === "/transport-hyperswarm" && action === "send") {
			transportSendCalls.push(args[0] as any);
			return { delivery_id: "send-" + Date.now() };
		}
		if (prefix === "/transport-hyperswarm" && action === "broadcast") return { sent: 1, skipped: 0 };
		if (prefix === "/transport-hyperswarm" && action === "joinTopic") return { ok: true };
		throw new Error(`unmocked dispatch: ${prefix} ${action}`);
	};

	const ctx: ProgramContext = {
		client: {} as any,
		store: { get: async () => null, list: async () => [] } as any,
		resolveId: async (s: string) => s,
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		style: {} as any,
		randomUUID: () => "abcdefab-1234-5678-9abc-def012345678",
		state: { discovered: opts.mockDiscovered ?? {}, requests: {} },
		emit: () => {},
		programId: "test-directory",
		objectActor: () => ({ setField: async () => {} }) as any,
		dispatchProgram: dispatch,
		dispatchTypedAction: async (prefix, action, input) => dispatch(prefix, action, [input]),
	};

	return { ctx, dispatchCalls, notifyCalls, peerSetFieldCalls, transportSendCalls };
}

describe("handleAnnounce", () => {
	it("upserts a new discovered peer and stores it locally", async () => {
		const h = makeHarness();
		const body = {
			identity_pubkey: "alice-id-hex",
			hyperswarm_pubkey: "alice-hs-hex",
			agent_name: "Alice",
			capabilities: ["trade"],
			announced_at: Date.now(),
		};
		const envelope = {
			contentType: "glon/peer-announce",
			payload: new TextEncoder().encode(JSON.stringify(body)),
			senderPubkey: new Uint8Array(0),
			metadata: {},
		};
		const ok = await handleAnnounce(h.ctx, envelope, {});
		assert.equal(ok, true);
		const stored = h.ctx.state.discovered["alice-id-hex"];
		assert.ok(stored);
		assert.equal(stored.agent_name, "Alice");
		assert.ok(h.dispatchCalls.some((c) => c.prefix === "/peer" && c.action === "add"));
	});

	it("rejects an announce missing hyperswarm_pubkey", async () => {
		const h = makeHarness();
		const envelope = {
			contentType: "glon/peer-announce",
			payload: new TextEncoder().encode(JSON.stringify({ identity_pubkey: "x" })),
			senderPubkey: new Uint8Array(0),
			metadata: {},
		};
		const ok = await handleAnnounce(h.ctx, envelope, {});
		assert.equal(ok, false);
	});
});

describe("handlePeerRequest", () => {
	it("creates a pending incoming request + surfaces to user-chat", async () => {
		const h = makeHarness();
		const body = {
			request_id: "req-001",
			identity_pubkey: "bob-id",
			hyperswarm_pubkey: "bob-hs",
			agent_name: "Bob",
			message: "trade buddy?",
		};
		const envelope = {
			contentType: "glon/peer-request",
			payload: new TextEncoder().encode(JSON.stringify(body)),
			senderPubkey: new Uint8Array(0),
			metadata: {},
		};
		const ok = await handlePeerRequest(h.ctx, envelope, { fromEndpoint: "swarm://bob-hs" });
		assert.equal(ok, true);
		assert.ok(h.ctx.state.requests["req-001"]);
		assert.equal(h.ctx.state.requests["req-001"].status, "waiting");
		assert.equal(h.ctx.state.requests["req-001"].direction, "incoming");
		assert.ok(h.notifyCalls.some((m) => m.includes("Bob")));
	});

	it("rejects when fromEndpoint hyperswarm pubkey doesn't match the claim", async () => {
		const h = makeHarness();
		const body = {
			request_id: "req-002",
			identity_pubkey: "real-bob",
			hyperswarm_pubkey: "claimed-bob-hs",
			agent_name: "Bob",
		};
		const envelope = {
			contentType: "glon/peer-request",
			payload: new TextEncoder().encode(JSON.stringify(body)),
			senderPubkey: new Uint8Array(0),
			metadata: {},
		};
		const ok = await handlePeerRequest(h.ctx, envelope, { fromEndpoint: "swarm://attacker-hs" });
		assert.equal(ok, false);
		assert.equal(h.ctx.state.requests["req-002"], undefined);
	});

	it("dedupes a duplicate request_id", async () => {
		const h = makeHarness();
		const body = { request_id: "req-dup", identity_pubkey: "b-id", hyperswarm_pubkey: "b-hs", agent_name: "B" };
		const envelope = {
			contentType: "glon/peer-request",
			payload: new TextEncoder().encode(JSON.stringify(body)),
			senderPubkey: new Uint8Array(0),
			metadata: {},
		};
		await handlePeerRequest(h.ctx, envelope, { fromEndpoint: "swarm://b-hs" });
		const before = h.notifyCalls.length;
		const ok2 = await handlePeerRequest(h.ctx, envelope, { fromEndpoint: "swarm://b-hs" });
		assert.equal(ok2, true);
		assert.equal(h.notifyCalls.length, before, "duplicate request should not re-notify");
	});
});

describe("acceptRequest / declineRequest", () => {
	it("acceptRequest flips state and sends a peer-accept", async () => {
		const h = makeHarness();
		h.ctx.state.requests["req-1"] = {
			request_id: "req-1",
			direction: "incoming",
			peer_identity_pubkey: "alice-id",
			peer_hyperswarm_pubkey: "alice-hs",
			peer_agent_name: "Alice",
			created_at: Date.now(),
			approval_deadline: Date.now() + 600_000,
			status: "waiting",
		};
		const r = await acceptRequest(h.ctx, "req-1");
		assert.deepEqual(r, { ok: true });
		assert.equal(h.ctx.state.requests["req-1"].status, "accepted");
		const sent = h.transportSendCalls.find((c) => c.content_type === "glon/peer-accept");
		assert.ok(sent);
		assert.equal(sent!.endpoint, "swarm://alice-hs");
	});

	it("declineRequest emits a peer-decline + transitions state", async () => {
		const h = makeHarness();
		h.ctx.state.requests["req-2"] = {
			request_id: "req-2", direction: "incoming",
			peer_identity_pubkey: "alice-id", peer_hyperswarm_pubkey: "alice-hs",
			peer_agent_name: "Alice", created_at: Date.now(), approval_deadline: Date.now() + 60_000,
			status: "waiting",
		};
		await declineRequest(h.ctx, "req-2", "approval_timeout");
		assert.equal(h.ctx.state.requests["req-2"].status, "declined");
		assert.equal(h.ctx.state.requests["req-2"].decline_reason, "approval_timeout");
		const sent = h.transportSendCalls.find((c) => c.content_type === "glon/peer-decline");
		assert.ok(sent);
	});

	it("acceptRequest rejects outgoing requests", async () => {
		const h = makeHarness();
		h.ctx.state.requests["out-1"] = {
			request_id: "out-1", direction: "outgoing",
			peer_identity_pubkey: "x", peer_hyperswarm_pubkey: "x",
			peer_agent_name: "X", created_at: Date.now(), approval_deadline: Date.now() + 60_000,
			status: "waiting",
		};
		await assert.rejects(acceptRequest(h.ctx, "out-1"), /not an incoming/);
	});
});

describe("requestPeering", () => {
	it("requires the target to be in discovered map", async () => {
		const h = makeHarness();
		await assert.rejects(requestPeering(h.ctx, { identity_pubkey: "stranger" }), /no discovered peer/);
	});

	it("emits an outgoing peer-request when target is discovered", async () => {
		const h = makeHarness({ mockDiscovered: { "alice-id": { identity_pubkey: "alice-id", hyperswarm_pubkey: "alice-hs", agent_name: "Alice", capabilities: [], first_seen: Date.now(), last_seen: Date.now() } } });
		const r = await requestPeering(h.ctx, { identity_pubkey: "alice-id", message: "hello" });
		assert.ok(r.request_id);
		const sent = h.transportSendCalls.find((c) => c.content_type === "glon/peer-request");
		assert.ok(sent);
		assert.equal(sent!.endpoint, "swarm://alice-hs");
		assert.ok(h.ctx.state.requests[r.request_id]);
		assert.equal(h.ctx.state.requests[r.request_id].direction, "outgoing");
	});
});

describe("program shape", () => {
	it("registers expected typed actions", () => {
		const t = (directoryProgram.actor!.typedActions ?? {}) as Record<string, unknown>;
		for (const name of ["announce", "listDiscovered", "listRequests", "requestPeering", "acceptRequest", "declineRequest", "status", "tick"]) {
			assert.ok(t[name], `missing action: ${name}`);
		}
	});
});
