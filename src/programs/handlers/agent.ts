// Agent — an LLM-powered conversational agent that runs on Glon.
//
// Each agent is a regular Glon object (type "agent"). Every turn — user
// prompt, assistant text, tool_use, tool_result, compaction summary — is
// a content-addressed block in the DAG. The LLM sees a *view* over these
// blocks; the DAG itself is append-only truth.
//
// This file is the entry point. Core logic lives in:
//   agent-types.ts        — shared types, constants, field helpers
//   agent-conversation.ts — block classification, turn grouping, token estimation
//   agent-compaction.ts   — context-window compaction and summarisation
//   agent-runner.ts       — ReAct loop, steering, status, recall
//   agent-spawn.ts        — subagent spawning and result submission

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, red, green, yellow, magenta, blue } from "../shared.js";
import type { AnthropicContent } from "./agent-llm.js";
import { isContextOverflowError, listAvailableProviders, pickProvider } from "./agent-llm.js";

import {
	DEFAULT_MODEL,
	DEFAULT_MAX_TOOL_ITERATIONS,
	TOOL_RESULT_TRUNCATE,
	DEFAULT_COMPACTION_CONTEXT_WINDOW,
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
	BLOCK_TOOL_USE,
	BLOCK_TOOL_RESULT,
	BLOCK_COMPACTION_SUMMARY,
	STYLE_USER,
	STYLE_ASSISTANT,
	CHARS_PER_TOKEN,
	extractString,
	extractInt,
	extractBool,
	extractTools,
	doRegisterTool,
	ToolSpec,
	SpawnInput,
	SubmitResultInput,
	FollowUpHook,
} from "./agent-types.js";

	import {
	classifyBlocks,
	findLatestCompaction,
	filterToKept,
	groupIntoTurns,
	repairToolPairs,
	mergeConsecutiveTurns,
	buildConversationView,
	findCutIndex,
	estimateAskTokens,
	estimateToolDefinitionsTokens,
	estimateItemTokens,
	textBlock,
	toolUseBlock,
	toolResultBlock,
	compactionBlock,
} from "./agent-conversation.js";

	import {
		doCompact,
		serializeItemsForSummary,
		buildSummaryPrompt,
	} from "./agent-compaction.js";

import {
	doUnregisterTool,
	doListTools,
	doStatus,
	runAsk,
	mergeAskResults,
	makeTodoFollowUpHook,
	resolveMemoryDigest,
	buildEffectiveSystem,
	shouldAutoCompact,
	doRecall,
	renderBlockForRecall,
	doCancel,
	hasAssistantTextAfter,
	computeAssistantSlice,
	ensureSlot,
	_resetRunSlots,
} from "./agent-runner.js";

import {
	spawnTool,
	doSpawn as _doSpawn,
	doSubmitResult,
	doGetSubagents,
	buildSubagentSystemPrompt,
	submitResultTool,
	validateAgainstSchema,
	resolveAgentTemplate,
	BUILTIN_TEMPLATES,
	maxSpawnDepth,
	Semaphore,
	renderSubagentTree,
	countDescendants,
} from "./agent-spawn.js";

// Wrapper that injects runAsk so existing callers (actorDef.spawn, tests)
// don't need to pass it.
async function doSpawn(input: SpawnInput, ctx: ProgramContext) {
	return _doSpawn(input, ctx, runAsk);
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { store, resolveId, stringVal, linkVal, print, randomUUID } = ctx as any;
	const client = ctx.client as any;

	switch (cmd) {
		case "new": {
			let name = "agent";
			let model = DEFAULT_MODEL;
			let system: string | undefined;

			const positional: string[] = [];
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--model" && args[i + 1]) { model = args[++i]; }
				else if (args[i] === "--system" && args[i + 1]) { system = args[++i]; }
				else { positional.push(args[i]); }
			}
			if (positional.length > 0) name = positional.join(" ");

			const fields: Record<string, any> = {
				name: stringVal(name),
				model: stringVal(model),
			};
			if (system) fields.system = stringVal(system);

			const id = await store.create("agent", JSON.stringify(fields));
			print(green("Agent created: ") + bold(id));
			print(dim(`  model: ${model}`));
			if (system) print(dim(`  system: ${system}`));
			print(dim(`  agent ask ${id.slice(0, 8)} Hello!`));
			break;
		}

		case "ask": {
			const raw = args[0];
			const prompt = args.slice(1).join(" ");
			if (!raw || !prompt) { print(red("Usage: agent ask <id> <prompt...>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }

			try {
				const state = await store.get(id);
				if (!state) { print(red("Agent not found")); break; }
				const model = extractString(state.fields?.["model"]) || DEFAULT_MODEL;
				const toolsCount = extractTools(state.fields?.["tools"]).length;

				print(dim(`  thinking (${model})${toolsCount > 0 ? `, ${toolsCount} tool(s)` : ""}...`));
				print("");
				print(magenta(bold("  assistant")) + dim(toolsCount > 0 ? "" : " streaming..."));
				print("");

				const result = await runAsk(id, prompt, ctx, {
					printStream: true,
					// Default ON for the CLI: if /todo is loaded and the agent
					// has incomplete items, the agent will be re-prompted with
					// a <system-reminder> instead of stopping early. No-op
					// when /todo isn't running or the agent has no list.
					followUpHook: makeTodoFollowUpHook(),
				});

				if (toolsCount > 0 && result.finalText) {
					for (const line of result.finalText.split("\n")) print(`  ${line}`);
				}
				print("");
				const toolSuffix = result.toolCalls > 0
					? `, ${result.toolCalls} tool call(s) over ${result.iterations} iteration(s)`
					: "";
				const compactionNotes: string[] = [];
				if (result.compactedBeforeAsk) compactionNotes.push("auto-compacted before ask");
				if (result.compactedOnOverflow) compactionNotes.push("compacted on overflow + retried");
				if (result.followUpAttempts > 0) compactionNotes.push(`${result.followUpAttempts} follow-up turn(s)`);
				const compactionSuffix = compactionNotes.length ? `, ${compactionNotes.join("; ")}` : "";
				const cacheNote = result.cacheReadTokens > 0 || result.cacheCreationTokens > 0
					? `, cache: ${result.cacheReadTokens} read + ${result.cacheCreationTokens} written`
					: "";
				print(dim(`  (${result.inputTokens} input + ${result.outputTokens} output = ${result.inputTokens + result.outputTokens} tokens${toolSuffix}${compactionSuffix}${cacheNote})`));
				print("");
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "history": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent history <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }

			const state = await store.get(id);
			if (!state) { print(red("Agent not found")); break; }

			const name = extractString(state.fields?.["name"]) || "agent";
			const model = extractString(state.fields?.["model"]) || DEFAULT_MODEL;
			const system = extractString(state.fields?.["system"]);
			const items = classifyBlocks(state.blocks ?? [], state.blockProvenance ?? {});
			const latest = findLatestCompaction(items);

			print(bold(`  ${name}`) + dim(` (${model})`));
			if (system) print(dim(`  system: ${system.slice(0, 200)}${system.length > 200 ? "…" : ""}`));
			if (latest) {
				const ageMin = Math.round((Date.now() - latest.timestamp) / 60000);
				print(dim(`  compaction: ${latest.turnCount} turn(s), ≈${latest.tokensBefore} tokens, ${ageMin}m ago`));
			}
			print("");

			if (items.length === 0) { print(dim("  (no conversation yet)")); break; }

			for (const item of items) {
				const ts = item.timestamp
					? new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
					: "--:--";
				switch (item.kind) {
					case "user_text": {
						print(cyan(bold("  user")) + " " + dim(ts));
						for (const line of item.text.split("\n")) print(`    ${line}`);
						print("");
						break;
					}
					case "assistant_text": {
						print(magenta(bold("  assistant")) + " " + dim(ts));
						for (const line of item.text.split("\n")) print(`    ${line}`);
						print("");
						break;
					}
					case "tool_use": {
						const inputStr = JSON.stringify(item.input);
						const shown = inputStr.length > 120 ? inputStr.slice(0, 120) + "…" : inputStr;
						print(`    ${yellow("→ tool_use")} ${bold(item.name)} ${dim(shown)}`);
						break;
					}
					case "tool_result": {
						const preview = item.content.length > 120 ? item.content.slice(0, 120) + "…" : item.content;
						const tag = item.isError ? red("← tool_error") : blue("← tool_result");
						for (const line of preview.split("\n")) print(`    ${tag} ${line}`);
						break;
					}
					case "compaction": {
						const separator = "─".repeat(2);
						print(dim(`  ${separator} compacted ${item.turnCount} turn(s), ≈${item.tokensBefore} tokens ${separator}`));
						const preview = item.summary.split("\n").slice(0, 4).join("\n");
						for (const line of preview.split("\n")) print(dim(`    ${line}`));
						print(dim(`    (summary continues — /agent view-summary ${id.slice(0, 8)} to see all)`));
						print("");
						break;
					}
				}
			}
			break;
		}

		case "view-summary": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent view-summary <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			const state = await store.get(id);
			if (!state) { print(red("Agent not found")); break; }
			const items = classifyBlocks(state.blocks ?? [], state.blockProvenance ?? {});
			const latest = findLatestCompaction(items);
			if (!latest) { print(dim("  (no compaction summary yet)")); break; }
			print(bold(`  Compaction summary`) + dim(` — ${latest.turnCount} turns, ≈${latest.tokensBefore} tokens`));
			print("");
			for (const line of latest.summary.split("\n")) print(`  ${line}`);
			break;
		}

		case "compact": {
			const raw = args[0];
			const instructions = args.slice(1).join(" ") || undefined;
			if (!raw) { print(red("Usage: agent compact <id> [instructions...]")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				print(dim("  compacting..."));
				const result = await doCompact(id, instructions, ctx);
				if (result.compacted) {
					print(green(`  Compacted ${result.turnCount} turn(s), ≈${result.tokensBefore} tokens`));
					print(dim(`  summary block: ${result.blockId?.slice(0, 12)}`));
				} else {
					const msgMap = {
						disabled: "Compaction is disabled on this agent",
						under_budget: "Conversation is under the compaction budget — nothing to do",
						no_cut_point: "No safe cut point (conversation too short or single turn too large)",
					};
					print(dim(`  ${msgMap[result.reason!] ?? "Nothing to compact"}`));
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "config": {
			const raw = args[0];
			const key = args[1];
			const value = args.slice(2).join(" ");
			if (!raw || !key || !value) {
				print(red("Usage: agent config <id> <key> <value>"));
				print(dim("  Keys: model, system, name, temperature,"));
				print(dim("        compaction_enabled, compaction_context_window,"));
				print(dim("        compaction_reserve_tokens, compaction_keep_recent_tokens,"));
				print(dim("        compaction_model, max_tool_iterations"));
				break;
			}
			const allowed = [
				"model", "system", "name", "temperature",
				"compaction_enabled", "compaction_context_window",
				"compaction_reserve_tokens", "compaction_keep_recent_tokens",
				"compaction_model",
				"memory_digest_enabled", "memory_extraction_enabled",
				"max_tool_iterations",
			];
			if (!allowed.includes(key)) {
				print(red(`Unknown config key: ${key}. Use: ${allowed.join(", ")}`));
				break;
			}
			if (key === "temperature") {
				const temp = parseFloat(value);
				if (isNaN(temp) || temp < 0 || temp > 2) {
					print(red("Temperature must be a number between 0 and 2"));
					break;
				}
			}
			if (key.startsWith("compaction_") && key !== "compaction_model" && key !== "compaction_enabled") {
				const n = parseInt(value, 10);
				if (!Number.isFinite(n) || n < 0) {
					print(red(`${key} must be a non-negative integer`));
					break;
				}
			}
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			const actor = client.objectActor.getOrCreate([id]);
			await actor.setField(key, JSON.stringify(stringVal(value)));
			print(dim(`  ${key} = `) + value);
			break;
		}

		case "status": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent status <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const s = await doStatus(id, ctx);
				print(bold(`  ${s.name}`) + dim(` (${s.model})`));
				print(dim(`  blocks: ${s.blockCount}  |  effective turns: ${s.effectiveTurns}  |  tools: ${s.tools}`));
				const pct = s.compaction.threshold > 0
					? Math.round(100 * s.estimatedTokens / s.compaction.threshold)
					: 0;
				const barColor = pct > 80 ? red : pct > 50 ? yellow : green;
				print(dim(`  tokens: ≈${s.estimatedTokens} / ${s.compaction.threshold} threshold  `) + barColor(`(${pct}%)`));
				print(dim(`  compaction: ${s.compaction.config.enabled ? "enabled" : "disabled"}  |  window ${s.compaction.config.contextWindow}, reserve ${s.compaction.config.reserveTokens}, keep-recent ${s.compaction.config.keepRecentTokens}`));
				if (s.compaction.lastCompaction) {
					const c = s.compaction.lastCompaction;
					const ageMin = Math.round((Date.now() - c.createdAt) / 60000);
					print(dim(`  last compaction: ${c.turnCount} turn(s), ≈${c.tokensBefore} tokens, ${ageMin}m ago`));
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "recall": {
			const raw = args[0];
			const blockRaw = args[1];
			if (!raw || !blockRaw) { print(red("Usage: agent recall <agent-id> <block-id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const state = await store.get(id);
				if (!state) { print(red("Agent not found")); break; }
				// Accept a full block id OR any unique prefix.
				const match = (state.blocks ?? []).find((b: any) => b.id === blockRaw || b.id.startsWith(blockRaw));
				if (!match) { print(red("Block not in this agent: ") + blockRaw); break; }
				const result = await doRecall(id, match.id, ctx);
				print(green("  Recalled ") + result.sourceKind + dim(` → new block ${result.newBlockId.slice(0, 8)}`));
				if (result.truncated) print(dim("  (content was long; truncated at 8192 bytes)"));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "tree": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent tree <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const root = await doGetSubagents(id, ctx);
				print(bold("spawn tree rooted at ") + root.id);
				print(renderSubagentTree(root));
				const count = countDescendants(root);
				print(dim(`  ${count} subagent(s) total`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "list-templates": {
			try {
				const dagRefs = (await (store as any).list("agent_template")) as Array<{ id: string }> ?? [];
				const seen = new Set<string>();
				print(bold("agent templates:"));
				for (const ref of dagRefs) {
					const s = await store.get(ref.id);
					if (!s || s.deleted) continue;
					const name = extractString(s.fields?.name) ?? ref.id.slice(0, 8);
					const model = extractString(s.fields?.model) ?? DEFAULT_MODEL;
					const spawns = extractString(s.fields?.spawns) ?? "";
					const desc = extractString(s.fields?.description) ?? "";
					seen.add(name);
					print(green(`  ${name}`) + dim(` [DAG ${ref.id.slice(0, 8)}]`));
					print(dim(`    model=${model}  spawns=${spawns || "(none)"}  ${desc}`));
				}
				for (const [name, tpl] of Object.entries(BUILTIN_TEMPLATES)) {
					if (seen.has(name)) continue;
					print(yellow(`  ${name}`) + dim(" [builtin]"));
					print(dim(`    model=${tpl.model}  spawns=${tpl.spawns || "(none)"}  ${tpl.description}`));
				}
			} catch (err: any) {
				print(red("  list-templates failed: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "create-template": {
			let name: string | undefined, model = DEFAULT_MODEL, systemText = "", spawns = "", description = "";
			const positional: string[] = [];
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--model" && args[i + 1]) model = args[++i];
				else if (args[i] === "--system" && args[i + 1]) systemText = args[++i];
				else if (args[i] === "--spawns" && args[i + 1]) spawns = args[++i];
				else if (args[i] === "--description" && args[i + 1]) description = args[++i];
				else positional.push(args[i]);
			}
			name = positional[0];
			if (!name) {
				print(red("Usage: agent create-template <name> [--model M] [--system S] [--spawns '*'|'' |CSV] [--description D]"));
				break;
			}
			if (!systemText) systemText = `You are a ${name} agent. Finish with submit_result.`;
			const fields: Record<string, any> = {
				name: stringVal(name),
				model: stringVal(model),
				system: stringVal(systemText),
				spawns: stringVal(spawns),
				description: stringVal(description),
			};
			try {
				const id: string = await (store as any).create("agent_template", JSON.stringify(fields));
				print(green("Template created: ") + bold(name) + dim(` (${id})`));
				if (BUILTIN_TEMPLATES[name]) {
					print(dim("  note: this DAG template now overrides the built-in of the same name."));
				}
			} catch (err: any) {
				print(red("  create-template failed: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "delete-template": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent delete-template <name-or-id>")); break; }
			// Try interpreting as DAG id prefix first; fall back to name lookup.
			let id: string | null = await resolveId(raw);
			if (!id) {
				try {
					const dagRefs = (await (store as any).list("agent_template")) as Array<{ id: string }> ?? [];
					for (const ref of dagRefs) {
						const s = await store.get(ref.id);
						if (s && !s.deleted && extractString(s.fields?.name) === raw) { id = ref.id; break; }
					}
				} catch { /* ignore */ }
			}
			if (!id) { print(red("Template not found: ") + raw); break; }
			const state = await store.get(id);
			if (!state || state.typeKey !== "agent_template") {
				print(red("Not an agent_template: ") + id);
				break;
			}
			const actor = (client as any).objectActor.getOrCreate([id]);
			await actor.markDeleted();
			print(green("Template tombstoned: ") + id);
			break;
		}

		case "read": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent read <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }

			const state = await store.get(id);
			if (!state) { print(red("Agent not found")); break; }

			const name = extractString(state.fields?.["name"]) || "agent";
			const view = buildConversationView(state.blocks ?? [], state.blockProvenance ?? {});

			print(bold(`  ${name}`) + dim(` — ${view.turns.length} effective turn(s)${view.latestCompaction ? " (compacted)" : ""}`));
			print("");

			const recent = view.turns.slice(-5);
			if (view.turns.length > 5) print(dim(`  ... ${view.turns.length - 5} earlier turns`));
			for (const turn of recent) {
				const label = turn.role === "user" ? cyan("user") : magenta("assistant");
				const str = typeof turn.content === "string"
					? turn.content
					: turn.content.map((c) => c.type === "text" ? c.text : `[${c.type}]`).join(" ");
				const preview = str.length > 120 ? str.slice(0, 120) + "..." : str;
				print(`  ${label}: ${preview}`);
			}
			break;
		}

		case "inject": {
			const targetRaw = args[0];
			const sourceRaw = args[1];
			if (!targetRaw || !sourceRaw) {
				print(red("Usage: agent inject <target-id> <source-id>"));
				break;
			}
			const targetId = await resolveId(targetRaw);
			const sourceId = await resolveId(sourceRaw);
			if (!targetId) { print(red("Target not found: ") + targetRaw); break; }
			if (!sourceId) { print(red("Source not found: ") + sourceRaw); break; }

			const sourceState = await store.get(sourceId);
			if (!sourceState) { print(red("Source agent not found")); break; }
			const sourceName = extractString(sourceState.fields?.["name"]) || "agent";
			const sourceView = buildConversationView(sourceState.blocks ?? [], sourceState.blockProvenance ?? {});
			if (sourceView.turns.length === 0) { print(dim("  Source agent has no conversation to inject")); break; }

			const lines = [`[Context from agent "${sourceName}" (${sourceId.slice(0, 8)})]`];
			for (const turn of sourceView.turns) {
				const str = typeof turn.content === "string"
					? turn.content
					: turn.content.map((c) => c.type === "text" ? c.text : `[${c.type}]`).join(" ");
				lines.push(`${turn.role}: ${str}`);
			}
			lines.push("[End context]");

			const actor = client.objectActor.getOrCreate([targetId]);
			const blockId = randomUUID();
			await actor.addBlock(JSON.stringify(textBlock(blockId, lines.join("\n"), STYLE_USER)));
			await actor.setField("context_source", JSON.stringify(linkVal(sourceId, "context_source")));

			print(green(`  Injected ${sourceView.turns.length} turns from "${sourceName}" into target`));
			print(dim(`  block ${blockId.slice(0, 8)}`));
			break;
		}

		case "register-tool": {
			const raw = args[0];
			const name = args[1];
			const targetPrefix = args[2];
			const targetAction = args[3];
			const description = args.slice(4).join(" ");
			if (!raw || !name || !targetPrefix || !targetAction) {
				print(red("Usage: agent register-tool <agentId> <name> <targetPrefix> <targetAction> [description...]"));
				break;
			}
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const msg = await doRegisterTool(id, {
					name,
					description: description || `Call ${targetPrefix} ${targetAction}`,
					input_schema: { type: "object" },
					target_prefix: targetPrefix,
					target_action: targetAction,
				}, ctx);
				print(green("  " + msg));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "unregister-tool": {
			const raw = args[0];
			const name = args[1];
			if (!raw || !name) { print(red("Usage: agent unregister-tool <agentId> <name>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const msg = await doUnregisterTool(id, name, ctx);
				print(green("  " + msg));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "tools": {
			const raw = args[0];
			if (!raw) { print(red("Usage: agent tools <agentId>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const tools = await doListTools(id, ctx);
				if (tools.length === 0) { print(dim("  (no tools registered)")); break; }
				print(bold(`  ${tools.length} tool(s)`));
				for (const t of tools) {
					print(`    ${cyan(bold(t.name))} ${dim("→")} ${t.target_prefix} ${t.target_action}`);
					if (t.description) print(dim(`      ${t.description}`));
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Agent"),
				`    ${cyan("agent new")} ${dim("[name] [--model X] [--system \"...\"]")}  create an agent`,
				`    ${cyan("agent ask")} ${dim("<id> <prompt...>")}                      chat with agent`,
				`    ${cyan("agent history")} ${dim("<id>")}                               full block history`,
				`    ${cyan("agent view-summary")} ${dim("<id>")}                          show the latest compaction summary in full`,
				`    ${cyan("agent status")} ${dim("<id>")}                                tokens, turns, compaction state`,
				`    ${cyan("agent compact")} ${dim("<id> [instructions...]")}             manual compaction`,
				`    ${cyan("agent config")} ${dim("<id> <key> <value>")}                  set model/system/temperature/compaction_*`,
				`    ${cyan("agent read")} ${dim("<id>")}                                  peek at effective (post-compaction) conversation`,
				`    ${cyan("agent inject")} ${dim("<target> <source>")}                   inject context from another agent`,
				`    ${cyan("agent register-tool")} ${dim("<id> <name> <prefix> <action>")} register a tool`,
				`    ${cyan("agent unregister-tool")} ${dim("<id> <name>")}                remove a tool`,
				`    ${cyan("agent tools")} ${dim("<id>")}                                 list registered tools`,
				"",
				dim("  Models: claude-sonnet-4-20250514, claude-haiku-4-20250414, moonshot-v1-8k, moonshot-v1-32k, moonshot-v1-128k, etc."),
				dim("  Requires ANTHROPIC_API_KEY or KIMI_API_KEY env var, or `/auth login`."),
			].join("\n"));
		}
	}
};

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		registerTool: async (ctx: ProgramContext, agentId: string, spec: string | ToolSpec) => {
			const parsed: ToolSpec = typeof spec === "string" ? JSON.parse(spec) : spec;
			if (!parsed?.name || !parsed.target_prefix || !parsed.target_action) {
				throw new Error("registerTool: spec must include name, target_prefix, target_action");
			}
			if (!parsed.input_schema) parsed.input_schema = { type: "object" };
			if (!parsed.description) parsed.description = `Call ${parsed.target_prefix} ${parsed.target_action}`;
			return await doRegisterTool(agentId, parsed, ctx);
		},
		unregisterTool: async (ctx: ProgramContext, agentId: string, toolName: string) => {
			return await doUnregisterTool(agentId, toolName, ctx);
		},
		listTools: async (ctx: ProgramContext, agentId: string) => {
			return await doListTools(agentId, ctx);
		},
		ask: async (
			ctx: ProgramContext,
			agentId: string,
			prompt: string,
			opts?: { followUp?: { kind: "todo"; max?: number } | "none" },
		) => {
			let followUpHook: FollowUpHook | undefined;
			if (opts?.followUp && opts.followUp !== "none") {
				if (opts.followUp.kind === "todo") {
					followUpHook = makeTodoFollowUpHook({ maxAttempts: opts.followUp.max });
				}
			}
			return await runAsk(agentId, prompt, ctx, { followUpHook });
		},
		compact: async (ctx: ProgramContext, agentId: string, instructions?: string) => {
			return await doCompact(agentId, instructions, ctx);
		},
		status: async (ctx: ProgramContext, agentId: string) => {
			return await doStatus(agentId, ctx);
		},
		spawn: async (ctx: ProgramContext, arg: string | SpawnInput) => {
			const input: SpawnInput = typeof arg === "string" ? JSON.parse(arg) : arg;
			return await doSpawn(input, ctx);
		},
		submitResult: async (ctx: ProgramContext, arg: string | SubmitResultInput) => {
			const input: SubmitResultInput = typeof arg === "string" ? JSON.parse(arg) : arg;
			return await doSubmitResult(input, ctx);
		},
		recall: async (ctx: ProgramContext, agentId: string, blockId: string) => {
			return await doRecall(agentId, blockId, ctx);
		},
		cancel: async (ctx: ProgramContext, agentId: string) => {
			return await doCancel(agentId, ctx);
		},
		getSubagents: async (ctx: ProgramContext, agentId: string) => {
			return await doGetSubagents(agentId, ctx);
		},
		/**
		 * Survey configured LLM providers. Returns one entry per registered
		 * provider with `available`, `envVarSet`, `authPath` ("env" | "auth.json"
		 * | null), and the default model that would be used if we had to fall
		 * back. Use this for status displays — astrolabe / CLI / health checks.
		 */
		providers: async (ctx: ProgramContext) => {
			return await listAvailableProviders(ctx);
		},
		/**
		 * Resolve which provider + model would actually serve a request for
		 * `requestedModel`. Returns `{ provider, model, swapped, reason }`.
		 * Does not make a network call. Throws if no provider is configured.
		 */
		whichProvider: async (ctx: ProgramContext, requestedModel: string) => {
			const picked = await pickProvider(requestedModel, ctx);
			return {
				provider: picked.provider.name,
				model: picked.model,
				swapped: picked.swapped,
				reason: picked.reason ?? null,
			};
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Direct exports (backward compatibility for tests & callers) ──

export { estimateTokens } from "./agent-conversation.js";
export type { FollowUpHookContext, FollowUpHook } from "./agent-types.js";
export { makeTodoFollowUpHook } from "./agent-runner.js";
export { spawnTool } from "./agent-spawn.js";

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	classifyBlocks,
	findLatestCompaction,
	filterToKept,
	groupIntoTurns,
	repairToolPairs,
	mergeConsecutiveTurns,
	buildConversationView,
	findCutIndex,
	estimateAskTokens,
	estimateToolDefinitionsTokens,
	CHARS_PER_TOKEN,
	DEFAULT_COMPACTION_CONTEXT_WINDOW,
	DEFAULT_COMPACTION_RESERVE_TOKENS,
	DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
	estimateItemTokens,
	serializeItemsForSummary,
	buildSummaryPrompt,
	compactionBlock,
	textBlock,
	toolUseBlock,
	toolResultBlock,
	doCompact,
	doRegisterTool,
	doStatus,
	runAsk,
	mergeAskResults,
	makeTodoFollowUpHook,
	shouldAutoCompact,
	isContextOverflowError,
	buildEffectiveSystem,
	// Subagent spawning
	doSpawn,
	doSubmitResult,
	doCancel,
	resolveAgentTemplate,
	BUILTIN_TEMPLATES,
	buildSubagentSystemPrompt,
	submitResultTool,
	spawnTool,
	validateAgainstSchema,
	doGetSubagents,
	renderSubagentTree,
	countDescendants,
	doRecall,
	renderBlockForRecall,
	// Test-only: clear in-memory run coordination state.
	_resetRunSlots,
	Semaphore,
	maxSpawnDepth,
};
