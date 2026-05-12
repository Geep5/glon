// directory — Glon peer presence + first-contact handshake over Hyperswarm.
//
// Two jobs:
//
//   1. Announce loop. Every DIRECTORY_ANNOUNCE_INTERVAL_S, broadcast a
//      `glon/peer-announce` envelope to the well-known directory topic
//      that every Glon joins on startup. Receivers upsert the sender as
//      a "discovered" peer in /peer; TTL prunes stale entries.
//
//   2. Peer-request handshake. When the user clicks "peer with Alice" in
//      the UI, this program sends a unicast `glon/peer-request` to her
//      hyperswarm pubkey. Alice's daemon surfaces "Bob wants to peer,
//      accept?" via /user-chat. On accept she replies `glon/peer-accept`;
//      on decline (or 10-min timeout) she replies `glon/peer-decline`.
//      Both sides flip their /peer record to trusted on accept and then
//      use /transport-hyperswarm for ongoing comms.
//
// Identity model in v1: we authenticate peers by their Hyperswarm Noise
// pubkey only — that's what the swarm guarantees at the channel level.
// The wallet's Ed25519 identity pubkey is *claimed* inside announces but
// not separately signed at this layer; it gets verified at trade time
// when actual signed Changes show up. A misbehaving peer can claim any
// Ed25519 pubkey but can't produce signed Changes for keys they don't
// hold, so the worst case is a "phished peer-with" that goes nowhere.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { registerActorContentHandler } from "../runtime.js";
import { dim, bold, cyan, green, red, yellow } from "../shared.js";
import {
	isReady as swarmIsReady,
	getHyperswarmPublicKeyHex,
	directoryTopic,
	statusSnapshot,
} from "../../swarm-host.js";

// ── Constants ────────────────────────────────────────────────────

export const PEER_ANNOUNCE_CONTENT_TYPE = "glon/peer-announce";
export const PEER_REQUEST_CONTENT_TYPE = "glon/peer-request";
export const PEER_ACCEPT_CONTENT_TYPE = "glon/peer-accept";
export const PEER_DECLINE_CONTENT_TYPE = "glon/peer-decline";

const DEFAULT_ANNOUNCE_INTERVAL_S = 60;
const DEFAULT_PRESENCE_TTL_S = 300;
const DEFAULT_PEER_REQUEST_APPROVAL_TIMEOUT_S = 600; // 10 min
const TICK_MS = 30_000;

const PERSISTED_STATE_FIELD = "persisted_state";

// ── Types ────────────────────────────────────────────────────────

export interface DiscoveredPeer {
	identity_pubkey: string;       // claimed (not cryptographically verified at this layer in v1)
	hyperswarm_pubkey: string;     // network identity, verified by Noise channel
	agent_name: string;
	capabilities: string[];
	first_seen: number;
	last_seen: number;
	peer_object_id?: string;       // local /peer record id, populated on upsert
	agents?: Array<{ id: string; name: string }>;  // from PeerAnnounceBody.agents
}

export type RequestStatus = "waiting" | "accepted" | "declined" | "timed_out";
export interface PendingRequest {
	request_id: string;
	direction: "outgoing" | "incoming";
	peer_identity_pubkey: string;
	peer_hyperswarm_pubkey: string;
	peer_agent_name: string;
	message?: string;
	created_at: number;
	approval_deadline: number;
	status: RequestStatus;
	decline_reason?: "declined" | "approval_timeout";
}

interface PersistedDirectoryState {
	discovered: Record<string, DiscoveredPeer>;
	requests: Record<string, PendingRequest>;
}

interface BlobMeta {
	fromEndpoint?: string;
	receivedAt?: number;
	transportMetadata?: Record<string, string>;
}

// ── Config helpers ───────────────────────────────────────────────

function announceIntervalS(): number {
	const raw = process.env.DIRECTORY_ANNOUNCE_INTERVAL_S;
	if (!raw) return DEFAULT_ANNOUNCE_INTERVAL_S;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n >= 5 ? n : DEFAULT_ANNOUNCE_INTERVAL_S;
}
function presenceTtlS(): number {
	const raw = process.env.DIRECTORY_PRESENCE_TTL_S;
	if (!raw) return DEFAULT_PRESENCE_TTL_S;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n >= 30 ? n : DEFAULT_PRESENCE_TTL_S;
}
function peerRequestApprovalTimeoutS(): number {
	const raw = process.env.PEER_REQUEST_APPROVAL_TIMEOUT_S;
	if (!raw) return DEFAULT_PEER_REQUEST_APPROVAL_TIMEOUT_S;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n >= 30 ? n : DEFAULT_PEER_REQUEST_APPROVAL_TIMEOUT_S;
}

// ── Persistence (same pattern as /discord and /trade) ──────────

function snapshotState(state: Record<string, any>): string {
	return JSON.stringify({
		discovered: state.discovered ?? {},
		requests: state.requests ?? {},
	});
}

async function restoreState(state: Record<string, any>, ctx: ProgramContext) {
	if (!ctx.programId) return;
	try {
		const obj = await (ctx.store as any).get(ctx.programId);
		const field = obj?.fields?.[PERSISTED_STATE_FIELD];
		const raw = typeof field === "string" ? field : field?.stringValue;
		if (!raw) return;
		const parsed = JSON.parse(raw) as PersistedDirectoryState;
		if (parsed.discovered) state.discovered = parsed.discovered;
		if (parsed.requests) state.requests = parsed.requests;
		state._lastPersistedSnapshot = snapshotState(state);
	} catch (err: any) {
		ctx.print?.(dim(`  [directory] restore failed: ${err?.message ?? String(err)}`));
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
		ctx.print?.(dim(`  [directory] persist failed: ${err?.message ?? String(err)}`));
	}
}

// ── User notification (mirrors /trade's pattern) ────────────────

async function notifyUser(ctx: ProgramContext, text: string, urgency: "low" | "normal" | "high" = "normal") {
	try {
		await ctx.dispatchProgram("/user-chat", "notify", [{ text, urgency, source: "directory" }]);
	} catch {
		ctx.print?.(`[directory${urgency !== "normal" ? ` ${urgency}` : ""}] ${text}`);
	}
}

// ── Peer-object upsert via /peer ────────────────────────────────

async function upsertPeer(ctx: ProgramContext, opts: {
	identity_pubkey: string;
	hyperswarm_pubkey: string;
	agent_name: string;
	trust_level: "discovered" | "trusted";
	existing_peer_object_id?: string;
}): Promise<string | null> {
	try {
		// Index by identity_pubkey — the stable chain identity. Even if the
		// caller doesn't remember an existing peer_object_id (e.g. because
		// state.discovered hadn't been populated yet on a fresh restart),
		// /peer findOrCreate dedupes by the external key so we never create
		// a second row for the same identity.
		let peerId: string | null = opts.existing_peer_object_id ?? null;
		let createdNow = false;
		if (!peerId) {
			const found = await ctx.dispatchProgram("/peer", "findOrCreate", [{
				external_key: "identity_pubkey",
				external_value: opts.identity_pubkey,
				defaults: {
					display_name: opts.agent_name,
					kind: "agent",
					trust_level: opts.trust_level,
				},
			}]) as { id?: string; created?: boolean } | null;
			peerId = found?.id ?? null;
			createdNow = !!found?.created;
		}
		if (peerId) {
			await ctx.dispatchProgram("/peer", "setField", [peerId, "hyperswarm_pubkey", opts.hyperswarm_pubkey]);
			await ctx.dispatchProgram("/peer", "setField", [peerId, "last_seen", String(Date.now())]);
			// Promote-only: only call setTrust when we're upgrading to
			// "trusted". Never write "discovered" over an existing record —
			// that would silently downgrade trusted peers on every announce.
			if (!createdNow && opts.trust_level === "trusted") {
				await ctx.dispatchProgram("/peer", "setTrust", [peerId, "trusted"]);
			}
		}
		return peerId;
	} catch (err: any) {
		ctx.print?.(dim(`  [directory] peer upsert failed: ${err?.message ?? String(err)}`));
		return null;
	}
}

// ── Announce loop ────────────────────────────────────────────────

/**
 * On-wire shape of a peer-announce envelope payload.
 *
 * Forward-compat rules:
 *   - protocol_version is set by every sender, read by every receiver.
 *     v1 receivers MUST accept higher versions as long as the required
 *     v1 fields are present (additive evolution).
 *   - Receivers MUST tolerate unknown fields — JSON.parse drops them in,
 *     don't strip them on re-encode if you ever do.
 *   - To make a BREAKING change (e.g. signed announces, schema diff),
 *     bump protocol_version and ship parallel handling for the duration
 *     of the migration. NEVER reuse an old field name with new semantics.
 */
const ANNOUNCE_PROTOCOL_VERSION = 1;

/** Lightweight agent roster entry — one per /agent object the sender hosts. */
export interface AnnouncedAgent {
	id: string;
	name: string;
}

interface PeerAnnounceBody {
	protocol_version?: number;          // optional only for back-compat reads of pre-v1 announces.
	identity_pubkey: string;
	hyperswarm_pubkey: string;
	agent_name: string;
	capabilities: string[];
	announced_at: number;
	// New in this protocol_version (still v1 — additive). Pre-v1 receivers
	// just ignore it. The roster lets remote UIs render specific agents
	// orbiting the peer's sun and address chat envelopes to individual
	// agents (once from_subentity_id / to_subentity_id are wired into
	// peer-chat envelopes).
	agents?: AnnouncedAgent[];
}

async function resolveSelfIdentity(ctx: ProgramContext): Promise<{ identity_pubkey: string; agent_name: string; agents: AnnouncedAgent[] }> {
	// Wallet's default key is treated as this daemon's chain identity.
	let identity_pubkey = "";
	try {
		const info = await ctx.dispatchProgram("/wallet", "show", ["default"]) as { pubkey?: string } | null;
		identity_pubkey = info?.pubkey ?? "";
	} catch { /* no wallet, no key */ }
	// Walk the DAG's agent objects once: gives us both the "first agent"
	// for the legacy agent_name field AND the full roster for the new
	// `agents` array on the announce body.
	let agent_name = "glon";
	const agents: AnnouncedAgent[] = [];
	try {
		const result = await ctx.dispatchProgram("/crud", "list", ["agent"]) as { objects?: Array<{ id: string; typeKey?: string; name?: string; deleted?: boolean }> } | null;
		const liveAgents = (result?.objects ?? [])
			.filter((o) => o?.typeKey === "agent" && !o.deleted && typeof o.name === "string" && o.name.length > 0)
			.sort((a, b) => String(a.id).localeCompare(String(b.id)));
		for (const a of liveAgents) agents.push({ id: a.id, name: a.name as string });
		if (agents.length > 0) agent_name = agents[0].name;
	} catch { /* no /crud, or empty DAG — keep fallback */ }
	return { identity_pubkey, agent_name, agents };
}

async function broadcastAnnounce(ctx: ProgramContext): Promise<{ sent: number; skipped: number } | null> {
	if (!swarmIsReady()) return null;
	const hyperswarm_pubkey = getHyperswarmPublicKeyHex();
	const { identity_pubkey, agent_name, agents } = await resolveSelfIdentity(ctx);
	const body: PeerAnnounceBody = {
		protocol_version: ANNOUNCE_PROTOCOL_VERSION,
		identity_pubkey,
		hyperswarm_pubkey,
		agent_name,
		capabilities: ["trade", "swap"],
		announced_at: Date.now(),
		agents,                            // remote glons render these as orbiters of this peer's sun
	};
	const payload_b64 = Buffer.from(JSON.stringify(body)).toString("base64");
	const topicHex = directoryTopic().toString("hex");
	try {
		const r = await ctx.dispatchProgram("/transport-hyperswarm", "broadcast", [{
			topic: topicHex,
			payload_b64,
			content_type: PEER_ANNOUNCE_CONTENT_TYPE,
			metadata: {},
		}]) as { sent: number; skipped: number };
		return r;
	} catch (err: any) {
		ctx.print?.(dim(`  [directory] broadcast failed: ${err?.message ?? String(err)}`));
		return null;
	}
}

// ── Incoming envelope handlers ──────────────────────────────────

async function handleAnnounce(ctx: ProgramContext, envelope: { payload: Uint8Array; metadata: Record<string, string> }, _blob: BlobMeta) {
	let body: PeerAnnounceBody;
	try { body = JSON.parse(new TextDecoder().decode(envelope.payload)); }
	catch { return false; }
	if (!body.hyperswarm_pubkey) return false;
	// Ignore our own announces.
	if (swarmIsReady() && body.hyperswarm_pubkey === getHyperswarmPublicKeyHex()) return true;
	// Forward-compat: accept higher protocol_versions as long as the
	// required v1 fields parsed. Log once per session so we notice if a
	// peer is on a newer schema and we should consider upgrading.
	if (typeof body.protocol_version === "number" && body.protocol_version > ANNOUNCE_PROTOCOL_VERSION) {
		const state = ctx.state;
		if (!state._sawHigherProtocolVersion) {
			ctx.print?.(dim(`[directory] peer announced protocol_version=${body.protocol_version} (we're on ${ANNOUNCE_PROTOCOL_VERSION}). Parsing as v1.`));
			state._sawHigherProtocolVersion = body.protocol_version;
		}
	}

	const idKey = body.identity_pubkey || body.hyperswarm_pubkey; // key by identity if known, else hyperswarm
	const state = ctx.state;
	state.discovered = state.discovered ?? {};
	const existing = state.discovered[idKey] as DiscoveredPeer | undefined;
	const merged: DiscoveredPeer = {
		identity_pubkey: body.identity_pubkey || "",
		hyperswarm_pubkey: body.hyperswarm_pubkey,
		agent_name: body.agent_name || "(unnamed)",
		capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
		first_seen: existing?.first_seen ?? Date.now(),
		last_seen: Date.now(),
		peer_object_id: existing?.peer_object_id,
		agents: Array.isArray(body.agents)
			? body.agents
				.filter((a) => a && typeof a.id === "string" && typeof a.name === "string")
				.slice(0, 32)
				.map((a) => ({ id: a.id, name: a.name }))
			: existing?.agents,        // preserve prior roster if this announce has none (pre-v1 sender)
	};
	state.discovered[idKey] = merged;

	// Upsert /peer with trust_level=discovered (or refresh last_seen if
	// already known). Don't downgrade trusted peers.
	if (body.identity_pubkey) {
		const peerId = await upsertPeer(ctx, {
			identity_pubkey: body.identity_pubkey,
			hyperswarm_pubkey: body.hyperswarm_pubkey,
			agent_name: body.agent_name || "(unnamed)",
			trust_level: "discovered",
			existing_peer_object_id: merged.peer_object_id,
		});
		if (peerId) merged.peer_object_id = peerId;
		// Cache the peer's agent roster on their /peer record as a JSON
		// blob. Lets UIs render specific remote agents and address chats
		// to them. Forward-compat with pre-roster peers: missing/empty
		// stays missing/empty.
		if (peerId && Array.isArray(body.agents)) {
			try {
				const rosterJson = JSON.stringify(
					body.agents
						.filter((a) => a && typeof a.id === "string" && typeof a.name === "string")
						.slice(0, 32)            // cap at 32 to bound the field size
						.map((a) => ({ id: a.id, name: a.name })),
				);
				await ctx.dispatchProgram("/peer", "setField", [peerId, "agents_json", rosterJson]);
			} catch { /* peer field not whitelisted yet, or transient — non-fatal */ }
		}
	}
	await persistIfChanged(state, ctx);
	return true;
}

async function handlePeerRequest(ctx: ProgramContext, envelope: { payload: Uint8Array; metadata: Record<string, string> }, blob: BlobMeta) {
	let body: { request_id: string; identity_pubkey: string; hyperswarm_pubkey: string; agent_name: string; message?: string };
	try { body = JSON.parse(new TextDecoder().decode(envelope.payload)); }
	catch { return false; }
	if (!body.request_id || !body.hyperswarm_pubkey) return false;

	// Cross-check: the from_endpoint hyperswarm pubkey should match the
	// requester's claim. If not, ignore — somebody's trying to spoof.
	const fromHex = (blob.fromEndpoint ?? "").replace(/^swarm:\/\//, "").toLowerCase();
	if (fromHex && fromHex !== body.hyperswarm_pubkey.toLowerCase()) {
		ctx.print?.(dim(`  [directory] peer-request hyperswarm-pubkey mismatch (claim: ${body.hyperswarm_pubkey.slice(0, 12)}, from: ${fromHex.slice(0, 12)}) — ignoring`));
		return false;
	}

	const state = ctx.state;
	state.requests = state.requests ?? {};
	if (state.requests[body.request_id]) return true; // dedupe

	const req: PendingRequest = {
		request_id: body.request_id,
		direction: "incoming",
		peer_identity_pubkey: body.identity_pubkey || "",
		peer_hyperswarm_pubkey: body.hyperswarm_pubkey,
		peer_agent_name: body.agent_name || "(unnamed)",
		message: body.message,
		created_at: Date.now(),
		approval_deadline: Date.now() + peerRequestApprovalTimeoutS() * 1000,
		status: "waiting",
	};
	state.requests[body.request_id] = req;

	const minutes = Math.round(peerRequestApprovalTimeoutS() / 60);
	// Persist BEFORE notifying — if the daemon crashes between the two,
	// at least we'll surface the request on next startup. The /user-chat
	// notify may also block; we don't want to lose the request behind it.
	await persistIfChanged(state, ctx);
	await notifyUser(
		ctx,
		[
			`Incoming peer request from ${req.peer_agent_name}`,
			`  identity: ${req.peer_identity_pubkey.slice(0, 16)}…`,
			`  hyperswarm: ${req.peer_hyperswarm_pubkey.slice(0, 16)}…`,
			req.message ? `  message: ${req.message}` : null,
			"",
			`Accept:  \`/directory accept ${req.request_id}\``,
			`Decline: \`/directory decline ${req.request_id}\``,
			`Auto-declines in ${minutes} min.`,
		].filter(Boolean).join("\n"),
		"high",
	);
	return true;
}

async function handlePeerAccept(ctx: ProgramContext, envelope: { payload: Uint8Array; metadata: Record<string, string> }, blob: BlobMeta) {
	let body: { request_id: string; identity_pubkey: string; hyperswarm_pubkey: string };
	try { body = JSON.parse(new TextDecoder().decode(envelope.payload)); }
	catch { return false; }

	const state = ctx.state;
	const req = (state.requests as Record<string, PendingRequest> | undefined)?.[body.request_id];
	if (!req || req.direction !== "outgoing" || req.status !== "waiting") return false;

	const fromHex = (blob.fromEndpoint ?? "").replace(/^swarm:\/\//, "").toLowerCase();
	if (fromHex && fromHex !== req.peer_hyperswarm_pubkey.toLowerCase()) return false;

	req.status = "accepted";
	state.requests[req.request_id] = req;

	// Flip /peer record to trusted.
	const existing = (state.discovered as Record<string, DiscoveredPeer> | undefined)?.[req.peer_identity_pubkey];
	await upsertPeer(ctx, {
		identity_pubkey: req.peer_identity_pubkey,
		hyperswarm_pubkey: req.peer_hyperswarm_pubkey,
		agent_name: req.peer_agent_name,
		trust_level: "trusted",
		existing_peer_object_id: existing?.peer_object_id,
	});

	await persistIfChanged(state, ctx);
	await notifyUser(ctx, `${req.peer_agent_name} accepted your peer request. You can now trade.`);
	return true;
}

async function handlePeerDecline(ctx: ProgramContext, envelope: { payload: Uint8Array; metadata: Record<string, string> }, blob: BlobMeta) {
	let body: { request_id: string; reason?: "declined" | "approval_timeout" };
	try { body = JSON.parse(new TextDecoder().decode(envelope.payload)); }
	catch { return false; }

	const state = ctx.state;
	const req = (state.requests as Record<string, PendingRequest> | undefined)?.[body.request_id];
	if (!req || req.status !== "waiting") return false;
	const fromHex = (blob.fromEndpoint ?? "").replace(/^swarm:\/\//, "").toLowerCase();
	if (fromHex && req.peer_hyperswarm_pubkey && fromHex !== req.peer_hyperswarm_pubkey.toLowerCase()) return false;

	req.status = "declined";
	req.decline_reason = body.reason ?? "declined";
	state.requests[req.request_id] = req;
	await persistIfChanged(state, ctx);
	const reasonText = req.decline_reason === "approval_timeout" ? " (no response in time)" : "";
	await notifyUser(ctx, `${req.peer_agent_name} declined your peer request${reasonText}.`);
	return true;
}

// ── User-facing actions ─────────────────────────────────────────

async function requestPeering(ctx: ProgramContext, input: { hyperswarm_pubkey?: string; identity_pubkey?: string; message?: string }): Promise<{ request_id: string }> {
	const state = ctx.state;
	state.discovered = state.discovered ?? {};
	state.requests = state.requests ?? {};

	let target: DiscoveredPeer | null = null;
	if (input.identity_pubkey) {
		target = (state.discovered[input.identity_pubkey] as DiscoveredPeer) ?? null;
	}
	if (!target && input.hyperswarm_pubkey) {
		for (const d of Object.values(state.discovered) as DiscoveredPeer[]) {
			if (d.hyperswarm_pubkey === input.hyperswarm_pubkey) { target = d; break; }
		}
	}
	if (!target) throw new Error("requestPeering: no discovered peer matches the input — wait for an announce or pass a discovered peer's identity_pubkey");

	const request_id = Buffer.from(ctx.randomUUID().replace(/-/g, ""), "hex").subarray(0, 8).toString("hex");
	const { identity_pubkey: myId, agent_name } = await resolveSelfIdentity(ctx);
	const body = {
		request_id,
		identity_pubkey: myId,
		hyperswarm_pubkey: swarmIsReady() ? getHyperswarmPublicKeyHex() : "",
		agent_name,
		message: input.message ?? "",
	};
	const payload_b64 = Buffer.from(JSON.stringify(body)).toString("base64");
	await ctx.dispatchProgram("/transport-hyperswarm", "send", [{
		endpoint: `swarm://${target.hyperswarm_pubkey}`,
		payload_b64,
		content_type: PEER_REQUEST_CONTENT_TYPE,
		metadata: { request_id },
	}]);

	state.requests[request_id] = {
		request_id,
		direction: "outgoing",
		peer_identity_pubkey: target.identity_pubkey,
		peer_hyperswarm_pubkey: target.hyperswarm_pubkey,
		peer_agent_name: target.agent_name,
		message: input.message,
		created_at: Date.now(),
		approval_deadline: Date.now() + peerRequestApprovalTimeoutS() * 1000,
		status: "waiting",
	};
	// Persist immediately — if the daemon restarts before doTick runs, the
	// pending outgoing request would otherwise be lost (and the receiver's
	// acceptance, when it arrives, would reference an unknown request_id).
	await persistIfChanged(state, ctx);
	return { request_id };
}

async function acceptRequest(ctx: ProgramContext, requestId: string): Promise<{ ok: true }> {
	const state = ctx.state;
	const req = (state.requests as Record<string, PendingRequest> | undefined)?.[requestId];
	if (!req) throw new Error(`unknown request: ${requestId}`);
	if (req.direction !== "incoming") throw new Error("acceptRequest: not an incoming request");
	if (req.status !== "waiting") throw new Error(`request is in state ${req.status}`);

	const { identity_pubkey: myId } = await resolveSelfIdentity(ctx);
	const body = {
		request_id: requestId,
		identity_pubkey: myId,
		hyperswarm_pubkey: swarmIsReady() ? getHyperswarmPublicKeyHex() : "",
	};
	const payload_b64 = Buffer.from(JSON.stringify(body)).toString("base64");
	await ctx.dispatchProgram("/transport-hyperswarm", "send", [{
		endpoint: `swarm://${req.peer_hyperswarm_pubkey}`,
		payload_b64,
		content_type: PEER_ACCEPT_CONTENT_TYPE,
		metadata: { request_id: requestId },
	}]);

	req.status = "accepted";
	state.requests[requestId] = req;
	const existing = (state.discovered as Record<string, DiscoveredPeer> | undefined)?.[req.peer_identity_pubkey];
	await upsertPeer(ctx, {
		identity_pubkey: req.peer_identity_pubkey,
		hyperswarm_pubkey: req.peer_hyperswarm_pubkey,
		agent_name: req.peer_agent_name,
		trust_level: "trusted",
		existing_peer_object_id: existing?.peer_object_id,
	});
	// Persist BEFORE notifying — losing the "accepted" status would leave
	// us showing a stale "waiting" pill while the counterparty thinks
	// we've already trusted them.
	await persistIfChanged(state, ctx);
	await notifyUser(ctx, `Peered with ${req.peer_agent_name}. You can now trade.`);
	return { ok: true };
}

async function declineRequest(ctx: ProgramContext, requestId: string, reason: "declined" | "approval_timeout" = "declined"): Promise<{ ok: true }> {
	const state = ctx.state;
	const req = (state.requests as Record<string, PendingRequest> | undefined)?.[requestId];
	if (!req) throw new Error(`unknown request: ${requestId}`);
	if (req.direction !== "incoming") throw new Error("declineRequest: not an incoming request");
	if (req.status !== "waiting") return { ok: true };

	const body = { request_id: requestId, reason };
	const payload_b64 = Buffer.from(JSON.stringify(body)).toString("base64");
	try {
		await ctx.dispatchProgram("/transport-hyperswarm", "send", [{
			endpoint: `swarm://${req.peer_hyperswarm_pubkey}`,
			payload_b64,
			content_type: PEER_DECLINE_CONTENT_TYPE,
			metadata: { request_id: requestId, reason },
		}]);
	} catch (err: any) {
		ctx.print?.(yellow(`[directory] decline send failed for ${requestId}: ${err?.message ?? String(err)}`));
	}
	req.status = "declined";
	req.decline_reason = reason;
	state.requests[requestId] = req;
	await persistIfChanged(state, ctx);
	return { ok: true };
}

// ── Tick watcher ────────────────────────────────────────────────

async function doTick(ctx: ProgramContext) {
	if (!swarmIsReady()) return;
	const state = ctx.state;
	const now = Date.now();

	// Ensure we're joined to the directory topic. Idempotent in
	// /transport-hyperswarm. Self-heals when the directory's onCreate
	// raced ahead of /transport-hyperswarm's load (the bootstrap loads
	// programs alphabetically, so /directory starts before /transport-*).
	if (!state._directoryTopicJoined) {
		const topicHex = directoryTopic().toString("hex");
		try {
			await ctx.dispatchProgram("/transport-hyperswarm", "joinTopic", [{ topic: topicHex }]);
			state._directoryTopicJoined = true;
			ctx.print?.(dim(`[directory] joined topic ${topicHex.slice(0, 16)}...`));
		} catch (err: any) {
			// Will retry on the next tick.
			ctx.print?.(dim(`[directory] joinTopic retry pending: ${err?.message ?? String(err)}`));
		}
	}

	// Announce ourselves.
	const lastAnnounce = state._lastAnnounceAt ?? 0;
	if (now - lastAnnounce >= announceIntervalS() * 1000) {
		await broadcastAnnounce(ctx);
		state._lastAnnounceAt = now;
	}

	// Prune stale discovered peers (don't touch ones already trusted in /peer).
	const ttlMs = presenceTtlS() * 1000;
	if (state.discovered) {
		for (const key of Object.keys(state.discovered)) {
			const d = state.discovered[key] as DiscoveredPeer;
			if (now - d.last_seen > ttlMs) delete state.discovered[key];
		}
	}

	// Auto-decline pending incoming requests past their deadline.
	if (state.requests) {
		for (const id of Object.keys(state.requests)) {
			const r = state.requests[id] as PendingRequest;
			if (r.status !== "waiting") continue;
			if (r.direction === "incoming" && now >= r.approval_deadline) {
				try { await declineRequest(ctx, id, "approval_timeout"); }
				catch (err: any) { ctx.print?.(dim(`  [directory] auto-decline failed for ${id}: ${err?.message ?? String(err)}`)); }
			}
			if (r.direction === "outgoing" && now >= r.approval_deadline) {
				r.status = "timed_out";
				r.decline_reason = "approval_timeout";
				state.requests[id] = r;
				await notifyUser(ctx, `Peer request to ${r.peer_agent_name} timed out (no response).`);
			}
		}
	}

	await persistIfChanged(state, ctx);
}

// ── CLI handler ─────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	if (cmd === "status") {
		if (!swarmIsReady()) {
			print(red("directory: swarm offline (start daemon with GLON_SWARM=1)"));
			return;
		}
		const snap = statusSnapshot();
		const state = ctx.state;
		print(bold("  directory"));
		print(dim(`    hyperswarm pubkey: ${snap.hyperswarm_pubkey.slice(0, 32)}...`));
		print(dim(`    discovered peers: ${Object.keys(state.discovered ?? {}).length}`));
		print(dim(`    pending requests: ${Object.values(state.requests ?? {}).filter((r: any) => r.status === "waiting").length}`));
		print(dim(`    last announce:    ${state._lastAnnounceAt ? new Date(state._lastAnnounceAt).toISOString() : "(never)"}`));
		return;
	}

	if (cmd === "list") {
		const state = ctx.state;
		const discovered = (state.discovered ?? {}) as Record<string, DiscoveredPeer>;
		const ids = Object.keys(discovered).sort((a, b) => discovered[b].last_seen - discovered[a].last_seen);
		if (ids.length === 0) { print(dim("(no discovered peers)")); return; }
		for (const id of ids) {
			const d = discovered[id];
			const age = Math.round((Date.now() - d.last_seen) / 1000);
			print(`  ${cyan(d.agent_name)}  ${dim(d.identity_pubkey.slice(0, 16) || d.hyperswarm_pubkey.slice(0, 16))}  ${dim(age + "s ago")}`);
		}
		return;
	}

	if (cmd === "announce") {
		try { const r = await broadcastAnnounce(ctx); print(green(`announce: sent=${r?.sent ?? 0} skipped=${r?.skipped ?? 0}`)); }
		catch (err: any) { print(red(`announce failed: ${err?.message ?? String(err)}`)); }
		return;
	}

	if (cmd === "requestPeering" || cmd === "peer") {
		const pubkey = args[0];
		const message = args.slice(1).join(" ");
		if (!pubkey) { print(red("Usage: /directory peer <identity-pubkey-or-hyperswarm-pubkey> [message...]")); return; }
		try {
			// Try identity first, fall back to hyperswarm.
			const r = await requestPeering(ctx, /^[0-9a-fA-F]{64}$/.test(pubkey) ? { hyperswarm_pubkey: pubkey, message } : { identity_pubkey: pubkey, message });
			print(green(`peer request sent: ${r.request_id}`));
		} catch (err: any) {
			print(red(`Error: ${err?.message ?? String(err)}`));
		}
		return;
	}

	if (cmd === "accept") {
		const id = args[0];
		if (!id) { print(red("Usage: /directory accept <request-id>")); return; }
		try { await acceptRequest(ctx, id); print(green(`accepted ${id}`)); }
		catch (err: any) { print(red(`Error: ${err?.message ?? String(err)}`)); }
		return;
	}

	if (cmd === "decline") {
		const id = args[0];
		if (!id) { print(red("Usage: /directory decline <request-id>")); return; }
		try { await declineRequest(ctx, id); print(green(`declined ${id}`)); }
		catch (err: any) { print(red(`Error: ${err?.message ?? String(err)}`)); }
		return;
	}

	if (cmd === "listRequests") {
		const reqs = (ctx.state.requests ?? {}) as Record<string, PendingRequest>;
		const ids = Object.keys(reqs).sort((a, b) => reqs[b].created_at - reqs[a].created_at);
		if (ids.length === 0) { print(dim("(no requests)")); return; }
		for (const id of ids) {
			const r = reqs[id];
			print(`  ${cyan(id)}  ${r.direction.padEnd(10)}  ${r.status.padEnd(12)}  ${dim(r.peer_agent_name)}`);
		}
		return;
	}

	print([
		bold("  directory") + dim(" — Glon peer discovery + handshake over Hyperswarm"),
		`    ${cyan("/directory status")}                        show network state`,
		`    ${cyan("/directory list")}                          list discovered peers`,
		`    ${cyan("/directory announce")}                      force a broadcast`,
		`    ${cyan("/directory peer")} ${dim("<pubkey> [msg]")}            send a peer request`,
		`    ${cyan("/directory accept")} ${dim("<request-id>")}            accept an incoming request`,
		`    ${cyan("/directory decline")} ${dim("<request-id>")}           decline an incoming request`,
		`    ${cyan("/directory listRequests")}                  list outgoing + incoming requests`,
	].join("\n"));
};

// ── Actor ───────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({ discovered: {}, requests: {}, _lastAnnounceAt: 0 }),
	onCreate: async (ctx) => {
		await restoreState(ctx.state, ctx);
		if (!swarmIsReady()) {
			ctx.print?.(yellow("[directory] swarm not ready; will join directory topic when GLON_SWARM=1 daemon brings it up"));
			return;
		}
		// Join the directory topic so we get other peers' announces.
		// If /transport-hyperswarm hasn't loaded yet (bootstrap loads
		// alphabetically so /directory starts first), the onTick watcher
		// retries every 30s.
		const topicHex = directoryTopic().toString("hex");
		try {
			await ctx.dispatchProgram("/transport-hyperswarm", "joinTopic", [{ topic: topicHex }]);
			ctx.state!._directoryTopicJoined = true;
			ctx.print?.(dim(`[directory] joined topic ${topicHex.slice(0, 16)}...`));
		} catch (err: any) {
			ctx.print?.(yellow(`[directory] joinTopic deferred to tick: ${err?.message ?? String(err)}`));
		}
	},
	tickMs: TICK_MS,
	onTick: async (ctx) => {
		try { await doTick(ctx); }
		catch (err: any) { ctx.print?.(dim(`[directory] tick error: ${err?.message ?? String(err)}`)); }
	},
	typedActions: {
		announce: { description: "Force a presence broadcast now.", inputSchema: { type: "object", properties: {} }, handler: async (ctx) => (await broadcastAnnounce(ctx)) ?? { sent: 0, skipped: 0 } },
		listDiscovered: { description: "Return discovered peers.", inputSchema: { type: "object", properties: {} }, handler: async (ctx) => Object.values(ctx.state.discovered ?? {}) },
		listRequests: { description: "Return pending peer requests.", inputSchema: { type: "object", properties: {} }, handler: async (ctx) => Object.values(ctx.state.requests ?? {}) },
		requestPeering: {
			description: "Send a glon/peer-request to a discovered peer.",
			inputSchema: { type: "object", properties: { hyperswarm_pubkey: { type: "string" }, identity_pubkey: { type: "string" }, message: { type: "string" } } },
			handler: async (ctx, input: { hyperswarm_pubkey?: string; identity_pubkey?: string; message?: string }) => requestPeering(ctx, input),
		},
		acceptRequest: { description: "Accept an incoming peer request.", inputSchema: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" } } }, handler: async (ctx, input: { request_id: string }) => acceptRequest(ctx, input.request_id) },
		declineRequest: { description: "Decline an incoming peer request.", inputSchema: { type: "object", required: ["request_id"], properties: { request_id: { type: "string" }, reason: { type: "string" } } }, handler: async (ctx, input: { request_id: string; reason?: "declined" | "approval_timeout" }) => declineRequest(ctx, input.request_id, input.reason ?? "declined") },
		status: {
			description: "Network state snapshot, including a `self` block so UIs can show 'you'.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => {
				const snap = statusSnapshot();
				const { identity_pubkey, agent_name } = await resolveSelfIdentity(ctx);
				const lastAnnounceAt = (ctx.state._lastAnnounceAt as number) ?? 0;
				const announceIntervalMs = announceIntervalS() * 1000;
				const isAnnouncing = swarmIsReady() && (Date.now() - lastAnnounceAt) < announceIntervalMs * 2;
				return {
					...snap,
					pending_requests: Object.values(ctx.state.requests ?? {}).filter((r: any) => r.status === "waiting").length,
					discovered_count: Object.keys(ctx.state.discovered ?? {}).length,
					self: {
						identity_pubkey,
						hyperswarm_pubkey: snap.hyperswarm_pubkey,
						agent_name,
						last_announce_at: lastAnnounceAt,
						is_announcing: isAnnouncing,
						announce_interval_s: announceIntervalS(),
					},
				};
			},
		},
		tick: { description: "Force the watcher tick.", inputSchema: { type: "object", properties: {} }, handler: async (ctx) => { await doTick(ctx); return { ok: true }; } },
		handleAnnounce: {
			description: "Process an incoming peer announce envelope.",
			inputSchema: { type: "object", required: ["envelope_b64"], properties: { envelope_b64: { type: "string" }, content_type: { type: "string" }, from: { type: "string" } } },
			handler: async (ctx, input: any) => {
				const payload = Buffer.from(input.envelope_b64, "base64");
				const envelope = { payload, metadata: {} };
				const blobMeta = { fromEndpoint: input.from };
				return await handleAnnounce(ctx, envelope, blobMeta);
			},
		},
		// The three handlers below MUST be dispatched through /directory's
		// actor (not invoked directly from /transport-router's ctx) so the
		// state mutation lands in /directory's state and persistIfChanged
		// writes to /directory's persisted field. Same trick as
		// handleAnnounce above — keep them parallel.
		handlePeerRequest: {
			description: "Process an incoming peer-request envelope.",
			inputSchema: { type: "object", required: ["envelope_b64"], properties: { envelope_b64: { type: "string" }, content_type: { type: "string" }, from: { type: "string" } } },
			handler: async (ctx, input: any) => {
				const payload = Buffer.from(input.envelope_b64, "base64");
				const envelope = { payload, metadata: {} };
				const blobMeta = { fromEndpoint: input.from };
				return await handlePeerRequest(ctx, envelope, blobMeta);
			},
		},
		handlePeerAccept: {
			description: "Process an incoming peer-accept envelope.",
			inputSchema: { type: "object", required: ["envelope_b64"], properties: { envelope_b64: { type: "string" }, content_type: { type: "string" }, from: { type: "string" } } },
			handler: async (ctx, input: any) => {
				const payload = Buffer.from(input.envelope_b64, "base64");
				const envelope = { payload, metadata: {} };
				const blobMeta = { fromEndpoint: input.from };
				return await handlePeerAccept(ctx, envelope, blobMeta);
			},
		},
		handlePeerDecline: {
			description: "Process an incoming peer-decline envelope.",
			inputSchema: { type: "object", required: ["envelope_b64"], properties: { envelope_b64: { type: "string" }, content_type: { type: "string" }, from: { type: "string" } } },
			handler: async (ctx, input: any) => {
				const payload = Buffer.from(input.envelope_b64, "base64");
				const envelope = { payload, metadata: {} };
				const blobMeta = { fromEndpoint: input.from };
				return await handlePeerDecline(ctx, envelope, blobMeta);
			},
		},
		cleanupPeerDuplicates: {
			description: "Consolidate duplicate /peer rows that share an identity_pubkey. Keeps one survivor per identity (preferring trusted > family > friend > discovered > stranger; ties broken by id alpha order) and soft-deletes the rest. Optionally pass {dryRun:true} to see what WOULD be removed without changing anything.",
			inputSchema: { type: "object", properties: { dryRun: { type: "boolean" } } },
			handler: async (ctx, input: { dryRun?: boolean } = {}) => {
				const dryRun = !!input?.dryRun;
				const all = await ctx.dispatchProgram("/peer", "list", [{}]) as any[];
				// Group by identity_pubkey; ignore peers that lack one (humans
				// added by hand may not have an identity yet).
				const byIdentity = new Map<string, any[]>();
				for (const p of all ?? []) {
					const id = p?.identity_pubkey;
					if (!id) continue;
					const arr = byIdentity.get(id) ?? [];
					arr.push(p);
					byIdentity.set(id, arr);
				}
				const TRUST_RANK: Record<string, number> = { self: 100, family: 80, friend: 60, trusted: 50, discovered: 30, stranger: 10 };
				const summary: Array<{ identity_pubkey: string; kept: string; kept_trust: string; removed: string[] }> = [];
				let removedCount = 0;
				for (const [idKey, group] of byIdentity) {
					if (group.length <= 1) continue;
					// Pick survivor: highest trust rank, then lex-smallest id.
					group.sort((a, b) => {
						const ra = TRUST_RANK[a.trust_level] ?? 0;
						const rb = TRUST_RANK[b.trust_level] ?? 0;
						if (ra !== rb) return rb - ra;
						return String(a.id).localeCompare(String(b.id));
					});
					const survivor = group[0];
					const losers = group.slice(1);
					summary.push({
						identity_pubkey: idKey,
						kept: survivor.id,
						kept_trust: survivor.trust_level,
						removed: losers.map((l) => l.id),
					});
					if (!dryRun) {
						for (const l of losers) {
							try { await ctx.dispatchProgram("/peer", "remove", [{ peer_id: l.id }]); removedCount++; }
							catch (err: any) { ctx.print?.(dim(`  [directory] cleanup remove failed for ${l.id}: ${err?.message ?? String(err)}`)); }
						}
					}
				}
				return {
					dryRun,
					duplicate_groups: summary.length,
					removed: dryRun ? summary.reduce((n, g) => n + g.removed.length, 0) : removedCount,
					groups: summary,
				};
			},
		},
	},
};

// ── Content handler registrations ───────────────────────────────
//
// All four envelopes route through /directory's actor (see the typed
// actions handleAnnounce / handlePeerRequest / handlePeerAccept /
// handlePeerDecline above). registerActorContentHandler is the only
// safe shape for handlers that mutate persisted state — it guarantees
// the action runs with /directory's `ctx.state` and `ctx.programId`
// instead of /transport-router's. Don't switch back to a raw
// registerContentHandler here without re-reading the regression in
// commit 5215330.

registerActorContentHandler(PEER_ANNOUNCE_CONTENT_TYPE, "/directory", "handleAnnounce");
registerActorContentHandler(PEER_REQUEST_CONTENT_TYPE,  "/directory", "handlePeerRequest");
registerActorContentHandler(PEER_ACCEPT_CONTENT_TYPE,   "/directory", "handlePeerAccept");
registerActorContentHandler(PEER_DECLINE_CONTENT_TYPE,  "/directory", "handlePeerDecline");

const program: ProgramDef = { handler, actor: actorDef };
export default program;

export const __test = {
	broadcastAnnounce,
	handleAnnounce,
	handlePeerRequest,
	handlePeerAccept,
	handlePeerDecline,
	requestPeering,
	acceptRequest,
	declineRequest,
	doTick,
	announceIntervalS,
	presenceTtlS,
	peerRequestApprovalTimeoutS,
	PEER_ANNOUNCE_CONTENT_TYPE,
	PEER_REQUEST_CONTENT_TYPE,
	PEER_ACCEPT_CONTENT_TYPE,
	PEER_DECLINE_CONTENT_TYPE,
};
