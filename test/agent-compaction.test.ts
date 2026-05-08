/**
 * Agent compaction tests.
 *
 * Covers the pure helpers (estimator, classify, findLatestCompaction,
 * filterToKept, groupIntoTurns, buildConversationView, findCutIndex,
 * buildEffectiveSystem, isContextOverflowError) and the integrated
 * flows (doCompact writes a well-formed summary block; runAsk auto-
 * compacts over threshold; overflow error triggers a retry; iterative
 * compaction supersedes an older summary).
 *
 * Run: npx tsx --test test/agent-compaction.test.ts
 */

import { describe, it, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import agentProgram, { estimateTokens, __test } from "../src/programs/handlers/agent.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import type { ProgramContext } from "../src/programs/runtime.js";

// ── Helpers ──────────────────────────────────────────────────────

function restoreAnthropic() {
	delete (globalThis as any).__LLM_FETCH;
}

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
	deleted: boolean;
}

function createHarness() {
	const objects = new Map<string, StoredAgent>();
	let nextBlockTs = 1000;
	let nextId = 1;

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
			addBlock: async (blockJson: string) => {
				const obj = objects.get(id);
				if (!obj) throw new Error(`no object ${id}`);
				const block = JSON.parse(blockJson);
				obj.blocks.push({ id: block.id, content: block.content, timestamp: nextBlockTs++ });
			},
			markDeleted: async () => {
				const obj = objects.get(id);
				if (obj) obj.deleted = true;
			},
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
				id,
				typeKey: obj.typeKey,
				fields: obj.fields,
				blocks: obj.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content })),
				blockProvenance: provenance,
				deleted: obj.deleted,
				content: "",
				createdAt: 0,
				updatedAt: 0,
				headIds: [],
				changeCount: obj.blocks.length,
			};
		},
		create: async (typeKey: string, fieldsJson: string) => {
			const id = `obj-${nextId++}`;
			objects.set(id, {
				id, typeKey,
				fields: fieldsJson ? JSON.parse(fieldsJson) : {},
				blocks: [],
				deleted: false,
			});
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

	const dispatchHandlers = new Map<string, (args: unknown[]) => unknown>();

	const ctx: ProgramContext = {
		client, store,
		resolveId: async (p: string) => {
			for (const k of objects.keys()) if (k === p || k.startsWith(p)) return k;
			return null;
		},
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles: () => [],
		readChangeByHex: () => null,
		hexEncode: () => "",
		print: () => {},
		randomUUID: () => `uuid-${nextId++}`,
		state: {},
		emit: () => {},
		programId: "test-agent-program",
		objectActor: (id: string) => actorFor(id),
		dispatchProgram: async (prefix, action, args) => {
			const key = `${prefix}::${action}`;
			const handler = dispatchHandlers.get(key);
			if (!handler) throw new Error(`no dispatch handler ${key}`);
			return handler(args);
		},
	};

	return {
		ctx, objects,
		onDispatch(prefix: string, action: string, handler: (args: unknown[]) => unknown) {
			dispatchHandlers.set(`${prefix}::${action}`, handler);
		},
		seedAgent(fields: Record<string, any> = {}) {
			const id = `agent-${nextId++}`;
			objects.set(id, { id, typeKey: "agent", fields, blocks: [], deleted: false });
			return id;
		},
		seedBlocks(agentId: string, blocks: Array<{ id?: string; content: any }>): string[] {
			const obj = objects.get(agentId)!;
			const created: string[] = [];
			for (const b of blocks) {
				const id = b.id ?? `block-${nextId++}`;
				obj.blocks.push({ id, content: b.content, timestamp: nextBlockTs++ });
				created.push(id);
			}
			return created;
		},
	};
}

function userText(text: string) { return { text: { text, style: 0 } }; }
function assistantText(text: string) { return { text: { text, style: 1 } }; }
function toolUseCustom(toolUseId: string, name: string, input: Record<string, unknown>) {
	return {
		custom: {
			contentType: "tool_use",
			data: "",
			meta: { tool_use_id: toolUseId, tool_name: name, input: JSON.stringify(input) },
		},
	};
}
function toolResultCustom(toolUseId: string, content: string, isError = false) {
	return {
		custom: {
			contentType: "tool_result",
			data: "",
			meta: { tool_use_id: toolUseId, content, is_error: isError ? "true" : "false" },
		},
	};
}
function compactionCustom(summary: string, firstKeptBlockId: string, tokensBefore = 0, turnCount = 0) {
	return {
		custom: {
			contentType: "compaction_summary",
			data: "",
			meta: {
				summary,
				first_kept_block_id: firstKeptBlockId,
				tokens_before: String(tokensBefore),
				turn_count: String(turnCount),
				created_at: String(Date.now()),
			},
		},
	};
}

// ── estimator ────────────────────────────────────────────────────

describe("estimateTokens", () => {
	it("estimates text length / CHARS_PER_TOKEN for strings", () => {
		const R = __test.CHARS_PER_TOKEN;
		assert.equal(estimateTokens("hello world"), Math.ceil(11 / R));
		assert.equal(estimateTokens(""), 0);
	});

	it("sums across content arrays with tool blocks weighted", () => {
		const R = __test.CHARS_PER_TOKEN;
		const content = [
			{ type: "text" as const, text: "abc" },
			{ type: "tool_use" as const, id: "x", name: "calc", input: { a: 1 } },
			{ type: "tool_result" as const, tool_use_id: "x", content: "result body" },
		];
		const total = estimateTokens(content);
		const expected =
			Math.ceil(3 / R) +
			Math.ceil(("calc" + JSON.stringify({ a: 1 })).length / R) +
			Math.ceil("result body".length / R);
		assert.equal(total, expected);
	});
});

// ── classify + buildConversationView ─────────────────────────────

describe("classifyBlocks + buildConversationView", () => {
	it("classifies every block kind and emits a clean turn list when no compaction exists", () => {
		const h = createHarness();
		const id = h.seedAgent();
		const ids = h.seedBlocks(id, [
			{ content: userText("hi") },
			{ content: assistantText("hey!") },
			{ content: toolUseCustom("tu_1", "echo", { v: 1 }) },
			{ content: toolResultCustom("tu_1", "1") },
			{ content: assistantText("done") },
		]);
		const obj = h.objects.get(id)!;
		const storeBlocks = obj.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content }));
		const provenance = Object.fromEntries(obj.blocks.map((b) => [b.id, { timestamp: b.timestamp, author: "t", changeId: "c" }]));

		const items = __test.classifyBlocks(storeBlocks, provenance);
		assert.equal(items.length, 5);
		assert.deepEqual(items.map((i) => i.kind), ["user_text", "assistant_text", "tool_use", "tool_result", "assistant_text"]);

		const view = __test.buildConversationView(storeBlocks, provenance);
		assert.equal(view.systemExtension, undefined);
		assert.equal(view.latestCompaction, null);
		assert.equal(view.turns.length, 4);
		assert.equal(view.turns[0].role, "user");
		assert.equal(view.turns[1].role, "assistant");
		assert.equal(view.turns[2].role, "user");
		assert.equal(view.turns[3].role, "assistant");
		void ids;
	});

	it("honours the latest compaction block: summary becomes systemExtension, pre-cut blocks are dropped", () => {
		const h = createHarness();
		const id = h.seedAgent();
		const [u1, , u2, a2] = h.seedBlocks(id, [
			{ content: userText("first") },
			{ content: assistantText("ans1") },
			{ content: userText("second") },
			{ content: assistantText("ans2") },
		]);
		// Compaction block: first kept is u2, summary replaces u1/a1
		h.seedBlocks(id, [
			{ content: compactionCustom("SUMMARY-A", u2, 100, 1) },
		]);

		const obj = h.objects.get(id)!;
		const storeBlocks = obj.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content }));
		const provenance = Object.fromEntries(obj.blocks.map((b) => [b.id, { timestamp: b.timestamp, author: "t", changeId: "c" }]));
		const view = __test.buildConversationView(storeBlocks, provenance);

		assert.equal(view.systemExtension, "SUMMARY-A");
		assert.equal(view.latestCompaction?.summary, "SUMMARY-A");
		// Kept turns are just u2 + a2.
		assert.equal(view.turns.length, 2);
		assert.equal(view.turns[0].content, "second");
		assert.equal(view.turns[1].content, "ans2");
		void u1; void a2;
	});

	it("latest compaction wins when multiple exist", () => {
		const h = createHarness();
		const id = h.seedAgent();
		const ids = h.seedBlocks(id, [
			{ content: userText("a") },
			{ content: userText("b") },
			{ content: userText("c") },
		]);
		// Older compaction first, newer second
		h.seedBlocks(id, [
			{ content: compactionCustom("OLD", ids[1], 10, 1) },
			{ content: compactionCustom("NEW", ids[2], 20, 1) },
		]);

		const obj = h.objects.get(id)!;
		const storeBlocks = obj.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content }));
		const provenance = Object.fromEntries(obj.blocks.map((b) => [b.id, { timestamp: b.timestamp, author: "t", changeId: "c" }]));
		const view = __test.buildConversationView(storeBlocks, provenance);

		assert.equal(view.systemExtension, "NEW");
		assert.equal(view.turns.length, 1);
		assert.equal(view.turns[0].content, "c");
	});
});

// ── Tool-pair repair (tool_use without tool_result) ───────────

describe("repairToolPairs + mergeConsecutiveTurns", () => {
	it("is a no-op on a well-paired conversation", () => {
		const items = [
			{ kind: "user_text" as const, blockId: "b1", text: "hi", timestamp: 1 },
			{ kind: "assistant_text" as const, blockId: "b2", text: "one sec", timestamp: 2 },
			{ kind: "tool_use" as const, blockId: "b3", toolUseId: "tu_ok", name: "echo", input: { v: 1 }, timestamp: 3 },
			{ kind: "tool_result" as const, blockId: "b4", toolUseId: "tu_ok", content: "1", isError: false, timestamp: 4 },
			{ kind: "assistant_text" as const, blockId: "b5", text: "done", timestamp: 5 },
		];
		const out = __test.repairToolPairs(items);
		assert.deepEqual(out, items);
	});

	it("synthesizes an error tool_result stub for an orphan tool_use", () => {
		const items = [
			{ kind: "user_text" as const, blockId: "b1", text: "do X", timestamp: 1 },
			{ kind: "tool_use" as const, blockId: "b2", toolUseId: "tu_orphan", name: "shell_exec", input: {}, timestamp: 2 },
		];
		const out = __test.repairToolPairs(items);
		assert.equal(out.length, 3);
		assert.equal(out[2].kind, "tool_result");
		assert.equal((out[2] as any).toolUseId, "tu_orphan");
		assert.equal((out[2] as any).isError, true);
		assert.match((out[2] as any).content, /interrupted/i);
		assert.match((out[2] as any).blockId, /^__synthetic:/);
	});

	it("drops orphan tool_results whose matching tool_use is not present", () => {
		const items = [
			{ kind: "user_text" as const, blockId: "b1", text: "ok", timestamp: 1 },
			{ kind: "tool_result" as const, blockId: "b2", toolUseId: "tu_gone", content: "x", isError: false, timestamp: 2 },
			{ kind: "assistant_text" as const, blockId: "b3", text: "done", timestamp: 3 },
		];
		const out = __test.repairToolPairs(items);
		assert.equal(out.length, 2);
		assert.equal(out[0].kind, "user_text");
		assert.equal(out[1].kind, "assistant_text");
	});

	it("hoists a tool_result up to immediately follow its tool_use when steered blocks intervened", () => {
		// Reproduces the exact pattern observed in production: while a tool_use
		// was in flight, a steered user_text + assistant reply (and even a fresh
		// tool_use) landed in the DAG before the original tool_result did.
		const items = [
			{ kind: "tool_use" as const, blockId: "b1", toolUseId: "tu_lmc4", name: "register_tool", input: {}, timestamp: 1 },
			{ kind: "user_text" as const, blockId: "b2", text: "i made you have 1000 iterations", timestamp: 2 },
			{ kind: "assistant_text" as const, blockId: "b3", text: "Thanks!", timestamp: 3 },
			{ kind: "user_text" as const, blockId: "b4", text: "yes please finish", timestamp: 4 },
			{ kind: "assistant_text" as const, blockId: "b5", text: "Perfect, continuing.", timestamp: 5 },
			{ kind: "tool_use" as const, blockId: "b6", toolUseId: "tu_bfvc", name: "shell_exec", input: {}, timestamp: 6 },
			{ kind: "tool_result" as const, blockId: "b7", toolUseId: "tu_lmc4", content: "ok", isError: false, timestamp: 7 },
			{ kind: "tool_result" as const, blockId: "b8", toolUseId: "tu_bfvc", content: "done", isError: false, timestamp: 8 },
		];
		const out = __test.repairToolPairs(items);
		// tu_lmc4's tool_result must now sit at index 1 (immediately after its tool_use).
		assert.equal(out[0].kind, "tool_use"); assert.equal((out[0] as any).toolUseId, "tu_lmc4");
		assert.equal(out[1].kind, "tool_result"); assert.equal((out[1] as any).toolUseId, "tu_lmc4");
		// The intervening user/assistant blocks shifted down but stayed in the conversation.
		assert.equal(out[2].kind, "user_text");
		assert.equal(out[3].kind, "assistant_text");
		assert.equal(out[4].kind, "user_text");
		assert.equal(out[5].kind, "assistant_text");
		// tu_bfvc's tool_use is then immediately followed by its own tool_result.
		assert.equal(out[6].kind, "tool_use"); assert.equal((out[6] as any).toolUseId, "tu_bfvc");
		assert.equal(out[7].kind, "tool_result"); assert.equal((out[7] as any).toolUseId, "tu_bfvc");
		assert.equal(out.length, 8, "no items dropped or duplicated");
		// All synthetic stubs would have blockId starting with __synthetic; none here.
		for (const it of out) assert.ok(!it.blockId.startsWith("__synthetic:"), "no stubs needed");
	});


	it("mergeConsecutiveTurns collapses adjacent same-role turns into one", () => {
		const turns = [
			{ role: "user" as const, content: "a", timestamp: 1 },
			{ role: "user" as const, content: "b", timestamp: 2 },
			{ role: "assistant" as const, content: "c", timestamp: 3 },
		];
		const out = __test.mergeConsecutiveTurns(turns);
		assert.equal(out.length, 2);
		assert.equal(out[0].role, "user");
		assert.equal(out[1].role, "assistant");
	});

	it("end-to-end: buildConversationView repairs an orphan tool_use so messages are API-valid", () => {
		const h = createHarness();
		const id = h.seedAgent();
		h.seedBlocks(id, [
			{ content: userText("do it") },
			{ content: assistantText("working") },
			{ content: toolUseCustom("tu_stuck", "shell_exec", { cmd: "true" }) },
			// NO tool_result for tu_stuck — simulating a tool_result write that
			// never landed in the DAG because RivetKit dropped mid-turn.
		]);
		const obj = h.objects.get(id)!;
		const storeBlocks = obj.blocks.map((b) => ({ id: b.id, childrenIds: [], content: b.content }));
		const provenance = Object.fromEntries(obj.blocks.map((b) => [b.id, { timestamp: b.timestamp, author: "t", changeId: "c" }]));

		const view = __test.buildConversationView(storeBlocks, provenance);
		// The view must be a valid Anthropic sequence: every tool_use paired
		// with a tool_result and no two consecutive same-role turns.
		let tuCount = 0, trCount = 0;
		for (const turn of view.turns) {
			const arr = typeof turn.content === "string" ? [] : turn.content;
			for (const c of arr) {
				if (c.type === "tool_use") tuCount++;
				if (c.type === "tool_result") trCount++;
			}
		}
		assert.equal(tuCount, 1);
		assert.equal(trCount, 1, "orphan tool_use gets a synthesized tool_result paired with it");
		for (let i = 1; i < view.turns.length; i++) {
			assert.notEqual(view.turns[i].role, view.turns[i - 1].role, "roles must alternate");
		}
	});
});


// ── findCutIndex ─────────────────────────────────────────────────

describe("findCutIndex", () => {
	function bigUser(text: string, tokens: number) {
		return { kind: "user_text" as const, blockId: "b", text: "x".repeat(tokens * 4), timestamp: 0 };
	}
	function smallAssistant(tokens: number) {
		return { kind: "assistant_text" as const, blockId: "b", text: "x".repeat(tokens * 4), timestamp: 0 };
	}

	it("returns null when the whole conversation fits under keepRecentTokens", () => {
		const items = [bigUser("u1", 100), smallAssistant(100)];
		assert.equal(__test.findCutIndex(items, 1000), null);
	});

	it("cuts at the user-text boundary once budget is hit", () => {
		// Four turns, ~500 tokens each (2000 total). keepRecent = 800.
		// Walking backward: a4=500, u4=500+500=1000 ≥ 800 → cut at index of u4.
		const items = [
			{ ...bigUser("u1", 500), blockId: "u1" },
			smallAssistant(500),
			{ ...bigUser("u2", 500), blockId: "u2" },
			smallAssistant(500),
		];
		const cut = __test.findCutIndex(items, 800);
		// Budget hit at the first user we encounter walking backward whose cumulative ≥ 800.
		// Rearranged: indices = [u1(0), a1(1), u2(2), a2(3)]. Walking newest: a2→500, u2→1000 (≥800, user). cut=2.
		assert.equal(cut, 2);
	});

	it("returns null if a single turn alone exceeds the keep budget (no user boundary in kept range)", () => {
		// Single huge turn: u1 + huge assistant. Walking backward from assistant hits budget
		// but there's only one user at index 0 and we reject index 0.
		const items = [
			{ ...bigUser("u1", 100), blockId: "u1" },
			smallAssistant(5000),
		];
		assert.equal(__test.findCutIndex(items, 1000), null);
	});

	it("never returns index 0 (no point compacting the whole thing)", () => {
		const items = [
			{ ...bigUser("u1", 10000), blockId: "u1" },
		];
		assert.equal(__test.findCutIndex(items, 1000), null);
	});
});

// ── doCompact ────────────────────────────────────────────────────

describe("doCompact", () => {
	afterEach(restoreAnthropic);

	it("writes a compaction_summary block with the right meta fields", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			model: stringVal("test-model"),
			// keep-recent = 20 tokens (tiny, forces a cut)
			compaction_keep_recent_tokens: stringVal("20"),
		});
		// Eight turns, each small. Total will exceed 20.
		h.seedBlocks(agentId, [
			{ content: userText("u1 " + "x".repeat(30)) },
			{ content: assistantText("a1 " + "x".repeat(30)) },
			{ content: userText("u2 " + "x".repeat(30)) },
			{ content: assistantText("a2 " + "x".repeat(30)) },
			{ content: userText("u3 " + "x".repeat(30)) },
			{ content: assistantText("a3 " + "x".repeat(30)) },
			{ content: userText("u4 " + "x".repeat(30)) },
			{ content: assistantText("a4 " + "x".repeat(30)) },
		]);

		// Mock the summarisation LLM call.
		(globalThis as any).__LLM_FETCH = async (req: { messages: any[] }) => {
			// Expect the user message to be the structured summary prompt.
			const body = req.messages[0].content as string;
			assert.match(body, /summarising an agent's conversation/);
			assert.match(body, /## Goal/);
			return {
				content: [{ type: "text", text: "## Goal\nTest summary goal." }],
				stopReason: "end_turn",
				model: "test-model",
				inputTokens: 100,
				outputTokens: 20,
			};
		};

		const result = await __test.doCompact(agentId, undefined, h.ctx);
		assert.equal(result.compacted, true);
		assert.ok(result.blockId);
		assert.ok(result.firstKeptBlockId);
		assert.ok((result.tokensBefore ?? 0) > 0);

		// The compaction block is on the agent.
		const obj = h.objects.get(agentId)!;
		const last = obj.blocks[obj.blocks.length - 1];
		assert.equal(last.content.custom.contentType, "compaction_summary");
		assert.match(last.content.custom.meta.summary, /Test summary goal/);
		assert.equal(last.content.custom.meta.first_kept_block_id, result.firstKeptBlockId);
		assert.ok(parseInt(last.content.custom.meta.tokens_before, 10) > 0);
		assert.ok(parseInt(last.content.custom.meta.turn_count, 10) >= 1);
	});

	it("returns compacted=false with no_cut_point when conversation fits under the budget", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			compaction_keep_recent_tokens: stringVal("100000"), // huge budget
		});
		h.seedBlocks(agentId, [{ content: userText("tiny") }]);

		const result = await __test.doCompact(agentId, undefined, h.ctx);
		assert.equal(result.compacted, false);
		assert.equal(result.reason, "no_cut_point");
	});

	it("respects compaction_enabled=false", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			compaction_enabled: stringVal("false"),
		});
		const result = await __test.doCompact(agentId, undefined, h.ctx);
		assert.equal(result.compacted, false);
		assert.equal(result.reason, "disabled");
	});

	it("feeds prior summary into the next compaction as context", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			compaction_keep_recent_tokens: stringVal("20"),
		});
		// Seed some blocks + a prior compaction.
		const [u1, , u2, , u3, a3] = h.seedBlocks(agentId, [
			{ content: userText("u1 " + "x".repeat(100)) },
			{ content: assistantText("a1 " + "x".repeat(100)) },
			{ content: userText("u2 " + "x".repeat(100)) },
			{ content: assistantText("a2 " + "x".repeat(100)) },
			{ content: userText("u3 " + "x".repeat(100)) },
			{ content: assistantText("a3 " + "x".repeat(100)) },
		]);
		// Prior compaction: firstKept = u2, so pre-cut was u1/a1.
		h.seedBlocks(agentId, [
			{ content: compactionCustom("PRIOR-SUMMARY-TEXT", u2, 50, 1) },
		]);

		let lastPrompt = "";
		(globalThis as any).__LLM_FETCH = async (req: { messages: any[] }) => {
			lastPrompt = req.messages[0].content as string;
			return {
				content: [{ type: "text", text: "## Goal\nNew summary." }],
				stopReason: "end_turn",
				model: "m",
				inputTokens: 50, outputTokens: 10,
			};
		};

		const result = await __test.doCompact(agentId, undefined, h.ctx);
		assert.equal(result.compacted, true);
		// The prompt should reference the prior summary text.
		assert.match(lastPrompt, /Prior summary being superseded/);
		assert.match(lastPrompt, /PRIOR-SUMMARY-TEXT/);
		// The new block records the prior_summary_id.
		const obj = h.objects.get(agentId)!;
		const last = obj.blocks[obj.blocks.length - 1];
		assert.ok(last.content.custom.meta.prior_summary_id, "should link to prior compaction");
		void u1; void u3; void a3;
	});

	it("doCompact with customInstructions adds focus text to the prompt", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({ compaction_keep_recent_tokens: stringVal("20") });
		h.seedBlocks(agentId, [
			{ content: userText("u1 " + "x".repeat(100)) },
			{ content: assistantText("a1 " + "x".repeat(100)) },
			{ content: userText("u2 " + "x".repeat(100)) },
			{ content: assistantText("a2 " + "x".repeat(100)) },
		]);

		let lastPrompt = "";
		(globalThis as any).__LLM_FETCH = async (req: { messages: any[] }) => {
			lastPrompt = req.messages[0].content as string;
			return {
				content: [{ type: "text", text: "## Goal\nSummary." }],
				stopReason: "end_turn", model: "m", inputTokens: 1, outputTokens: 1,
			};
		};

		await __test.doCompact(agentId, "focus on upcoming doctor appointment", h.ctx);
		assert.match(lastPrompt, /focus on upcoming doctor appointment/);
	});
});

// ── runAsk integration ───────────────────────────────────────────

describe("runAsk auto-compaction", () => {
	afterEach(restoreAnthropic);

	it("auto-compacts before the ask when token estimate exceeds threshold", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			model: stringVal("test-model"),
			compaction_context_window: stringVal("500"),
			compaction_reserve_tokens: stringVal("100"), // threshold = 400
			compaction_keep_recent_tokens: stringVal("50"),
		});
		// Seed blocks totalling ~800 tokens so threshold is tripped.
		for (let i = 0; i < 4; i++) {
			h.seedBlocks(agentId, [
				{ content: userText("u" + i + " " + "x".repeat(200)) },
				{ content: assistantText("a" + i + " " + "x".repeat(200)) },
			]);
		}

		let summaryCalled = false;
		let askCalled = false;
		(globalThis as any).__LLM_FETCH = async (req: { messages: any[] }) => {
			const first = req.messages[0].content;
			if (typeof first === "string" && first.includes("summarising an agent's conversation")) {
				summaryCalled = true;
				return {
					content: [{ type: "text", text: "## Goal\nCompressed." }],
					stopReason: "end_turn", model: "test-model", inputTokens: 1, outputTokens: 1,
				};
			}
			askCalled = true;
			return {
				content: [{ type: "text", text: "After-compaction reply" }],
				stopReason: "end_turn", model: "test-model", inputTokens: 1, outputTokens: 1,
			};
		};

		const result = await __test.runAsk(agentId, "new question", h.ctx);
		assert.equal(summaryCalled, true, "summary LLM should have been invoked");
		assert.equal(askCalled, true, "ask LLM should have been invoked");
		assert.equal(result.compactedBeforeAsk, true);
		assert.equal(result.finalText, "After-compaction reply");
	});

	it("does NOT compact when under threshold", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			model: stringVal("test-model"),
			compaction_context_window: stringVal("100000"), // huge threshold
			compaction_reserve_tokens: stringVal("1000"),
			compaction_keep_recent_tokens: stringVal("50"),
		});
		h.seedBlocks(agentId, [{ content: userText("hi") }]);

		let summaryCalled = false;
		(globalThis as any).__LLM_FETCH = async (req: { messages: any[] }) => {
			const first = req.messages[0].content;
			if (typeof first === "string" && first.includes("summarising")) {
				summaryCalled = true;
			}
			return {
				content: [{ type: "text", text: "reply" }],
				stopReason: "end_turn", model: "test-model", inputTokens: 1, outputTokens: 1,
			};
		};
		const result = await __test.runAsk(agentId, "q", h.ctx);
		assert.equal(summaryCalled, false);
		assert.equal(result.compactedBeforeAsk, false);
	});

	it("retries once after a context-overflow error by compacting first", async () => {
		const h = createHarness();
		const agentId = h.seedAgent({
			model: stringVal("test-model"),
			// Force it under the auto-compact threshold so the retry is the only compaction path.
			compaction_context_window: stringVal("1000000"),
			compaction_reserve_tokens: stringVal("1000"),
			compaction_keep_recent_tokens: stringVal("20"),
		});
		// Seed multi-turn history so a cut point exists when compaction is forced on overflow.
		h.seedBlocks(agentId, [
			{ content: userText("u1 " + "x".repeat(200)) },
			{ content: assistantText("a1 " + "x".repeat(200)) },
			{ content: userText("u2 " + "x".repeat(200)) },
			{ content: assistantText("a2 " + "x".repeat(200)) },
		]);

		let askAttempts = 0;
		let summaryCalled = false;
		(globalThis as any).__LLM_FETCH = async (req: { messages: any[] }) => {
			const first = req.messages[0].content;
			if (typeof first === "string" && first.includes("summarising")) {
				summaryCalled = true;
				return {
					content: [{ type: "text", text: "## Goal\nSummary." }],
					stopReason: "end_turn", model: "m", inputTokens: 1, outputTokens: 1,
				};
			}
			askAttempts++;
			if (askAttempts === 1) {
				throw new Error("Anthropic API 400: prompt is too long: 300000 tokens");
			}
			return {
				content: [{ type: "text", text: "worked after retry" }],
				stopReason: "end_turn", model: "m", inputTokens: 1, outputTokens: 1,
			};
		};

		const result = await __test.runAsk(agentId, "question", h.ctx);
		assert.equal(summaryCalled, true);
		assert.equal(askAttempts, 2);
		assert.equal(result.compactedOnOverflow, true);
		assert.equal(result.finalText, "worked after retry");
	});

	it("isContextOverflowError recognises typical error shapes", () => {
		assert.equal(__test.isContextOverflowError(new Error("Anthropic API 400: prompt is too long: 300k tokens")), true);
		assert.equal(__test.isContextOverflowError(new Error("context_length_exceeded for model ...")), true);
		assert.equal(__test.isContextOverflowError(new Error("rate_limit_error")), false);
		assert.equal(__test.isContextOverflowError(new Error("invalid_api_key")), false);
	});
});

// ── buildEffectiveSystem ─────────────────────────────────────────

describe("buildEffectiveSystem", () => {
	it("returns undefined when both parts are empty", () => {
		assert.equal(__test.buildEffectiveSystem(undefined, undefined), undefined);
	});
	it("returns base when there's no summary", () => {
		assert.equal(__test.buildEffectiveSystem("base prompt", undefined), "base prompt");
	});
	it("wraps summary in conversation-summary tags appended to base", () => {
		const sys = __test.buildEffectiveSystem("base", "S");
		assert.equal(sys, "base\n\n<conversation-summary>\nS\n</conversation-summary>");
	});
	it("returns only the summary block when base is empty", () => {
		const sys = __test.buildEffectiveSystem(undefined, "S");
		assert.equal(sys, "<conversation-summary>\nS\n</conversation-summary>");
	});
});


// ── estimateToolDefinitionsTokens ────────────────────────────────
//
// Tool schemas show up in the API request body, so they count against
// the context window. The estimator must include them, otherwise an
// agent with a big tool surface (Holdfast wires ~50) under-counts by
// thousands of tokens and never trips compaction.

describe("estimateToolDefinitionsTokens", () => {
	it("returns 0 when there are no tools", () => {
		assert.equal(__test.estimateToolDefinitionsTokens([]), 0);
	});

	it("sums name + description + serialized schema + per-tool framing for each tool", () => {
		const R = __test.CHARS_PER_TOKEN;
		const tools = [
			{
				name: "x",
				description: "desc",
				input_schema: { type: "object" },
				target_prefix: "/p",
				target_action: "a",
			},
		];
		const expected =
			Math.ceil("x".length / R) +
			Math.ceil("desc".length / R) +
			Math.ceil(JSON.stringify({ type: "object" }).length / R) +
			12;
		assert.equal(__test.estimateToolDefinitionsTokens(tools), expected);
	});
});

// ── shouldAutoCompact ────────────────────────────────────────────
//
// The Graice 200k-overflow that motivated this fix happened because
// shouldAutoCompact was missing the base system prompt and every tool
// definition from its estimate. We pin the trigger semantics so the
// next regression is loud.

describe("shouldAutoCompact", () => {
	it("returns false on a fresh agent with no blocks", async () => {
		const h = createHarness();
		const id = h.seedAgent({
			system: stringVal("You are a tiny assistant."),
		});
		assert.equal(await __test.shouldAutoCompact(id, h.ctx), false);
	});

	it("respects the compaction_enabled=false flag", async () => {
		const h = createHarness();
		const id = h.seedAgent({
			system: stringVal("x".repeat(10_000)),
			compaction_enabled: stringVal("false"),
			compaction_context_window: stringVal("1000"),
			compaction_reserve_tokens: stringVal("100"),
		});
		assert.equal(await __test.shouldAutoCompact(id, h.ctx), false);
	});

	it("counts the base system prompt against the threshold", async () => {
		const h = createHarness();
		const R = __test.CHARS_PER_TOKEN;
		// System prompt alone exceeds the (window - reserve) threshold.
		const sysChars = Math.ceil((1000 - 100 + 50) * R);
		const id = h.seedAgent({
			system: stringVal("x".repeat(sysChars)),
			compaction_context_window: stringVal("1000"),
			compaction_reserve_tokens: stringVal("100"),
		});
		assert.equal(await __test.shouldAutoCompact(id, h.ctx), true);
	});

	it("counts tool definitions against the threshold", async () => {
		const h = createHarness();
		const R = __test.CHARS_PER_TOKEN;
		// Many tools whose definitions together blow the budget.
		const toolsEntries: Record<string, any> = {};
		for (let i = 0; i < 20; i++) {
			toolsEntries[`tool_${i}`] = mapVal({
				description: stringVal("d".repeat(Math.ceil(60 * R))),
				input_schema: stringVal(JSON.stringify({ type: "object" })),
				target_prefix: stringVal("/p"),
				target_action: stringVal("a"),
			});
		}
		const id = h.seedAgent({
			tools: mapVal(toolsEntries),
			compaction_context_window: stringVal("1000"),
			compaction_reserve_tokens: stringVal("100"),
		});
		assert.equal(await __test.shouldAutoCompact(id, h.ctx), true);
	});

	it("stays below threshold when only the conversation is small", async () => {
		const h = createHarness();
		const id = h.seedAgent({
			system: stringVal("short system"),
			compaction_context_window: stringVal("100000"),
			compaction_reserve_tokens: stringVal("10000"),
		});
		h.seedBlocks(id, [
			{ content: userText("hello") },
			{ content: assistantText("hi") },
		]);
		assert.equal(await __test.shouldAutoCompact(id, h.ctx), false);
	});
});
