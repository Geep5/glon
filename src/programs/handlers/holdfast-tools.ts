// Holdfast tools — tool specs for the generic agent harness.
//
// Extracted from holdfast.ts to reduce omnibus size. Pure data +
// tool-builder functions; no holdfast business logic.

import type { ProgramContext } from "../runtime.js";
import { spawnTool } from "./agent.js";
import { todoWriteToolSpec } from "./todo.js";

export interface ToolSpec {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	target_prefix: string;
	target_action: string;
	/** Partial-application merged over the model's input — use to bind owner etc. */
	bound_args?: Record<string, unknown>;
}

const BASE_TOOLS: ToolSpec[] = [
	{
		name: "peer_list",
		description: "List all peers in your directory. Optionally filter by kind or trust_level.",
		input_schema: {
			type: "object",
			properties: {
				kind: { type: "string", description: "self | human | agent | service" },
				trust_level: { type: "string", description: "self | family | ops | stranger" },
			},
		},
		target_prefix: "/peer",
		target_action: "list",
	},
	{
		name: "peer_get",
		description: "Get full details for a peer by id. Useful when you need someone's Discord id, email, etc.",
		input_schema: {
			type: "object",
			properties: { peer_id: { type: "string" } },
			required: ["peer_id"],
		},
		target_prefix: "/peer",
		target_action: "get",
	},
	{
		name: "peer_add",
		description: "Add a new peer (person or agent) to your directory. Use when your principal introduces someone new. Defaults to kind=human, trust_level=stranger.",
		input_schema: {
			type: "object",
			properties: {
				display_name: { type: "string" },
				kind: { type: "string", enum: ["self", "human", "agent", "service"] },
				trust_level: { type: "string", enum: ["self", "family", "ops", "stranger"] },
				discord_id: { type: "string" },
				email: { type: "string" },
				notes: { type: "string" },
			},
			required: ["display_name"],
		},
		target_prefix: "/peer",
		target_action: "add",
	},
	{
		name: "peer_set_trust",
		description: "Change a peer's trust level. Only do this when explicitly asked by your principal — it changes what that peer can ask you to do.",
		input_schema: {
			type: "object",
			properties: {
				peer_id: { type: "string" },
				level: { type: "string", enum: ["self", "family", "ops", "stranger"] },
			},
			required: ["peer_id", "level"],
		},
		target_prefix: "/peer",
		target_action: "setTrust",
	},
	{
		name: "discord_send",
		description: "Send a Discord DM to a peer (who must have discord_id set). Use peer_list / peer_get to find the peer id.",
		input_schema: {
			type: "object",
			properties: {
				peer_id: { type: "string" },
				text: { type: "string" },
			},
			required: ["peer_id", "text"],
		},
		target_prefix: "/discord",
		target_action: "send",
	},
	{
		name: "discord_bridge_send",
		description: "Send a message to a Discord bridge channel (inter-agent communication). Use when you need to proactively reach another agent in a shared channel.",
		input_schema: {
			type: "object",
			properties: {
				channel_id: { type: "string" },
				text: { type: "string" },
			},
			required: ["channel_id", "text"],
		},
		target_prefix: "/discord",
		target_action: "sendChannel",
	},
	{
		name: "remind_schedule",
		description: [
			"Schedule a future action. fire_at accepts ISO 8601 (2026-04-24T15:00:00) or relative shorthand (+10m, +2h, +30s).",
			"Channels:",
			"  - discord: payload {message: '...'} — send exactly that text via DM.",
			"  - agent_compose: payload {prompt: '...'} — when it fires, you get re-invoked with the prompt and compose a fresh message (use this when the message should reflect current state, e.g. 'remind me about dinner, check traffic first').",
			"  - email: payload {subject, body} — requires /mail program (not yet wired).",
		].join("\n"),
		input_schema: {
			type: "object",
			properties: {
				channel: { type: "string", enum: ["discord", "email", "agent_compose"] },
				target: { type: "string", description: "peer_id for discord/agent_compose; email address for email" },
				fire_at: { type: "string", description: "ISO 8601 datetime or +Ns/+Nm/+Nh" },
				payload: { type: "object", description: "channel-specific data" },
				note: { type: "string", description: "human-readable label" },
			},
			required: ["channel", "target", "fire_at", "payload"],
		},
		target_prefix: "/remind",
		target_action: "schedule",
	},
	{
		name: "remind_list",
		description: "List scheduled reminders. Filter by status (pending|sent|failed|cancelled), peer_id, channel, or before_iso (date cutoff).",
		input_schema: {
			type: "object",
			properties: {
				peer_id: { type: "string" },
				status: { type: "string" },
				channel: { type: "string" },
				before_iso: { type: "string" },
			},
		},
		target_prefix: "/remind",
		target_action: "list",
	},
	{
		name: "remind_cancel",
		description: "Cancel a pending reminder by id.",
		input_schema: {
			type: "object",
			properties: { reminder_id: { type: "string" } },
			required: ["reminder_id"],
		},
		target_prefix: "/remind",
		target_action: "cancel",
	},

	// ── Graph introspection (read) ──────────────────────────────────

	{
		name: "object_list",
		description: [
			"List Glon objects. Without filters, returns every object in the store.",
			"Common type_keys you can filter by:",
			"  - program   (running programs including /holdfast, /agent, /peer, /discord, /remind)",
			"  - peer      (people and agents you talk to)",
			"  - agent     (LLM agent objects — you are one)",
			"  - reminder  (scheduled actions from /remind)",
			"  - typescript, proto, json, markdown (source files of the Glon environment itself)",
		].join("\n"),
		input_schema: {
			type: "object",
			properties: {
				type_key: { type: "string", description: "filter by type_key" },
				limit: { type: "number", description: "cap on results (default 100)" },
			},
		},
		target_prefix: "/crud",
		target_action: "list",
	},
	{
		name: "object_get",
		description: [
			"Read an object's full state: type_key, fields, block count, byte size, DAG heads.",
			"IMPORTANT: The returned payload is a summary. To get raw source code, ALWAYS use",
			"object_read_source with the object_id — do NOT decode the content/manifest fields yourself.",
			"For program objects, source lives in manifest.modules.<filename> as base64 inside a",
			"ValueMap; treat the manifest as opaque and read source via object_read_source on the",
			"typescript object it points at.",
		].join(" "),
		input_schema: {
			type: "object",
			properties: { object_id: { type: "string" } },
			required: ["object_id"],
		},
		target_prefix: "/crud",
		target_action: "get",
	},
	{
		name: "object_read_source",
		description: "Read the raw UTF-8 content of an object (source file, markdown, JSON, etc.). Truncates at max_bytes (default 16384, hard max 65536). Use this to inspect your own source code or read a file-like object.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				max_bytes: { type: "number", description: "truncate beyond this size (default 16384)" },
			},
			required: ["object_id"],
		},
		target_prefix: "/crud",
		target_action: "readContent",
	},
	{
		name: "object_search",
		description: "Full-text search across object fields and content. Narrow with type_key when relevant.",
		input_schema: {
			type: "object",
			properties: {
				query: { type: "string" },
				type_key: { type: "string" },
				limit: { type: "number" },
			},
			required: ["query"],
		},
		target_prefix: "/crud",
		target_action: "search",
	},
	{
		name: "object_history",
		description: "Show the DAG history (every Change) of an object: who changed what and when. Use this to audit mutations or find a prior value to restore.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				limit: { type: "number", description: "most recent N changes" },
			},
			required: ["object_id"],
		},
		target_prefix: "/inspect",
		target_action: "history",
	},
	{
		name: "object_links",
		description: "List the outgoing and incoming ObjectLink fields of an object. E.g. your agent has an outgoing 'principal' link to your principal's peer; that peer has it inbound.",
		input_schema: {
			type: "object",
			properties: { object_id: { type: "string" } },
			required: ["object_id"],
		},
		target_prefix: "/graph",
		target_action: "links",
	},

	// ── Graph mutation (write) ───────────────────────────────────────
	// Every write produces a new Change in the DAG. Prior values remain
	// retrievable via object_history — nothing is truly destroyed.
	// Prefer domain-specific tools (peer_add, remind_schedule, etc.) when
	// they exist; reach for these only for general-purpose graph work.

	{
		name: "object_create",
		description: [
			"Create a new Glon object of the given type_key. fields is a {key: primitive|Value} map;",
			"content is optional UTF-8 text for plain file-like objects.",
			"Prefer peer_add / remind_schedule for domain objects — this is for novel types.",
			"IMPORTANT: type_key='program' objects have a specific structure Glon's runtime requires",
			"(manifest.modules.<filename> as a nested ValueMap of base64-encoded source). Do NOT try to",
			"create program objects with this tool — ask your principal to add the program to bootstrap.ts",
			"instead; it's the supported way to register new programs.",
		].join(" "),
		input_schema: {
			type: "object",
			properties: {
				type_key: { type: "string" },
				fields: { type: "object", description: "e.g. {name: 'foo', priority: 1}" },
				content: { type: "string", description: "UTF-8 content, optional" },
			},
			required: ["type_key"],
		},
		target_prefix: "/crud",
		target_action: "create",
	},
	{
		name: "object_set_field",
		description: [
			"Set a single field on an object. Value can be a plain string, number, boolean (auto-coerced),",
			"or a pre-built Value JSON.",
			"Major self-mutations (your own system prompt, your model, a peer's trust level) should be",
			"announced to your principal before you do them.",
			"DO NOT modify your own `tools` field directly with this — the ValueMap shape is easy to",
			"get wrong and will brick your tool access. If your principal wants you to gain a new capability,",
			"ask them to add it in the harness source so it auto-registers next setup.",
		].join(" "),
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				key: { type: "string" },
				value: { description: "string | number | boolean | Value object" },
			},
			required: ["object_id", "key", "value"],
		},
		target_prefix: "/crud",
		target_action: "setField",
	},
	{
		name: "object_delete_field",
		description: "Remove a field from an object. History retains the prior value.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				key: { type: "string" },
			},
			required: ["object_id", "key"],
		},
		target_prefix: "/crud",
		target_action: "deleteField",
	},
	{
		name: "object_set_content",
		description: "Replace the raw content of an object with new UTF-8 text. Use for editing source-file-like objects. History is preserved.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				content: { type: "string", description: "UTF-8 content replacing the current bytes" },
			},
			required: ["object_id", "content"],
		},
		target_prefix: "/crud",
		target_action: "setContent",
	},
	{
		name: "object_remove",
		description: "Tombstone an object (sets deleted=true flag). Recoverable — it stays in the DAG and can be un-deleted by setting the flag back.",
		input_schema: {
			type: "object",
			properties: { object_id: { type: "string" } },
			required: ["object_id"],
		},
		target_prefix: "/crud",
		target_action: "remove",
	},
	{
		name: "object_add_block",
		description: "Append a block to an object. Primarily useful for injecting structured notes into agent conversations or adding messages to chat rooms. block must be a Glon Block shape: {id, childrenIds:[], content:{text:{text,style}} | {custom:{contentType,data,meta}}}.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string" },
				block: { type: "object", description: "Glon Block shape" },
			},
			required: ["object_id", "block"],
		},
		target_prefix: "/crud",
		target_action: "addBlock",
	},
];

// ── Memory tools ─────────────────────────────────────────────────
//
// These bind `owner = agentId` so the model never handles its own id
// (and can't spoof a different one). All memory actions filter by owner.

function buildMemoryTools(agentId: string): ToolSpec[] {
	const owner = { owner: agentId };
	return [
		{
			name: "memory_upsert_fact",
			description: "Pin a durable fact you want to remember across compactions. One row per `key` — upserting the same key replaces the value (old value stays in object_history). Use for contact info, preferences, names, boundaries.",
			input_schema: {
				type: "object",
				properties: {
					key: { type: "string", description: "short identifier, e.g. 'principal_birthday' or 'moms_email'" },
					value: { type: "string" },
					confidence: { type: "string", enum: ["low", "med", "high"], description: "defaults to med" },
					sourced_from_block_id: { type: "string", description: "block id in this conversation where the fact came from (optional)" },
				},
				required: ["key", "value"],
			},
			target_prefix: "/memory",
			target_action: "upsert_fact",
			bound_args: owner,
		},
		{
			name: "memory_list_facts",
			description: "List your pinned facts. Optionally filter by `key`.",
			input_schema: {
				type: "object",
				properties: { key: { type: "string" } },
			},
			target_prefix: "/memory",
			target_action: "list_facts",
			bound_args: owner,
		},
		{
			name: "memory_upsert_milestone",
			description: [
				"Record a multi-turn arc: a project, decision, onboarding, phase — anything bigger than a single fact.",
				"Pass `supersedes: [id,...]` when this milestone replaces or amends older ones; they'll be auto-marked 'superseded' but stay readable.",
				"Use amend_milestone instead when editing an existing milestone in place (preferred for small corrections).",
			].join(" "),
			input_schema: {
				type: "object",
				properties: {
					title: { type: "string" },
					narrative: { type: "string", description: "prose — what happened, what was decided, what's next" },
					topics: { type: "array", items: { type: "string" }, description: "short tags for later recall" },
					peers: { type: "array", items: { type: "string" }, description: "peer ids involved" },
					supersedes: { type: "array", items: { type: "string" }, description: "milestone ids this replaces/amends" },
					status: { type: "string", enum: ["active", "completed", "superseded"], description: "defaults to active" },
					confidence: { type: "string", enum: ["low", "med", "high"] },
					sourced_from_blocks: { type: "array", items: { type: "string" }, description: "conversation block ids that informed this milestone" },
					started_at: { type: "number", description: "unix ms; when the arc began" },
					ended_at: { type: "number", description: "unix ms; when it ended (if it did)" },
				},
				required: ["title", "narrative"],
			},
			target_prefix: "/memory",
			target_action: "upsert_milestone",
			bound_args: owner,
		},
		{
			name: "memory_amend_milestone",
			description: "Edit fields on an existing milestone in place. Use when correcting or extending a past milestone; prior field values remain in object_history. Only pass fields you want to change.",
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
			// No bound_args — amend is scoped by milestone_id (itself owner-locked server-side).
		},
		{
			name: "memory_list_milestones",
			description: "List your milestones, optionally filtered by status/topic/peer. Most-recently-updated first.",
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
			name: "memory_get_milestone",
			description: "Read one milestone in full by id.",
			input_schema: {
				type: "object",
				properties: { milestone_id: { type: "string" } },
				required: ["milestone_id"],
			},
			target_prefix: "/memory",
			target_action: "get_milestone",
		},
		{
			name: "memory_recall",
			description: "Scoped search over your memory. Use before answering when prior context may matter.",
			input_schema: {
				type: "object",
				properties: {
					query: { type: "string", description: "case-insensitive substring over fact key/value and milestone title/narrative/topics" },
					topics: { type: "array", items: { type: "string" } },
					peer_ids: { type: "array", items: { type: "string" } },
					time_range_start: { type: "number" },
					time_range_end: { type: "number" },
					limit_facts: { type: "number" },
					limit_milestones: { type: "number" },
					include_superseded: { type: "boolean" },
				},
			},
			target_prefix: "/memory",
			target_action: "recall",
			bound_args: owner,
		},
	];
}

// ── Shell tools (via /shell → persistent bash sessions) ────────────
//
// Full bash, no gate. Trusted environment — the agent can run anything the
// principal's user can run. Sessions persist cwd + env across calls so
// multi-step work composes naturally.

function buildShellTools(): ToolSpec[] {
	return [
		{
			name: "shell_exec",
			description: [
				"Run a bash command in a persistent session on the principal's machine.",
				"Full bash semantics: pipes, redirects, $VARS, globs, backgrounding.",
				"cwd and env persist across calls within the same `session` name.",
				"Default session is 'main'. Use distinct session names to run parallel work.",
				"Returns stdout, stderr, exit_code, duration_ms, and the resulting cwd.",
			].join(" "),
			input_schema: {
				type: "object",
				properties: {
					command: { type: "string", description: "bash command line, e.g. 'cd ~/projekt && git status'" },
					session: { type: "string", description: "session name; default 'main'" },
					timeout_ms: { type: "number", description: "per-call timeout; default 30000, max 600000" },
				},
				required: ["command"],
			},
			target_prefix: "/shell",
			target_action: "exec",
		},
		{
			name: "shell_sessions",
			description: "List live shell sessions with cwd, exec count, and idle time.",
			input_schema: { type: "object", properties: {} },
			target_prefix: "/shell",
			target_action: "list_sessions",
		},
		{
			name: "shell_kill",
			description: "Kill and discard a shell session. Next shell_exec on that name starts a fresh bash. Use when a session hangs or you need a clean state.",
			input_schema: {
				type: "object",
				properties: { session: { type: "string", description: "session name; default 'main'" } },
			},
			target_prefix: "/shell",
			target_action: "kill",
		},
	];
}

function buildPeerChatTools(agentId: string, agentDisplayName: string): ToolSpec[] {
	const sender = { from_agent_id: agentId };
	const rosterReplyBound: Record<string, unknown> = { label: agentDisplayName };
	return [
		{
			name: "peer_conversation_start",
			description: "Start a new goal-driven conversation with a peered agent or human. Address the target by display_name when you know it (\"Mikey\", \"Tarzan\") — names are unique across local agents. Fall back to peer_id or agent_uuid only if name resolution is ambiguous. Always include a clear, specific goal (e.g. 'introduce ourselves', 'coordinate Cash's pickup tomorrow', 'compare task-tracking approaches'). The opening text becomes the first message. Returns conversation_id — use that in subsequent peer_message_send / peer_conversation_done calls.\n\nDELEGATION: when you start this conversation as a result of a human asking you to ask someone else (e.g. \"can you ask Mikey…\"), pass `originated_from` with the source `thread_id` and `message_id` from the [origin_thread=… origin_msg=…] tags in your incoming H2A prompt. This lets the system automatically relay the eventual answer back to that human in their original chat thread — without it, the answer will sit on your A2A side and the requester never hears back.",
			input_schema: {
				type: "object",
				required: ["goal", "text"],
				properties: {
					display_name: { type: "string", description: "Target's name (preferred — names are unique among local agents)." },
					peer_id: { type: "string", description: "Peer id from peer_list (use if you already have it)." },
					agent_uuid: { type: "string", description: "Globally unique agent UUID (v4). Use when display_name is ambiguous." },
					goal: { type: "string", description: "Human-readable purpose, 1-280 chars." },
					text: { type: "string", description: "Opening message." },
					originated_from: {
						type: "object",
						description: "When this conversation is a delegation triggered by a human request, pass the source thread/message info so the answer can be relayed back automatically.",
						properties: {
							kind: { type: "string", description: "Origin type, e.g. 'discord-roster'." },
							thread_id: { type: "string", description: "Discord thread id where the human asked." },
							message_id: { type: "string", description: "Discord message id of the human's request." },
							human_peer_id: { type: "string", description: "The human's /peer record id." },
							human_display_name: { type: "string", description: "How to address them in the relay reply." },
							original_request: { type: "string", description: "Short snippet of the human's original request (helps you remember what to relay)." },
						},
					},
				},
			},
			target_prefix: "/peer-chat",
			target_action: "startConversation",
			bound_args: sender,
		},
		{
			name: "roster_chat_reply",
			description: "Post a message into a Discord roster thread (an agent's H2A chat room). Use this to relay an A2A answer back to the human who originally asked. The system will surface the right thread_id in your prompt when a relay is needed — just pass it through. Your name is auto-prefixed; you don't need to write \"<your name>:\" yourself.",
			input_schema: {
				type: "object",
				required: ["thread_id", "text"],
				properties: {
					thread_id: { type: "string", description: "Discord thread id of the human's chat room — provided in the relay prompt." },
					text: { type: "string", description: "Message body to post. Don't repeat your own name — the system will prefix it for you." },
				},
			},
			target_prefix: "/discord",
			target_action: "rosterChatReply",
			bound_args: rosterReplyBound,
		},
		{
			name: "peer_message_send",
			description: "Send a follow-up message into an active conversation. Requires conversation_id from a prior peer_conversation_start (or from peer_conversations_list). Fails if the conversation is done/auto-expired — start a new one to continue.",
			input_schema: {
				type: "object",
				required: ["conversation_id", "text"],
				properties: {
					conversation_id: { type: "string", description: "From a prior peer_conversation_start or peer_conversations_list result." },
					text: { type: "string", description: "Message body, up to ~8000 chars." },
					in_reply_to: { type: ["string", "null"], description: "Optional msg_id this message is a reply to." },
				},
			},
			target_prefix: "/peer-chat",
			target_action: "send",
			bound_args: sender,
		},
		{
			name: "peer_conversation_done",
			description: "Close a conversation when the goal is achieved, the conversation has run its course, or further reply would not add value. Either side can call this — one-sided done closes it for both. Be willing to use this freely: sign-offs, acknowledgements, and 'sounds good' filler should END the thread, not extend it. Include a short reason ('greeted', 'agreed to meet at 4pm', 'no further questions').",
			input_schema: {
				type: "object",
				required: ["conversation_id"],
				properties: {
					conversation_id: { type: "string" },
					reason: { type: "string", description: "Short reason — what was achieved or why ending." },
				},
			},
			target_prefix: "/peer-chat",
			target_action: "endConversation",
			bound_args: sender,
		},
		{
			name: "peer_conversations_list",
			description: "List YOUR conversations (filtered to ones you own). Optional peer_id or agent_uuid narrows to a specific peer; optional status (active/done/paused) narrows by state. Each entry includes conversation_id, goal, status, hops_remaining, last_message_preview.",
			input_schema: {
				type: "object",
				properties: {
					peer_id: { type: "string" },
					agent_uuid: { type: "string" },
					status: { type: "string", enum: ["active", "done", "paused"] },
				},
			},
			target_prefix: "/peer-chat",
			target_action: "listConversations",
			bound_args: sender,
		},
		{
			name: "peer_message_list",
			description: "Read messages in a specific conversation. Pass conversation_id (preferred) from peer_conversations_list.",
			input_schema: {
				type: "object",
				properties: {
					conversation_id: { type: "string" },
					peer_id: { type: "string", description: "Fallback if you don't have a conversation_id; uses the most recent matching conversation." },
					agent_uuid: { type: "string" },
					since: { type: "number" },
					limit: { type: "number" },
				},
			},
			target_prefix: "/peer-chat",
			target_action: "listMessages",
			bound_args: sender,
		},
	];
}

export function buildHarnessTools(agentId: string, agentDisplayName: string = "agent"): ToolSpec[] {
	return [
		...BASE_TOOLS,
		...buildMemoryTools(agentId),
		...buildShellTools(),
		...buildPeerChatTools(agentId, agentDisplayName),
		// /todo: phased task list per agent. Pairs with the follow-up hook
		// in /agent — the harness re-prompts when items remain incomplete.
		todoWriteToolSpec(agentId),
		spawnTool(agentId),
	];
}

export async function autoWireTools(agentId: string, ctx: ProgramContext): Promise<{ wired: string[]; skipped: { name: string; reason: string }[]; pruned: string[] }> {
	const wired: string[] = [];
	const skipped: { name: string; reason: string }[] = [];
	// Look up the agent's display name from the store so we can bake it
	// into tools that need it (e.g., roster_chat_reply auto-prefixes
	// the agent's name on every reply).
	let agentDisplayName = "agent";
	try {
		const store = ctx.store as any;
		const agent = await store.get(agentId);
		const nameVal = agent?.fields?.name;
		const extracted = typeof nameVal === "string" ? nameVal : nameVal?.stringValue;
		if (extracted) agentDisplayName = String(extracted);
	} catch { /* fall back to default */ }
	const tools = buildHarnessTools(agentId, agentDisplayName);
	for (const spec of tools) {
		try {
			await ctx.dispatchProgram("/agent", "registerTool", [agentId, JSON.stringify(spec)]);
			wired.push(spec.name);
		} catch (err: any) {
			skipped.push({ name: spec.name, reason: err?.message ?? String(err) });
		}
	}

	// Prune stale tools: registerTool is upsert-only by name, so when the
	// authoritative tool list shrinks (for example when a /web wrapper is
	// removed in favour of shell_exec), the old entries linger in the agent's
	// `tools` map and the model is told to call programs that no longer
	// exist. Diff against the current map and rewrite without the strays.
	const pruned: string[] = [];
	try {
		const store = ctx.store as any;
		const client = ctx.client as any;
		const agent = await store.get(agentId);
		const entries = agent?.fields?.tools?.mapValue?.entries ?? {};
		const keep = new Set(wired);
		const keptEntries: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(entries)) {
			if (keep.has(k)) keptEntries[k] = v;
			else pruned.push(k);
		}
		if (pruned.length > 0) {
			const newToolsValue = { mapValue: { entries: keptEntries, kind: "mapValue" }, kind: "mapValue" };
			const actor = client.objectActor.getOrCreate([agentId]);
			await actor.setField("tools", JSON.stringify(newToolsValue));
		}
	} catch {
		// Best-effort prune. If the store call fails (no client, transient), the
		// next refresh will catch it.
	}

	return { wired, skipped, pruned };
}
