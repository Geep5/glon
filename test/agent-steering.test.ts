/**
 * Agent steering tests.
 *
 * Covers the per-agent run coordinator: when a second `ask` arrives while
 * a model run for the same agent is already in flight, it must NOT spawn
 * a parallel inference. Instead the second caller becomes a "steerer":
 * their user prompt is committed to the DAG immediately, but their
 * promise resolves only after the runner's loop has produced an
 * assistant response addressing them.
 *
 * Scenarios:
 *   1. Sequential asks: baseline — no coordination engaged.
 *   2. Concurrent asks (no tools): runner + steerer; both resolve with
 *      the right slice of assistant text, one model call per question.
 *   3. Steer during a tool loop: second ask lands while the runner is
 *      mid-tool-dispatch; the next iteration's rebuild from DAG picks
 *      up the steered user_text and the model addresses both.
 *   4. Co-drained steerers (two steerers, one model call): both get the
 *      same slice — that's correct, one response addressed both.
 *
 * Run: npx tsx --test test/agent-steering.test.ts
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import agentProgram from "../src/programs/handlers/agent.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

// ── Sequenced Anthropic mock ─────────────────────────────────────
//
// Each model call gets a numbered slot. The test resolves slots
// out-of-band so it can interleave new asks between the runner's
// model calls.

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: any) => void;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void;
	let reject!: (e: any) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

interface MockResponse {
	content: any[];
	stopReason?: string;
}

function mockAnthropicSequenced() {
	const responses: Deferred<{ content: any[]; stopReason: string; model: string; inputTokens: number; outputTokens: number }>[] = [];
	const startedSignals: Deferred<void>[] = [];
	let nextIndex = 0;

	function ensureSlot(i: number) {
		if (!responses[i]) responses[i] = deferred();
		if (!startedSignals[i]) startedSignals[i] = deferred();
	}

	(globalThis as any).__LLM_FETCH = async () => {
		const i = nextIndex++;
		ensureSlot(i);
		startedSignals[i].resolve();
		return await responses[i].promise;
	};

	return {
		/** Resolve model call `i` with the given response. */
		resolveCall(i: number, r: MockResponse) {
			ensureSlot(i);
			const stopReason = r.stopReason ?? (r.content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn");
			responses[i].resolve({
				content: r.content,
				stopReason,
				model: "test-model",
				inputTokens: 10,
				outputTokens: 20,
			});
		},
		/** Wait for the runner to begin model call `i`. */
		waitForCall(i: number): Promise<void> {
			ensureSlot(i);
			return startedSignals[i].promise;
		},
		/** How many model calls have started so far. */
		callsStarted(): number {
			return nextIndex;
		},
	};
}

function restoreAnthropic() {
	delete (globalThis as any).__LLM_FETCH;
}

// ── In-memory agent harness ──────────────────────────────────────
//
// Mirrors test/agent-tooluse.test.ts. Keeps actor.addBlock and store.get
// honest so buildConversationView sees the same blocks the runner wrote.

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
	const dispatchHandlers = new Map<string, (action: string, args: unknown[]) => unknown | Promise<unknown>>();

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
			setContent: async (_: string) => { /* unused */ },
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

	let uuidCounter = 0;
	const ctx: ProgramContext = {
		client,
		store,
		resolveId: async (prefix: string) => {
			for (const k of objects.keys()) if (k === prefix || k.startsWith(prefix)) return k;
			return null;
		},
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		randomUUID: () => `uuid-${++uuidCounter}`,
		state: {},
		emit: () => {},
		programId: "test-agent-program",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async (prefix, action, args) => {
			const handler = dispatchHandlers.get(`${prefix}::${action}`);
			if (!handler) throw new Error(`No dispatch handler for ${prefix}::${action}`);
			return await handler(action, args);
		},
	} as ProgramContext;

	return {
		ctx,
		objects,
		seedAgent(id: string, fields: Record<string, any> = {}) {
			objects.set(id, { id, typeKey: "agent", fields, blocks: [] });
			return id;
		},
		onDispatch(prefix: string, action: string, h: (action: string, args: unknown[]) => unknown | Promise<unknown>) {
			dispatchHandlers.set(`${prefix}::${action}`, h);
		},
	};
}

// ── Tests ────────────────────────────────────────────────────────

const ask = agentProgram.actor!.actions!.ask as (
	ctx: ProgramContext,
	agentId: string,
	prompt: string,
) => Promise<{ finalText: string; iterations: number; toolCalls: number; inputTokens: number; outputTokens: number }>;

describe("agent steering", () => {
	afterEach(restoreAnthropic);

	it("sequential asks: each is a fresh runner, no coordination engaged", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-seq", { model: stringVal("test-model") });

		const m = mockAnthropicSequenced();
		m.resolveCall(0, { content: [{ type: "text", text: "first reply" }] });
		const r1 = await ask(h.ctx, agentId, "first prompt");
		assert.equal(r1.finalText, "first reply");

		m.resolveCall(1, { content: [{ type: "text", text: "second reply" }] });
		const r2 = await ask(h.ctx, agentId, "second prompt");
		assert.equal(r2.finalText, "second reply");

		// DAG: [user1, asst1, user2, asst2]
		const blocks = h.objects.get(agentId)!.blocks;
		assert.equal(blocks.length, 4);
		assert.equal(blocks[0].content.text.text, "first prompt");
		assert.equal(blocks[1].content.text.text, "first reply");
		assert.equal(blocks[2].content.text.text, "second prompt");
		assert.equal(blocks[3].content.text.text, "second reply");
	});

	it("concurrent asks (no tools): runner + steerer, two model calls, correct slices", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-concurrent", { model: stringVal("test-model") });

		const m = mockAnthropicSequenced();

		// Kick off the runner.
		const askA = ask(h.ctx, agentId, "question A");

		// Wait until the runner has actually started its first model call —
		// only then is slot.running set, so a second ask becomes a steerer.
		await m.waitForCall(0);

		// Second ask while the model call is in flight.
		const askB = ask(h.ctx, agentId, "question B");

		// Let askB's addBlock land on the actor before we resolve call 0.
		// The harness's addBlock is synchronous-ish (a microtask), so a
		// short tick is enough.
		await new Promise((r) => setImmediate(r));

		// Resolve the runner's call 0. It produced no tools, so the loop
		// will rebuild messages including question B and call the model again.
		m.resolveCall(0, { content: [{ type: "text", text: "answer to A" }] });

		// Wait for call 1, then resolve it addressing B.
		await m.waitForCall(1);
		m.resolveCall(1, { content: [{ type: "text", text: "answer to B" }] });

		const [rA, rB] = await Promise.all([askA, askB]);

		assert.equal(rA.finalText, "answer to A", "A's slice = first assistant text after A's user block");
		assert.equal(rB.finalText, "answer to B", "B's slice = next assistant text after B's user block");

		// DAG commit order reflects real-time writes:
		//   userA -> userB (added during call 0) -> asstA -> asstB.
		// The model's view (via the runner's incremental messages array)
		// preserves true conversational order: userA, asstA, userB, asstB.
		const blocks = h.objects.get(agentId)!.blocks;
		const texts = blocks.map((b) => b.content.text.text);
		assert.deepEqual(texts, ["question A", "question B", "answer to A", "answer to B"]);

		// Exactly two model calls — no parallel inference.
		assert.equal(m.callsStarted(), 2);
	});

	it("steer during tool loop: second ask incorporated at next iteration", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-tools", { model: stringVal("test-model") });

		// Register a tool.
		const register = agentProgram.actor!.actions!.registerTool;
		await register(h.ctx, agentId, JSON.stringify({
			name: "echo",
			description: "echo input",
			input_schema: { type: "object" },
			target_prefix: "/echo",
			target_action: "go",
		}));

		// Tool dispatch is held until we manually release it, simulating a
		// slow tool that lets a steerer arrive mid-flight.
		const toolGate = deferred<void>();
		h.onDispatch("/echo", "go", async () => {
			await toolGate.promise;
			return "echo result";
		});

		const m = mockAnthropicSequenced();

		const askA = ask(h.ctx, agentId, "do the work");

		// Round 1: model emits tool_use.
		await m.waitForCall(0);
		m.resolveCall(0, {
			content: [
				{ type: "text", text: "running echo" },
				{ type: "tool_use", id: "tu_1", name: "echo", input: { x: 1 } },
			],
			stopReason: "tool_use",
		});

		// Wait until the runner has begun dispatching the tool. The tool
		// is gated, so the runner is now blocked inside dispatchProgram.
		// Yield enough microtasks for it to enqueue the dispatch.
		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

		// Steer in B while the tool is running.
		const askB = ask(h.ctx, agentId, "also do this");
		await new Promise((r) => setImmediate(r));

		// Release the tool.
		toolGate.resolve();

		// Round 2: model now sees user A, assistant text+tool_use,
		// user (tool_result + question B). Final text addresses both.
		await m.waitForCall(1);
		m.resolveCall(1, {
			content: [{ type: "text", text: "done. and here is B's answer." }],
		});

		const [rA, rB] = await Promise.all([askA, askB]);

		// A's slice walks from A's user block. Next assistant_text is
		// "running echo". Then the next user_text (B's prompt) — stop.
		// So A gets "running echo".
		assert.equal(rA.finalText, "running echo");

		// B's slice walks from B's user block. Next assistant text is
		// "done. and here is B's answer.".
		assert.equal(rB.finalText, "done. and here is B's answer.");

		// Exactly two model calls.
		assert.equal(m.callsStarted(), 2);

		// DAG includes B's user_text after the tool_result.
		const blocks = h.objects.get(agentId)!.blocks;
		const ids = blocks.map((b) => {
			if (b.content.text) return `${b.content.text.style === 1 ? "asst" : "user"}:${b.content.text.text}`;
			if (b.content.custom?.contentType === "tool_use") return `tu:${b.content.custom.meta.tool_name}`;
			if (b.content.custom?.contentType === "tool_result") return `tr:${b.content.custom.meta.content}`;
			return "?";
		});
		// Order reflects real-time commits: userA, asst, tu (call 0), then userB
		// (steered during tool dispatch, before tr commits), tr, asstFinal.
		assert.deepEqual(ids, [
			"user:do the work",
			"asst:running echo",
			"tu:echo",
			"user:also do this",
			"tr:echo result",
			"asst:done. and here is B's answer.",
		]);
	});

	it("co-drained steerers share the same response slice", async () => {
		const h = createTestHarness();
		const agentId = h.seedAgent("agent-codrained", { model: stringVal("test-model") });

		const m = mockAnthropicSequenced();

		const askA = ask(h.ctx, agentId, "first");
		await m.waitForCall(0);

		// Both B and C arrive before the runner's first model call resolves.
		// They become steerers on the same slot.
		const askB = ask(h.ctx, agentId, "second");
		const askC = ask(h.ctx, agentId, "third");
		await new Promise((r) => setImmediate(r));

		// Round 0 returns the original answer to A.
		m.resolveCall(0, { content: [{ type: "text", text: "answer to A" }] });

		// Round 1: rebuild from DAG includes A, asstA, B, C as user blocks.
		// buildConversationView's groupIntoTurns concatenates B and C into
		// one user turn (the model sees them as one batched user message).
		// The model produces one reply addressing both.
		await m.waitForCall(1);
		m.resolveCall(1, { content: [{ type: "text", text: "answer to B and C" }] });

		const [rA, rB, rC] = await Promise.all([askA, askB, askC]);

		assert.equal(rA.finalText, "answer to A");
		// B and C share the same slice — both walked past their co-drained
		// peer's user_text and stopped at the same assistant_text.
		assert.equal(rB.finalText, "answer to B and C");
		assert.equal(rC.finalText, "answer to B and C");

		// Two model calls, not three.
		assert.equal(m.callsStarted(), 2);
	});
});
