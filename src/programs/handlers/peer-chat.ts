// peer-chat — agent-to-agent text messaging over Hyperswarm.
//
// One conversation per peered identity. Outbound messages dispatch through
// /transport-hyperswarm; inbound envelopes route through this program's
// actor via registerActorContentHandler so state mutations land in our
// own actor (not /transport-router's, lesson from commit 5215330).
//
// Trust gate (both directions) is /peer isPeered() — i.e. trust_level ∈
// {trusted, friend, family, self}. Strangers and discovered-but-not-peered
// senders are dropped silently with a one-line warning so spam on the DHT
// can't pollute the chat log.
//
// Envelope payload shape is Phase-2 ready — `kind` is a string with v1
// emitting only "text". When agent-RPC kinds ship later (`agent-request`,
// `agent-response`), no protocol migration needed: receivers that don't
// recognise a kind just store the message verbatim and surface it raw.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { registerActorContentHandler } from "../runtime.js";
import { dim, bold, cyan, green, red, yellow } from "../shared.js";
import { randomUUID } from "node:crypto";

const PEER_TRUSTED_LEVELS = new Set(["trusted", "friend", "family", "self"]);
function isPeered(trust_level: string | undefined | null): boolean {
	return !!trust_level && PEER_TRUSTED_LEVELS.has(trust_level);
}
// ── Constants ────────────────────────────────────────────────────

export const PEER_CHAT_CONTENT_TYPE = "glon/peer-chat";

const PERSISTED_STATE_FIELD = "persisted_state";
const MAX_MESSAGES_PER_CONVERSATION = 2000;
const MAX_BODY_LEN = 8000;

// When a conversation runs this many hops without explicit done, it
// pauses for human review rather than auto-killing. The user decides
// whether to continue (which extends the pause threshold by another
// chunk) or end via peer_conversation_done. No hard auto-kill —
// nothing dies without a human or an agent saying so.
const PAUSE_FOR_REVIEW_AT_HOPS = 50;

// Bump when the on-disk schema changes incompatibly; load() throws old data
// away and starts fresh. Acceptable since peer-chat history isn't precious.
const STATE_VERSION = 3;

// ── Types ────────────────────────────────────────────────────────

export interface PeerMessage {
	msg_id: string;
	conversation_id: string;
	direction: "in" | "out";
	kind: string;                 // "text" today; future: agent-request/response
	in_reply_to: string | null;
	body: unknown;
	sent_at: number;
}

export type ConversationStatus = "active" | "done" | "paused";

export interface Conversation {
	id: string;                            // conversation_id
	peer_identity_pubkey: string;
	peer_hyperswarm_pubkey: string;
	peer_display_name: string;
	peer_object_id?: string;
	goal: string;                          // human-readable purpose
	status: ConversationStatus;
	started_at: number;
	started_by_agent_id?: string;          // local sender id, or undefined for cross-machine
	owner_agent_id?: string;               // which local agent's perspective this conv is (local-route only)
	mirror_conversation_id?: string;       // links the other side's mirror for local convos
	hop_cap: number;                       // pause when messages.length >= hop_cap; user resume bumps by PAUSE_FOR_REVIEW_AT_HOPS
	ended_at?: number;
	ended_reason?: string;
	ended_by_agent_id?: string;
	paused_at?: number;
	resumed_count?: number;
	messages: PeerMessage[];
	last_message_at: number;
	unread_count: number;
}

interface PersistedChatState {
	version: number;
	conversations: Record<string, Conversation>;   // keyed by conversation_id
}

/**
 * On-wire payload shape inside a glon/peer-chat envelope. Forward-compat
 * rules (mirroring PeerAnnounceBody):
 *   - `kind` is the version axis. Receivers MUST accept unknown kinds and
 *     either store-verbatim (text-style fallback) or ignore. Never crash.
 *   - Unknown fields MUST be tolerated; future Phase-2 kinds may add e.g.
 *     `tool_name`, `tool_args` for agent-request, without bumping any
 *     external version number.
 */
interface PeerChatPayload {
	msg_id: string;
	kind: string;                 // "text" today; future: "agent-request", "agent-response"
	in_reply_to: string | null;
	body: unknown;
	sent_at: number;
	from_identity_pubkey: string; // claim; cross-checked against /peer's hyperswarm pubkey
	// Additive cross-machine A2A routing fields. Both optional:
	//   from_agent_id — sender-side agent id (on the sender's glon). Lets
	//                   the receiver address replies back to a specific
	//                   remote agent and render messages as agent-tagged.
	//   to_agent_id   — receiver-side agent id (on this glon). Receiver
	//                   uses it to set conv.owner_agent_id so the right
	//                   local agent's loop fires. If absent, the message
	//                   is human-routed (notification to the principal).
	from_agent_id?: string;
	to_agent_id?: string;
}

interface BlobMeta {
	fromEndpoint?: string;
	receivedAt?: number;
	transportMetadata?: Record<string, string>;
}

// ── Persistence (same pattern as /directory) ────────────────────

function snapshotState(state: Record<string, any>): string {
	return JSON.stringify({ version: STATE_VERSION, conversations: state.conversations ?? {} });
}

async function restoreState(state: Record<string, any>, ctx: ProgramContext) {
	if (!ctx.programId) return;
	try {
		const obj = await (ctx.store as any).get(ctx.programId);
		const field = obj?.fields?.[PERSISTED_STATE_FIELD];
		const raw = typeof field === "string" ? field : field?.stringValue;
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedChatState;
		// Schema migration: previous version was keyed by peer_identity_pubkey
		// and had no goal/status. Reset rather than translate — peer-chat
		// history isn't precious, and clean state avoids ambiguity.
		if (parsed.version !== STATE_VERSION) {
			ctx.print?.(dim(`  [peer-chat] resetting state (version ${parsed.version ?? "1"} → ${STATE_VERSION})`));
			state.conversations = {};
			state._lastPersistedSnapshot = snapshotState(state);
			return;
		}
		if (parsed.conversations) state.conversations = parsed.conversations;
		state._lastPersistedSnapshot = snapshotState(state);
	} catch (err: any) {
		ctx.print?.(dim(`  [peer-chat] restore failed: ${err?.message ?? String(err)}`));
	}
}

async function persistIfChanged(state: Record<string, any>, ctx: ProgramContext) {
	if (!ctx.programId) return;
	const snap = snapshotState(state);
	if (state._lastPersistedSnapshot === snap) return;
	try {
		const actor = ctx.objectActor(ctx.programId) as any;
		if (typeof actor?.setField !== "function") return;
		await actor.setField(PERSISTED_STATE_FIELD, JSON.stringify(ctx.stringVal(snap)));
		state._lastPersistedSnapshot = snap;
	} catch (err: any) {
		ctx.print?.(dim(`  [peer-chat] persist failed: ${err?.message ?? String(err)}`));
	}
}

// ── Helpers ──────────────────────────────────────────────────────

async function resolveSelfIdentity(ctx: ProgramContext): Promise<string> {
	try {
		const info = await ctx.dispatchProgram("/wallet", "show", ["default"]) as { pubkey?: string } | null;
		return info?.pubkey ?? "";
	} catch { return ""; }
}

	/** Find a peered /peer record by identity_pubkey, peer_id, or display_name. Refuses non-peered.
	 *  Returns `agent_id_remote` for remote-agent peers (the agent's id on
	 *  the host glon) — used to set to_agent_id on cross-machine envelopes
	 *  so the receiver routes the message to the right agent. */
	async function resolvePeerForChat(
		ctx: ProgramContext,
		ref: { peer_id?: string; identity_pubkey?: string; display_name?: string },
	): Promise<{ peer_id: string; identity_pubkey: string; hyperswarm_pubkey: string; display_name: string; agent_id_remote?: string }> {
		const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
		const peers = Array.isArray(all) ? all : [];

		// Collect candidates that match any provided ref field. Prefer
		// remote-agent records (kind=agent + agent_id_remote) over the
		// kind=human host record so display_name="Nova" routes to the
		// remote agent Nova rather than the human host who runs that glon.
		const candidates = peers.filter((p) => {
			if (ref.peer_id && p.id === ref.peer_id) return true;
			if (ref.identity_pubkey && (p.identity_pubkey ?? "").toLowerCase() === ref.identity_pubkey.toLowerCase()) return true;
			if (ref.display_name && (p.display_name ?? "").toLowerCase() === ref.display_name.toLowerCase()) return true;
			return false;
		});

		// Rank: peered first, then agent over human (more specific target),
		// then by recency.
		const rank = (p: any) => {
			let s = 0;
			if (isPeered(p.trust_level)) s += 100;
			if (p.kind === "agent") s += 10;
			return s;
		};
		const match = candidates.slice().sort((a, b) => rank(b) - rank(a))[0];

		if (!match) throw new Error(`peer-chat: no peer matches ${JSON.stringify(ref)}. Have you peered with them? Try /directory list.`);
		// Remote-agent records inherit trust from their host (the only
		// trust handshake is host-to-host; agents are addressable iff the
		// host that owns them is peered). If the matched record is a
		// remote-agent peer and not directly trusted, look up the host
		// via host_peer_id and use its trust.
		let effectiveTrust = match.trust_level;
		if (!isPeered(effectiveTrust) && match.kind === "agent" && match.host_peer_id) {
			const host = peers.find((p) => p.id === match.host_peer_id);
			if (host && isPeered(host.trust_level)) effectiveTrust = host.trust_level;
		}
		if (!isPeered(effectiveTrust)) {
			throw new Error(`peer-chat: peer "${match.display_name}" is at trust=${match.trust_level}; need a peered trust level. Run /directory peer ${(match.identity_pubkey ?? "").slice(0, 16)} first.`);
		}
		if (!match.identity_pubkey) throw new Error(`peer-chat: peer "${match.display_name}" has no identity_pubkey on record (can't address)`);
		// Local sibling agents have identity_pubkey="local:<agentId>" and no
		// hyperswarm_pubkey — that's expected and fine.
		const isLocal = String(match.identity_pubkey).startsWith("local:");
		if (!isLocal && !match.hyperswarm_pubkey) {
			throw new Error(`peer-chat: peer "${match.display_name}" has no hyperswarm_pubkey yet — wait for their next announce.`);
		}
		return {
			peer_id: match.id,
			identity_pubkey: match.identity_pubkey,
			hyperswarm_pubkey: match.hyperswarm_pubkey ?? "",
			display_name: match.display_name ?? match.id,
			agent_id_remote: match.agent_id_remote,
		};
	}

	/** For a "local:<agentId>" target, look up the SENDER agent's own peer
	 *  record. Used to record the incoming side of an in-process message
	 *  in the recipient's view. */
	async function findLocalPeerForAgent(
		ctx: ProgramContext,
		agentId: string,
	): Promise<{ peer_id: string; identity_pubkey: string; display_name: string } | null> {
		const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
		const peers = Array.isArray(all) ? all : [];
		const want = `local:${agentId}`.toLowerCase();
		for (const p of peers) {
			if ((p.identity_pubkey ?? "").toLowerCase() === want) {
				return {
					peer_id: p.id,
					identity_pubkey: p.identity_pubkey,
					display_name: p.display_name ?? p.id,
				};
			}
		}
		return null;
	}

/** Generate a short opaque conversation id. */
function newConversationId(): string {
	return `c_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Push a new message into an existing conversation. Returns true if the
 *  conversation just crossed the pause threshold this append; the caller
 *  fires a /user-chat notification asking the human to continue or stop. */
function appendMessageToConversation(state: Record<string, any>, conv: Conversation, msg: PeerMessage): { pausedNow: boolean } {
	if (conv.messages.some((m) => m.msg_id === msg.msg_id)) return { pausedNow: false };
	conv.messages.push(msg);
	if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
		conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
	}
	conv.last_message_at = msg.sent_at;
	if (msg.direction === "in") conv.unread_count += 1;

	let pausedNow = false;
	const cap = conv.hop_cap ?? PAUSE_FOR_REVIEW_AT_HOPS;
	if (conv.status === "active" && conv.messages.length >= cap) {
		conv.status = "paused";
		conv.paused_at = msg.sent_at;
		pausedNow = true;
	}
	state.conversations[conv.id] = conv;
	return { pausedNow };
}

/** Find an existing conversation by id. */
function getConversation(state: Record<string, any>, conversation_id: string): Conversation | null {
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	return conversations[conversation_id] ?? null;
}

/** Fire a /user-chat notification asking the human to continue or stop a
 *  paused conversation. Best-effort; never throws. */
async function notifyPauseForReview(ctx: ProgramContext, conv: Conversation): Promise<void> {
	try {
		const peerName = conv.peer_display_name || "(peer)";
		const hops = conv.messages.length;
		const text = `peer-chat: "${conv.goal}" with ${peerName} hit ${hops} hops — continue or stop?`;
		await ctx.dispatchProgram("/user-chat", "notify", [{ text, urgency: "normal", source: "peer-chat" }]);
	} catch { /* best-effort */ }
}

// ── startConversation ─────────────────────────────────────────────

interface StartConversationInput {
	peer_id?: string;
	identity_pubkey?: string;
	display_name?: string;
	goal: string;
	text: string;
	from_agent_id?: string;   // bound by tool
}

interface StartConversationResult {
	conversation_id: string;
	mirror_conversation_id?: string;
	msg_id: string;
}

async function doStartConversation(ctx: ProgramContext, input: StartConversationInput): Promise<StartConversationResult> {
	if (typeof input?.goal !== "string" || input.goal.trim().length === 0) {
		throw new Error("peer-chat startConversation: `goal` is required and must be a non-empty string");
	}
	if (input.goal.length > 280) {
		throw new Error(`peer-chat startConversation: goal too long (${input.goal.length} > 280)`);
	}
	if (typeof input?.text !== "string" || input.text.length === 0) {
		throw new Error("peer-chat startConversation: `text` is required (the opening message)");
	}
	if (input.text.length > MAX_BODY_LEN) {
		throw new Error(`peer-chat startConversation: text too long (${input.text.length} > ${MAX_BODY_LEN})`);
	}

	const peer = await resolvePeerForChat(ctx, input);
	const state = ctx.state;
	state.conversations = state.conversations ?? {};
	const now = Date.now();

	const isLocalTarget = String(peer.identity_pubkey).startsWith("local:");
	const conversation_id = newConversationId();
	const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);

	if (isLocalTarget) {
		if (!input.from_agent_id) {
			throw new Error(`peer-chat startConversation: local-target peer requires from_agent_id`);
		}
		const senderPeer = await findLocalPeerForAgent(ctx, input.from_agent_id);
		if (!senderPeer) {
			throw new Error(`peer-chat startConversation: no /peer record for sender agent ${input.from_agent_id}`);
		}
		const recipientAgentId = String(peer.identity_pubkey).slice("local:".length);
		const mirror_id = newConversationId();

		// Sender's conversation: peer = recipient
		const ownerConv: Conversation = {
			id: conversation_id,
			peer_identity_pubkey: peer.identity_pubkey,
			peer_hyperswarm_pubkey: peer.hyperswarm_pubkey,
			peer_display_name: peer.display_name,
			peer_object_id: peer.peer_id,
			goal: input.goal.trim(),
			status: "active",
			started_at: now,
			started_by_agent_id: input.from_agent_id,
			owner_agent_id: input.from_agent_id,
			mirror_conversation_id: mirror_id,
			hop_cap: PAUSE_FOR_REVIEW_AT_HOPS,
			messages: [],
			last_message_at: 0,
			unread_count: 0,
		};
		state.conversations[conversation_id] = ownerConv;
		appendMessageToConversation(state, ownerConv, {
			msg_id, conversation_id, direction: "out", kind: "text", in_reply_to: null, body: input.text, sent_at: now,
		});

		// Recipient's mirror conversation: peer = sender
		const mirrorConv: Conversation = {
			id: mirror_id,
			peer_identity_pubkey: senderPeer.identity_pubkey,
			peer_hyperswarm_pubkey: "",
			peer_display_name: senderPeer.display_name,
			peer_object_id: senderPeer.peer_id,
			goal: input.goal.trim(),
			status: "active",
			started_at: now,
			started_by_agent_id: input.from_agent_id,
			owner_agent_id: recipientAgentId,
			mirror_conversation_id: conversation_id,
			hop_cap: PAUSE_FOR_REVIEW_AT_HOPS,
			messages: [],
			last_message_at: 0,
			unread_count: 0,
		};
		state.conversations[mirror_id] = mirrorConv;
		appendMessageToConversation(state, mirrorConv, {
			msg_id, conversation_id: mirror_id, direction: "in", kind: "text", in_reply_to: null, body: input.text, sent_at: now,
		});

		await persistIfChanged(state, ctx);
		// Fire-and-forget: nudge the recipient agent so it sees the new conversation.
		void maybeAutoTrigger(ctx, mirror_id);
		return { conversation_id, mirror_conversation_id: mirror_id, msg_id };
	}

	// ── Cross-machine: opening message rides over Hyperswarm ──────
	const self_identity = await resolveSelfIdentity(ctx);
	const payload: PeerChatPayload = {
		msg_id,
		kind: "text",
		in_reply_to: null,
		body: input.text,
		sent_at: now,
		from_identity_pubkey: self_identity,
		from_agent_id: input.from_agent_id,        // undefined when sent by the human principal
		to_agent_id: peer.agent_id_remote,         // set only when targeting a remote agent
	};
	const payload_b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
	await ctx.dispatchProgram("/transport-hyperswarm", "send", [{
		endpoint: `swarm://${peer.hyperswarm_pubkey}`,
		payload_b64,
		content_type: PEER_CHAT_CONTENT_TYPE,
		metadata: { msg_id, conversation_id, goal: input.goal.trim() },
	}]);

	const conv: Conversation = {
		id: conversation_id,
		peer_identity_pubkey: peer.identity_pubkey,
		peer_hyperswarm_pubkey: peer.hyperswarm_pubkey,
		peer_display_name: peer.display_name,
		peer_object_id: peer.peer_id,
		goal: input.goal.trim(),
		status: "active",
		started_at: now,
		started_by_agent_id: input.from_agent_id,
		owner_agent_id: input.from_agent_id,
		hop_cap: PAUSE_FOR_REVIEW_AT_HOPS,
		messages: [],
		last_message_at: 0,
		unread_count: 0,
	};
	state.conversations[conversation_id] = conv;
	appendMessageToConversation(state, conv, {
		msg_id, conversation_id, direction: "out", kind: "text", in_reply_to: null, body: input.text, sent_at: now,
	});
	await persistIfChanged(state, ctx);
	return { conversation_id, msg_id };
}

// ── send: continue an existing active conversation ────────────────

interface SendInput {
	conversation_id: string;
	text: string;
	in_reply_to?: string | null;
	from_agent_id?: string;
}

async function doSend(ctx: ProgramContext, input: SendInput): Promise<{ msg_id: string }> {
	if (typeof input?.text !== "string" || input.text.length === 0) {
		throw new Error("peer-chat send: `text` is required and must be a non-empty string");
	}
	if (input.text.length > MAX_BODY_LEN) {
		throw new Error(`peer-chat send: message too long (${input.text.length} > ${MAX_BODY_LEN})`);
	}
	if (typeof input?.conversation_id !== "string" || !input.conversation_id) {
		throw new Error("peer-chat send: `conversation_id` is required. Use startConversation to begin a new thread.");
	}
	const state = ctx.state;
	const conv = getConversation(state, input.conversation_id);
	if (!conv) throw new Error(`peer-chat send: conversation ${input.conversation_id} not found`);
	if (conv.status !== "active") {
		throw new Error(`peer-chat send: conversation ${input.conversation_id} is ${conv.status} — start a new one to continue.`);
	}

	const isLocalTarget = String(conv.peer_identity_pubkey).startsWith("local:");
	const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);
	const sent_at = Date.now();

	if (isLocalTarget) {
		if (!input.from_agent_id) throw new Error(`peer-chat send: local conversation requires from_agent_id`);
		// We're writing from the sender's perspective; conv.owner_agent_id IS the sender for this side.
		if (conv.owner_agent_id && conv.owner_agent_id !== input.from_agent_id) {
			throw new Error(`peer-chat send: conversation ${input.conversation_id} is owned by ${conv.owner_agent_id}, not ${input.from_agent_id}`);
		}
		// 1. Outgoing in sender's view
		const senderResult = appendMessageToConversation(state, conv, {
			msg_id, conversation_id: conv.id, direction: "out", kind: "text",
			in_reply_to: input.in_reply_to ?? null, body: input.text, sent_at,
		});

		// 2. Incoming in recipient's mirror
		const mirrorId = conv.mirror_conversation_id;
		const mirror = mirrorId ? getConversation(state, mirrorId) : null;
		let mirrorResult: { pausedNow: boolean } = { pausedNow: false };
		if (mirror) {
			mirrorResult = appendMessageToConversation(state, mirror, {
				msg_id, conversation_id: mirror.id, direction: "in", kind: "text",
				in_reply_to: input.in_reply_to ?? null, body: input.text, sent_at,
			});
			// Propagate status flips across the mirror so both sides agree.
			if (conv.status !== "active" && mirror.status === "active") {
				mirror.status = conv.status;
				if (conv.status === "paused") mirror.paused_at = sent_at;
			}
			if (mirror.status !== "active" && conv.status === "active") {
				conv.status = mirror.status;
				if (mirror.status === "paused") conv.paused_at = sent_at;
			}
		}

		await persistIfChanged(state, ctx);
		// Nudge the recipient agent only if still active. Paused/done blocks auto-trigger.
		if (mirror && mirror.status === "active") void maybeAutoTrigger(ctx, mirror.id);
		// Surface a pause to the human user.
		if (senderResult.pausedNow) await notifyPauseForReview(ctx, conv);
		else if (mirrorResult.pausedNow && mirror) await notifyPauseForReview(ctx, mirror);
		return { msg_id };
	}

	// Cross-machine
	const self_identity = await resolveSelfIdentity(ctx);
	// Look up the peer's agent_id_remote so replies route back to the same
	// remote agent — without this, a reply to a remote-agent conversation
	// would land as a generic human notification on the receiving glon.
	let to_agent_id: string | undefined;
	try {
		const peerRow = await ctx.dispatchProgram("/peer", "get", [conv.peer_object_id]) as { agent_id_remote?: string } | null;
		to_agent_id = peerRow?.agent_id_remote;
	} catch { /* peer record removed — proceed without targeted routing */ }
	const payload: PeerChatPayload = {
		msg_id,
		kind: "text",
		in_reply_to: input.in_reply_to ?? null,
		body: input.text,
		sent_at,
		from_identity_pubkey: self_identity,
		from_agent_id: input.from_agent_id,
		to_agent_id,
	};
	const payload_b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
	await ctx.dispatchProgram("/transport-hyperswarm", "send", [{
		endpoint: `swarm://${conv.peer_hyperswarm_pubkey}`,
		payload_b64,
		content_type: PEER_CHAT_CONTENT_TYPE,
		metadata: { msg_id, conversation_id: conv.id },
	}]);
	appendMessageToConversation(state, conv, {
		msg_id, conversation_id: conv.id, direction: "out", kind: "text",
		in_reply_to: input.in_reply_to ?? null, body: input.text, sent_at,
	});
	await persistIfChanged(state, ctx);
	return { msg_id };
}

// ── endConversation: one-sided "done" closes the thread ──────────

interface EndConversationInput {
	conversation_id: string;
	reason?: string;
	from_agent_id?: string;
}

async function doEndConversation(ctx: ProgramContext, input: EndConversationInput): Promise<{ ok: true }> {
	if (typeof input?.conversation_id !== "string" || !input.conversation_id) {
		throw new Error("peer-chat endConversation: `conversation_id` is required");
	}
	const state = ctx.state;
	const conv = getConversation(state, input.conversation_id);
	if (!conv) throw new Error(`peer-chat endConversation: conversation ${input.conversation_id} not found`);
	if (conv.status === "done") return { ok: true }; // idempotent
	const now = Date.now();
	const reason = (input.reason ?? "").toString().slice(0, 200) || "no reason given";
	conv.status = "done";
	conv.ended_at = now;
	conv.ended_reason = reason;
	conv.ended_by_agent_id = input.from_agent_id ?? conv.owner_agent_id;
	state.conversations[conv.id] = conv;

	// Same-machine mirror: closing one side closes the linked one too.
	if (conv.mirror_conversation_id) {
		const mirror = getConversation(state, conv.mirror_conversation_id);
		if (mirror && mirror.status !== "done") {
			mirror.status = "done";
			mirror.ended_at = now;
			mirror.ended_reason = reason;
			mirror.ended_by_agent_id = conv.ended_by_agent_id;
			state.conversations[mirror.id] = mirror;
		}
	}

	// Cross-machine: tell the remote side this conversation is done. Without
	// this, their conv stays "active" while ours is "done" — they'll send
	// more messages and we'll silently drop them because we can't append
	// to a closed thread, AND if they're the agent owner their auto-trigger
	// won't fire because status check requires active. Best-effort send;
	// don't fail the local close on network hiccup.
	const isLocalTarget = String(conv.peer_identity_pubkey || "").startsWith("local:");
	if (!isLocalTarget && conv.peer_hyperswarm_pubkey) {
		try {
			const self_identity = await resolveSelfIdentity(ctx);
			let to_agent_id: string | undefined;
			try {
				const peerRow = await ctx.dispatchProgram("/peer", "get", [conv.peer_object_id]) as { agent_id_remote?: string } | null;
				to_agent_id = peerRow?.agent_id_remote;
			} catch { /* peer gone — proceed without targeted routing */ }
			const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);
			const payload: PeerChatPayload = {
				msg_id,
				kind: "done",
				in_reply_to: null,
				body: reason,
				sent_at: now,
				from_identity_pubkey: self_identity,
				from_agent_id: input.from_agent_id,
				to_agent_id,
			};
			const payload_b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
			await ctx.dispatchProgram("/transport-hyperswarm", "send", [{
				endpoint: `swarm://${conv.peer_hyperswarm_pubkey}`,
				payload_b64,
				content_type: PEER_CHAT_CONTENT_TYPE,
				metadata: { msg_id, conversation_id: conv.id, kind: "done" },
			}]);
		} catch (err: any) {
			ctx.print?.(dim(`[peer-chat] cross-machine done send failed: ${err?.message ?? err}`));
		}
	}

	await persistIfChanged(state, ctx);
	return { ok: true };
}

// ── resumeConversation: user re-greenlights a paused thread ───────

interface ResumeConversationInput {
	conversation_id: string;
}

async function doResumeConversation(ctx: ProgramContext, input: ResumeConversationInput): Promise<{ ok: true; new_hop_cap: number }> {
	if (typeof input?.conversation_id !== "string" || !input.conversation_id) {
		throw new Error("peer-chat resumeConversation: `conversation_id` is required");
	}
	const state = ctx.state;
	const conv = getConversation(state, input.conversation_id);
	if (!conv) throw new Error(`peer-chat resumeConversation: conversation ${input.conversation_id} not found`);
	if (conv.status === "done") {
		throw new Error("peer-chat resumeConversation: conversation is done — start a new one to continue.");
	}
	// Extend the hop cap so the next pause fires PAUSE_FOR_REVIEW_AT_HOPS messages from here.
	conv.hop_cap = (conv.messages.length) + PAUSE_FOR_REVIEW_AT_HOPS;
	conv.status = "active";
	conv.resumed_count = (conv.resumed_count ?? 0) + 1;
	conv.paused_at = undefined;
	state.conversations[conv.id] = conv;

	// Mirror gets the same treatment.
	if (conv.mirror_conversation_id) {
		const mirror = getConversation(state, conv.mirror_conversation_id);
		if (mirror) {
			mirror.hop_cap = (mirror.messages.length) + PAUSE_FOR_REVIEW_AT_HOPS;
			mirror.status = "active";
			mirror.resumed_count = (mirror.resumed_count ?? 0) + 1;
			mirror.paused_at = undefined;
			state.conversations[mirror.id] = mirror;
		}
	}
	await persistIfChanged(state, ctx);
	// Nudge whoever was waiting on a reply (the side whose latest message is incoming).
	const lastOwner = conv.messages[conv.messages.length - 1];
	if (lastOwner?.direction === "in" && conv.status === "active") void maybeAutoTrigger(ctx, conv.id);
	const mirrorConv = conv.mirror_conversation_id ? getConversation(state, conv.mirror_conversation_id) : null;
	if (mirrorConv) {
		const lastMirror = mirrorConv.messages[mirrorConv.messages.length - 1];
		if (lastMirror?.direction === "in" && mirrorConv.status === "active") void maybeAutoTrigger(ctx, mirrorConv.id);
	}
	return { ok: true, new_hop_cap: conv.hop_cap };
}

// ── Auto-trigger ─────────────────────────────────────────────────
// When an inbound message lands in a still-active local conversation,
// nudge the recipient's /agent ask asynchronously so the conversation
// flows. Fire-and-forget; failures stay out of the caller's path.
async function maybeAutoTrigger(ctx: ProgramContext, conversation_id: string): Promise<void> {
	try {
		const conv = getConversation(ctx.state, conversation_id);
		if (!conv || conv.status !== "active" || !conv.owner_agent_id) return;
		const last = conv.messages[conv.messages.length - 1];
		if (!last || last.direction !== "in") return; // only react to incoming
		const goalPreview = conv.goal ? conv.goal.slice(0, 200) : "(no goal stated)";
		const bodyPreview = String(last.body ?? "").slice(0, 1500);
		const prompt = [
			`You have a new peer-chat message in an active conversation.`,
			`Conversation id: ${conv.id}`,
			`Goal: ${goalPreview}`,
			`From: ${conv.peer_display_name}`,
			`Message: ${bodyPreview}`,
			``,
			`If the goal is achieved or further reply would not add value, call peer_conversation_done with a short reason. Otherwise, call peer_message_send with this conversation_id to reply. Do NOT ask the human user — this is autonomous A2A.`,
		].join("\n");
		await ctx.dispatchProgram("/agent", "ask", [conv.owner_agent_id, prompt]);
	} catch (err: any) {
		ctx.print?.(dim(`  [peer-chat] auto-trigger failed for conv ${conversation_id}: ${err?.message ?? err}`));
	}
}

// ── Inbound: handleIncoming (dispatched via registerActorContentHandler) ──

interface HandleIncomingInput {
	envelope_b64: string;
	content_type?: string;
	from?: string;
}

async function doHandleIncoming(ctx: ProgramContext, input: HandleIncomingInput): Promise<boolean> {
	let payload: PeerChatPayload;
	try {
		const raw = Buffer.from(input.envelope_b64, "base64").toString("utf8");
		payload = JSON.parse(raw);
	} catch {
		ctx.print?.(dim(`[peer-chat] dropped: payload not valid JSON`));
		return false;
	}
	if (!payload || typeof payload.msg_id !== "string" || typeof payload.sent_at !== "number") {
		ctx.print?.(dim(`[peer-chat] dropped: payload missing msg_id or sent_at`));
		return false;
	}
	// Body validation: today we only render "text". Other kinds are STORED
	// (forward-compat — they may be Phase-2 agent-RPC) but not parsed here.
	if (payload.kind === "text" && typeof payload.body !== "string") {
		ctx.print?.(dim(`[peer-chat] dropped: kind=text but body is not a string`));
		return false;
	}
	if (payload.kind === "text" && (payload.body as string).length > MAX_BODY_LEN) {
		ctx.print?.(dim(`[peer-chat] dropped: text body too long`));
		return false;
	}

	// Authenticate sender by hyperswarm channel pubkey. There may be
	// multiple /peer records sharing that hpk (the host + every remote
	// agent on that glon); the HOST (kind=human) is the authoritative
	// trust gate — agent records inherit. We pick a representative
	// senderPeer to attach to the conversation, preferring the specific
	// agent when from_agent_id is set.
	const fromHex = (input.from ?? "").replace(/^swarm:\/\//, "").toLowerCase();
	if (!fromHex) {
		ctx.print?.(dim(`[peer-chat] dropped: no from_endpoint on blob`));
		return false;
	}
	const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peersByHpk = (Array.isArray(all) ? all : []).filter((p) => (p.hyperswarm_pubkey ?? "").toLowerCase() === fromHex);
	if (peersByHpk.length === 0) {
		ctx.print?.(dim(`[peer-chat] dropped: sender hyperswarm=${fromHex.slice(0, 12)} not in /peer (not peered)`));
		return false;
	}
	// Trust gate: at least one record for this glon must be peered. Host
	// is the canonical record (kind=human); if it's peered the whole glon
	// is. Falls back to "any record peered" so legacy installs without a
	// separate host record (pre-roster) still work.
	const hostPeer = peersByHpk.find((p) => p.kind === "human") ?? peersByHpk[0];
	if (!isPeered(hostPeer.trust_level)) {
		ctx.print?.(dim(`[peer-chat] dropped: sender host ${hostPeer.display_name} at trust=${hostPeer.trust_level}; need peered`));
		return false;
	}
	if (payload.from_identity_pubkey && hostPeer.identity_pubkey && payload.from_identity_pubkey.toLowerCase() !== (hostPeer.identity_pubkey as string).toLowerCase()) {
		ctx.print?.(dim(`[peer-chat] dropped: claimed identity=${payload.from_identity_pubkey.slice(0, 12)} doesn't match host /peer record ${(hostPeer.identity_pubkey as string).slice(0, 12)} for that hyperswarm key`));
		return false;
	}
	// Pick the senderPeer that should own this side of the conversation:
	// if the envelope names a specific agent on the sender glon, find that
	// remote-agent /peer record. Otherwise the host is the sender.
	let senderPeer = hostPeer;
	if (payload.from_agent_id) {
		const agentPeer = peersByHpk.find((p) => p.kind === "agent" && p.agent_id_remote === payload.from_agent_id);
		if (agentPeer) senderPeer = agentPeer;
	}

	// Resolve which local agent (if any) should own this conversation.
	// If the envelope carries to_agent_id, route to that agent's loop so
	// agent-to-agent A2A actually fires the recipient's tool loop. If
	// to_agent_id is absent, the message is human-routed (the principal
	// gets a notification, no agent processes it automatically).
	const owner_agent_id = payload.to_agent_id;

	// Cross-machine "done" envelope: the remote side closed this thread.
	// Close our matching conv so the user / our agent stops trying to
	// reply into a dead conversation. Look up the conv by the explicit
	// conversation_id in metadata first; fall back to the latest active
	// one for this sender.
	const state = ctx.state;
	if (payload.kind === "done") {
		const meta_conv_id = (input as any)?.metadata?.conversation_id ?? null;
		let target: Conversation | null = meta_conv_id ? getConversation(state, meta_conv_id) : null;
		if (!target) {
			const candidates = Object.values((state.conversations ?? {}) as Record<string, Conversation>)
				.filter((c) => c.peer_identity_pubkey.toLowerCase() === (senderPeer.identity_pubkey as string).toLowerCase())
				.filter((c) => c.status === "active")
				.sort((a, b) => b.started_at - a.started_at);
			target = candidates[0] ?? null;
		}
		if (target && target.status !== "done") {
			target.status = "done";
			target.ended_at = payload.sent_at;
			target.ended_reason = String(payload.body ?? "remote closed");
			state.conversations[target.id] = target;
			await persistIfChanged(state, ctx);
		}
		return true;
	}

	// Persist.
	// Match an existing active conversation with this peer, else start one
	// (cross-machine peers that don't speak the new protocol won't send
	// conversation_id metadata yet; we accept this gracefully).
	const conversation_id_from_meta = (input as any)?.metadata?.conversation_id ?? null;
	let conv: Conversation | null = null;
	if (conversation_id_from_meta) {
		conv = getConversation(state, conversation_id_from_meta);
	}
	if (!conv) {
		// Best-effort find: same peer (by senderPeer.identity_pubkey),
		// latest active conversation.
		const candidates = Object.values((state.conversations ?? {}) as Record<string, Conversation>)
			.filter((c) => c.peer_identity_pubkey.toLowerCase() === (senderPeer.identity_pubkey as string).toLowerCase())
			.filter((c) => c.status === "active")
			.sort((a, b) => b.started_at - a.started_at);
		conv = candidates[0] ?? null;
	}
	if (!conv) {
		// Implicit conversation with no goal — legacy peer or auto-recovered.
		const conversation_id = newConversationId();
		conv = {
			id: conversation_id,
			peer_identity_pubkey: senderPeer.identity_pubkey,
			peer_hyperswarm_pubkey: senderPeer.hyperswarm_pubkey ?? fromHex,
			peer_display_name: senderPeer.display_name ?? "(unnamed)",
			peer_object_id: senderPeer.id,
			goal: "(implicit — inbound without conversation_id)",
			status: "active",
			started_at: payload.sent_at,
			owner_agent_id,                   // routes maybeAutoTrigger to the right agent
			hop_cap: PAUSE_FOR_REVIEW_AT_HOPS,
			messages: [],
			last_message_at: 0,
			unread_count: 0,
		};
		state.conversations = state.conversations ?? {};
		state.conversations[conversation_id] = conv;
	} else if (owner_agent_id && !conv.owner_agent_id) {
		// Back-patch ownership onto an implicit conversation that the
		// sender has now learned to address explicitly.
		conv.owner_agent_id = owner_agent_id;
	}
	appendMessageToConversation(state, conv, {
		msg_id: payload.msg_id,
		conversation_id: conv.id,
		direction: "in",
		kind: payload.kind ?? "text",
		in_reply_to: payload.in_reply_to ?? null,
		body: payload.body,
		sent_at: payload.sent_at,
	});
	await persistIfChanged(state, ctx);

	// If the envelope addressed a specific local agent (to_agent_id),
	// nudge that agent's loop so it actually responds. Without this, the
	// message lands in state.conversations and just sits there — the
	// recipient agent never sees it. Mirrors what local startConversation
	// does for same-machine targets.
	if (conv.owner_agent_id && conv.status === "active") {
		void maybeAutoTrigger(ctx, conv.id);
	}

	// Surface a tiny notification once per conversation pause so the human
	// notices without spam. /user-chat dedupes by source+text within a
	// short window; we only ping if it's been quiet for >30s.
	if (conv && (Date.now() - (conv.last_message_at - 0) > 30_000 || conv.messages.length === 1)) {
		const preview = payload.kind === "text" ? String(payload.body).slice(0, 80) : `(${payload.kind})`;
		try {
			await ctx.dispatchProgram("/user-chat", "notify", [{
				text: `${senderPeer.display_name}: ${preview}`,
				urgency: "low",
				source: "peer-chat",
			}]);
		} catch { /* notify is best-effort */ }
	}
	return true;
}

// ── Read actions ─────────────────────────────────────────────────

interface ListConversationsInput {
	peer_id?: string;
	identity_pubkey?: string;
	status?: ConversationStatus;
	from_agent_id?: string;        // bound by tool; filters to the asking agent's conversations
	include_other_perspectives?: boolean;  // default false — hide mirror entries
}

async function doListConversations(ctx: ProgramContext, input?: ListConversationsInput) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	const i = input ?? {};
	return Object.values(conversations)
		.filter((c) => {
			if (i.peer_id && c.peer_object_id !== i.peer_id) return false;
			if (i.status && c.status !== i.status) return false;
			if (i.identity_pubkey && c.peer_identity_pubkey.toLowerCase() !== i.identity_pubkey.toLowerCase()) return false;
			if (i.from_agent_id && !i.include_other_perspectives) {
				// Show only conversations this agent owns. Mirrors owned by
				// other local agents (peer_identity_pubkey == local:<me>)
				// belong to the OTHER side.
				if (c.owner_agent_id && c.owner_agent_id !== i.from_agent_id) return false;
				const ownLocal = `local:${i.from_agent_id}`.toLowerCase();
				if (c.peer_identity_pubkey.toLowerCase() === ownLocal) return false;
			}
			return true;
		})
		.sort((a, b) => b.last_message_at - a.last_message_at)
		.map((c) => ({
			conversation_id: c.id,
			peer_identity_pubkey: c.peer_identity_pubkey,
			peer_hyperswarm_pubkey: c.peer_hyperswarm_pubkey,
			peer_display_name: c.peer_display_name,
			peer_object_id: c.peer_object_id,
			goal: c.goal,
			status: c.status,
			started_at: c.started_at,
			started_by_agent_id: c.started_by_agent_id,
			owner_agent_id: c.owner_agent_id,
			ended_at: c.ended_at,
			ended_reason: c.ended_reason,
			ended_by_agent_id: c.ended_by_agent_id,
			last_message_at: c.last_message_at,
			unread_count: c.unread_count,
			message_count: c.messages.length,
			hop_cap: c.hop_cap ?? PAUSE_FOR_REVIEW_AT_HOPS,
			hops_remaining: Math.max(0, (c.hop_cap ?? PAUSE_FOR_REVIEW_AT_HOPS) - c.messages.length),
			paused_at: c.paused_at,
			resumed_count: c.resumed_count ?? 0,
			last_message_preview: c.messages.length > 0 ? String(c.messages[c.messages.length - 1].body ?? "").slice(0, 120) : "",
		}));
}

interface ListMessagesInput {
	conversation_id?: string;
	peer_id?: string;
	identity_pubkey?: string;
	from_agent_id?: string;
	since?: number;
	limit?: number;
}

async function doListMessages(ctx: ProgramContext, input: ListMessagesInput) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	let conv: Conversation | null = null;
	if (input.conversation_id) {
		conv = conversations[input.conversation_id] ?? null;
	} else if (input.identity_pubkey || input.peer_id) {
		// Find the most recent active conversation owned by this agent for the requested peer.
		const matches = Object.values(conversations).filter((c) => {
			if (input.identity_pubkey && c.peer_identity_pubkey.toLowerCase() !== input.identity_pubkey.toLowerCase()) return false;
			if (input.peer_id && c.peer_object_id !== input.peer_id) return false;
			if (input.from_agent_id && c.owner_agent_id && c.owner_agent_id !== input.from_agent_id) return false;
			return true;
		}).sort((a, b) => b.last_message_at - a.last_message_at);
		conv = matches[0] ?? null;
	}
	if (!conv) return [];
	const since = typeof input.since === "number" ? input.since : 0;
	const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : 500;
	return conv.messages.filter((m) => m.sent_at > since).slice(-limit);
}

interface MarkReadInput {
	conversation_id?: string;
	peer_id?: string;
	identity_pubkey?: string;
}
async function doMarkRead(ctx: ProgramContext, input: MarkReadInput) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	let conv: Conversation | null = null;
	if (input.conversation_id) conv = conversations[input.conversation_id] ?? null;
	else {
		const matches = Object.values(conversations).filter((c) =>
			(input.identity_pubkey && c.peer_identity_pubkey.toLowerCase() === input.identity_pubkey.toLowerCase()) ||
			(input.peer_id && c.peer_object_id === input.peer_id),
		);
		conv = matches[0] ?? null;
	}
	if (!conv) return { ok: true };
	if (conv.unread_count !== 0) {
		conv.unread_count = 0;
		await persistIfChanged(state, ctx);
	}
	return { ok: true };
}

async function doStatus(ctx: ProgramContext) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	let in_count = 0, out_count = 0, unread = 0, active = 0, done = 0, paused = 0;
	for (const c of Object.values(conversations)) {
		unread += c.unread_count;
		for (const m of c.messages) (m.direction === "in" ? in_count++ : out_count++);
		if (c.status === "active") active++;
		else if (c.status === "done") done++;
		else if (c.status === "paused") paused++;
	}
	return {
		conversations: Object.keys(conversations).length,
		active, done, paused,
		messages_in: in_count,
		messages_out: out_count,
		unread,
	};
}

// ── CLI handler ─────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		const s = await doStatus(ctx);
		print(bold("  peer-chat"));
		print(dim(`    conversations: ${s.conversations}`));
		print(dim(`    messages in:   ${s.messages_in}`));
		print(dim(`    messages out:  ${s.messages_out}`));
		print(dim(`    unread:        ${s.unread}`));
		return;
	}
	if (cmd === "send") {
		const peerRef = args[0];
		const text = args.slice(1).join(" ");
		if (!peerRef || !text) { print(red("Usage: /peer-chat send <peer-name|identity-pubkey> <message...>")); return; }
		try {
			const isHex = /^[0-9a-fA-F]{64}$/.test(peerRef);
			const ref = isHex ? { identity_pubkey: peerRef } : { display_name: peerRef };
			// Find an active conversation with this peer; if none, start one.
			const convs = await doListConversations(ctx, { ...ref, status: "active" });
			let conversation_id = (convs[0] as any)?.conversation_id;
			if (!conversation_id) {
				const r = await doStartConversation(ctx, { ...ref, goal: "(CLI message from human)", text });
				print(green(`started conversation ${r.conversation_id}, sent: ${r.msg_id}`));
				return;
			}
			const r = await doSend(ctx, { conversation_id, text });
			print(green(`sent: ${r.msg_id}`));
		} catch (err: any) {
			print(red(`Error: ${err?.message ?? String(err)}`));
		}
		return;
	}
	if (cmd === "read") {
		const peerRef = args[0];
		if (!peerRef) { print(red("Usage: /peer-chat read <peer-name|identity-pubkey>")); return; }
		const isHex = /^[0-9a-fA-F]{64}$/.test(peerRef);
		const msgs = await doListMessages(ctx, isHex ? { identity_pubkey: peerRef } : (async () => {
			// Resolve display_name to identity for read
			const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
			const m = (all || []).find((p) => (p.display_name ?? "").toLowerCase() === peerRef.toLowerCase());
			return m?.identity_pubkey ? { identity_pubkey: m.identity_pubkey } : {};
		})() as any);
		if (msgs.length === 0) { print(dim("(no messages)")); return; }
		for (const m of msgs) {
			const ts = new Date(m.sent_at).toLocaleTimeString();
			const tag = m.direction === "in" ? cyan("◀ them") : green("you ▶");
			const body = m.kind === "text" ? String(m.body) : `[${m.kind}] ${JSON.stringify(m.body)}`;
			print(`  ${dim(ts)}  ${tag}  ${body}`);
		}
		return;
	}
	if (cmd === "list") {
		const convs = await doListConversations(ctx, {});
		if (convs.length === 0) { print(dim("(no conversations yet)")); return; }
		for (const c of convs) {
			const age = Math.round((Date.now() - c.last_message_at) / 1000);
			const unread = c.unread_count > 0 ? red(` (${c.unread_count} unread)`) : "";
			const statusTag = c.status === "active" ? green("●") : c.status === "done" ? dim("✓") : yellow("⌛");
			print(`  ${statusTag} ${cyan(c.peer_display_name)}  ${dim(`"${(c.goal || "").slice(0, 40)}"`)}  ${dim(`${c.message_count} msgs, ${age}s ago`)}${unread}`);
		}
		return;
	}
	print([
		bold("  peer-chat") + dim(" — agent-to-agent messaging over Hyperswarm"),
		`    ${cyan("/peer-chat list")}                          list conversations`,
		`    ${cyan("/peer-chat read")} ${dim("<peer>")}                    read a conversation`,
		`    ${cyan("/peer-chat send")} ${dim("<peer> <message...>")}        send a message`,
		`    ${cyan("/peer-chat status")}                        message counters`,
		dim("    <peer> may be a display_name (e.g. 'glon') or a 64-hex identity_pubkey."),
		dim("    Trust gate: only peers at trust ≥ trusted can be reached or be received from."),
	].join("\n"));
	void yellow;
};

// ── Actor ───────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({ conversations: {} }),
	onCreate: async (ctx) => {
		await restoreState(ctx.state, ctx);
	},
	typedActions: {
		startConversation: {
			description: "Start a new goal-driven conversation with a peer. Requires goal (1-280 chars) and an opening text message. Returns conversation_id; subsequent messages use send with that id. Either side can call endConversation to close.",
			inputSchema: {
				type: "object",
				required: ["goal", "text"],
				properties: {
					peer_id: { type: "string" },
					identity_pubkey: { type: "string" },
					display_name: { type: "string" },
					goal: { type: "string" },
					text: { type: "string" },
					from_agent_id: { type: "string" },
				},
			},
			handler: async (ctx, input: StartConversationInput) => doStartConversation(ctx, input),
		},
		send: {
			description: "Send a message into an existing active conversation. Requires conversation_id from a prior startConversation. Fails if the conversation is done. If paused (waiting for human review), the message is rejected until the user resumes.",
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
			description: "Mark a conversation as done. One side calling this closes it for both. Idempotent on already-closed conversations.",
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
			description: "Resume a paused conversation. Called by the human user after reviewing whether the agents should keep going. Extends the hop cap by PAUSE_FOR_REVIEW_AT_HOPS messages and re-fires any pending auto-trigger.",
			inputSchema: {
				type: "object",
				required: ["conversation_id"],
				properties: { conversation_id: { type: "string" } },
			},
			handler: async (ctx, input: ResumeConversationInput) => doResumeConversation(ctx, input),
		},
		listConversations: {
			description: "List conversations, sorted by last_message_at desc. Pass from_agent_id to filter to your own perspective (drops mirror entries for sibling agents).",
			inputSchema: {
				type: "object",
				properties: {
					peer_id: { type: "string" },
					identity_pubkey: { type: "string" },
					status: { type: "string", enum: ["active", "done", "paused"] },
					from_agent_id: { type: "string" },
					include_other_perspectives: { type: "boolean" },
				},
			},
			handler: async (ctx, input: ListConversationsInput) => doListConversations(ctx, input ?? {}),
		},
		listMessages: {
			description: "Return messages in a conversation. Prefer conversation_id; peer_id/identity_pubkey resolves to the most recent matching conversation.",
			inputSchema: {
				type: "object",
				properties: {
					conversation_id: { type: "string" },
					peer_id: { type: "string" },
					identity_pubkey: { type: "string" },
					from_agent_id: { type: "string" },
					since: { type: "number" },
					limit: { type: "number" },
				},
			},
			handler: async (ctx, input: ListMessagesInput) => doListMessages(ctx, input ?? {}),
		},
		markRead: {
			description: "Reset unread_count for a conversation to 0.",
			inputSchema: { type: "object", properties: { conversation_id: { type: "string" }, peer_id: { type: "string" }, identity_pubkey: { type: "string" } } },
			handler: async (ctx, input: MarkReadInput) => doMarkRead(ctx, input ?? {}),
		},
		status: {
			description: "Return counters: conversations (total/active/done/paused), messages in/out, unread.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => doStatus(ctx),
		},
		handleIncoming: {
			description: "Process an incoming glon/peer-chat envelope. Wired via registerActorContentHandler so it runs with /peer-chat's actor state, not /transport-router's.",
			inputSchema: {
				type: "object",
				required: ["envelope_b64"],
				properties: { envelope_b64: { type: "string" }, content_type: { type: "string" }, from: { type: "string" } },
			},
			handler: async (ctx, input: HandleIncomingInput) => doHandleIncoming(ctx, input),
		},
	},
};

// ── Content handler registration ────────────────────────────────

registerActorContentHandler(PEER_CHAT_CONTENT_TYPE, "/peer-chat", "handleIncoming");

const program: ProgramDef = { handler, actor: actorDef };
export default program;

export const __test = { doStartConversation, doSend, doEndConversation, doResumeConversation, doHandleIncoming, doListConversations, doListMessages };
