// Auction expiry tests.
//
// Covers:
//   1. auction.create with expiry_ms <= created_at lands as invalid_expired_on_creation
//   2. Bid arriving after expiry triggers lazy-expire and is dropped
//   3. Settle arriving after expiry refunds seller, no transfer happens
//   4. Cancel after expiry is idempotent (already cleaned up)

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import Autobase from "autobase";
import Hyperbee from "hyperbee";
import { apply, canonicalSigningBytes } from "../src/autobase-host.ts";
import { generateKeyPair, sign as ed25519Sign } from "../src/det/ed25519.ts";
import { hexEncode, sha256 } from "../src/crypto.ts";
import { parseDuration } from "../src/programs/handlers/auction.ts";

const tmpDirs: string[] = [];

function openView(store: any) {
	return new Hyperbee(store.get("auction-view"), {
		keyEncoding: "utf-8",
		valueEncoding: "utf-8",
	});
}

async function makeNode() {
	const dir = mkdtempSync(join(tmpdir(), "glon-expiry-"));
	tmpDirs.push(dir);
	const store = new Corestore(dir);
	await store.ready();
	const base = new Autobase(store, null, { open: openView, apply, ackInterval: 100 });
	await base.ready();
	return { store, base };
}

function newSigner() {
	const kp = generateKeyPair();
	return { ...kp, pubkeyHex: hexEncode(kp.publicKey) };
}

function signOp(op: Record<string, unknown>, signer: ReturnType<typeof newSigner>): string {
	return hexEncode(ed25519Sign(signer.privateKey, canonicalSigningBytes(op)));
}

function deriveTokenId(opNoIdNoSig: Record<string, unknown>): string {
	return hexEncode(sha256(canonicalSigningBytes(opNoIdNoSig))).slice(0, 32);
}

async function viewParse<T = any>(base: any, key: string): Promise<T | null> {
	const node = await base.view.get(key);
	if (!node) return null;
	const s = typeof node.value === "string" ? node.value : node.value.toString("utf-8");
	try { return JSON.parse(s) as T; } catch { return null; }
}

async function balanceOf(base: any, tokenId: string, pubkey: string): Promise<string> {
	const node = await base.view.get(`balance/${tokenId}/${pubkey}`);
	if (!node) return "0";
	return typeof node.value === "string" ? node.value : node.value.toString("utf-8");
}

/** Deploy a FIG token to alice; return tokenId + alice signer. */
async function setupAlice(base: any, supply = "1000") {
	const alice = newSigner();
	const deployCore = {
		kind: "coin.deploy" as const,
		name: "Figgies", symbol: "FIG", decimals: 0,
		supply, owner_pubkey: alice.pubkeyHex, mint_renounced: false, created_at: 1,
	};
	const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
	const deployOp = { ...deployCore, token_id: tokenId };
	await base.append(JSON.stringify({ ...deployOp, signature: signOp(deployOp, alice) }));
	await new Promise((r) => setTimeout(r, 50));
	await base.update();
	return { alice, tokenId };
}

describe("parseDuration", () => {
	it("parses common forms", () => {
		assert.equal(parseDuration("30m"), 30 * 60_000);
		assert.equal(parseDuration("1h"),  60 * 60_000);
		assert.equal(parseDuration("2d"),  2 * 86_400_000);
		assert.equal(parseDuration("45s"), 45_000);
		assert.equal(parseDuration("500ms"), 500);
		assert.equal(parseDuration("1000"), 1000);
	});
	it("returns null on bad input", () => {
		assert.equal(parseDuration("forever"), null);
		assert.equal(parseDuration("-1h"), null);
		assert.equal(parseDuration("0h"), null);
		assert.equal(parseDuration("1.5h"), null);
		assert.equal(parseDuration(""), null);
	});
});

describe("auction expiry enforcement", () => {
	after(() => {
		for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
		tmpDirs.length = 0;
	});

	it("auction.create with expiry_ms <= created_at lands as invalid_expired_on_creation", async () => {
		const A = await makeNode();
		const { alice, tokenId } = await setupAlice(A.base);

		const auctionCore = {
			kind: "auction.create" as const,
			id: "expired-on-creation",
			seller_pubkey: alice.pubkeyHex,
			give: [{ token: tokenId, amount: "10" }],
			want: [{ token: "GLD", amount: "5" }],
			expiry_ms: 1000,        // same as created_at → invalid
			created_at: 1000,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));
		await new Promise((r) => setTimeout(r, 50));
		await A.base.update();

		const a = await viewParse<any>(A.base, `auction/${auctionCore.id}`);
		assert.equal(a.status, "invalid_expired_on_creation");
		// Escrow NOT applied — alice still has full supply.
		assert.equal(await balanceOf(A.base, tokenId, alice.pubkeyHex), "1000");

		await A.base.close(); await A.store.close();
	});

	it("bid arriving after expiry triggers lazy-expire; seller is refunded; bid dropped", async () => {
		const A = await makeNode();
		const { alice, tokenId } = await setupAlice(A.base);
		const bob = newSigner();

		// Auction expires at t=2000; bid at t=3000 (1s after expiry).
		const auctionCore = {
			kind: "auction.create" as const,
			id: "late-bid-test",
			seller_pubkey: alice.pubkeyHex,
			give: [{ token: tokenId, amount: "100" }],
			want: [{ token: "GLD", amount: "50" }],
			expiry_ms: 2000,
			created_at: 1000,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));
		// Confirm escrow happened.
		await new Promise((r) => setTimeout(r, 50));
		await A.base.update();
		assert.equal(await balanceOf(A.base, tokenId, alice.pubkeyHex), "900");

		// Bid AFTER expiry.
		const bidOp = {
			kind: "auction.bid" as const,
			auction_id: "late-bid-test",
			bidder_pubkey: bob.pubkeyHex,
			offer: [{ token: "GLD", amount: "50" }],
			created_at: 3000,
		};
		await A.base.append(JSON.stringify({ ...bidOp, signature: signOp(bidOp, bob) }));
		await new Promise((r) => setTimeout(r, 50));
		await A.base.update();

		const a = await viewParse<any>(A.base, `auction/late-bid-test`);
		assert.equal(a.status, "expired");
		assert.equal(a.expired_at, 3000);
		// Seller refunded.
		assert.equal(await balanceOf(A.base, tokenId, alice.pubkeyHex), "1000");
		// Bid NOT recorded.
		const bidNode = await A.base.view.get(`auction/late-bid-test/bids/${bob.pubkeyHex}/3000`);
		assert.equal(bidNode, null, "late bid must not be recorded");

		await A.base.close(); await A.store.close();
	});

	it("settle arriving after expiry refunds seller; no transfer happens", async () => {
		const A = await makeNode();
		const { alice, tokenId } = await setupAlice(A.base);
		const bob = newSigner();

		// Give bob some GLD so he COULD afford the settle (but won't get to).
		const gldDeploy = {
			kind: "coin.deploy" as const,
			name: "Gold", symbol: "GLD", decimals: 0,
			supply: "500", owner_pubkey: bob.pubkeyHex, mint_renounced: false, created_at: 1,
		};
		const gldId = deriveTokenId(gldDeploy as Record<string, unknown>);
		const gldOp = { ...gldDeploy, token_id: gldId };
		await A.base.append(JSON.stringify({ ...gldOp, signature: signOp(gldOp, bob) }));

		const auctionCore = {
			kind: "auction.create" as const,
			id: "late-settle-test",
			seller_pubkey: alice.pubkeyHex,
			give: [{ token: tokenId, amount: "100" }],
			want: [{ token: gldId, amount: "50" }],
			expiry_ms: 2000,
			created_at: 1000,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));

		// Late settle.
		const settleOp = {
			kind: "auction.settle" as const,
			auction_id: "late-settle-test",
			winner_pubkey: bob.pubkeyHex,
			created_at: 5000,
		};
		await A.base.append(JSON.stringify({ ...settleOp, signature: signOp(settleOp, alice) }));
		await new Promise((r) => setTimeout(r, 50));
		await A.base.update();

		const a = await viewParse<any>(A.base, `auction/late-settle-test`);
		assert.equal(a.status, "expired");
		// No transfer of FIG to bob.
		assert.equal(await balanceOf(A.base, tokenId, bob.pubkeyHex), "0");
		// Alice refunded.
		assert.equal(await balanceOf(A.base, tokenId, alice.pubkeyHex), "1000");
		// Bob's GLD untouched (no payment).
		assert.equal(await balanceOf(A.base, gldId, bob.pubkeyHex), "500");

		await A.base.close(); await A.store.close();
	});

	it("bid arriving BEFORE expiry is recorded normally", async () => {
		// Regression: make sure the expiry gate doesn't reject in-window bids.
		const A = await makeNode();
		const { alice, tokenId } = await setupAlice(A.base);
		const bob = newSigner();

		const auctionCore = {
			kind: "auction.create" as const,
			id: "in-window-bid",
			seller_pubkey: alice.pubkeyHex,
			give: [{ token: tokenId, amount: "10" }],
			want: [{ token: "GLD", amount: "5" }],
			expiry_ms: 10_000,
			created_at: 1000,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));

		const bidOp = {
			kind: "auction.bid" as const,
			auction_id: "in-window-bid",
			bidder_pubkey: bob.pubkeyHex,
			offer: [{ token: "GLD", amount: "5" }],
			created_at: 5000,
		};
		await A.base.append(JSON.stringify({ ...bidOp, signature: signOp(bidOp, bob) }));
		await new Promise((r) => setTimeout(r, 50));
		await A.base.update();

		const a = await viewParse<any>(A.base, `auction/in-window-bid`);
		assert.equal(a.status, "open");
		const bidNode = await A.base.view.get(`auction/in-window-bid/bids/${bob.pubkeyHex}/5000`);
		assert.notEqual(bidNode, null, "in-window bid must be recorded");

		await A.base.close(); await A.store.close();
	});
});
