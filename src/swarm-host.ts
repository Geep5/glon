/**
 * swarm-host — daemon-side ownership of the single Hyperswarm instance.
 *
 * Why this module exists: bundled programs can't `require("hyperswarm")`
 * because hyperswarm pulls in `udx-native`, a native (.node) module that
 * esbuild can't bundle into a string-evaluated program. So the daemon
 * imports hyperswarm at the Node level, creates exactly one Hyperswarm
 * instance, and exposes a tiny API surface through `runtime.ts`'s
 * externals map so programs can use it.
 *
 * Programs that need swarm access import like:
 *
 *   import { sendToPeer, drainIncoming, getHyperswarmKeyPair }
 *     from "../swarm-host.js";
 *
 * The bundler resolves "swarm-host.js" to the singleton this module
 * exposes via getSingleton().
 *
 * Threading & state: everything lives on the Node event loop. The swarm's
 * `connection` event handler dumps parsed envelopes onto an incoming queue;
 * programs call drainIncoming() periodically to pull them off. Outbound is
 * synchronous-ish — sendToPeer awaits the connection event for the target
 * pubkey (joining the pair topic if needed), then writes.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// We never `import` hyperswarm at the top level because that triggers native
// module loading; instead we accept the instance via `initSwarm`.
// The types below are minimal structural duplicates of the bits we use,
// declared inline to avoid a hard compile-time dependency.
interface NoiseInfo {
	publicKey: Buffer;
	[k: string]: unknown;
}
interface HsConnection {
	readonly destroyed: boolean;
	write(data: Buffer): boolean;
	once(event: "close", fn: () => void): this;
	on(event: "data", fn: (chunk: Buffer) => void): this;
	on(event: "error", fn: (err: Error) => void): this;
	on(event: "close", fn: () => void): this;
	destroy(err?: Error): void;
}
interface HsDiscovery {
	flushed(): Promise<void>;
	destroy(): Promise<void>;
}
interface HsSwarm {
	keyPair: { publicKey: Buffer; secretKey: Buffer };
	connections: Iterable<HsConnection>;
	on(event: "connection", fn: (conn: HsConnection, info: NoiseInfo) => void): this;
	join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): HsDiscovery;
	leave(topic: Buffer): Promise<void>;
	flush(): Promise<void>;
	destroy(): Promise<void>;
}

// ── Configuration ────────────────────────────────────────────────

/** Where to persist the swarm's long-lived Noise keypair so identity
 *  survives daemon restarts. Defaults to `~/.glon/hyperswarm.key`. */
function keyPairPath(): string {
	return process.env.HYPERSWARM_KEYPAIR_FILE ?? join(homedir(), ".glon", "hyperswarm.key");
}

/** sha256(topicString) → 32-byte Buffer. Pure; tests can reproduce. */
export function topicFor(label: string): Buffer {
	return createHash("sha256").update(label).digest();
}

/** Directory topic — every Glon joins this on startup. Override with
 *  GLON_DIRECTORY_TOPIC (raw string fed to sha256). */
export function directoryTopic(): Buffer {
	return topicFor(process.env.GLON_DIRECTORY_TOPIC ?? "glon:network:v1");
}

/** Pair topic between two identity pubkeys (lexicographically sorted so
 *  both sides compute the same value). Inputs are hex strings of
 *  whatever identity space the caller is using (Ed25519 or Noise key —
 *  caller's choice). */
export function pairTopic(idA: string, idB: string): Buffer {
	const [a, b] = idA < idB ? [idA, idB] : [idB, idA];
	return topicFor(`glon:pair:v1:${a}:${b}`);
}

// ── Incoming queue ───────────────────────────────────────────────

export interface IncomingBlob {
	from_endpoint: string;          // swarm://<hex_hyperswarm_pubkey>
	payload_b64: string;            // base64 of the encoded TransportEnvelope
	content_type: string;
	received_at: number;
	metadata: Record<string, string>;
}

interface Singleton {
	swarm: HsSwarm;
	connsByPubkey: Map<string, HsConnection>;
	pendingResolvers: Map<string, Array<(c: HsConnection) => void>>;
	joinedTopics: Map<string, HsDiscovery>;   // hex(topic) -> handle
	topicMembers: Map<string, Set<string>>;   // hex(topic) -> set of hex(pubkey) seen
	connTopics: Map<HsConnection, Set<string>>; // conn -> set of hex(topic)
	queue: IncomingBlob[];
	decodeEnvelope: (bytes: Uint8Array) => { contentType: string; metadata: Record<string, string> };
}

let singleton: Singleton | null = null;

function require_(): Singleton {
	if (!singleton) {
		throw new Error("swarm-host: initSwarm() has not been called yet — daemon must bring the swarm up before programs use it");
	}
	return singleton;
}

// ── Public API used by programs (through runtime externals) ─────

export function isReady(): boolean { return singleton != null; }

export function getHyperswarmPublicKeyHex(): string {
	return require_().swarm.keyPair.publicKey.toString("hex");
}

/** Join a topic. Idempotent. Returns when discovery has flushed once. */
export async function joinTopic(topic: Buffer): Promise<void> {
	const s = require_();
	const key = topic.toString("hex");
	if (s.joinedTopics.has(key)) return;
	const disco = s.swarm.join(topic, { server: true, client: true });
	s.joinedTopics.set(key, disco);
	await disco.flushed();
}

export async function leaveTopic(topic: Buffer): Promise<void> {
	const s = require_();
	const key = topic.toString("hex");
	const disco = s.joinedTopics.get(key);
	if (!disco) return;
	await disco.destroy();
	s.joinedTopics.delete(key);
}

/** Send framed bytes to the peer identified by their hyperswarm pubkey.
 *  Will join the pair topic + wait up to `timeoutMs` for the connection
 *  if not already cached. Throws on timeout or peer offline. */
export async function sendToPeer(remotePubkeyHex: string, payload: Uint8Array | Buffer, opts: { timeoutMs?: number; joinPairTopic?: boolean } = {}): Promise<void> {
	const s = require_();
	const cached = s.connsByPubkey.get(remotePubkeyHex);
	if (cached && !cached.destroyed) {
		writeFrame(cached, payload);
		return;
	}
	if (opts.joinPairTopic !== false) {
		const mine = getHyperswarmPublicKeyHex();
		await joinTopic(pairTopic(mine, remotePubkeyHex));
	}
	const conn = await waitForConnection(remotePubkeyHex, opts.timeoutMs ?? 10_000);
	writeFrame(conn, payload);
}

/** Broadcast framed bytes to every currently-connected peer that is also
 *  on the given topic. Used by /directory for announce loops. */
export function broadcastOnTopic(topic: Buffer, payload: Uint8Array | Buffer): { sent: number; skipped: number } {
	const s = require_();
	const topicHex = topic.toString("hex");
	let sent = 0;
	let skipped = 0;
	for (const [pubkeyHex, conn] of s.connsByPubkey) {
		const topics = s.connTopics.get(conn);
		if (!topics || !topics.has(topicHex)) { skipped++; continue; }
		if (conn.destroyed) { skipped++; continue; }
		try { writeFrame(conn, payload); sent++; }
		catch { skipped++; }
		void pubkeyHex;
	}
	return { sent, skipped };
}

export function drainIncoming(): IncomingBlob[] {
	const s = require_();
	const out = s.queue.splice(0, s.queue.length);
	return out;
}

export function statusSnapshot(): {
	hyperswarm_pubkey: string;
	peers_connected: number;
	topics_joined: number;
	queue_depth: number;
} {
	if (!singleton) return { hyperswarm_pubkey: "", peers_connected: 0, topics_joined: 0, queue_depth: 0 };
	return {
		hyperswarm_pubkey: getHyperswarmPublicKeyHex(),
		peers_connected: singleton.connsByPubkey.size,
		topics_joined: singleton.joinedTopics.size,
		queue_depth: singleton.queue.length,
	};
}

// ── Daemon lifecycle (NOT used by bundled programs) ─────────────

export interface InitOpts {
	/** Pre-built Hyperswarm instance (daemon constructs it). Required. */
	swarm: HsSwarm;
	/** Function to decode the framed payload into headers (content_type,
	 *  metadata) so we can populate IncomingBlob without re-importing
	 *  protobufjs at this layer. */
	decodeEnvelope: (bytes: Uint8Array) => { contentType: string; metadata: Record<string, string> };
}

export function initSwarm(opts: InitOpts): void {
	if (singleton) throw new Error("swarm-host: already initialised");
	singleton = {
		swarm: opts.swarm,
		connsByPubkey: new Map(),
		pendingResolvers: new Map(),
		joinedTopics: new Map(),
		topicMembers: new Map(),
		connTopics: new Map(),
		queue: [],
		decodeEnvelope: opts.decodeEnvelope,
	};

	opts.swarm.on("connection", (conn, info) => {
		const pubkeyHex = info.publicKey.toString("hex");
		singleton!.connsByPubkey.set(pubkeyHex, conn);
		// Tag the connection with topics we share. We don't know yet which
		// topic(s) brought us together; treat every currently-joined topic
		// as a candidate. Hyperswarm doesn't expose per-conn topic info.
		const topicSet = new Set<string>(singleton!.joinedTopics.keys());
		singleton!.connTopics.set(conn, topicSet);
		for (const tk of topicSet) {
			let members = singleton!.topicMembers.get(tk);
			if (!members) { members = new Set(); singleton!.topicMembers.set(tk, members); }
			members.add(pubkeyHex);
		}

		// Resolve any pending sendToPeer() calls waiting for this peer.
		const waiters = singleton!.pendingResolvers.get(pubkeyHex);
		if (waiters) {
			singleton!.pendingResolvers.delete(pubkeyHex);
			for (const r of waiters) r(conn);
		}

		const reader = makeFrameReader((bytes) => {
			try {
				const env = opts.decodeEnvelope(bytes);
				const b64 = Buffer.from(bytes).toString("base64");
				singleton!.queue.push({
					from_endpoint: `swarm://${pubkeyHex}`,
					payload_b64: b64,
					content_type: env.contentType,
					received_at: Date.now(),
					metadata: env.metadata,
				});
			} catch {
				// Drop malformed; we can't usefully recover this frame.
			}
		});

		conn.on("data", reader);
		conn.on("error", () => { /* swallow — close handler does cleanup */ });
		conn.on("close", () => {
			singleton!.connsByPubkey.delete(pubkeyHex);
			singleton!.connTopics.delete(conn);
			for (const members of singleton!.topicMembers.values()) members.delete(pubkeyHex);
		});
	});
}

export async function destroySwarm(): Promise<void> {
	if (!singleton) return;
	try { await singleton.swarm.destroy(); } catch { /* best effort */ }
	singleton = null;
}

/** Load (or create + persist) the long-lived Noise keypair used to identify
 *  this daemon on the swarm. Returns the keypair shape Hyperswarm expects. */
export function loadOrCreateKeyPair(generate: () => { publicKey: Buffer; secretKey: Buffer }): { publicKey: Buffer; secretKey: Buffer } {
	const file = keyPairPath();
	if (existsSync(file)) {
		const raw = JSON.parse(readFileSync(file, "utf-8")) as { publicKey: string; secretKey: string };
		return {
			publicKey: Buffer.from(raw.publicKey, "hex"),
			secretKey: Buffer.from(raw.secretKey, "hex"),
		};
	}
	const kp = generate();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			publicKey: kp.publicKey.toString("hex"),
			secretKey: kp.secretKey.toString("hex"),
		}),
		{ mode: 0o600 },
	);
	return kp;
}

// ── Frame protocol ──────────────────────────────────────────────
// 4-byte big-endian length prefix, then `length` bytes of envelope. Simple,
// length-bounded, no need for delimiters; payloads are arbitrary binary.

const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function writeFrame(conn: HsConnection, payload: Uint8Array | Buffer): void {
	const body = payload instanceof Buffer ? payload : Buffer.from(payload);
	if (body.length > MAX_FRAME_BYTES) {
		throw new Error(`swarm-host: frame too large (${body.length} > ${MAX_FRAME_BYTES})`);
	}
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32BE(body.length, 0);
	conn.write(Buffer.concat([header, body]));
}

/** Returns a function that accumulates Buffer chunks and emits each fully
 *  formed frame's bytes to `onFrame`. Safely handles arbitrary chunk
 *  boundaries (frames split across multiple data events, multiple frames
 *  in one chunk, etc.). */
function makeFrameReader(onFrame: (frame: Uint8Array) => void): (chunk: Buffer) => void {
	let buffer: Buffer = Buffer.alloc(0);
	return (chunk: Buffer) => {
		buffer = (buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])) as Buffer;
		while (buffer.length >= 4) {
			const need = buffer.readUInt32BE(0);
			if (need > MAX_FRAME_BYTES) {
				// Bad framing — drop the rest, can't recover.
				buffer = Buffer.alloc(0);
				return;
			}
			if (buffer.length < 4 + need) return;
			const frame = buffer.subarray(4, 4 + need);
			buffer = buffer.subarray(4 + need);
			try { onFrame(new Uint8Array(frame)); }
			catch { /* never let a handler bug stall the stream */ }
		}
	};
}

// ── Connection-wait helper ─────────────────────────────────────

function waitForConnection(remotePubkeyHex: string, timeoutMs: number): Promise<HsConnection> {
	const s = require_();
	const cached = s.connsByPubkey.get(remotePubkeyHex);
	if (cached && !cached.destroyed) return Promise.resolve(cached);
	return new Promise<HsConnection>((resolve, reject) => {
		const arr = s.pendingResolvers.get(remotePubkeyHex) ?? [];
		const fn = (c: HsConnection) => { clearTimeout(timer); resolve(c); };
		arr.push(fn);
		s.pendingResolvers.set(remotePubkeyHex, arr);
		const timer = setTimeout(() => {
			const list = s.pendingResolvers.get(remotePubkeyHex);
			if (list) {
				const idx = list.indexOf(fn);
				if (idx >= 0) list.splice(idx, 1);
				if (list.length === 0) s.pendingResolvers.delete(remotePubkeyHex);
			}
			reject(new Error(`swarm-host: timed out waiting for connection to ${remotePubkeyHex.slice(0, 12)} after ${timeoutMs}ms`));
		}, timeoutMs);
	});
}

// ── Test exports ────────────────────────────────────────────────

export const __test = {
	makeFrameReader,
	writeFrame,
	topicFor,
	pairTopic,
	reset: () => { singleton = null; },
};
