// Agent runner — ReAct loop, steering, status, and recall.
//
// Extracted from agent.ts to reduce omnibus size. Owns the per-agent
// run coordination (steering), the model loop, and follow-up hooks.

import type { ProgramContext } from "../runtime.js";
import {
	AnthropicContent,
	InferenceResult,
	callLLM,
	isContextOverflowError,
} from "./agent-llm.js";
import {
	ToolSpec,
	AskResult,
	FollowUpHookContext,
	FollowUpHook,
	AgentStatus,
	PendingSteerer,
	RunSlot,
	CompactionConfig,
	ClassifiedItem,
	extractString,
	extractInt,
	extractBool,
	extractTools,
	extractCompactionConfig,
	DEFAULT_MODEL,
	DEFAULT_MAX_TOOL_ITERATIONS,
	TOOL_RESULT_TRUNCATE,
	TOOL_RESULT_TRUNCATE_FOR_SUMMARY,
	SUMMARY_MAX_TOKENS,
	SUMMARY_TEMPERATURE,
	DEFAULT_COMPACTION_CONTEXT_WINDOW,
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
	BLOCK_TOOL_USE,
	BLOCK_TOOL_RESULT,
	BLOCK_COMPACTION_SUMMARY,
	STYLE_USER,
	STYLE_ASSISTANT,
	CHARS_PER_TOKEN,
	safeJsonParse,
	doRegisterTool,
} from "./agent-types.js";
import {
	classifyBlocks,
	findLatestCompaction,
	buildConversationView,
	estimateAskTokens,
	textBlock,
	toolUseBlock,
	toolResultBlock,
	compactionBlock,
} from "./agent-conversation.js";
import { doCompact } from "./agent-compaction.js";

export async function doUnregisterTool(agentId: string, toolName: string, ctx: ProgramContext): Promise<string> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);

	const existing = extractTools(state.fields?.tools);
	const filtered = existing.filter((t) => t.name !== toolName);
	if (filtered.length === existing.length) return `No tool named '${toolName}' registered`;

	const client = ctx.client as any;
	const actor = client.objectActor.getOrCreate([agentId]);
	const encoded = encodeToolsField(filtered, ctx.mapVal, ctx.stringVal);
	await actor.setField("tools", JSON.stringify(encoded));
	return `Unregistered '${toolName}' (${filtered.length} tool(s) remain)`;
}

export async function doListTools(agentId: string, ctx: ProgramContext): Promise<ToolSpec[]> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);
	return extractTools(state.fields?.tools);
}


export async function doStatus(agentId: string, ctx: ProgramContext): Promise<AgentStatus> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);
	if (state.typeKey !== "agent") throw new Error(`Object ${agentId} is not an agent`);

	const items = classifyBlocks(state.blocks ?? [], state.blockProvenance ?? {});
	const latest = findLatestCompaction(items);
	const view = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});
	const config = extractCompactionConfig(state.fields ?? {});
	const threshold = config.contextWindow - config.reserveTokens;

	const memoryDigest = await resolveMemoryDigest(agentId, ctx);
	const estimatedTokens = estimateAskTokens(state, view, memoryDigest);

	return {
		id: agentId,
		name: extractString(state.fields?.name) ?? "agent",
		model: extractString(state.fields?.model) ?? DEFAULT_MODEL,
		system: extractString(state.fields?.system),
		tools: extractTools(state.fields?.tools).length,
		blockCount: items.length,
		effectiveTurns: view.turns.length,
		estimatedTokens,
		compaction: {
			config,
			threshold,
			lastCompaction: latest ? {
				blockId: latest.blockId,
				firstKeptBlockId: latest.firstKeptBlockId,
				tokensBefore: latest.tokensBefore,
				turnCount: latest.turnCount,
				createdAt: latest.timestamp,
			} : undefined,
		},
	};
}


export function mergeAskResults(a: AskResult, b: AskResult): AskResult {
	return {
		iterations: a.iterations + b.iterations,
		toolCalls: a.toolCalls + b.toolCalls,
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		compactedBeforeAsk: a.compactedBeforeAsk || b.compactedBeforeAsk,
		compactedOnOverflow: a.compactedOnOverflow || b.compactedOnOverflow,
		finalText: b.finalText ? b.finalText : a.finalText,
		followUpAttempts: a.followUpAttempts + b.followUpAttempts,
	};
}


export function makeTodoFollowUpHook(opts?: { maxAttempts?: number }): FollowUpHook {
	const max = opts?.maxAttempts ?? 3;
	return async ({ agentId, ctx, attempt }) => {
		if (attempt >= max) return null;
		let summary: { phases: { name: string; tasks: { id: string; content: string; status: string }[] }[]; total: number };
		try {
			summary = (await ctx.dispatchProgram("/todo", "incomplete", [{ owner: agentId }])) as typeof summary;
		} catch {
			return null;
		}
		if (!summary || summary.total === 0) return null;

		const formatted = summary.phases
			.map((p) => {
				const tasks = p.tasks.map((t) => `  - ${t.content} [${t.status}]`).join("\n");
				return `- ${p.name}\n${tasks}`;
			})
			.join("\n");
		const text =
			`<system-reminder>\n` +
			`You stopped with ${summary.total} incomplete todo item(s):\n${formatted}\n\n` +
			`Please continue working on these tasks. When a task is finished, mark it ` +
			`completed via the \`todo_write\` tool ({op: "update", id: "task-N", status: "completed"}). ` +
			`If a task is no longer needed, mark it abandoned. Do not stop until every task is in a terminal state.\n` +
			`(Reminder ${attempt + 1}/${max})\n` +
			`</system-reminder>`;
		return { text };
	};
}


const FIELD_MEMORY_DIGEST_ENABLED = "memory_digest_enabled";

export async function resolveMemoryDigest(agentId: string, ctx: ProgramContext): Promise<string | undefined> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) return undefined;
	if (!extractBool(state.fields?.[FIELD_MEMORY_DIGEST_ENABLED], false)) return undefined;
	try {
		const raw = await ctx.dispatchProgram("/memory", "digest", [{ owner: agentId }]);
		return typeof raw === "string" && raw.length > 0 ? raw : undefined;
	} catch {
		return undefined;
	}
}


export function buildEffectiveSystem(
	base: string | undefined,
	extension: string | undefined,
	memoryDigest?: string,
): string | undefined {
	const parts: string[] = [];
	if (base) parts.push(base);
	if (extension) parts.push(`<conversation-summary>\n${extension}\n</conversation-summary>`);
	if (memoryDigest) parts.push(memoryDigest);
	return parts.length === 0 ? undefined : parts.join("\n\n");
}


export async function shouldAutoCompact(agentId: string, ctx: ProgramContext): Promise<boolean> {
	const store = ctx.store as any;
	const state = await store.get(agentId);
	if (!state) return false;
	const config = extractCompactionConfig(state.fields ?? {});
	if (!config.enabled) return false;

	const view = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});
	const memoryDigest = await resolveMemoryDigest(agentId, ctx);
	const est = estimateAskTokens(state, view, memoryDigest);
	return est > config.contextWindow - config.reserveTokens;
}


 const runSlots = new Map<string, RunSlot>();
 

export function ensureSlot(agentId: string): RunSlot {
 	let slot = runSlots.get(agentId);
 	if (!slot) {
		slot = { running: false, pending: [] };
 		runSlots.set(agentId, slot);
 	}
 	return slot;
 }
 

export function hasAssistantTextAfter(blocks: any[], userBlockId: string): boolean {
 	const idx = blocks.findIndex((b) => b.id === userBlockId);
 	if (idx < 0) return false;
 	for (let i = idx + 1; i < blocks.length; i++) {
 		const text = blocks[i].content?.text;
 		if (!text) continue;
 		if ((text.style ?? 0) === STYLE_ASSISTANT) return true;
 	}
 	return false;
 }
 

export function computeAssistantSlice(blocks: any[], userBlockId: string): string {
 	const idx = blocks.findIndex((b) => b.id === userBlockId);
 	if (idx < 0) return "";
 	const out: string[] = [];
 	let foundAssistant = false;
 	for (let i = idx + 1; i < blocks.length; i++) {
 		const text = blocks[i].content?.text;
 		if (!text) continue;
 		const style = text.style ?? 0;
 		if (style === STYLE_USER) {
 			if (foundAssistant) break;
 			continue;
 		}
 		if (style === STYLE_ASSISTANT) {
 			out.push(text.text);
 			foundAssistant = true;
 		}
 	}
 	return out.join("\n\n");
 }
 

export async function runAsk(
 	agentId: string,
 	prompt: string,
 	ctx: ProgramContext,
 	opts: { printStream?: boolean; followUpHook?: FollowUpHook } = {},
 ): Promise<AskResult> {
 	const slot = ensureSlot(agentId);
 	const userBlockId = ctx.randomUUID();
 	const actor = (ctx.client as any).objectActor.getOrCreate([agentId]);

	// Synchronous lock decision. Single-threaded JS guarantees no other
	// caller can interleave between the read and the write.
	const isRunner = !slot.running;

 	if (!isRunner) {
 		// Steerer path: commit the user block, then park on a promise the
 		// runner will resolve from runLoop's tail.
 		await actor.addBlock(JSON.stringify(textBlock(userBlockId, prompt, STYLE_USER)));
 		return new Promise<AskResult>((resolve, reject) => {
 			slot.pending.push({ userBlockId, resolve, reject });
 		});
 	}

	// Runner path. The runner does NOT join slot.pending — their result is
	// returned directly from runLoop. Only late steerers ride pending.
	slot.running = true;
	await actor.addBlock(JSON.stringify(textBlock(userBlockId, prompt, STYLE_USER)));

	try {
		let aggregate: AskResult | null = null;
		let currentUserBlockId = userBlockId;
		let followUpAttempt = 0;

		// Outer follow-up loop. After each runLoop call, if a follow-up hook
		// provides text, commit it as a fresh user_text block and re-enter
		// runLoop with it as the new "originalUserBlockId" for attribution.
		while (true) {
			let result: AskResult;
			// Inner straggler loop (existing behavior): drain late steerers
			// pushed between runLoop's last pending check and its return.
			while (true) {
				result = await runLoop(agentId, currentUserBlockId, slot, ctx, opts);
				if (slot.pending.length === 0) break;
			}

			aggregate = aggregate ? mergeAskResults(aggregate, result) : result;

			if (!opts.followUpHook) return aggregate;

			let followUp: { text: string } | null | undefined;
			try {
				followUp = await opts.followUpHook({
					agentId,
					ctx,
					attempt: followUpAttempt,
					lastResult: result,
				});
			} catch {
				// A throwing hook MUST NOT take the conversation down. Treat
				// it as "no follow-up" and finish the ask.
				return aggregate;
			}

			if (!followUp || !followUp.text) return aggregate;

			// Commit the follow-up as a regular user_text block. From the
			// model's POV it's just another user turn. From a peer's POV
			// the DAG records exactly what was sent. Worth surfacing to
			// the user via the existing print stream so they see the
			// continuation isn't a hallucination.
			const followUpBlockId = ctx.randomUUID();
			await actor.addBlock(JSON.stringify(textBlock(followUpBlockId, followUp.text, STYLE_USER)));
			aggregate = { ...aggregate, followUpAttempts: aggregate.followUpAttempts + 1 };
			currentUserBlockId = followUpBlockId;
			followUpAttempt++;
		}
	} catch (err: any) {
		// Propagate the error to any steerer waiting on a result and to the
		// runner's caller (via this throw).
		const stragglers = slot.pending.splice(0);
		for (const p of stragglers) p.reject(err instanceof Error ? err : new Error(String(err)));
		throw err;
	} finally {
		slot.running = false;
		if (slot.pending.length === 0) runSlots.delete(agentId);
	}
 }
 

export async function runLoop(
	agentId: string,
	originalUserBlockId: string,
	slot: RunSlot,
	ctx: ProgramContext,
	opts: { printStream?: boolean },
): Promise<AskResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const { randomUUID, print } = ctx;

	let compactedBeforeAsk = false;
	let compactedOnOverflow = false;

	// Pre-flight auto-compact. Re-evaluates current context size every time
	// runLoop is invoked; if the runner re-enters the loop for a late
	// straggler (extremely rare race), the second call gets a fresh check.
	if (await shouldAutoCompact(agentId, ctx)) {
		const res = await doCompact(agentId, undefined, ctx);
		compactedBeforeAsk = res.compacted;
	}

	let state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);
	if (state.typeKey !== "agent") throw new Error(`Object ${agentId} is not an agent`);

	const baseSystem = extractString(state.fields?.["system"]);
	const model = extractString(state.fields?.["model"]) || DEFAULT_MODEL;
	const tempStr = extractString(state.fields?.["temperature"]);
	const temperature = tempStr ? parseFloat(tempStr) : undefined;
	const tools = extractTools(state.fields?.["tools"]);
	const maxToolIterations = extractInt(state.fields?.["max_tool_iterations"], DEFAULT_MAX_TOOL_ITERATIONS);

	const actor = client.objectActor.getOrCreate([agentId]);

	// Initial messages: compaction-aware translation of every block already
	// in the DAG. From this point we maintain `messages` incrementally so
	// the temporal order the model sees mirrors the order the runner
	// produced it — not the order the DAG happens to record (steered
	// user blocks can land between a model call's submit and its response,
	// so DAG-order rebuilds would interleave them incorrectly).
	const initialView = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});
	const initialMemoryDigest = await resolveMemoryDigest(agentId, ctx);
	let effectiveSystem = buildEffectiveSystem(baseSystem, initialView.systemExtension, initialMemoryDigest);
	const messages: { role: string; content: string | AnthropicContent[] }[] = initialView.turns.map((t) => ({
		role: t.role,
		content: t.content,
	}));

	// Track every block already represented in `messages`. Anything in the
	// DAG that isn't in this set at the top of an iteration is new — in
	// practice that means a steered user_text block from another caller.
	const incorporatedBlockIds = new Set<string>();
	for (const b of state.blocks ?? []) incorporatedBlockIds.add(b.id);

	// Per-iteration attribution. We track which iteration first submitted each
	// pending user_block to the model, and the assistant text emitted at each
	// iteration. At run-end, every pending caller's slice is determined by
	// the first text-emitting iteration whose batch (users submitted since
	// the previous text-emitting iteration) includes them. This produces:
	//   - co-drained users (submitted in same batch) share the response,
	//   - tool-loop interruptions: the steerer's batch extends through tool
	//     iterations until the model finally emits text addressing all of them,
	//   - the original caller's slice is computed by the same rule.
	const firstSubmittedAtIter = new Map<string, number>();
	const iterationTexts = new Map<number, string>();
	const addressedUserBlockIds = new Set<string>();

	let iterations = 0;
	let toolCalls = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheCreationTokens = 0;
	let totalCacheReadTokens = 0;
	let lastRoundHadTools = false;

	while (true) {
		if (iterations >= maxToolIterations) {
			throw new Error(`Tool-use loop exceeded ${maxToolIterations} iterations`);
		}

		// Cancel signal (set externally via /agent.cancel or by a parent
		// during a subagent run).
		state = await store.get(agentId);
		if (state && extractString(state.fields?.cancel_requested) === "true") {
			throw new Error("cancelled: cancel_requested was set on this agent");
		}

		// Drain new user_text blocks committed since last iteration. These
		// are steered messages from other callers — their addBlock landed in
		// the DAG, but they aren't in `messages` yet. Append as a fresh user
		// turn (or merge with the previous user turn if that turn was also
		// pure user content; this happens when a steerer arrives before the
		// runner has emitted any assistant_text).
		const newUserBlocks: { id: string; text: string }[] = [];
		for (const block of state?.blocks ?? []) {
			if (incorporatedBlockIds.has(block.id)) continue;
			const text = block.content?.text;
			if (!text) continue;
			if ((text.style ?? 0) !== STYLE_USER) continue;
			newUserBlocks.push({ id: block.id, text: text.text });
		}
		if (newUserBlocks.length > 0) {
			const joined = newUserBlocks.map((b) => b.text).join("\n\n");
			const last = messages[messages.length - 1];
			if (last && last.role === "user" && typeof last.content === "string") {
				last.content = last.content + "\n\n" + joined;
			} else if (last && last.role === "user" && Array.isArray(last.content)) {
				last.content.push({ type: "text", text: joined });
			} else {
				messages.push({ role: "user", content: joined });
			}
			for (const b of newUserBlocks) incorporatedBlockIds.add(b.id);
		}

		// Decide whether another model round is needed: only break if no
		// pending steerer is still waiting on the model to address them.
		if (!lastRoundHadTools) {
			// Runner needs to be addressed too. Their userBlockId isn't in
			// slot.pending, but we still owe them a slice.
			const runnerNeedsAnswer = !addressedUserBlockIds.has(originalUserBlockId);
			const hasUnaddressed = runnerNeedsAnswer || slot.pending.some(
				(p) => !addressedUserBlockIds.has(p.userBlockId),
			);
			if (!hasUnaddressed) break;
		}

		iterations++;

		// Record submission iteration. The runner's userBlockId is incorporated
		// from the initial view; we ensure it's tracked here. Steerers added
		// to slot.pending are also tracked.
		if (!firstSubmittedAtIter.has(originalUserBlockId)) {
			firstSubmittedAtIter.set(originalUserBlockId, iterations);
		}
		for (const p of slot.pending) {
			if (!firstSubmittedAtIter.has(p.userBlockId) && incorporatedBlockIds.has(p.userBlockId)) {
				firstSubmittedAtIter.set(p.userBlockId, iterations);
			}
		}

		let streamBuffer = "";
		const canStream = opts.printStream && tools.length === 0;
		const onChunk = canStream
			? (text: string) => {
				streamBuffer += text;
				const lines = streamBuffer.split("\n");
				for (let i = 0; i < lines.length - 1; i++) print(`  ${lines[i]}`);
				streamBuffer = lines[lines.length - 1];
			}
			: undefined;

		let result: InferenceResult;
		try {
			result = await callLLM(messages, effectiveSystem, model, temperature, tools.length > 0 ? tools : undefined, onChunk, undefined, ctx);
		} catch (err: any) {
			if (iterations === 1 && !compactedOnOverflow && isContextOverflowError(err)) {
				// Overflow recovery: compact, then rebuild messages from the
				// new (smaller) DAG view and retry. Steered user blocks added
				// before this point are preserved — they're still in the DAG
				// and the rebuild picks them up.
				await doCompact(agentId, undefined, ctx);
				compactedOnOverflow = true;
				state = await store.get(agentId);
				const reView = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});
				const reDigest = await resolveMemoryDigest(agentId, ctx);
				effectiveSystem = buildEffectiveSystem(baseSystem, reView.systemExtension, reDigest);
				messages.length = 0;
				for (const t of reView.turns) messages.push({ role: t.role, content: t.content });
				incorporatedBlockIds.clear();
				for (const b of state.blocks ?? []) incorporatedBlockIds.add(b.id);
				iterations--;
				continue;
			}
			throw err;
		}

		if (canStream && streamBuffer) print(`  ${streamBuffer}`);
		totalInputTokens += result.inputTokens;
		totalOutputTokens += result.outputTokens;
		totalCacheCreationTokens += result.cacheCreationTokens ?? 0;
		totalCacheReadTokens += result.cacheReadTokens ?? 0;

		const assistantText = result.content
			.filter((c): c is Extract<AnthropicContent, { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("");
		const toolUses = result.content.filter(
			(c): c is Extract<AnthropicContent, { type: "tool_use" }> => c.type === "tool_use",
		);

		// Append the assistant message (text + tool_uses) to local messages.
		if (result.content.length > 0) {
			messages.push({ role: "assistant", content: result.content, reasoningContent: result.reasoningContent });
		}

		// Persist to DAG and record text-emitting iterations for attribution.
		if (assistantText) {
			const id = randomUUID();
			await actor.addBlock(JSON.stringify(textBlock(id, assistantText, STYLE_ASSISTANT)));
			incorporatedBlockIds.add(id);
			iterationTexts.set(iterations, assistantText);
			// Mark every user (runner + pending) submitted up to this iteration
			// as addressed. They share this iteration's text if they were
			// submitted since the previous text-emitting iteration.
			for (const [blockId, fi] of firstSubmittedAtIter) {
				if (fi <= iterations) addressedUserBlockIds.add(blockId);
			}
		}
		for (const tu of toolUses) {
			const id = randomUUID();
			await actor.addBlock(JSON.stringify(toolUseBlock(id, tu.id, tu.name, tu.input)));
			incorporatedBlockIds.add(id);
		}

		if (toolUses.length === 0) {
			lastRoundHadTools = false;
			// Loop's top will recheck pending and break if all are addressed,
			// or drain a steered prompt and run another iteration.
			continue;
		}

		// Run tools sequentially. Each tool_result is appended to a fresh
		// user-role turn (per the Anthropic API contract: tool_result blocks
		// must follow their corresponding tool_use in the next user turn).
		const toolResults: AnthropicContent[] = [];
		for (const tu of toolUses) {
			toolCalls++;
			const tool = tools.find((t) => t.name === tu.name);
			let contentText: string;
			let isError = false;
			if (!tool) {
				contentText = `Tool '${tu.name}' is not registered on this agent`;
				isError = true;
			} else {
				try {
					const dispatchInput = tool.bound_args && Object.keys(tool.bound_args).length > 0
						? { ...(tu.input ?? {}), ...tool.bound_args }
						: tu.input;
					const raw = await ctx.dispatchProgram(tool.target_prefix, tool.target_action, [dispatchInput]);
					contentText = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
				} catch (err: any) {
					contentText = `Error: ${err?.message ?? String(err)}`;
					isError = true;
				}
			}
			if (contentText.length > TOOL_RESULT_TRUNCATE) {
				contentText = contentText.slice(0, TOOL_RESULT_TRUNCATE) + `\n…[truncated, ${contentText.length - TOOL_RESULT_TRUNCATE} bytes omitted]`;
			}
			toolResults.push({
				type: "tool_result",
				tool_use_id: tu.id,
				content: contentText,
				is_error: isError,
			});
			const id = randomUUID();
			await actor.addBlock(JSON.stringify(toolResultBlock(id, tu.id, contentText, isError)));
			incorporatedBlockIds.add(id);
		}
		messages.push({ role: "user", content: toolResults });
		lastRoundHadTools = true;
	}

	// Resolve every pending caller with their slice. Attribution rule:
	// each user's batch is iterations [fi, nextGreaterFi), where fi is the
	// iteration that first submitted them and nextGreaterFi is the first
	// iteration submitting a strictly later user. The slice is the LAST
	// text-emitting iteration inside that batch (so tool-loop runs that
	// emit text in their final iteration give the caller the final answer,
	// not the partial preamble). Co-drained users (same fi) share the
	// batch and therefore the same slice.
	const sortedTextIters = [...iterationTexts.keys()].sort((a, b) => a - b);
	const userToTextIter = new Map<string, number>();
	for (const [userId, fi] of firstSubmittedAtIter) {
		let nextGreaterFi = Infinity;
		for (const otherFi of firstSubmittedAtIter.values()) {
			if (otherFi > fi && otherFi < nextGreaterFi) nextGreaterFi = otherFi;
		}
		let last = -1;
		for (const ti of sortedTextIters) {
			if (ti >= fi && ti < nextGreaterFi) last = ti;
		}
		if (last !== -1) userToTextIter.set(userId, last);
	}

	const metrics = {
		iterations,
		toolCalls,
		inputTokens: totalInputTokens,
		outputTokens: totalOutputTokens,
		cacheCreationTokens: totalCacheCreationTokens,
		cacheReadTokens: totalCacheReadTokens,
		compactedBeforeAsk,
		compactedOnOverflow,
		// runLoop never drives follow-ups — that's the outer loop in runAsk.
		// Each runLoop call contributes 0; runAsk increments as it commits
		// follow-up blocks.
		followUpAttempts: 0,
	};

	const pending = slot.pending.splice(0);
	for (const p of pending) {
		const textIter = userToTextIter.get(p.userBlockId);
		const finalText = textIter !== undefined ? iterationTexts.get(textIter) ?? "" : "";
		p.resolve({ ...metrics, finalText });
	}

	// Return the runner's own slice. The runner's userBlockId was tracked in
	// firstSubmittedAtIter at the start of iteration 1, so it has an entry
	// in userToTextIter unless the model never emitted text — in which
	// case the runner gets the empty string (truthful and observable).
	const runnerTextIter = userToTextIter.get(originalUserBlockId);
	const runnerFinalText = runnerTextIter !== undefined
		? iterationTexts.get(runnerTextIter) ?? ""
		: "";
	return { ...metrics, finalText: runnerFinalText };
}


export function renderBlockForRecall(block: any, tsIso: string): { text: string; kind: string } {
	const textContent = block?.content?.text;
	if (textContent?.text !== undefined) {
		const role = textContent.style === STYLE_ASSISTANT ? "assistant" : "user";
		return {
			kind: role === "assistant" ? "assistant_text" : "user_text",
			text: `[Recalled ${role} turn from ${tsIso}]:\n${textContent.text}`,
		};
	}
	const custom = block?.content?.custom;
	if (custom) {
		const contentType = custom.contentType ?? custom.content_type;
		const meta = custom.meta ?? {};
		if (contentType === BLOCK_TOOL_USE) {
			const toolName = meta.tool_name ?? "?";
			const input = meta.input ?? "{}";
			return { kind: "tool_use", text: `[Recalled tool call from ${tsIso}]: ${toolName}(${input})` };
		}
		if (contentType === BLOCK_TOOL_RESULT) {
			return { kind: "tool_result", text: `[Recalled tool result from ${tsIso}]:\n${meta.content ?? ""}${meta.is_error === "true" ? "\n(was an error)" : ""}` };
		}
		if (contentType === BLOCK_COMPACTION_SUMMARY) {
			return { kind: "compaction", text: `[Recalled compaction summary from ${tsIso}]:\n${meta.summary ?? ""}` };
		}
	}
	return { kind: "other", text: `[Recalled block ${block?.id ?? "?"} from ${tsIso}]` };
}


export async function doRecall(agentId: string, blockId: string, ctx: ProgramContext): Promise<{ newBlockId: string; sourceKind: string; truncated: boolean }> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const { randomUUID } = ctx;

	const state = await store.get(agentId);
	if (!state) throw new Error(`recall: agent not found: ${agentId}`);
	if (state.typeKey !== "agent") throw new Error(`recall: ${agentId} is not an agent`);

	const block = (state.blocks ?? []).find((b: any) => b.id === blockId);
	if (!block) throw new Error(`recall: block ${blockId} is not on agent ${agentId}`);

	const prov = state.blockProvenance?.[blockId];
	const tsIso = prov?.timestamp ? new Date(prov.timestamp).toISOString() : "unknown time";
	const rendered = renderBlockForRecall(block, tsIso);

	const RECALL_TRUNCATE = 8192;
	let text = rendered.text;
	let truncated = false;
	if (text.length > RECALL_TRUNCATE) {
		text = text.slice(0, RECALL_TRUNCATE) + `\n…[recall truncated, ${text.length - RECALL_TRUNCATE} bytes omitted]`;
		truncated = true;
	}

	const newBlockId = randomUUID();
	const actor = client.objectActor.getOrCreate([agentId]);
	await actor.addBlock(JSON.stringify(textBlock(newBlockId, text, STYLE_USER)));
	return { newBlockId, sourceKind: rendered.kind, truncated };
}


export async function doCancel(agentId: string, ctx: ProgramContext): Promise<{ ok: true }> {
	const client = ctx.client as any;
	const { stringVal } = ctx as any;
	const actor = client.objectActor.getOrCreate([agentId]);
	await actor.setField("cancel_requested", JSON.stringify(stringVal("true")));
	return { ok: true };
}


/** Test-only: clear in-memory run coordination state. */
export function _resetRunSlots(): void {
	runSlots.clear();
}
