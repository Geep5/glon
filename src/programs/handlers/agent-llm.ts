// Agent LLM client — Anthropic and Kimi API wrappers.
//
// Extracted from agent.ts to reduce omnibus size. Contains no agent
// business logic — just credential resolution, request formatting,
// streaming, and response normalisation.

import type { ProgramContext } from "../runtime.js";

// ── Types shared with the agent layer ────────────────────────────

export type AnthropicContent =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface InferenceResult {
	content: AnthropicContent[];
	stopReason: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens?: number;
	cacheReadTokens?: number;
	reasoningContent?: string;
}

// Minimal tool-shape used for LLM requests (mirrors ToolSpec but avoids
// importing the agent-specific variant).
interface LlmToolSpec {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

// ── Claude Code impersonation constants ──────────────────────────

const CLAUDE_CODE_VERSION = "2.1.39";
const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_TOOL_PREFIX = "proxy_";
const CLAUDE_CODE_BETAS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"prompt-caching-scope-2026-01-05",
].join(",");

const CLAUDE_CODE_STAINLESS_HEADERS: Record<string, string> = {
	"X-Stainless-Helper-Method": "stream",
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime-Version": "v24.13.1",
	"X-Stainless-Package-Version": "0.73.0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Lang": "js",
	"X-Stainless-Arch": "arm64",
	"X-Stainless-Os": "MacOS",
	"X-Stainless-Timeout": "600",
};

// ── Credential types ─────────────────────────────────────────────

interface ResolvedAnthropicCredential {
	token: string;
	isOAuth: boolean;
}

interface ResolvedKimiCredential {
	token: string;
}

// ── Network utilities ────────────────────────────────────────────

function isTransientFetchError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	if (msg.includes("fetch failed")) return true;
	if (msg.includes("econnreset")) return true;
	if (msg.includes("econnrefused")) return true;
	if (msg.includes("etimedout")) return true;
	if (msg.includes("socket hang up")) return true;
	if (msg.includes("enotfound")) return true;
	return false;
}

async function fetchWithTransientRetry(url: string, opts: RequestInit, retryDelayMs = 1500): Promise<Response> {
	try {
		return await fetch(url, opts);
	} catch (err) {
		if (!isTransientFetchError(err)) throw err;
		await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		return await fetch(url, opts);
	}
}

// ── Credential resolution ────────────────────────────────────────

async function resolveAnthropicCredential(ctx: ProgramContext | undefined): Promise<ResolvedAnthropicCredential | null> {
	if (ctx) {
		try {
			const result = await ctx.dispatchProgram("/auth", "getAnthropic", []) as ResolvedAnthropicCredential | null;
			if (result?.token) return result;
		} catch {
			// /auth not loaded — fall through to env-var.
		}
	}
	const envKey = process.env.ANTHROPIC_API_KEY;
	if (envKey) return { token: envKey, isOAuth: false };
	return null;
}

async function resolveKimiCredential(ctx: ProgramContext | undefined): Promise<ResolvedKimiCredential | null> {
	if (ctx) {
		try {
			const result = await ctx.dispatchProgram("/auth", "getKimi", []) as ResolvedKimiCredential | null;
			if (result?.token) return result;
		} catch {
			// /auth not loaded — fall through to env-var.
		}
	}
	const envKey = process.env.KIMI_API_KEY;
	if (envKey) return { token: envKey };
	return null;
}

// ── Request builders ─────────────────────────────────────────────

function buildOAuthSystemBlocks(system: string | undefined): { type: "text"; text: string }[] {
	const userPrompt = (system ?? "").trim();
	if (userPrompt.includes(CLAUDE_CODE_SYSTEM_INSTRUCTION)) {
		return [{ type: "text", text: userPrompt }];
	}
	const blocks: { type: "text"; text: string }[] = [
		{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
	];
	if (userPrompt) blocks.push({ type: "text", text: userPrompt });
	return blocks;
}

function applyPromptCaching(body: Record<string, any>): void {
	const stamp = { type: "ephemeral" } as const;
	if (Array.isArray(body.system) && body.system.length > 0) {
		const tail = body.system[body.system.length - 1];
		if (tail && typeof tail === "object") tail.cache_control = stamp;
	}
	if (Array.isArray(body.tools) && body.tools.length > 0) {
		const tail = body.tools[body.tools.length - 1];
		if (tail && typeof tail === "object") tail.cache_control = stamp;
	}
	if (Array.isArray(body.messages) && body.messages.length > 0) {
		const lastIdx = body.messages.length - 1;
		const lastMsg = body.messages[lastIdx];
		if (!lastMsg || typeof lastMsg !== "object") return;
		let newContent: any;
		if (typeof lastMsg.content === "string") {
			newContent = [{ type: "text", text: lastMsg.content, cache_control: stamp }];
		} else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
			newContent = lastMsg.content.slice();
			newContent[newContent.length - 1] = { ...newContent[newContent.length - 1], cache_control: stamp };
		} else {
			return;
		}
		body.messages = body.messages.slice();
		body.messages[lastIdx] = { ...lastMsg, content: newContent };
	}
}

function safeJsonParse(s: string): unknown {
	try { return JSON.parse(s); } catch { return null; }
}

// ── Anthropic client ─────────────────────────────────────────────

export async function callAnthropic(
	messages: { role: string; content: string | AnthropicContent[] }[],
	system: string | undefined,
	model: string,
	temperature: number | undefined,
	tools: LlmToolSpec[] | undefined,
	onChunk: ((text: string) => void) | undefined,
	maxTokens?: number,
	ctx?: ProgramContext,
): Promise<InferenceResult> {
	const testFetch = (globalThis as any).__ANTHROPIC_FETCH as
		| undefined
		| ((req: { messages: any[]; tools?: any[]; system?: string; model: string; maxTokens?: number }) => Promise<InferenceResult>);
	if (testFetch) {
		return testFetch({ messages, tools, system, model, maxTokens });
	}

	const auth = await resolveAnthropicCredential(ctx);
	if (!auth) {
		throw new Error(
			"No Anthropic credentials. Run `/auth login anthropic` to use a Claude Pro/Max plan, " +
			"or set ANTHROPIC_API_KEY in your environment.",
		);
	}

	const stream = !!onChunk && !tools;

	const body: Record<string, any> = {
		model,
		max_tokens: maxTokens ?? 4096,
		messages,
		stream,
	};
	if (temperature !== undefined) body.temperature = temperature;

	if (auth.isOAuth) {
		body.system = buildOAuthSystemBlocks(system);
	} else if (typeof system === "string" && system.length > 0) {
		body.system = [{ type: "text", text: system }];
	}

	if (tools && tools.length > 0) {
		body.tools = tools.map((t) => ({
			name: auth.isOAuth ? `${CLAUDE_CODE_TOOL_PREFIX}${t.name}` : t.name,
			description: t.description,
			input_schema: t.input_schema,
		}));
	}

	applyPromptCaching(body);

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (auth.isOAuth) {
		headers["Authorization"] = `Bearer ${auth.token}`;
		headers["anthropic-beta"] = CLAUDE_CODE_BETAS;
		headers["User-Agent"] = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
		headers["X-App"] = "cli";
		for (const [k, v] of Object.entries(CLAUDE_CODE_STAINLESS_HEADERS)) headers[k] = v;
	} else {
		headers["x-api-key"] = auth.token;
	}

	const doFetch = () => fetchWithTransientRetry("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});

	let res = await doFetch();

	if (!res.ok && res.status === 401 && auth.isOAuth && ctx) {
		try {
			const refreshed = await ctx.dispatchProgram("/auth", "refreshAnthropic", []) as ResolvedAnthropicCredential | null;
			if (refreshed?.token && refreshed.isOAuth) {
				headers["Authorization"] = `Bearer ${refreshed.token}`;
				res = await doFetch();
			}
		} catch {
			// Fall through to the original 401 handling.
		}
	}

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Anthropic API ${res.status}: ${text}`);
	}

	if (stream) {
		let textAccum = "";
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheCreationTokens = 0;
		let cacheReadTokens = 0;
		const decoder = new TextDecoder();
		const reader = res.body!.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			for (const line of chunk.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6);
				if (data === "[DONE]") continue;
				try {
					const parsed = JSON.parse(data);
					if (parsed.type === "content_block_delta") {
						const t = parsed.delta?.text;
						if (t) { textAccum += t; onChunk!(t); }
					} else if (parsed.type === "message_start") {
						inputTokens = parsed.message?.usage?.input_tokens ?? 0;
						cacheCreationTokens = parsed.message?.usage?.cache_creation_input_tokens ?? 0;
						cacheReadTokens = parsed.message?.usage?.cache_read_input_tokens ?? 0;
					} else if (parsed.type === "message_delta") {
						outputTokens = parsed.usage?.output_tokens ?? 0;
					}
				} catch { /* ignore */ }
			}
		}
		return {
			content: textAccum ? [{ type: "text", text: textAccum }] : [],
			stopReason: "end_turn",
			model,
			inputTokens,
			outputTokens,
			cacheCreationTokens,
			cacheReadTokens,
		};
	}

	const data = await res.json() as any;
	const rawContent: any[] = Array.isArray(data.content) ? data.content : [];
	const content: AnthropicContent[] = rawContent.map((c) => {
		if (auth.isOAuth && c?.type === "tool_use" && typeof c.name === "string" && c.name.startsWith(CLAUDE_CODE_TOOL_PREFIX)) {
			return { ...c, name: c.name.slice(CLAUDE_CODE_TOOL_PREFIX.length) } as AnthropicContent;
		}
		return c as AnthropicContent;
	});

	return {
		content,
		stopReason: data.stop_reason ?? "end_turn",
		model: data.model ?? model,
		inputTokens: data.usage?.input_tokens ?? 0,
		outputTokens: data.usage?.output_tokens ?? 0,
		cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? 0,
		cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
	};
}

// ── Kimi (Moonshot) client ───────────────────────────────────────

function anthropicMessagesToOpenAI(
	messages: { role: string; content: string | AnthropicContent[] }[],
): { role: string; content?: string; tool_calls?: any[]; tool_call_id?: string }[] {
	const out: { role: string; content?: string; tool_calls?: any[]; tool_call_id?: string }[] = [];
	for (const msg of messages) {
		if (typeof msg.content === "string") {
			out.push({ role: msg.role, content: msg.content });
			continue;
		}
		const textParts: string[] = [];
		const toolCalls: any[] = [];
		const toolResults: { role: "tool"; tool_call_id: string; content: string }[] = [];
		for (const c of msg.content) {
			if (c.type === "text") {
				textParts.push(c.text);
			} else if (c.type === "tool_use") {
				toolCalls.push({
					id: c.id,
					type: "function",
					function: { name: c.name, arguments: JSON.stringify(c.input) },
				});
			} else if (c.type === "tool_result") {
				toolResults.push({ role: "tool", tool_call_id: c.tool_use_id, content: c.content });
			}
		}
		if (msg.role === "assistant") {
			const openAiMsg: any = { role: "assistant" };
			if (textParts.length > 0) openAiMsg.content = textParts.join("");
			if (toolCalls.length > 0) openAiMsg.tool_calls = toolCalls;
			// Moonshot requires reasoning_content on all assistant messages when
			// thinking is enabled for the model (even if empty).
			openAiMsg.reasoning_content = (msg as any).reasoningContent ?? "";
			out.push(openAiMsg);
		} else {
			out.push(...toolResults);
			if (textParts.length > 0) {
				out.push({ role: "user", content: textParts.join("") });
			}
		}
	}
	return out;
}

export async function callKimi(
	messages: { role: string; content: string | AnthropicContent[] }[],
	system: string | undefined,
	model: string,
	temperature: number | undefined,
	tools: LlmToolSpec[] | undefined,
	onChunk: ((text: string) => void) | undefined,
	maxTokens: number | undefined,
	ctx: ProgramContext,
): Promise<InferenceResult> {
	const auth = await resolveKimiCredential(ctx);
	if (!auth) {
		throw new Error(
			`No credentials for model "${model}". Run \`/auth login kimi <key>\` or set KIMI_API_KEY.`,
		);
	}

	const stream = !!onChunk && !tools;
	const openAiMessages = anthropicMessagesToOpenAI(messages);
	if (system) {
		openAiMessages.unshift({ role: "system", content: system });
	}

	const body: Record<string, any> = {
		model,
		messages: openAiMessages,
		stream,
	};
	if (maxTokens !== undefined) body.max_tokens = maxTokens;
	if (temperature !== undefined) body.temperature = temperature;
	if (tools && tools.length > 0) {
		body.tools = tools.map((t) => ({
			type: "function",
			function: {
				name: t.name,
				description: t.description,
				parameters: t.input_schema,
			},
		}));
	}

	const isKimiCodingKey = auth.token.startsWith("sk-kimi-");
	const kimiBaseUrl = isKimiCodingKey ? "https://api.kimi.com/coding" : "https://api.moonshot.cn";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"Authorization": `Bearer ${auth.token}`,
	};
	if (isKimiCodingKey) {
		headers["User-Agent"] = "KimiCLI/1.0.0";
		headers["X-Msh-Platform"] = "kimi_cli";
		headers["X-Msh-Version"] = "1.0.0";
		headers["X-Msh-Device-Name"] = "glon";
		headers["X-Msh-Device-Model"] = "Linux";
		headers["X-Msh-Os-Version"] = "linux";
		headers["X-Msh-Device-Id"] = "glon-agent-001";
	}

	const bodyJson = JSON.stringify(body);
	const res = await fetchWithTransientRetry(`${kimiBaseUrl}/v1/chat/completions`, {
		method: "POST",
		headers,
		body: bodyJson,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Kimi API ${res.status}: ${text}`);
	}

	if (stream) {
		let textAccum = "";
		let reasoningAccum = "";
		let inputTokens = 0;
		let outputTokens = 0;
		const decoder = new TextDecoder();
		const reader = res.body!.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			for (const line of chunk.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6);
				if (data === "[DONE]") continue;
				try {
					const parsed = JSON.parse(data);
					const delta = parsed.choices?.[0]?.delta;
					if (delta?.content) {
						textAccum += delta.content;
						onChunk!(delta.content);
					}
					if (delta?.reasoning_content) {
						reasoningAccum += delta.reasoning_content;
					}
					if (parsed.usage?.prompt_tokens) {
						inputTokens = parsed.usage.prompt_tokens;
					}
					if (parsed.usage?.completion_tokens) {
						outputTokens = parsed.usage.completion_tokens;
					}
				} catch { /* ignore */ }
			}
		}
		return {
			content: textAccum ? [{ type: "text", text: textAccum }] : [],
			stopReason: "end_turn",
			model,
			inputTokens,
			outputTokens,
			reasoningContent: reasoningAccum || undefined,
		};
	}

	const data = await res.json() as any;
	const choice = data.choices?.[0];
	const message = choice?.message ?? {};
	const content: AnthropicContent[] = [];
	if (message.content) {
		content.push({ type: "text", text: message.content });
	} else if (message.reasoning_content) {
		// Some models (Kimi with thinking) return reasoning but no content.
		// Fall back to reasoning so callers don't get empty responses.
		content.push({ type: "text", text: message.reasoning_content });
	}
	for (const tc of message.tool_calls ?? []) {
		if (tc.type === "function") {
			content.push({
				type: "tool_use",
				id: tc.id,
				name: tc.function?.name ?? "",
				input: (safeJsonParse(tc.function?.arguments ?? "{}") as Record<string, unknown>) ?? {},
			});
		}
	}
	const finishReason = choice?.finish_reason;
	const stopReason = finishReason === "tool_calls" ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn";
	return {
		content,
		stopReason,
		model: data.model ?? model,
		inputTokens: data.usage?.prompt_tokens ?? 0,
		outputTokens: data.usage?.completion_tokens ?? 0,
		reasoningContent: message.reasoning_content,
	};
}

// ── Provider registry ────────────────────────────────────────────
//
// Each provider declares how to match its models, how to check whether
// it has credentials, a default model to fall back to, and the call fn.
// Adding a new provider is one entry plus a `call*` implementation.

type LlmCallFn = (
	messages: { role: string; content: string | AnthropicContent[] }[],
	system: string | undefined,
	model: string,
	temperature: number | undefined,
	tools: LlmToolSpec[] | undefined,
	onChunk: ((text: string) => void) | undefined,
	maxTokens: number | undefined,
	ctx: ProgramContext,
) => Promise<InferenceResult>;

export interface ProviderSpec {
	name: string;
	envVar: string;
	authAction: string;
	matchesModel: (model: string) => boolean;
	hasCredentials: (ctx: ProgramContext | undefined) => Promise<boolean>;
	defaultModel: () => string;
	call: LlmCallFn;
}

const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-20250514";
const KIMI_DEFAULT_MODEL = "kimi-k2-0905-preview";

export const PROVIDERS: ProviderSpec[] = [
	{
		name: "anthropic",
		envVar: "ANTHROPIC_API_KEY",
		authAction: "/auth login anthropic",
		matchesModel: (m) => m.startsWith("claude-"),
		hasCredentials: async (ctx) => !!(await resolveAnthropicCredential(ctx)),
		defaultModel: () => process.env.ANTHROPIC_DEFAULT_MODEL ?? ANTHROPIC_DEFAULT_MODEL,
		call: callAnthropic,
	},
	{
		name: "kimi",
		envVar: "KIMI_API_KEY",
		authAction: "/auth login kimi <api-key>",
		matchesModel: (m) => m.startsWith("kimi-") || m.startsWith("moonshot"),
		hasCredentials: async (ctx) => !!(await resolveKimiCredential(ctx)),
		defaultModel: () => process.env.KIMI_DEFAULT_MODEL ?? KIMI_DEFAULT_MODEL,
		call: callKimi,
	},
];

/** Provider status for diagnostics — credential presence + default model. */
export interface ProviderStatus {
	name: string;
	available: boolean;
	envVar: string;
	envVarSet: boolean;
	authPath: "env" | "auth.json" | null;
	defaultModel: string;
	authAction: string;
}

/** Survey every registered provider; tells caller which are usable.
 *  Reports `authPath="env"` when the credential came from an env var,
 *  `"auth.json"` when only the auth-program file has it. Env is checked
 *  first so we don't mis-label env-only setups.
 */
export async function listAvailableProviders(ctx?: ProgramContext): Promise<ProviderStatus[]> {
	const out: ProviderStatus[] = [];
	for (const p of PROVIDERS) {
		const envVarSet = !!process.env[p.envVar];
		let authPath: ProviderStatus["authPath"] = null;
		let available = false;
		if (envVarSet) { authPath = "env"; available = true; }
		if (!available && ctx) {
			try {
				const fromAuth = await ctx.dispatchProgram("/auth", p.name === "anthropic" ? "getAnthropic" : "getKimi", []) as { token?: string } | null;
				if (fromAuth?.token) { authPath = "auth.json"; available = true; }
			} catch { /* /auth not loaded */ }
		}
		out.push({
			name: p.name,
			available,
			envVar: p.envVar,
			envVarSet,
			authPath,
			defaultModel: p.defaultModel(),
			authAction: p.authAction,
		});
	}
	return out;
}

/** Result of resolving which provider should serve a given model request. */
export interface PickedProvider {
	provider: ProviderSpec;
	model: string;
	swapped: boolean;
	reason?: string;
}

/**
 * Pick the provider that will actually handle a request. If the model's
 * "native" provider has credentials, use it. Otherwise, fall back to the
 * first provider with credentials, using its default model. Throws if
 * nothing is configured.
 *
 * Exported so tests and the /agent.providers action can inspect the
 * decision without making a request.
 */
export async function pickProvider(requestedModel: string, ctx: ProgramContext | undefined): Promise<PickedProvider> {
	const intended = PROVIDERS.find((p) => p.matchesModel(requestedModel));
	if (intended && await intended.hasCredentials(ctx)) {
		return { provider: intended, model: requestedModel, swapped: false };
	}
	for (const p of PROVIDERS) {
		if (p === intended) continue;
		if (await p.hasCredentials(ctx)) {
			const reason = intended
				? `requested ${requestedModel} (${intended.name}) but no ${intended.envVar} or auth.json entry; using ${p.name}`
				: `unknown model ${requestedModel}; falling back to first configured provider (${p.name})`;
			return { provider: p, model: p.defaultModel(), swapped: true, reason };
		}
	}
	const tried = PROVIDERS.map((p) => `${p.envVar} or \`${p.authAction}\``).join(" / ");
	throw new Error(
		`No LLM credentials configured for any provider. Set one of: ${tried}.`,
	);
}

// ── Unified LLM dispatcher ───────────────────────────────────────

export async function callLLM(
	messages: { role: string; content: string | AnthropicContent[] }[],
	system: string | undefined,
	model: string,
	temperature: number | undefined,
	tools: LlmToolSpec[] | undefined,
	onChunk: ((text: string) => void) | undefined,
	maxTokens: number | undefined,
	ctx: ProgramContext,
): Promise<InferenceResult> {
	// Unified test stub — intercepts before provider dispatch.
	const testFetch = (globalThis as any).__LLM_FETCH as
		| undefined
		| ((req: { messages: any[]; tools?: any[]; system?: string; model: string; maxTokens?: number }) => Promise<InferenceResult>);
	if (testFetch) {
		return testFetch({ messages, tools, system, model, maxTokens });
	}

	const picked = await pickProvider(model, ctx);
	if (picked.swapped && picked.reason) {
		ctx?.print?.(`[agent-llm] ${picked.reason}`);
	}
	return picked.provider.call(messages, system, picked.model, temperature, tools, onChunk, maxTokens, ctx);
}

// ── Error classification ─────────────────────────────────────────

export function isContextOverflowError(err: any): boolean {
	const msg = err?.message ?? String(err ?? "");
	return /too long|context length|prompt is too long|context_length_exceeded|context window|max context/i.test(msg);
}
