// peer-chat — agent-to-agent text messaging over Discord threads.
//
// Discord is the truth. Every conversation is a thread inside a pair
// channel; the thread's name is the goal; the thread's locked/archived
// flags are the conversation's lifecycle. This actor stores no
// conversation state of its own — every read fetches from Discord on
// demand, and every write is a thin wrapper over /discord.
//
// Identity:
//   - agent_uuid identifies an agent globally (v4, minted at bootstrap)
//   - display_name is human-readable, may collide across daemons
//   - On THIS daemon, /peer.agent_object_id maps a local agent's UUID
//     back to its rivetkit /agent id so handleA2A can dispatch agent.ask
//
// Trust: the Discord bot token IS the auth boundary. /peer.trust_level
// gates which peers can initiate / receive A2A; peer-chat enforces it
// on both ends.
//
// Wire envelope (v1):
//   { v, from_agent_uuid, from_display_name, to_agent_uuid, to_display_name, body }
// Everything else is derived from the surrounding Discord message + thread.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, green, red, yellow } from "../shared.js";

const PEER_TRUSTED_LEVELS = new Set(["trusted", "friend", "family", "self"]);
function isPeered(trust_level: string | undefined | null): boolean {
	return !!trust_level && PEER_TRUSTED_LEVELS.has(trust_level);
}

const MAX_BODY_LEN = 8000;
const MAX_GOAL_LEN = 100; // Discord thread name limit

// ── Types (return-only — no persisted state) ────────────────────

/** Optional delegation context attached to the opening envelope of an
 *  A2A conversation. Lets the receiving daemon (or the originating agent
 *  on done) know that this conversation was started on behalf of a human
 *  who is waiting for the answer in some Discord chat thread. When set,
 *  the daemon fires a relay step after the A2A closes so the agent can
 *  post the result back to the original requester. */
export interface OriginatedFrom {
	kind: "discord-roster" | string;
	thread_id: string;         // Discord thread the human was chatting in
	message_id?: string;       // the human's message that triggered this delegation
	human_peer_id?: string;    // /peer record id for the human
	human_display_name?: string;
	original_request?: string; // short snippet of what the human asked (for relay context)
}

interface A2AEnvelope {
	v: 1;
	from_agent_uuid: string;
	from_display_name: string;
	to_agent_uuid: string;
	to_display_name: string;
	body: unknown;
	originated_from?: OriginatedFrom;
}

export interface PeerMessage {
	msg_id: string;                      // Discord message id (snowflake)
	conversation_id: string;             // = thread id
	direction: "in" | "out";
	in_reply_to: string | null;          // Discord message id or null
	body: unknown;
	sent_at: number;                     // derived from snowflake
	from_agent_uuid: string;
	from_display_name: string;
}

export type ConversationStatus = "active" | "done" | "paused";

export interface Conversation {
	conversation_id: string;             // = thread id
	goal: string;                         // = thread name
	peer_agent_uuid: string;
	peer_display_name: string;
	owner_agent_object_id: string;       // local agent that owns this view
	status: ConversationStatus;
	message_count: number;
	last_message_at: number | null;
}

// ── Local agent / peer lookups (still needed for routing) ────────

interface LocalAgentPeer {
	peer_id: string;
	agent_object_id: string;
	agent_uuid: string;
	display_name: string;
}

async function listLocalAgentPeers(ctx: ProgramContext): Promise<LocalAgentPeer[]> {
	const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peers = Array.isArray(all) ? all : [];
	const out: LocalAgentPeer[] = [];
	for (const p of peers) {
		if (p.kind !== "agent") continue;
		const uuid = p.agent_uuid;
		const obj = p.agent_object_id;
		if (!uuid || !obj) continue;
		out.push({ peer_id: p.id, agent_object_id: obj, agent_uuid: uuid, display_name: p.display_name ?? obj });
	}
	return out;
}

async function findLocalAgentByObjectId(ctx: ProgramContext, agentObjectId: string): Promise<LocalAgentPeer | null> {
	const list = await listLocalAgentPeers(ctx);
	return list.find((a) => a.agent_object_id === agentObjectId) ?? null;
}

async function findLocalAgentByUuid(ctx: ProgramContext, agentUuid: string): Promise<LocalAgentPeer | null> {
	const list = await listLocalAgentPeers(ctx);
	const want = agentUuid.toLowerCase();
	return list.find((a) => a.agent_uuid.toLowerCase() === want) ?? null;
}

interface ResolvedPeer {
	peer_id: string;
	agent_uuid: string;
	display_name: string;
}

async function resolvePeerForChat(
	ctx: ProgramContext,
	ref: { peer_id?: string; agent_uuid?: string; display_name?: string },
): Promise<ResolvedPeer> {
	const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peers = Array.isArray(all) ? all : [];
	const candidates = peers.filter((p) => {
		if (p.kind !== "agent") return false;
		if (ref.peer_id && p.id === ref.peer_id) return true;
		if (ref.agent_uuid && (p.agent_uuid ?? "").toLowerCase() === ref.agent_uuid.toLowerCase()) return true;
		if (ref.display_name && (p.display_name ?? "").toLowerCase() === ref.display_name.toLowerCase()) return true;
		return false;
	});
	const match = candidates.slice().sort((a, b) => (isPeered(b.trust_level) ? 1 : 0) - (isPeered(a.trust_level) ? 1 : 0))[0];
	if (!match) throw new Error(`peer-chat: no agent peer matches ${JSON.stringify(ref)}`);
	let effectiveTrust = match.trust_level;
	if (!isPeered(effectiveTrust) && match.host_peer_id) {
		const host = peers.find((p) => p.id === match.host_peer_id);
		if (host && isPeered(host.trust_level)) effectiveTrust = host.trust_level;
	}
	if (!isPeered(effectiveTrust)) {
		throw new Error(`peer-chat: peer "${match.display_name}" is at trust=${match.trust_level}; need a peered trust level.`);
	}
	if (!match.agent_uuid) throw new Error(`peer-chat: peer "${match.display_name}" has no agent_uuid (re-bootstrap may be needed)`);
	return { peer_id: match.id, agent_uuid: match.agent_uuid, display_name: match.display_name ?? match.id };
}

async function getDisplayNameForUuid(ctx: ProgramContext, agentUuid: string): Promise<string> {
	const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peers = Array.isArray(all) ? all : [];
	const match = peers.find((p) => p.kind === "agent" && (p.agent_uuid ?? "").toLowerCase() === agentUuid.toLowerCase());
	return match?.display_name ?? agentUuid.slice(0, 8);
}

// ── Action: startConversation ────────────────────────────────────

interface StartConversationInput {
	peer_id?: string;
	agent_uuid?: string;
	display_name?: string;
	goal: string;
	text: string;
	from_agent_id?: string;
	/** When set, this conversation is a delegation triggered by a human's
	 *  request. The daemon will surface this context in the relay-on-done
	 *  auto-trigger so the agent can post the answer back to the original
	 *  requester. Pass the source thread_id + message_id + human peer info
	 *  captured from the H2A invocation prompt. */
	originated_from?: OriginatedFrom;
}

interface StartConversationResult {
	conversation_id: string;
	msg_id: string;
	channel_id: string;
	thread_id: string;
}

async function doStartConversation(ctx: ProgramContext, input: StartConversationInput): Promise<StartConversationResult> {
	if (typeof input?.goal !== "string" || !input.goal.trim()) {
		throw new Error("peer-chat startConversation: `goal` is required");
	}
	if (input.goal.length > MAX_GOAL_LEN) {
		throw new Error(`peer-chat startConversation: goal too long (${input.goal.length} > ${MAX_GOAL_LEN})`);
	}
	if (typeof input?.text !== "string" || !input.text.length) {
		throw new Error("peer-chat startConversation: `text` is required");
	}
	if (input.text.length > MAX_BODY_LEN) {
		throw new Error(`peer-chat startConversation: text too long (${input.text.length} > ${MAX_BODY_LEN})`);
	}
	if (!input.from_agent_id) {
		throw new Error("peer-chat startConversation: from_agent_id is required");
	}

	const sender = await findLocalAgentByObjectId(ctx, input.from_agent_id);
	if (!sender) throw new Error(`peer-chat startConversation: no local agent with object id ${input.from_agent_id}`);
	const peer = await resolvePeerForChat(ctx, input);

	// 1. Ensure the pair channel for these two agents
	const pair = await ctx.dispatchProgram("/discord", "ensurePairChannel", [{
		peer_a_agent_uuid: sender.agent_uuid,
		peer_b_agent_uuid: peer.agent_uuid,
	}]) as { channel_id: string };
	if (!pair?.channel_id) throw new Error("peer-chat startConversation: /discord ensurePairChannel returned no channel_id");

	// 2. Create a fresh thread for this conversation (name = goal)
	const thread = await ctx.dispatchProgram("/discord", "ensureConversationThread", [{
		pair_channel_id: pair.channel_id,
		name: input.goal.trim(),
	}]) as { thread_id: string; name: string };
	if (!thread?.thread_id) throw new Error("peer-chat startConversation: /discord ensureConversationThread returned no thread_id");

	// 3. Post the opening envelope inside the thread (includes the optional
	//    originated_from delegation context so the relay-on-done step has it)
	const envelope: A2AEnvelope = {
		v: 1,
		from_agent_uuid: sender.agent_uuid,
		from_display_name: sender.display_name,
		to_agent_uuid: peer.agent_uuid,
		to_display_name: peer.display_name,
		body: input.text,
	};
	if (input.originated_from && input.originated_from.thread_id) {
		envelope.originated_from = {
			kind: input.originated_from.kind || "discord-roster",
			thread_id: String(input.originated_from.thread_id),
			message_id: input.originated_from.message_id ? String(input.originated_from.message_id) : undefined,
			human_peer_id: input.originated_from.human_peer_id ? String(input.originated_from.human_peer_id) : undefined,
			human_display_name: input.originated_from.human_display_name ? String(input.originated_from.human_display_name) : undefined,
			original_request: input.originated_from.original_request ? String(input.originated_from.original_request).slice(0, 500) : undefined,
		};
	}
	const posted = await ctx.dispatchProgram("/discord", "postToThread", [{
		thread_id: thread.thread_id,
		envelope,
	}]) as { message_id: string };

	return {
		conversation_id: thread.thread_id,
		msg_id: posted.message_id,
		channel_id: pair.channel_id,
		thread_id: thread.thread_id,
	};
}

// ── Action: send ─────────────────────────────────────────────────

interface SendInput {
	conversation_id: string;
	text: string;
	in_reply_to?: string | null;
	from_agent_id?: string;
}

async function doSend(ctx: ProgramContext, input: SendInput): Promise<{ msg_id: string }> {
	if (typeof input?.text !== "string" || !input.text.length) throw new Error("peer-chat send: `text` is required");
	if (input.text.length > MAX_BODY_LEN) throw new Error(`peer-chat send: message too long`);
	if (!input?.conversation_id) throw new Error("peer-chat send: conversation_id is required");
	if (!input?.from_agent_id) throw new Error("peer-chat send: from_agent_id is required");

	const sender = await findLocalAgentByObjectId(ctx, input.from_agent_id);
	if (!sender) throw new Error(`peer-chat send: no local agent with object id ${input.from_agent_id}`);

	// Look up the thread + its current message_count etc. via a list call.
	// We also need to know who the OTHER participant is — derived from the
	// thread's parent pair channel.
	const { peer_agent_uuid, peer_display_name } = await getPeerForThread(ctx, input.conversation_id, sender.agent_uuid);

	const envelope: A2AEnvelope = {
		v: 1,
		from_agent_uuid: sender.agent_uuid,
		from_display_name: sender.display_name,
		to_agent_uuid: peer_agent_uuid,
		to_display_name: peer_display_name,
		body: input.text,
	};
	const posted = await ctx.dispatchProgram("/discord", "postToThread", [{
		thread_id: input.conversation_id,
		envelope,
		reply_to_discord_id: input.in_reply_to ?? undefined,
	}]) as { message_id: string };

	return { msg_id: posted.message_id };
}

// ── Action: endConversation ──────────────────────────────────────

interface EndConversationInput {
	conversation_id: string;
	reason?: string;
	from_agent_id?: string;
}

async function doEndConversation(ctx: ProgramContext, input: EndConversationInput): Promise<{ ok: true }> {
	if (!input?.conversation_id) throw new Error("peer-chat endConversation: conversation_id is required");
	if (!input?.from_agent_id) throw new Error("peer-chat endConversation: from_agent_id is required");

	const sender = await findLocalAgentByObjectId(ctx, input.from_agent_id);
	if (!sender) throw new Error(`peer-chat endConversation: no local agent with object id ${input.from_agent_id}`);

	// Post a final message stating the reason (so the human transcript
	// reads naturally), then lock+archive the thread.
	const reason = (input.reason ?? "").toString().slice(0, 200) || "no reason given";
	try {
		const { peer_agent_uuid, peer_display_name } = await getPeerForThread(ctx, input.conversation_id, sender.agent_uuid);
		await ctx.dispatchProgram("/discord", "postToThread", [{
			thread_id: input.conversation_id,
			envelope: {
				v: 1,
				from_agent_uuid: sender.agent_uuid,
				from_display_name: sender.display_name,
				to_agent_uuid: peer_agent_uuid,
				to_display_name: peer_display_name,
				body: `[conversation done] ${reason}`,
			},
		}]);
	} catch (err: any) {
		ctx.print?.(dim(`[peer-chat] endConversation: final-message post failed (${err?.message ?? err}); locking anyway`));
	}

	await ctx.dispatchProgram("/discord", "archiveThread", [{
		thread_id: input.conversation_id,
		locked: true,
	}]);
	return { ok: true };
}

// ── Action: resumeConversation ──────────────────────────────────

interface ResumeConversationInput {
	conversation_id: string;
	from_agent_id?: string;   // not strictly required since this only un-archives
}

async function doResumeConversation(ctx: ProgramContext, input: ResumeConversationInput): Promise<{ ok: true }> {
	if (!input?.conversation_id) throw new Error("peer-chat resumeConversation: conversation_id is required");
	await ctx.dispatchProgram("/discord", "unarchiveThread", [{ thread_id: input.conversation_id }]);
	return { ok: true };
}

// ── handleA2A: inbound envelope from /discord poll ──────────────

interface HandleA2AInput {
	envelope: A2AEnvelope;
	thread_id: string;
	thread_name: string;
	channel_id: string;
	discord_message_id: string;
	in_reply_to_discord_id?: string | null;
	sent_at?: number;
	thread_archived?: boolean;
	thread_locked?: boolean;
}

async function doHandleA2A(ctx: ProgramContext, input: HandleA2AInput): Promise<{ processed: boolean; reason?: string }> {
	const env = input?.envelope;
	if (!env || typeof env !== "object") return { processed: false, reason: "no envelope" };
	if (env.v !== 1) return { processed: false, reason: `unknown version ${env.v}` };
	if (!env.from_agent_uuid || !env.to_agent_uuid) return { processed: false, reason: "missing agent_uuids" };

	// Recipient must be a local agent on this daemon. We process locked
	// threads here too — doneness is a property of the envelope (kind:done),
	// not a reason to skip — and we may need to surface the relay step.
	const recipient = await findLocalAgentByUuid(ctx, env.to_agent_uuid);
	if (!recipient) return { processed: false, reason: "no local recipient" };

	// Trust gate on sender
	const allPeers = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const senderPeer = (Array.isArray(allPeers) ? allPeers : [])
		.find((p) => p.kind === "agent" && (p.agent_uuid ?? "").toLowerCase() === env.from_agent_uuid.toLowerCase());
	if (!senderPeer) {
		ctx.print?.(dim(`[peer-chat] dropped inbound: sender agent_uuid ${env.from_agent_uuid.slice(0, 12)}… not in /peer`));
		return { processed: false, reason: "sender not in /peer" };
	}
	let effectiveTrust = senderPeer.trust_level;
	if (!isPeered(effectiveTrust) && senderPeer.host_peer_id) {
		const host = (Array.isArray(allPeers) ? allPeers : []).find((p) => p.id === senderPeer.host_peer_id);
		if (host && isPeered(host.trust_level)) effectiveTrust = host.trust_level;
	}
	if (!isPeered(effectiveTrust)) {
		ctx.print?.(dim(`[peer-chat] dropped inbound: sender ${senderPeer.display_name} at trust=${senderPeer.trust_level}`));
		return { processed: false, reason: "sender not peered" };
	}

	// Look up the conversation's delegation context, if any. We do this for
	// both text and done envelopes — for text we surface "you're answering
	// on behalf of X" in the prompt; for done we surface "now relay back."
	const originatedFrom = await lookupOriginatedFromForThread(ctx, input.thread_id);

	const goal = (input.thread_name || "(no goal)").slice(0, 200);
	const bodyPreview = String(env.body ?? "").slice(0, 1500);
	const kind = env.kind === "done" ? "done" : "text";

	let prompt: string;
	if (kind === "done") {
		// The peer just closed the conversation. Surface the closing reason
		// + delegation context (if any) and instruct the agent on next step.
		const lines = [
			`A peer-chat conversation just closed.`,
			`Conversation id: ${input.thread_id}`,
			`Goal: ${goal}`,
			`Closed by: ${env.from_display_name || env.from_agent_uuid.slice(0, 8)}`,
			`Closing reason: ${bodyPreview}`,
			``,
		];
		if (originatedFrom?.thread_id) {
			lines.push(
				`This conversation was started by you on behalf of ${originatedFrom.human_display_name ?? "a human requester"} ` +
				`who asked you in Discord thread \`${originatedFrom.thread_id}\`.`,
			);
			if (originatedFrom.original_request) {
				lines.push(`Their original request: "${originatedFrom.original_request}"`);
			}
			lines.push(``);
			lines.push(
				`Now relay the answer back to them. Call:`,
				`  roster_chat_reply({`,
				`    thread_id: "${originatedFrom.thread_id}",`,
				`    text: "<a clear, concise summary of what you learned from the peer; address the requester by name>"`,
				`  })`,
				``,
				`Your name (${recipient.display_name}) is auto-prefixed — don't write "${recipient.display_name}:" yourself.`,
				`This is the last thing you need to do for this delegation. After posting, you're done.`,
			);
		} else {
			lines.push(
				`No relay context — the conversation closed cleanly. ` +
				`If you have nothing further to do, this turn can be a no-op.`,
			);
		}
		prompt = lines.join("\n");
	} else {
		const lines = [
			`You have a new peer-chat message in an active conversation.`,
			`Conversation id: ${input.thread_id}`,
			`Goal: ${goal}`,
			`From: ${env.from_display_name || env.from_agent_uuid.slice(0, 8)}`,
			`Message: ${bodyPreview}`,
			``,
		];
		if (originatedFrom?.thread_id) {
			lines.push(
				`Note: this conversation was started by you on behalf of ` +
				`${originatedFrom.human_display_name ?? "a human requester"} in thread \`${originatedFrom.thread_id}\`. ` +
				`When you call peer_conversation_done, the system will prompt you to relay back to them.`,
			);
			lines.push(``);
		}
		lines.push(
			`If the goal is achieved or further reply would not add value, ` +
			`call peer_conversation_done with a short reason (this locks the thread). ` +
			`Otherwise, call peer_message_send with conversation_id=${input.thread_id} to reply. ` +
			`Do NOT ask the human user — this is autonomous A2A.`,
		);
		prompt = lines.join("\n");
	}

	try {
		await ctx.dispatchProgram("/agent", "ask", [recipient.agent_object_id, prompt]);
	} catch (err: any) {
		ctx.print?.(dim(`  [peer-chat] auto-trigger failed for ${recipient.agent_object_id}/${input.thread_id}: ${err?.message ?? err}`));
	}
	return { processed: true };
}

/** Fetch the conversation's opening envelope from Discord and extract its
 *  originated_from delegation context (if any). Returns null when the
 *  conversation wasn't started as a delegation from a human request. */
async function lookupOriginatedFromForThread(ctx: ProgramContext, threadId: string): Promise<OriginatedFrom | null> {
	try {
		// The thread's starter message has the same id as the thread itself
		// (Discord convention for thread-starter messages in pair channels).
		const starter = await ctx.dispatchProgram("/discord", "listThreadMessages", [{
			thread_id: threadId,
			limit: 1,
		}]) as Array<{ envelope?: A2AEnvelope }>;
		if (!Array.isArray(starter) || starter.length === 0) return null;
		const env = starter[0]?.envelope;
		if (!env || !env.originated_from) return null;
		const o = env.originated_from;
		if (!o.thread_id) return null;
		return {
			kind: String(o.kind ?? "discord-roster"),
			thread_id: String(o.thread_id),
			message_id: o.message_id ? String(o.message_id) : undefined,
			human_peer_id: o.human_peer_id ? String(o.human_peer_id) : undefined,
			human_display_name: o.human_display_name ? String(o.human_display_name) : undefined,
			original_request: o.original_request ? String(o.original_request) : undefined,
		};
	} catch {
		return null;
	}
}

// ── Read actions (everything fetches from Discord on demand) ────

async function getPeerForThread(ctx: ProgramContext, threadId: string, selfAgentUuid: string): Promise<{ peer_agent_uuid: string; peer_display_name: string }> {
	// Look up which pair channel the thread lives in. We don't have a
	// direct channels-by-thread index — easiest path: scan known pair
	// channels from /discord and ask each for its threads. Caching is in
	// /discord's actor state.
	const pairs = await ctx.dispatchProgram("/discord", "listPairChannels", []) as Array<{ channel_id: string; peer_a_agent_uuid: string; peer_b_agent_uuid: string }>;
	for (const pc of pairs) {
		// Skip pair channels we're not in
		const selfLower = selfAgentUuid.toLowerCase();
		if (pc.peer_a_agent_uuid !== selfLower && pc.peer_b_agent_uuid !== selfLower) continue;
		const threads = await ctx.dispatchProgram("/discord", "listConversationThreads", [{ pair_channel_id: pc.channel_id, include_archived: true }]) as Array<{ thread_id: string }>;
		if (threads.some((t) => t.thread_id === threadId)) {
			const peerUuid = pc.peer_a_agent_uuid === selfLower ? pc.peer_b_agent_uuid : pc.peer_a_agent_uuid;
			const peerName = await getDisplayNameForUuid(ctx, peerUuid);
			return { peer_agent_uuid: peerUuid, peer_display_name: peerName };
		}
	}
	throw new Error(`peer-chat: could not locate the pair channel hosting thread ${threadId}`);
}

interface ListConversationsInput {
	peer_id?: string;
	agent_uuid?: string;
	status?: ConversationStatus;
	from_agent_id?: string;
	include_archived?: boolean;
}

async function doListConversations(ctx: ProgramContext, input?: ListConversationsInput): Promise<Conversation[]> {
	const i = input ?? {};
	const pairs = await ctx.dispatchProgram("/discord", "listPairChannels", []) as Array<{ channel_id: string; peer_a_agent_uuid: string; peer_b_agent_uuid: string }>;

	let scopeAgent: LocalAgentPeer | null = null;
	if (i.from_agent_id) {
		scopeAgent = await findLocalAgentByObjectId(ctx, i.from_agent_id);
		if (!scopeAgent) return [];
	}

	const out: Conversation[] = [];
	for (const pc of pairs) {
		if (scopeAgent) {
			const self = scopeAgent.agent_uuid.toLowerCase();
			if (pc.peer_a_agent_uuid !== self && pc.peer_b_agent_uuid !== self) continue;
		}
		const threads = await ctx.dispatchProgram("/discord", "listConversationThreads", [{
			pair_channel_id: pc.channel_id,
			include_archived: i.include_archived ?? true,
		}]) as Array<{ thread_id: string; name: string; archived: boolean; locked: boolean; message_count: number; last_message_id: string | null }>;

		for (const t of threads) {
			const status: ConversationStatus = t.locked ? "done" : (t.archived ? "paused" : "active");
			if (i.status && i.status !== status) continue;
			// Which side is "me" for this pair? If no scope, render from peer_a's perspective.
			const myUuid = scopeAgent ? scopeAgent.agent_uuid.toLowerCase() : pc.peer_a_agent_uuid;
			const ownerObjId = scopeAgent ? scopeAgent.agent_object_id : "";
			const peerUuid = pc.peer_a_agent_uuid === myUuid ? pc.peer_b_agent_uuid : pc.peer_a_agent_uuid;
			if (i.agent_uuid && peerUuid.toLowerCase() !== i.agent_uuid.toLowerCase()) continue;
			const peerName = await getDisplayNameForUuid(ctx, peerUuid);
			out.push({
				conversation_id: t.thread_id,
				goal: t.name,
				peer_agent_uuid: peerUuid,
				peer_display_name: peerName,
				owner_agent_object_id: ownerObjId,
				status,
				message_count: t.message_count,
				last_message_at: t.last_message_id ? snowflakeTimestampMs(t.last_message_id) : null,
			});
		}
	}
	return out.sort((a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0));
}

interface ListMessagesInput {
	conversation_id: string;
	from_agent_id?: string;
	since?: number;          // ms epoch; filter to messages after this
	limit?: number;
}

async function doListMessages(ctx: ProgramContext, input: ListMessagesInput): Promise<PeerMessage[]> {
	if (!input?.conversation_id) return [];
	const fetched = await ctx.dispatchProgram("/discord", "listThreadMessages", [{
		thread_id: input.conversation_id,
		limit: input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 100,
	}]) as Array<{ message_id: string; envelope: A2AEnvelope; in_reply_to_message_id: string | null; sent_at: number }>;

	// Determine "my" agent_uuid for direction labeling
	let myUuid: string | null = null;
	if (input.from_agent_id) {
		const me = await findLocalAgentByObjectId(ctx, input.from_agent_id);
		myUuid = me?.agent_uuid?.toLowerCase() ?? null;
	}

	const since = typeof input.since === "number" ? input.since : 0;
	const out: PeerMessage[] = [];
	for (const m of fetched) {
		if (m.sent_at <= since) continue;
		const direction: "in" | "out" = myUuid && m.envelope.from_agent_uuid.toLowerCase() === myUuid ? "out" : "in";
		out.push({
			msg_id: m.message_id,
			conversation_id: input.conversation_id,
			direction,
			in_reply_to: m.in_reply_to_message_id,
			body: m.envelope.body,
			sent_at: m.sent_at,
			from_agent_uuid: m.envelope.from_agent_uuid,
			from_display_name: m.envelope.from_display_name,
		});
	}
	return out;
}

async function doStatus(ctx: ProgramContext): Promise<{ pair_channels: number; conversations: number; active: number; done: number; paused: number }> {
	const pairs = await ctx.dispatchProgram("/discord", "listPairChannels", []) as Array<any>;
	let active = 0, done = 0, paused = 0;
	for (const pc of pairs) {
		const threads = await ctx.dispatchProgram("/discord", "listConversationThreads", [{ pair_channel_id: pc.channel_id, include_archived: true }]) as Array<{ archived: boolean; locked: boolean }>;
		for (const t of threads) {
			if (t.locked) done++;
			else if (t.archived) paused++;
			else active++;
		}
	}
	return { pair_channels: pairs.length, conversations: active + done + paused, active, done, paused };
}

// snowflakeTimestampMs: tiny re-implementation so peer-chat doesn't need
// to import from /discord. Discord epoch = 2015-01-01.
const DISCORD_EPOCH_MS = 1420070400000;
function snowflakeTimestampMs(snowflake: string): number {
	try {
		return Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS;
	} catch {
		return 0;
	}
}

// ── CLI handler ─────────────────────────────────────────────────

const handler = async (cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		const s = await doStatus(ctx);
		print(bold("  peer-chat"));
		print(dim(`    pair channels: ${s.pair_channels}`));
		print(dim(`    conversations: ${s.conversations} (active ${s.active}, paused ${s.paused}, done ${s.done})`));
		return;
	}
	if (cmd === "list") {
		const convs = await doListConversations(ctx, {});
		if (convs.length === 0) { print(dim("(no conversations)")); return; }
		for (const c of convs) {
			const statusTag = c.status === "active" ? green("●") : c.status === "done" ? dim("✓") : yellow("⌛");
			const age = c.last_message_at ? `${Math.round((Date.now() - c.last_message_at) / 1000)}s ago` : "never";
			print(`  ${statusTag} ${cyan(c.peer_display_name)}  ${dim(`"${c.goal.slice(0, 40)}"`)}  ${dim(`${c.message_count} msgs, ${age}`)}`);
		}
		return;
	}
	print([
		bold("  peer-chat") + dim(" — agent-to-agent messaging over Discord threads"),
		`    ${cyan("/peer-chat list")}    list conversations`,
		`    ${cyan("/peer-chat status")}  counters`,
		dim("    Every conversation is a Discord thread under glon-a2a/. The thread's"),
		dim("    name is the goal; locked == done; archived == paused. Discord is the truth."),
	].join("\n"));
	void red;
};

// ── Actor ───────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	typedActions: {
		startConversation: {
			description: "Start a new goal-driven A2A conversation. Creates a Discord thread named after the goal in the pair channel for sender↔target, then posts the opening message. Returns conversation_id (= thread id).",
			inputSchema: {
				type: "object",
				required: ["goal", "text"],
				properties: {
					peer_id: { type: "string" },
					agent_uuid: { type: "string" },
					display_name: { type: "string" },
					goal: { type: "string" },
					text: { type: "string" },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: StartConversationInput) => doStartConversation(ctx, input),
		},
		send: {
			description: "Send a message into an existing conversation (Discord thread). Requires conversation_id + from_agent_id.",
			inputSchema: {
				type: "object",
				required: ["conversation_id", "text"],
				properties: {
					conversation_id: { type: "string" },
					text: { type: "string" },
					in_reply_to: { type: ["string", "null"] },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: SendInput) => doSend(ctx, input),
		},
		endConversation: {
			description: "Close the conversation — posts a final message with the reason, then locks + archives the thread. Discord rejects further posts to a locked thread.",
			inputSchema: {
				type: "object",
				required: ["conversation_id"],
				properties: {
					conversation_id: { type: "string" },
					reason: { type: "string" },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: EndConversationInput) => doEndConversation(ctx, input),
		},
		resumeConversation: {
			description: "Unarchive a paused thread so agents can post again.",
			inputSchema: {
				type: "object",
				required: ["conversation_id"],
				properties: {
					conversation_id: { type: "string" },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: ResumeConversationInput) => doResumeConversation(ctx, input),
		},
		listConversations: {
			description: "List conversations (threads) across pair channels. Pass from_agent_id to filter to one local agent's perspective.",
			inputSchema: {
				type: "object",
				properties: {
					peer_id: { type: "string" },
					agent_uuid: { type: "string" },
					status: { type: "string", enum: ["active", "done", "paused"] },
					from_agent_id: { type: "string" },
					include_archived: { type: "boolean" },
				},
			},
			handler: async (ctx, input: ListConversationsInput) => doListConversations(ctx, input ?? {}),
		},
		listMessages: {
			description: "Fetch messages in a conversation (thread) from Discord. Pass from_agent_id to label direction (in/out).",
			inputSchema: {
				type: "object",
				required: ["conversation_id"],
				properties: {
					conversation_id: { type: "string" },
					from_agent_id: { type: "string" },
					since: { type: "number" },
					limit: { type: "number" },
				},
			},
			handler: async (ctx, input: ListMessagesInput) => doListMessages(ctx, input),
		},
		status: {
			description: "Counters: pair channels + conversations by status.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => doStatus(ctx),
		},
		handleA2A: {
			description: "Process an inbound A2A envelope from /discord's thread poll. Called by /discord, not by agents.",
			inputSchema: {
				type: "object",
				required: ["envelope", "thread_id", "thread_name", "channel_id", "discord_message_id"],
				properties: {
					envelope: { type: "object" },
					thread_id: { type: "string" },
					thread_name: { type: "string" },
					channel_id: { type: "string" },
					discord_message_id: { type: "string" },
					in_reply_to_discord_id: { type: ["string", "null"] },
					sent_at: { type: "number" },
					thread_archived: { type: "boolean" },
					thread_locked: { type: "boolean" },
				},
			},
			handler: async (ctx, input: HandleA2AInput) => doHandleA2A(ctx, input),
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

export const __test = {
	doStartConversation, doSend, doEndConversation, doResumeConversation,
	doHandleA2A, doListConversations, doListMessages, doStatus,
};
