/**
 * autobase-host — daemon-side ownership of the auction-house autobase.
 *
 * Why this module exists: same reason as swarm-host. corestore/autobase/
 * hyperbee pull in native deps (sodium-native at minimum) that esbuild
 * can't bundle into a string-evaluated program. The daemon owns the
 * autobase instance and exposes a tiny API surface through runtime
 * externals so bundled programs (`/auction`) can read/write the log.
 *
 * Programs that need autobase access import like:
 *
 *   import { appendOp, getView, getWriterPubkeyHex } from "../autobase-host.js";
 *
 * The bundler resolves "autobase-host.js" to this module's exports via
 * the runtime externals map.
 *
 * Threading & state: everything lives on the Node event loop. Autobase
 * runs `apply` whenever new nodes arrive; we install a single apply
 * function that dispatches op-kind → handler.
 *
 * Persistence: `~/.glon/autobase/` holds the corestore. The autobase
 * bootstrap key is generated once (first run) and persisted; subsequent
 * starts load the same base. When/if we want a canonical glon-mainnet
 * later, the founder commits their bootstrap pubkey to `src/genesis.ts`
 * and clients pass it via env to bootstrap from there.
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

// ── Singleton state ───────────────────────────────────────────────

interface AutobaseInstance {
	base: any;                      // Autobase instance — typed via structural minimum below
	view: any;                      // Hyperbee
	corestore: any;
	writerPubkey: Buffer;
}

let singleton: AutobaseInstance | null = null;

function require_(): AutobaseInstance {
	if (!singleton) {
		throw new Error("autobase-host: initAutobase() has not been called yet");
	}
	return singleton;
}

export function isReady(): boolean { return singleton != null; }

// ── Storage paths ─────────────────────────────────────────────────

function corestoreDir(): string {
	return process.env.GLON_AUTOBASE_DIR ?? join(homedir(), ".glon", "autobase");
}

function bootstrapKeyFile(): string {
	return join(corestoreDir(), "bootstrap.key");
}

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

/** Append an op to the local writer hypercore. Returns when the autobase
 *  has applied it locally (view reflects the change). Throws if autobase
 *  isn't initialized or if the underlying append fails. */
export async function appendOp(op: AuctionOp): Promise<void> {
	const inst = require_();
	await inst.base.append(JSON.stringify(op));
	// `update()` is idempotent; it gives apply a chance to run.
	await inst.base.update();
}

/** Read a key from the hyperbee view. Returns parsed JSON or null. */
export async function viewGet<T = unknown>(key: string): Promise<T | null> {
	const inst = require_();
	const node = await inst.view.get(key);
	if (!node) return null;
	const raw = node.value;
	if (raw == null) return null;
	const s = typeof raw === "string" ? raw : raw.toString("utf-8");
	try { return JSON.parse(s) as T; } catch { return null; }
}

/** Iterate keys with a given prefix (e.g. "auction/") — returns an array
 *  for simplicity at MVP scale. Switch to async iterator if we ever care
 *  about large auction-list pagination. */
export async function viewList<T = unknown>(prefix: string): Promise<Array<{ key: string; value: T }>> {
	const inst = require_();
	const out: Array<{ key: string; value: T }> = [];
	const upper = prefix + "￿";
	const stream = inst.view.createReadStream({ gte: prefix, lt: upper });
	for await (const node of stream) {
		const raw = node.value;
		const s = typeof raw === "string" ? raw : raw.toString("utf-8");
		try { out.push({ key: node.key.toString("utf-8"), value: JSON.parse(s) as T }); } catch { /* skip malformed */ }
	}
	return out;
}

export function getWriterPubkeyHex(): string {
	return require_().writerPubkey.toString("hex");
}

/** Whether this node's autobase writer has been admitted (can append ops). */
export function isWritable(): boolean {
	if (!singleton) return false;
	return singleton.base.writable === true;
}

export function getBootstrapKeyHex(): string {
	return require_().base.key.toString("hex");
}

export function statusSnapshot(): {
	bootstrap_key: string;
	writer_pubkey: string;
	view_length: number;
	system_length: number;
} {
	if (!singleton) {
		return { bootstrap_key: "", writer_pubkey: "", view_length: 0, system_length: 0 };
	}
	return {
		bootstrap_key: singleton.base.key.toString("hex"),
		writer_pubkey: singleton.writerPubkey.toString("hex"),
		view_length: singleton.view?.feed?.length ?? 0,
		system_length: singleton.base.length ?? 0,
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
	if (singleton) throw new Error("autobase-host: already initialized");
	singleton = {
		base: opts.autobase,
		view: opts.view,
		corestore: opts.corestore,
		writerPubkey: opts.writerPubkey,
	};
}

export async function shutdown(): Promise<void> {
	if (!singleton) return;
	try { await singleton.base.close(); } catch { /* best effort */ }
	try { await singleton.corestore.close(); } catch { /* best effort */ }
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
				await view.put(`auction/${op.id}`, JSON.stringify({
					...op,
					status: invalidReason ?? "open",
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
				// Two flavors:
				//   - has want[] (a real trade): winner pays `want` to seller, gets `give`
				//   - empty want[] (a gift):     winner just receives `give` (no payment)
				const isGift = !auction.want || auction.want.length === 0;
				// Check winner has the `want` balance (if any).
				if (!isGift) {
					for (const w of auction.want) {
						if (w.token && w.amount) {
							const balKey = `balance/${w.token}/${op.winner_pubkey}`;
							const balRaw = await view.get(balKey);
							const bal = balRaw ? BigInt(typeof balRaw.value === "string" ? balRaw.value : balRaw.value.toString("utf-8")) : 0n;
							if (bal < BigInt(w.amount)) {
								auction.status = "invalid_winner_insufficient_balance";
								await view.put(`auction/${op.auction_id}`, JSON.stringify(auction));
								return; // bail — no transfers
							}
						}
					}
				}
				// Settle: transfer `give` to winner, `want` from winner to seller.
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
				if (!isGift) {
					for (const w of auction.want) {
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
				}
				auction.status = "settled";
				auction.winner_pubkey = op.winner_pubkey;
				auction.settled_at = op.created_at;
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

/** Read the persisted bootstrap key (hex string) or null. */
export function loadPersistedBootstrap(): Buffer | null {
	return readPersistedBootstrap();
}

/** Persist a bootstrap key (called by daemon after first-time init). */
export function persistBootstrap(key: Buffer): void {
	writePersistedBootstrap(key);
}

/** Where the corestore lives on disk. Daemon needs this to construct Corestore. */
export function getCorestoreDir(): string {
	return corestoreDir();
}
