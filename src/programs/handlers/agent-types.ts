// Agent shared types, constants, and tiny field helpers.
//
// Zero runtime dependencies on other agent modules.

import type { AnthropicContent } from "./agent-llm.js";
import type { ProgramContext } from "../runtime.js";

// ── Constants ──────────────────────────────────────────────────────

export const DEFAULT_MODEL = "moonshot-v1-8k";
export const DEFAULT_MAX_TOOL_ITERATIONS = 100;
export const TOOL_RESULT_TRUNCATE = 8192;
export const TOOL_RESULT_TRUNCATE_FOR_SUMMARY = 2000;
export const SUMMARY_MAX_TOKENS = 2048;
export const SUMMARY_TEMPERATURE = 0.3;
export const DEFAULT_COMPACTION_CONTEXT_WINDOW = 200000;
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 32768;
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20000;
export const DEFAULT_MAX_SPAWN_DEPTH = 4;
export const DEFAULT_SPAWN_CONCURRENCY = 6;

export const SUBAGENT_ADDENDUM = `

---
SUBAGENT CONTEXT

You are a subagent. Your parent delegated one task to you and is waiting
for your structured answer.

When you are finished, call the \`submit_result\` tool with your final
answer. If you don't, your last assistant message will be used as the
fallback result with a \`no_submit_result\` warning.

You cannot spawn further subagents unless your template permits it.
`;

export const BLOCK_TOOL_USE = "tool_use";
export const BLOCK_TOOL_RESULT = "tool_result";
export const BLOCK_COMPACTION_SUMMARY = "compaction_summary";
export const STYLE_USER = 0;
export const STYLE_ASSISTANT = 1;
export const CHARS_PER_TOKEN = 2.8;

// ── Types ──────────────────────────────────────────────────────────

export interface ToolSpec {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	target_prefix: string;
	target_action: string;
	bound_args?: Record<string, unknown>;
}

export interface CompactionConfig {
	enabled: boolean;
	contextWindow: number;
	reserveTokens: number;
	keepRecentTokens: number;
	model?: string;
}

export type ClassifiedItem =
	| { kind: "user_text"; blockId: string; text: string; timestamp: number }
	| { kind: "assistant_text"; blockId: string; text: string; timestamp: number }
	| { kind: "tool_use"; blockId: string; toolUseId: string; name: string; input: Record<string, unknown>; timestamp: number }
	| { kind: "tool_result"; blockId: string; toolUseId: string; content: string; isError: boolean; timestamp: number }
	| { kind: "compaction"; blockId: string; summary: string; firstKeptBlockId: string; tokensBefore: number; turnCount: number; priorSummaryId?: string; timestamp: number };

export interface Turn {
	role: "user" | "assistant";
	content: string | AnthropicContent[];
	timestamp: number;
}

export interface ConversationView {
	/** Summary to inject as a system-prompt extension, if any. */
	systemExtension?: string;
	/** Turns to send as the messages[] array. */
	turns: Turn[];
	/** Latest compaction block, if one exists (for diagnostics). */
	latestCompaction: Extract<ClassifiedItem, { kind: "compaction" }> | null;
}

export interface AskResult {
	finalText: string;
	iterations: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	compactedBeforeAsk: boolean;
	compactedOnOverflow: boolean;
	followUpAttempts: number;
}

export interface FollowUpHookContext {
	agentId: string;
	ctx: ProgramContext;
	attempt: number;
	lastResult: AskResult;
}

export type FollowUpHook = (c: FollowUpHookContext) => Promise<{ text: string } | null | undefined>;

export interface AgentStatus {
	id: string;
	name: string;
	model: string;
	system: string | undefined;
	tools: number;
	blockCount: number;
	effectiveTurns: number;
	estimatedTokens: number;
	compaction: {
		config: CompactionConfig;
		threshold: number;
		lastCompaction: {
			blockId: string;
			firstKeptBlockId: string;
			tokensBefore: number;
			turnCount: number;
			createdAt: number;
		} | undefined;
	};
}

export interface AgentTemplate {
	name: string;
	description: string;
	model: string;
	system: string;
	defaultTools: ToolSpec[];
	spawns: string;
}

export interface SpawnTaskInput {
	id: string;
	agentTemplate: string;
	assignment: string;
	model?: string;
	timeoutMs?: number;
	maxAttempts?: number;
}

export interface SpawnInput {
	agentId: string;
	context?: string;
	schema?: unknown;
	maxConcurrency?: number;
	tasks: SpawnTaskInput[];
}

export interface SingleResult {
	id: string;
	childAgentId: string;
	output: unknown;
	status: "ok" | "no_submit_result" | "cancelled" | "error" | "timeout" | "schema_invalid";
	attempts?: number;
	error?: string;
	durationMs: number;
	tokens: { input: number; output: number };
	compacted: boolean;
}

export interface SubmitResultInput {
	agentId: string;
	result: unknown;
}

export interface SubagentNode {
	id: string;
	depth: number;
	status: string;
	output?: unknown;
	children: SubagentNode[];
}

export interface PendingSteerer {
	userBlockId: string;
	resolve: (r: AskResult) => void;
	reject: (e: Error) => void;
}

export interface RunSlot {
	running: boolean;
	pending: PendingSteerer[];
}

export interface ExtractionResult {
	extractionSummary: string;
	toolCalls: number;
	iterations: number;
	inputTokens: number;
	outputTokens: number;
}

export interface CompactResult {
	compacted: boolean;
	reason?: "disabled" | "under_budget" | "no_cut_point";
	blockId?: string;
	firstKeptBlockId?: string;
	turnCount?: number;
	tokensBefore?: number;
	summary?: string;
	extraction?: {
		ran: boolean;
		toolCalls: number;
		iterations: number;
		inputTokens: number;
		outputTokens: number;
		summary: string;
	};
}

// ── Field helpers ──────────────────────────────────────────────────

export function extractString(v: any): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return undefined;
}

	export function extractInt(v: any, fallback: number): number {
		const s = extractString(v);
		if (s === undefined) return fallback;
		const n = parseInt(s, 10);
		return Number.isFinite(n) ? n : fallback;
	}

	export function extractBool(v: any, fallback: boolean): boolean {
		const s = extractString(v);
		if (s === undefined) return fallback;
		return s === "true" || s === "1";
	}
export function extractMapEntries(v: any): Record<string, any> | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "object" && !Array.isArray(v)) return v;
	if (v.mapValue?.entries) return v.mapValue.entries;
	return undefined;
}

export function extractTools(toolsField: any): ToolSpec[] {
	const raw = extractString(toolsField);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as ToolSpec[];
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((t) => t && typeof t.name === "string" && typeof t.target_prefix === "string" && typeof t.target_action === "string");
	} catch {
		return [];
	}
}

export function encodeToolsField(
	tools: ToolSpec[],
	mapVal: ProgramContext["mapVal"],
	stringVal: ProgramContext["stringVal"],
) {
	return mapVal(
		tools.map((t) =>
			mapVal({
				name: stringVal(t.name),
				description: stringVal(t.description),
				input_schema: stringVal(JSON.stringify(t.input_schema)),
				target_prefix: stringVal(t.target_prefix),
				target_action: stringVal(t.target_action),
				...(t.bound_args
					? { bound_args: stringVal(JSON.stringify(t.bound_args)) }
					: {}),
			}),
		),
	);
}

export function extractCompactionConfig(fields: Record<string, any>): CompactionConfig {
	return {
		enabled: extractBool(fields?.compaction_enabled, true),
		contextWindow: extractInt(fields?.compaction_context_window, DEFAULT_COMPACTION_CONTEXT_WINDOW),
		reserveTokens: extractInt(fields?.compaction_reserve_tokens, DEFAULT_COMPACTION_RESERVE_TOKENS),
		keepRecentTokens: extractInt(fields?.compaction_keep_recent_tokens, DEFAULT_COMPACTION_KEEP_RECENT_TOKENS),
		model: extractString(fields?.compaction_model),
	};
}

export function safeJsonParse(s: string): unknown {
	try { return JSON.parse(s); } catch { return null; }
}

export async function doRegisterTool(agentId: string, spec: ToolSpec, ctx: ProgramContext): Promise<string> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);
	if (state.typeKey !== "agent") throw new Error(`Object ${agentId} is not an agent (typeKey=${state.typeKey})`);

	const existing = extractTools(state.fields?.tools);
	const filtered = existing.filter((t) => t.name !== spec.name);
	filtered.push(spec);

	const client = ctx.client as any;
	const actor = client.objectActor.getOrCreate([agentId]);
	const encoded = encodeToolsField(filtered, ctx.mapVal, ctx.stringVal);
	await actor.setField("tools", JSON.stringify(encoded));
	return `Registered tool '${spec.name}' → ${spec.target_prefix} ${spec.target_action}`;
}
