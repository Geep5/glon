/**
 * ledger-host — daemon-side ownership of the auction-house ledger.
 *
 * Why this module exists: corestore / autobase / hyperbee pull in native
 * deps (sodium-native at minimum) that esbuild can't bundle into a
 * string-evaluated program. The daemon owns the ledger instance and
 * exposes a tiny API surface through runtime externals so bundled
 * programs (`/auction`, `/coin`) can read/write it.
 *
 * Programs that need ledger access import like:
 *
 *   import { appendOp, viewGet, getWriterPubkeyHex } from "../ledger-host.js";
 *
 * The bundler resolves "ledger-host.js" to this module's exports via
 * the runtime externals map.
 *
 * Two backends share this module's API:
 *
 *   "autobase" — the original implementation. Single autobase with a
 *                writer set. Existing writers must admit new writers via
 *                peer.join ops. Persistent storage at ~/.glon/autobase/.
 *
 *   "raw"      — pure CRDT over a corestore of writer hypercores. No
 *                writer set, no admission, no whitelist. Every node has
 *                its own writer hypercore; nodes deterministically merge
 *                all known writers' ops by (created_at, writer_pubkey,
 *                seq) and run apply over the result. isWritable() is
 *                always true. Persistent storage at ~/.glon/ledger/.
 *
 * The daemon picks the backend at init based on GLON_RAW_LEDGER env.
 * Programs are backend-agnostic — they call appendOp / viewGet / etc.
 * and the right implementation runs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { verify as ed25519Verify } from "./det/ed25519.js";

// ── Op type (JSON over autobase value-encoded blocks) ────────────

/**
 * Every op written to the autobase is a JSON object with at least
 * `kind`. The apply function dispatches on `kind` to mutate the view.
 * Keep these shapes flat and additive — autobase replays history on
 * reorder, so additive evolution is safe; removal is not.
 */
export type AuctionOp =
	| AuctionCreateOp
	| AuctionBidOp
	| AuctionSettleOp
	| AuctionCancelOp
	| CoinDeployOp
	| CoinMintOp
	| CoinTransferOp
	| CoinBurnOp
	| TypeRegisterOp
	| JoinOp;

/** Mint additional supply (token owner only). Increments owner's balance. */
export interface CoinMintOp {
	kind: "coin.mint";
	token_id: string;
	to_pubkey: string;
	amount: string;            // decimal string
	signature: string;         // signed by token owner (verified via view lookup)
	created_at: number;
}

/** Transfer fungible balance between two pubkeys. Signed by sender. */
export interface CoinTransferOp {
	kind: "coin.transfer";
	token_id: string;
	from_pubkey: string;       // signer
	to_pubkey: string;
	amount: string;
	signature: string;
	created_at: number;
}

/** Burn fungible balance from sender's account. Signed by sender. */
export interface CoinBurnOp {
	kind: "coin.burn";
	token_id: string;
	from_pubkey: string;       // signer
	amount: string;
	signature: string;
	created_at: number;
}

/**
 * A new peer requests to be admitted as an indexer. The apply function
 * accepts unconditionally — that's what makes this permissionless. The
 * permission isn't "who's allowed to join" (everyone is), it's the
 * per-op conservation rules enforced once they start writing.
 *
 * Existing writers receive this op and call host.addWriter for the
 * joiner's writer_pubkey. After that, the joiner can append normally.
 */
export interface JoinOp {
	kind: "peer.join";
	writer_pubkey: string;          // hex of the joining node's autobase writer key
	chain_pubkey: string;           // hex of the joining node's Ed25519 chain identity (for sig verify in Phase 3)
	created_at: number;
}

export interface AuctionCreateOp {
	kind: "auction.create";
	/** Content-addressed ID = sha256 of the canonical op bytes (without `kind` filled-in id). */
	id: string;
	seller_pubkey: string;
	/** Optional recipient for "gift" / direct trade flows. Public auction if omitted. */
	recipient_pubkey?: string;
	/** Object IDs (game items) or coin specs ({ token, amount }). */
	give: AuctionAsset[];
	want: AuctionAsset[];
	expiry_ms: number;
	signature: string; // hex Ed25519 over canonical(op without signature)
	created_at: number; // unix ms
}

export interface AuctionBidOp {
	kind: "auction.bid";
	auction_id: string;
	bidder_pubkey: string;
	offer: AuctionAsset[];
	signature: string;
	created_at: number;
}

export interface AuctionSettleOp {
	kind: "auction.settle";
	auction_id: string;
	winner_pubkey: string;          // seller declares the winner
	/**
	 * `created_at` of the winning bid. Required for **open auctions**
	 * (auctions with empty `want`) — the apply function uses this to look
	 * up the specific bid record at `auction/<id>/bids/<winner>/<this>`
	 * and charges the winner the contents of THAT bid's offer.
	 *
	 * For fixed-price auctions (non-empty `want`), if omitted, the apply
	 * function charges the winner the auction's posted `want` instead.
	 * Pass it anyway if the seller is accepting a bid that doesn't match
	 * the original asking price (e.g. accepting a counter-offer).
	 *
	 * For gifts (recipient_pubkey set + empty want), this is ignored.
	 */
	winning_bid_at?: number;
	signature: string;              // sig by seller
	created_at: number;
}

export interface AuctionCancelOp {
	kind: "auction.cancel";
	auction_id: string;
	signature: string;              // sig by seller
	created_at: number;
}

export interface CoinDeployOp {
	kind: "coin.deploy";
	token_id: string;               // content-addressed
	name: string;
	symbol: string;
	decimals: number;
	supply: string;                 // decimal string, supports large bigints
	owner_pubkey: string;           // initial supply recipient + mint authority
	mint_renounced: boolean;        // if true, no future coin.mint ops allowed
	signature: string;
	created_at: number;
}

export interface TypeRegisterOp {
	kind: "type.register";
	type_key: string;               // e.g. "game.cooltcg.card"
	mint_authority_pubkey: string;
	volatile: boolean;              // true → UUID IDs; false → content-addressed
	signature: string;
	created_at: number;
}

export interface AuctionAsset {
	/** Either object_id (unique item) OR token (fungible) — never both. */
	object_id?: string;
	token?: string;
	amount?: string;                // decimal string for fungible
}

// ── Singleton state (two-backend) ─────────────────────────────────

interface AutobaseInstance {
	backend: "autobase";
	base: any;                      // Autobase instance
	view: any;                      // Hyperbee
	corestore: any;
	writerPubkey: Buffer;
}

interface RawInstance {
	backend: "raw";
	corestore: any;                 // Corestore (owns all writer hypercores)
	localCore: any;                 // This node's writer hypercore
	knownWriters: Map<string, any>; // pubkey_hex → peer's hypercore
	view: Map<string, string>;      // In-memory key/value view; rebuilt on replay
	highestSeenTs: number;          // Fast-path: skip replay when new op's ts > this
	registryFile: string;           // Where peer pubkeys are persisted across restarts
	reapplyTimer: ReturnType<typeof setTimeout> | null;
	reapplyInFlight: Promise<void> | null;
	storageDir: string;             // ~/.glon/ledger (or override) — for status / debugging
}

type LedgerInstance = AutobaseInstance | RawInstance;

let singleton: LedgerInstance | null = null;

function require_(): LedgerInstance {
	if (!singleton) {
		throw new Error("ledger-host: not initialized — call initAutobase() or initRawLedger()");
	}
	return singleton;
}

function requireAutobase(): AutobaseInstance {
	const s = require_();
	if (s.backend !== "autobase") throw new Error("ledger-host: this call requires the autobase backend");
	return s;
}

function requireRaw(): RawInstance {
	const s = require_();
	if (s.backend !== "raw") throw new Error("ledger-host: this call requires the raw backend");
	return s;
}

export function isReady(): boolean { return singleton != null; }

export function backendName(): "autobase" | "raw" | "none" {
	return singleton?.backend ?? "none";
}

// ── Storage paths ─────────────────────────────────────────────────

function corestoreDir(): string {
	return process.env.GLON_AUTOBASE_DIR ?? join(homedir(), ".glon", "autobase");
}

function bootstrapKeyFile(): string {
	return join(corestoreDir(), "bootstrap.key");
}

/** Default bootstrap key for the glon auction-house autobase network.
 *  Fresh installs join this network automatically. Users can override via
 *  GLON_AUTOBASE_BOOTSTRAP env or by wiping ~/.glon/autobase/bootstrap.key.
 */
const DEFAULT_BOOTSTRAP_KEY = Buffer.from(
	"61b596909db2e6e0fa87645d79a0764d5ee4cd6a40c4458ba60cc6e86635a86e",
	"hex",
);

function readPersistedBootstrap(): Buffer | null {
	const p = bootstrapKeyFile();
	if (!existsSync(p)) return null;
	try {
		return Buffer.from(readFileSync(p, "utf-8").trim(), "hex");
	} catch {
		return null;
	}
}

function writePersistedBootstrap(key: Buffer): void {
	mkdirSync(corestoreDir(), { recursive: true });
	writeFileSync(bootstrapKeyFile(), key.toString("hex"), { mode: 0o600 });
}

// ── Public API used by programs (through runtime externals) ─────

/** Append an op to the local writer. Returns when the view reflects the
 *  change (autobase: apply has run; raw: incremental or full replay has
 *  applied the new op locally). */
export async function appendOp(op: AuctionOp): Promise<void> {
	const inst = require_();
	if (inst.backend === "autobase") {
		await inst.base.append(JSON.stringify(op));
		await inst.base.update();
	} else {
		await rawAppendAndApply(inst, op);
	}
}

/** Read a key from the view. Returns parsed JSON or null. */
export async function viewGet<T = unknown>(key: string): Promise<T | null> {
	const inst = require_();
	if (inst.backend === "autobase") {
		const node = await inst.view.get(key);
		if (!node) return null;
		const raw = node.value;
		if (raw == null) return null;
		const s = typeof raw === "string" ? raw : raw.toString("utf-8");
		try { return JSON.parse(s) as T; } catch { return null; }
	} else {
		const v = inst.view.get(key);
		if (v === undefined) return null;
		try { return JSON.parse(v) as T; } catch { return null; }
	}
}

/** Iterate keys with a given prefix (e.g. "auction/"). */
export async function viewList<T = unknown>(prefix: string): Promise<Array<{ key: string; value: T }>> {
	const inst = require_();
	const out: Array<{ key: string; value: T }> = [];
	if (inst.backend === "autobase") {
		const upper = prefix + "￿";
		const stream = inst.view.createReadStream({ gte: prefix, lt: upper });
		for await (const node of stream) {
			const raw = node.value;
			const s = typeof raw === "string" ? raw : raw.toString("utf-8");
			try { out.push({ key: node.key.toString("utf-8"), value: JSON.parse(s) as T }); } catch { /* skip */ }
		}
	} else {
		const upper = prefix + "￿";
		const keys = [...inst.view.keys()].filter((k) => k >= prefix && k < upper).sort();
		for (const k of keys) {
			const v = inst.view.get(k);
			if (v === undefined) continue;
			try { out.push({ key: k, value: JSON.parse(v) as T }); } catch { /* skip */ }
		}
	}
	return out;
}

export function getWriterPubkeyHex(): string {
	const inst = require_();
	if (inst.backend === "autobase") return inst.writerPubkey.toString("hex");
	return inst.localCore.key.toString("hex");
}

/** Whether this node can append ops. Autobase: true once admitted as a
 *  writer. Raw: always true (every node owns its own writer hypercore
 *  with no admission step). */
export function isWritable(): boolean {
	if (!singleton) return false;
	if (singleton.backend === "autobase") return singleton.base.writable === true;
	return true;
}

export function getBootstrapKeyHex(): string {
	const inst = require_();
	if (inst.backend === "autobase") return inst.base.key.toString("hex");
	// Raw ledger has no bootstrap key — network identity is the topic, not a key.
	return "";
}

export function statusSnapshot(): {
	bootstrap_key: string;
	writer_pubkey: string;
	view_length: number;
	system_length: number;
	backend?: string;
	known_writers?: number;
} {
	if (!singleton) {
		return { bootstrap_key: "", writer_pubkey: "", view_length: 0, system_length: 0 };
	}
	if (singleton.backend === "autobase") {
		return {
			backend: "autobase",
			bootstrap_key: singleton.base.key.toString("hex"),
			writer_pubkey: singleton.writerPubkey.toString("hex"),
			view_length: singleton.view?.feed?.length ?? 0,
			system_length: singleton.base.length ?? 0,
		};
	}
	// Raw backend
	return {
		backend: "raw",
		bootstrap_key: "",   // no bootstrap key — topic-based network
		writer_pubkey: singleton.localCore.key.toString("hex"),
		view_length: singleton.view.size,
		system_length: singleton.localCore.length ?? 0,
		known_writers: singleton.knownWriters.size + 1,  // +1 for our local writer
	};
}

// ── Daemon lifecycle (NOT used by bundled programs) ─────────────

export interface InitOpts {
	/** Constructed Corestore — daemon imports `corestore` natively and
	 *  passes the instance here, mirroring how the swarm is passed to
	 *  swarm-host.initSwarm. */
	corestore: any;
	/** Constructed Autobase, ready (already awaited .ready()). */
	autobase: any;
	/** The hyperbee view, after open(). */
	view: any;
	/** The 32-byte writer pubkey of this node's local hypercore. */
	writerPubkey: Buffer;
}

export function initAutobase(opts: InitOpts): void {
	if (singleton) throw new Error("ledger-host: already initialized");
	singleton = {
		backend: "autobase",
		base: opts.autobase,
		view: opts.view,
		corestore: opts.corestore,
		writerPubkey: opts.writerPubkey,
	};
}

export async function shutdown(): Promise<void> {
	if (!singleton) return;
	if (singleton.backend === "autobase") {
		try { await singleton.base.close(); } catch { /* best effort */ }
		try { await singleton.corestore.close(); } catch { /* best effort */ }
	} else {
		if (singleton.reapplyTimer) clearTimeout(singleton.reapplyTimer);
		try { await singleton.localCore.close(); } catch { /* best effort */ }
		for (const core of singleton.knownWriters.values()) {
			try { await core.close(); } catch { /* best effort */ }
		}
		try { await singleton.corestore.close(); } catch { /* best effort */ }
	}
	singleton = null;
}

// ── Signature verification ───────────────────────────────────────

/**
 * Canonical bytes for signing: JSON of the op with the `signature` and
 * `id` fields stripped, with object keys sorted lexicographically. This
 * MUST match exactly what auction.ts:signOp produces — otherwise verify
 * will never match what was signed.
 */
export function canonicalSigningBytes(op: Record<string, unknown>): Uint8Array {
	const copy: Record<string, unknown> = {};
	for (const k of Object.keys(op).sort()) {
		if (k === "signature" || k === "id") continue;
		copy[k] = (op as any)[k];
	}
	return new TextEncoder().encode(JSON.stringify(copy));
}

/** Which pubkey field signs each op kind. */
function signerPubkeyHexForOp(op: AuctionOp): string | null {
	switch (op.kind) {
		case "auction.create": return op.seller_pubkey;
		case "auction.bid":    return op.bidder_pubkey;
		case "auction.settle":
		case "auction.cancel":
			// Seller signs both — caller must look up the auction's
			// seller_pubkey from the view at verify time. Returning null
			// here is a signal to the caller to do the lookup.
			return null;
		case "coin.deploy":    return op.owner_pubkey;
		case "coin.mint":
			// Mint must be signed by the token's owner; caller looks up token/<id>.
			return null;
		case "coin.transfer":  return op.from_pubkey;
		case "coin.burn":      return op.from_pubkey;
		case "type.register":  return op.mint_authority_pubkey;
		case "peer.join":      return op.chain_pubkey;
	}
}

/**
 * Verify an op's signature. Returns true on valid, false on tampered/
 * forged/malformed. The view is used to look up seller_pubkey for
 * settle/cancel ops (since those are signed by the original seller,
 * not anyone named in the op itself).
 *
 * Permissive in one specific way: if signature is empty or all-zeros,
 * we return false (no "anonymous" ops allowed in v1). To opt-out of
 * verification entirely during dev, set GLON_AUCTION_SKIP_VERIFY=1
 * in the env; this is for migration of in-flight test data only and
 * MUST be off in production.
 */
export async function verifyOpSignature(op: AuctionOp, view: any): Promise<boolean> {
	if (process.env.GLON_AUCTION_SKIP_VERIFY === "1") return true;
	const sig = (op as any).signature as string | undefined;
	if (!sig || !/^[0-9a-fA-F]{128}$/.test(sig)) return false;

	let signerHex: string | null = signerPubkeyHexForOp(op);
	if (!signerHex && (op.kind === "auction.settle" || op.kind === "auction.cancel")) {
		const auctionRaw = await view.get(`auction/${op.auction_id}`);
		if (!auctionRaw) return false;
		const auction = JSON.parse(typeof auctionRaw.value === "string" ? auctionRaw.value : auctionRaw.value.toString("utf-8"));
		signerHex = auction.seller_pubkey;
	}
	if (!signerHex && op.kind === "coin.mint") {
		const tokenRaw = await view.get(`token/${op.token_id}`);
		if (!tokenRaw) return false;
		const token = JSON.parse(typeof tokenRaw.value === "string" ? tokenRaw.value : tokenRaw.value.toString("utf-8"));
		signerHex = token.owner_pubkey;
	}
	if (!signerHex || !/^[0-9a-fA-F]{64}$/.test(signerHex)) return false;

	const pubkey = Buffer.from(signerHex, "hex");
	const signature = Buffer.from(sig, "hex");
	const message = canonicalSigningBytes(op as unknown as Record<string, unknown>);
	return ed25519Verify(new Uint8Array(pubkey), message, new Uint8Array(signature));
}

// ── Expiry helper ────────────────────────────────────────────────

/**
 * Lazy expiry. If the auction is open and `nowMs >= auction.expiry_ms`,
 * refund the seller's escrowed assets, mark the auction `expired`, and
 * return true. Otherwise return false (no state change).
 *
 * "nowMs" is the timestamp of the op currently being applied — NOT the
 * wall clock. This is what keeps expiry deterministic across nodes:
 * everyone sees the same op stream and uses the same `created_at`
 * values, so everyone computes the same expiry transitions.
 *
 * Safety: an attacker could post an op with a far-future `created_at` to
 * force premature expiry of someone else's auction. The worst case is
 * the seller gets their escrow refunded early — no value is stolen.
 * v2 can tighten this with a max-seen-timestamp gate.
 */
async function tryExpireAuction(view: any, auctionId: string, nowMs: number): Promise<boolean> {
	const auctionRaw = await view.get(`auction/${auctionId}`);
	if (!auctionRaw) return false;
	const auction = JSON.parse(typeof auctionRaw.value === "string" ? auctionRaw.value : auctionRaw.value.toString("utf-8"));
	if (auction.status !== "open") return false;
	if (typeof auction.expiry_ms !== "number" || auction.expiry_ms > nowMs) return false;

	// Refund seller's escrow — same logic as auction.cancel.
	for (const asset of auction.give ?? []) {
		if (asset.object_id) {
			await view.put(`coin/${asset.object_id}`, JSON.stringify({ owner: auction.seller_pubkey }));
		} else if (asset.token && asset.amount) {
			const sellerKey = `balance/${asset.token}/${auction.seller_pubkey}`;
			const sellerRaw = await view.get(sellerKey);
			const sellerBal = sellerRaw ? BigInt(typeof sellerRaw.value === "string" ? sellerRaw.value : sellerRaw.value.toString("utf-8")) : 0n;
			await view.put(sellerKey, (sellerBal + BigInt(asset.amount)).toString());
		}
	}
	auction.status = "expired";
	auction.expired_at = nowMs;
	await view.put(`auction/${auctionId}`, JSON.stringify(auction));
	return true;
}

// ── Apply function (the merge rule) ──────────────────────────────

/**
 * The deterministic apply function — given the linearized stream of ops
 * from all writers' hypercores, mutate the hyperbee view.
 *
 * autobase guarantees:
 *   - all nodes that have replicated the same set of writer hypercores
 *     compute the same view
 *   - on causal forks, autobase reorders + replays apply, so we must
 *     never mutate anything outside `view`
 *
 * Conservation rule (the actual CRDT merge logic):
 *   - "auction.create" with `give` that includes a coin: that coin moves
 *     into escrow at coin/<coin_id> → { escrowed_in: auction_id }. If a
 *     conflicting create lands later, first-applied wins (autobase
 *     ordering decides); the later one's give-escrow attempt fails →
 *     auction is marked invalid → bidders get refunded automatically.
 *
 * This function is exported so it can be imported by the daemon when it
 * constructs the Autobase instance. Programs don't call it directly.
 */
export async function apply(nodes: Array<{ value: Buffer | string; from?: { key: Buffer } }>, view: any, host: any): Promise<void> {
	// Auto-admit new writers: anyone whose ops we see gets added as an
	// indexer. This is the "permissionless" part — no gatekeeping at
	// the autobase layer; conservation is enforced by the per-op logic
	// below. Identity binding (writer key ↔ chain key) is verified inside
	// op handlers via signature checks.
	for (const node of nodes) {
		const raw = node.value;
		const s = typeof raw === "string" ? raw : raw.toString("utf-8");
		let op: AuctionOp;
		try { op = JSON.parse(s) as AuctionOp; }
		catch { continue; /* skip malformed; the writer wasted bytes */ }

		// Signature gate: reject any op whose Ed25519 signature doesn't
		// verify against the claimed signer pubkey. Replayable + pure, so
		// every node computes the same accept/reject set.
		if (!(await verifyOpSignature(op, view))) {
			continue;
		}

		switch (op.kind) {
			case "peer.join": {
				// Open-enrollment: anyone who sends a join op gets added as
				// an indexer. Conservation is enforced per-op, not at the
				// writer-set level, so this is safe — a malicious joiner can
				// write garbage but can't double-spend or fake escrow.
				try {
					const writerKey = Buffer.from(op.writer_pubkey, "hex");
					await host.addWriter(writerKey, { indexer: true });
				} catch { /* already a writer; ignore */ }
				await view.put(`peer/${op.chain_pubkey}/writer`, JSON.stringify({ writer_pubkey: op.writer_pubkey, joined_at: op.created_at }));
				break;
			}
			case "auction.create": {
				const existing = await view.get(`auction/${op.id}`);
				if (existing) break; // id collision; first writer wins
				// Validate expiry: every auction MUST have a future expiry.
				// expiry_ms == created_at counts as already-expired and is rejected.
				let invalidReason: string | null = null;
				if (typeof op.expiry_ms !== "number" || op.expiry_ms <= op.created_at) {
					invalidReason = "invalid_expired_on_creation";
				}
				// Try to escrow each asset in `give`:
				//   - object_id: unique item — check coin/<id> isn't already escrowed
				//   - token+amount: fungible — check seller has the balance
				// If any escrow fails, the auction lands in an invalid_* state and
				// no escrow side-effects are applied.
				if (!invalidReason) for (const asset of op.give) {
					if (asset.object_id) {
						const escrow = await view.get(`coin/${asset.object_id}`);
						if (escrow) { invalidReason = "invalid_double_escrow"; break; }
					} else if (asset.token && asset.amount) {
						const balKey = `balance/${asset.token}/${op.seller_pubkey}`;
						const balRaw = await view.get(balKey);
						const bal = balRaw ? BigInt(typeof balRaw.value === "string" ? balRaw.value : balRaw.value.toString("utf-8")) : 0n;
						if (bal < BigInt(asset.amount)) { invalidReason = "invalid_insufficient_balance"; break; }
					}
				}
				if (!invalidReason) {
					// Apply escrows.
					for (const asset of op.give) {
						if (asset.object_id) {
							await view.put(`coin/${asset.object_id}`, JSON.stringify({ escrowed_in: op.id }));
						} else if (asset.token && asset.amount) {
							const balKey = `balance/${asset.token}/${op.seller_pubkey}`;
							const balRaw = await view.get(balKey);
							const bal = BigInt(typeof balRaw!.value === "string" ? balRaw!.value : balRaw!.value.toString("utf-8"));
							const newBal = bal - BigInt(asset.amount);
							if (newBal === 0n) await view.del(balKey); else await view.put(balKey, newBal.toString());
						}
					}
				}
				// Gifts (recipient set + empty want) atomically auto-settle:
				// the sender's intent is "send X to Y," so we transfer in the
				// same apply pass rather than making the sender call settle
				// later. Fungibles' escrow has already been deducted above;
				// here we credit the recipient. Unique items flip their
				// coin/<id> record from escrowed_in to owner.
				const isAutoSettleGift = !invalidReason
					&& !!op.recipient_pubkey
					&& (!op.want || op.want.length === 0);
				if (isAutoSettleGift) {
					for (const asset of op.give) {
						if (asset.object_id) {
							await view.put(`coin/${asset.object_id}`, JSON.stringify({ owner: op.recipient_pubkey }));
						} else if (asset.token && asset.amount) {
							const recipKey = `balance/${asset.token}/${op.recipient_pubkey}`;
							const recipRaw = await view.get(recipKey);
							const recipBal = recipRaw ? BigInt(typeof recipRaw.value === "string" ? recipRaw.value : recipRaw.value.toString("utf-8")) : 0n;
							await view.put(recipKey, (recipBal + BigInt(asset.amount)).toString());
						}
					}
				}

				await view.put(`auction/${op.id}`, JSON.stringify({
					...op,
					status: invalidReason ?? (isAutoSettleGift ? "settled" : "open"),
					...(isAutoSettleGift ? {
						winner_pubkey: op.recipient_pubkey,
						settled_at: op.created_at,
						settled_payment: [],
						auto_settled_gift: true,
					} : {}),
				}));
				await view.put(`peer/${op.seller_pubkey}/auctions/${op.id}`, JSON.stringify({ id: op.id, created_at: op.created_at }));
				break;
			}
			case "auction.bid": {
				// Lazy-expire any open auction whose deadline has passed by
				// this op's timestamp. After this, status may flip to expired
				// and the bid below is dropped.
				await tryExpireAuction(view, op.auction_id, op.created_at);
				const auctionRaw = await view.get(`auction/${op.auction_id}`);
				if (!auctionRaw) break; // bid on missing auction; ignore
				const auction = JSON.parse(typeof auctionRaw.value === "string" ? auctionRaw.value : auctionRaw.value.toString("utf-8"));
				if (auction.status !== "open") break; // expired/settled/cancelled/invalid — drop bid
				// Bids are stored under the auction; settle-time validation
				// happens in auction.settle.
				await view.put(`auction/${op.auction_id}/bids/${op.bidder_pubkey}/${op.created_at}`, JSON.stringify(op));
				break;
			}
			case "auction.settle": {
				// Lazy-expire first. If the settle op arrives after the
				// deadline, the auction expires and the settle is dropped —
				// seller gets refunded, not the proposed winner.
				await tryExpireAuction(view, op.auction_id, op.created_at);
				const auctionRaw = await view.get(`auction/${op.auction_id}`);
				if (!auctionRaw) break;
				const auction = JSON.parse(typeof auctionRaw.value === "string" ? auctionRaw.value : auctionRaw.value.toString("utf-8"));
				if (auction.status !== "open") break;

				// Determine settle mode:
				//   - gift: recipient_pubkey set + want is empty → no payment expected
				//   - open: want is empty, no recipient → winner pays per THEIR bid's offer
				//   - fixed: want is non-empty → winner pays per auction.want (or per
				//     their bid if seller accepts a different offer via winning_bid_at)
				const wantEmpty = !auction.want || auction.want.length === 0;
				const isGift = wantEmpty && !!auction.recipient_pubkey;
				const isOpen = wantEmpty && !auction.recipient_pubkey;

				// Resolve the payment basket the winner owes.
				let payment: Array<{ token?: string; amount?: string; object_id?: string }> = [];
				if (isGift) {
					payment = [];
				} else if (op.winning_bid_at) {
					// Seller specified a particular winning bid. Look it up.
					const bidRaw = await view.get(`auction/${op.auction_id}/bids/${op.winner_pubkey}/${op.winning_bid_at}`);
					if (!bidRaw) {
						auction.status = "invalid_no_such_bid";
						await view.put(`auction/${op.auction_id}`, JSON.stringify(auction));
						return;
					}
					const bid = JSON.parse(typeof bidRaw.value === "string" ? bidRaw.value : bidRaw.value.toString("utf-8"));
					payment = bid.offer ?? [];
				} else if (isOpen) {
					// Open auction needs an explicit winning_bid_at; no bid → no settle.
					auction.status = "invalid_open_settle_needs_bid";
					await view.put(`auction/${op.auction_id}`, JSON.stringify(auction));
					return;
				} else {
					// Fixed-price: use auction.want as the payment.
					payment = auction.want;
				}

				// Verify the winner has every fungible token they owe.
				for (const w of payment) {
					if (w.token && w.amount) {
						const balKey = `balance/${w.token}/${op.winner_pubkey}`;
						const balRaw = await view.get(balKey);
						const bal = balRaw ? BigInt(typeof balRaw.value === "string" ? balRaw.value : balRaw.value.toString("utf-8")) : 0n;
						if (bal < BigInt(w.amount)) {
							auction.status = "invalid_winner_insufficient_balance";
							await view.put(`auction/${op.auction_id}`, JSON.stringify(auction));
							return;
						}
					}
				}

				// Transfer give[] → winner.
				for (const asset of auction.give) {
					if (asset.object_id) {
						await view.put(`coin/${asset.object_id}`, JSON.stringify({ owner: op.winner_pubkey }));
					} else if (asset.token && asset.amount) {
						const winKey = `balance/${asset.token}/${op.winner_pubkey}`;
						const winRaw = await view.get(winKey);
						const winBal = winRaw ? BigInt(typeof winRaw.value === "string" ? winRaw.value : winRaw.value.toString("utf-8")) : 0n;
						await view.put(winKey, (winBal + BigInt(asset.amount)).toString());
					}
				}

				// Transfer payment[] → seller.
				for (const w of payment) {
					if (w.token && w.amount) {
						const winKey = `balance/${w.token}/${op.winner_pubkey}`;
						const winRaw = await view.get(winKey);
						const winBal = BigInt(typeof winRaw!.value === "string" ? winRaw!.value : winRaw!.value.toString("utf-8"));
						const newWinBal = winBal - BigInt(w.amount);
						if (newWinBal === 0n) await view.del(winKey); else await view.put(winKey, newWinBal.toString());
						const sellerKey = `balance/${w.token}/${auction.seller_pubkey}`;
						const sellerRaw = await view.get(sellerKey);
						const sellerBal = sellerRaw ? BigInt(typeof sellerRaw.value === "string" ? sellerRaw.value : sellerRaw.value.toString("utf-8")) : 0n;
						await view.put(sellerKey, (sellerBal + BigInt(w.amount)).toString());
					}
				}

				auction.status = "settled";
				auction.winner_pubkey = op.winner_pubkey;
				auction.settled_at = op.created_at;
				auction.settled_payment = payment;
				await view.put(`auction/${op.auction_id}`, JSON.stringify(auction));
				break;
			}
			case "auction.cancel": {
				// Lazy-expire first. If the auction already expired by this
				// cancel op's timestamp, tryExpireAuction has already refunded
				// the seller and flipped status to expired. The cancel below
				// becomes a no-op (status !== "open"), which is correct.
				await tryExpireAuction(view, op.auction_id, op.created_at);
				const auctionRaw = await view.get(`auction/${op.auction_id}`);
				if (!auctionRaw) break;
				const auction = JSON.parse(typeof auctionRaw.value === "string" ? auctionRaw.value : auctionRaw.value.toString("utf-8"));
				if (auction.status !== "open") break;
				// Refund escrowed assets to the seller.
				for (const asset of auction.give) {
					if (asset.object_id) {
						await view.put(`coin/${asset.object_id}`, JSON.stringify({ owner: auction.seller_pubkey }));
					} else if (asset.token && asset.amount) {
						const sellerKey = `balance/${asset.token}/${auction.seller_pubkey}`;
						const sellerRaw = await view.get(sellerKey);
						const sellerBal = sellerRaw ? BigInt(typeof sellerRaw.value === "string" ? sellerRaw.value : sellerRaw.value.toString("utf-8")) : 0n;
						await view.put(sellerKey, (sellerBal + BigInt(asset.amount)).toString());
					}
				}
				auction.status = "cancelled";
				auction.cancelled_at = op.created_at;
				await view.put(`auction/${op.auction_id}`, JSON.stringify(auction));
				break;
			}
			case "coin.deploy": {
				const existing = await view.get(`token/${op.token_id}`);
				if (existing) break;
				await view.put(`token/${op.token_id}`, JSON.stringify(op));
				// Credit initial supply to the owner.
				await view.put(`balance/${op.token_id}/${op.owner_pubkey}`, op.supply);
				break;
			}
			case "coin.mint": {
				const tokenRaw = await view.get(`token/${op.token_id}`);
				if (!tokenRaw) break;
				const token = JSON.parse(typeof tokenRaw.value === "string" ? tokenRaw.value : tokenRaw.value.toString("utf-8"));
				if (token.mint_renounced) break; // mint authority gave up the right to mint
				const recipientKey = `balance/${op.token_id}/${op.to_pubkey}`;
				const current = await view.get(recipientKey);
				const currentBal = current ? BigInt(typeof current.value === "string" ? current.value : current.value.toString("utf-8")) : 0n;
				await view.put(recipientKey, (currentBal + BigInt(op.amount)).toString());
				// Bump supply on the token entry for accurate display.
				token.supply = (BigInt(token.supply) + BigInt(op.amount)).toString();
				await view.put(`token/${op.token_id}`, JSON.stringify(token));
				break;
			}
			case "coin.transfer": {
				const fromKey = `balance/${op.token_id}/${op.from_pubkey}`;
				const toKey   = `balance/${op.token_id}/${op.to_pubkey}`;
				const fromRaw = await view.get(fromKey);
				if (!fromRaw) break; // no balance to spend from
				const fromBal = BigInt(typeof fromRaw.value === "string" ? fromRaw.value : fromRaw.value.toString("utf-8"));
				const amt = BigInt(op.amount);
				if (fromBal < amt) break; // insufficient — conservation enforced
				const newFromBal = fromBal - amt;
				if (newFromBal === 0n) await view.del(fromKey); else await view.put(fromKey, newFromBal.toString());
				const toRaw = await view.get(toKey);
				const toBal = toRaw ? BigInt(typeof toRaw.value === "string" ? toRaw.value : toRaw.value.toString("utf-8")) : 0n;
				await view.put(toKey, (toBal + amt).toString());
				break;
			}
			case "coin.burn": {
				const fromKey = `balance/${op.token_id}/${op.from_pubkey}`;
				const fromRaw = await view.get(fromKey);
				if (!fromRaw) break;
				const fromBal = BigInt(typeof fromRaw.value === "string" ? fromRaw.value : fromRaw.value.toString("utf-8"));
				const amt = BigInt(op.amount);
				if (fromBal < amt) break;
				const newBal = fromBal - amt;
				if (newBal === 0n) await view.del(fromKey); else await view.put(fromKey, newBal.toString());
				const tokenRaw = await view.get(`token/${op.token_id}`);
				if (tokenRaw) {
					const token = JSON.parse(typeof tokenRaw.value === "string" ? tokenRaw.value : tokenRaw.value.toString("utf-8"));
					token.supply = (BigInt(token.supply) - amt).toString();
					await view.put(`token/${op.token_id}`, JSON.stringify(token));
				}
				break;
			}
			case "type.register": {
				const existing = await view.get(`type/${op.type_key}`);
				if (existing) break; // first-write-wins on namespaces
				await view.put(`type/${op.type_key}`, JSON.stringify(op));
				break;
			}
		}

		// Auto-admit the writer:
		//   - ackWriter so optimistic blocks from non-writers are accepted into the view.
		//   - addWriter to graduate them to a permanent indexer for future blocks.
		// Both are idempotent.
		if (node.from?.key) {
			try { await host.ackWriter(node.from.key); }
			catch { /* ignore — already acked */ }
			try { await host.addWriter(node.from.key, { indexer: true }); }
			catch { /* already a writer; ignore */ }
		}
	}
}

// ── Bootstrap-key helpers exposed to the daemon ──────────────────

/** Read the persisted bootstrap key. Falls back to the hardcoded default
 *  so fresh installs join the shared glon auction-house network. */
export function loadPersistedBootstrap(): Buffer | null {
	const persisted = readPersistedBootstrap();
	if (persisted) return persisted;
	return DEFAULT_BOOTSTRAP_KEY;
}

/** Persist a bootstrap key (called by daemon after first-time init). */
export function persistBootstrap(key: Buffer): void {
	writePersistedBootstrap(key);
}

/** Where the corestore lives on disk. Daemon needs this to construct Corestore. */
export function getCorestoreDir(): string {
	return corestoreDir();
}

// ══════════════════════════════════════════════════════════════════
// RAW BACKEND — multi-writer CRDT over raw hypercores, no autobase.
// ══════════════════════════════════════════════════════════════════
//
// Each node has its own writer hypercore. Other writers' cores are
// discovered (eventually, by Phase 2's swarm layer) and added to the
// local corestore for replication. The view is computed by sorting all
// known writers' ops by (created_at, writer_pubkey_hex, seq) and
// running the existing `apply()` function over that ordered stream.
//
// Persistence:
//   ~/.glon/ledger/corestore/   — all hypercores (mine + replicated peers')
//   ~/.glon/ledger/peers.json   — array of known peer writer pubkeys (hex)
//
// The view is in-memory only. It's rebuilt from the hypercores on every
// cold start. Losing the view on crash is fine — the hypercores are the
// source of truth.

function rawStorageDir(): string {
	return process.env.GLON_LEDGER_DIR ?? join(homedir(), ".glon", "ledger");
}

function rawCorestoreDir(): string {
	return join(rawStorageDir(), "corestore");
}

function rawRegistryFile(): string {
	return join(rawStorageDir(), "peers.json");
}

function loadPeerRegistry(): string[] {
	const p = rawRegistryFile();
	if (!existsSync(p)) return [];
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8"));
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch { return []; }
}

function savePeerRegistry(peers: string[]): void {
	mkdirSync(rawStorageDir(), { recursive: true });
	writeFileSync(rawRegistryFile(), JSON.stringify(peers, null, 2));
}

export interface InitRawOpts {
	corestore: any;     // Constructed Corestore, ready()-ed
	localCore: any;     // The local writer hypercore (already ready())
	knownWriters?: string[];  // Optional list of peer pubkey hexes to load
}

/** Initialize the raw multi-writer backend. Daemon calls this when
 *  GLON_RAW_LEDGER=1. After this call, the public API (appendOp,
 *  viewGet, etc.) operates in raw mode. */
export async function initRawLedger(opts: InitRawOpts): Promise<void> {
	if (singleton) throw new Error("ledger-host: already initialized");
	const knownWritersList = opts.knownWriters ?? loadPeerRegistry();
	const knownWriters = new Map<string, any>();
	for (const hex of knownWritersList) {
		if (!/^[0-9a-fA-F]{64}$/.test(hex)) continue;
		try {
			const core = opts.corestore.get({ key: Buffer.from(hex, "hex") });
			await core.ready();
			knownWriters.set(hex.toLowerCase(), core);
		} catch (err: any) {
			console.warn(`[ledger-host:raw] couldn't open peer core ${hex.slice(0, 12)}…: ${err?.message ?? err}`);
		}
	}
	const inst: RawInstance = {
		backend: "raw",
		corestore: opts.corestore,
		localCore: opts.localCore,
		knownWriters,
		view: new Map<string, string>(),
		highestSeenTs: 0,
		registryFile: rawRegistryFile(),
		reapplyTimer: null,
		reapplyInFlight: null,
		storageDir: rawStorageDir(),
	};
	singleton = inst;
	// Subscribe to local core appends + each peer core's appends so we
	// know when to re-apply.
	const wireAppendListener = (core: any) => {
		core.on("append", () => scheduleReapply(inst));
	};
	wireAppendListener(opts.localCore);
	for (const core of knownWriters.values()) wireAppendListener(core);
	// Initial replay to populate view from on-disk state.
	await rawRunFullReplay(inst);
}

/** Add a peer's writer hypercore to the replication set. Daemon's swarm
 *  layer (Phase 2) calls this when it discovers a new writer. The peer
 *  is persisted to disk so we keep replicating it across daemon restarts. */
export async function addKnownWriter(pubkeyHex: string): Promise<void> {
	const inst = requireRaw();
	pubkeyHex = pubkeyHex.toLowerCase();
	if (!/^[0-9a-fA-F]{64}$/.test(pubkeyHex)) throw new Error("invalid pubkey");
	if (inst.knownWriters.has(pubkeyHex)) return;
	const core = inst.corestore.get({ key: Buffer.from(pubkeyHex, "hex") });
	await core.ready();
	core.on("append", () => scheduleReapply(inst));
	inst.knownWriters.set(pubkeyHex, core);
	// Persist.
	const list = [...inst.knownWriters.keys()];
	savePeerRegistry(list);
	scheduleReapply(inst);
}

/** Append op to local writer, then either apply incrementally (fast path)
 *  or trigger a full replay (slow path, reorg). */
async function rawAppendAndApply(inst: RawInstance, op: AuctionOp): Promise<void> {
	const ts = (op as any).created_at ?? 0;
	await inst.localCore.append(JSON.stringify(op));
	if (ts > inst.highestSeenTs) {
		// Fast path — strictly newer than everything we've applied; just
		// apply this single op on top of the current view.
		await rawApplySingle(inst, op);
		inst.highestSeenTs = ts;
	} else {
		// Slow path — reorg required. Do a full replay so this op lands
		// at its correct position relative to existing ops.
		await rawRunFullReplay(inst);
	}
}

/** Apply one op against the current view, without touching state from
 *  other writers. Caller is responsible for ordering guarantees (fast
 *  path only). */
async function rawApplySingle(inst: RawInstance, op: AuctionOp): Promise<void> {
	const viewShim = makeMapViewShim(inst.view);
	const hostShim = makeNoopHostShim();
	const node = { value: JSON.stringify(op), from: { key: inst.localCore.key } };
	await apply([node], viewShim, hostShim);
}

/** Collect all ops from every writer hypercore, sort deterministically,
 *  clear the view, and re-run apply from scratch. Called on cold start
 *  and on any reorg (out-of-order op or new peer writer joined). */
async function rawRunFullReplay(inst: RawInstance): Promise<void> {
	if (inst.reapplyInFlight) {
		// Coalesce: there's already a replay running. Caller can await
		// the existing promise. We schedule one more just in case there
		// were appends between the current pass and now.
		await inst.reapplyInFlight;
		return;
	}
	inst.reapplyInFlight = (async () => {
		const ops: Array<{ op: AuctionOp; writerHex: string; seq: number }> = [];
		const cores: Array<[string, any]> = [
			[inst.localCore.key.toString("hex").toLowerCase(), inst.localCore],
			...inst.knownWriters,
		];
		for (const [hex, core] of cores) {
			const len = core.length ?? 0;
			for (let i = 0; i < len; i++) {
				let block;
				try { block = await core.get(i); } catch { continue; }
				if (!block) continue;
				const s = typeof block === "string" ? block : block.toString("utf-8");
				let op: AuctionOp;
				try { op = JSON.parse(s) as AuctionOp; } catch { continue; }
				ops.push({ op, writerHex: hex, seq: i });
			}
		}
		// Deterministic ordering: timestamp first, then writer pubkey lex,
		// then sequence inside that writer.
		ops.sort((a, b) => {
			const ta = (a.op as any).created_at ?? 0;
			const tb = (b.op as any).created_at ?? 0;
			if (ta !== tb) return ta - tb;
			if (a.writerHex !== b.writerHex) return a.writerHex < b.writerHex ? -1 : 1;
			return a.seq - b.seq;
		});
		// Reset view + replay.
		inst.view.clear();
		inst.highestSeenTs = 0;
		const viewShim = makeMapViewShim(inst.view);
		const hostShim = makeNoopHostShim();
		const nodes = ops.map((o) => ({
			value: JSON.stringify(o.op),
			from: { key: Buffer.from(o.writerHex, "hex") },
		}));
		await apply(nodes, viewShim, hostShim);
		// Recompute highestSeenTs.
		for (const o of ops) {
			const t = (o.op as any).created_at ?? 0;
			if (t > inst.highestSeenTs) inst.highestSeenTs = t;
		}
	})();
	try {
		await inst.reapplyInFlight;
	} finally {
		inst.reapplyInFlight = null;
	}
}

/** Debounced re-apply scheduler. Multiple triggers within 50ms coalesce
 *  into one full replay. */
function scheduleReapply(inst: RawInstance): void {
	if (inst.reapplyTimer) return;
	inst.reapplyTimer = setTimeout(() => {
		inst.reapplyTimer = null;
		rawRunFullReplay(inst).catch((err: any) => {
			console.error(`[ledger-host:raw] reapply failed: ${err?.message ?? err}`);
		});
	}, 50);
}

/** Hyperbee-shape proxy backed by a JS Map. Lets the existing apply()
 *  function work without any modification. */
function makeMapViewShim(map: Map<string, string>): any {
	return {
		async get(key: string) {
			const v = map.get(key);
			return v === undefined ? null : { key, value: v };
		},
		async put(key: string, value: any) {
			const s = typeof value === "string" ? value : value.toString("utf-8");
			map.set(key, s);
		},
		async del(key: string) {
			map.delete(key);
		},
		createReadStream(opts: { gte: string; lt?: string }) {
			const { gte, lt } = opts;
			const keys = [...map.keys()].filter((k) => k >= gte && (!lt || k < lt)).sort();
			async function* gen() {
				for (const k of keys) yield { key: k, value: map.get(k)! };
			}
			return gen();
		},
	};
}

/** Apply expects a `host` arg with addWriter/ackWriter for the autobase
 *  flow. In raw mode there's no writer set, so these are no-ops. */
function makeNoopHostShim(): any {
	return {
		async addWriter(_key: Buffer, _opts?: any) { /* noop */ },
		async ackWriter(_key: Buffer) { /* noop */ },
		async removeWriter(_key: Buffer) { /* noop */ },
	};
}

/** Helper for daemon: where the raw corestore lives on disk. */
export function getRawCorestoreDir(): string {
	return rawCorestoreDir();
}
