/**
 * Subagent spawning tests (M1).
 *
 * Covers:
 *   - resolveAgentTemplate falls back to BUILTIN_TEMPLATES when store.list
 *     is unavailable / no override exists.
 *   - doSpawn creates a child agent with spawn_parent / spawn_depth /
 *     spawn_template fields, runs an ask loop on it, and returns the
 *     child's submit_result payload as SingleResult.output.
 *   - Parallel batch: three children, all reach status:"ok".
 *   - Depth cap: parent already at max depth refuses to spawn.
 *   - submit_result fallback: when a child finishes without calling the
 *     tool, the parent gets status:"no_submit_result" + final assistant
 *     text as output.
 *
 * Mocks Anthropic via globalThis.__LLM_FETCH and stubs the program
 * dispatcher so the child's submit_result tool routes to the real
 * doSubmitResult helper exported from the program.
 *
 * Run: npx tsx --test test/agent-spawn.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import agentProgram, { __test } from "../src/programs/handlers/agent.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

// ── In-memory harness (mirrors agent-tooluse.test.ts) ────────────

interface StoredBlock { id: string; content: any; timestamp: number; }
interface StoredAgent {
	id: string;
	typeKey: string;
	fields: Record<string, any>;
	blocks: StoredBlock[];
	deleted?: boolean;
}

function createHarness() {
	const objects = new Map<string, StoredAgent>();
	const dispatchHandlers = new Map<string, (action: string, args: unknown[]) => unknown>();
	let nextBlockTs = 1000;
	let nextChildSerial = 0;

	function actorFor(id: string) {
		return {
			setField: async (key: string, valueJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`actor.setField: no object ${id}`);
				obj.fields[key] = JSON.parse(valueJson);
			},
			setFields: async (fieldsJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`actor.setFields: no object ${id}`);
				Object.assign(obj.fields, JSON.parse(fieldsJson));
			},
			addBlock: async (blockJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`actor.addBlock: no object ${id}`);
				const block = JSON.parse(blockJson);
				obj.blocks.push({ id: block.id, content: block.content, timestamp: nextBlockTs++ });
			},
			markDeleted: async () => { const obj = objects.get(id); if (obj) obj.deleted = true; },
			setContent: async () => { /* unused */ },
		};
	}

	const store = {
		get: async (id: string) => {
			const obj = objects.get(id);
			if (!obj) return null;
			const provenance: Record<string, any> = {};
			for (const b of obj.blocks) provenance[b.id] = { timestamp: b.timestamp, author: "test", changeId: "test" };
			return {
				id, typeKey: obj.typeKey, fields: obj.fields, blocks: obj.blocks,
				blockProvenance: provenance, content: new Uint8Array(0), deleted: !!obj.deleted,
				createdAt: 0, updatedAt: 0, headIds: [], changeCount: obj.blocks.length,
			};
		},
		create: async (typeKey: string, fieldsJson: string) => {
			const id = `child-${++nextChildSerial}`;
			objects.set(id, { id, typeKey, fields: fieldsJson ? JSON.parse(fieldsJson) : {}, blocks: [] });
			return id;
		},
	};

	const client = { objectActor: { getOrCreate: (args: string[]) => actorFor(args[0]) } };

	const ctx: ProgramContext = {
		client, store,
		resolveId: async (prefix: string) => {
			for (const k of objects.keys()) if (k === prefix || k.startsWith(prefix)) return k;
			return null;
		},
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [], readChangeByHex: () => null, hexEncode: () => "",
		print: () => {},
		randomUUID: (() => { let n = 0; return () => `uuid-${++n}`; })(),
		state: {}, emit: () => {}, programId: "test-agent-program",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async (prefix, action, args) => {
			const key = `${prefix}::${action}`;
			const handler = dispatchHandlers.get(key);
			if (!handler) throw new Error(`No dispatch handler for ${key}`);
			return handler(action, args);
		},
	} as unknown as ProgramContext;

	return {
		ctx, objects,
		onDispatch(prefix: string, action: string, handler: (action: string, args: unknown[]) => unknown) {
			dispatchHandlers.set(`${prefix}::${action}`, handler);
		},
		seedAgent(id: string, fields: Record<string, any> = {}) {
			objects.set(id, { id, typeKey: "agent", fields, blocks: [] });
			return id;
		},
	};
}

// Mock that lets each ask loop converge in 2 iterations: first call →
// tool_use(submit_result, {result: ...}); second call → final text "done".
function mockSubmitResultThenDone(payload: unknown = { ok: true, hello: "world" }) {
	let toolCounter = 0;
	(globalThis as any).__LLM_FETCH = async ({ messages }: { messages: any[] }) => {
		const sawSubmit = messages.some((m) =>
			Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_use" && c.name === "submit_result"),
		);
		if (sawSubmit) {
			return { content: [{ type: "text", text: "done" }], stopReason: "end_turn", model: "mock", inputTokens: 5, outputTokens: 5 };
		}
		toolCounter++;
		return {
			content: [{ type: "tool_use", id: `tu-${toolCounter}`, name: "submit_result", input: { result: payload } }],
			stopReason: "tool_use", model: "mock", inputTokens: 5, outputTokens: 5,
		};
	};
}

function mockNoSubmitResult() {
	(globalThis as any).__LLM_FETCH = async () => ({
		content: [{ type: "text", text: "I forgot to submit." }],
		stopReason: "end_turn", model: "mock", inputTokens: 4, outputTokens: 4,
	});
}

function restoreAnthropic() { delete (globalThis as any).__LLM_FETCH; }

// Wires the child's submit_result dispatch back to the real handler so the
// fully-real tool path is exercised end-to-end.
function wireSubmitResult(h: ReturnType<typeof createHarness>) {
	h.onDispatch("/agent", "submitResult", async (_a, args) => {
		return await __test.doSubmitResult(args[0] as any, h.ctx);
	});
}

// ── Tests ────────────────────────────────────────────────────────

describe("resolveAgentTemplate", () => {
	it("falls back to BUILTIN_TEMPLATES when store has no override", async () => {
		const h = createHarness();
		const tpl = await __test.resolveAgentTemplate("task", h.ctx);
		assert.equal(tpl.name, "task");
		assert.equal(tpl.spawns, "*");
		assert.match(tpl.system, /general-purpose/i);
	});

	it("throws on unknown template name", async () => {
		const h = createHarness();
		await assert.rejects(() => __test.resolveAgentTemplate("nonsense", h.ctx), /unknown agent template/i);
	});
});

describe("doSpawn — single child", () => {
	beforeEach(() => mockSubmitResultThenDone({ summary: "child finished" }));
	afterEach(restoreAnthropic);

	it("creates a child, runs it, and returns its submit_result payload", async () => {
		const h = createHarness();
		const parentId = h.seedAgent("parent-1", { name: stringVal("Parent"), spawn_template: stringVal("task") });
		wireSubmitResult(h);

		const out = await __test.doSpawn({
			agentId: parentId,
			tasks: [{ id: "t1", agentTemplate: "explore", assignment: "look at things" }],
		}, h.ctx);

		assert.equal(out.results.length, 1);
		const r = out.results[0];
		assert.equal(r.status, "ok");
		assert.equal(r.id, "t1");
		assert.equal(r.childAgentId, out.childAgentIds[0]);
		assert.deepEqual(r.output, { summary: "child finished" });

		const child = h.objects.get(r.childAgentId)!;
		assert.equal(child.typeKey, "agent");
		assert.equal(child.fields.spawn_template?.stringValue, "explore");
		assert.equal(child.fields.spawn_task_id?.stringValue, "t1");
		assert.equal(child.fields.spawn_depth?.stringValue, "1");
		assert.equal(child.fields.spawn_parent?.linkValue?.targetId, parentId);
		assert.equal(child.fields.submitted_result?.stringValue, JSON.stringify({ summary: "child finished" }));
	});
});

describe("doSpawn — parallel batch", () => {
	beforeEach(() => mockSubmitResultThenDone({ ok: true }));
	afterEach(restoreAnthropic);

	it("spawns three children concurrently and returns one result per task", async () => {
		const h = createHarness();
		const parentId = h.seedAgent("parent-2", { name: stringVal("Parent"), spawn_template: stringVal("task") });
		wireSubmitResult(h);

		const out = await __test.doSpawn({
			agentId: parentId,
			tasks: [
				{ id: "a", agentTemplate: "quick_task", assignment: "do A" },
				{ id: "b", agentTemplate: "quick_task", assignment: "do B" },
				{ id: "c", agentTemplate: "quick_task", assignment: "do C" },
			],
		}, h.ctx);

		assert.equal(out.results.length, 3);
		assert.equal(out.childAgentIds.length, 3);
		const ids = out.results.map((r) => r.id).sort();
		assert.deepEqual(ids, ["a", "b", "c"]);
		for (const r of out.results) {
			assert.equal(r.status, "ok", `task ${r.id}: ${r.error ?? ""}`);
			assert.deepEqual(r.output, { ok: true });
		}
	});
});

describe("doSpawn — depth cap", () => {
	beforeEach(() => mockSubmitResultThenDone());
	afterEach(restoreAnthropic);

	it("rejects when parent is already at GLON_AGENT_MAX_DEPTH", async () => {
		const h = createHarness();
		const cap = __test.maxSpawnDepth();
		const parentId = h.seedAgent("parent-cap", {
			name: stringVal("AtCap"),
			spawn_depth: stringVal(String(cap)),
		});
		await assert.rejects(
			() => __test.doSpawn({ agentId: parentId, tasks: [{ id: "x", agentTemplate: "task", assignment: "go" }] }, h.ctx),
			/max depth/i,
		);
	});

	it("rejects when parent template forbids spawning", async () => {
		const h = createHarness();
		// explore has spawns="" — cannot delegate.
		const parentId = h.seedAgent("parent-explore", {
			name: stringVal("Explorer"),
			spawn_template: stringVal("explore"),
		});
		await assert.rejects(
			() => __test.doSpawn({ agentId: parentId, tasks: [{ id: "x", agentTemplate: "task", assignment: "go" }] }, h.ctx),
			/not allowed to spawn/i,
		);
	});
});

describe("doSpawn — submit_result fallback", () => {
	beforeEach(() => mockNoSubmitResult());
	afterEach(restoreAnthropic);

	it("returns status no_submit_result with the final assistant text", async () => {
		const h = createHarness();
		const parentId = h.seedAgent("parent-3", { name: stringVal("Parent"), spawn_template: stringVal("task") });
		wireSubmitResult(h);

		const out = await __test.doSpawn({
			agentId: parentId,
			tasks: [{ id: "lazy", agentTemplate: "explore", assignment: "be lazy" }],
		}, h.ctx);

		assert.equal(out.results.length, 1);
		const r = out.results[0];
		assert.equal(r.status, "no_submit_result");
		assert.equal(r.output, "I forgot to submit.");
		assert.match(r.error ?? "", /without calling submit_result/i);
	});
});

describe("doCancel", () => {
	it("sets cancel_requested on the agent", async () => {
		const h = createHarness();
		h.seedAgent("cancel-me");
		await __test.doCancel("cancel-me", h.ctx);
		assert.equal(h.objects.get("cancel-me")!.fields.cancel_requested?.stringValue, "true");
	});
});
