// /auction — decentralized auction house over a permissionless autobase.
//
// Posts auctions / bids / settlements / cancellations to the local
// writer hypercore. The autobase apply function (in src/autobase-host.ts)
// linearizes them with everyone else's ops and enforces conservation in
// the hyperbee view.
//
// Three top-level commands at MVP:
//   auction list                                     — list open auctions
//   auction post <give> for <want> [to <pubkey>]    — post a (public or directed) auction
//   auction gift <amount> <token> to <pubkey>        — degenerate auction: price=0, recipient set
//
// "Send Alice 10 FIG" = gift command = an auction with recipient + zero want.
//
// Identity binding: every op is signed by the seller's chain Ed25519 key
// from /wallet. The autobase writer pubkey is generated locally by the
// hypercore; the apply function will eventually verify the chain
// signature inside the op against the registered binding. For v1 we
// trust the writer-key/chain-key claim — Phase 3 tightens this.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { registerActorContentHandler } from "../runtime.js";
import { dim, bold, cyan, green, red, yellow } from "../shared.js";
import { sha256, hexEncode } from "../../crypto.js";
import {
	appendOp,
	viewGet,
	viewList,
	isReady as autobaseReady,
	isWritable,
	getWriterPubkeyHex,
	statusSnapshot,
	type AuctionOp,
	type AuctionCreateOp,
	type AuctionBidOp,
	type AuctionSettleOp,
	type AuctionCancelOp,
	type AuctionAsset,
	type JoinOp,
} from "../../autobase-host.js";
import { randomUUID } from "node:crypto";

// ── Auto-join over Hyperswarm directory topic ────────────────────

export const AUCTION_JOIN_CONTENT_TYPE = "glon/auction-join";
const JOIN_BROADCAST_INTERVAL_MS = 15_000;
const JOIN_TOPIC_LABEL = "glon-auction-join-v1";

// ── Helpers ──────────────────────────────────────────────────────

function requireAutobase(): void {
	if (!autobaseReady()) {
		throw new Error("auction: autobase not initialised (start daemon with GLON_AUCTION=1)");
	}
}

/** Build the canonical bytes for signing: keys sorted, `signature` and
 *  `id` stripped. Must match autobase-host.canonicalSigningBytes exactly. */
function canonicalSigningBytes(op: Record<string, unknown>): Uint8Array {
	const copy: Record<string, unknown> = {};
	for (const k of Object.keys(op).sort()) {
		if (k === "signature" || k === "id") continue;
		copy[k] = op[k];
	}
	return new TextEncoder().encode(JSON.stringify(copy));
}

/** Content-address an op: sha256 of canonical signing bytes. */
function contentAddressOp(op: Omit<AuctionCreateOp, "id" | "signature">): string {
	return hexEncode(sha256(canonicalSigningBytes(op as Record<string, unknown>))).slice(0, 32);
}

/** Sign an op with the wallet's chain key. Returns hex signature. */
async function signOp(ctx: ProgramContext, keyName: string, op: Omit<AuctionOp, "signature">): Promise<string> {
	const messageB64 = Buffer.from(canonicalSigningBytes(op as Record<string, unknown>)).toString("base64");
	const result = await ctx.dispatchProgram("/wallet", "sign", [keyName, messageB64]) as { signature: string; pubkey: string };
	return result.signature;
}

async function resolveWalletPubkey(ctx: ProgramContext, keyName: string): Promise<string> {
	const info = await ctx.dispatchProgram("/wallet", "show", [keyName]) as { pubkey: string } | null;
	if (!info) throw new Error(`auction: wallet key "${keyName}" not found`);
	return info.pubkey;
}

// ── Asset parsing ────────────────────────────────────────────────

/** Parse "<amount> <token>" or "<object_id>" into an AuctionAsset. */
function parseAsset(spec: string): AuctionAsset {
	const trimmed = spec.trim();
	const fungibleMatch = /^(\d+)\s+([a-zA-Z0-9_.-]+)$/.exec(trimmed);
	if (fungibleMatch) {
		return { token: fungibleMatch[2], amount: fungibleMatch[1] };
	}
	// Otherwise treat as object_id
	return { object_id: trimmed };
}

// ── Core operations ──────────────────────────────────────────────

async function doPost(ctx: ProgramContext, args: {
	give: AuctionAsset[];
	want: AuctionAsset[];
	keyName: string;
	recipient?: string;
	expiryMs?: number;
}): Promise<{ auctionId: string }> {
	requireAutobase();
	const seller = await resolveWalletPubkey(ctx, args.keyName);
	const created_at = Date.now();
	const expiry_ms = args.expiryMs ?? (created_at + 24 * 60 * 60 * 1000); // 24h default

	const opNoSig: Omit<AuctionCreateOp, "signature"> = {
		kind: "auction.create",
		id: "", // filled below
		seller_pubkey: seller,
		recipient_pubkey: args.recipient,
		give: args.give,
		want: args.want,
		expiry_ms,
		created_at,
	};
	opNoSig.id = contentAddressOp(opNoSig as any);
	const signature = await signOp(ctx, args.keyName, opNoSig);
	const op: AuctionCreateOp = { ...opNoSig, signature };
	await appendOp(op);
	return { auctionId: op.id };
}

async function doBid(ctx: ProgramContext, args: {
	auctionId: string;
	offer: AuctionAsset[];
	keyName: string;
}): Promise<void> {
	requireAutobase();
	const bidder = await resolveWalletPubkey(ctx, args.keyName);
	const opNoSig: Omit<AuctionBidOp, "signature"> = {
		kind: "auction.bid",
		auction_id: args.auctionId,
		bidder_pubkey: bidder,
		offer: args.offer,
		created_at: Date.now(),
	};
	const signature = await signOp(ctx, args.keyName, opNoSig);
	await appendOp({ ...opNoSig, signature });
}

async function doSettle(ctx: ProgramContext, args: {
	auctionId: string;
	winner: string;
	keyName: string;
}): Promise<void> {
	requireAutobase();
	const opNoSig: Omit<AuctionSettleOp, "signature"> = {
		kind: "auction.settle",
		auction_id: args.auctionId,
		winner_pubkey: args.winner,
		created_at: Date.now(),
	};
	const signature = await signOp(ctx, args.keyName, opNoSig);
	await appendOp({ ...opNoSig, signature });
}

async function doCancel(ctx: ProgramContext, args: {
	auctionId: string;
	keyName: string;
}): Promise<void> {
	requireAutobase();
	const opNoSig: Omit<AuctionCancelOp, "signature"> = {
		kind: "auction.cancel",
		auction_id: args.auctionId,
		created_at: Date.now(),
	};
	const signature = await signOp(ctx, args.keyName, opNoSig);
	await appendOp({ ...opNoSig, signature });
}

async function doList(): Promise<Array<{ id: string; seller_pubkey: string; give: AuctionAsset[]; want: AuctionAsset[]; status: string; recipient_pubkey?: string }>> {
	requireAutobase();
	const rows = await viewList<any>("auction/");
	return rows
		.filter((r) => !r.key.includes("/bids/")) // skip nested bid keys
		.map((r) => r.value);
}

// ── Auto peer.join over Hyperswarm ───────────────────────────────

/** Build a signed peer.join op announcing this node's writer key and chain key. */
async function buildJoinAnnouncement(ctx: ProgramContext, keyName: string): Promise<JoinOp & { signature: string }> {
	if (!autobaseReady()) throw new Error("auction: autobase not ready");
	const writerKey = getWriterPubkeyHex();
	const keyInfo = await ctx.dispatchProgram("/wallet", "show", [keyName]) as { pubkey: string } | null;
	if (!keyInfo) throw new Error(`auction: wallet key "${keyName}" not found`);

	const opNoSig = {
		kind: "peer.join" as const,
		writer_pubkey: writerKey,
		chain_pubkey: keyInfo.pubkey,
		created_at: Date.now(),
	};
	const signature = await signOp(ctx, keyName, opNoSig);
	return { ...opNoSig, signature };
}

/** Broadcast a peer.join announcement on the auction-join topic.
 *  Called periodically while we're not yet a writer. Stops once we are. */
async function broadcastJoinAnnounce(ctx: ProgramContext): Promise<{ broadcast: boolean; reason?: string }> {
	if (!autobaseReady()) return { broadcast: false, reason: "autobase not ready" };
	if (isWritable()) return { broadcast: false, reason: "already a writer" };

	const swarmHost = await import("../../swarm-host.js");
	if (!swarmHost.isReady()) return { broadcast: false, reason: "swarm not ready" };

	let announcement: JoinOp & { signature: string };
	try {
		announcement = await buildJoinAnnouncement(ctx, "default");
	} catch (err: any) {
		return { broadcast: false, reason: err?.message ?? "no wallet key 'default' yet" };
	}

	const topicHex = swarmHost.topicFor(JOIN_TOPIC_LABEL).toString("hex");
	const payload_b64 = Buffer.from(JSON.stringify(announcement)).toString("base64");
	try {
		await ctx.dispatchProgram("/transport-hyperswarm", "broadcast", [{
			topic: topicHex,
			payload_b64,
			content_type: AUCTION_JOIN_CONTENT_TYPE,
			metadata: {},
		}]);
		return { broadcast: true };
	} catch (err: any) {
		return { broadcast: false, reason: err?.message ?? "broadcast failed" };
	}
}

/** Content handler: an existing writer relays the incoming peer.join into the autobase.
 *  Sig verification happens inside apply, so this is best-effort. */
async function handleJoinAnnounce(_ctx: ProgramContext, envelope: { payload: Uint8Array; metadata: Record<string, string> }, _blob: unknown): Promise<boolean> {
	if (!autobaseReady() || !isWritable()) return false;
	let signedOp: JoinOp & { signature: string };
	try { signedOp = JSON.parse(new TextDecoder().decode(envelope.payload)); }
	catch { return false; }
	if (signedOp.kind !== "peer.join") return false;
	if (!signedOp.writer_pubkey || !signedOp.chain_pubkey || !signedOp.signature) return false;

	// Skip if the peer is already a writer (their writer key shows up in
	// our peer/<chain>/writer hyperbee record).
	const existing = await viewGet<{ writer_pubkey: string }>(`peer/${signedOp.chain_pubkey}/writer`);
	if (existing) return true;

	try {
		await appendOp(signedOp);
		return true;
	} catch {
		return false;
	}
}

// One-time content handler registration. registerActorContentHandler dispatches
// incoming envelopes to the named actor action.
registerActorContentHandler(AUCTION_JOIN_CONTENT_TYPE, "/auction", "handleJoinAnnounce");

// ── CLI handler ──────────────────────────────────────────────────

function formatAsset(a: AuctionAsset): string {
	if (a.object_id) return a.object_id;
	if (a.token && a.amount) return `${a.amount} ${a.token}`;
	return "<malformed-asset>";
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	switch (cmd) {
		case "status": {
			if (!autobaseReady()) {
				print(red("  Autobase not initialised. Start daemon with GLON_AUCTION=1."));
				break;
			}
			const s = statusSnapshot();
			print(bold("  Auction") + dim(" — permissionless autobase ledger"));
			print(dim("    bootstrap key: ") + s.bootstrap_key.slice(0, 32) + "...");
			print(dim("    writer pubkey: ") + s.writer_pubkey.slice(0, 32) + "...");
			print(dim("    system length: ") + String(s.system_length));
			print(dim("    view length:   ") + String(s.view_length));
			break;
		}

		case "list": {
			try {
				const auctions = await doList();
				if (auctions.length === 0) {
					print(dim("  No auctions in the local view yet."));
					break;
				}
				for (const a of auctions) {
					const give = a.give.map(formatAsset).join(", ");
					const want = a.want.map(formatAsset).join(", ");
					const directed = a.recipient_pubkey ? dim(` → ${a.recipient_pubkey.slice(0, 12)}…`) : "";
					print(`  ${bold(a.id.slice(0, 8))} ${dim(a.status)} ${cyan(give)} for ${cyan(want)}${directed}`);
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "post": {
			// Syntax: auction post <giveSpec> for <wantSpec> [with <key>] [to <pubkey>]
			const forIdx = args.indexOf("for");
			if (forIdx < 1) { print(red("Usage: auction post <give> for <want> [with <key>] [to <pubkey>]")); break; }
			const giveSpec = args.slice(0, forIdx).join(" ");
			let rest = args.slice(forIdx + 1);
			let wantParts: string[] = [];
			let keyName = "default";
			let recipient: string | undefined;
			while (rest.length) {
				if (rest[0] === "with" && rest.length >= 2) { keyName = rest[1]; rest = rest.slice(2); continue; }
				if (rest[0] === "to" && rest.length >= 2) { recipient = rest[1]; rest = rest.slice(2); continue; }
				wantParts.push(rest[0]); rest = rest.slice(1);
			}
			if (wantParts.length === 0) { print(red("Usage: auction post <give> for <want> [with <key>] [to <pubkey>]")); break; }
			try {
				const r = await doPost(ctx, {
					give: [parseAsset(giveSpec)],
					want: [parseAsset(wantParts.join(" "))],
					keyName,
					recipient,
				});
				print(green("Auction posted"));
				print(dim("  id: ") + r.auctionId);
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "gift": {
			// Syntax: auction gift <amount> <token> to <pubkey> [with <key>]
			if (args.length < 4 || args[2] !== "to") {
				print(red("Usage: auction gift <amount> <token> to <pubkey> [with <key>]"));
				break;
			}
			const amount = args[0];
			const token = args[1];
			const recipient = args[3];
			const keyName = args[5] && args[4] === "with" ? args[5] : "default";
			try {
				const r = await doPost(ctx, {
					give: [{ token, amount }],
					want: [], // no exchange — pure gift
					keyName,
					recipient,
				});
				print(green("Gift sent"));
				print(dim("  to:     ") + recipient.slice(0, 32) + (recipient.length > 32 ? "..." : ""));
				print(dim("  amount: ") + `${amount} ${token}`);
				print(dim("  id:     ") + r.auctionId);
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "bid": {
			// Syntax: auction bid <auctionId> <amount> <token> [with <key>]
			if (args.length < 3) { print(red("Usage: auction bid <auctionId> <amount> <token> [with <key>]")); break; }
			const auctionId = args[0];
			const amount = args[1];
			const token = args[2];
			const keyName = args[4] && args[3] === "with" ? args[4] : "default";
			try {
				await doBid(ctx, { auctionId, offer: [{ token, amount }], keyName });
				print(green("Bid submitted"));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "settle": {
			// Syntax: auction settle <auctionId> <winnerPubkey> [with <key>]
			if (args.length < 2) { print(red("Usage: auction settle <auctionId> <winnerPubkey> [with <key>]")); break; }
			const auctionId = args[0];
			const winner = args[1];
			const keyName = args[3] && args[2] === "with" ? args[3] : "default";
			try {
				await doSettle(ctx, { auctionId, winner, keyName });
				print(green("Settled"));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "join": {
			// Useful when running a second daemon: shows your writer key
			// and broadcasts an announce immediately so a founder online
			// right now can relay it.
			if (!autobaseReady()) { print(red("  Autobase not initialised.")); break; }
			print(bold("  Auction join") + dim(" — request admission to the network"));
			print(dim("    bootstrap key: ") + statusSnapshot().bootstrap_key);
			print(dim("    writer pubkey: ") + getWriterPubkeyHex());
			print(dim("    writable now:  ") + (isWritable() ? green("yes") : yellow("no — waiting for relay")));
			if (!isWritable()) {
				const r = await broadcastJoinAnnounce(ctx);
				print(r.broadcast
					? dim("    → join announcement broadcast on the network")
					: yellow(`    → broadcast skipped: ${r.reason ?? "unknown"}`));
			}
			break;
		}

		case "cancel": {
			if (args.length < 1) { print(red("Usage: auction cancel <auctionId> [with <key>]")); break; }
			const auctionId = args[0];
			const keyName = args[2] && args[1] === "with" ? args[2] : "default";
			try {
				await doCancel(ctx, { auctionId, keyName });
				print(green("Cancelled"));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Auction") + dim(" — permissionless P2P auction house"),
				`    ${cyan("auction status")}                              ledger health snapshot`,
				`    ${cyan("auction join")}                                broadcast a join request (run on first start)`,
				`    ${cyan("auction list")}                                local view of all auctions`,
				`    ${cyan("auction post")} ${dim("<give> for <want> [to <pubkey>]")}  post an auction`,
				`    ${cyan("auction gift")} ${dim("<amount> <token> to <pubkey>")}     send tokens to someone`,
				`    ${cyan("auction bid")} ${dim("<auctionId> <amount> <token>")}      bid on an open auction`,
				`    ${cyan("auction settle")} ${dim("<auctionId> <winnerPubkey>")}     seller picks a winner`,
				`    ${cyan("auction cancel")} ${dim("<auctionId>")}                    seller cancels an open auction`,
				dim(`  Ledger: ~/.glon/autobase  (permissionless CRDT over Hyperswarm)`),
				dim(`  Bring up the daemon with GLON_SWARM=1 GLON_AUCTION=1.`),
				dim(`  To join a specific network: set GLON_AUTOBASE_BOOTSTRAP=<hex-pubkey>.`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ──────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	tickMs: JOIN_BROADCAST_INTERVAL_MS,
	onTick: async (ctx: ProgramContext) => {
		// While we're not a writer, periodically rebroadcast a peer.join
		// so existing writers learn about us and relay the op into the
		// autobase. Stops broadcasting once writable.
		if (!autobaseReady() || isWritable()) return;
		const r = await broadcastJoinAnnounce(ctx);
		if (r.broadcast) ctx.print?.(dim(`[auction] join announce sent`));
	},
	actions: {
		status: async (_ctx: ProgramContext) => statusSnapshot(),
		list: async (_ctx: ProgramContext) => doList(),
		get: async (_ctx: ProgramContext, auctionId: string) => viewGet(`auction/${auctionId}`),
		post: async (ctx: ProgramContext, input: { give: AuctionAsset[]; want: AuctionAsset[]; keyName: string; recipient?: string; expiryMs?: number }) => doPost(ctx, input),
		gift: async (ctx: ProgramContext, input: { amount: string; token: string; recipient: string; keyName: string }) =>
			doPost(ctx, { give: [{ token: input.token, amount: input.amount }], want: [], keyName: input.keyName, recipient: input.recipient }),
		bid: async (ctx: ProgramContext, input: { auctionId: string; offer: AuctionAsset[]; keyName: string }) => doBid(ctx, input),
		settle: async (ctx: ProgramContext, input: { auctionId: string; winner: string; keyName: string }) => doSettle(ctx, input),
		cancel: async (ctx: ProgramContext, input: { auctionId: string; keyName: string }) => doCancel(ctx, input),
		announceJoin: async (ctx: ProgramContext) => broadcastJoinAnnounce(ctx),
		handleJoinAnnounce,
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
