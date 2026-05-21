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

interface DiscordChannelSummary {
	id: string;
	name: string;
	type: number;
	parent_id?: string | null;
}

function a2aGuildId(): string {
	const g = process.env.GLON_A2A_DISCORD_GUILD;
	if (!g) throw new Error("GLON_A2A_DISCORD_GUILD not set — required for A2A channel ops");
	return g;
}

function a2aCategoryName(): string {
	return process.env.GLON_A2A_CATEGORY_NAME ?? A2A_CATEGORY_NAME_DEFAULT;
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

	const created = await discord("POST", `/guilds/${guildId}/channels`, {
		name: wantName,
		type: DISCORD_CHANNEL_TYPE_CATEGORY,
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
		return { channel_id: existing.id, name: existing.name, created: false, category_id: cat.category_id };
	}

	const created = await discord("POST", `/guilds/${guildId}/channels`, {
		name,
		type: DISCORD_CHANNEL_TYPE_TEXT,
		parent_id: cat.category_id,
		topic: `glon A2A channel · ${input.peer_a_agent_uuid.slice(0, 24)} ↔ ${input.peer_b_agent_uuid.slice(0, 24)}`,
	});
	if (!created?.id) throw new Error("Discord did not return a channel id when creating pair channel");
	state.a2aPairChannel[cacheKey] = created.id as string;
	return { channel_id: created.id as string, name: created.name as string, created: true, category_id: cat.category_id };
}

// ── A2A envelope wire format ─────────────────────────────────────
// Discord messages in pair channels carry a human-readable preamble
// (so the channel reads naturally) plus a fenced code block containing
// the machine-parsable JSON envelope. The fence tag distinguishes glon
// protocol messages from arbitrary human chatter that may live in the
// same channel.

const A2A_ENVELOPE_FENCE = "glon-msg";
const A2A_FENCE_RE = new RegExp("```\\s*" + A2A_ENVELOPE_FENCE + "\\s*\\n([\\s\\S]*?)\\n```", "i");
const A2A_POLL_BATCH = 25;

export interface A2AEnvelope {
	v: 1;
	msg_id: string;
	conversation_id: string;
	kind: "text" | "done";
	from_agent_uuid: string;
	from_display_name: string;
	to_agent_uuid: string;
	to_display_name: string;
	body: unknown;
	in_reply_to: string | null;
	sent_at: number;
	goal?: string;
}

export function formatA2AMessage(env: A2AEnvelope): string {
	const sender = env.from_display_name || env.from_agent_uuid.slice(0, 8) || "agent";
	const target = env.to_display_name || env.to_agent_uuid.slice(0, 8) || "agent";
	const convShort = (env.conversation_id || "").slice(0, 12);
	const goalSnippet = env.goal ? ` · "${String(env.goal).slice(0, 60)}"` : "";
	const bodyText = env.kind === "text" ? String(env.body ?? "") : `[${env.kind}]`;
	const bodyPreview = bodyText.length > 1500 ? bodyText.slice(0, 1500) + "…" : bodyText;
	const quoted = bodyPreview.split("\n").map((line) => `> ${line}`).join("\n");
	const preamble = `**${sender} → ${target}** · \`${convShort}\`${goalSnippet}\n${quoted}`;
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
		if (typeof parsed.msg_id !== "string" || typeof parsed.conversation_id !== "string") return null;
		return parsed as A2AEnvelope;
	} catch {
		return null;
	}
}

interface PostA2AInput {
	peer_a_agent_uuid: string;
	peer_b_agent_uuid: string;
	envelope: A2AEnvelope;
}

interface PostA2AResult {
	channel_id: string;
	channel_name: string;
	message_ids: string[];
}

async function doPostA2A(state: Record<string, any>, input: PostA2AInput): Promise<PostA2AResult> {
	if (!input?.envelope) throw new Error("discord.postA2A: envelope required");
	const ch = await doEnsurePairChannel(state, {
		peer_a_agent_uuid: input.peer_a_agent_uuid,
		peer_b_agent_uuid: input.peer_b_agent_uuid,
	});
	const body = formatA2AMessage(input.envelope);
	const message_ids = await postMessage(ch.channel_id, body);
	return { channel_id: ch.channel_id, channel_name: ch.name, message_ids };
}

/** Poll one A2A pair channel for new envelopes. Unlike pollBridgeChannel,
 *  the bot itself is the only Discord author — we still ingest every
 *  message but filter to those carrying a glon-msg fenced block. The
 *  recipient's daemon picks up envelopes addressed to its local agents;
 *  the sender's daemon naturally ignores its own outbound because
 *  to_agent_id will name the peer, not anyone local. */
async function pollA2APairChannel(channelId: string, state: Record<string, any>, ctx: ProgramContext): Promise<number> {
	state.a2aWatermarks = state.a2aWatermarks ?? {};
	const watermark = state.a2aWatermarks[channelId] as string | undefined;
	const isFirstPoll = !watermark;

	const qs = isFirstPoll ? `?limit=${A2A_POLL_BATCH}` : `?limit=${A2A_POLL_BATCH}&after=${watermark}`;
	const msgs = await discord("GET", `/channels/${channelId}/messages${qs}`) as DiscordMessage[] | null;
	if (!msgs || msgs.length === 0) {
		if (isFirstPoll) state.a2aWatermarks[channelId] = "0";
		return 0;
	}
	const sorted = [...msgs].sort((a, b) => a.id.localeCompare(b.id));
	const newest = sorted[sorted.length - 1].id;
	if (!watermark || newest > watermark) state.a2aWatermarks[channelId] = newest;

	const now = Date.now();
	const eligible = isFirstPoll
		? sorted.filter((m) => now - snowflakeTimestampMs(m.id) <= FIRST_POLL_RECENCY_MS)
		: sorted;

	let processed = 0;
	for (const m of eligible) {
		const env = parseA2AMessage(m.content ?? "");
		if (!env) continue;
		processed++;
		try {
			await ctx.dispatchProgram("/peer-chat", "handleA2A", [{
				envelope: env,
				channel_id: channelId,
				discord_message_id: m.id,
			}]);
		} catch (err: any) {
			ctx.print(dim(`  [discord] A2A dispatch failed (channel ${channelId}, msg ${m.id}): ${err?.message ?? String(err)}`));
		}
	}
	return processed;
}

// A2A poll cadence + caching:
// - pollA2AGuild is invoked from the actor tick (every 3s) but actually
//   touches Discord only every A2A_POLL_INTERVAL_MS (default 15s).
// - Channel listing is cached for A2A_CHANNEL_CACHE_TTL_MS so we don't
//   re-list every poll cycle — new pair channels still get noticed
//   when the cache expires, just not instantly.
// - On a 429, we honour the server's retry_after and skip A2A polls
//   until that deadline (plus a small buffer).
const A2A_POLL_INTERVAL_MS = Number(process.env.GLON_A2A_POLL_INTERVAL_MS ?? 15_000);
const A2A_CHANNEL_CACHE_TTL_MS = Number(process.env.GLON_A2A_CHANNEL_CACHE_TTL_MS ?? 60_000);

/** Enumerate pair channels under the A2A category and poll each. Throttled
 *  so we don't hammer Discord. Returns total envelopes processed (or 0 if
 *  we're skipping this cycle). */
async function pollA2AGuild(state: Record<string, any>, ctx: ProgramContext): Promise<number> {
	if (!process.env.GLON_A2A_DISCORD_GUILD) return 0;

	const now = Date.now();
	if (typeof state.a2aNextPollAt === "number" && now < state.a2aNextPollAt) {
		return 0; // throttled or rate-limited
	}
	// Schedule the next poll up front; on success we may extend it normally,
	// on 429 we extend by the retry_after instead.
	state.a2aNextPollAt = now + A2A_POLL_INTERVAL_MS;

	let total = 0;
	try {
		const cat = await doEnsurePairCategory(state);

		// Cache the pair-channel list so we don't list-channels every poll.
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

		for (const ch of pairChannels) {
			try {
				total += await pollA2APairChannel(ch.id, state, ctx);
			} catch (err: any) {
				if (err?.rateLimited) {
					const wait = Math.max(1, Number(err.retryAfter ?? 1));
					state.a2aNextPollAt = Date.now() + Math.round(wait * 1000) + 500;
					ctx.print(dim(`  [discord] A2A rate-limited; backing off ${wait.toFixed(1)}s`));
					return total;
				}
				ctx.print(dim(`  [discord] A2A poll error for ${ch.name}: ${err?.message ?? String(err)}`));
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
	return { peers: peers.length, processed, bridges, a2a };
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

		/** Post a glon-msg envelope into the pair channel for two identity
		 *  pubkeys. Creates the channel if absent. Used by /peer-chat to
		 *  push outbound A2A traffic onto Discord. */
		postA2A: async (ctx: ProgramContext, input: string | PostA2AInput) => {
			const args = typeof input === "string" ? JSON.parse(input) : input;
			return await doPostA2A(ctx.state, args);
		},

		/** Force an A2A poll cycle. Useful for tests that don't want to wait
		 *  for the tick. */
		pollA2A: async (ctx: ProgramContext) => {
			return { processed: await pollA2AGuild(ctx.state, ctx) };
		},
	},
};

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
