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
import { randomUUID } from "node:crypto";

const PEER_TRUSTED_LEVELS = new Set(["trusted", "friend", "family", "self"]);
function isPeered(trust_level: string | undefined | null): boolean {
	return !!trust_level && PEER_TRUSTED_LEVELS.has(trust_level);
}
// ── Constants ────────────────────────────────────────────────────

export const PEER_CHAT_CONTENT_TYPE = "glon/peer-chat";

const PERSISTED_STATE_FIELD = "persisted_state";
const MAX_MESSAGES_PER_CONVERSATION = 2000;  // hard cap on in-memory growth
const MAX_BODY_LEN = 8000;                   // ~8KB per message; refuse larger

// ── Types ────────────────────────────────────────────────────────

export interface PeerMessage {
	msg_id: string;
	direction: "in" | "out";
	kind: string;                 // "text" in v1; opaque to receivers for forward-compat
	in_reply_to: string | null;
	body: unknown;                // string for kind:"text"; opaque for future kinds
	sent_at: number;
}

export interface Conversation {
	peer_identity_pubkey: string;
	peer_hyperswarm_pubkey: string;
	peer_display_name: string;
	peer_object_id?: string;
	messages: PeerMessage[];
	last_message_at: number;
	unread_count: number;
}

interface PersistedChatState {
	conversations: Record<string, Conversation>;   // keyed by peer_identity_pubkey
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
}

interface BlobMeta {
	fromEndpoint?: string;
	receivedAt?: number;
	transportMetadata?: Record<string, string>;
}

// ── Persistence (same pattern as /directory) ────────────────────

function snapshotState(state: Record<string, any>): string {
	return JSON.stringify({ conversations: state.conversations ?? {} });
}

async function restoreState(state: Record<string, any>, ctx: ProgramContext) {
	if (!ctx.programId) return;
	try {
		const obj = await (ctx.store as any).get(ctx.programId);
		const field = obj?.fields?.[PERSISTED_STATE_FIELD];
		const raw = typeof field === "string" ? field : field?.stringValue;
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedChatState;
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

/** Find a peered /peer record by identity_pubkey, peer_id, or display_name. Refuses non-peered. */
async function resolvePeerForChat(
	ctx: ProgramContext,
	ref: { peer_id?: string; identity_pubkey?: string; display_name?: string },
): Promise<{ peer_id: string; identity_pubkey: string; hyperswarm_pubkey: string; display_name: string }> {
	const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peers = Array.isArray(all) ? all : [];
	let match: any | undefined;
	if (ref.peer_id) match = peers.find((p) => p.id === ref.peer_id);
	if (!match && ref.identity_pubkey) match = peers.find((p) => (p.identity_pubkey ?? "").toLowerCase() === ref.identity_pubkey!.toLowerCase());
	if (!match && ref.display_name) {
		const lower = ref.display_name.toLowerCase();
		match = peers.find((p) => (p.display_name ?? "").toLowerCase() === lower);
	}
	if (!match) throw new Error(`peer-chat: no peer matches ${JSON.stringify(ref)}. Have you peered with them? Try /directory list.`);
	if (!isPeered(match.trust_level)) {
		throw new Error(`peer-chat: peer "${match.display_name}" is at trust=${match.trust_level}; need a peered trust level. Run /directory peer ${(match.identity_pubkey ?? "").slice(0, 16)} first.`);
	}
	if (!match.identity_pubkey) throw new Error(`peer-chat: peer "${match.display_name}" has no identity_pubkey on record (can't address)`);
	if (!match.hyperswarm_pubkey) throw new Error(`peer-chat: peer "${match.display_name}" has no hyperswarm_pubkey yet — wait for their next announce.`);
	return {
		peer_id: match.id,
		identity_pubkey: match.identity_pubkey,
		hyperswarm_pubkey: match.hyperswarm_pubkey,
		display_name: match.display_name ?? match.id,
	};
}

/** Push a new message into a conversation; create the conversation if it doesn't exist. */
function appendMessage(state: Record<string, any>, peer: {
	identity_pubkey: string; hyperswarm_pubkey: string; display_name: string; peer_object_id?: string;
}, msg: PeerMessage): void {
	state.conversations = state.conversations ?? {};
	const key = peer.identity_pubkey.toLowerCase();
	let conv = state.conversations[key] as Conversation | undefined;
	if (!conv) {
		conv = {
			peer_identity_pubkey: peer.identity_pubkey,
			peer_hyperswarm_pubkey: peer.hyperswarm_pubkey,
			peer_display_name: peer.display_name,
			peer_object_id: peer.peer_object_id,
			messages: [],
			last_message_at: 0,
			unread_count: 0,
		};
	}
	// Dedupe by msg_id — re-deliveries are possible (network retries, etc.).
	if (conv.messages.some((m) => m.msg_id === msg.msg_id)) return;
	conv.messages.push(msg);
	// Cap message buffer so a long-running pair doesn't bloat persisted state.
	if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
		conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
	}
	conv.last_message_at = msg.sent_at;
	// Refresh cached peer metadata (hyperswarm key may have rotated; display name may have changed)
	conv.peer_hyperswarm_pubkey = peer.hyperswarm_pubkey;
	conv.peer_display_name = peer.display_name;
	if (peer.peer_object_id) conv.peer_object_id = peer.peer_object_id;
	if (msg.direction === "in") conv.unread_count += 1;
	state.conversations[key] = conv;
}

// ── Outbound: send ───────────────────────────────────────────────

interface SendInput {
	peer_id?: string;
	identity_pubkey?: string;
	display_name?: string;
	text: string;
	in_reply_to?: string | null;
}

async function doSend(ctx: ProgramContext, input: SendInput): Promise<{ msg_id: string }> {
	if (typeof input?.text !== "string" || input.text.length === 0) {
		throw new Error("peer-chat send: `text` is required and must be a non-empty string");
	}
	if (input.text.length > MAX_BODY_LEN) {
		throw new Error(`peer-chat send: message too long (${input.text.length} > ${MAX_BODY_LEN})`);
	}
	const peer = await resolvePeerForChat(ctx, input);
	const self_identity = await resolveSelfIdentity(ctx);
	const msg_id = randomUUID().replace(/-/g, "").slice(0, 16);
	const sent_at = Date.now();
	const payload: PeerChatPayload = {
		msg_id,
		kind: "text",
		in_reply_to: input.in_reply_to ?? null,
		body: input.text,
		sent_at,
		from_identity_pubkey: self_identity,
	};
	const payload_b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
	await ctx.dispatchProgram("/transport-hyperswarm", "send", [{
		endpoint: `swarm://${peer.hyperswarm_pubkey}`,
		payload_b64,
		content_type: PEER_CHAT_CONTENT_TYPE,
		metadata: { msg_id },
	}]);

	// Record locally as outgoing so the UI sees it immediately.
	const state = ctx.state;
	appendMessage(state, {
		identity_pubkey: peer.identity_pubkey,
		hyperswarm_pubkey: peer.hyperswarm_pubkey,
		display_name: peer.display_name,
		peer_object_id: peer.peer_id,
	}, {
		msg_id,
		direction: "out",
		kind: "text",
		in_reply_to: input.in_reply_to ?? null,
		body: input.text,
		sent_at,
	});
	await persistIfChanged(state, ctx);
	return { msg_id };
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

	// Authenticate sender: cross-check the claimed identity_pubkey against
	// the /peer record whose hyperswarm_pubkey matches the channel pubkey.
	// If they don't agree, drop — somebody is trying to spoof.
	const fromHex = (input.from ?? "").replace(/^swarm:\/\//, "").toLowerCase();
	if (!fromHex) {
		ctx.print?.(dim(`[peer-chat] dropped: no from_endpoint on blob`));
		return false;
	}
	const all = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peerRow = (Array.isArray(all) ? all : []).find((p) => (p.hyperswarm_pubkey ?? "").toLowerCase() === fromHex);
	if (!peerRow) {
		ctx.print?.(dim(`[peer-chat] dropped: sender hyperswarm=${fromHex.slice(0, 12)} not in /peer (not peered)`));
		return false;
	}
	if (!isPeered(peerRow.trust_level)) {
		ctx.print?.(dim(`[peer-chat] dropped: sender ${peerRow.display_name} at trust=${peerRow.trust_level}; need peered`));
		return false;
	}
	if (payload.from_identity_pubkey && peerRow.identity_pubkey && payload.from_identity_pubkey.toLowerCase() !== (peerRow.identity_pubkey as string).toLowerCase()) {
		ctx.print?.(dim(`[peer-chat] dropped: claimed identity=${payload.from_identity_pubkey.slice(0, 12)} doesn't match /peer record ${(peerRow.identity_pubkey as string).slice(0, 12)} for that hyperswarm key`));
		return false;
	}

	// Persist.
	const state = ctx.state;
	appendMessage(state, {
		identity_pubkey: peerRow.identity_pubkey,
		hyperswarm_pubkey: peerRow.hyperswarm_pubkey,
		display_name: peerRow.display_name ?? "(unnamed)",
		peer_object_id: peerRow.id,
	}, {
		msg_id: payload.msg_id,
		direction: "in",
		kind: payload.kind ?? "text",
		in_reply_to: payload.in_reply_to ?? null,
		body: payload.body,
		sent_at: payload.sent_at,
	});
	await persistIfChanged(state, ctx);

	// Surface a tiny notification once per conversation pause so the human
	// notices without spam. /user-chat dedupes by source+text within a
	// short window; we only ping if it's been quiet for >30s.
	const conv = state.conversations[(peerRow.identity_pubkey as string).toLowerCase()];
	if (conv && (Date.now() - (conv.last_message_at - 0) > 30_000 || conv.messages.length === 1)) {
		const preview = payload.kind === "text" ? String(payload.body).slice(0, 80) : `(${payload.kind})`;
		try {
			await ctx.dispatchProgram("/user-chat", "notify", [{
				text: `${peerRow.display_name}: ${preview}`,
				urgency: "low",
				source: "peer-chat",
			}]);
		} catch { /* notify is best-effort */ }
	}
	return true;
}

// ── Read actions ─────────────────────────────────────────────────

async function doListConversations(ctx: ProgramContext) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	return Object.values(conversations)
		.sort((a, b) => b.last_message_at - a.last_message_at)
		.map((c) => ({
			peer_identity_pubkey: c.peer_identity_pubkey,
			peer_hyperswarm_pubkey: c.peer_hyperswarm_pubkey,
			peer_display_name: c.peer_display_name,
			peer_object_id: c.peer_object_id,
			last_message_at: c.last_message_at,
			unread_count: c.unread_count,
			message_count: c.messages.length,
		}));
}

interface ListMessagesInput {
	peer_id?: string;
	identity_pubkey?: string;
	since?: number;     // ms epoch — return messages strictly after this
	limit?: number;
}

async function doListMessages(ctx: ProgramContext, input: ListMessagesInput) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	let key: string | undefined;
	if (input.identity_pubkey) key = input.identity_pubkey.toLowerCase();
	else if (input.peer_id) {
		const conv = Object.values(conversations).find((c) => c.peer_object_id === input.peer_id);
		if (conv) key = conv.peer_identity_pubkey.toLowerCase();
	}
	if (!key) return [];
	const conv = conversations[key];
	if (!conv) return [];
	const since = typeof input.since === "number" ? input.since : 0;
	const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : 500;
	return conv.messages.filter((m) => m.sent_at > since).slice(-limit);
}

interface MarkReadInput { peer_id?: string; identity_pubkey?: string; }
async function doMarkRead(ctx: ProgramContext, input: MarkReadInput) {
	const state = ctx.state;
	const conversations = (state.conversations ?? {}) as Record<string, Conversation>;
	let key: string | undefined;
	if (input.identity_pubkey) key = input.identity_pubkey.toLowerCase();
	else if (input.peer_id) {
		const conv = Object.values(conversations).find((c) => c.peer_object_id === input.peer_id);
		if (conv) key = conv.peer_identity_pubkey.toLowerCase();
	}
	if (!key) return { ok: true };
	const conv = conversations[key];
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
	let in_count = 0, out_count = 0, unread = 0;
	for (const c of Object.values(conversations)) {
		unread += c.unread_count;
		for (const m of c.messages) (m.direction === "in" ? in_count++ : out_count++);
	}
	return {
		conversations: Object.keys(conversations).length,
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
			const r = await doSend(ctx, isHex ? { identity_pubkey: peerRef, text } : { display_name: peerRef, text });
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
		const convs = await doListConversations(ctx);
		if (convs.length === 0) { print(dim("(no conversations yet)")); return; }
		for (const c of convs) {
			const age = Math.round((Date.now() - c.last_message_at) / 1000);
			const unread = c.unread_count > 0 ? red(` (${c.unread_count} unread)`) : "";
			print(`  ${cyan(c.peer_display_name)}  ${dim((c.peer_identity_pubkey || "").slice(0, 16))}  ${dim(`${c.message_count} msgs, ${age}s ago`)}${unread}`);
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
		send: {
			description: "Send a chat message to a peered glon. Refuses if the target's trust_level isn't peered (trusted/friend/family).",
			inputSchema: {
				type: "object",
				required: ["text"],
				properties: {
					peer_id: { type: "string" },
					identity_pubkey: { type: "string" },
					display_name: { type: "string" },
					text: { type: "string" },
					in_reply_to: { type: ["string", "null"] },
				},
			},
			handler: async (ctx, input: SendInput) => doSend(ctx, input),
		},
		listConversations: {
			description: "Return a summary list of conversations, sorted by last_message_at desc.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => doListConversations(ctx),
		},
		listMessages: {
			description: "Return messages in a conversation. Pass either peer_id or identity_pubkey. Optional since (ms epoch) returns only newer messages.",
			inputSchema: {
				type: "object",
				properties: {
					peer_id: { type: "string" },
					identity_pubkey: { type: "string" },
					since: { type: "number" },
					limit: { type: "number" },
				},
			},
			handler: async (ctx, input: ListMessagesInput) => doListMessages(ctx, input ?? {}),
		},
		markRead: {
			description: "Reset unread_count for a conversation to 0.",
			inputSchema: { type: "object", properties: { peer_id: { type: "string" }, identity_pubkey: { type: "string" } } },
			handler: async (ctx, input: MarkReadInput) => doMarkRead(ctx, input ?? {}),
		},
		status: {
			description: "Return counters: conversations, messages in/out, unread.",
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

export const __test = { doSend, doHandleIncoming, doListConversations, doListMessages, appendMessage };
