/**
 * runAsk follow-up loop tests.
 *
 * Covers the outer follow-up loop in runAsk: after the model produces a
 * "would-stop" turn, the harness can re-prompt by injecting a new user
 * block, driving the agent past its natural termination.
 *
 * Scenarios:
 *   1. No follow-up hook: behaviour unchanged from the no-hook baseline.
 *   2. Hook returns null: agent stops normally; followUpAttempts === 0.
 *   3. Hook returns text once, then null: one follow-up turn fires; the
 *      follow-up text is committed as a user_text block on the agent's
 *      DAG; metrics aggregate across both runLoop calls; finalText reflects
 *      the model's last response (not the first).
 *   4. Hook returns text repeatedly until its own cap: the harness drives
 *      the cap'd number of follow-ups and stops; user blocks accumulate
 *      in the DAG.
 *   5. Hook throws: error is swallowed, ask returns the pre-throw aggregate.
 *   6. mergeAskResults: counter sums, flag ORs, finalText fallback.
 *
 * Mocks Anthropic via globalThis.__LLM_FETCH; in-memory store/actor
 * matches the pattern in test/agent-tooluse.test.ts.
 *
 * Run: npx tsx --test test/agent-followup.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import agentProgram, { __test, type FollowUpHook } from "../src/programs/handlers/agent.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

const { runAsk, mergeAskResults, _resetRunSlots } = __test;

// ── In-memory harness (mirrors test/agent-tooluse.test.ts) ───────

interface StoredBlock { id: string; content: any; timestamp: number }
interface StoredAgent { id: string; typeKey: string; fields: Record<string, any>; blocks: StoredBlock[] }

function createTestHarness() {
	const objects = new Map<string, StoredAgent>();
	let nextBlockTs = 1000;

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
				deleted: false,
				createdAt: 0,
				updatedAt: 0,
				headIds: [],
				changeCount: obj.blocks.length,
			};
		},
		create: async (typeKey: string, fieldsJson: string) => {
			const id = `obj-${objects.size + 1}`;
			objects.set(id, { id, typeKey, fields: fieldsJson ? JSON.parse(fieldsJson) : {}, blocks: [] });
			return id;
		},
		list: async () => [],
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
		dispatchProgram: async () => { throw new Error("no dispatch handlers wired"); },
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

// ── mergeAskResults ──────────────────────────────────────────────

describe("mergeAskResults", () => {
	const base = {
		finalText: "first",
		iterations: 1,
		toolCalls: 0,
		inputTokens: 10,
		outputTokens: 20,
		compactedBeforeAsk: false,
		compactedOnOverflow: false,
		followUpAttempts: 0,
	};

	it("sums counters and ORs flags", () => {
		const a = { ...base, iterations: 2, toolCalls: 1, inputTokens: 100, outputTokens: 50, compactedBeforeAsk: true };
		const b = { ...base, iterations: 3, toolCalls: 2, inputTokens: 200, outputTokens: 75, compactedOnOverflow: true };
		const merged = mergeAskResults(a, b);
		assert.equal(merged.iterations, 5);
		assert.equal(merged.toolCalls, 3);
		assert.equal(merged.inputTokens, 300);
		assert.equal(merged.outputTokens, 125);
		assert.equal(merged.compactedBeforeAsk, true);
		assert.equal(merged.compactedOnOverflow, true);
	});

	it("prefers b.finalText when non-empty (latest wins)", () => {
		const a = { ...base, finalText: "first response" };
		const b = { ...base, finalText: "second response" };
		assert.equal(mergeAskResults(a, b).finalText, "second response");
	});

	it("falls back to a.finalText when b.finalText is empty", () => {
		const a = { ...base, finalText: "early answer" };
		const b = { ...base, finalText: "" };
		assert.equal(mergeAskResults(a, b).finalText, "early answer");
	});

	it("sums followUpAttempts", () => {
		const a = { ...base, followUpAttempts: 2 };
		const b = { ...base, followUpAttempts: 1 };
		assert.equal(mergeAskResults(a, b).followUpAttempts, 3);
	});
});

// ── runAsk follow-up loop ────────────────────────────────────────

describe("runAsk follow-up loop", () => {
	beforeEach(restoreAnthropic);
	afterEach(restoreAnthropic);

	it("baseline: no hook, single model call, followUpAttempts=0", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		const m = mockAnthropic([
			{ content: [{ type: "text", text: "hello" }] },
		]);

		const result = await runAsk(agentId, "hi", h.ctx);
		assert.equal(result.finalText, "hello");
		assert.equal(result.followUpAttempts, 0);
		assert.equal(m.callsMade(), 1);
		assert.deepEqual(h.userBlocks(agentId), ["hi"]);
		assert.deepEqual(h.assistantBlocks(agentId), ["hello"]);
	});

	it("hook returning null: behaviour identical to no hook", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		mockAnthropic([
			{ content: [{ type: "text", text: "hello" }] },
		]);

		let hookCalls = 0;
		const hook: FollowUpHook = async () => { hookCalls++; return null; };
		const result = await runAsk(agentId, "hi", h.ctx, { followUpHook: hook });
		assert.equal(hookCalls, 1, "hook should be consulted exactly once at the would-stop boundary");
		assert.equal(result.followUpAttempts, 0);
		assert.equal(result.finalText, "hello");
	});

	it("hook returns text once: drives one follow-up turn, commits user block, aggregates", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		mockAnthropic([
			{ content: [{ type: "text", text: "first answer" }] },
			{ content: [{ type: "text", text: "follow-up answer" }] },
		]);

		let hookCalls = 0;
		const hook: FollowUpHook = async ({ attempt }) => {
			hookCalls++;
			if (attempt === 0) return { text: "<system-reminder>finish your work</system-reminder>" };
			return null;
		};

		const result = await runAsk(agentId, "do work", h.ctx, { followUpHook: hook });

		assert.equal(hookCalls, 2, "hook called after each runLoop");
		assert.equal(result.followUpAttempts, 1);
		assert.equal(result.finalText, "follow-up answer", "finalText is the latest response");
		// Aggregated counters: 2 model calls × (10/20 tokens, 1 iteration each).
		assert.equal(result.iterations, 2);
		assert.equal(result.inputTokens, 20);
		assert.equal(result.outputTokens, 40);

		// DAG: original user prompt + reminder injection committed as user blocks.
		assert.deepEqual(h.userBlocks(agentId), [
			"do work",
			"<system-reminder>finish your work</system-reminder>",
		]);
		assert.deepEqual(h.assistantBlocks(agentId), ["first answer", "follow-up answer"]);
	});

	it("hook drives multiple follow-ups until it returns null", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		mockAnthropic([
			{ content: [{ type: "text", text: "a1" }] },
			{ content: [{ type: "text", text: "a2" }] },
			{ content: [{ type: "text", text: "a3" }] },
			{ content: [{ type: "text", text: "a4" }] },
		]);

		// Hook fires 3 times, then signals done.
		const hook: FollowUpHook = async ({ attempt }) => {
			if (attempt < 3) return { text: `reminder-${attempt}` };
			return null;
		};

		const result = await runAsk(agentId, "go", h.ctx, { followUpHook: hook });
		assert.equal(result.followUpAttempts, 3);
		assert.equal(result.finalText, "a4");
		assert.deepEqual(h.userBlocks(agentId), ["go", "reminder-0", "reminder-1", "reminder-2"]);
	});

	it("hook returning empty text is treated as no follow-up", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		mockAnthropic([
			{ content: [{ type: "text", text: "done" }] },
		]);
		const hook: FollowUpHook = async () => ({ text: "" });
		const result = await runAsk(agentId, "go", h.ctx, { followUpHook: hook });
		assert.equal(result.followUpAttempts, 0);
		assert.equal(result.finalText, "done");
	});

	it("throwing hook is contained — ask returns the pre-throw aggregate", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");
		mockAnthropic([
			{ content: [{ type: "text", text: "first" }] },
		]);
		const hook: FollowUpHook = async () => { throw new Error("boom"); };
		const result = await runAsk(agentId, "go", h.ctx, { followUpHook: hook });
		assert.equal(result.followUpAttempts, 0);
		assert.equal(result.finalText, "first");
	});

	it("follow-up turns drive another tool-use loop end-to-end", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");

		// Seed a tool so the model can dispatch on follow-up.
		const register = agentProgram.actor!.actions!.registerTool;
		await register(h.ctx, agentId, JSON.stringify({
			name: "noop",
			description: "no-op tool",
			input_schema: { type: "object" },
			target_prefix: "/p",
			target_action: "noop",
		}));
		// Wire the dispatch handler.
		(h.ctx as any).dispatchProgram = async (prefix: string, action: string) => {
			if (prefix === "/p" && action === "noop") return "ok";
			throw new Error(`unhandled ${prefix}::${action}`);
		};

		mockAnthropic([
			{ content: [{ type: "text", text: "initial answer" }] },
			// On follow-up: tool_use, then a text response.
			{ content: [{ type: "tool_use", id: "tu-1", name: "noop", input: {} }] },
			{ content: [{ type: "text", text: "after tool" }] },
		]);

		let calls = 0;
		const hook: FollowUpHook = async () => {
			calls++;
			return calls === 1 ? { text: "keep going" } : null;
		};

		const result = await runAsk(agentId, "go", h.ctx, { followUpHook: hook });
		assert.equal(result.followUpAttempts, 1);
		assert.equal(result.toolCalls, 1, "tool call inside follow-up turn is counted");
		assert.equal(result.finalText, "after tool");
		assert.equal(result.iterations, 3, "1 baseline + 2 (tool_use + text) inside follow-up");
	});
});
