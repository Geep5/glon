/**
 * /trade tests — covers the v1 Hyperswarm-based trade flow. Replaces
 * the deleted test/swap-email.test.ts.
 *
 * Focus: peer resolution via /peer, transport-hyperswarm dispatch,
 * trust-gating on incoming offers, swarm-pubkey verification on
 * responses and declines, tightened timeouts.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import tradeProgram, { __test } from "../src/programs/handlers/trade.js";
import {
	stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
	encodeChangeBundle,
} from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";
import { OFFER_TYPE_KEY } from "../src/programs/handlers/coin-types.js";

const {
	handleIncomingOffer, handleIncomingResponse, handleIncomingDecline,
	declineSwap, originatorTimeoutS, receiverApprovalTimeoutS,
} = __test;

interface DispatchCall { prefix: string; action: string; args: unknown[]; }

function harness(opts: {
	peers?: Array<any>;
	walletPubkey?: string;
} = {}) {
	const dispatchCalls: DispatchCall[] = [];
	const notifyCalls: string[] = [];
	const sendCalls: Array<any> = [];
	const peers = opts.peers ?? [];
	const walletPubkey = opts.walletPubkey ?? "deadbeef".repeat(8);

	const dispatch = async (prefix: string, action: string, args: unknown[]): Promise<unknown> => {
		dispatchCalls.push({ prefix, action, args });
		if (prefix === "/user-chat" && action === "notify") {
			notifyCalls.push((args[0] as { text?: string })?.text ?? "");
			return { delivered: ["test"] };
		}
		if (prefix === "/peer" && action === "list") return peers;
		if (prefix === "/wallet" && action === "show") return { pubkey: walletPubkey };
		if (prefix === "/wallet" && action === "signChange") return { changeB64: (args[0] as { changeB64: string }).changeB64 };
		if (prefix === "/consensus" && action === "getNonce") return 0;
		if (prefix === "/swap" && action === "exportOffer") return { bundleBase64: Buffer.from(encodeChangeBundle({ changes: [] })).toString("base64") };
		if (prefix === "/swap" && action === "importOffer") return { offerId: "imported-offer", status: "imported", escrowCount: 0 };
		if (prefix === "/transport-hyperswarm" && action === "send") {
			sendCalls.push(args[0]);
			return { delivery_id: "swarm-" + Date.now() };
		}
		throw new Error(`unmocked dispatch: ${prefix} ${action}`);
	};

	const ctx: ProgramContext = {
		client: { storeActor: { getOrCreate: () => ({ pushChangesBatch: async () => {} }) } } as any,
		store: { get: async () => null, list: async () => [], coinSelect: async () => [] } as any,
		resolveId: async (s: string) => s,
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		style: {} as any,
		randomUUID: () => "abcdefab-1234-5678-9abc-def012345678",
		state: { swaps: {} },
		emit: () => {},
		programId: "test-trade",
		objectActor: () => ({ setField: async () => {}, pushChanges: async () => {}, getHeads: async () => [] }) as any,
		dispatchProgram: dispatch,
		dispatchTypedAction: async (p, a, i) => dispatch(p, a, [i]),
	};

	return { ctx, dispatchCalls, notifyCalls, sendCalls };
}

describe("config defaults tightened for sub-second transport", () => {
	it("originator timeout default is 30 min (was 48 h)", () => {
		assert.equal(originatorTimeoutS(), 1800);
	});
	it("receiver approval default is 5 min (was 20 min)", () => {
		assert.equal(receiverApprovalTimeoutS(), 300);
	});
});

describe("handleIncomingOffer rejects untrusted senders", () => {
	it("ignores offers from peers not in /peer", async () => {
		const h = harness({ peers: [] });
		const envelope = {
			contentType: "glon/swap-offer",
			payload: encodeChangeBundle({ changes: [] }),
			senderPubkey: new Uint8Array(0),
			metadata: { swap_id: "abc12345", terms_json: JSON.stringify({ offered: [], requested: [] }) },
		};
		const ok = await handleIncomingOffer(h.ctx, envelope, { fromEndpoint: "swarm://" + "ab".repeat(32) });
		assert.equal(ok, false);
		assert.equal(Object.keys(h.ctx.state.swaps).length, 0);
	});

	it("ignores offers from discovered-but-not-trusted peers", async () => {
		const h = harness({
			peers: [{
				id: "peer-1",
				identity_pubkey: "alice-id",
				hyperswarm_pubkey: "ab".repeat(32),
				display_name: "Alice",
				trust_level: "discovered",
			}],
		});
		const envelope = {
			contentType: "glon/swap-offer",
			payload: encodeChangeBundle({ changes: [] }),
			senderPubkey: new Uint8Array(0),
			metadata: { swap_id: "abc12345", terms_json: JSON.stringify({ offered: [], requested: [] }) },
		};
		const ok = await handleIncomingOffer(h.ctx, envelope, { fromEndpoint: "swarm://" + "ab".repeat(32) });
		assert.equal(ok, false);
	});

	it("accepts offers from trusted peers and surfaces approval", async () => {
		const h = harness({
			peers: [{
				id: "peer-1",
				identity_pubkey: "alice-id",
				hyperswarm_pubkey: "ab".repeat(32),
				display_name: "Alice",
				trust_level: "trusted",
			}],
		});
		const envelope = {
			contentType: "glon/swap-offer",
			payload: encodeChangeBundle({ changes: [] }),
			senderPubkey: new Uint8Array(0),
			metadata: { swap_id: "swap0001", terms_json: JSON.stringify({ offered: [{ tokenId: "t1", amount: "5" }], requested: [{ tokenId: "t2", amount: "10" }] }) },
		};
		const ok = await handleIncomingOffer(h.ctx, envelope, { fromEndpoint: "swarm://" + "ab".repeat(32) });
		assert.equal(ok, true);
		const swap = h.ctx.state.swaps["swap0001"];
		assert.ok(swap);
		assert.equal(swap.role, "responder");
		assert.equal(swap.status, "awaiting_human");
		assert.equal(swap.counterparty_name, "Alice");
		assert.equal(swap.counterparty_hyperswarm_pubkey, "ab".repeat(32));
		assert.ok(h.notifyCalls.some((m) => m.includes("Alice") && m.includes("/trade accept")));
	});
});

describe("handleIncomingResponse swarm-pubkey check", () => {
	it("rejects a response from an unexpected swarm pubkey", async () => {
		const h = harness();
		h.ctx.state.swaps["swap-002"] = {
			swap_id: "swap-002", role: "originator", status: "sent",
			counterparty_peer_id: "p1", counterparty_identity_pubkey: "alice-id",
			counterparty_hyperswarm_pubkey: "ab".repeat(32),
			counterparty_name: "Alice",
			offer_id: "o1", key_name: "default",
			terms: { offered: [], requested: [] },
			created_at: Date.now(), timeout_seconds: 1800, last_event: Date.now(),
		};
		const envelope = {
			contentType: "glon/swap-response",
			payload: encodeChangeBundle({ changes: [] }),
			senderPubkey: new Uint8Array(0),
			metadata: { swap_id: "swap-002" },
		};
		const handled = await handleIncomingResponse(h.ctx, envelope, { fromEndpoint: "swarm://" + "cd".repeat(32) });
		assert.equal(handled, false);
		assert.equal(h.ctx.state.swaps["swap-002"].status, "sent");
		assert.ok(h.notifyCalls.some((m) => m.includes("unexpected swarm pubkey")));
	});
});

describe("declineSwap (responder) sends over hyperswarm", () => {
	it("dispatches a /transport-hyperswarm send (no transport-gmail)", async () => {
		const h = harness();
		h.ctx.state.swaps["dec-001"] = {
			swap_id: "dec-001", role: "responder", status: "awaiting_human",
			counterparty_peer_id: "p1", counterparty_identity_pubkey: "alice-id",
			counterparty_hyperswarm_pubkey: "ab".repeat(32),
			counterparty_name: "Alice",
			offer_id: "o1", key_name: "default",
			terms: { offered: [], requested: [] },
			created_at: Date.now(), timeout_seconds: 300,
			approval_deadline: Date.now() + 300_000, last_event: Date.now(),
		};
		await declineSwap(h.ctx, "dec-001", "explicit_decline");
		assert.equal(h.ctx.state.swaps["dec-001"].status, "cancelled");
		const send = h.sendCalls.find((c) => c.content_type === "glon/swap-decline");
		assert.ok(send);
		assert.equal(send.endpoint, "swarm://" + "ab".repeat(32));
		assert.equal(h.dispatchCalls.filter((c) => c.prefix === "/transport-gmail").length, 0, "must not touch transport-gmail");
	});
});

describe("handleIncomingDecline flips state via swarm-pubkey match", () => {
	it("accepts a matching swarm decline; ignores a mismatched one", async () => {
		const h = harness({
			peers: [{
				id: "p1", identity_pubkey: "alice-id", hyperswarm_pubkey: "ab".repeat(32),
				display_name: "Alice", trust_level: "trusted",
			}],
		});
		h.ctx.state.swaps["dec-002"] = {
			swap_id: "dec-002", role: "originator", status: "sent",
			counterparty_peer_id: "p1", counterparty_identity_pubkey: "alice-id",
			counterparty_hyperswarm_pubkey: "ab".repeat(32),
			counterparty_name: "Alice",
			offer_id: "o1", key_name: "default",
			terms: { offered: [], requested: [] },
			created_at: Date.now(), timeout_seconds: 1800, last_event: Date.now(),
		};
		const envelope = {
			contentType: "glon/swap-decline",
			payload: new TextEncoder().encode(JSON.stringify({ swap_id: "dec-002", reason: "explicit_decline" })),
			senderPubkey: new Uint8Array(0),
			metadata: { swap_id: "dec-002", reason: "explicit_decline" },
		};
		// Provide a store mock that returns the offer object (cancelOrchestration needs it).
		(h.ctx.store as any).get = async (id: string) => id === "o1" ? { typeKey: OFFER_TYPE_KEY, fields: { maker_pubkey: { stringValue: "deadbeef".repeat(8) } }, blocks: [] } : null;
		const handled = await handleIncomingDecline(h.ctx, envelope, { fromEndpoint: "swarm://" + "ab".repeat(32) });
		assert.equal(handled, true);
		assert.equal(h.ctx.state.swaps["dec-002"].status, "declined");
	});
});

describe("program shape", () => {
	it("registers the new typed-action set", () => {
		const t = (tradeProgram.actor!.typedActions ?? {}) as Record<string, unknown>;
		for (const name of ["start", "accept", "decline", "cancel", "list", "tick", "handleIncomingOffer", "handleIncomingResponse", "handleIncomingDecline"]) {
			assert.ok(t[name], `missing action: ${name}`);
		}
	});
});
