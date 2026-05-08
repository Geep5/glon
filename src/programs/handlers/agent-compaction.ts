// Agent compaction — summarisation, memory extraction, and context window management.
//
// Extracted from agent.ts to reduce omnibus size. When token estimates exceed
// budget, doCompact walks backward to a safe cut point and emits a compaction_summary
// block that compresses everything before it.

import type { ProgramContext } from "../runtime.js";
import type { AnthropicContent } from "./agent-llm.js";
import { callLLM } from "./agent-llm.js";
import {
	ClassifiedItem,
	CompactResult,
	ExtractionResult,
	ToolSpec,
	extractCompactionConfig,
	extractBool,
	extractString,
	DEFAULT_MODEL,
	SUMMARY_TEMPERATURE,
	SUMMARY_MAX_TOKENS,
	TOOL_RESULT_TRUNCATE_FOR_SUMMARY,
} from "./agent-types.js";
import {
	classifyBlocks,
	findLatestCompaction,
	filterToKept,
	findCutIndex,
	estimateItemTokens,
	serializeItemsForSummary,
	buildSummaryPrompt,
	compactionBlock,
} from "./agent-conversation.js";

// ── Summarisation prompt + serialisation ─────────────────────────

export function serializeItemsForSummary(items: ClassifiedItem[]): string {
	const lines: string[] = [];
	for (const item of items) {
		switch (item.kind) {
			case "user_text":
				lines.push(`[User]: ${item.text}`);
				break;
			case "assistant_text":
				lines.push(`[Assistant]: ${item.text}`);
				break;
			case "tool_use":
				lines.push(`[Assistant tool calls]: ${item.name}(${JSON.stringify(item.input)})`);
				break;
			case "tool_result": {
				let body = item.content;
				if (body.length > TOOL_RESULT_TRUNCATE_FOR_SUMMARY) {
					const omitted = body.length - TOOL_RESULT_TRUNCATE_FOR_SUMMARY;
					body = body.slice(0, TOOL_RESULT_TRUNCATE_FOR_SUMMARY) + `\n[truncated — ${omitted} more bytes]`;
				}
				const tag = item.isError ? "Tool error" : "Tool result";
				lines.push(`[${tag}]: ${body}`);
				break;
			}
			case "compaction":
				// shouldn't be here
				break;
		}
	}
	return lines.join("\n\n");
}


export function buildSummaryPrompt(
	items: ClassifiedItem[],
	priorSummary: string | undefined,
	customInstructions: string | undefined,
	extractionRan: boolean = false,
): string {
	const conversation = serializeItemsForSummary(items);
	const priorBlock = priorSummary
		? `\n\nPrior summary being superseded (integrate into the new summary — do not drop facts from it):\n${priorSummary}\n`
		: "";
	const customBlock = customInstructions
		? `\n\nAdditional focus for this summary: ${customInstructions}\n`
		: "";
	const extractionBlock = extractionRan
		? `\n\nDurable facts and narrative milestones have already been extracted to a structured memory store in a prior pass. Keep this summary focused on the short-term arc of the kept region — goal, current state, next steps. Do not re-enumerate every fact; memory covers that.\n`
		: "";

	return `You are summarising an agent's conversation to free up context window space.

Preserve everything the agent will need to continue without re-reading the prior turns:
- What the primary peer is trying to accomplish
- Constraints, preferences, and boundaries stated
- Progress so far — what's done, what's in flight, what's blocked
- Key decisions and their rationale
- Concrete next steps
- Facts that must survive future compactions (names, dates, ids, contact info, pinned context)
- Open threads (things started but not yet resolved)

Write the summary in this exact markdown structure:

## Goal
[1-3 sentences on what the peer wants right now]

## Constraints & Preferences
- [one item per line]

## Progress
### Done
- [x] [completed items]
### In Progress
- [ ] [current work]
### Blocked
- [blockers, if any]

## Key Decisions
- **[decision]**: [rationale]

## Next Steps
1. [most important next action]
2. [...]

## Critical Context
- [concrete facts: names, dates, ids, contact info]

<pinned-facts>
[one short line per fact worth carrying forever]
</pinned-facts>

<open-threads>
[one short line per unresolved thread]
</open-threads>
${customBlock}${priorBlock}${extractionBlock}

Conversation to summarise:

${conversation}`;
}


const EXTRACTION_SYSTEM = `You are extracting durable knowledge from a
conversation slice that is about to be compacted. Write structured memory
via the memory_* tools:

- memory_upsert_fact for atomic, key-value truths (preferences, contact info,
  configuration, boundaries). One row per \`key\`; upserting with the same key
  replaces the value. Use short, stable keys.
- memory_upsert_milestone for narrative arcs: projects, decisions, phases.
  Pass supersedes=[id,...] when this milestone amends or replaces older ones.
- memory_amend_milestone when correcting an existing milestone in place — prefer
  this over creating a new milestone with supersedes when the change is small.
- memory_list_facts / memory_list_milestones / memory_recall to inspect the
  current memory state BEFORE writing, so you don't duplicate what's already known.

Rules:
- Quality over quantity. A terse, accurate set beats a verbose, speculative one.
- Do not invent facts. If the conversation didn't state something, don't pin it.
- Prefer amendments over new milestones when the subject already exists.
- Include sourced_from_block_id / sourced_from_blocks when you can trace the source.
- When done, reply with one short paragraph summarising what you wrote and why.`;


export function buildExtractionTools(agentId: string): ToolSpec[] {
	const owner = { owner: agentId };
	return [
		{
			name: "memory_list_facts",
			description: "List existing pinned facts for this agent. Inspect before writing to avoid duplicates.",
			input_schema: { type: "object", properties: { key: { type: "string" } } },
			target_prefix: "/memory",
			target_action: "list_facts",
			bound_args: owner,
		},
		{
			name: "memory_list_milestones",
			description: "List existing milestones. Filter by status/topic/peer_id/limit. Inspect before writing.",
			input_schema: {
				type: "object",
				properties: {
					status: { type: "string", enum: ["active", "completed", "superseded"] },
					topic: { type: "string" },
					peer_id: { type: "string" },
					limit: { type: "number" },
				},
			},
			target_prefix: "/memory",
			target_action: "list_milestones",
			bound_args: owner,
		},
		{
			name: "memory_recall",
			description: "Scoped search over facts + milestones by query/topics/peers/time range.",
			input_schema: {
				type: "object",
				properties: {
					query: { type: "string" },
					topics: { type: "array", items: { type: "string" } },
					peer_ids: { type: "array", items: { type: "string" } },
					limit_facts: { type: "number" },
					limit_milestones: { type: "number" },
					include_superseded: { type: "boolean" },
				},
			},
			target_prefix: "/memory",
			target_action: "recall",
			bound_args: owner,
		},
		{
			name: "memory_upsert_fact",
			description: "Pin a durable atomic fact. One row per `key` — upsert replaces by key.",
			input_schema: {
				type: "object",
				properties: {
					key: { type: "string" },
					value: { type: "string" },
					confidence: { type: "string", enum: ["low", "med", "high"] },
					sourced_from_block_id: { type: "string" },
				},
				required: ["key", "value"],
			},
			target_prefix: "/memory",
			target_action: "upsert_fact",
			bound_args: owner,
		},
		{
			name: "memory_upsert_milestone",
			description: "Record a narrative arc. Pass supersedes=[id,...] to replace older milestones.",
			input_schema: {
				type: "object",
				properties: {
					title: { type: "string" },
					narrative: { type: "string" },
					topics: { type: "array", items: { type: "string" } },
					peers: { type: "array", items: { type: "string" } },
					supersedes: { type: "array", items: { type: "string" } },
					status: { type: "string", enum: ["active", "completed", "superseded"] },
					confidence: { type: "string", enum: ["low", "med", "high"] },
					sourced_from_blocks: { type: "array", items: { type: "string" } },
					started_at: { type: "number" },
					ended_at: { type: "number" },
				},
				required: ["title", "narrative"],
			},
			target_prefix: "/memory",
			target_action: "upsert_milestone",
			bound_args: owner,
		},
		{
			name: "memory_amend_milestone",
			description: "Edit fields on an existing milestone. Prior values remain in object_history.",
			input_schema: {
				type: "object",
				properties: {
					milestone_id: { type: "string" },
					title: { type: "string" },
					narrative: { type: "string" },
					topics: { type: "array", items: { type: "string" } },
					peers: { type: "array", items: { type: "string" } },
					supersedes: { type: "array", items: { type: "string" } },
					status: { type: "string", enum: ["active", "completed", "superseded"] },
					confidence: { type: "string", enum: ["low", "med", "high"] },
					sourced_from_blocks: { type: "array", items: { type: "string" } },
					started_at: { type: "number" },
					ended_at: { type: "number" },
				},
				required: ["milestone_id"],
			},
			target_prefix: "/memory",
			target_action: "amend_milestone",
			// amend is scoped by milestone_id (owner-locked server-side in doAmendMilestone)
		},
	];
}


const EXTRACTION_MAX_ITERATIONS = 8;

interface ExtractionResult {
	extractionSummary: string;
	toolCalls: number;
	iterations: number;
	inputTokens: number;
	outputTokens: number;
}


export async function runExtractionLoop(
	serializedConversation: string,
	agentId: string,
	model: string,
	ctx: ProgramContext,
): Promise<ExtractionResult> {
	const tools = buildExtractionTools(agentId);
	const messages: { role: string; content: string | AnthropicContent[] }[] = [
		{ role: "user", content: serializedConversation },
	];
	let iterations = 0;
	let toolCalls = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let extractionSummary = "";

	while (iterations < EXTRACTION_MAX_ITERATIONS) {
		iterations++;
		const result = await callLLM(
			messages, EXTRACTION_SYSTEM, model, SUMMARY_TEMPERATURE, tools, undefined, SUMMARY_MAX_TOKENS, ctx,
		);
		inputTokens += result.inputTokens;
		outputTokens += result.outputTokens;

		const assistantText = result.content
			.filter((c): c is Extract<AnthropicContent, { type: "text" }> => c.type === "text")
			.map((c) => c.text)
			.join("");
		const toolUses = result.content.filter(
			(c): c is Extract<AnthropicContent, { type: "tool_use" }> => c.type === "tool_use",
		);

		if (toolUses.length === 0) {
			extractionSummary = assistantText.trim();
			break;
		}

		const toolResults: Extract<AnthropicContent, { type: "tool_result" }>[] = [];
		for (const tu of toolUses) {
			toolCalls++;
			const tool = tools.find((t) => t.name === tu.name);
			let content: string;
			let isError = false;
			if (!tool) {
				content = `Tool '${tu.name}' not registered on extraction loop`;
				isError = true;
			} else {
				try {
					const dispatchInput = tool.bound_args && Object.keys(tool.bound_args).length > 0
						? { ...(tu.input ?? {}), ...tool.bound_args }
						: tu.input;
					const raw = await ctx.dispatchProgram(tool.target_prefix, tool.target_action, [dispatchInput]);
					content = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
				} catch (err: any) {
					content = `Error: ${err?.message ?? String(err)}`;
					isError = true;
				}
			}
			if (content.length > TOOL_RESULT_TRUNCATE_FOR_SUMMARY) {
				content = content.slice(0, TOOL_RESULT_TRUNCATE_FOR_SUMMARY)
					+ `\n[truncated — ${content.length - TOOL_RESULT_TRUNCATE_FOR_SUMMARY} bytes]`;
			}
			toolResults.push({
				type: "tool_result", tool_use_id: tu.id, content, is_error: isError,
			});
		}
		messages.push({ role: "assistant", content: result.content, reasoningContent: result.reasoningContent });
		messages.push({ role: "user", content: toolResults });
	}

	return { extractionSummary, toolCalls, iterations, inputTokens, outputTokens };
}


interface CompactResult {
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


export async function doCompact(
	agentId: string,
	customInstructions: string | undefined,
	ctx: ProgramContext,
): Promise<CompactResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const { randomUUID } = ctx;

	const state = await store.get(agentId);
	if (!state) throw new Error(`Agent not found: ${agentId}`);
	if (state.typeKey !== "agent") throw new Error(`Object ${agentId} is not an agent`);

	const config = extractCompactionConfig(state.fields ?? {});
	if (!config.enabled) return { compacted: false, reason: "disabled" };

	const items = classifyBlocks(state.blocks ?? [], state.blockProvenance ?? {});
	const latestCompaction = findLatestCompaction(items);
	const effective = latestCompaction
		? filterToKept(items, latestCompaction.firstKeptBlockId)
		: items.filter((i) => i.kind !== "compaction");

	const cutIndex = findCutIndex(effective, config.keepRecentTokens);
	if (cutIndex === null) return { compacted: false, reason: "no_cut_point" };

	const toSummarise = effective.slice(0, cutIndex);
	const firstKeptItem = effective[cutIndex];
	if (toSummarise.length === 0) return { compacted: false, reason: "no_cut_point" };

	const tokensBefore = toSummarise.reduce((acc, it) => acc + estimateItemTokens(it), 0);
	const turnCount = toSummarise.filter((i) => i.kind === "user_text").length;

	const model = config.model || extractString(state.fields?.["model"]) || DEFAULT_MODEL;

	// Stage A — memory extraction (opt-in). Writes structured facts/milestones
	// to /memory via tool calls. Failures degrade gracefully: we log and continue
	// to Stage B so a buggy extraction never blocks compaction.
	const extractionEnabled = extractBool(state.fields?.["memory_extraction_enabled"], false);
	let extractionResult: ExtractionResult | null = null;
	if (extractionEnabled) {
		try {
			const conversation = serializeItemsForSummary(toSummarise);
			extractionResult = await runExtractionLoop(conversation, agentId, model, ctx);
		} catch (err: any) {
			// Degrade: record the failure in the result, skip Stage A contribution.
			extractionResult = {
				extractionSummary: `(extraction failed: ${err?.message ?? String(err)})`,
				toolCalls: 0, iterations: 0, inputTokens: 0, outputTokens: 0,
			};
		}
	}

	const prompt = buildSummaryPrompt(toSummarise, latestCompaction?.summary, customInstructions, !!extractionResult);

	const result = await callLLM(
		[{ role: "user", content: prompt }],
		undefined,
		model,
		SUMMARY_TEMPERATURE,
		undefined,
		undefined,
		SUMMARY_MAX_TOKENS,
		ctx,
	);
	const summary = result.content
		.filter((c): c is Extract<AnthropicContent, { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trim();
	if (!summary) throw new Error("Compaction summary came back empty");

	const actor = client.objectActor.getOrCreate([agentId]);
	const blockId = randomUUID();
	await actor.addBlock(JSON.stringify(
		compactionBlock(blockId, summary, firstKeptItem.blockId, tokensBefore, turnCount, latestCompaction?.blockId),
	));

	const extraction = extractionResult ? {
		ran: true,
		toolCalls: extractionResult.toolCalls,
		iterations: extractionResult.iterations,
		inputTokens: extractionResult.inputTokens,
		outputTokens: extractionResult.outputTokens,
		summary: extractionResult.extractionSummary,
	} : undefined;

	return {
		compacted: true,
		blockId,
		firstKeptBlockId: firstKeptItem.blockId,
		extraction,
		turnCount,
		tokensBefore,
		summary,
	};
}

