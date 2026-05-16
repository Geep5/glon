// /auction — decentralized auction house over a permissionless autobase.
//
// Posts auctions / bids / settlements / cancellations to the local
// writer hypercore. The apply function (in src/ledger-host.ts)
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
// Static import — goes through the runtime externals shim. Dynamic `import()`
// here would try to resolve the path against the bundled program's directory
// and fail with "Cannot find module".
import { isReady as swarmIsReady, topicFor as swarmTopicFor } from "../../swarm-host.js";
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
} from "../../ledger-host.js";
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
 *  `id` stripped. Must match ledger-host.canonicalSigningBytes exactly. */
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

/** Parse a human duration like "30m", "1h", "2d" into milliseconds.
 *  Bare numbers are treated as ms. Returns null on parse failure. */
export function parseDuration(spec: string): number | null {
	const m = /^(\d+)(ms|s|m|h|d)?$/.exec(spec.trim().toLowerCase());
	if (!m) return null;
	const n = parseInt(m[1], 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	switch (m[2]) {
		case "d": return n * 86_400_000;
		case "h": return n * 3_600_000;
		case "m": return n * 60_000;
		case "s": return n * 1_000;
		case "ms":
		case undefined:
		default:  return n;
	}
}

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h

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
	const expiry_ms = args.expiryMs ?? (created_at + DEFAULT_EXPIRY_MS);
	if (expiry_ms <= created_at) {
		throw new Error(`auction: expiry_ms (${expiry_ms}) must be after created_at (${created_at})`);
	}

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
	/** For open auctions (no posted want), required: pick which of the
	 *  winner's bids to honor. For fixed-price auctions, optional override
	 *  if the seller accepts a counter-offer. */
	winningBidAt?: number;
}): Promise<void> {
	requireAutobase();
	const opNoSig: Omit<AuctionSettleOp, "signature"> = {
		kind: "auction.settle",
		auction_id: args.auctionId,
		winner_pubkey: args.winner,
		winning_bid_at: args.winningBidAt,
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

async function doGetBids(auctionId: string): Promise<Array<{
	auction_id: string;
	bidder_pubkey: string;
	offer: AuctionAsset[];
	created_at: number;
}>> {
	requireAutobase();
	const prefix = `auction/${auctionId}/bids/`;
	const rows = await viewList<any>(prefix);
	// Sort by created_at descending so newest bids surface first.
	return rows
		.map((r) => r.value)
		.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
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

	if (!swarmIsReady()) return { broadcast: false, reason: "swarm not ready" };

	let announcement: JoinOp & { signature: string };
	try {
		announcement = await buildJoinAnnouncement(ctx, "default");
	} catch (err: any) {
		return { broadcast: false, reason: err?.message ?? "no wallet key 'default' yet" };
	}

	const topicHex = swarmTopicFor(JOIN_TOPIC_LABEL).toString("hex");
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
			// Syntax: auction post <give> [for <want>] [with <key>] [to <pubkey>] [--expires=<duration>]
			//   no `for`           → open auction (bidders propose anything)
			//   `to <pubkey>` only → gift (no payment expected from recipient)
			//   `for <want>`       → fixed-price (winner pays this)
			let expiryMs: number | undefined;
			const filteredArgs: string[] = [];
			for (const a of args) {
				if (a.startsWith("--expires=")) {
					const dur = parseDuration(a.split("=")[1]);
					if (dur === null) { print(red(`Invalid --expires value (use forms like 30m, 1h, 2d)`)); return; }
					expiryMs = Date.now() + dur;
				} else {
					filteredArgs.push(a);
				}
			}
			const forIdx = filteredArgs.indexOf("for");
			// Split on the "for" keyword if present; otherwise everything up to a
			// trailing "with"/"to" is the give spec.
			let giveSpec: string;
			let wantParts: string[] = [];
			let rest: string[];
			if (forIdx >= 1) {
				giveSpec = filteredArgs.slice(0, forIdx).join(" ");
				rest = filteredArgs.slice(forIdx + 1);
			} else {
				// No "for" — find first "with"/"to" or end of args.
				let endIdx = filteredArgs.length;
				for (let i = 0; i < filteredArgs.length; i++) {
					if (filteredArgs[i] === "with" || filteredArgs[i] === "to") { endIdx = i; break; }
				}
				giveSpec = filteredArgs.slice(0, endIdx).join(" ");
				rest = filteredArgs.slice(endIdx);
			}
			if (!giveSpec) { print(red("Usage: auction post <give> [for <want>] [with <key>] [to <pubkey>] [--expires=<duration>]")); break; }
			let keyName = "default";
			let recipient: string | undefined;
			while (rest.length) {
				if (rest[0] === "with" && rest.length >= 2) { keyName = rest[1]; rest = rest.slice(2); continue; }
				if (rest[0] === "to" && rest.length >= 2) { recipient = rest[1]; rest = rest.slice(2); continue; }
				wantParts.push(rest[0]); rest = rest.slice(1);
			}
			try {
				const want = wantParts.length > 0 ? [parseAsset(wantParts.join(" "))] : [];
				const r = await doPost(ctx, {
					give: [parseAsset(giveSpec)],
					want,
					keyName,
					recipient,
					expiryMs,
				});
				const mode = want.length === 0
					? (recipient ? "gift" : "open auction (any bid welcome)")
					: "fixed-price auction";
				print(green(`Posted ${mode}`));
				print(dim("  id:      ") + r.auctionId);
				if (expiryMs) print(dim("  expires: ") + new Date(expiryMs).toISOString());
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "gift": {
			// Syntax: auction gift <amount> <token> to <pubkey> [with <key>] [--expires=<duration>]
			let expiryMs: number | undefined;
			const filteredArgs: string[] = [];
			for (const a of args) {
				if (a.startsWith("--expires=")) {
					const dur = parseDuration(a.split("=")[1]);
					if (dur === null) { print(red(`Invalid --expires value`)); return; }
					expiryMs = Date.now() + dur;
				} else {
					filteredArgs.push(a);
				}
			}
			if (filteredArgs.length < 4 || filteredArgs[2] !== "to") {
				print(red("Usage: auction gift <amount> <token> to <pubkey> [with <key>] [--expires=<duration>]"));
				break;
			}
			const amount = filteredArgs[0];
			const token = filteredArgs[1];
			const recipient = filteredArgs[3];
			const keyName = filteredArgs[5] && filteredArgs[4] === "with" ? filteredArgs[5] : "default";
			try {
				const r = await doPost(ctx, {
					give: [{ token, amount }],
					want: [], // no exchange — pure gift
					keyName,
					recipient,
					expiryMs,
				});
				print(green("Gift sent"));
				print(dim("  to:     ") + recipient.slice(0, 32) + (recipient.length > 32 ? "..." : ""));
				print(dim("  amount: ") + `${amount} ${token}`);
				print(dim("  id:     ") + r.auctionId);
				if (expiryMs) print(dim("  expires: ") + new Date(expiryMs).toISOString());
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
			// Syntax: auction settle <auctionId> <winnerPubkey> [--bid-at=<ms>] [with <key>]
			let winningBidAt: number | undefined;
			const positional: string[] = [];
			let keyName = "default";
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				if (a.startsWith("--bid-at=")) {
					winningBidAt = parseInt(a.split("=")[1], 10);
				} else if (a === "with" && args[i + 1]) {
					keyName = args[i + 1]; i++;
				} else {
					positional.push(a);
				}
			}
			if (positional.length < 2) { print(red("Usage: auction settle <auctionId> <winnerPubkey> [--bid-at=<ms>] [with <key>]")); break; }
			try {
				await doSettle(ctx, { auctionId: positional[0], winner: positional[1], winningBidAt, keyName });
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
				`    ${cyan("auction post")} ${dim("<give> [for <want>] [to <pubkey>] [--expires=1h]")}  post (default expiry 24h)`,
				dim(`        omit "for"  → open auction; bidders propose any tokens / basket`),
				dim(`        add "to X"  → directed (gift if no "for"; private sale otherwise)`),
				`    ${cyan("auction gift")} ${dim("<amount> <token> to <pubkey> [--expires=1h]")}     shortcut: directed, no payment`,
				`    ${cyan("auction bid")} ${dim("<auctionId> <amount> <token>")}      bid on an auction`,
				`    ${cyan("auction settle")} ${dim("<id> <winner> [--bid-at=<ms>]")}   seller picks a winner (--bid-at required for open auctions)`,
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
		getBids: async (_ctx: ProgramContext, auctionId: string) => doGetBids(auctionId),
		post: async (ctx: ProgramContext, input: { give: AuctionAsset[]; want: AuctionAsset[]; keyName: string; recipient?: string; expiryMs?: number }) => doPost(ctx, input),
		gift: async (ctx: ProgramContext, input: { amount: string; token: string; recipient: string; keyName: string }) =>
			doPost(ctx, { give: [{ token: input.token, amount: input.amount }], want: [], keyName: input.keyName, recipient: input.recipient }),
		bid: async (ctx: ProgramContext, input: { auctionId: string; offer: AuctionAsset[]; keyName: string }) => doBid(ctx, input),
		settle: async (ctx: ProgramContext, input: { auctionId: string; winner: string; keyName: string; winningBidAt?: number }) => doSettle(ctx, input),
		cancel: async (ctx: ProgramContext, input: { auctionId: string; keyName: string }) => doCancel(ctx, input),
		announceJoin: async (ctx: ProgramContext) => broadcastJoinAnnounce(ctx),
		handleJoinAnnounce,
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
