/**
 * Reminder scheduler tests.
 *
 * Covers schedule, list, cancel, get, and the scheduler tick — including
 * idempotency guard, channel dispatch routing, failure handling, and
 * filtering.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import remindProgram, { __test, CHANNELS } from "../src/programs/handlers/remind.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

interface StoredObj {
	id: string;
	typeKey: string;
	fields: Record<string, any>;
	deleted: boolean;
}

function createHarness() {
	const objects = new Map<string, StoredObj>();
	const dispatchCalls: { prefix: string; action: string; args: unknown[] }[] = [];
	const dispatchHandlers = new Map<string, (args: unknown[]) => unknown>();
	let nextId = 1;

	// Pre-seed common test target ids as peers so target validation passes.
	// Tests that exercise validation explicitly seed/omit targets themselves.
	for (const id of ["grant", "g", "p", "x", "mom", "peer-grant", "peer-x"]) {
		objects.set(id, { id, typeKey: "peer", fields: {}, deleted: false });
	}

	function actorFor(id: string) {
		return {
			setField: async (key: string, valueJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`no object ${id}`);
				obj.fields[key] = JSON.parse(valueJson);
			},
			setFields: async (fieldsJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`no object ${id}`);
				Object.assign(obj.fields, JSON.parse(fieldsJson));
			},
			markDeleted: async () => {
				const obj = objects.get(id);
				if (obj) obj.deleted = true;
			},
			addBlock: async () => { /* unused */ },
			setContent: async () => { /* unused */ },
		};
	}

	const store = {
		get: async (id: string) => {
			const o = objects.get(id);
			if (!o) return null;
			return {
				id, typeKey: o.typeKey, fields: o.fields, deleted: o.deleted,
				blocks: [], blockProvenance: {}, content: "",
				createdAt: 0, updatedAt: 0, headIds: [], changeCount: 0,
			};
		},
		create: async (typeKey: string, fieldsJson: string) => {
			const id = `${typeKey}-${nextId++}`;
			objects.set(id, { id, typeKey, fields: fieldsJson ? JSON.parse(fieldsJson) : {}, deleted: false });
			return id;
		},
		list: async (typeKey?: string) => {
			const refs: { id: string; typeKey: string }[] = [];
			for (const o of objects.values()) {
				if (typeKey && o.typeKey !== typeKey) continue;
				refs.push({ id: o.id, typeKey: o.typeKey });
			}
			return refs;
		},
	};

	const client = {
		objectActor: { getOrCreate: (args: string[]) => actorFor(args[0]) },
	};

	const ctx: ProgramContext = {
		client, store,
		resolveId: async (p: string) => objects.has(p) ? p : null,
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		randomUUID: () => `uuid-${nextId++}`,
		state: {},
		emit: () => {},
		programId: "test-remind",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async (prefix, action, args) => {
			dispatchCalls.push({ prefix, action, args });
			const key = `${prefix}::${action}`;
			const handler = dispatchHandlers.get(key);
			if (!handler) throw new Error(`no dispatch handler for ${key}`);
			return handler(args);
		},
	};

	return {
		ctx, objects, dispatchCalls,
		onDispatch(prefix: string, action: string, fn: (args: unknown[]) => unknown) {
			dispatchHandlers.set(`${prefix}::${action}`, fn);
		},
		/** Register an object so target validation accepts it. Default typeKey=peer. */
		seedTarget(id: string, typeKey: "peer" | "agent" = "peer") {
			objects.set(id, { id, typeKey, fields: {}, deleted: false });
			return id;
		},
	};
}

// ── parseFireAt ──────────────────────────────────────────────────

describe("parseFireAt", () => {
	it("parses ISO strings", () => {
		const ms = __test.parseFireAt("2030-04-24T15:00:00Z");
		assert.ok(ms > 0);
		assert.equal(ms, Date.parse("2030-04-24T15:00:00Z"));
	});

	it("parses relative shorthand", () => {
		const before = Date.now();
		const ms = __test.parseFireAt("+5m");
		const after = Date.now();
		assert.ok(ms >= before + 5 * 60_000);
		assert.ok(ms <= after + 5 * 60_000 + 100);
	});

	it("accepts raw numbers as epoch ms", () => {
		assert.equal(__test.parseFireAt(12345), 12345);
	});

	it("rejects garbage", () => {
		assert.throws(() => __test.parseFireAt("not-a-date"), /invalid fire_at/);
	});
});

// ── schedule ─────────────────────────────────────────────────────

describe("schedule", () => {
	it("creates a reminder object with correctly-shaped fields", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const r = await schedule(h.ctx, {
			channel: "discord",
			target: "peer-grant",
			fire_at: "+10m",
			payload: { message: "call Sarah" },
			created_by: "peer-grant",
			note: "sarah-call",
		}) as { id: string; fire_at_ms: number };

		const obj = h.objects.get(r.id)!;
		assert.equal(obj.typeKey, "reminder");
		assert.equal(obj.fields.channel.stringValue, "discord");
		assert.equal(obj.fields.target.stringValue, "peer-grant");
		assert.equal(obj.fields.status.stringValue, "pending");
		assert.equal(obj.fields.created_by.stringValue, "peer-grant");
		assert.equal(obj.fields.note.stringValue, "sarah-call");
		const payload = JSON.parse(obj.fields.payload.stringValue);
		assert.deepEqual(payload, { message: "call Sarah" });
		assert.ok(obj.fields.fire_at_ms.intValue > Date.now());
		assert.ok(obj.fields.created_at_ms.intValue <= Date.now());
	});

	it("rejects unknown channels", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		await assert.rejects(
			() => schedule(h.ctx, { channel: "sms", target: "x", fire_at: "+1m" }),
			/unknown channel/,
		);
	});

	it("defaults created_by to 'system' when omitted", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const r = await schedule(h.ctx, {
			channel: "discord", target: "peer-x", fire_at: "+1h",
			payload: { message: "x" },
		}) as { id: string };
		const obj = h.objects.get(r.id)!;
		assert.equal(obj.fields.created_by.stringValue, "system");
	});
});

// ── list + get + cancel ──────────────────────────────────────────

describe("list / get / cancel", () => {
	it("list returns records sorted by fire_at_ms", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const list = remindProgram.actor!.actions!.list;

		await schedule(h.ctx, { channel: "discord", target: "p", fire_at: "+2h", payload: { message: "later" } });
		await schedule(h.ctx, { channel: "discord", target: "p", fire_at: "+1h", payload: { message: "middle" } });
		await schedule(h.ctx, { channel: "discord", target: "p", fire_at: "+30m", payload: { message: "soon" } });

		const records = await list(h.ctx) as Array<{ payload: { message: string } }>;
		assert.equal(records.length, 3);
		assert.equal(records[0].payload.message, "soon");
		assert.equal(records[1].payload.message, "middle");
		assert.equal(records[2].payload.message, "later");
	});

	it("list filters by status / peer / channel / before", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const cancel = remindProgram.actor!.actions!.cancel;
		const list = remindProgram.actor!.actions!.list;

		const a = await schedule(h.ctx, { channel: "discord", target: "grant", fire_at: "+1h", payload: { message: "hi" }, created_by: "grant" }) as { id: string };
		const b = await schedule(h.ctx, { channel: "email", target: "mom@ex.com", fire_at: "+2h", payload: { subject: "hi", body: "hi" }, created_by: "grant" }) as { id: string };
		await schedule(h.ctx, { channel: "discord", target: "mom", fire_at: "+3h", payload: { message: "hi" }, created_by: "mom" });
		await cancel(h.ctx, a.id);

		const pending = await list(h.ctx, { status: "pending" }) as Array<{ id: string }>;
		assert.equal(pending.length, 2);
		assert.ok(!pending.find((r) => r.id === a.id));

		const email = await list(h.ctx, { channel: "email" }) as Array<{ id: string }>;
		assert.equal(email.length, 1);
		assert.equal(email[0].id, b.id);

		const grantOnly = await list(h.ctx, { peer_id: "grant" }) as Array<unknown>;
		// `a` (created_by grant, cancelled) + `b` (created_by grant) match by created_by;
		// the mom one doesn't match.
		assert.equal(grantOnly.length, 2);
	});

	it("get returns full record or null", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const get = remindProgram.actor!.actions!.get;
		const r = await schedule(h.ctx, { channel: "discord", target: "x", fire_at: "+1h", payload: { message: "hi" } }) as { id: string };
		const rec = await get(h.ctx, r.id) as { id: string; payload: { message: string } };
		assert.equal(rec.id, r.id);
		assert.equal(rec.payload.message, "hi");

		assert.equal(await get(h.ctx, "nope"), null);
	});

	it("cancel marks pending reminders cancelled; noop on non-pending", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const cancel = remindProgram.actor!.actions!.cancel;
		const r = await schedule(h.ctx, { channel: "discord", target: "x", fire_at: "+1h", payload: { message: "x" } }) as { id: string };
		const result1 = await cancel(h.ctx, r.id) as { ok: boolean; was: string };
		assert.equal(result1.ok, true);
		assert.equal(result1.was, "pending");
		// Second cancel is a noop.
		const result2 = await cancel(h.ctx, r.id) as { ok: boolean; was: string };
		assert.equal(result2.ok, false);
		assert.equal(result2.was, "cancelled");
	});
});

// ── runSchedulerTick ─────────────────────────────────────────────

describe("runSchedulerTick", () => {
	it("fires only due + pending reminders via the right dispatcher", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;

		// Mock downstream programs.
		let discordSends = 0;
		let agentCompositions = 0;
		h.onDispatch("/discord", "send", (args) => {
			discordSends++;
			const inp = (args as [any])[0];
			assert.equal(inp.peer_id, "grant");
			assert.equal(inp.text, "wake up");
			return { channel_id: "ch", message_ids: ["m"] };
		});
		h.onDispatch("/holdfast", "ingest", (args) => {
			agentCompositions++;
			const [source, peer, text] = args as [string, string, string];
			assert.equal(source, "scheduler");
			assert.equal(peer, "grant");
			assert.match(text, /think about dinner/);
			return { finalText: "ok", iterations: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, peer: { display_name: "grant" } };
		});

		// Due: one discord, one agent_compose. Not due: one in the future.
		const dueDiscord = await schedule(h.ctx, {
			channel: "discord", target: "grant",
			fire_at: Date.now() - 60_000, // 1 min ago
			payload: { message: "wake up" },
		}) as { id: string };
		const dueGraice = await schedule(h.ctx, {
			channel: "agent_compose", target: "grant",
			fire_at: Date.now() - 30_000,
			payload: { prompt: "think about dinner" },
		}) as { id: string };
		const notDue = await schedule(h.ctx, {
			channel: "discord", target: "grant",
			fire_at: Date.now() + 3_600_000, // 1h ahead
			payload: { message: "later" },
		}) as { id: string };

		const result = await __test.runSchedulerTick(h.ctx);
		assert.equal(discordSends, 1);
		assert.equal(agentCompositions, 1);
		assert.equal(result.fired, 2);
		assert.equal(result.failed, 0);

		// Status transitions.
		assert.equal(h.objects.get(dueDiscord.id)!.fields.status.stringValue, "sent");
		assert.equal(h.objects.get(dueGraice.id)!.fields.status.stringValue, "sent");
		assert.equal(h.objects.get(notDue.id)!.fields.status.stringValue, "pending");
		assert.ok(h.objects.get(dueDiscord.id)!.fields.sent_at_ms.intValue > 0);
	});

	it("retries once on transient errors (e.g. fetch failed) and recovers", async () => {
		__test.setRetryDelayMs(0);
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;

		let attempts = 0;
		h.onDispatch("/discord", "send", () => {
			attempts++;
			if (attempts === 1) throw new Error("fetch failed");
			return { channel_id: "ch", message_ids: ["m"] };
		});

		const r = await schedule(h.ctx, {
			channel: "discord", target: "grant",
			fire_at: Date.now() - 1000,
			payload: { message: "survive a blip" },
		}) as { id: string };

		const result = await __test.runSchedulerTick(h.ctx);
		assert.equal(attempts, 2, "retry attempted");
		assert.equal(result.fired, 1);
		assert.equal(result.failed, 0);
		assert.equal(h.objects.get(r.id)!.fields.status.stringValue, "sent");
	});

	it("retries on transient and gives up after the second attempt also fails", async () => {
		__test.setRetryDelayMs(0);
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;

		let attempts = 0;
		h.onDispatch("/discord", "send", () => {
			attempts++;
			throw new Error("fetch failed");
		});

		const r = await schedule(h.ctx, {
			channel: "discord", target: "grant",
			fire_at: Date.now() - 1000,
			payload: { message: "persistent outage" },
		}) as { id: string };

		const result = await __test.runSchedulerTick(h.ctx);
		assert.equal(attempts, 2, "two attempts before giving up");
		assert.equal(result.fired, 0);
		assert.equal(result.failed, 1);
		const obj = h.objects.get(r.id)!;
		assert.equal(obj.fields.status.stringValue, "failed");
		assert.match(obj.fields.last_error.stringValue, /fetch failed/);
	});

	it("non-transient errors (e.g. unknown peer) bypass retry and fail immediately", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;

		let attempts = 0;
		h.onDispatch("/discord", "send", () => {
			attempts++;
			throw new Error("peer Grant has no discord_id");
		});

		const r = await schedule(h.ctx, {
			channel: "discord", target: "grant",
			fire_at: Date.now() - 1000,
			payload: { message: "misconfig" },
		}) as { id: string };

		const result = await __test.runSchedulerTick(h.ctx);
		assert.equal(attempts, 1, "non-transient errors aren't retried");
		assert.equal(result.failed, 1);
		assert.match(h.objects.get(r.id)!.fields.last_error.stringValue, /no discord_id/);
	});

	it("records last_error and status=failed when the dispatcher throws", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		h.onDispatch("/discord", "send", () => { throw new Error("boom"); });

		const r = await schedule(h.ctx, {
			channel: "discord", target: "grant",
			fire_at: Date.now() - 1000,
			payload: { message: "x" },
		}) as { id: string };

		const result = await __test.runSchedulerTick(h.ctx);
		assert.equal(result.failed, 1);
		assert.equal(result.fired, 0);
		const obj = h.objects.get(r.id)!;
		assert.equal(obj.fields.status.stringValue, "failed");
		assert.match(obj.fields.last_error.stringValue, /boom/);
	});

	it("skips cancelled and already-sent reminders", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const cancel = remindProgram.actor!.actions!.cancel;
		h.onDispatch("/discord", "send", () => ({ channel_id: "c", message_ids: [] }));

		const cancelled = await schedule(h.ctx, {
			channel: "discord", target: "g", fire_at: Date.now() - 1000, payload: { message: "x" },
		}) as { id: string };
		await cancel(h.ctx, cancelled.id);

		const result = await __test.runSchedulerTick(h.ctx);
		assert.equal(result.fired, 0);
		assert.equal(h.objects.get(cancelled.id)!.fields.status.stringValue, "cancelled");
	});

	it("marks status=sending before dispatch (idempotency guard)", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;

		let observedStatusAtDispatch: string | undefined;
		h.onDispatch("/discord", "send", () => {
			// During dispatch, the reminder's on-disk status should be 'sending'.
			for (const obj of h.objects.values()) {
				if (obj.typeKey === "reminder") {
					observedStatusAtDispatch = obj.fields.status.stringValue;
				}
			}
			return { channel_id: "c", message_ids: ["m"] };
		});

		await schedule(h.ctx, {
			channel: "discord", target: "g",
			fire_at: Date.now() - 1000, payload: { message: "x" },
		});
		await __test.runSchedulerTick(h.ctx);
		assert.equal(observedStatusAtDispatch, "sending");
	});
});

// ── channel set ──────────────────────────────────────────────────

describe("CHANNELS", () => {
	it("exposes the supported channels", () => {
		assert.deepEqual([...CHANNELS].sort(), ["discord", "email", "agent_compose"].sort());
	});
});


// ── normalizePayload ─────────────────────────────────────────────
//
// Models routinely pass `payload` as a JSON-encoded string instead of an
// object even though the schema declares `type: object`. Older /remind
// schedule then JSON.stringify'd that string a second time, so the stored
// field was double-encoded and parsing on read returned `{}` — every
// fired reminder delivered the empty fallback. These tests pin the fix.

describe("normalizePayload", () => {
	it("passes plain objects through", () => {
		assert.deepEqual(__test.normalizePayload({ prompt: "hi" }), { prompt: "hi" });
		assert.deepEqual(__test.normalizePayload({}), {});
	});

	it("parses JSON-encoded object strings", () => {
		assert.deepEqual(__test.normalizePayload('{"prompt":"hi"}'), { prompt: "hi" });
		assert.deepEqual(__test.normalizePayload('{}'), {});
	});

	it("treats null/undefined/empty string as empty payload", () => {
		assert.deepEqual(__test.normalizePayload(null), {});
		assert.deepEqual(__test.normalizePayload(undefined), {});
		assert.deepEqual(__test.normalizePayload(""), {});
		assert.deepEqual(__test.normalizePayload("   "), {});
	});

	it("rejects strings that aren't valid JSON", () => {
		assert.throws(() => __test.normalizePayload("not json"), /not valid JSON/);
	});

	it("rejects JSON that decodes to a non-object (number, array, string)", () => {
		assert.throws(() => __test.normalizePayload('"prompt"'), /must encode a JSON object/);
		assert.throws(() => __test.normalizePayload("42"), /must encode a JSON object/);
		assert.throws(() => __test.normalizePayload("[1,2,3]"), /must encode a JSON object/);
	});

	it("rejects non-object, non-string types outright", () => {
		assert.throws(() => __test.normalizePayload(42), /must be an object or a JSON-encoded object string/);
		assert.throws(() => __test.normalizePayload(true), /must be an object or a JSON-encoded object string/);
		assert.throws(() => __test.normalizePayload([1, 2, 3]), /must be an object or a JSON-encoded object string/);
	});
});

// ── parsePayloadField ────────────────────────────────────────────
//
// Defensive read recovers reminders written by the buggy old schedule path.

describe("parsePayloadField", () => {
	it("reads a clean JSON object string", () => {
		assert.deepEqual(__test.parsePayloadField('{"prompt":"hi"}'), { prompt: "hi" });
	});

	it("unwraps a legacy double-encoded payload (string-of-string-of-object)", () => {
		// What the old schedule path stored: JSON.stringify of an already-stringified payload.
		const legacy = JSON.stringify('{"prompt":"hi"}');
		assert.deepEqual(__test.parsePayloadField(legacy), { prompt: "hi" });
	});

	it("returns {} on garbage input rather than throwing", () => {
		assert.deepEqual(__test.parsePayloadField(""), {});
		assert.deepEqual(__test.parsePayloadField("not json"), {});
		assert.deepEqual(__test.parsePayloadField('"a string"'), {});
	});
});

// ── validatePayloadForChannel ────────────────────────────────────
//
// Per-channel contracts catch payload mistakes at schedule time so the
// model can self-correct, instead of producing a fired reminder that
// delivers the empty `Follow up: {}` fallback at dispatch time.

describe("validatePayloadForChannel", () => {
	it("agent_compose requires a non-empty prompt string", () => {
		__test.validatePayloadForChannel("agent_compose", { prompt: "hi" });
		assert.throws(() => __test.validatePayloadForChannel("agent_compose", {}), /requires a non-empty 'prompt'/);
		assert.throws(() => __test.validatePayloadForChannel("agent_compose", { prompt: "" }), /requires a non-empty 'prompt'/);
		assert.throws(() => __test.validatePayloadForChannel("agent_compose", { prompt: "   " }), /requires a non-empty 'prompt'/);
		assert.throws(() => __test.validatePayloadForChannel("agent_compose", { prompt: 42 as unknown as string }), /requires a non-empty 'prompt'/);
	});

	it("discord requires a non-empty message string", () => {
		__test.validatePayloadForChannel("discord", { message: "hi" });
		assert.throws(() => __test.validatePayloadForChannel("discord", {}), /requires a non-empty 'message'/);
		assert.throws(() => __test.validatePayloadForChannel("discord", { message: "" }), /requires a non-empty 'message'/);
	});

	it("email requires both subject and body (or message as body)", () => {
		__test.validatePayloadForChannel("email", { subject: "x", body: "y" });
		__test.validatePayloadForChannel("email", { subject: "x", message: "y" });
		assert.throws(() => __test.validatePayloadForChannel("email", {}), /requires a non-empty 'subject'/);
		assert.throws(() => __test.validatePayloadForChannel("email", { subject: "x" }), /requires a non-empty 'body'/);
	});
});

// ── validateTarget + doSchedule integration ─────────────────────
//
// Targets that aren't peer/agent objects are the most damaging input the
// scheduler accepts: the dispatcher then routes to /holdfast.ingest using
// the target as a peer id, the from-tag becomes garbage, and the agent
// can't find the sender to reply to. Reject early.

describe("target validation", () => {
	it("rejects targets that don't resolve to any object", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		await assert.rejects(
			() => schedule(h.ctx, {
				channel: "discord", target: "not-a-real-id",
				fire_at: "+1m", payload: { message: "x" },
			}),
			/target object not found/,
		);
	});

	it("rejects targets that resolve to a program object (the Graice mis-pick)", async () => {
		const h = createHarness();
		// Mimic the actual Graice bug: agent picked the /agent program object's id
		// as `target` and it ended up firing reminders into nothing useful.
		h.objects.set("prog-agent", { id: "prog-agent", typeKey: "program", fields: {}, deleted: false });
		const schedule = remindProgram.actor!.actions!.schedule;
		await assert.rejects(
			() => schedule(h.ctx, {
				channel: "agent_compose", target: "prog-agent",
				fire_at: "+1m", payload: { prompt: "do thing" },
			}),
			/typeKey='program'/,
		);
	});

	it("accepts a peer target for discord", async () => {
		const h = createHarness();
		h.seedTarget("alice", "peer");
		const schedule = remindProgram.actor!.actions!.schedule;
		const r = await schedule(h.ctx, {
			channel: "discord", target: "alice",
			fire_at: "+1m", payload: { message: "hi" },
		}) as { id: string };
		assert.ok(r.id);
	});

	it("accepts an agent target for agent_compose (self-scheduled prompts)", async () => {
		const h = createHarness();
		h.seedTarget("my-agent", "agent");
		const schedule = remindProgram.actor!.actions!.schedule;
		const r = await schedule(h.ctx, {
			channel: "agent_compose", target: "my-agent",
			fire_at: "+1m", payload: { prompt: "think about dinner" },
		}) as { id: string };
		assert.ok(r.id);
	});

	it("email targets must contain @ but skip the Glon-id existence check", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const r = await schedule(h.ctx, {
			channel: "email", target: "alice@example.com",
			fire_at: "+1m", payload: { subject: "hi", body: "hello" },
		}) as { id: string };
		assert.ok(r.id);
		await assert.rejects(
			() => schedule(h.ctx, {
				channel: "email", target: "not-an-email",
				fire_at: "+1m", payload: { subject: "hi", body: "hi" },
			}),
			/email target must be an email address/,
		);
	});
});

// ── doSchedule + string payload (the original Graice bug) ────────
//
// End-to-end check that a model passing payload as a JSON string still
// produces a reminder whose stored payload round-trips to a real object.

describe("doSchedule with string payload (legacy model behaviour)", () => {
	it("accepts payload as a JSON string and stores a clean payload object", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		const r = await schedule(h.ctx, {
			channel: "agent_compose", target: "grant",
			fire_at: "+1m",
			// What Graice was actually sending — payload as a JSON string.
			payload: '{"prompt":"check chrome sessions"}' as unknown as Record<string, unknown>,
		}) as { id: string };

		const obj = h.objects.get(r.id)!;
		const storedPayload = JSON.parse(obj.fields.payload.stringValue);
		assert.deepEqual(storedPayload, { prompt: "check chrome sessions" });
		// And the dispatcher's view of the record gets the prompt string out.
		const rec = __test.recordFromState(r.id, obj.fields)!;
		assert.equal(rec.payload.prompt, "check chrome sessions");
	});

	it("rejects a string payload that doesn't decode to an object", async () => {
		const h = createHarness();
		const schedule = remindProgram.actor!.actions!.schedule;
		await assert.rejects(
			() => schedule(h.ctx, {
				channel: "discord", target: "grant",
				fire_at: "+1m",
				payload: '"just a string"' as unknown as Record<string, unknown>,
			}),
			/must encode a JSON object/,
		);
	});
});
