/**
 * Agent tool-use tests.
 *
 * Covers:
 *   - Tool registration: writes a properly-shaped ValueMap to the agent's `tools` field
 *   - Tool listing: round-trips registered tools
 *   - Tool-use loop: dispatches tool calls, persists tool_use/tool_result blocks,
 *     returns final text
 *   - Unknown tool: produces an is_error tool_result, loop continues
 *   - Iteration cap: throws when the model never stops calling tools
 *   - extractTurns: rebuilds Anthropic-shaped messages from mixed blocks
 *
 * Mocks Anthropic via `globalThis.__LLM_FETCH`; stubs the store/actor
 * with a minimal in-memory harness.
 *
 * Run: npx tsx --test test/agent-tooluse.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import agentProgram from "../src/programs/handlers/agent.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

// ── In-memory store/actor stub ───────────────────────────────────

interface StoredBlock {
	id: string;
	content: any;
	timestamp: number;
}

interface StoredAgent {
	id: string;
	typeKey: string;
	fields: Record<string, any>;
	blocks: StoredBlock[];
}

function createTestHarness() {
	const objects = new Map<string, StoredAgent>();
	const dispatchCalls: { prefix: string; action: string; args: unknown[] }[] = [];
	const dispatchHandlers = new Map<string, (action: string, args: unknown[]) => unknown>();

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
			setContent: async (_: string) => { /* not used in these tests */ },
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
	};

	const client = {
		objectActor: {
			getOrCreate: (args: string[]) => actorFor(args[0]),
		},
	};

	const ctx: ProgramContext = {
		client,
		store,
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
		dispatchProgram: async (prefix, action, args) => {
			dispatchCalls.push({ prefix, action, args });
			const key = `${prefix}::${action}`;
			const handler = dispatchHandlers.get(key);
			if (!handler) throw new Error(`No dispatch handler for ${key}`);
			return handler(action, args);
		},
	};

	return {
		ctx,
		objects,
		dispatchCalls,
		onDispatch(prefix: string, action: string, handler: (action: string, args: unknown[]) => unknown) {
			dispatchHandlers.set(`${prefix}::${action}`, handler);
		},
		seedAgent(id: string, fields: Record<string, any> = {}) {
			objects.set(id, { id, typeKey: "agent", fields, blocks: [] });
			return id;
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
}

function restoreAnthropic() {
	delete (globalThis as any).__LLM_FETCH;
}

// ── Tests ────────────────────────────────────────────────────────

describe("agent tool registration", () => {
	afterEach(restoreAnthropic);

	it("registerTool writes a properly-shaped ValueMap to the agent's tools field", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-1");

		const register = agentProgram.actor!.actions!.registerTool;
		await register(h.ctx, agentId, JSON.stringify({
			name: "calendar_list",
			description: "List calendar events",
			input_schema: { type: "object", properties: { range: { type: "string" } } },
			target_prefix: "/calendar",
			target_action: "list",
		}));

		const obj = h.objects.get(agentId)!;
		const tools = obj.fields.tools;
		assert.ok(tools?.mapValue?.entries?.calendar_list, "tools.calendar_list should exist");
		const inner = tools.mapValue.entries.calendar_list.mapValue.entries;
		assert.equal(inner.description.stringValue, "List calendar events");
		assert.equal(inner.target_prefix.stringValue, "/calendar");
		assert.equal(inner.target_action.stringValue, "list");
		const schema = JSON.parse(inner.input_schema.stringValue);
		assert.equal(schema.type, "object");
		assert.ok(schema.properties?.range);
	});

	it("listTools round-trips registered tools", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-2");

		const register = agentProgram.actor!.actions!.registerTool;
		const listTools = agentProgram.actor!.actions!.listTools;

		await register(h.ctx, agentId, JSON.stringify({
			name: "a", description: "", input_schema: { type: "object" },
			target_prefix: "/p1", target_action: "x",
		}));
		await register(h.ctx, agentId, JSON.stringify({
			name: "b", description: "", input_schema: { type: "object" },
			target_prefix: "/p2", target_action: "y",
		}));

		const tools = await listTools(h.ctx, agentId) as Array<{ name: string; target_prefix: string }>;
		assert.equal(tools.length, 2);
		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["a", "b"]);
	});

	it("re-registering a tool by name replaces the prior spec", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-3");

		const register = agentProgram.actor!.actions!.registerTool;
		const listTools = agentProgram.actor!.actions!.listTools;

		await register(h.ctx, agentId, {
			name: "t", description: "first", input_schema: { type: "object" },
			target_prefix: "/old", target_action: "old",
		});
		await register(h.ctx, agentId, {
			name: "t", description: "second", input_schema: { type: "object" },
			target_prefix: "/new", target_action: "new",
		});

		const tools = await listTools(h.ctx, agentId) as Array<{ name: string; target_prefix: string; description: string }>;
		assert.equal(tools.length, 1);
		assert.equal(tools[0].target_prefix, "/new");
		assert.equal(tools[0].description, "second");
	});

	it("unregisterTool removes a tool", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-4");

		const register = agentProgram.actor!.actions!.registerTool;
		const unregister = agentProgram.actor!.actions!.unregisterTool;
		const listTools = agentProgram.actor!.actions!.listTools;

		await register(h.ctx, agentId, {
			name: "keep", description: "", input_schema: { type: "object" },
			target_prefix: "/p", target_action: "k",
		});
		await register(h.ctx, agentId, {
			name: "drop", description: "", input_schema: { type: "object" },
			target_prefix: "/p", target_action: "d",
		});
		await unregister(h.ctx, agentId, "drop");

		const tools = await listTools(h.ctx, agentId) as Array<{ name: string }>;
		assert.equal(tools.length, 1);
		assert.equal(tools[0].name, "keep");
	});

	it("registerTool rejects non-agent objects", async () => {
		const h = createTestHarness();
		// object with wrong type
		h.objects.set("not-agent", { id: "not-agent", typeKey: "chat", fields: {}, blocks: [] });

		const register = agentProgram.actor!.actions!.registerTool;
		await assert.rejects(
			() => register(h.ctx, "not-agent", {
				name: "x", description: "", input_schema: { type: "object" },
				target_prefix: "/p", target_action: "a",
			}),
			/not an agent/,
		);
	});
});

describe("agent tool-use loop", () => {
	afterEach(restoreAnthropic);

	it("dispatches a tool, persists tool_use/tool_result blocks, returns final text", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-5", {
			model: stringVal("test-model"),
			system: stringVal("You are a test agent."),
		});

		const register = agentProgram.actor!.actions!.registerTool;
		await register(h.ctx, agentId, {
			name: "weather",
			description: "Get the weather",
			input_schema: { type: "object", properties: { city: { type: "string" } } },
			target_prefix: "/weather",
			target_action: "get",
		});

		h.onDispatch("/weather", "get", (_action, args) => {
			const input = args[0] as { city: string };
			return `The weather in ${input.city} is sunny, 72°F.`;
		});

		// Round 1: model calls the tool. Round 2: model responds with final text.
		mockAnthropic([
			{
				content: [
					{ type: "text", text: "Let me check." },
					{ type: "tool_use", id: "tu_1", name: "weather", input: { city: "SF" } },
				],
				stopReason: "tool_use",
			},
			{
				content: [{ type: "text", text: "It's sunny and 72°F in SF." }],
				stopReason: "end_turn",
			},
		]);

		const ask = agentProgram.actor!.actions!.ask;
		const result = await ask(h.ctx, agentId, "What's the weather in SF?") as {
			finalText: string; iterations: number; toolCalls: number;
		};

		assert.equal(result.finalText, "It's sunny and 72°F in SF.");
		assert.equal(result.iterations, 2);
		assert.equal(result.toolCalls, 1);

		// Dispatch was called once with the model's input.
		assert.equal(h.dispatchCalls.length, 1);
		assert.equal(h.dispatchCalls[0].prefix, "/weather");
		assert.equal(h.dispatchCalls[0].action, "get");
		assert.deepEqual(h.dispatchCalls[0].args[0], { city: "SF" });

		// Block sequence in the DAG:
		//   1. user text "What's the weather in SF?"
		//   2. assistant text "Let me check."
		//   3. tool_use block for tu_1
		//   4. tool_result block for tu_1
		//   5. assistant text "It's sunny and 72°F in SF."
		const blocks = h.objects.get(agentId)!.blocks;
		assert.equal(blocks.length, 5);
		assert.equal(blocks[0].content.text.text, "What's the weather in SF?");
		assert.equal(blocks[0].content.text.style, 0);
		assert.equal(blocks[1].content.text.text, "Let me check.");
		assert.equal(blocks[1].content.text.style, 1);
		assert.equal(blocks[2].content.custom.contentType, "tool_use");
		assert.equal(blocks[2].content.custom.meta.tool_name, "weather");
		assert.equal(blocks[2].content.custom.meta.tool_use_id, "tu_1");
		assert.deepEqual(JSON.parse(blocks[2].content.custom.meta.input), { city: "SF" });
		assert.equal(blocks[3].content.custom.contentType, "tool_result");
		assert.equal(blocks[3].content.custom.meta.tool_use_id, "tu_1");
		assert.match(blocks[3].content.custom.meta.content, /sunny, 72°F/);
		assert.equal(blocks[3].content.custom.meta.is_error, "false");
		assert.equal(blocks[4].content.text.text, "It's sunny and 72°F in SF.");
	});

	it("unknown tool name produces is_error=true tool_result and loop continues", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-6", { model: stringVal("test-model") });

		// No tools registered — the model tries to use one anyway.
		mockAnthropic([
			{ content: [{ type: "tool_use", id: "tu_bad", name: "nope", input: {} }] },
			{ content: [{ type: "text", text: "Sorry, can't do that." }] },
		]);

		const ask = agentProgram.actor!.actions!.ask;
		const result = await ask(h.ctx, agentId, "Use nope") as { finalText: string };
		assert.equal(result.finalText, "Sorry, can't do that.");

		const blocks = h.objects.get(agentId)!.blocks;
		const toolResult = blocks.find((b) => b.content?.custom?.contentType === "tool_result");
		assert.ok(toolResult, "should write a tool_result block for the failed dispatch");
		assert.equal(toolResult!.content.custom.meta.is_error, "true");
		assert.match(toolResult!.content.custom.meta.content, /not registered/);
	});

	it("iteration cap throws when tools never stop", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-7", { model: stringVal("test-model"), max_tool_iterations: stringVal("5") });
		const register = agentProgram.actor!.actions!.registerTool;
		await register(h.ctx, agentId, {
			name: "loop", description: "", input_schema: { type: "object" },
			target_prefix: "/loop", target_action: "go",
		});
		h.onDispatch("/loop", "go", () => "keep going");

		// Always return a tool_use — should trip the iteration cap.
		(globalThis as any).__LLM_FETCH = async () => ({
			content: [{ type: "tool_use", id: "tu_x", name: "loop", input: {} }],
			stopReason: "tool_use",
			model: "test-model",
			inputTokens: 1,
			outputTokens: 1,
		});

		const ask = agentProgram.actor!.actions!.ask;
		await assert.rejects(
			() => ask(h.ctx, agentId, "go forever"),
			/exceeded 5 iterations/,
		);
	});

	it("dispatch failure surfaces as is_error tool_result without crashing the loop", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-8", { model: stringVal("test-model") });
		const register = agentProgram.actor!.actions!.registerTool;
		await register(h.ctx, agentId, {
			name: "flaky", description: "", input_schema: { type: "object" },
			target_prefix: "/flaky", target_action: "run",
		});
		h.onDispatch("/flaky", "run", () => { throw new Error("oops"); });

		mockAnthropic([
			{ content: [{ type: "tool_use", id: "tu_f", name: "flaky", input: {} }] },
			{ content: [{ type: "text", text: "Recovered." }] },
		]);

		const ask = agentProgram.actor!.actions!.ask;
		const result = await ask(h.ctx, agentId, "try flaky") as { finalText: string };
		assert.equal(result.finalText, "Recovered.");

		const tr = h.objects.get(agentId)!.blocks.find((b) => b.content?.custom?.contentType === "tool_result");
		assert.ok(tr);
		assert.equal(tr!.content.custom.meta.is_error, "true");
		assert.match(tr!.content.custom.meta.content, /oops/);
	});

	it("second ask sees prior tool_use/tool_result as conversation history", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-9", { model: stringVal("test-model") });
		const register = agentProgram.actor!.actions!.registerTool;
		await register(h.ctx, agentId, {
			name: "echo", description: "", input_schema: { type: "object" },
			target_prefix: "/echo", target_action: "say",
		});
		h.onDispatch("/echo", "say", (_action, args) => JSON.stringify(args[0]));

		// First ask runs a tool cycle.
		mockAnthropic([
			{ content: [{ type: "tool_use", id: "tu_a", name: "echo", input: { v: 1 } }] },
			{ content: [{ type: "text", text: "Done one." }] },
		]);

		const ask = agentProgram.actor!.actions!.ask;
		await ask(h.ctx, agentId, "call echo");

		// Second ask: capture the messages the mock sees.
		let seenMessages: any[] = [];
		(globalThis as any).__LLM_FETCH = async (req: { messages: any[] }) => {
			seenMessages = req.messages;
			return {
				content: [{ type: "text", text: "Done two." }],
				stopReason: "end_turn",
				model: "test-model",
				inputTokens: 1,
				outputTokens: 1,
			};
		};

		await ask(h.ctx, agentId, "anything else?");

		// The messages should include the prior user turn, assistant tool_use,
		// user tool_result, and the new user prompt.
		assert.ok(seenMessages.length >= 4, `expected >=4 messages, got ${seenMessages.length}`);
		const assistantTurn = seenMessages.find((m) => m.role === "assistant" && Array.isArray(m.content));
		assert.ok(assistantTurn, "should have an assistant turn with tool_use content");
		const toolUseItem = assistantTurn.content.find((c: any) => c.type === "tool_use");
		assert.ok(toolUseItem);
		assert.equal(toolUseItem.name, "echo");

		const userToolResultTurn = seenMessages.find(
			(m) => m.role === "user" && Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"),
		);
		assert.ok(userToolResultTurn, "should have a user turn carrying tool_result");
	});
});
