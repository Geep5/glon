/**
 * swap-email tests.
 *
 * Focus: state machine + persistence, content handler dispatch, and
 * timeout watchers. The orchestration helpers (createOffer, accept,
 * cancel, claim) are heavy SQL-like sequences best exercised by the
 * env-gated integration test; here we mock them at the dispatchProgram
 * boundary.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import swapEmailProgram, { __test } from "../src/programs/handlers/swap-email.js";
import {
	stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
	encodeTransportEnvelope, encodeChangeBundle, encodeChange,
} from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";
import { OFFER_TYPE_KEY } from "../src/programs/handlers/coin-types.js";

const {
	generateSwapId, termsSummary, getSwap, setSwap, snapshotState, restoreState,
	persistIfChanged, handleIncomingOffer, handleIncomingResponse,
	handleIncomingDecline, declineSwap, tickWatcher,
} = __test;

interface DispatchCall { prefix: string; action: string; args: unknown[]; }

interface Harness {
	ctx: ProgramContext;
	dispatchCalls: DispatchCall[];
	storedField: { value?: string };
	notifyCalls: string[];
	storeGetReturns: Record<string, any>;
	walletPubkey: string;
}

function makeHarness(opts: {
	dispatchOverrides?: Record<string, (args: unknown[]) => any>;
	storeOverrides?: Record<string, any>;
	walletPubkey?: string;
} = {}): Harness {
	const dispatchCalls: DispatchCall[] = [];
	const storedField: { value?: string } = {};
	const notifyCalls: string[] = [];
	const storeGetReturns: Record<string, any> = opts.storeOverrides ?? {};
	const walletPubkey = opts.walletPubkey ?? "deadbeef".repeat(8);
	const PROGRAM_ID = "test-swap-email";

	const dispatch = async (prefix: string, action: string, args: unknown[]): Promise<unknown> => {
		dispatchCalls.push({ prefix, action, args });

		const overrideKey = `${prefix} ${action}`;
		if (opts.dispatchOverrides?.[overrideKey]) {
			return opts.dispatchOverrides[overrideKey](args);
		}

		// Sensible defaults so flows don't blow up.
		if (prefix === "/user-chat" && action === "notify") {
			const text = (args[0] as { text?: string })?.text ?? "";
			notifyCalls.push(text);
			return { delivered: ["test"] };
		}
		if (prefix === "/wallet" && action === "show") return { pubkey: walletPubkey };
		if (prefix === "/wallet" && action === "signChange") {
			const inp = args[0] as { changeB64: string };
			return { changeB64: inp.changeB64 };
		}
		if (prefix === "/consensus" && action === "getNonce") return 0;
		if (prefix === "/swap" && action === "exportOffer") {
			return { bundleBase64: Buffer.from(encodeChangeBundle({ changes: [] })).toString("base64") };
		}
		if (prefix === "/swap" && action === "importOffer") {
			return { offerId: "imported-offer", status: "imported", escrowCount: 0 };
		}
		if (prefix === "/transport-gmail" && action === "send") {
			return { delivery_id: "test-delivery" };
		}
		throw new Error(`unmocked dispatch: ${prefix} ${action}`);
	};

	const ctx: ProgramContext = {
		client: {
			storeActor: { getOrCreate: () => ({ pushChangesBatch: async () => {} }) },
		} as any,
		store: {
			get: async (id: string) => {
				if (id === PROGRAM_ID) {
					if (!storedField.value) return { id, fields: {} };
					return { id, fields: { persisted_state: { stringValue: storedField.value } } };
				}
				return storeGetReturns[id] ?? null;
			},
			list: async () => [],
			coinSelect: async () => [],
		} as any,
		resolveId: async (s: string) => s,
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		style: {} as any,
		randomUUID: () => "uuid-fixed",
		state: {},
		emit: () => {},
		programId: PROGRAM_ID,
		objectActor: (id: string) => ({
			setField: async (key: string, valueJson: string) => {
				if (id === PROGRAM_ID && key === "persisted_state") {
					try {
						const wrapped = JSON.parse(valueJson) as { stringValue?: string };
						storedField.value = wrapped.stringValue;
					} catch { /* ignore */ }
				}
			},
			pushChanges: async () => {},
			getHeads: async () => [],
		}) as any,
		dispatchProgram: dispatch,
		dispatchTypedAction: async (prefix, action, input) => dispatch(prefix, action, [input]),
	};

	return { ctx, dispatchCalls, storedField, notifyCalls, storeGetReturns, walletPubkey };
}

describe("generateSwapId", () => {
	it("returns 8 lowercase hex chars", () => {
		for (let i = 0; i < 20; i++) {
			const id = generateSwapId();
			assert.equal(id.length, 8);
			assert.match(id, /^[0-9a-f]{8}$/);
		}
	});
	it("is highly likely to be unique across calls", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 50; i++) seen.add(generateSwapId());
		assert.ok(seen.size >= 49, `got ${seen.size} unique ids out of 50`);
	});
});

describe("termsSummary", () => {
	it("formats single-asset terms", () => {
		const s = termsSummary({
			offered: [{ tokenId: "ffaabb1100ddeeccaa", amount: "5" }],
			requested: [{ tokenId: "112233aabbccddeeff", amount: "10" }],
		});
		assert.match(s, /5 ffaabb11/);
		assert.match(s, /10 112233aa/);
	});
});

describe("state persistence", () => {
	it("round-trips swaps through snapshot + restore", async () => {
		const h1 = makeHarness();
		const swap = {
			swap_id: "abc12345",
			role: "originator" as const,
			status: "sent" as const,
			counterparty_email: "bob@example.com",
			offer_id: "offer1",
			key_name: "default",
			terms: { offered: [{ tokenId: "t1", amount: "5" }], requested: [{ tokenId: "t2", amount: "10" }] },
			created_at: 1_700_000_000_000,
			timeout_seconds: 3600,
			last_event: 1_700_000_000_000,
		};
		setSwap(h1.ctx.state, swap);
		await persistIfChanged(h1.ctx.state, h1.ctx);
		assert.ok(h1.storedField.value, "field should be persisted");

		const h2 = makeHarness();
		h2.storedField.value = h1.storedField.value;
		await restoreState(h2.ctx.state, h2.ctx);
		const restored = getSwap(h2.ctx.state, "abc12345");
		assert.deepEqual(restored, swap);
	});

	it("does not write if the snapshot is unchanged", async () => {
		const h = makeHarness();
		const swap = {
			swap_id: "abc12345",
			role: "originator" as const,
			status: "sent" as const,
			counterparty_email: "x@y.z",
			offer_id: "o1",
			key_name: "default",
			terms: { offered: [], requested: [] },
			created_at: 0,
			timeout_seconds: 0,
			last_event: 0,
		};
		setSwap(h.ctx.state, swap);
		await persistIfChanged(h.ctx.state, h.ctx);
		const after1 = h.storedField.value;
		await persistIfChanged(h.ctx.state, h.ctx);
		assert.equal(h.storedField.value, after1, "no-op persist should not change anything");
	});
});

describe("handleIncomingOffer", () => {
	it("creates responder state and surfaces to user", async () => {
		const h = makeHarness();
		const envelope = {
			contentType: "glon/swap-offer",
			payload: encodeChangeBundle({ changes: [] }),
			senderPubkey: new Uint8Array(0),
			metadata: {
				swap_id: "abc12345",
				terms_json: JSON.stringify({
					offered: [{ tokenId: "t1", amount: "5" }],
					requested: [{ tokenId: "t2", amount: "10" }],
				}),
			},
		};
		const handled = await handleIncomingOffer(h.ctx, envelope, { fromEndpoint: "gmail://alice@example.com" });
		assert.equal(handled, true);

		const swap = getSwap(h.ctx.state, "abc12345");
		assert.ok(swap);
		assert.equal(swap!.role, "responder");
		assert.equal(swap!.status, "awaiting_human");
		assert.equal(swap!.counterparty_email, "alice@example.com");
		assert.ok(swap!.approval_deadline! > Date.now());
		assert.ok(h.notifyCalls.some((m) => m.includes("alice@example.com")));
		assert.ok(h.notifyCalls.some((m) => m.includes("/swap-email accept")));
	});

	it("is idempotent on replay", async () => {
		const h = makeHarness();
		const envelope = {
			contentType: "glon/swap-offer",
			payload: encodeChangeBundle({ changes: [] }),
			senderPubkey: new Uint8Array(0),
			metadata: { swap_id: "dup12345" },
		};
		await handleIncomingOffer(h.ctx, envelope, { fromEndpoint: "gmail://alice@example.com" });
		const before = h.notifyCalls.length;
		const handled2 = await handleIncomingOffer(h.ctx, envelope, { fromEndpoint: "gmail://alice@example.com" });
		assert.equal(handled2, true);
		assert.equal(h.notifyCalls.length, before, "duplicate offer should not re-notify");
	});

	it("rejects an offer with no swap_id metadata", async () => {
		const h = makeHarness();
		const envelope = {
			contentType: "glon/swap-offer",
			payload: encodeChangeBundle({ changes: [] }),
			senderPubkey: new Uint8Array(0),
			metadata: {},
		};
		const handled = await handleIncomingOffer(h.ctx, envelope, { fromEndpoint: "gmail://alice@example.com" });
		assert.equal(handled, false);
	});
});

describe("handleIncomingResponse", () => {
	it("refuses a response from an unexpected sender", async () => {
		const h = makeHarness();
		setSwap(h.ctx.state, {
			swap_id: "abc12345",
			role: "originator", status: "sent",
			counterparty_email: "expected@example.com",
			offer_id: "o1", key_name: "default",
			terms: { offered: [], requested: [] },
			created_at: Date.now(), timeout_seconds: 3600, last_event: Date.now(),
		});
		const envelope = {
			contentType: "glon/swap-response",
			payload: encodeChangeBundle({ changes: [] }),
			senderPubkey: new Uint8Array(0),
			metadata: { swap_id: "abc12345" },
		};
		const handled = await handleIncomingResponse(h.ctx, envelope, { fromEndpoint: "gmail://attacker@evil.com" });
		assert.equal(handled, false);
		const swap = getSwap(h.ctx.state, "abc12345");
		assert.equal(swap!.status, "sent", "state should not advance");
	});

	it("ignores a response for an unknown swap_id", async () => {
		const h = makeHarness();
		const envelope = {
			contentType: "glon/swap-response",
			payload: encodeChangeBundle({ changes: [] }),
			senderPubkey: new Uint8Array(0),
			metadata: { swap_id: "deadbeef" },
		};
		const handled = await handleIncomingResponse(h.ctx, envelope, { fromEndpoint: "gmail://x@y.z" });
		assert.equal(handled, false);
	});
});

describe("handleIncomingDecline", () => {
	it("transitions originator to declined and triggers cancel orchestration", async () => {
		const offerId = "offer1";
		const makerPubkey = "deadbeef".repeat(8);
		const h = makeHarness({
			storeOverrides: {
				[offerId]: {
					typeKey: OFFER_TYPE_KEY,
					fields: { maker_pubkey: { stringValue: makerPubkey } },
					blocks: [],
				},
			},
			walletPubkey: makerPubkey,
		});

		setSwap(h.ctx.state, {
			swap_id: "abc12345",
			role: "originator", status: "sent",
			counterparty_email: "bob@example.com",
			offer_id: offerId, key_name: "default",
			terms: { offered: [], requested: [] },
			created_at: Date.now(), timeout_seconds: 3600, last_event: Date.now(),
		});

		const envelope = {
			contentType: "glon/swap-decline",
			payload: new TextEncoder().encode(JSON.stringify({ swap_id: "abc12345", reason: "explicit_decline" })),
			senderPubkey: new Uint8Array(0),
			metadata: { swap_id: "abc12345", reason: "explicit_decline" },
		};
		const handled = await handleIncomingDecline(h.ctx, envelope, { fromEndpoint: "gmail://bob@example.com" });
		assert.equal(handled, true);

		const swap = getSwap(h.ctx.state, "abc12345");
		assert.equal(swap!.status, "declined");
		assert.ok(h.notifyCalls.some((m) => m.includes("declined")));
	});

	it("ignores a decline from an unexpected sender", async () => {
		const h = makeHarness();
		setSwap(h.ctx.state, {
			swap_id: "abc12345",
			role: "originator", status: "sent",
			counterparty_email: "bob@example.com",
			offer_id: "o1", key_name: "default",
			terms: { offered: [], requested: [] },
			created_at: Date.now(), timeout_seconds: 3600, last_event: Date.now(),
		});
		const envelope = {
			contentType: "glon/swap-decline",
			payload: new TextEncoder().encode("{}"),
			senderPubkey: new Uint8Array(0),
			metadata: { swap_id: "abc12345" },
		};
		const handled = await handleIncomingDecline(h.ctx, envelope, { fromEndpoint: "gmail://attacker@evil.com" });
		assert.equal(handled, false);
		const swap = getSwap(h.ctx.state, "abc12345");
		assert.equal(swap!.status, "sent");
	});
});

describe("declineSwap (responder side)", () => {
	it("sends a decline email and flips state to cancelled", async () => {
		const h = makeHarness();
		setSwap(h.ctx.state, {
			swap_id: "rspd0001",
			role: "responder", status: "awaiting_human",
			counterparty_email: "alice@example.com",
			offer_id: "o1", key_name: "default",
			terms: { offered: [], requested: [] },
			created_at: Date.now(),
			timeout_seconds: 1200,
			approval_deadline: Date.now() + 1_200_000,
			last_event: Date.now(),
		});

		await declineSwap(h.ctx, "rspd0001", "explicit_decline");
		const swap = getSwap(h.ctx.state, "rspd0001");
		assert.equal(swap!.status, "cancelled");

		const sendCall = h.dispatchCalls.find((c) => c.prefix === "/transport-gmail" && c.action === "send");
		assert.ok(sendCall, "should have dispatched a send");
		const sent = sendCall!.args[0] as any;
		assert.equal(sent.endpoint, "gmail://alice@example.com");
		assert.match(sent.metadata.subject, /swap-decline rspd0001/);
		assert.equal(sent.content_type, "glon/swap-decline");
	});
});

describe("tickWatcher: originator timeout", () => {
	it("cancels expired originator swaps", async () => {
		const offerId = "offer-expired";
		const makerPubkey = "ab".repeat(32);
		const h = makeHarness({
			storeOverrides: {
				[offerId]: {
					typeKey: OFFER_TYPE_KEY,
					fields: { maker_pubkey: { stringValue: makerPubkey } },
					blocks: [],
				},
			},
			walletPubkey: makerPubkey,
		});
		setSwap(h.ctx.state, {
			swap_id: "old00001",
			role: "originator", status: "sent",
			counterparty_email: "bob@example.com",
			offer_id: offerId, key_name: "default",
			terms: { offered: [], requested: [] },
			created_at: Date.now() - 10_000,
			timeout_seconds: 1, // already past
			last_event: Date.now() - 10_000,
		});

		await tickWatcher(h.ctx);
		const swap = getSwap(h.ctx.state, "old00001");
		assert.equal(swap!.status, "timed_out");
	});
});

describe("tickWatcher: responder approval timeout", () => {
	it("auto-declines an awaiting_human swap past its deadline", async () => {
		const h = makeHarness();
		setSwap(h.ctx.state, {
			swap_id: "wait0001",
			role: "responder", status: "awaiting_human",
			counterparty_email: "alice@example.com",
			offer_id: "o1", key_name: "default",
			terms: { offered: [], requested: [] },
			created_at: Date.now() - 30 * 60 * 1000,
			timeout_seconds: 60,
			approval_deadline: Date.now() - 10_000, // already past
			last_event: Date.now() - 30 * 60 * 1000,
		});

		await tickWatcher(h.ctx);
		const swap = getSwap(h.ctx.state, "wait0001");
		assert.equal(swap!.status, "cancelled");
		const sendCall = h.dispatchCalls.find((c) => c.prefix === "/transport-gmail" && c.action === "send");
		assert.ok(sendCall);
		const sent = sendCall!.args[0] as any;
		assert.equal(sent.metadata.reason, "approval_timeout");
	});
});

describe("program shape", () => {
	it("registers expected typed actions", () => {
		const t = (swapEmailProgram.actor!.typedActions ?? {}) as any;
		assert.ok(t.start);
		assert.ok(t.accept);
		assert.ok(t.decline);
		assert.ok(t.cancel);
		assert.ok(t.list);
		assert.ok(t.tick);
		assert.ok(t.handleIncomingOffer);
		assert.ok(t.handleIncomingResponse);
		assert.ok(t.handleIncomingDecline);
	});
});
