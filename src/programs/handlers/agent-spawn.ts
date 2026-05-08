// Agent spawn — subagent spawning, templates, and result submission.
//
// Extracted from agent.ts to reduce omnibus size. Contains no conversation
// or compaction logic — just spawn machinery and result plumbing.
//
// Note: doSpawn and runOneAccept receive `runAsk` as a parameter rather
// than importing it, to avoid a circular dependency with agent-runner.ts.

import type { ProgramContext } from "../runtime.js";
import {
	ToolSpec,
	AgentTemplate,
	SpawnTaskInput,
	SpawnInput,
	SingleResult,
	SubmitResultInput,
	SubagentNode,
	extractString,
	extractInt,
	extractBool,
	DEFAULT_MODEL,
	DEFAULT_MAX_SPAWN_DEPTH,
	DEFAULT_SPAWN_CONCURRENCY,
	SUBAGENT_ADDENDUM,
	doRegisterTool,
} from "./agent-types.js";

// ── Subagent spawning machinery ────────────────────────────────
//
// Templates are code-constant defaults that can be overridden at runtime
// by DAG objects of typeKey="agent_template" with matching `name`. If a
// matching DAG object exists it wins; otherwise the code default applies.
// This mirrors the "both" storage model: shipping sensible defaults while
// letting each peer customize without touching source.


// Read-only DAG tool bundle — safe for any subagent. Every tool listed
// here targets an existing glon program action and mutates nothing.
const READ_ONLY_TOOLS: ToolSpec[] = [
	{
		name: "object_list",
		description: "List Glon objects in the store. Optional type_key filter narrows to one type.",
		input_schema: { type: "object", properties: { type_key: { type: "string" }, limit: { type: "number" } } },
		target_prefix: "/crud", target_action: "list",
	},
	{
		name: "object_get",
		description: "Read an object's state summary. Use object_read_source for file contents.",
		input_schema: { type: "object", properties: { object_id: { type: "string" } }, required: ["object_id"] },
		target_prefix: "/crud", target_action: "get",
	},
	{
		name: "object_read_source",
		description: "Read raw UTF-8 content of an object. Truncates at max_bytes.",
		input_schema: { type: "object", properties: { object_id: { type: "string" }, max_bytes: { type: "number" } }, required: ["object_id"] },
		target_prefix: "/crud", target_action: "readContent",
	},
	{
		name: "object_search",
		description: "Full-text search across object fields and content. Narrow with type_key.",
		input_schema: { type: "object", properties: { query: { type: "string" }, type_key: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
		target_prefix: "/crud", target_action: "search",
	},
	{
		name: "object_links",
		description: "Show outbound and inbound ObjectLinks for an object.",
		input_schema: { type: "object", properties: { object_id: { type: "string" } }, required: ["object_id"] },
		target_prefix: "/graph", target_action: "links",
	},
	{
		name: "object_neighbors",
		description: "Immediate neighbours (one-hop link targets) of an object.",
		input_schema: { type: "object", properties: { object_id: { type: "string" } }, required: ["object_id"] },
		target_prefix: "/graph", target_action: "neighbors",
	},
];
	export const BUILTIN_TEMPLATES: Record<string, AgentTemplate> = {
	task: {
		name: "task",
		description: "General-purpose worker agent. Can spawn further subagents.",
		model: DEFAULT_MODEL,
		system: "You are a general-purpose agent running inside Glon. You can use registered tools and may spawn further subagents to parallelize work. Be precise, terse, and finish with submit_result.",
		defaultTools: READ_ONLY_TOOLS,
		spawns: "*",
	},
	explore: {
		name: "explore",
		description: "Read-only investigator. Returns a compressed map of findings.",
		model: DEFAULT_MODEL,
		system: "You are an investigator. Read the DAG via the tools you have. Do not mutate anything. Return a compressed, structured summary via submit_result.",
		defaultTools: READ_ONLY_TOOLS,
		spawns: "",
	},
	quick_task: {
		name: "quick_task",
		description: "Fast small-model worker for mechanical tasks.",
		model: "claude-haiku-4-20250414",
		system: "You are a lightweight worker. Do the single mechanical task you were given and return the answer via submit_result. Do not explore beyond the request.",
		defaultTools: [],
		spawns: "",
	},
};

export async function resolveAgentTemplate(name: string, ctx: ProgramContext): Promise<AgentTemplate> {
	const store = ctx.store as any;
	// DAG override: scan agent_template objects, first matching name wins.
	try {
		const refs = (await store.list("agent_template")) as Array<{ id: string }>;
		for (const ref of refs) {
			const state = await store.get(ref.id);
			if (!state || state.deleted) continue;
			const templateName = extractString(state.fields?.name);
			if (templateName !== name) continue;
			const toolsRaw = extractString(state.fields?.default_tools) ?? "[]";
			let defaultTools: ToolSpec[] = [];
			try { defaultTools = JSON.parse(toolsRaw); } catch { /* keep empty */ }
			return {
				name: templateName,
				description: extractString(state.fields?.description) ?? "",
				model: extractString(state.fields?.model) ?? DEFAULT_MODEL,
				system: extractString(state.fields?.system) ?? BUILTIN_TEMPLATES.task.system,
				defaultTools,
				spawns: extractString(state.fields?.spawns) ?? "",
			};
		}
	} catch { /* store may not support list in tests — fall through to code default */ }
	const tpl = BUILTIN_TEMPLATES[name];
	if (!tpl) throw new Error(`Unknown agent template: ${name}`);
	return tpl;
}





export function maxSpawnDepth(): number {
	const raw = process.env.GLON_AGENT_MAX_DEPTH;
	if (!raw) return DEFAULT_MAX_SPAWN_DEPTH;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_SPAWN_DEPTH;
}

export class Semaphore {
	private avail: number;
	private waiters: Array<() => void> = [];
	constructor(n: number) { this.avail = Math.max(1, n); }
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.avail > 0) { this.avail--; }
		else await new Promise<void>((res) => this.waiters.push(res));
		try { return await fn(); }
		finally {
			const next = this.waiters.shift();
			if (next) next(); else this.avail++;
		}
	}
}

export function buildSubagentSystemPrompt(
	template: AgentTemplate,
	parentId: string,
	task: SpawnTaskInput,
	depth: number,
	sharedContext: string | undefined,
	schema: unknown | undefined,
): string {
	const parts = [template.system.trim(), SUBAGENT_ADDENDUM.trim()];
	parts.push(`Parent agent: ${parentId}`);
	parts.push(`Task id: ${task.id}`);
	parts.push(`Depth: ${depth}`);
	if (sharedContext && sharedContext.trim()) {
		parts.push("--- SHARED CONTEXT ---\n" + sharedContext.trim());
	}
	if (schema !== undefined) {
		parts.push("--- OUTPUT SCHEMA ---\nYour submit_result `result` argument must satisfy:\n" + JSON.stringify(schema, null, 2));
	}
	return parts.join("\n\n");
}

export function submitResultTool(childId: string): ToolSpec {
	return {
		name: "submit_result",
		description: "Submit your final structured result to the parent agent and conclude the task.",
		input_schema: {
			type: "object",
			properties: { result: { description: "Your structured answer. Shape must match the output schema if one was given in your system prompt." } },
			required: ["result"],
		},
		target_prefix: "/agent",
		target_action: "submitResult",
		bound_args: { agentId: childId },
	};
}

export function spawnTool(parentId: string): ToolSpec { return {
		name: "spawn",
		description: "Spawn one or more subagents in parallel to complete delegated tasks. Each task runs as a fresh agent with its own DAG. Waits for all children before returning a compressed batch result.",
		input_schema: {
			type: "object",
			properties: {
				context: { type: "string", description: "Shared background prepended to every child's first user turn." },
				schema: { type: "object", description: "Optional output shape every child's submit_result must satisfy." },
				maxConcurrency: { type: "number", description: "Upper bound on parallel children. Default 6." },
				tasks: {
					type: "array",
					minItems: 1,
					items: {
						type: "object",
						required: ["id", "agentTemplate", "assignment"],
						properties: {
							id: { type: "string" },
							agentTemplate: { type: "string", description: "Template name (e.g. 'task', 'explore', 'quick_task') or an agent_template object id." },
							assignment: { type: "string" },
							model: { type: "string" },
						},
					},
				},
			},
			required: ["tasks"],
		},
		target_prefix: "/agent",
		target_action: "spawn",
		bound_args: { agentId: parentId },
	}; }

export async function createChildAgent(
	parent: { id: string; depth: number; spawnsPolicy: string },
	task: SpawnTaskInput,
	sharedContext: string | undefined,
	schema: unknown | undefined,
	ctx: ProgramContext,
): Promise<{ childId: string; template: AgentTemplate }> {
	const store = ctx.store as any;
	const { stringVal, linkVal } = ctx as any;

	const template = await resolveAgentTemplate(task.agentTemplate, ctx);
	const childDepth = parent.depth + 1;
	const system = buildSubagentSystemPrompt(template, parent.id, task, childDepth, sharedContext, schema);
	const childCanSpawn = template.spawns !== "" && childDepth < maxSpawnDepth();

	const fields: Record<string, any> = {
		name: stringVal(`${template.name}-${task.id}`),
		model: stringVal(task.model ?? template.model),
		system: stringVal(system),
		spawn_parent: linkVal(parent.id, "spawn_parent"),
		spawn_depth: stringVal(String(childDepth)),
		spawn_task_id: stringVal(task.id),
		spawn_template: stringVal(template.name),
	};
	if (schema !== undefined && schema !== null) {
		fields.output_schema = stringVal(JSON.stringify(schema));
	}
	const childId: string = await store.create("agent", JSON.stringify(fields));

	// Every child always gets submit_result. Children that can spawn get the spawn tool.
	await doRegisterTool(childId, submitResultTool(childId), ctx);
	if (childCanSpawn) {
		await doRegisterTool(childId, spawnTool(childId), ctx);
	}
	for (const t of template.defaultTools) {
		await doRegisterTool(childId, t, ctx);
	}

	return { childId, template };
}

export async function doSpawn(input: SpawnInput, ctx: ProgramContext, runAsk: (agentId: string, prompt: string, ctx: ProgramContext, opts?: { printStream?: boolean; followUpHook?: any }) => Promise<any>): Promise<{ childAgentIds: string[]; results: SingleResult[]; batchId: string }> {
	const store = ctx.store as any;
	if (!input?.agentId) throw new Error("spawn: agentId required");
	if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
		throw new Error("spawn: tasks[] required");
	}
	const parent = await store.get(input.agentId);
	if (!parent) throw new Error(`spawn: parent agent not found: ${input.agentId}`);
	if (parent.typeKey !== "agent") throw new Error(`spawn: ${input.agentId} is not an agent`);

	const parentDepth = extractInt(parent.fields?.spawn_depth, 0);
	const cap = maxSpawnDepth();
	if (parentDepth >= cap) {
		throw new Error(`spawn: parent is at max depth (${cap}); cannot spawn further`);
	}
	// Policy enforcement: a parent's template's `spawns` field — when we know
	// what template the parent came from — may whitelist templates it can
	// delegate to. For top-level user-created agents without a template, allow
	// anything (back-compat).
	const parentTemplateName = extractString(parent.fields?.spawn_template);
	let allowed: "*" | string[] = "*";
	if (parentTemplateName) {
		const parentTpl = await resolveAgentTemplate(parentTemplateName, ctx);
		if (parentTpl.spawns === "") {
			throw new Error(`spawn: parent template '${parentTemplateName}' is not allowed to spawn subagents`);
		}
		allowed = parentTpl.spawns === "*" ? "*" : parentTpl.spawns.split(",").map((s) => s.trim()).filter(Boolean);
	}
	if (allowed !== "*") {
		for (const t of input.tasks) {
			if (!allowed.includes(t.agentTemplate)) {
				throw new Error(`spawn: template '${t.agentTemplate}' not permitted by parent policy (${allowed.join(",") || "<none>"})`);
			}
		}
	}

	const ids = new Set<string>();
	for (const t of input.tasks) {
		if (!t?.id) throw new Error("spawn: every task needs an id");
		if (ids.has(t.id)) throw new Error(`spawn: duplicate task id '${t.id}'`);
		ids.add(t.id);
		if (!t.agentTemplate) throw new Error(`spawn[${t.id}]: agentTemplate required`);
		if (!t.assignment) throw new Error(`spawn[${t.id}]: assignment required`);
	}

	const sem = new Semaphore(input.maxConcurrency ?? DEFAULT_SPAWN_CONCURRENCY);
	const childAgentIds: string[] = [];
	const parentRef = { id: input.agentId, depth: parentDepth, spawnsPolicy: parentTemplateName ? (await resolveAgentTemplate(parentTemplateName, ctx)).spawns : "*" };

	const batchId = (ctx as any).randomUUID ? (ctx as any).randomUUID() : `batch-${Date.now()}`;
	const emit = (channel: string, data: any) => { try { ctx.emit?.(channel, data); } catch { /* best-effort */ } };
	emit("spawn:start", {
		batchId,
		parentAgentId: input.agentId,
		tasks: input.tasks.map((t) => ({ id: t.id, template: t.agentTemplate })),
		maxConcurrency: input.maxConcurrency ?? DEFAULT_SPAWN_CONCURRENCY,
	});
	const results = await Promise.all(input.tasks.map((task) => sem.run(async (): Promise<SingleResult> => {
		const started = Date.now();
		const maxAttempts = Math.max(1, task.maxAttempts ?? 1);
		let childId = "";
		let lastResult: SingleResult | null = null;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			lastResult = await runOneAttempt(runAsk, task, attempt, parentRef, input.context, input.schema, ctx, (id) => {
				childId = id; childAgentIds.push(id);
				emit("spawn:child_created", { batchId, taskId: task.id, childAgentId: id, attempt });
			}, started);
			emit("spawn:child_done", { batchId, taskId: task.id, childAgentId: lastResult.childAgentId, status: lastResult.status, attempt, durationMs: lastResult.durationMs });
			if (lastResult.status === "ok" || lastResult.status === "no_submit_result" || lastResult.status === "schema_invalid" || lastResult.status === "cancelled") break;
		}
		return lastResult!;
	})));


	emit("spawn:complete", {
		batchId,
		parentAgentId: input.agentId,
		summary: {
			total: results.length,
			ok: results.filter((r) => r.status === "ok").length,
			no_submit_result: results.filter((r) => r.status === "no_submit_result").length,
			timeout: results.filter((r) => r.status === "timeout").length,
			error: results.filter((r) => r.status === "error").length,
			cancelled: results.filter((r) => r.status === "cancelled").length,
			schema_invalid: results.filter((r) => r.status === "schema_invalid").length,
		},
	});
	return { childAgentIds, results, batchId };
}

export async function runOneAttempt(runAsk: (agentId: string, prompt: string, ctx: ProgramContext, opts?: { printStream?: boolean; followUpHook?: any }) => Promise<any>, 
	task: SpawnTaskInput,
	attempt: number,
	parentRef: { id: string; depth: number; spawnsPolicy: string },
	sharedContext: string | undefined,
	schema: unknown | undefined,
	ctx: ProgramContext,
	onChildCreated: (id: string) => void,
	batchStartedAt: number,
): Promise<SingleResult> {
	const store = ctx.store as any;
	let childId = "";
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const created = await createChildAgent(parentRef, task, sharedContext, schema, ctx);
		childId = created.childId;
		onChildCreated(childId);

		const askPromise = runAsk(childId, task.assignment, ctx);
		const timeoutPromise = task.timeoutMs && task.timeoutMs > 0
			? new Promise<never>((_res, rej) => {
				timer = setTimeout(async () => {
					timedOut = true;
					try { await doCancel(childId, ctx); } catch { /* best-effort */ }
					rej(new Error(`timeout: task exceeded ${task.timeoutMs}ms`));
				}, task.timeoutMs);
			})
			: null;
		const ask = await (timeoutPromise ? Promise.race([askPromise, timeoutPromise]) : askPromise);
		if (timer) clearTimeout(timer);

		const state = await store.get(childId);
		const submitted = extractString(state?.fields?.submitted_result);
		if (submitted !== undefined) {
			let parsed: unknown = submitted;
			try { parsed = JSON.parse(submitted); } catch { /* keep raw */ }
			return {
				id: task.id,
				childAgentId: childId,
				output: parsed,
				status: "ok",
				attempts: attempt,
				durationMs: Date.now() - batchStartedAt,
				tokens: { input: ask.inputTokens, output: ask.outputTokens },
				compacted: ask.compactedBeforeAsk || ask.compactedOnOverflow,
			};
		}
		const submissionErrors = extractString(state?.fields?.submission_errors);
		if (submissionErrors) {
			return {
				id: task.id,
				childAgentId: childId,
				output: null,
				status: "schema_invalid",
				attempts: attempt,
				error: submissionErrors,
				durationMs: Date.now() - batchStartedAt,
				tokens: { input: ask.inputTokens, output: ask.outputTokens },
				compacted: ask.compactedBeforeAsk || ask.compactedOnOverflow,
			};
		}
		return {
			id: task.id,
			childAgentId: childId,
			output: ask.finalText,
			status: "no_submit_result",
			attempts: attempt,
			error: "subagent finished without calling submit_result; falling back to final assistant text",
			durationMs: Date.now() - batchStartedAt,
			tokens: { input: ask.inputTokens, output: ask.outputTokens },
			compacted: ask.compactedBeforeAsk || ask.compactedOnOverflow,
		};
	} catch (err: any) {
		if (timer) clearTimeout(timer);
		const msg = err?.message ?? String(err);
		const isTimeout = timedOut || /^timeout:/i.test(msg);
		const isCancelled = !isTimeout && /cancelled/i.test(msg);
		const isSchemaFail = /schema validation/i.test(msg);
		const status: SingleResult["status"] = isTimeout ? "timeout" : isCancelled ? "cancelled" : isSchemaFail ? "schema_invalid" : "error";
		return {
			id: task.id,
			childAgentId: childId,
			output: null,
			status,
			attempts: attempt,
			error: msg,
			durationMs: Date.now() - batchStartedAt,
			tokens: { input: 0, output: 0 },
			compacted: false,
		};
	}
}

// Minimal JSON-Schema-subset validator for submit_result payloads.
// Supports: type, required, properties, items, enum, const, nullable.
// No external deps. Returns a flat list of path-qualified error strings;
// empty list means valid.
export function validateAgainstSchema(value: unknown, schema: any, path: string = "$"): string[] {
	if (schema == null || typeof schema !== "object") return [];
	const errors: string[] = [];
	const expected = schema.type;
	const nullable = schema.nullable === true;
	if (value === null) {
		if (!nullable && expected !== "null" && expected !== undefined) {
			errors.push(`${path}: expected ${expected}, got null`);
		}
		return errors;
	}
	if (expected) {
		const actual = Array.isArray(value) ? "array" : typeof value;
		const hit = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
		if (!hit) errors.push(`${path}: expected ${Array.isArray(expected) ? expected.join("|") : expected}, got ${actual}`);
	}
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		errors.push(`${path}: value not in enum (${JSON.stringify(schema.enum)})`);
	}
	if ("const" in schema && value !== schema.const) {
		errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
	}
	if (schema.properties && typeof value === "object" && !Array.isArray(value) && value !== null) {
		const obj = value as Record<string, unknown>;
		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (!(key in obj)) errors.push(`${path}.${key}: required`);
			}
		}
		for (const [key, sub] of Object.entries(schema.properties)) {
			if (key in obj) errors.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
		}
	}
	if (schema.items && Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			errors.push(...validateAgainstSchema(value[i], schema.items, `${path}[${i}]`));
		}
	}
	return errors;
}

export async function doSubmitResult(input: SubmitResultInput, ctx: ProgramContext): Promise<{ ok: true }> {
	const client = ctx.client as any;
	const store = ctx.store as any;
	const { stringVal } = ctx as any;
	if (!input?.agentId) throw new Error("submitResult: agentId required");

	const state = await store.get(input.agentId);
	const schemaJson = state ? extractString(state.fields?.output_schema) : undefined;
	if (schemaJson) {
		let schema: unknown = null;
		try { schema = JSON.parse(schemaJson); } catch { /* stored malformed — skip */ }
		if (schema) {
			const payload = input.result;
			const errors = validateAgainstSchema(payload, schema);
			if (errors.length > 0) {
				const msg = `submit_result failed schema validation:\n  - ${errors.join("\n  - ")}`;
				// Record the failure on the child so doSpawn can classify status=schema_invalid
				// even if the model doesn't retry or never succeeds. Error is still thrown so the
				// model sees is_error=true on its tool_result and can self-correct.
				const actor = client.objectActor.getOrCreate([input.agentId]);
				await actor.setField("submission_errors", JSON.stringify(stringVal(msg)));
				throw new Error(msg);
			}
		}
	}

	const resultJson = typeof input.result === "string" ? input.result : JSON.stringify(input.result);
	const actor = client.objectActor.getOrCreate([input.agentId]);
	await actor.setField("submitted_result", JSON.stringify(stringVal(resultJson)));
	await actor.setField("submitted_at", JSON.stringify(stringVal(String(Date.now()))));
	return { ok: true };
}


/** Walk the spawn_parent links reachable from an agent and return a tree. */
export async function doGetSubagents(rootId: string, ctx: ProgramContext, maxDepth: number = 8): Promise<SubagentNode> {
	const store = ctx.store as any;
	// Scan is O(agents). /agent doesn't maintain a reverse index today; if this
	// becomes a bottleneck we can add one to storeActor.
	let refs: Array<{ id: string }> = [];
	try { refs = (await store.list("agent")) ?? []; } catch { /* minimal harness — single-node tree */ }
	const states = new Map<string, any>();
	for (const ref of refs) {
		const s = await store.get(ref.id);
		if (s && !s.deleted) states.set(ref.id, s);
	}
	const rootState = states.get(rootId) ?? await store.get(rootId);
	if (!rootState) throw new Error(`agent not found: ${rootId}`);
	if (!states.has(rootId)) states.set(rootId, rootState);

	function nodeFor(id: string, state: any, depth: number): SubagentNode {
		const name = extractString(state.fields?.name) ?? id.slice(0, 8);
		const tpl = extractString(state.fields?.spawn_template);
		const taskId = extractString(state.fields?.spawn_task_id);
		const submitted = extractString(state.fields?.submitted_result);
		const cancelled = extractString(state.fields?.cancel_requested) === "true";
		const status: SubagentNode["status"] = cancelled ? "cancelled" : submitted ? "done" : "pending";
		return { id, name, template: tpl, depth, taskId, status, children: [] };
	}

	const rootNode = nodeFor(rootId, rootState, extractInt(rootState.fields?.spawn_depth, 0));
	const byParent = new Map<string, string[]>();
	for (const [id, s] of states) {
		const parentId = s.fields?.spawn_parent?.linkValue?.targetId;
		if (!parentId) continue;
		const bucket = byParent.get(parentId);
		if (bucket) bucket.push(id); else byParent.set(parentId, [id]);
	}

	const startDepth = rootNode.depth;
	function expand(node: SubagentNode) {
		if (node.depth - startDepth >= maxDepth) return;
		const childIds = byParent.get(node.id) ?? [];
		for (const cid of childIds) {
			const cstate = states.get(cid);
			if (!cstate) continue;
			const childNode = nodeFor(cid, cstate, node.depth + 1);
			node.children.push(childNode);
			expand(childNode);
		}
	}
	expand(rootNode);
	return rootNode;
}

export function countDescendants(node: SubagentNode): number {
	let n = 0;
	for (const c of node.children) n += 1 + countDescendants(c);
	return n;
}

export function renderSubagentTree(node: SubagentNode, indent: string = "", isLast: boolean = true, isRoot: boolean = true): string {
	const branch = isRoot ? "" : (isLast ? "└─ " : "├─ ");
	const statusSym = node.status === "done" ? "✓" : node.status === "cancelled" ? "✗" : "·";
	const tplTag = node.template ? `[${node.template}]` : "";
	const taskTag = node.taskId ? ` task=${node.taskId}` : "";
	const head = `${indent}${branch}${statusSym} ${node.name} ${tplTag}${taskTag}  ${node.id.slice(0, 8)}`;
	const lines = [head];
	const nextIndent = indent + (isRoot ? "" : (isLast ? "   " : "│  "));
	for (let i = 0; i < node.children.length; i++) {
		lines.push(renderSubagentTree(node.children[i], nextIndent, i === node.children.length - 1, false));
	}
	return lines.join("\n");
}