/**
 * Integration: /agent + /todo + makeTodoFollowUpHook together.
 *
 * Verifies the full mechanism the OMP analysis recommended:
 *   - The model starts a task with todos, marks one in_progress, calls
 *     `todo_write` to record the plan.
 *   - The model emits a "would-stop" turn while items are still pending.
 *   - The follow-up hook detects incomplete items via /todo.incomplete
 *     and injects a <system-reminder> turn.
 *   - The agent re-enters the loop, the model marks the work complete,
 *     and on the next would-stop the hook returns null (everything done).
 *   - The cap (max=2 reminders) terminates an otherwise-infinite loop
 *     when the model never marks anything complete.
 *
 * Wires /todo's actor.actions through the test harness's dispatchProgram
 * so the hook can call /todo.incomplete and todo_write can call /todo.write.
 *
 * Run: npx tsx --test test/agent-todo-followup.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import agentProgram, { __test as agentTest, makeTodoFollowUpHook } from "../src/programs/handlers/agent.js";
import todoProgram, { todoWriteToolSpec } from "../src/programs/handlers/todo.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

const { runAsk, _resetRunSlots } = agentTest;

// ── In-memory harness with /todo dispatch wired ──────────────────

interface StoredBlock { id: string; content: any; timestamp: number }
interface StoredObj { id: string; typeKey: string; fields: Record<string, any>; blocks: StoredBlock[]; deleted?: boolean }

function createTestHarness() {
	const objects = new Map<string, StoredObj>();
	let nextBlockTs = 1000;
	let nextObjId = 1;

	function actorFor(id: string) {
		return {
			setField: async (key: string, valueJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`actor.setField: no object ${id}`);
				obj.fields[key] = JSON.parse(valueJson);
			},
			addBlock: async (blockJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`actor.addBlock: no object ${id}`);
				const block = JSON.parse(blockJson);
				obj.blocks.push({ id: block.id, content: block.content, timestamp: nextBlockTs++ });
			},
			setContent: async () => {},
			setFields: async (fieldsJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`actor.setFields: no object ${id}`);
				Object.assign(obj.fields, JSON.parse(fieldsJson));
			},
			markDeleted: async () => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`actor.markDeleted: no object ${id}`);
				obj.deleted = true;
			},
		};
	}

	const store = {
		get: async (id: string) => {
			const obj = objects.get(id);
			if (!obj) return null;
			const provenance: Record<string, { timestamp: number; author: string; changeId: string }> = {};
			for (const b of obj.blocks) {
				provenance[b.id] = { timestamp: b.timestamp, author: "test", changeId: "test" };
			}
			return {
				id,
				typeKey: obj.typeKey,
				fields: obj.fields,
				blocks: obj.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content })),
				blockProvenance: provenance,
				content: "",
				deleted: obj.deleted ?? false,
				createdAt: 0,
				updatedAt: 0,
				headIds: [],
				changeCount: obj.blocks.length,
			};
		},
		create: async (typeKey: string, fieldsJson: string) => {
			const id = `obj-${nextObjId++}`;
			objects.set(id, { id, typeKey, fields: fieldsJson ? JSON.parse(fieldsJson) : {}, blocks: [] });
			return id;
		},
		list: async (typeKey?: string) => {
			const out: { id: string; typeKey: string }[] = [];
			for (const [id, obj] of objects) {
				if (obj.deleted) continue;
				if (typeKey && obj.typeKey !== typeKey) continue;
				out.push({ id, typeKey: obj.typeKey });
			}
			return out;
		},
	};

	const client = {
		objectActor: { getOrCreate: (args: string[]) => actorFor(args[0]) },
	};

	const ctx: ProgramContext = {
		client, store,
		resolveId: async (prefix: string) => {
			for (const k of objects.keys()) {
				if (k === prefix || k.startsWith(prefix)) return k;
			}
			return null;
		},
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		randomUUID: (() => {
			let n = 0;
			return () => `uuid-${++n}`;
		})(),
		state: {},
		emit: () => {},
		programId: "test-agent-program",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async (prefix: string, action: string, args: unknown[]) => {
			// Wire /todo's actor.actions for real, exercising the same code
			// the hook + tool dispatch will hit at runtime.
			if (prefix === "/todo") {
				const handler = todoProgram.actor?.actions?.[action];
				if (!handler) throw new Error(`/todo has no action ${action}`);
				return await handler(ctx, ...args);
			}
			throw new Error(`unhandled dispatch ${prefix}::${action}`);
		},
	};

	return {
		ctx, objects,
		seedAgent(id: string, fields: Record<string, any> = {}) {
			objects.set(id, { id, typeKey: "agent", fields, blocks: [] });
			return id;
		},
		userBlocks(agentId: string) {
			const obj = objects.get(agentId);
			if (!obj) return [];
			return obj.blocks
				.filter((b) => b.content?.text && (b.content.text.style ?? 0) === 0)
				.map((b) => b.content.text.text as string);
		},
		assistantBlocks(agentId: string) {
			const obj = objects.get(agentId);
			if (!obj) return [];
			return obj.blocks
				.filter((b) => b.content?.text && b.content.text.style === 1)
				.map((b) => b.content.text.text as string);
		},
	};
}

function mockAnthropic(responses: Array<{ content: any[]; stopReason?: string }>) {
	let i = 0;
	(globalThis as any).__LLM_FETCH = async () => {
		if (i >= responses.length) throw new Error(`Mock Anthropic exhausted (called ${i + 1}x)`);
		const r = responses[i++];
		return {
			content: r.content,
			stopReason: r.stopReason ?? (r.content.some((c: any) => c.type === "tool_use") ? "tool_use" : "end_turn"),
			model: "test-model",
			inputTokens: 10,
			outputTokens: 20,
		};
	};
	return { callsMade: () => i };
}

function restoreAnthropic() {
	delete (globalThis as any).__LLM_FETCH;
	_resetRunSlots();
}

// Register the todo_write tool on the agent.
async function wireTodoTool(agentId: string, ctx: ProgramContext) {
	const spec = todoWriteToolSpec(agentId);
	const register = agentProgram.actor!.actions!.registerTool!;
	await register(ctx, agentId, JSON.stringify(spec));
}

// ── Tests ────────────────────────────────────────────────────────

describe("/agent + /todo follow-up integration", () => {
	beforeEach(restoreAnthropic);
	afterEach(restoreAnthropic);

	it("model writes todos, stops with one in_progress, hook re-prompts, model completes, hook returns null", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		await wireTodoTool(agentId, h.ctx);

		// Model script:
		//   1. Initial: write a 2-task list (replace) and answer briefly.
		//   2. Follow-up #1 (after reminder): mark task-1 completed; task-2 auto-promotes; answer.
		//   3. Follow-up #2 (after reminder): mark task-2 completed; answer "all done".
		mockAnthropic([
			{
				content: [
					{
						type: "tool_use", id: "tu-1", name: "todo_write",
						input: {
							ops: [{
								op: "replace",
								phases: [{ name: "Build", tasks: [{ content: "Step 1" }, { content: "Step 2" }] }],
							}],
						},
					},
				],
			},
			{ content: [{ type: "text", text: "starting" }] },
			{
				content: [
					{
						type: "tool_use", id: "tu-2", name: "todo_write",
						input: { ops: [{ op: "update", id: "task-1", status: "completed" }] },
					},
				],
			},
			{ content: [{ type: "text", text: "step 1 done" }] },
			{
				content: [
					{
						type: "tool_use", id: "tu-3", name: "todo_write",
						input: { ops: [{ op: "update", id: "task-2", status: "completed" }] },
					},
				],
			},
			{ content: [{ type: "text", text: "all done" }] },
		]);

		const hook = makeTodoFollowUpHook({ maxAttempts: 5 });
		const result = await runAsk(agentId, "build the thing", h.ctx, { followUpHook: hook });

		assert.equal(result.followUpAttempts, 2, "two reminders fired");
		assert.equal(result.finalText, "all done");
		assert.equal(result.toolCalls, 3, "three todo_write dispatches");

		// User blocks: original prompt + 2 system reminders.
		const users = h.userBlocks(agentId);
		assert.equal(users.length, 3);
		assert.equal(users[0], "build the thing");
		assert.match(users[1], /<system-reminder>/);
		assert.match(users[1], /Step 1/);
		assert.match(users[2], /<system-reminder>/);
		assert.match(users[2], /Step 2/);

		// /todo state: both tasks completed.
		const incomplete = await todoProgram.actor!.actions!.incomplete!(h.ctx, "agent-1") as { total: number };
		assert.equal(incomplete.total, 0);
	});

	it("hook returns null immediately when no todos exist", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		mockAnthropic([
			{ content: [{ type: "text", text: "hello" }] },
		]);
		const hook = makeTodoFollowUpHook();
		const result = await runAsk(agentId, "hi", h.ctx, { followUpHook: hook });
		assert.equal(result.followUpAttempts, 0);
		assert.equal(result.finalText, "hello");
	});

	it("hook returns null when only completed tasks remain", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		await wireTodoTool(agentId, h.ctx);

		// Pre-seed a completed-only list directly via the action.
		await todoProgram.actor!.actions!.write!(h.ctx, {
			owner: agentId,
			ops: [{ op: "replace", phases: [{ name: "P", tasks: [{ content: "x", status: "completed" }] }] }],
		});

		mockAnthropic([
			{ content: [{ type: "text", text: "all good" }] },
		]);
		const hook = makeTodoFollowUpHook();
		const result = await runAsk(agentId, "go", h.ctx, { followUpHook: hook });
		assert.equal(result.followUpAttempts, 0);
		assert.equal(result.finalText, "all good");
	});

	it("respects maxAttempts cap when the model never completes anything", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		await wireTodoTool(agentId, h.ctx);

		// Pre-seed a list with a single pending task; the model just acks each turn.
		await todoProgram.actor!.actions!.write!(h.ctx, {
			owner: agentId,
			ops: [{ op: "replace", phases: [{ name: "Stuck", tasks: [{ content: "Never done" }] }] }],
		});

		// 3 model calls: original + 2 reminders. Each just answers without writing todos.
		mockAnthropic([
			{ content: [{ type: "text", text: "ok" }] },
			{ content: [{ type: "text", text: "still ok" }] },
			{ content: [{ type: "text", text: "yet still ok" }] },
		]);

		const hook = makeTodoFollowUpHook({ maxAttempts: 2 });
		const result = await runAsk(agentId, "do it", h.ctx, { followUpHook: hook });
		assert.equal(result.followUpAttempts, 2, "exactly maxAttempts reminders");

		// The pending task is still pending — the cap protects us against
		// runaway grinding when the model can't or won't complete.
		const incomplete = await todoProgram.actor!.actions!.incomplete!(h.ctx, agentId) as { total: number };
		assert.equal(incomplete.total, 1);
	});

	it("a fresh prompt resets the follow-up budget", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		await wireTodoTool(agentId, h.ctx);

		await todoProgram.actor!.actions!.write!(h.ctx, {
			owner: agentId,
			ops: [{ op: "replace", phases: [{ name: "P", tasks: [{ content: "Task A" }] }] }],
		});

		// First ask: pending task triggers two reminders, both ineffective.
		mockAnthropic([
			{ content: [{ type: "text", text: "1a" }] },
			{ content: [{ type: "text", text: "1b" }] },
			{ content: [{ type: "text", text: "1c" }] },
		]);
		const r1 = await runAsk(agentId, "first", h.ctx, { followUpHook: makeTodoFollowUpHook({ maxAttempts: 2 }) });
		assert.equal(r1.followUpAttempts, 2);

		// Second ask uses a fresh hook (capping is per-hook, the hook is per-ask).
		// The pending task still exists, so the same reminder pattern fires again.
		mockAnthropic([
			{ content: [{ type: "text", text: "2a" }] },
			{ content: [{ type: "text", text: "2b" }] },
			{ content: [{ type: "text", text: "2c" }] },
		]);
		const r2 = await runAsk(agentId, "second", h.ctx, { followUpHook: makeTodoFollowUpHook({ maxAttempts: 2 }) });
		assert.equal(r2.followUpAttempts, 2, "budget resets per ask");
	});

	it("graceful no-op when /todo is not loaded", async () => {
		const h = createTestHarness();
		// Disable the /todo route to simulate a deployment without /todo.
		(h.ctx as any).dispatchProgram = async () => { throw new Error("not loaded"); };
		const agentId = h.seedAgent("agent-1");

		mockAnthropic([
			{ content: [{ type: "text", text: "hi" }] },
		]);
		const result = await runAsk(agentId, "go", h.ctx, { followUpHook: makeTodoFollowUpHook() });
		assert.equal(result.followUpAttempts, 0);
		assert.equal(result.finalText, "hi");
	});

	it("agent.ask action accepts {followUp: {kind: 'todo'}} and drives reminders", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		await wireTodoTool(agentId, h.ctx);

		await todoProgram.actor!.actions!.write!(h.ctx, {
			owner: agentId,
			ops: [{ op: "replace", phases: [{ name: "P", tasks: [{ content: "T" }] }] }],
		});

		mockAnthropic([
			{ content: [{ type: "text", text: "x" }] },
			{ content: [{ type: "text", text: "y" }] },
		]);

		const ask = agentProgram.actor!.actions!.ask!;
		const result = await ask(h.ctx, agentId, "go", { followUp: { kind: "todo", max: 1 } }) as { followUpAttempts: number };
		assert.equal(result.followUpAttempts, 1);
	});

	it("agent.ask action with no opts uses no follow-up by default (back-compat)", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		await wireTodoTool(agentId, h.ctx);

		await todoProgram.actor!.actions!.write!(h.ctx, {
			owner: agentId,
			ops: [{ op: "replace", phases: [{ name: "P", tasks: [{ content: "T" }] }] }],
		});

		mockAnthropic([
			{ content: [{ type: "text", text: "answer" }] },
		]);

		const ask = agentProgram.actor!.actions!.ask!;
		// No opts → no follow-up hook → existing behaviour.
		const result = await ask(h.ctx, agentId, "go") as { followUpAttempts: number };
		assert.equal(result.followUpAttempts, 0);
	});
});
