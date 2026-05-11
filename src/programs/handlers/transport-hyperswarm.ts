// transport-hyperswarm — send and receive Glon envelopes over Hyperswarm.
//
// Why: Discord/Gmail/HTTP transports all depend on a server we don't run
// (or can't ignore). Hyperswarm gives us a P2P stack with no fixed server
// — peers discover each other through a DHT and form direct or DHT-relayed
// Noise-encrypted connections. This transport is the underlay for `/trade`
// and `/directory`; it knows nothing about either of them, only about
// sending bytes by peer pubkey and broadcasting on topics.
//
// Endpoint format: `swarm://<hex_hyperswarm_pubkey>` — the 32-byte Noise
// public key of the destination. (Programs that work in terms of identity
// pubkeys can map identity → hyperswarm pubkey via /peer.)
//
// Architecture:
// - The daemon owns a single Hyperswarm instance (see scripts/daemon.ts).
//   It exposes it via the swarm-host module, which we import here.
// - On every `connection` event the daemon-level code already pushes
//   parsed envelopes onto an incoming queue. This program's
//   `inbox_drain` action just drains that queue.
// - `send` writes a length-prefixed frame to the destination peer,
//   auto-joining their pair topic if no connection is cached.
// - `broadcast` writes a frame to every connection currently on a given
//   topic — used by /directory's announce loop.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, green, red } from "../shared.js";
import { encodeTransportEnvelope } from "../../proto.js";
import {
	sendToPeer,
	broadcastOnTopic,
	joinTopic,
	leaveTopic,
	drainIncoming,
	isReady,
	statusSnapshot,
} from "../../swarm-host.js";

// ── Helpers ──────────────────────────────────────────────────────

function parseEndpoint(endpoint: string): string {
	const m = /^swarm:\/\/([0-9a-fA-F]{64})$/.exec(endpoint);
	if (!m) throw new Error(`transport-hyperswarm: invalid endpoint ${endpoint} (expected swarm://<64-hex-pubkey>)`);
	return m[1].toLowerCase();
}

function parseTopicHex(topicHex: string): Buffer {
	if (!/^[0-9a-fA-F]{64}$/.test(topicHex)) {
		throw new Error(`transport-hyperswarm: invalid topic ${topicHex} (expected 64-hex-char buffer)`);
	}
	return Buffer.from(topicHex, "hex");
}

function buildEnvelope(content_type: string, payload_b64: string, metadata?: Record<string, string>): Buffer {
	const bytes = encodeTransportEnvelope({
		contentType: content_type,
		payload: Buffer.from(payload_b64, "base64"),
		senderPubkey: new Uint8Array(0), // identity is authenticated in the body, not the envelope
		metadata: metadata ?? {},
	});
	return Buffer.from(bytes);
}

// ── Typed actions ────────────────────────────────────────────────

interface SendInput {
	endpoint: string;
	payload_b64: string;
	content_type: string;
	metadata?: Record<string, string>;
}

async function doSend(_ctx: ProgramContext, input: SendInput): Promise<{ delivery_id: string }> {
	if (!isReady()) throw new Error("transport-hyperswarm: swarm not initialised (start the daemon with GLON_SWARM=1)");
	const remoteHex = parseEndpoint(input.endpoint);
	const frame = buildEnvelope(input.content_type, input.payload_b64, input.metadata);
	await sendToPeer(remoteHex, frame, { joinPairTopic: true, timeoutMs: 10_000 });
	return { delivery_id: `swarm-${remoteHex.slice(0, 8)}-${Date.now()}` };
}

interface BroadcastInput {
	topic: string;                          // 64-hex
	payload_b64: string;
	content_type: string;
	metadata?: Record<string, string>;
}

async function doBroadcast(_ctx: ProgramContext, input: BroadcastInput): Promise<{ sent: number; skipped: number }> {
	if (!isReady()) throw new Error("transport-hyperswarm: swarm not initialised");
	const topic = parseTopicHex(input.topic);
	const frame = buildEnvelope(input.content_type, input.payload_b64, input.metadata);
	return broadcastOnTopic(topic, frame);
}

interface JoinTopicInput { topic: string; }
async function doJoinTopic(_ctx: ProgramContext, input: JoinTopicInput): Promise<{ ok: true }> {
	if (!isReady()) throw new Error("transport-hyperswarm: swarm not initialised");
	await joinTopic(parseTopicHex(input.topic));
	return { ok: true };
}
async function doLeaveTopic(_ctx: ProgramContext, input: JoinTopicInput): Promise<{ ok: true }> {
	if (!isReady()) throw new Error("transport-hyperswarm: swarm not initialised");
	await leaveTopic(parseTopicHex(input.topic));
	return { ok: true };
}

async function doInboxDrain(_ctx: ProgramContext) {
	if (!isReady()) return [];
	return drainIncoming();
}

// ── CLI Handler ──────────────────────────────────────────────────

const handler = async (cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		if (!isReady()) {
			print(red("transport-hyperswarm: swarm offline (start daemon with GLON_SWARM=1)"));
			return;
		}
		const s = statusSnapshot();
		print(bold("  transport-hyperswarm"));
		print(dim(`    hyperswarm pubkey: ${s.hyperswarm_pubkey.slice(0, 32)}...`));
		print(dim(`    peers connected:   ${s.peers_connected}`));
		print(dim(`    topics joined:     ${s.topics_joined}`));
		print(dim(`    inbox queue:       ${s.queue_depth}`));
		return;
	}
	print([
		bold("  transport-hyperswarm") + dim(" — P2P transport over Hyperswarm"),
		`    ${cyan("transport-hyperswarm status")}  show swarm state`,
		dim("    Endpoint format: swarm://<64-hex-hyperswarm-pubkey>"),
		dim("    Used by /directory and /trade. Daemon starts the swarm; see GLON_SWARM env."),
	].join("\n"));
	void green;
};

// ── Actor ────────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({ sentCount: 0, drainedCount: 0 }),
	typedActions: {
		send: {
			description: "Send a payload to a Hyperswarm peer. Auto-joins their pair topic if not connected. Throws on timeout or offline.",
			inputSchema: {
				type: "object",
				required: ["endpoint", "payload_b64", "content_type"],
				properties: {
					endpoint: { type: "string" },
					payload_b64: { type: "string" },
					content_type: { type: "string" },
					metadata: { type: "object" },
				},
			},
			handler: async (ctx, input: SendInput) => doSend(ctx, input),
		},
		broadcast: {
			description: "Broadcast a payload to every connection currently on a topic.",
			inputSchema: {
				type: "object",
				required: ["topic", "payload_b64", "content_type"],
				properties: {
					topic: { type: "string" },
					payload_b64: { type: "string" },
					content_type: { type: "string" },
					metadata: { type: "object" },
				},
			},
			handler: async (ctx, input: BroadcastInput) => doBroadcast(ctx, input),
		},
		joinTopic: {
			description: "Join a Hyperswarm topic (server+client). Idempotent.",
			inputSchema: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } },
			handler: async (ctx, input: JoinTopicInput) => doJoinTopic(ctx, input),
		},
		leaveTopic: {
			description: "Leave a Hyperswarm topic.",
			inputSchema: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } },
			handler: async (ctx, input: JoinTopicInput) => doLeaveTopic(ctx, input),
		},
		inbox_drain: {
			description: "Drain queued envelopes received from any swarm peer.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => doInboxDrain(ctx),
		},
		status: {
			description: "Return swarm-state snapshot.",
			inputSchema: { type: "object", properties: {} },
			handler: async () => statusSnapshot(),
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

export const __test = { parseEndpoint, parseTopicHex, buildEnvelope, doSend, doBroadcast, doInboxDrain };
