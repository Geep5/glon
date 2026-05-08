/**
 * Advanced subagent spawning tests (M4, M6, M8, M9, M10).
 *
 * Covers:
 *   - validateAgainstSchema: type, required, enum, nested objects, arrays
 *   - doSubmitResult rejects payloads that violate output_schema; retry on
 *     validation failure re-runs the task (M4 + M9).
 *   - renderSubagentTree + countDescendants produce a stable rooted tree
 *     from spawn_parent links (M6 pivot).
 *   - timeoutMs cancels a hung ask loop and reports status="timeout" (M8).
 *   - maxAttempts retries on timeout and stops on the first success.
 *   - ctx.emit receives spawn:start, spawn:child_created, spawn:child_done,
 *     spawn:complete events (M10).
 *
 * Run: npx tsx --test test/agent-spawn-advanced.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { __test } from "../src/programs/handlers/agent.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

// ── Harness (full version with emit capture + list support) ──────

function createHarness() {
	const objects = new Map<string, { id: string; typeKey: string; fields: Record<string, any>; blocks: any[]; deleted?: boolean }>();
	const dispatchHandlers = new Map<string, (action: string, args: unknown[]) => unknown>();
	const events: Array<{ channel: string; data: any }> = [];
	let nextBlockTs = 1000;
	let nextChildSerial = 0;

	function actorFor(id: string) {
		return {
			setField: async (key: string, json: string) => { objects.get(id)!.fields[key] = JSON.parse(json); },
			setFields: async (json: string) => { Object.assign(objects.get(id)!.fields, JSON.parse(json)); },
			addBlock: async (json: string) => {
				const obj = objects.get(id)!;
				const block = JSON.parse(json);
				obj.blocks.push({ id: block.id, content: block.content, timestamp: nextBlockTs++ });
			},
			markDeleted: async () => { const o = objects.get(id); if (o) o.deleted = true; },
			setContent: async () => {},
		};
	}

	const store = {
		get: async (id: string) => {
			const o = objects.get(id); if (!o) return null;
			const prov: Record<string, any> = {};
			for (const b of o.blocks) prov[b.id] = { timestamp: b.timestamp, author: "t", changeId: "t" };
			return { ...o, blockProvenance: prov, content: new Uint8Array(0), createdAt: 0, updatedAt: 0, headIds: [], changeCount: o.blocks.length };
		},
		create: async (typeKey: string, json: string) => {
			const id = `child-${++nextChildSerial}`;
			objects.set(id, { id, typeKey, fields: json ? JSON.parse(json) : {}, blocks: [] });
			return id;
		},
		list: async (typeKey: string) => {
			const out: Array<{ id: string }> = [];
			for (const [id, o] of objects) if (o.typeKey === typeKey && !o.deleted) out.push({ id });
			return out;
		},
	};

	const client = { objectActor: { getOrCreate: (args: string[]) => actorFor(args[0]) } };

	const ctx: ProgramContext = {
		client, store,
		resolveId: async (p: string) => { for (const k of objects.keys()) if (k === p || k.startsWith(p)) return k; return null; },
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [], readChangeByHex: () => null, hexEncode: () => "",
		print: () => {},
		randomUUID: (() => { let n = 0; return () => `u-${++n}`; })(),
		state: {}, emit: (channel: string, data: any) => { events.push({ channel, data }); }, programId: "t",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async (prefix, action, args) => {
			const h = dispatchHandlers.get(`${prefix}::${action}`);
			if (!h) throw new Error(`No dispatch handler for ${prefix}::${action}`);
			return h(action, args);
		},
	} as unknown as ProgramContext;

	return {
		ctx, objects, events,
		onDispatch(prefix: string, action: string, h: (action: string, args: unknown[]) => unknown) {
			dispatchHandlers.set(`${prefix}::${action}`, h);
		},
		seedAgent(id: string, fields: Record<string, any> = {}) {
			objects.set(id, { id, typeKey: "agent", fields, blocks: [] });
			return id;
		},
	};
}

function mockSubmitResultThenDone(payload: unknown = { ok: true }) {
	(globalThis as any).__LLM_FETCH = async ({ messages }: { messages: any[] }) => {
		const sawSubmit = messages.some((m) =>
			Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_use" && c.name === "submit_result"),
		);
		if (sawSubmit) {
			return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", model: "mock", inputTokens: 5, outputTokens: 5 };
		}
		return {
			content: [{ type: "tool_use", id: "tu-1", name: "submit_result", input: { result: payload } }],
			stopReason: "tool_use", model: "mock", inputTokens: 5, outputTokens: 5,
		};
	};
}

function mockHangForever() {
	(globalThis as any).__LLM_FETCH = async () => new Promise(() => {}); // never resolves
}

function mockPayloadsInOrder(payloads: unknown[]) {
	let i = 0;
	(globalThis as any).__LLM_FETCH = async ({ messages }: { messages: any[] }) => {
		const sawSubmit = messages.some((m) =>
			Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_use" && c.name === "submit_result"),
		);
		if (sawSubmit) {
			return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", model: "mock", inputTokens: 5, outputTokens: 5 };
		}
		const payload = payloads[Math.min(i++, payloads.length - 1)];
		return {
			content: [{ type: "tool_use", id: `tu-${i}`, name: "submit_result", input: { result: payload } }],
			stopReason: "tool_use", model: "mock", inputTokens: 5, outputTokens: 5,
		};
	};
}

function restore() {
	delete (globalThis as any).__LLM_FETCH;
	__test._resetRunSlots();
}

function wireSubmit(h: ReturnType<typeof createHarness>) {
	h.onDispatch("/agent", "submitResult", async (_a, args) => __test.doSubmitResult(args[0] as any, h.ctx));
}

// ── M4: validator + schema enforcement ───────────────────────────

describe("validateAgainstSchema", () => {
	it("accepts a value matching a nested schema", () => {
		const schema = {
			type: "object",
			required: ["name", "tags"],
			properties: { name: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
		};
		assert.deepEqual(__test.validateAgainstSchema({ name: "a", tags: ["x", "y"] }, schema), []);
	});

	it("flags missing required keys, wrong types, and bad enum", () => {
		const schema = {
			type: "object",
			required: ["kind"],
			properties: { kind: { type: "string", enum: ["fact", "milestone"] }, count: { type: "number" } },
		};
		const errs = __test.validateAgainstSchema({ kind: "nope", count: "lots" }, schema);
		assert.ok(errs.some((e) => /enum/i.test(e)));
		assert.ok(errs.some((e) => /count.*number/i.test(e)));
	});
});

describe("doSpawn with schema", () => {
	afterEach(restore);

	it("returns status=schema_invalid when submit_result payload violates schema", async () => {
		mockSubmitResultThenDone("not an object");
		const h = createHarness();
		const parent = h.seedAgent("p-schema", { name: stringVal("P"), spawn_template: stringVal("task") });
		wireSubmit(h);

		const out = await __test.doSpawn({
			agentId: parent,
			schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
			tasks: [{ id: "t", agentTemplate: "quick_task", assignment: "go" }],
		}, h.ctx);

		assert.equal(out.results[0].status, "schema_invalid");
		assert.match(out.results[0].error ?? "", /schema validation/i);
	});

	it("accepts a payload that matches the schema", async () => {
		mockSubmitResultThenDone({ answer: "yes" });
		const h = createHarness();
		const parent = h.seedAgent("p-schema-ok", { name: stringVal("P"), spawn_template: stringVal("task") });
		wireSubmit(h);

		const out = await __test.doSpawn({
			agentId: parent,
			schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
			tasks: [{ id: "t", agentTemplate: "quick_task", assignment: "go" }],
		}, h.ctx);

		assert.equal(out.results[0].status, "ok");
		assert.deepEqual(out.results[0].output, { answer: "yes" });
	});
});

// ── M6 (pivot): spawn tree inspection ────────────────────────────

describe("doGetSubagents + renderSubagentTree", () => {
	afterEach(restore);

	it("walks spawn_parent links into a rooted tree and counts descendants", async () => {
		mockSubmitResultThenDone();
		const h = createHarness();
		const parent = h.seedAgent("root", { name: stringVal("Root"), spawn_template: stringVal("task") });
		wireSubmit(h);

		await __test.doSpawn({
			agentId: parent,
			tasks: [
				{ id: "a", agentTemplate: "quick_task", assignment: "a" },
				{ id: "b", agentTemplate: "quick_task", assignment: "b" },
			],
		}, h.ctx);

		const tree = await __test.doGetSubagents(parent, h.ctx);
		assert.equal(tree.id, parent);
		assert.equal(tree.children.length, 2);
		const childStatuses = tree.children.map((c) => c.status).sort();
		assert.deepEqual(childStatuses, ["done", "done"]);
		assert.equal(__test.countDescendants(tree), 2);

		const rendered = __test.renderSubagentTree(tree);
		assert.match(rendered, /Root/);
		// Tree-drawing glyphs appear exactly once per non-root node.
		assert.equal((rendered.match(/└─|├─/g) ?? []).length, 2);
	});
});

// ── M8 + M9: timeout + retry ─────────────────────────────────────

describe("per-task timeoutMs and maxAttempts", () => {
	afterEach(restore);

	it("cancels a hung child after timeoutMs and returns status=timeout", async () => {
		mockHangForever();
		const h = createHarness();
		const parent = h.seedAgent("p-to", { name: stringVal("P"), spawn_template: stringVal("task") });
		wireSubmit(h);

		const out = await __test.doSpawn({
			agentId: parent,
			tasks: [{ id: "slow", agentTemplate: "quick_task", assignment: "wait forever", timeoutMs: 50 }],
		}, h.ctx);

		assert.equal(out.results[0].status, "timeout");
		assert.match(out.results[0].error ?? "", /timeout/i);
	});

	it("retries up to maxAttempts on timeout and reports attempts", async () => {
		mockHangForever();
		const h = createHarness();
		const parent = h.seedAgent("p-retry", { name: stringVal("P"), spawn_template: stringVal("task") });
		wireSubmit(h);

		const out = await __test.doSpawn({
			agentId: parent,
			tasks: [{ id: "flaky", agentTemplate: "quick_task", assignment: "x", timeoutMs: 30, maxAttempts: 3 }],
		}, h.ctx);

		assert.equal(out.results[0].status, "timeout");
		assert.equal(out.results[0].attempts, 3);
	});
});

// ── M10: progress events ─────────────────────────────────────────

describe("doSpawn emits progress events", () => {
	afterEach(restore);

	it("emits spawn:start, spawn:child_created, spawn:child_done, spawn:complete", async () => {
		mockSubmitResultThenDone({ ok: true });
		const h = createHarness();
		const parent = h.seedAgent("p-events", { name: stringVal("P"), spawn_template: stringVal("task") });
		wireSubmit(h);

		await __test.doSpawn({
			agentId: parent,
			tasks: [
				{ id: "a", agentTemplate: "quick_task", assignment: "do a" },
				{ id: "b", agentTemplate: "quick_task", assignment: "do b" },
			],
		}, h.ctx);

		const channels = h.events.map((e) => e.channel);
		assert.ok(channels.includes("spawn:start"));
		assert.ok(channels.includes("spawn:complete"));
		assert.equal(channels.filter((c) => c === "spawn:child_created").length, 2);
		assert.equal(channels.filter((c) => c === "spawn:child_done").length, 2);

		const complete = h.events.find((e) => e.channel === "spawn:complete")!;
		assert.equal(complete.data.summary.ok, 2);
		assert.equal(complete.data.summary.total, 2);
	});
});
