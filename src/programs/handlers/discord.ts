// Discord — I/O bridge between Holdfast (or any Glon agent) and Discord.
//
// Runs as a Glon program with a 3-second tick. Each tick:
//   1. Loads peers that have `discord_id` set via /peer.list
//   2. Opens/caches a DM channel per peer
//   3. Polls each DM channel for new messages since its watermark
//   4. Dispatches each inbound to /holdfast.ingest(source="discord", peer_id, text)
//   5. Sends the agent's final reply back as Discord messages (split at 2000)
//
// Actions exposed to other programs (the harness calls these as tools):
//   - send(peerId, text)       — DM a peer by peer id
//   - sendChannel(channelId, text) — post to a specific channel
//   - typing(peerId)           — typing indicator while the agent thinks
//
// Credentials: DISCORD_BOT_TOKEN env var only. Never persisted to the DAG.
// State (bot user id, channel cache, watermarks) lives in the actor's
// in-memory state. On restart we re-fetch bot user and set watermarks
// from the newest inbound per channel, skipping historical backfill.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, red, green, yellow } from "../shared.js";
import { createHash } from "node:crypto";


// ── Constants ────────────────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_POLL_MS = 3000;
const MESSAGE_MAX_LEN = 2000;


// ── Bridge channels ──────────────────────────────────────────────
// Inter-agent communication happens over shared Discord channels
// (bot-to-bot DMs are forbidden by Discord TOS). Channels listed in
// GLON_BRIDGE_CHANNELS are polled alongside DMs. Messages from known
// peers are routed through /holdfast.ingest exactly like DMs.
//
// Format: GLON_BRIDGE_CHANNELS=channelId1,channelId2,...
//
// Loop safety: only ONE bot in a bridge channel should auto-ingest.
// The other bot(s) should leave GLON_BRIDGE_CHANNELS empty and post
// manually via discord_bridge_send or sendChannel.

/** Parse GLON_BRIDGE_CHANNELS env var into a list of channel IDs. */
function getBridgeChannels(): string[] {
	const raw = process.env.GLON_BRIDGE_CHANNELS ?? "";
	if (!raw) return [];
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Whether to ingest messages from agent-kind peers in bridge channels.
 *  Default true. Set to false on the "listening" side if both bots
 *  auto-ingest and you want to break reply loops. */
const BRIDGE_INGEST_AGENTS = (process.env.GLON_BRIDGE_INGEST_FROM_AGENTS ?? "true") !== "false";
// ── Types ────────────────────────────────────────────────────────

interface PeerSnapshot {
	id: string;
	display_name: string;
	kind: string;
	trust_level: string;
	discord_id?: string;
}

interface DiscordMessage {
	id: string;
	author: { id: string; username?: string; global_name?: string };
	content: string;
}

// ── Helpers ──────────────────────────────────────────────────────

function token(): string {
	const t = process.env.DISCORD_BOT_TOKEN;
	if (!t) throw new Error("DISCORD_BOT_TOKEN not set");
	return t;
}

/** Discord REST helper. Respects 429 with Retry-After. */
async function discord(method: string, path: string, body?: unknown): Promise<any> {
	const testFetch = (globalThis as any).__DISCORD_FETCH as
		| undefined
		| ((req: { method: string; path: string; body: unknown }) => Promise<any>);
	if (testFetch) {
		return testFetch({ method, path, body });
	}

	const headers: Record<string, string> = {
		"Authorization": `Bot ${token()}`,
		"User-Agent": "Glon/Holdfast (+https://github.com/Geep5/glon)",
	};
	if (body !== undefined) headers["Content-Type"] = "application/json";

	const res = await fetch(`${DISCORD_API}${path}`, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (res.status === 429) {
		const raw = await res.text();
		let retryAfter = 1;
		try { retryAfter = JSON.parse(raw).retry_after ?? 1; } catch { /* ignore */ }
		const err = new Error(`Discord 429 — retry after ${retryAfter}s`) as Error & { retryAfter?: number; rateLimited?: boolean };
		err.retryAfter = retryAfter;
		err.rateLimited = true;
		throw err;
	}
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Discord ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
	}
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

/** Split text at newline boundaries into chunks ≤ maxLen. */
export function splitMessage(text: string, maxLen = MESSAGE_MAX_LEN): string[] {
	if (text.length <= maxLen) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > maxLen) {
		let cut = remaining.lastIndexOf("\n", maxLen);
		if (cut <= 0) cut = maxLen;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut).replace(/^\n+/, "");
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

async function getBotUserId(state: Record<string, any>): Promise<string> {
	if (state.botUserId) return state.botUserId;
	const me = await discord("GET", "/users/@me");
	if (!me?.id) throw new Error("failed to resolve bot user id");
	state.botUserId = me.id as string;
	return state.botUserId;
}

/** Get (or open) the DM channel with a peer. Result is cached in state. */
async function getDmChannel(peer: PeerSnapshot, state: Record<string, any>): Promise<string> {
	if (!peer.discord_id) throw new Error(`peer ${peer.id} has no discord_id set`);
	state.dmChannelByPeer = state.dmChannelByPeer ?? {};
	if (state.dmChannelByPeer[peer.id]) return state.dmChannelByPeer[peer.id];
	const ch = await discord("POST", "/users/@me/channels", { recipient_id: peer.discord_id });
	if (!ch?.id) throw new Error(`failed to open DM channel with ${peer.discord_id}`);
	state.dmChannelByPeer[peer.id] = ch.id as string;
	return ch.id as string;
}

async function postMessage(channelId: string, text: string): Promise<string[]> {
	const parts = splitMessage(text);
	const ids: string[] = [];
	for (const part of parts) {
		const msg = await discord("POST", `/channels/${channelId}/messages`, { content: part });
		if (msg?.id) ids.push(msg.id as string);
	}
	return ids;
}

async function fetchPeersWithDiscord(ctx: ProgramContext): Promise<PeerSnapshot[]> {
	const all = await ctx.dispatchProgram("/peer", "list", []) as PeerSnapshot[];
	return all.filter((p) => !!p.discord_id);
}

// ── A2A channel management ───────────────────────────────────────
// Inter-glon agent communication runs over admin-bot-managed channels
// in a single Discord guild. The bot creates a dedicated category and
// one channel per agent-pair, named deterministically from the two
// agent UUIDs (sorted) so both sides converge on the same channel.
//
// Env:
//   GLON_A2A_DISCORD_GUILD     — target guild id (required)
//   GLON_A2A_CATEGORY_NAME     — category name (default "glon-a2a")

const A2A_CATEGORY_NAME_DEFAULT = "glon-a2a";
const DISCORD_CHANNEL_TYPE_CATEGORY = 4;
const DISCORD_CHANNEL_TYPE_TEXT = 0;
const DISCORD_CHANNEL_TYPE_PUBLIC_THREAD = 11;

// Discord permission bit flags — see https://discord.com/developers/docs/topics/permissions
const PERM_MANAGE_CHANNELS = 1n << 4n;
const PERM_VIEW_CHANNEL = 1n << 10n;
const PERM_SEND_MESSAGES = 1n << 11n;
const PERM_READ_MESSAGE_HISTORY = 1n << 16n;
const PERM_MANAGE_THREADS = 1n << 34n;
const PERM_CREATE_PUBLIC_THREADS = 1n << 35n;
const PERM_SEND_MESSAGES_IN_THREADS = 1n << 38n;
const PERM_OVERWRITE_TYPE_ROLE = 0;
const PERM_OVERWRITE_TYPE_MEMBER = 1;

// Thread auto-archive duration (minutes). Discord allowed values: 60, 1440, 4320, 10080.
// We pick 7 days so paused-for-review conversations have plenty of slack before Discord
// hides the thread. A future post in an archived thread auto-unarchives it.
const A2A_THREAD_AUTO_ARCHIVE_MINUTES = Number(process.env.GLON_A2A_THREAD_AUTO_ARCHIVE_MINUTES ?? 10080);

/** Operator user IDs that should also see + post in the private A2A
 *  channels. Set GLON_A2A_DISCORD_OPERATOR_IDS to a comma-separated
 *  list of Discord user ids. Guild owners technically have admin
 *  access already, but Discord's sidebar hides @everyone-denied
 *  channels even from admins by default — adding an explicit member
 *  allow makes them appear normally. */
function operatorUserIds(): string[] {
	const raw = process.env.GLON_A2A_DISCORD_OPERATOR_IDS ?? "";
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Permission overwrite array that opens a channel to the whole guild for
 *  read + reply-in-threads, while leaving thread-creation and channel
 *  management to the bot. Used for the #roster forum so any server member
 *  can click on an agent's post and chat with them, but nobody else can
 *  fabricate new agent cards.
 *
 *    @everyone : VIEW + READ_HISTORY + SEND_MESSAGES_IN_THREADS
 *    bot       : full manage (view, send, history, manage_channels,
 *                manage_threads, create_public_threads, send_in_threads)
 *    operators : view + send + history + send_in_threads + manage_threads
 */
function buildPublicRosterOverwrites(guildId: string, botUserId: string): Array<{ id: string; type: number; allow: string; deny: string }> {
	const botAllow = (
		PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_MESSAGE_HISTORY
		| PERM_MANAGE_CHANNELS | PERM_MANAGE_THREADS
		| PERM_CREATE_PUBLIC_THREADS | PERM_SEND_MESSAGES_IN_THREADS
	).toString();
	const everyoneAllow = (
		PERM_VIEW_CHANNEL | PERM_READ_MESSAGE_HISTORY | PERM_SEND_MESSAGES_IN_THREADS
	).toString();
	const operatorAllow = (
		PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_READ_MESSAGE_HISTORY
		| PERM_SEND_MESSAGES_IN_THREADS | PERM_MANAGE_THREADS
	).toString();
	const overwrites: Array<{ id: string; type: number; allow: string; deny: string }> = [
		{ id: guildId, type: PERM_OVERWRITE_TYPE_ROLE, allow: everyoneAllow, deny: "0" },
		{ id: botUserId, type: PERM_OVERWRITE_TYPE_MEMBER, allow: botAllow, deny: "0" },
	];
	for (const opId of operatorUserIds()) {
		overwrites.push({ id: opId, type: PERM_OVERWRITE_TYPE_MEMBER, allow: operatorAllow, deny: "0" });
	}
	return overwrites;
}

/** Permission overwrite array that hides a channel from @everyone but
 *  grants the bot user explicit view/send/history/manage/threads, plus
 *  the same (minus manage) for each operator listed in
 *  GLON_A2A_DISCORD_OPERATOR_IDS. */
function buildPrivateA2AOverwrites(guildId: string, botUserId: string): Array<{ id: string; type: number; allow: string; deny: string }> {
	const botAllow = (
		PERM_VIEW_CHANNEL
		| PERM_SEND_MESSAGES
		| PERM_READ_MESSAGE_HISTORY
		| PERM_MANAGE_CHANNELS
		| PERM_MANAGE_THREADS
		| PERM_CREATE_PUBLIC_THREADS
		| PERM_SEND_MESSAGES_IN_THREADS
	).toString();
	const operatorAllow = (
		PERM_VIEW_CHANNEL
		| PERM_SEND_MESSAGES
		| PERM_READ_MESSAGE_HISTORY
		| PERM_SEND_MESSAGES_IN_THREADS
	).toString();
	const overwrites: Array<{ id: string; type: number; allow: string; deny: string }> = [
		{
			id: guildId,                         // @everyone role's id == guild id
			type: PERM_OVERWRITE_TYPE_ROLE,
			allow: "0",
			deny: PERM_VIEW_CHANNEL.toString(),
		},
		{
			id: botUserId,
			type: PERM_OVERWRITE_TYPE_MEMBER,
			allow: botAllow,
			deny: "0",
		},
	];
	for (const opId of operatorUserIds()) {
		overwrites.push({
			id: opId,
			type: PERM_OVERWRITE_TYPE_MEMBER,
			allow: operatorAllow,
			deny: "0",
		});
	}
	return overwrites;
}

interface DiscordChannelSummary {
	id: string;
	name: string;
	type: number;
	parent_id?: string | null;
	topic?: string | null;
}

function a2aGuildId(): string {
	const g = process.env.GLON_A2A_DISCORD_GUILD;
	if (!g) throw new Error("GLON_A2A_DISCORD_GUILD not set — required for A2A channel ops");
	return g;
}

function a2aCategoryName(): string {
	return process.env.GLON_A2A_CATEGORY_NAME ?? A2A_CATEGORY_NAME_DEFAULT;
}

/** Structured topic string for a pair channel, embedding both agent_uuids
 *  in a machine-parseable form. Other helpers can recover the participants
 *  from the channel topic without round-tripping back to /peer. */
const PAIR_TOPIC_PREFIX = "glon-a2a:v1";
export function formatPairChannelTopic(uuidA: string, uuidB: string): string {
	const [lo, hi] = uuidA.toLowerCase() < uuidB.toLowerCase() ? [uuidA, uuidB] : [uuidB, uuidA];
	return `${PAIR_TOPIC_PREFIX} | ${lo} ↔ ${hi}`;
}

const PAIR_TOPIC_RE = /^glon-a2a:v1\s*\|\s*([0-9a-f-]+)\s*↔\s*([0-9a-f-]+)/i;
export function parsePairChannelTopic(topic: string | null | undefined): { peer_a_agent_uuid: string; peer_b_agent_uuid: string } | null {
	if (!topic) return null;
	const m = PAIR_TOPIC_RE.exec(topic.trim());
	if (!m) return null;
	return { peer_a_agent_uuid: m[1].toLowerCase(), peer_b_agent_uuid: m[2].toLowerCase() };
}

/** Deterministic Discord-safe channel name for an unordered pair of
 *  agent UUIDs. Hashes each input to 16 hex chars and sorts so both
 *  daemons compute the same name. Discord channel names allow [a-z0-9_-]
 *  only, which hex satisfies. */
export function pairChannelName(idA: string, idB: string): string {
	const a = String(idA ?? "");
	const b = String(idB ?? "");
	if (!a || !b) throw new Error("pairChannelName: both agent_uuids required");
	const hash = (s: string) => createHash("sha256").update(s.toLowerCase()).digest("hex").slice(0, 16);
	const ha = hash(a);
	const hb = hash(b);
	const [lo, hi] = ha < hb ? [ha, hb] : [hb, ha];
	return `pair-${lo}-${hi}`;
}

async function listGuildChannels(guildId: string): Promise<DiscordChannelSummary[]> {
	const raw = await discord("GET", `/guilds/${guildId}/channels`);
	if (!Array.isArray(raw)) return [];
	return raw.map((c: any) => ({
		id: String(c.id),
		name: String(c.name ?? ""),
		type: Number(c.type ?? 0),
		parent_id: c.parent_id ?? null,
		topic: c.topic ?? null,
	}));
}

interface EnsureCategoryResult {
	category_id: string;
	created: boolean;
	name: string;
}

async function doEnsurePairCategory(state: Record<string, any>): Promise<EnsureCategoryResult> {
	const guildId = a2aGuildId();
	const wantName = a2aCategoryName();
	state.a2aCategoryByGuild = state.a2aCategoryByGuild ?? {} as Record<string, string>;
	const cached = state.a2aCategoryByGuild[guildId];
	if (cached) return { category_id: cached, created: false, name: wantName };

	const channels = await listGuildChannels(guildId);
	const existing = channels.find((c) => c.type === DISCORD_CHANNEL_TYPE_CATEGORY && c.name.toLowerCase() === wantName.toLowerCase());
	if (existing) {
		state.a2aCategoryByGuild[guildId] = existing.id;
		return { category_id: existing.id, created: false, name: existing.name };
	}

	const botUserId = await getBotUserId(state);
	const created = await discord("POST", `/guilds/${guildId}/channels`, {
		name: wantName,
		type: DISCORD_CHANNEL_TYPE_CATEGORY,
		permission_overwrites: buildPrivateA2AOverwrites(guildId, botUserId),
	});
	if (!created?.id) throw new Error("Discord did not return a channel id when creating category");
	state.a2aCategoryByGuild[guildId] = created.id as string;
	return { category_id: created.id as string, created: true, name: created.name as string };
}

interface EnsurePairChannelInput {
	peer_a_agent_uuid: string;
	peer_b_agent_uuid: string;
}

interface EnsurePairChannelResult {
	channel_id: string;
	name: string;
	created: boolean;
	category_id: string;
}

async function doEnsurePairChannel(state: Record<string, any>, input: EnsurePairChannelInput): Promise<EnsurePairChannelResult> {
	if (!input?.peer_a_agent_uuid || !input?.peer_b_agent_uuid) {
		throw new Error("discord.ensurePairChannel: peer_a_agent_uuid and peer_b_agent_uuid required");
	}
	const guildId = a2aGuildId();
	const cat = await doEnsurePairCategory(state);
	const name = pairChannelName(input.peer_a_agent_uuid, input.peer_b_agent_uuid);

	state.a2aPairChannel = state.a2aPairChannel ?? {} as Record<string, string>;
	const cacheKey = `${guildId}:${name}`;
	const cached = state.a2aPairChannel[cacheKey];
	if (cached) return { channel_id: cached, name, created: false, category_id: cat.category_id };

	const channels = await listGuildChannels(guildId);
	const existing = channels.find((c) => c.type === DISCORD_CHANNEL_TYPE_TEXT && c.parent_id === cat.category_id && c.name.toLowerCase() === name.toLowerCase());
	if (existing) {
		state.a2aPairChannel[cacheKey] = existing.id;
		// Back-patch the topic if it doesn't match the structured format —
		// older channels (pre-cleanup) had a different topic, which breaks
		// participant lookup via listPairChannels.
		const wantTopic = formatPairChannelTopic(input.peer_a_agent_uuid, input.peer_b_agent_uuid);
		if (!parsePairChannelTopic(existing.topic)) {
			try {
				await discord("PATCH", `/channels/${existing.id}`, { topic: wantTopic });
			} catch (err: any) {
				// Topic update isn't critical — the channel still works for posting.
				// listPairChannels will skip it until updated, which only affects
				// conversation listing.
			}
		}
		return { channel_id: existing.id, name: existing.name, created: false, category_id: cat.category_id };
	}

	const botUserId = await getBotUserId(state);
	const created = await discord("POST", `/guilds/${guildId}/channels`, {
		name,
		type: DISCORD_CHANNEL_TYPE_TEXT,
		parent_id: cat.category_id,
		topic: formatPairChannelTopic(input.peer_a_agent_uuid, input.peer_b_agent_uuid),
		permission_overwrites: buildPrivateA2AOverwrites(guildId, botUserId),
	});
	if (!created?.id) throw new Error("Discord did not return a channel id when creating pair channel");
	state.a2aPairChannel[cacheKey] = created.id as string;
	return { channel_id: created.id as string, name: created.name as string, created: true, category_id: cat.category_id };
}

// ── A2A wire format (Discord-as-truth, threads-per-conversation) ──
//
// A conversation = a Discord thread inside a pair channel.
//   - Thread name = goal (set at peer_conversation_start, immutable)
//   - Thread id = the conversation_id surfaced to agents
//   - Thread locked = conversation is done
//   - Thread archived = conversation paused / idle (Discord auto-archives
//     after the configured duration; sending a new message un-archives)
//
// A message in a thread carries a minimal JSON envelope inside a fenced
// glon-msg code block. Everything else (msg_id, sent_at, in_reply_to,
// conversation_id, goal) is derived from the Discord message + thread.

const A2A_ENVELOPE_FENCE = "glon-msg";
const A2A_FENCE_RE = new RegExp("```\\s*" + A2A_ENVELOPE_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "i");
const A2A_POLL_BATCH = 50;

export interface A2AEnvelope {
	v: 1;
	from_agent_uuid: string;
	from_display_name: string;
	to_agent_uuid: string;
	to_display_name: string;
	body: unknown;
}

export function formatA2AMessage(env: A2AEnvelope): string {
	const sender = env.from_display_name || env.from_agent_uuid.slice(0, 8) || "agent";
	const target = env.to_display_name || env.to_agent_uuid.slice(0, 8) || "agent";
	const bodyText = String(env.body ?? "");
	const bodyPreview = bodyText.length > 1500 ? bodyText.slice(0, 1500) + "…" : bodyText;
	const quoted = bodyPreview.split("\n").map((line) => `> ${line}`).join("\n");
	const preamble = `**${sender} → ${target}**\n${quoted}`;
	const jsonBlock = "```" + A2A_ENVELOPE_FENCE + "\n" + JSON.stringify(env) + "\n```";
	return `${preamble}\n${jsonBlock}`;
}

export function parseA2AMessage(content: string): A2AEnvelope | null {
	const m = A2A_FENCE_RE.exec(content ?? "");
	if (!m) return null;
	try {
		const parsed = JSON.parse(m[1]);
		if (!parsed || typeof parsed !== "object") return null;
		if (parsed.v !== 1) return null;
		if (typeof parsed.from_agent_uuid !== "string" || typeof parsed.to_agent_uuid !== "string") return null;
		return {
			v: 1,
			from_agent_uuid: String(parsed.from_agent_uuid),
			from_display_name: String(parsed.from_display_name ?? ""),
			to_agent_uuid: String(parsed.to_agent_uuid),
			to_display_name: String(parsed.to_display_name ?? ""),
			body: parsed.body,
		};
	} catch {
		return null;
	}
}

// ── Threads: create / post / list / message-iterate / archive ────

interface ThreadSummary {
	thread_id: string;
	name: string;
	parent_id: string;
	archived: boolean;
	locked: boolean;
	message_count: number;
	last_message_id?: string | null;
	auto_archive_minutes: number;
}

function threadFromRaw(raw: any): ThreadSummary {
	return {
		thread_id: String(raw.id),
		name: String(raw.name ?? ""),
		parent_id: String(raw.parent_id ?? ""),
		archived: !!raw.thread_metadata?.archived,
		locked: !!raw.thread_metadata?.locked,
		message_count: Number(raw.message_count ?? 0),
		last_message_id: raw.last_message_id ?? null,
		auto_archive_minutes: Number(raw.thread_metadata?.auto_archive_duration ?? A2A_THREAD_AUTO_ARCHIVE_MINUTES),
	};
}

interface EnsureThreadInput {
	pair_channel_id: string;
	name: string;                       // goal — becomes the thread title
}

interface EnsureThreadResult {
	thread_id: string;
	name: string;
	created: boolean;
}

async function doEnsureConversationThread(input: EnsureThreadInput): Promise<EnsureThreadResult> {
	if (!input?.pair_channel_id) throw new Error("ensureConversationThread: pair_channel_id required");
	if (!input?.name) throw new Error("ensureConversationThread: name required");
	const trimmedName = input.name.trim().slice(0, 100); // Discord limit
	// Always create a new thread — caller (peer-chat) generates one per
	// conversation_start. If they want to reuse an existing thread they
	// can address it directly by thread_id.
	const created = await discord("POST", `/channels/${input.pair_channel_id}/threads`, {
		name: trimmedName,
		type: DISCORD_CHANNEL_TYPE_PUBLIC_THREAD,
		auto_archive_duration: A2A_THREAD_AUTO_ARCHIVE_MINUTES,
	});
	if (!created?.id) throw new Error("Discord did not return a thread id");
	return { thread_id: String(created.id), name: String(created.name ?? trimmedName), created: true };
}

interface PostToThreadInput {
	thread_id: string;
	envelope: A2AEnvelope;
	reply_to_discord_id?: string;
}

interface PostToThreadResult {
	thread_id: string;
	message_id: string;
}

async function doPostToThread(input: PostToThreadInput): Promise<PostToThreadResult> {
	if (!input?.thread_id) throw new Error("postToThread: thread_id required");
	if (!input?.envelope) throw new Error("postToThread: envelope required");
	const body = formatA2AMessage(input.envelope);
	// Use the raw Discord endpoint so we can include message_reference for
	// reply chains (postMessage helper would chunk and we want one message
	// per envelope). Envelopes are bounded — if a single body exceeds the
	// 2000-char limit, we let Discord reject it.
	const payload: Record<string, unknown> = { content: body };
	if (input.reply_to_discord_id) {
		payload.message_reference = {
			message_id: input.reply_to_discord_id,
			fail_if_not_exists: false,
		};
	}
	const msg = await discord("POST", `/channels/${input.thread_id}/messages`, payload);
	if (!msg?.id) throw new Error("Discord did not return a message id when posting to thread");
	return { thread_id: input.thread_id, message_id: String(msg.id) };
}

async function listActiveThreads(pairChannelId: string): Promise<ThreadSummary[]> {
	// Per Discord docs, /channels/{id}/threads/active is removed; use the
	// guild-wide endpoint and filter by parent_id.
	const guildId = a2aGuildId();
	const raw = await discord("GET", `/guilds/${guildId}/threads/active`);
	const list: any[] = Array.isArray(raw) ? raw : (raw?.threads ?? []);
	return list.map(threadFromRaw).filter((t) => t.parent_id === pairChannelId);
}

async function listArchivedThreads(pairChannelId: string): Promise<ThreadSummary[]> {
	const raw = await discord("GET", `/channels/${pairChannelId}/threads/archived/public?limit=50`);
	const list: any[] = raw?.threads ?? [];
	return list.map(threadFromRaw);
}

interface ListConversationThreadsInput {
	pair_channel_id: string;
	include_archived?: boolean;
}

async function doListConversationThreads(input: ListConversationThreadsInput): Promise<ThreadSummary[]> {
	if (!input?.pair_channel_id) throw new Error("listConversationThreads: pair_channel_id required");
	const active = await listActiveThreads(input.pair_channel_id);
	if (!input.include_archived) return active;
	const archived = await listArchivedThreads(input.pair_channel_id);
	return [...active, ...archived];
}

interface ListThreadMessagesInput {
	thread_id: string;
	after?: string;       // discord snowflake
	limit?: number;
}

interface ParsedThreadMessage {
	message_id: string;
	envelope: A2AEnvelope;
	in_reply_to_message_id: string | null;
	sent_at: number;
	raw_content: string;
}

async function doListThreadMessages(input: ListThreadMessagesInput): Promise<ParsedThreadMessage[]> {
	if (!input?.thread_id) throw new Error("listThreadMessages: thread_id required");
	const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 100;
	const qs = input.after ? `?limit=${limit}&after=${input.after}` : `?limit=${limit}`;
	const raw = await discord("GET", `/channels/${input.thread_id}/messages${qs}`);
	if (!Array.isArray(raw)) return [];
	const sorted = [...raw].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
	const out: ParsedThreadMessage[] = [];
	for (const m of sorted) {
		const env = parseA2AMessage(m.content ?? "");
		if (!env) continue;
		out.push({
			message_id: String(m.id),
			envelope: env,
			in_reply_to_message_id: m.message_reference?.message_id ? String(m.message_reference.message_id) : null,
			sent_at: snowflakeTimestampMs(String(m.id)),
			raw_content: String(m.content ?? ""),
		});
	}
	return out;
}

interface ArchiveThreadInput {
	thread_id: string;
	locked?: boolean;
}

async function doArchiveThread(input: ArchiveThreadInput): Promise<{ ok: true }> {
	if (!input?.thread_id) throw new Error("archiveThread: thread_id required");
	await discord("PATCH", `/channels/${input.thread_id}`, {
		archived: true,
		locked: input.locked ?? true,
	});
	return { ok: true };
}

async function doUnarchiveThread(input: { thread_id: string }): Promise<{ ok: true }> {
	if (!input?.thread_id) throw new Error("unarchiveThread: thread_id required");
	await discord("PATCH", `/channels/${input.thread_id}`, { archived: false, locked: false });
	return { ok: true };
}

interface ListPairChannelsResult {
	channel_id: string;
	name: string;
	peer_a_agent_uuid: string;
	peer_b_agent_uuid: string;
}

async function doListPairChannels(state: Record<string, any>): Promise<ListPairChannelsResult[]> {
	const cat = await doEnsurePairCategory(state);
	const channels = await listGuildChannels(a2aGuildId());
	const out: ListPairChannelsResult[] = [];
	for (const c of channels) {
		if (c.type !== DISCORD_CHANNEL_TYPE_TEXT) continue;
		if (c.parent_id !== cat.category_id) continue;
		if (!c.name.startsWith("pair-")) continue;
		const parsed = parsePairChannelTopic(c.topic);
		if (!parsed) continue;
		out.push({
			channel_id: c.id,
			name: c.name,
			peer_a_agent_uuid: parsed.peer_a_agent_uuid,
			peer_b_agent_uuid: parsed.peer_b_agent_uuid,
		});
	}
	return out;
}

// A2A poll cadence + caching:
// - pollA2AGuild is invoked from the actor tick (every 3s) but actually
//   touches Discord only every A2A_POLL_INTERVAL_MS (default 15s).
// - Pair-channel list cached for A2A_CHANNEL_CACHE_TTL_MS.
// - On a 429, we honour the server's retry_after and skip A2A polls
//   until that deadline (plus a small buffer).
const A2A_POLL_INTERVAL_MS = Number(process.env.GLON_A2A_POLL_INTERVAL_MS ?? 15_000);
const A2A_CHANNEL_CACHE_TTL_MS = Number(process.env.GLON_A2A_CHANNEL_CACHE_TTL_MS ?? 60_000);

/** Poll all threads in all pair channels for new envelopes; dispatch each
 *  to /peer-chat handleA2A. Throttled per A2A_POLL_INTERVAL_MS; honours
 *  Discord 429 retry_after. Returns total envelopes processed. */
async function pollA2AGuild(state: Record<string, any>, ctx: ProgramContext): Promise<number> {
	if (!process.env.GLON_A2A_DISCORD_GUILD) return 0;
	const now = Date.now();
	if (typeof state.a2aNextPollAt === "number" && now < state.a2aNextPollAt) return 0;
	state.a2aNextPollAt = now + A2A_POLL_INTERVAL_MS;

	let total = 0;
	try {
		const cat = await doEnsurePairCategory(state);

		// Cache the pair-channel list — new pair channels show up within
		// A2A_CHANNEL_CACHE_TTL_MS.
		const cachedAt = typeof state.a2aChannelsCachedAt === "number" ? state.a2aChannelsCachedAt : 0;
		let pairChannels: DiscordChannelSummary[];
		if (Array.isArray(state.a2aChannelsCache) && now - cachedAt < A2A_CHANNEL_CACHE_TTL_MS) {
			pairChannels = state.a2aChannelsCache as DiscordChannelSummary[];
		} else {
			const channels = await listGuildChannels(a2aGuildId());
			pairChannels = channels.filter((c) =>
				c.type === DISCORD_CHANNEL_TYPE_TEXT
				&& c.parent_id === cat.category_id
				&& c.name.startsWith("pair-"),
			);
			state.a2aChannelsCache = pairChannels;
			state.a2aChannelsCachedAt = now;
		}

		// One guild-level active-threads call covers all our pair channels.
		const allActive = await discord("GET", `/guilds/${a2aGuildId()}/threads/active`);
		const activeList: any[] = Array.isArray(allActive) ? allActive : (allActive?.threads ?? []);
		const threadsByChannel: Map<string, ThreadSummary[]> = new Map();
		for (const t of activeList) {
			const summary = threadFromRaw(t);
			if (!threadsByChannel.has(summary.parent_id)) threadsByChannel.set(summary.parent_id, []);
			threadsByChannel.get(summary.parent_id)!.push(summary);
		}

		// Also pull recently archived threads per pair channel — when a peer
		// archives + locks a conversation right after their final message
		// (the common goal-driven-done pattern), our active-threads listing
		// no longer sees it. Without this, the originating agent never gets
		// auto-triggered for the peer's last word + done envelope. We bound
		// the lookback to threads archived within the last hour to avoid
		// re-processing ancient closed conversations on every poll.
		const archiveLookbackMs = 60 * 60 * 1000;
		for (const ch of pairChannels) {
			try {
				const archivedRaw = await discord("GET", `/channels/${ch.id}/threads/archived/public?limit=20`);
				const archivedList: any[] = archivedRaw?.threads ?? [];
				for (const t of archivedList) {
					const summary = threadFromRaw(t);
					const archivedAt = t.thread_metadata?.archive_timestamp
						? Date.parse(t.thread_metadata.archive_timestamp)
						: 0;
					if (archivedAt && Date.now() - archivedAt > archiveLookbackMs) continue;
					if (!threadsByChannel.has(summary.parent_id)) threadsByChannel.set(summary.parent_id, []);
					threadsByChannel.get(summary.parent_id)!.push(summary);
				}
			} catch (err: any) {
				// Per-channel failure shouldn't abort the whole tick.
				ctx.print(dim(`  [discord] A2A archived-threads fetch failed for ${ch.name}: ${err?.message ?? String(err)}`));
			}
		}

		state.a2aThreadWatermarks = state.a2aThreadWatermarks ?? {};

		for (const ch of pairChannels) {
			const threads = threadsByChannel.get(ch.id) ?? [];
			for (const t of threads) {
				try {
					total += await pollA2AThread(t, state, ctx);
				} catch (err: any) {
					if (err?.rateLimited) {
						const wait = Math.max(1, Number(err.retryAfter ?? 1));
						state.a2aNextPollAt = Date.now() + Math.round(wait * 1000) + 500;
						ctx.print(dim(`  [discord] A2A rate-limited; backing off ${wait.toFixed(1)}s`));
						return total;
					}
					ctx.print(dim(`  [discord] A2A thread poll error for ${t.name}: ${err?.message ?? String(err)}`));
				}
			}
		}
	} catch (err: any) {
		if (err?.rateLimited) {
			const wait = Math.max(1, Number(err.retryAfter ?? 1));
			state.a2aNextPollAt = Date.now() + Math.round(wait * 1000) + 500;
			ctx.print(dim(`  [discord] A2A rate-limited (setup); backing off ${wait.toFixed(1)}s`));
		} else {
			ctx.print(dim(`  [discord] A2A poll setup failed: ${err?.message ?? String(err)}`));
		}
	}
	return total;
}

async function pollA2AThread(thread: ThreadSummary, state: Record<string, any>, ctx: ProgramContext): Promise<number> {
	// Don't early-exit on locked threads — we need to process the final
	// messages (especially the `done` envelope) so the originating agent
	// can react. `handleA2A` itself sees `thread_locked: true` in the input
	// and decides whether to fire the relay step vs. ignore.

	const watermarks = state.a2aThreadWatermarks as Record<string, string>;
	const watermark = watermarks[thread.thread_id];
	const isFirstPoll = !watermark;

	// Snowflake comparison: thread.last_message_id older than or equal to
	// our watermark means there's nothing new — skip the message fetch.
	if (!isFirstPoll && thread.last_message_id && thread.last_message_id <= watermark) return 0;

	const qs = isFirstPoll ? `?limit=${A2A_POLL_BATCH}` : `?limit=${A2A_POLL_BATCH}&after=${watermark}`;
	const rawMessages = await discord("GET", `/channels/${thread.thread_id}/messages${qs}`);
	if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
		if (isFirstPoll) watermarks[thread.thread_id] = "0";
		return 0;
	}
	const sorted = [...rawMessages].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
	const newest = String(sorted[sorted.length - 1].id);
	if (!watermark || newest > watermark) watermarks[thread.thread_id] = newest;

	const now = Date.now();
	const eligible = isFirstPoll
		? sorted.filter((m: any) => now - snowflakeTimestampMs(String(m.id)) <= FIRST_POLL_RECENCY_MS)
		: sorted;

	let processed = 0;
	for (const m of eligible) {
		const envelope = parseA2AMessage(String(m.content ?? ""));
		if (!envelope) continue;
		processed++;
		try {
			await ctx.dispatchProgram("/peer-chat", "handleA2A", [{
				envelope,
				thread_id: thread.thread_id,
				thread_name: thread.name,
				channel_id: thread.parent_id,
				discord_message_id: String(m.id),
				in_reply_to_discord_id: m.message_reference?.message_id ? String(m.message_reference.message_id) : null,
				sent_at: snowflakeTimestampMs(String(m.id)),
				thread_archived: thread.archived,
				thread_locked: thread.locked,
			}]);
		} catch (err: any) {
			ctx.print(dim(`  [discord] A2A dispatch failed (thread ${thread.thread_id}, msg ${m.id}): ${err?.message ?? String(err)}`));
		}
	}
	return processed;
}

// ── Agent roster (Discord forum channel, one post per agent) ─────
//
// The roster is a forum channel under glon-a2a. Each agent has one
// forum post (Discord thread); the post's starter message holds the
// agent's status card; the post's applied_tags encode online state.
//
// Lifecycle:
//   - bootstrap → ensureRosterPost creates the post, tags it 🟢 online,
//     stores the thread_id on the /agent object
//   - heartbeat (every GLON_ROSTER_HEARTBEAT_MS, default 30 min) →
//     editRosterCard re-writes the starter message, bumping updated_at
//   - graceful shutdown → archiveRosterPost (tag ⚫ offline, archive)
//   - unclean exit → Discord auto-archives after the auto_archive
//     duration (default 1 day = 1440 min); the archived state IS the
//     stale signal — no prune script needed
//
// Each agent's roster_thread_id is stored on its /agent object so a
// daemon restart finds and updates the existing post instead of creating
// duplicates.

const ROSTER_FORUM_NAME_DEFAULT = "roster";
const ROSTER_CARD_FENCE = "glon-card";
const ROSTER_CARD_FENCE_RE = new RegExp("```\\s*" + ROSTER_CARD_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "i");
const ROSTER_HEARTBEAT_INTERVAL_MS = Number(process.env.GLON_ROSTER_HEARTBEAT_MS ?? 30 * 60 * 1000);
const ROSTER_AUTO_ARCHIVE_MINUTES = Number(process.env.GLON_ROSTER_AUTO_ARCHIVE_MINUTES ?? 1440);
const DISCORD_CHANNEL_TYPE_FORUM = 15;

interface RosterTagSet {
	online: string;       // tag id
	offline: string;
}

interface RosterCard {
	v: 1;
	agent_uuid: string;
	display_name: string;
	owner_discord_id?: string;
	owner_display_name?: string;
	bio?: string;
	status_text?: string;
	updated_at: number;
}

function rosterForumName(): string {
	return process.env.GLON_ROSTER_FORUM_NAME ?? ROSTER_FORUM_NAME_DEFAULT;
}

function formatRosterCard(card: RosterCard, statusLabel: string): string {
	const name = card.display_name || card.agent_uuid.slice(0, 8);
	const owner = card.owner_display_name ? ` · ${card.owner_display_name}` : "";
	const bio = card.bio ? `\n${card.bio}` : "";
	const status = card.status_text ? `\n_"${card.status_text}"_` : "";
	const updatedRelative = `_updated ${new Date(card.updated_at).toISOString()}_`;
	const preamble = `**${name}**${owner} · ${statusLabel}${bio}${status}\n${updatedRelative}`;
	const jsonBlock = "```" + ROSTER_CARD_FENCE + "\n" + JSON.stringify(card) + "\n```";
	return `${preamble}\n${jsonBlock}`;
}

function parseRosterCard(content: string): RosterCard | null {
	const m = ROSTER_CARD_FENCE_RE.exec(content ?? "");
	if (!m) return null;
	try {
		const parsed = JSON.parse(m[1]);
		if (!parsed || typeof parsed !== "object") return null;
		if (parsed.v !== 1) return null;
		if (typeof parsed.agent_uuid !== "string") return null;
		return {
			v: 1,
			agent_uuid: String(parsed.agent_uuid),
			display_name: String(parsed.display_name ?? ""),
			owner_discord_id: parsed.owner_discord_id ? String(parsed.owner_discord_id) : undefined,
			owner_display_name: parsed.owner_display_name ? String(parsed.owner_display_name) : undefined,
			bio: parsed.bio ? String(parsed.bio) : undefined,
			status_text: parsed.status_text ? String(parsed.status_text) : undefined,
			updated_at: Number(parsed.updated_at ?? 0),
		};
	} catch {
		return null;
	}
}

interface EnsureRosterForumResult {
	forum_channel_id: string;
	created: boolean;
	tags: RosterTagSet;
}

async function doEnsureRosterForum(state: Record<string, any>): Promise<EnsureRosterForumResult> {
	const guildId = a2aGuildId();
	const wantName = rosterForumName();
	state.rosterForumByGuild = state.rosterForumByGuild ?? {} as Record<string, { forum_channel_id: string; tags: RosterTagSet }>;
	const cached = state.rosterForumByGuild[guildId];
	if (cached?.forum_channel_id && cached.tags?.online && cached.tags?.offline) {
		return { forum_channel_id: cached.forum_channel_id, created: false, tags: cached.tags };
	}

	const cat = await doEnsurePairCategory(state);
	const channels = await listGuildChannels(guildId);
	const existing = channels.find((c) => c.type === DISCORD_CHANNEL_TYPE_FORUM && c.parent_id === cat.category_id && c.name.toLowerCase() === wantName.toLowerCase());

	let forumChannelId: string;
	let created = false;
	if (existing) {
		forumChannelId = existing.id;
	} else {
		const botUserId = await getBotUserId(state);
		const createBody = {
			name: wantName,
			type: DISCORD_CHANNEL_TYPE_FORUM,
			parent_id: cat.category_id,
			topic: "glon agent roster · one forum post per agent · click any to chat",
			default_auto_archive_duration: ROSTER_AUTO_ARCHIVE_MINUTES,
			// Public to the whole guild for read + reply-in-thread, but only the
			// bot can create new agent cards (forum posts). See
			// buildPublicRosterOverwrites for the full breakdown.
			permission_overwrites: buildPublicRosterOverwrites(guildId, botUserId),
			available_tags: [
				{ name: "online", emoji_name: "🟢", moderated: false },
				{ name: "offline", emoji_name: "⚫", moderated: false },
			],
		};
		const createdForum = await discord("POST", `/guilds/${guildId}/channels`, createBody);
		if (!createdForum?.id) throw new Error("Discord did not return a channel id when creating roster forum");
		forumChannelId = String(createdForum.id);
		created = true;
	}

	// Discover the tag ids (whether we just created them or they pre-existed).
	const channelInfo = await discord("GET", `/channels/${forumChannelId}`);
	const availableTags: Array<any> = channelInfo?.available_tags ?? [];
	const onlineTag = availableTags.find((t) => String(t.name ?? "").toLowerCase() === "online");
	const offlineTag = availableTags.find((t) => String(t.name ?? "").toLowerCase() === "offline");
	if (!onlineTag?.id || !offlineTag?.id) {
		throw new Error("roster forum is missing the online/offline tags — add them in Discord settings or recreate the channel");
	}
	const tags: RosterTagSet = { online: String(onlineTag.id), offline: String(offlineTag.id) };
	state.rosterForumByGuild[guildId] = { forum_channel_id: forumChannelId, tags };
	return { forum_channel_id: forumChannelId, created, tags };
}

interface EnsureRosterPostInput {
	agent_uuid: string;
	display_name: string;
	bio?: string;
	owner_discord_id?: string;
	owner_display_name?: string;
	status_text?: string;
	roster_thread_id?: string;   // if known from prior creation
}

interface EnsureRosterPostResult {
	roster_thread_id: string;
	starter_message_id: string;
	created: boolean;
}

async function doEnsureRosterPost(state: Record<string, any>, input: EnsureRosterPostInput): Promise<EnsureRosterPostResult> {
	if (!input?.agent_uuid) throw new Error("ensureRosterPost: agent_uuid required");
	if (!input?.display_name) throw new Error("ensureRosterPost: display_name required");
	const forum = await doEnsureRosterForum(state);
	const card: RosterCard = {
		v: 1,
		agent_uuid: input.agent_uuid,
		display_name: input.display_name,
		bio: input.bio,
		owner_discord_id: input.owner_discord_id,
		owner_display_name: input.owner_display_name,
		status_text: input.status_text,
		updated_at: Date.now(),
	};
	state.rosterPostByUuid = state.rosterPostByUuid ?? {} as Record<string, string>;

	// Try edit-in-place candidates first: explicit input, then in-process cache.
	// Each candidate is verified to live in the current GLON_A2A_DISCORD_GUILD
	// before we touch it — otherwise we'd accidentally edit a stale post in a
	// different guild that the bot is also a member of (cross-guild leak).
	const candidates: string[] = [];
	if (input.roster_thread_id) candidates.push(input.roster_thread_id);
	const cached = state.rosterPostByUuid[input.agent_uuid];
	if (cached && cached !== input.roster_thread_id) candidates.push(cached);

	const currentGuildId = a2aGuildId();
	for (const tid of candidates) {
		let okGuild = false;
		try {
			const meta = await discord("GET", `/channels/${tid}`);
			okGuild = String(meta?.guild_id ?? "") === currentGuildId;
		} catch {
			// 404 / 403 — drop this candidate, move on
		}
		if (!okGuild) continue;
		try {
			await doEditRosterCard({ thread_id: tid, card, status: "online", forum_tags: forum.tags });
			state.rosterPostByUuid[input.agent_uuid] = tid;
			return { roster_thread_id: tid, starter_message_id: tid, created: false };
		} catch {
			// thread in wrong forum within the same guild, or other edit failure
		}
	}

	// Discord-as-truth fallback: scan all roster posts for an existing one
	// matching this agent_uuid. This covers post-restart de-dup (in-memory
	// cache wiped) and the case where a stored roster_thread_id points to
	// a manually-deleted post.
	try {
		const existing = await doListRosterPosts(state, { include_archived: true });
		const match = existing.find((e) => e.card.agent_uuid.toLowerCase() === input.agent_uuid.toLowerCase());
		if (match) {
			try {
				await doEditRosterCard({ thread_id: match.roster_thread_id, card, status: "online", forum_tags: forum.tags });
			} catch { /* edit might still fail; we still know the post exists */ }
			state.rosterPostByUuid[input.agent_uuid] = match.roster_thread_id;
			return { roster_thread_id: match.roster_thread_id, starter_message_id: match.roster_thread_id, created: false };
		}
	} catch {
		// Scan failure shouldn't block creation.
	}

	// Fresh create — no existing post anywhere.
	const created = await discord("POST", `/channels/${forum.forum_channel_id}/threads`, {
		name: (input.display_name).slice(0, 100),
		applied_tags: [forum.tags.online],
		auto_archive_duration: ROSTER_AUTO_ARCHIVE_MINUTES,
		message: { content: formatRosterCard(card, "🟢 online") },
	});
	if (!created?.id) throw new Error("Discord did not return a thread id when creating roster post");
	state.rosterPostByUuid[input.agent_uuid] = String(created.id);
	return { roster_thread_id: String(created.id), starter_message_id: String(created.id), created: true };
}

/** One-off cleanup: for each agent_uuid with more than one roster post,
 *  keep the most recently updated and delete the rest. Idempotent. */
async function doPruneDuplicateRosterPosts(state: Record<string, any>): Promise<{ kept: string[]; deleted: string[] }> {
	const posts = await doListRosterPosts(state, { include_archived: true });
	const byUuid = new Map<string, typeof posts>();
	for (const p of posts) {
		const key = p.card.agent_uuid.toLowerCase();
		if (!byUuid.has(key)) byUuid.set(key, []);
		byUuid.get(key)!.push(p);
	}
	const kept: string[] = [];
	const deleted: string[] = [];
	for (const [, group] of byUuid) {
		if (group.length <= 1) {
			if (group[0]) kept.push(group[0].roster_thread_id);
			continue;
		}
		// Sort newest first; keep [0], delete the rest.
		const sorted = group.slice().sort((a, b) => (b.card.updated_at ?? 0) - (a.card.updated_at ?? 0));
		kept.push(sorted[0].roster_thread_id);
		for (const dupe of sorted.slice(1)) {
			try {
				await discord("DELETE", `/channels/${dupe.roster_thread_id}`);
				deleted.push(dupe.roster_thread_id);
			} catch {
				// Best effort.
			}
		}
	}
	// Reset the cache so subsequent calls re-discover.
	state.rosterPostByUuid = {};
	return { kept, deleted };
}

interface EditRosterCardInput {
	thread_id: string;
	card: RosterCard;
	status: "online" | "offline";
	forum_tags?: RosterTagSet;
}

async function doEditRosterCard(input: EditRosterCardInput): Promise<{ ok: true }> {
	if (!input?.thread_id) throw new Error("editRosterCard: thread_id required");
	if (!input?.card) throw new Error("editRosterCard: card required");
	const statusLabel = input.status === "online" ? "🟢 online" : "⚫ offline";
	const content = formatRosterCard(input.card, statusLabel);

	// The starter message of a forum post has the same id as the thread.
	// Edit it in place. If Discord rejects (thread archived but not locked),
	// editing un-archives automatically.
	await discord("PATCH", `/channels/${input.thread_id}/messages/${input.thread_id}`, { content });

	// Apply tags if provided.
	if (input.forum_tags) {
		const tagId = input.status === "online" ? input.forum_tags.online : input.forum_tags.offline;
		try {
			await discord("PATCH", `/channels/${input.thread_id}`, { applied_tags: [tagId] });
		} catch {
			// Tag update is best-effort; the card edit is the source of truth.
		}
	}
	return { ok: true };
}

interface ArchiveRosterPostInput {
	thread_id: string;
	final_card?: RosterCard;    // optional: rewrite the card before archiving
}

async function doArchiveRosterPost(state: Record<string, any>, input: ArchiveRosterPostInput): Promise<{ ok: true }> {
	if (!input?.thread_id) throw new Error("archiveRosterPost: thread_id required");
	const forum = await doEnsureRosterForum(state);
	if (input.final_card) {
		try {
			await doEditRosterCard({ thread_id: input.thread_id, card: input.final_card, status: "offline", forum_tags: forum.tags });
		} catch {
			// best-effort
		}
	} else {
		// Just flip the tag.
		try {
			await discord("PATCH", `/channels/${input.thread_id}`, { applied_tags: [forum.tags.offline] });
		} catch { /* best-effort */ }
	}
	await discord("PATCH", `/channels/${input.thread_id}`, { archived: true });
	return { ok: true };
}

interface RosterEntry {
	roster_thread_id: string;
	archived: boolean;
	tag_status: "online" | "offline" | "unknown";
	card: RosterCard;
}

async function doListRosterPosts(state: Record<string, any>, input?: { include_archived?: boolean }): Promise<RosterEntry[]> {
	const forum = await doEnsureRosterForum(state);
	const includeArchived = !!input?.include_archived;

	// Active threads first (via guild-wide endpoint, filter by parent).
	const guildId = a2aGuildId();
	const activeRaw = await discord("GET", `/guilds/${guildId}/threads/active`);
	const activeList: any[] = Array.isArray(activeRaw) ? activeRaw : (activeRaw?.threads ?? []);
	const active = activeList.filter((t) => String(t.parent_id) === forum.forum_channel_id);

	let archivedList: any[] = [];
	if (includeArchived) {
		const archivedRaw = await discord("GET", `/channels/${forum.forum_channel_id}/threads/archived/public?limit=50`);
		archivedList = archivedRaw?.threads ?? [];
	}

	const all = [...active, ...archivedList];
	const out: RosterEntry[] = [];
	for (const t of all) {
		const threadId = String(t.id);
		// The starter message of a forum post has the same id as the thread.
		let starter: any = null;
		try {
			starter = await discord("GET", `/channels/${threadId}/messages/${threadId}`);
		} catch {
			continue;
		}
		const card = parseRosterCard(String(starter?.content ?? ""));
		if (!card) continue;
		const appliedTags: string[] = Array.isArray(t.applied_tags) ? t.applied_tags.map(String) : [];
		const tagStatus: "online" | "offline" | "unknown" =
			appliedTags.includes(forum.tags.online) ? "online" :
			appliedTags.includes(forum.tags.offline) ? "offline" :
			"unknown";
		out.push({
			roster_thread_id: threadId,
			archived: !!t.thread_metadata?.archived,
			tag_status: tagStatus,
			card,
		});
	}
	return out;
}

// ── Roster forum H2A chat (humans → agents in their roster threads) ──
// When a human posts in an agent's #roster forum post, the daemon polls
// it, looks up the agent (via the card on the starter message), and
// dispatches the human's message to that agent's /agent.ask loop. The
// agent's final text gets posted back into the same thread with a
// **<AgentName>:** prefix and message_reference for native Discord
// reply rendering. Each roster thread is a permanent open-ended chat
// room — no goal, no done, no locking. Discord auto-archive eventually
// closes idle threads; humans posting un-archives them.

const ROSTER_CHAT_POLL_BATCH = 20;

async function pollRosterForumThreads(state: Record<string, any>, ctx: ProgramContext): Promise<number> {
	if (!process.env.GLON_A2A_DISCORD_GUILD) return 0;
	let total = 0;
	try {
		const forum = await doEnsureRosterForum(state);
		const guildId = a2aGuildId();
		const allActive = await discord("GET", `/guilds/${guildId}/threads/active`);
		const list: any[] = Array.isArray(allActive) ? allActive : (allActive?.threads ?? []);
		const rosterThreads = list
			.filter((t) => String(t.parent_id) === forum.forum_channel_id)
			.map(threadFromRaw);

		state.rosterChatWatermarks = state.rosterChatWatermarks ?? {} as Record<string, string>;
		for (const t of rosterThreads) {
			try {
				total += await pollRosterThread(t, state, ctx);
			} catch (err: any) {
				if (err?.rateLimited) {
					const wait = Math.max(1, Number(err.retryAfter ?? 1));
					state.a2aNextPollAt = Date.now() + Math.round(wait * 1000) + 500;
					ctx.print(dim(`  [discord] roster chat rate-limited; backing off ${wait.toFixed(1)}s`));
					return total;
				}
				ctx.print(dim(`  [discord] roster thread poll error for ${t.name}: ${err?.message ?? String(err)}`));
			}
		}
	} catch (err: any) {
		ctx.print(dim(`  [discord] roster chat poll setup failed: ${err?.message ?? String(err)}`));
	}
	return total;
}

async function pollRosterThread(thread: ThreadSummary, state: Record<string, any>, ctx: ProgramContext): Promise<number> {
	const watermarks = state.rosterChatWatermarks as Record<string, string>;
	const watermark = watermarks[thread.thread_id];
	const isFirstPoll = !watermark;

	if (!isFirstPoll && thread.last_message_id && thread.last_message_id <= watermark) return 0;

	const qs = isFirstPoll ? `?limit=${ROSTER_CHAT_POLL_BATCH}` : `?limit=${ROSTER_CHAT_POLL_BATCH}&after=${watermark}`;
	const rawMessages = await discord("GET", `/channels/${thread.thread_id}/messages${qs}`);
	if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
		if (isFirstPoll) watermarks[thread.thread_id] = "0";
		return 0;
	}
	const sorted = [...rawMessages].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
	const newest = String(sorted[sorted.length - 1].id);
	if (!watermark || newest > watermark) watermarks[thread.thread_id] = newest;

	const botUserId = await getBotUserId(state);
	let sawEmptyHumanContent = false;

	// Find the index of the most recent bot message — anything after it is
	// "unanswered" human chatter that needs handling. This is the right cut
	// for roster threads (permanent chat rooms): on a first poll after a
	// daemon restart, we don't want to drop old human messages just because
	// they're older than a recency window — they're real questions the
	// agent hasn't answered yet. The post-watermark `after=` query keeps
	// subsequent polls cheap.
	let lastBotIdx = -1;
	for (let i = sorted.length - 1; i >= 0; i--) {
		const m: any = sorted[i];
		if (m.author?.id === botUserId && String(m.id) !== thread.thread_id) { lastBotIdx = i; break; }
	}
	const afterLastBot = lastBotIdx >= 0 ? sorted.slice(lastBotIdx + 1) : sorted;

	const eligible = afterLastBot.filter((m: any) => {
		if (String(m.id) === thread.thread_id) return false; // starter message = agent card, not a chat
		if (m.author?.id === botUserId) return false;        // bot's own posts (shouldn't appear after the last-bot cut, but defensive)
		const content = String(m.content ?? "").trim();
		if (!content) {
			if (!m.author?.bot) sawEmptyHumanContent = true;
			return false;
		}
		return true;
	});
	if (sawEmptyHumanContent && !state._warnedAboutMessageContent) {
		ctx.print(red(`  [discord] saw human messages with empty content — enable MESSAGE CONTENT INTENT for the bot at https://discord.com/developers/applications, then re-post`));
		state._warnedAboutMessageContent = true;
	}
	if (eligible.length === 0) return 0;

	// Resolve which agent this thread belongs to via the starter message's card.
	let agentUuid: string | null = null;
	try {
		const starter = await discord("GET", `/channels/${thread.thread_id}/messages/${thread.thread_id}`);
		const card = parseRosterCard(String(starter?.content ?? ""));
		if (card) agentUuid = card.agent_uuid;
	} catch {
		return 0;
	}
	if (!agentUuid) return 0;

	let processed = 0;
	for (const m of eligible) {
		try {
			await routeRosterChatMessage(thread, m, agentUuid, ctx);
			processed++;
		} catch (err: any) {
			ctx.print(dim(`  [discord] roster chat dispatch failed (thread ${thread.thread_id}, msg ${m.id}): ${err?.message ?? String(err)}`));
		}
	}
	return processed;
}

async function routeRosterChatMessage(
	thread: ThreadSummary,
	message: any,
	agentUuid: string,
	ctx: ProgramContext,
): Promise<void> {
	// Find the local agent whose roster thread this is.
	const allPeers = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const peers = Array.isArray(allPeers) ? allPeers : [];
	const agentPeer = peers.find((p) =>
		p.kind === "agent"
		&& (p.agent_uuid ?? "").toLowerCase() === agentUuid.toLowerCase()
		&& p.agent_object_id,
	);
	if (!agentPeer) return; // not one of our agents (cross-daemon roster post)

	// Find or create a /peer record for the human poster.
	const humanDiscordId = String(message.author?.id ?? "");
	const humanUsername = String(message.author?.global_name ?? message.author?.username ?? `discord:${humanDiscordId}`);
	if (!humanDiscordId) return;
	const ensureRes = await ctx.dispatchProgram("/peer", "findOrCreate", [{
		external_key: "discord_id",
		external_value: humanDiscordId,
		defaults: { display_name: humanUsername, kind: "human", trust_level: "trusted" },
	}]) as { id: string; created: boolean };

	// Format the prompt similar to /holdfast's formatIngestPrompt and dispatch
	// to /agent.ask directly (so we can target THIS agent, not the harness
	// default that /holdfast.ingest is wired to).
	const content = String(message.content ?? "").trim();
	// Inject the source thread/message ids so the agent can pass them as
	// `originated_from` to peer_conversation_start when delegating an A2A
	// task on this human's behalf. The system-prompt-side teaching is in
	// the peer_conversation_start tool description.
	const prompt =
		`[from ${humanUsername} on discord-roster, trust=trusted] ` +
		`[origin_thread=${thread.thread_id} origin_msg=${String(message.id)} ` +
		`human_peer_id=${ensureRes?.id ?? ""} human_display_name=${humanUsername}] ` +
		`${content}`;
	const result = await ctx.dispatchProgram("/agent", "ask", [
		agentPeer.agent_object_id,
		prompt,
	]) as { finalText?: string };

	const reply = (result?.finalText ?? "").trim();
	if (!reply) return;

	// Post back to the thread with **<AgentName>:** preamble + native reply.
	const agentName = String(agentPeer.display_name ?? "agent");
	const body = `**${agentName}:** ${reply}`;
	// Discord caps content at 2000 chars; split if needed
	const chunks = splitMessage(body, MESSAGE_MAX_LEN);
	for (let i = 0; i < chunks.length; i++) {
		const payload: Record<string, unknown> = { content: chunks[i] };
		if (i === 0) {
			payload.message_reference = { message_id: String(message.id), fail_if_not_exists: false };
		}
		await discord("POST", `/channels/${thread.thread_id}/messages`, payload);
	}
	// Touch the human's peer record's last_seen so the UX can sort by recency.
	if (ensureRes?.id) {
		try {
			await ctx.dispatchProgram("/peer", "setField", [ensureRes.id, "last_seen", new Date().toISOString()]);
		} catch { /* best-effort */ }
	}
}

// Heartbeat: bumps the updated_at on every local agent's roster card so
// idle daemons still appear online (until auto-archive eventually closes
// them after ROSTER_AUTO_ARCHIVE_MINUTES of no edits).
async function heartbeatRosterPosts(state: Record<string, any>, ctx: ProgramContext): Promise<{ heartbeated: number }> {
	if (!process.env.GLON_A2A_DISCORD_GUILD) return { heartbeated: 0 };
	const allPeers = await ctx.dispatchProgram("/peer", "list", [{}]) as Array<any>;
	const localAgents = (Array.isArray(allPeers) ? allPeers : []).filter((p) =>
		p.kind === "agent" && p.agent_uuid && p.agent_object_id,
	);
	if (localAgents.length === 0) return { heartbeated: 0 };

	state.rosterPostByUuid = state.rosterPostByUuid ?? {};
	let count = 0;
	for (const peer of localAgents) {
		const card: RosterCard = {
			v: 1,
			agent_uuid: String(peer.agent_uuid),
			display_name: String(peer.display_name ?? peer.agent_uuid),
			bio: peer.notes ? String(peer.notes) : undefined,
			updated_at: Date.now(),
		};
		const knownThreadId: string | undefined = state.rosterPostByUuid[card.agent_uuid] || undefined;
		try {
			const res = await doEnsureRosterPost(state, {
				agent_uuid: card.agent_uuid,
				display_name: card.display_name,
				bio: card.bio,
				status_text: undefined,
				roster_thread_id: knownThreadId,
			});
			state.rosterPostByUuid[card.agent_uuid] = res.roster_thread_id;
			count++;
		} catch (err: any) {
			ctx.print(dim(`  [discord] roster heartbeat failed for ${card.display_name}: ${err?.message ?? String(err)}`));
		}
	}
	return { heartbeated: count };
}

// ── Core: sending ────────────────────────────────────────────────

async function doSend(peerId: string, text: string, state: Record<string, any>, ctx: ProgramContext): Promise<{ channel_id: string; message_ids: string[] }> {
	const peer = await ctx.dispatchProgram("/peer", "get", [peerId]) as PeerSnapshot | null;
	if (!peer) throw new Error(`unknown peer: ${peerId}`);
	if (!peer.discord_id) throw new Error(`peer ${peer.display_name} has no discord_id`);
	const channelId = await getDmChannel(peer, state);
	const ids = await postMessage(channelId, text);
	return { channel_id: channelId, message_ids: ids };
}

async function doSendChannel(channelId: string, text: string): Promise<{ channel_id: string; message_ids: string[] }> {
	const ids = await postMessage(channelId, text);
	return { channel_id: channelId, message_ids: ids };
}

async function doTyping(peerId: string, state: Record<string, any>, ctx: ProgramContext): Promise<{ ok: boolean }> {
	const peer = await ctx.dispatchProgram("/peer", "get", [peerId]) as PeerSnapshot | null;
	if (!peer) throw new Error(`unknown peer: ${peerId}`);
	if (!peer.discord_id) throw new Error(`peer ${peer.display_name} has no discord_id`);
	const channelId = await getDmChannel(peer, state);
	await discord("POST", `/channels/${channelId}/typing`);
	return { ok: true };
}

// ── Core: polling ────────────────────────────────────────────────

/** Discord snowflake epoch — all snowflake timestamps are offsets from this. */
const DISCORD_EPOCH_MS = 1420070400000;

/**
 * Window for processing "recent" messages on the first poll of a channel.
 *
 * Used only when no persisted watermark exists for the channel (true first
 * encounter, never a process restart — those are covered by
 * `restorePersistedState`). The window exists for the onboarding case: a
 * user DMs the bot before the daemon has ever seen this channel; we still
 * want to answer if the message is fresh. Anything older than the window is
 * absorbed into the watermark silently, so a long-offline bot does not flood
 * a channel on first boot.
 */
const FIRST_POLL_RECENCY_MS = 60 * 1000;

/** Extract the Unix ms timestamp encoded in a Discord snowflake id. */
export function snowflakeTimestampMs(id: string): number {
	return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
}

// ── Durable state (watermarks + DM channel cache) ───────────────
//
// Watermarks and the peer → DM channel map live on the /discord program
// object in the DAG, keyed by `PERSISTED_STATE_FIELD`. Without this, a
// daemon restart within `FIRST_POLL_RECENCY_MS` of any inbound would
// re-ingest the same user message and the agent would answer it twice.
//
// The field holds a single JSON string, refreshed after every poll cycle
// only when the snapshot actually changed. We never persist gateway state
// or the `tickInProgress` guard — those are pure in-memory invariants.

const PERSISTED_STATE_FIELD = "persisted_state";

interface PersistedDiscordState {
	watermarks: Record<string, string>;
	dmChannelByPeer: Record<string, string>;
}

function snapshotPersistedState(state: Record<string, any>): string {
	return JSON.stringify({
		watermarks: (state.watermarks ?? {}) as Record<string, string>,
		dmChannelByPeer: (state.dmChannelByPeer ?? {}) as Record<string, string>,
	});
}

async function restorePersistedState(state: Record<string, any>, ctx: ProgramContext): Promise<void> {
	if (!ctx.programId || !ctx.store) return;
	try {
		const obj = await (ctx.store as any).get(ctx.programId);
		const field = obj?.fields?.[PERSISTED_STATE_FIELD];
		const raw = typeof field === "string" ? field : field?.stringValue;
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedDiscordState;
		if (parsed.watermarks && typeof parsed.watermarks === "object") {
			state.watermarks = { ...parsed.watermarks };
		}
		if (parsed.dmChannelByPeer && typeof parsed.dmChannelByPeer === "object") {
			state.dmChannelByPeer = { ...parsed.dmChannelByPeer };
		}
		state._lastPersistedSnapshot = snapshotPersistedState(state);
	} catch (err: any) {
		ctx.print(dim(`  [discord] restore state failed: ${err?.message ?? String(err)}`));
	}
}

async function persistStateIfChanged(state: Record<string, any>, ctx: ProgramContext): Promise<void> {
	if (!ctx.programId) return;
	const snap = snapshotPersistedState(state);
	if (state._lastPersistedSnapshot === snap) return;
	try {
		const actor = ctx.objectActor(ctx.programId) as any;
		if (typeof actor?.setField !== "function") return;
		await actor.setField(PERSISTED_STATE_FIELD, JSON.stringify(ctx.stringVal(snap)));
		state._lastPersistedSnapshot = snap;
	} catch (err: any) {
		ctx.print(dim(`  [discord] persist state failed: ${err?.message ?? String(err)}`));
	}
}

async function pollPeer(peer: PeerSnapshot, state: Record<string, any>, ctx: ProgramContext): Promise<number> {
	if (!peer.discord_id) return 0;
	state.watermarks = state.watermarks ?? {};

	const channelId = await getDmChannel(peer, state);
	const watermark = state.watermarks[channelId] as string | undefined;
	const isFirstPoll = !watermark;

	// First poll: fetch a small tail so we can honour the recency window.
	// Subsequent polls only need messages after the watermark.
	const qs = isFirstPoll ? `?limit=5` : `?limit=10&after=${watermark}`;
	const msgs = await discord("GET", `/channels/${channelId}/messages${qs}`) as DiscordMessage[] | null;
	if (!msgs || msgs.length === 0) {
		// Ensure the channel has *some* watermark so next tick uses `after`.
		if (isFirstPoll) state.watermarks[channelId] = "0";
		return 0;
	}

	const botUserId = await getBotUserId(state);
	// Discord returns newest-first; process oldest-first so the DAG sees them in order.
	const sorted = [...msgs].sort((a, b) => a.id.localeCompare(b.id));

	// On first poll, skip anything older than the recency window. This preserves the
	// "no unbounded history replay" invariant while still picking up a user's onboarding DM.
	const now = Date.now();
	const eligible = isFirstPoll
		? sorted.filter((m) => now - snowflakeTimestampMs(m.id) <= FIRST_POLL_RECENCY_MS)
		: sorted;

	// Always advance the watermark to the newest returned message, even for skipped
	// messages, so the next tick only sees genuinely new traffic.
	const newest = sorted[sorted.length - 1].id;
	if (!watermark || newest > watermark) state.watermarks[channelId] = newest;

	let processed = 0;
	for (const m of eligible) {
		const authorId = m.author?.id;
		if (!authorId || authorId === botUserId) continue;
		const content = (m.content ?? "").trim();
		if (!content) continue;

		processed++;
		try {
			// Fire typing while we think.
			discord("POST", `/channels/${channelId}/typing`).catch(() => { /* non-critical */ });

			const result = await ctx.dispatchProgram("/holdfast", "ingest", ["discord", peer.id, content]) as {
				finalText: string;
			};
			if (result?.finalText) {
				await postMessage(channelId, result.finalText);
			}
		} catch (err: any) {
			// Don't let one bad message poison the rest of the poll.
			const raw = err?.message ?? String(err);
			// Log the full error to the daemon so it's debuggable after the fact.
			// Discord only sees the user-friendly version below.
			ctx.print(red(`  [discord] ingest failed for peer ${peer.id}: ${raw}`));
			const userFacing = /fetch failed|econnreset|etimedout|socket hang up/i.test(raw)
				? "[network hiccup talking to my model — try again in a sec]"
				: `[error: ${raw}]`;
			try { await postMessage(channelId, userFacing); }
			catch { /* best-effort */ }
		}
	}
	return processed;
}

/** Poll a bridge channel (shared server channel, not a DM) for messages from
 *  known peers. Works like pollPeer but resolves the sender by discord_id
 *  rather than opening a DM channel. Replies are posted back to the same
 *  channel. */
async function pollBridgeChannel(channelId: string, state: Record<string, any>, ctx: ProgramContext): Promise<number> {
	state.watermarks = state.watermarks ?? {};
	const watermark = state.watermarks[channelId] as string | undefined;
	const isFirstPoll = !watermark;

	const qs = isFirstPoll ? `?limit=5` : `?limit=10&after=${watermark}`;
	const msgs = await discord("GET", `/channels/${channelId}/messages${qs}`) as DiscordMessage[] | null;
	if (!msgs || msgs.length === 0) {
		if (isFirstPoll) state.watermarks[channelId] = "0";
		return 0;
	}

	const botUserId = await getBotUserId(state);
	const sorted = [...msgs].sort((a, b) => a.id.localeCompare(b.id));

	const now = Date.now();
	const eligible = isFirstPoll
		? sorted.filter((m) => now - snowflakeTimestampMs(m.id) <= FIRST_POLL_RECENCY_MS)
		: sorted;

	const newest = sorted[sorted.length - 1].id;
	if (!watermark || newest > watermark) state.watermarks[channelId] = newest;

	// Build a lookup of peer by discord_id so we can identify the sender.
	const peers = await fetchPeersWithDiscord(ctx);
	const peerByDiscordId = new Map<string, PeerSnapshot>();
	for (const p of peers) {
		if (p.discord_id) peerByDiscordId.set(p.discord_id, p);
	}

	let processed = 0;
	for (const m of eligible) {
		const authorId = m.author?.id;
		if (!authorId || authorId === botUserId) continue;
		const content = (m.content ?? "").trim();
		if (!content) continue;

		const peer = peerByDiscordId.get(authorId);
		if (!peer) continue; // unknown sender — skip
		if (!BRIDGE_INGEST_AGENTS && peer.kind === "agent") continue;

		processed++;
		try {
			discord("POST", `/channels/${channelId}/typing`).catch(() => {});

			const result = await ctx.dispatchProgram("/holdfast", "ingest", ["discord", peer.id, content]) as {
				finalText: string;
			};
			if (result?.finalText) {
				await postMessage(channelId, result.finalText);
			}
		} catch (err: any) {
			const raw = err?.message ?? String(err);
			ctx.print(red(`  [discord] bridge ingest failed for ${peer.display_name}: ${raw}`));
			const userFacing = /fetch failed|econnreset|etimedout|socket hang up/i.test(raw)
				? "[network hiccup talking to my model — try again in a sec]"
				: `[error: ${raw}]`;
			try { await postMessage(channelId, userFacing); }
			catch { /* best-effort */ }
		}
	}
	return processed;
}


async function maybeHeartbeatRoster(state: Record<string, any>, ctx: ProgramContext): Promise<void> {
	if (!process.env.GLON_A2A_DISCORD_GUILD) return;
	const now = Date.now();
	const next = typeof state.rosterNextHeartbeatAt === "number" ? state.rosterNextHeartbeatAt : 0;
	if (now < next) return;
	state.rosterNextHeartbeatAt = now + ROSTER_HEARTBEAT_INTERVAL_MS;
	try {
		await heartbeatRosterPosts(state, ctx);
	} catch (err: any) {
		ctx.print(dim(`  [discord] roster heartbeat tick error: ${err?.message ?? String(err)}`));
	}
}

async function runPoll(state: Record<string, any>, ctx: ProgramContext): Promise<{ peers: number; processed: number; bridges: number; a2a: number }> {
	const peers = await fetchPeersWithDiscord(ctx);
	let processed = 0;
	for (const peer of peers) {
		try {
			processed += await pollPeer(peer, state, ctx);
		} catch (err: any) {
			ctx.print(dim(`  [discord] poll error for ${peer.display_name}: ${err?.message ?? String(err)}`));
		}
	}

	const bridgeChannels = getBridgeChannels();
	let bridges = 0;
	for (const channelId of bridgeChannels) {
		try {
			bridges += await pollBridgeChannel(channelId, state, ctx);
		} catch (err: any) {
			ctx.print(dim(`  [discord] bridge poll error for ${channelId}: ${err?.message ?? String(err)}`));
		}
	}

	const a2a = await pollA2AGuild(state, ctx);
	// Poll for humans chatting with agents in their roster threads (H2A).
	let rosterChat = 0;
	try {
		rosterChat = await pollRosterForumThreads(state, ctx);
	} catch (err: any) {
		ctx.print(dim(`  [discord] roster chat tick error: ${err?.message ?? String(err)}`));
	}
	// Roster card heartbeat (separate throttle).
	await maybeHeartbeatRoster(state, ctx);
	return { peers: peers.length, processed, bridges, a2a, rosterChat } as any;
}

// ── Core: Gateway (presence / "online" status) ─────────────────
//
// Discord shows a bot as online only while it holds a live Gateway
// WebSocket. REST alone can't do it. We maintain a single outbound WSS
// client from the discord programActor, keep it warm with heartbeats, and
// reconnect with jittered exponential backoff on any drop.
//
// Intents are 0 — we don't subscribe to any events. REST polling already
// handles inbound DMs. This keeps the bot presence-only, so no privileged
// intents are required on the Discord developer dashboard.
//
// The WS client lives in the daemon process (scripts/daemon.ts). When the
// daemon dies the connection dies with it; onCreate/onTick re-open it when
// the daemon is restarted.

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// Bot presence shown next to the bot's name in Discord ("<bot> · <text>").
// Set GLON_DISCORD_PRESENCE in env to override; set it to an empty string to
// suppress the activity entirely. Activity type 4 (Custom status) is the
// least overbearing — it just shows the text without a "Playing"/"Listening"
// verb in front.
const GATEWAY_PRESENCE_ACTIVITY_NAME = process.env.GLON_DISCORD_PRESENCE ?? "glon";
const GATEWAY_PRESENCE_ACTIVITY_TYPE = 4; // 4 = Custom status

// Gateway opcodes — see https://discord.com/developers/docs/events/gateway-events
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const GATEWAY_MAX_BACKOFF_MS = 30_000;
const GATEWAY_BASE_BACKOFF_MS = 1_000;

/** Close codes that indicate we should not retry — configuration is wrong. */
const GATEWAY_FATAL_CLOSE_CODES = new Set([
	4004, // authentication failed (bad token)
	4010, // invalid shard
	4011, // sharding required
	4012, // invalid API version
	4013, // invalid intents
	4014, // disallowed intents (privileged intent not enabled in dev portal)
]);

/**
 * Minimal WebSocket shape we use. We accept `globalThis.WebSocket` (Node 22+)
 * or a test-injected fake via `globalThis.__DISCORD_GATEWAY_WS_CTOR`.
 */
interface GatewayWS {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	// Discord sends everything as text frames; we set these directly on the
	// instance so test fakes don't need an EventTarget implementation.
	onopen: ((ev?: any) => void) | null;
	onmessage: ((ev: { data: string }) => void) | null;
	onclose: ((ev: { code: number; reason: string }) => void) | null;
	onerror: ((ev: any) => void) | null;
}

type GatewayWSCtor = new (url: string) => GatewayWS;

function gatewayWSCtor(): GatewayWSCtor {
	const injected = (globalThis as any).__DISCORD_GATEWAY_WS_CTOR as GatewayWSCtor | undefined;
	if (injected) return injected;
	return WebSocket as unknown as GatewayWSCtor;
}

/** Build the IDENTIFY payload. Pure — unit-testable. */
export function buildIdentifyPayload(token: string): unknown {
	return {
		op: OP_IDENTIFY,
		d: {
			token,
			intents: 0,
			properties: {
				os: process.platform,
				browser: "glon",
				device: "glon",
			},
			presence: {
				status: "online",
				since: null,
				afk: false,
				activities: GATEWAY_PRESENCE_ACTIVITY_NAME
					? [{ name: GATEWAY_PRESENCE_ACTIVITY_NAME, type: GATEWAY_PRESENCE_ACTIVITY_TYPE }]
					: [],
			},
		},
	};
}

/** Jittered exponential backoff. Pure. */
export function computeReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
	const base = Math.min(GATEWAY_BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), GATEWAY_MAX_BACKOFF_MS);
	const jitter = 0.25; // ±25%
	return Math.round(base * (1 - jitter + random() * jitter * 2));
}

/** Decide whether the next heartbeat is due. Pure. */
export function shouldSendHeartbeat(state: Record<string, any>, now: number): boolean {
	if (!state.gatewayHeartbeatMs) return false;
	if (!state.gatewayConnected) return false;
	const last = state.gatewayLastHeartbeatSentAt ?? 0;
	return now - last >= state.gatewayHeartbeatMs;
}

/**
 * Detect a "zombied" connection where we've sent heartbeats but the server
 * hasn't ack'd in over two intervals. Discord tells us to reconnect in this
 * case (https://discord.com/developers/docs/events/gateway#heartbeat-interval).
 */
export function isHeartbeatAckOverdue(state: Record<string, any>, now: number): boolean {
	if (!state.gatewayHeartbeatMs) return false;
	if (!state.gatewayConnected) return false;
	const lastSent = state.gatewayLastHeartbeatSentAt ?? 0;
	const lastAck = state.gatewayLastHeartbeatAckAt ?? 0;
	if (lastSent === 0) return false; // never sent yet
	if (lastAck >= lastSent) return false; // all ack'd
	return now - lastSent >= state.gatewayHeartbeatMs * 2;
}

function sendHeartbeat(state: Record<string, any>, ws: GatewayWS, now: number): void {
	ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: state.gatewayLastSeq ?? null }));
	state.gatewayLastHeartbeatSentAt = now;
}

interface GatewayFrame {
	op: number;
	d?: any;
	s?: number | null;
	t?: string | null;
}

/**
 * Dispatch a received Gateway frame. Returns structured actions for the caller
 * so we can unit-test the decision logic without real network or timers.
 */
export function handleGatewayFrame(state: Record<string, any>, frame: GatewayFrame, now: number): {
	sendIdentify: boolean;
	sendHeartbeat: boolean;
	reconnect: boolean;
} {
	let sendIdentify = false;
	let sendHb = false;
	let reconnect = false;

	switch (frame.op) {
		case OP_HELLO: {
			const intervalMs = Number(frame.d?.heartbeat_interval);
			if (intervalMs > 0) state.gatewayHeartbeatMs = intervalMs;
			sendIdentify = true;
			break;
		}
		case OP_HEARTBEAT: {
			// Server requested an immediate heartbeat (out-of-band).
			sendHb = true;
			break;
		}
		case OP_HEARTBEAT_ACK: {
			state.gatewayLastHeartbeatAckAt = now;
			break;
		}
		case OP_RECONNECT: {
			reconnect = true;
			break;
		}
		case OP_INVALID_SESSION: {
			// Always treat as non-resumable — we never resume sessions.
			reconnect = true;
			break;
		}
		case OP_DISPATCH: {
			if (typeof frame.s === "number") state.gatewayLastSeq = frame.s;
			if (frame.t === "READY") {
				state.gatewayIdentified = true;
				state.gatewayReconnectAttempts = 0;
				state.botUserId = frame.d?.user?.id ?? state.botUserId;
			}
			break;
		}
		default: {
			// Ignore any other opcodes (HEARTBEAT_ACK handled above, etc.).
			break;
		}
	}
	return { sendIdentify, sendHeartbeat: sendHb, reconnect };
}

/** Is this close code fatal (stop retrying)? Pure. */
export function shouldReconnectOnClose(code: number | undefined): boolean {
	if (code === undefined) return true;
	if (GATEWAY_FATAL_CLOSE_CODES.has(code)) return false;
	return true;
}

/** Close and detach an active WS connection without triggering reconnect. */
function closeGateway(state: Record<string, any>, code = 1000, reason = ""): void {
	const ws = state.gatewayWs as GatewayWS | null;
	state.gatewayConnected = false;
	state.gatewayIdentified = false;
	if (ws) {
		// Detach handlers first so the close doesn't trigger our reconnect path.
		ws.onopen = null;
		ws.onmessage = null;
		ws.onclose = null;
		ws.onerror = null;
		try { ws.close(code, reason); } catch { /* best-effort */ }
	}
	state.gatewayWs = null;
	state.gatewayHeartbeatMs = null;
}

/**
 * Open a new Gateway connection. Safe to call when a connection is already
 * open — the old one is closed first. All handlers and state updates live
 * here; tick logic drives heartbeats and reconnects.
 */
function openGateway(state: Record<string, any>, ctx: ProgramContext): void {
	if (state.gatewayFatal) return; // stopped after fatal close
	if (state.gatewayWs) closeGateway(state);
	const token = process.env.DISCORD_BOT_TOKEN;
	if (!token) return;

	let ws: GatewayWS;
	try {
		ws = new (gatewayWSCtor())(GATEWAY_URL);
	} catch (err: any) {
		ctx.print(dim(`  [discord] gateway connect failed: ${err?.message ?? String(err)}`));
		scheduleGatewayReconnect(state);
		return;
	}

	state.gatewayWs = ws;
	state.gatewayConnected = false;
	state.gatewayIdentified = false;
	state.gatewayLastHeartbeatSentAt = 0;
	state.gatewayLastHeartbeatAckAt = 0;
	state.gatewayLastSeq = null;

	ws.onopen = () => { state.gatewayConnected = true; };

	ws.onmessage = (ev: { data: string }) => {
		let frame: GatewayFrame;
		try { frame = JSON.parse(ev.data); }
		catch { return; } // ignore malformed
		const now = Date.now();
		const wasIdentified = state.gatewayIdentified;
		const actions = handleGatewayFrame(state, frame, now);
		if (!wasIdentified && state.gatewayIdentified) {
			ctx.print(green(`  [discord] gateway connected — presence online`));
		}
		if (actions.sendIdentify) {
			ws.send(JSON.stringify(buildIdentifyPayload(token)));
		}
		if (actions.sendHeartbeat) {
			sendHeartbeat(state, ws, now);
		}
		if (actions.reconnect) {
			closeGateway(state, 1000);
			scheduleGatewayReconnect(state);
		}
	};

	ws.onclose = (ev: { code: number; reason: string }) => {
		state.gatewayConnected = false;
		state.gatewayIdentified = false;
		state.gatewayWs = null;
		if (!shouldReconnectOnClose(ev.code)) {
			state.gatewayFatal = true;
			ctx.print(red(`  [discord] gateway closed fatally (code=${ev.code}): ${ev.reason || "bot will stay offline"}`));
			return;
		}
		scheduleGatewayReconnect(state);
	};

	ws.onerror = () => {
		// Errors are followed by a close — let onclose handle reconnect.
	};
}

function scheduleGatewayReconnect(state: Record<string, any>): void {
	state.gatewayReconnectAttempts = (state.gatewayReconnectAttempts ?? 0) + 1;
	state.gatewayNextReconnectAt = Date.now() + computeReconnectDelayMs(state.gatewayReconnectAttempts);
}

/**
 * Called from onTick. Keeps the connection healthy:
 *   - reconnect if disconnected and backoff elapsed
 *   - fire a heartbeat if one is due
 *   - force-reconnect if we're in a zombie state (no ack in 2×interval)
 */
function tickGateway(state: Record<string, any>, ctx: ProgramContext): void {
	if (state.gatewayFatal) return;
	if (!process.env.DISCORD_BOT_TOKEN) return;
	const now = Date.now();

	if (!state.gatewayWs) {
		if (!state.gatewayNextReconnectAt || now >= state.gatewayNextReconnectAt) {
			openGateway(state, ctx);
		}
		return;
	}

	if (isHeartbeatAckOverdue(state, now)) {
		ctx.print(dim("  [discord] gateway heartbeat ack overdue — reconnecting"));
		closeGateway(state, 4000);
		scheduleGatewayReconnect(state);
		return;
	}

	if (shouldSendHeartbeat(state, now)) {
		const ws = state.gatewayWs as GatewayWS;
		try { sendHeartbeat(state, ws, now); }
		catch { /* close handler will reconnect */ }
	}
}


// ── Handler (CLI subcommands) ────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { resolveId, print } = ctx;
	const state = ctx.state;

	switch (cmd) {
		// /discord status
		case "status": {
			state.watermarks = state.watermarks ?? {};
			state.dmChannelByPeer = state.dmChannelByPeer ?? {};
			const watchedCount = Object.keys(state.watermarks).length;
			const cachedCount = Object.keys(state.dmChannelByPeer).length;
			const bridgeChannels = getBridgeChannels();
			print(bold("  Discord"));
			print(dim(`  bot user id: ${state.botUserId || "(not resolved yet)"}`));
			print(dim(`  gateway: ${state.gatewayConnected ? green("connected") : red("disconnected")}`));
			print(dim(`  DM channels cached: ${cachedCount}`));
			print(dim(`  watermarks tracked: ${watchedCount}`));
			if (bridgeChannels.length > 0) {
				print(dim(`  bridge channels: ${bridgeChannels.join(", ")}`));
				print(dim(`  bridge ingest agents: ${BRIDGE_INGEST_AGENTS ? "yes" : "no"}`));
			}
			break;
		}

		// /discord send <peerId> <text...>
		case "send": {
			const raw = args[0];
			const text = args.slice(1).join(" ");
			if (!raw || !text) { print(red("Usage: /discord send <peerId> <text...>")); break; }
			const peerId = await resolveId(raw) ?? raw;
			try {
				const r = await doSend(peerId, text, state, ctx);
				print(green(`  sent ${r.message_ids.length} message(s)`) + dim(` to channel ${r.channel_id}`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /discord poll — manually trigger a poll cycle (for debugging)
		case "poll": {
			try {
				const r = await runPoll(state, ctx);
				print(dim(`  polled ${r.peers} peer(s), processed ${r.processed} message(s)`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Discord") + dim(" — inbound/outbound bridge"),
				`    ${cyan("discord status")}                          show bridge state`,
				`    ${cyan("discord send")} ${dim("<peerId> <text...>")}      send a DM`,
				`    ${cyan("discord poll")}                            trigger a poll cycle now`,
				"",
				dim("  Requires DISCORD_BOT_TOKEN env var. Peers must have discord_id set."),
				dim("  Actor polls every 3s automatically; this CLI is for diagnostics."),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API + tick loop) ─────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({
		botUserId: "",
		dmChannelByPeer: {} as Record<string, string>,
		watermarks: {} as Record<string, string>,
		pollMs: DEFAULT_POLL_MS,
		tickInProgress: false,
		// Gateway (presence) state — managed by openGateway/tickGateway.
		gatewayWs: null as GatewayWS | null,
		gatewayConnected: false,
		gatewayIdentified: false,
		gatewayHeartbeatMs: null as number | null,
		gatewayLastSeq: null as number | null,
		gatewayLastHeartbeatSentAt: 0,
		gatewayLastHeartbeatAckAt: 0,
		gatewayReconnectAttempts: 0,
		gatewayNextReconnectAt: 0,
		gatewayFatal: false,
	}),

	onCreate: async (ctx: ProgramContext) => {
		if (!process.env.DISCORD_BOT_TOKEN) return;
		// Rehydrate watermarks + DM channel cache before the first tick so a
		// daemon restart does not re-ingest messages we already answered.
		await restorePersistedState(ctx.state, ctx);
		// Warm up the bot user id on startup (non-fatal if it fails — tick retries).
		try {
			await getBotUserId(ctx.state);
		} catch {
			// Log handled in tick loop.
		}
		// Open the Gateway connection so the bot appears online. Non-blocking:
		// the WebSocket handshake and IDENTIFY happen on their own event loop.
		openGateway(ctx.state, ctx);
	},

	onDestroy: async (ctx: ProgramContext) => {
		closeGateway(ctx.state, 1000, "daemon shutdown");
	},

	tickMs: DEFAULT_POLL_MS,

	onTick: async (ctx: ProgramContext) => {
		if (!process.env.DISCORD_BOT_TOKEN) return;
		// Gateway maintenance runs on every tick, independent of the REST
		// poll guard. A stalled REST poll should never block presence.
		try { tickGateway(ctx.state, ctx); }
		catch (err: any) { ctx.print(dim(`  [discord] gateway tick error: ${err?.message ?? String(err)}`)); }

		if (ctx.state.tickInProgress) return;
		ctx.state.tickInProgress = true;
		try {
			await runPoll(ctx.state, ctx);
			await persistStateIfChanged(ctx.state, ctx);
		} catch (err: any) {
			// onTick errors are swallowed by runtime, but we log for diagnostics.
			ctx.print(dim(`  [discord] tick error: ${err?.message ?? String(err)}`));
		} finally {
			ctx.state.tickInProgress = false;
		}
	},

	actions: {
		/** Send a DM to a peer (by peer id). Exposed to the harness as a tool. */
		send: async (ctx: ProgramContext, input: string | { peer_id?: string; text?: string }) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			const peerId = args?.peer_id;
			const text = args?.text;
			if (!peerId || !text) throw new Error("discord.send: peer_id and text required");
			return await doSend(peerId, text, ctx.state, ctx);
		},

		/** Post to a specific channel id. */
		sendChannel: async (_ctx: ProgramContext, input: string | { channel_id?: string; text?: string }) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			const channelId = args?.channel_id;
			const text = args?.text;
			if (!channelId || !text) throw new Error("discord.sendChannel: channel_id and text required");
			return await doSendChannel(channelId, text);
		},

		/** Send a typing indicator to a peer's DM channel. */
		typing: async (ctx: ProgramContext, input: string | { peer_id?: string }) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			const peerId = args?.peer_id;
			if (!peerId) throw new Error("discord.typing: peer_id required");
			return await doTyping(peerId, ctx.state, ctx);
		},

		/**
		 * Trigger a poll cycle now. Respects the same `tickInProgress` guard as
		 * the auto-tick so an external dispatch cannot race a running tick and
		 * re-ingest the same message.
		 */
		poll: async (ctx: ProgramContext) => {
			if (!process.env.DISCORD_BOT_TOKEN) return { peers: 0, processed: 0, skipped: "no-token" as const };
			if (ctx.state.tickInProgress) return { peers: 0, processed: 0, skipped: "tick-in-progress" as const };
			ctx.state.tickInProgress = true;
			try {
				const result = await runPoll(ctx.state, ctx);
				await persistStateIfChanged(ctx.state, ctx);
				return result;
			} finally {
				ctx.state.tickInProgress = false;
			}
		},

		/** Idempotently ensure the A2A category exists in GLON_A2A_DISCORD_GUILD. */
		ensurePairCategory: async (ctx: ProgramContext) => {
			return await doEnsurePairCategory(ctx.state);
		},

		/** Idempotently ensure a pair channel exists for two agent UUIDs.
		 *  Channel name is deterministic: pair-<short_lo>-<short_hi> so both
		 *  sides converge. */
		ensurePairChannel: async (ctx: ProgramContext, input: string | EnsurePairChannelInput) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doEnsurePairChannel(ctx.state, args);
		},

		/** Idempotently ensure a Discord thread exists inside a pair channel
		 *  to host one goal-driven conversation. The thread name == the goal.
		 *  Returns the thread id (used by peer-chat as conversation_id). */
		ensureConversationThread: async (_ctx: ProgramContext, input: string | EnsureThreadInput) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doEnsureConversationThread(args);
		},

		/** Post a glon-msg envelope into a conversation thread. */
		postToThread: async (_ctx: ProgramContext, input: string | PostToThreadInput) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doPostToThread(args);
		},

		/** List threads (active by default; pass include_archived for paused ones too). */
		listConversationThreads: async (_ctx: ProgramContext, input: string | ListConversationThreadsInput) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doListConversationThreads(args);
		},

		/** Fetch parsed envelopes from a thread. */
		listThreadMessages: async (_ctx: ProgramContext, input: string | ListThreadMessagesInput) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doListThreadMessages(args);
		},

		/** Archive (+ optionally lock) a thread — peer-chat uses this for
		 *  peer_conversation_done. Locked threads reject new messages. */
		archiveThread: async (_ctx: ProgramContext, input: string | ArchiveThreadInput) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doArchiveThread(args);
		},

		/** Unarchive and unlock a thread — peer-chat uses this for
		 *  peer_conversation_resume. */
		unarchiveThread: async (_ctx: ProgramContext, input: string | { thread_id: string }) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doUnarchiveThread(args);
		},

		/** Enumerate pair channels under the A2A category with parsed
		 *  participant agent_uuids from each channel's topic. */
		listPairChannels: async (ctx: ProgramContext) => {
			return await doListPairChannels(ctx.state);
		},

		/** Force an A2A poll cycle. Useful for tests that don't want to wait
		 *  for the tick. */
		pollA2A: async (ctx: ProgramContext) => {
			return { processed: await pollA2AGuild(ctx.state, ctx) };
		},

		/** Idempotently ensure the #roster forum channel exists with the
		 *  online/offline tags. Returns the forum's id and tag ids. */
		ensureRosterForum: async (ctx: ProgramContext) => {
			return await doEnsureRosterForum(ctx.state);
		},

		/** Create or edit-in-place an agent's roster post (forum starter
		 *  message). Used by /holdfast bootstrap and the heartbeat tick.
		 *  Stores the resulting thread_id on the daemon's state so
		 *  subsequent calls can edit instead of duplicate. */
		ensureRosterPost: async (ctx: ProgramContext, input: string | EnsureRosterPostInput) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doEnsureRosterPost(ctx.state, args);
		},

		/** Rewrite an existing roster post's starter message + tag. */
		editRosterCard: async (ctx: ProgramContext, input: string | EditRosterCardInput) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			// Resolve tag set if caller didn't supply one.
			if (!args.forum_tags) {
				const forum = await doEnsureRosterForum(ctx.state);
				args.forum_tags = forum.tags;
			}
			return await doEditRosterCard(args);
		},

		/** Mark an agent offline: flip its tag to ⚫ offline and archive
		 *  the forum post. Discord auto-archives idle posts on its own
		 *  (default 24h), so this is for explicit/graceful offline. */
		archiveRosterPost: async (ctx: ProgramContext, input: string | ArchiveRosterPostInput) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doArchiveRosterPost(ctx.state, args);
		},

		/** Enumerate roster forum posts (active by default; include_archived
		 *  for offline/stale ones too). Returns each post's parsed card. */
		listRosterPosts: async (ctx: ProgramContext, input: string | { include_archived?: boolean }) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doListRosterPosts(ctx.state, args ?? {});
		},

		/** Force a roster heartbeat cycle now (bypasses the throttle). */
		heartbeatRoster: async (ctx: ProgramContext) => {
			ctx.state.rosterNextHeartbeatAt = 0;
			await maybeHeartbeatRoster(ctx.state, ctx);
			return { ok: true };
		},

		/** Find agents with multiple roster posts (e.g. from pre-fix daemon
		 *  restarts that didn't reuse existing posts) and delete all but the
		 *  most recently updated. Idempotent — no-op once each agent has one. */
		pruneDuplicateRosterPosts: async (ctx: ProgramContext) => {
			return await doPruneDuplicateRosterPosts(ctx.state);
		},

		/** Force a roster-chat poll cycle. Useful for tests/manual triggers
		 *  that don't want to wait for the 3s tick. */
		pollRosterChat: async (ctx: ProgramContext) => {
			return { processed: await pollRosterForumThreads(ctx.state, ctx) };
		},

		/** Post a message into a roster thread (the agent's chat room with
		 *  humans). Used by agents when relaying a delegated A2A answer
		 *  back to the human who originally asked. Takes a thread_id and
		 *  text; optionally accepts a label that prepends "**<label>:** "
		 *  for visual clarity. Splits long content across messages per
		 *  Discord's 2000-char limit. */
		rosterChatReply: async (_ctx: ProgramContext, input: string | { thread_id: string; text: string; label?: string }) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			if (!args?.thread_id) throw new Error("rosterChatReply: thread_id required");
			if (!args?.text) throw new Error("rosterChatReply: text required");
			const label = args.label ? String(args.label).trim() : null;
			const formatted = label ? `**${label}:** ${String(args.text)}` : String(args.text);
			const ids = await postMessage(String(args.thread_id), formatted);
			return { thread_id: String(args.thread_id), message_ids: ids };
		},

		/** Flip the roster forum's permission overrides from private to
		 *  public — anyone in the guild can view + reply in existing agent
		 *  threads. The bot still owns thread creation; humans can't
		 *  fabricate fake agent cards. Idempotent. */
		makeRosterPublic: async (ctx: ProgramContext) => {
			const guildId = a2aGuildId();
			const botUserId = await getBotUserId(ctx.state);
			const forum = await doEnsureRosterForum(ctx.state);
			const overwrites = buildPublicRosterOverwrites(guildId, botUserId);
			await discord("PATCH", `/channels/${forum.forum_channel_id}`, { permission_overwrites: overwrites });
			ctx.state.rosterForumByGuild = {};
			return { ok: true, forum_channel_id: forum.forum_channel_id };
		},

		/** Retrofit existing A2A category + pair channels + roster forum with
		 *  private permission overwrites (deny @everyone view, allow the bot
		 *  + any GLON_A2A_DISCORD_OPERATOR_IDS). New channels created after
		 *  this code already include the overrides at creation time; this
		 *  action exists for channels that pre-date the operator-id work or
		 *  for refreshing perms after env config changes. Idempotent. */
		makePrivateA2A: async (ctx: ProgramContext) => {
			const guildId = a2aGuildId();
			const botUserId = await getBotUserId(ctx.state);
			const overwrites = buildPrivateA2AOverwrites(guildId, botUserId);
			const cat = await doEnsurePairCategory(ctx.state);

			const updated: string[] = [];
			// Category first
			await discord("PATCH", `/channels/${cat.category_id}`, { permission_overwrites: overwrites });
			updated.push(`category ${cat.category_id}`);

			// Then every channel under it: pair channels (text) + roster (forum)
			const channels = await listGuildChannels(guildId);
			const children = channels.filter((c) =>
				c.parent_id === cat.category_id
				&& (
					(c.type === DISCORD_CHANNEL_TYPE_TEXT && c.name.startsWith("pair-"))
					|| c.type === DISCORD_CHANNEL_TYPE_FORUM
				),
			);
			for (const ch of children) {
				try {
					await discord("PATCH", `/channels/${ch.id}`, { permission_overwrites: overwrites });
					updated.push(`${ch.name} (${ch.id})`);
				} catch (err: any) {
					ctx.print(dim(`  [discord] makePrivateA2A: failed to update ${ch.name}: ${err?.message ?? String(err)}`));
				}
			}
			// Invalidate caches so subsequent polls re-list with fresh perms.
			state_invalidateChannelCache(ctx.state);
			ctx.state.rosterForumByGuild = {};
			return { updated, total: updated.length };
		},
	},
};

function state_invalidateChannelCache(state: Record<string, any>): void {
	state.a2aChannelsCache = undefined;
	state.a2aChannelsCachedAt = 0;
}

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	splitMessage,
	doSend,
	doSendChannel,
	doTyping,
	runPoll,
	pollPeer,
	buildIdentifyPayload,
	computeReconnectDelayMs,
	shouldSendHeartbeat,
	isHeartbeatAckOverdue,
	shouldReconnectOnClose,
	handleGatewayFrame,
	openGateway,
	tickGateway,
	closeGateway,
	restorePersistedState,
	persistStateIfChanged,
	snapshotPersistedState,
	PERSISTED_STATE_FIELD,
	FIRST_POLL_RECENCY_MS,
};

// silence unused-warning for helpers we export only via __test
void yellow;
