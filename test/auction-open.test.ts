// Open auction + basket-bid tests.
//
// Open auction = auction.create with empty want[] and NO recipient.
// Bidders propose any tokens (or a basket of them); seller picks a
// specific bid via winning_bid_at. Apply charges the winner the contents
// of THAT bid's offer[].

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import Autobase from "autobase";
import Hyperbee from "hyperbee";
import { apply, canonicalSigningBytes } from "../src/ledger-host.ts";
import { generateKeyPair, sign as ed25519Sign } from "../src/det/ed25519.ts";
import { hexEncode, sha256 } from "../src/crypto.ts";

const tmpDirs: string[] = [];

function openView(store: any) {
	return new Hyperbee(store.get("auction-view"), {
		keyEncoding: "utf-8",
		valueEncoding: "utf-8",
	});
}

async function makeNode() {
	const dir = mkdtempSync(join(tmpdir(), "glon-open-"));
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

async function balanceOf(base: any, tokenId: string, pubkey: string): Promise<string> {
	const node = await base.view.get(`balance/${tokenId}/${pubkey}`);
	if (!node) return "0";
	return typeof node.value === "string" ? node.value : node.value.toString("utf-8");
}

async function viewParse<T = any>(base: any, key: string): Promise<T | null> {
	const node = await base.view.get(key);
	if (!node) return null;
	const s = typeof node.value === "string" ? node.value : node.value.toString("utf-8");
	try { return JSON.parse(s) as T; } catch { return null; }
}

async function deployToken(base: any, signer: ReturnType<typeof newSigner>, supply: string, symbol = "FIG", createdAt = 1) {
	const deployCore = {
		kind: "coin.deploy" as const,
		name: symbol, symbol, decimals: 0,
		supply, owner_pubkey: signer.pubkeyHex, mint_renounced: false, created_at: createdAt,
	};
	const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
	const deployOp = { ...deployCore, token_id: tokenId };
	await base.append(JSON.stringify({ ...deployOp, signature: signOp(deployOp, signer) }));
	return tokenId;
}

describe("open auctions (empty want, no recipient)", () => {
	after(() => {
		for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
		tmpDirs.length = 0;
	});

	it("seller settles using winning_bid_at; winner pays per their bid's offer", async () => {
		const A = await makeNode();
		const alice = newSigner();   // seller, owns FIG and the item
		const bob = newSigner();     // bidder with GLD
		const carol = newSigner();   // bidder with DIA

		// Alice owns the give-asset (a sword). Deploy GLD to bob and DIA to carol.
		const gldId = await deployToken(A.base, bob, "1000", "GLD", 1);
		const diaId = await deployToken(A.base, carol, "100", "DIA", 2);

		// Alice posts an OPEN auction for sword-007 (no want, no recipient).
		const auctionCore = {
			kind: "auction.create" as const,
			id: "open-sword-007",
			seller_pubkey: alice.pubkeyHex,
			give: [{ object_id: "sword-007" }],
			want: [],
			expiry_ms: 1_000_000,
			created_at: 10,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));

		// Both bid with whatever they want.
		const bobBid = {
			kind: "auction.bid" as const,
			auction_id: "open-sword-007",
			bidder_pubkey: bob.pubkeyHex,
			offer: [{ token: gldId, amount: "200" }],
			created_at: 100,
		};
		await A.base.append(JSON.stringify({ ...bobBid, signature: signOp(bobBid, bob) }));

		const carolBid = {
			kind: "auction.bid" as const,
			auction_id: "open-sword-007",
			bidder_pubkey: carol.pubkeyHex,
			offer: [{ token: diaId, amount: "5" }],
			created_at: 200,
		};
		await A.base.append(JSON.stringify({ ...carolBid, signature: signOp(carolBid, carol) }));

		await new Promise((r) => setTimeout(r, 50));
		await A.base.update();

		// Alice settles in favor of Bob (taking GLD).
		const settleOp = {
			kind: "auction.settle" as const,
			auction_id: "open-sword-007",
			winner_pubkey: bob.pubkeyHex,
			winning_bid_at: 100,
			created_at: 300,
		};
		await A.base.append(JSON.stringify({ ...settleOp, signature: signOp(settleOp, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		const settled = await viewParse<any>(A.base, "auction/open-sword-007");
		assert.equal(settled.status, "settled");
		assert.equal(settled.winner_pubkey, bob.pubkeyHex);
		// Alice now owns 200 GLD.
		assert.equal(await balanceOf(A.base, gldId, alice.pubkeyHex), "200");
		// Bob's GLD dropped by 200.
		assert.equal(await balanceOf(A.base, gldId, bob.pubkeyHex), "800");
		// Carol's DIA is untouched (her bid wasn't accepted).
		assert.equal(await balanceOf(A.base, diaId, carol.pubkeyHex), "100");
		// Sword now owned by Bob.
		const coin = await viewParse<any>(A.base, `coin/sword-007`);
		assert.equal(coin?.owner, bob.pubkeyHex);

		await A.base.close(); await A.store.close();
	});

	it("open settle without winning_bid_at fails (invalid_open_settle_needs_bid)", async () => {
		const A = await makeNode();
		const alice = newSigner();

		const auctionCore = {
			kind: "auction.create" as const,
			id: "open-no-bid",
			seller_pubkey: alice.pubkeyHex,
			give: [{ object_id: "rare-item" }],
			want: [],
			expiry_ms: 1_000_000,
			created_at: 1,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));

		// Try to settle without specifying a bid.
		const settleOp = {
			kind: "auction.settle" as const,
			auction_id: "open-no-bid",
			winner_pubkey: alice.pubkeyHex, // anyone
			created_at: 2,
			// no winning_bid_at
		};
		await A.base.append(JSON.stringify({ ...settleOp, signature: signOp(settleOp, alice) }));
		await new Promise((r) => setTimeout(r, 50));
		await A.base.update();

		const a = await viewParse<any>(A.base, "auction/open-no-bid");
		assert.equal(a.status, "invalid_open_settle_needs_bid");
		// Item is still escrowed in this auction (no settle, no transfer).
		const coin = await viewParse<any>(A.base, `coin/rare-item`);
		assert.equal(coin?.escrowed_in, "open-no-bid");
		assert.equal(coin?.owner, undefined, "item must not have flipped to a new owner");

		await A.base.close(); await A.store.close();
	});

	it("basket bid: bidder offers multiple tokens at once; all transfer on settle", async () => {
		const A = await makeNode();
		const alice = newSigner();
		const bob = newSigner();

		// Bob owns 500 of two tokens.
		const tokA = await deployToken(A.base, bob, "500", "GLD", 1);
		const tokB = await deployToken(A.base, bob, "500", "RUB", 2);

		const auctionCore = {
			kind: "auction.create" as const,
			id: "basket-bid-test",
			seller_pubkey: alice.pubkeyHex,
			give: [{ object_id: "shiny-helm" }],
			want: [],
			expiry_ms: 1_000_000,
			created_at: 10,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));

		// Bob's bid is a basket: 100 GLD + 50 RUB.
		const bid = {
			kind: "auction.bid" as const,
			auction_id: "basket-bid-test",
			bidder_pubkey: bob.pubkeyHex,
			offer: [
				{ token: tokA, amount: "100" },
				{ token: tokB, amount: "50" },
			],
			created_at: 100,
		};
		await A.base.append(JSON.stringify({ ...bid, signature: signOp(bid, bob) }));

		const settleOp = {
			kind: "auction.settle" as const,
			auction_id: "basket-bid-test",
			winner_pubkey: bob.pubkeyHex,
			winning_bid_at: 100,
			created_at: 200,
		};
		await A.base.append(JSON.stringify({ ...settleOp, signature: signOp(settleOp, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		assert.equal(await balanceOf(A.base, tokA, bob.pubkeyHex), "400");
		assert.equal(await balanceOf(A.base, tokA, alice.pubkeyHex), "100");
		assert.equal(await balanceOf(A.base, tokB, bob.pubkeyHex), "450");
		assert.equal(await balanceOf(A.base, tokB, alice.pubkeyHex), "50");

		await A.base.close(); await A.store.close();
	});

	it("gift (want=[] + recipient set) still works — no payment expected", async () => {
		// Regression: make sure splitting open from gift didn't break gifts.
		const A = await makeNode();
		const alice = newSigner();
		const bob = newSigner();

		const tokId = await deployToken(A.base, alice, "100", "FIG", 1);

		const auctionCore = {
			kind: "auction.create" as const,
			id: "gift-test",
			seller_pubkey: alice.pubkeyHex,
			recipient_pubkey: bob.pubkeyHex,
			give: [{ token: tokId, amount: "30" }],
			want: [],
			expiry_ms: 1_000_000,
			created_at: 10,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));

		const settleOp = {
			kind: "auction.settle" as const,
			auction_id: "gift-test",
			winner_pubkey: bob.pubkeyHex,
			created_at: 20,
			// no winning_bid_at — gift mode doesn't need one
		};
		await A.base.append(JSON.stringify({ ...settleOp, signature: signOp(settleOp, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		assert.equal(await balanceOf(A.base, tokId, bob.pubkeyHex), "30");
		assert.equal(await balanceOf(A.base, tokId, alice.pubkeyHex), "70");

		await A.base.close(); await A.store.close();
	});

	it("fixed-price auction with winning_bid_at override: seller accepts counter-offer", async () => {
		// Alice posts "sword for 100 FIG". Bob counter-offers 200 GLD (different token).
		// Alice settles accepting Bob's counter-offer via winning_bid_at.
		const A = await makeNode();
		const alice = newSigner();
		const bob = newSigner();

		const gldId = await deployToken(A.base, bob, "300", "GLD", 1);
		const figId = await deployToken(A.base, alice, "500", "FIG", 2);

		const auctionCore = {
			kind: "auction.create" as const,
			id: "counter-offer-test",
			seller_pubkey: alice.pubkeyHex,
			give: [{ object_id: "sword-99" }],
			want: [{ token: figId, amount: "100" }],
			expiry_ms: 1_000_000,
			created_at: 10,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));

		// Bob counter-bids with 200 GLD.
		const bid = {
			kind: "auction.bid" as const,
			auction_id: "counter-offer-test",
			bidder_pubkey: bob.pubkeyHex,
			offer: [{ token: gldId, amount: "200" }],
			created_at: 100,
		};
		await A.base.append(JSON.stringify({ ...bid, signature: signOp(bid, bob) }));

		// Alice accepts Bob's counter (overriding her posted want).
		const settleOp = {
			kind: "auction.settle" as const,
			auction_id: "counter-offer-test",
			winner_pubkey: bob.pubkeyHex,
			winning_bid_at: 100,
			created_at: 200,
		};
		await A.base.append(JSON.stringify({ ...settleOp, signature: signOp(settleOp, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		// Alice gets 200 GLD (not 100 FIG); Bob gets the sword.
		assert.equal(await balanceOf(A.base, gldId, alice.pubkeyHex), "200");
		assert.equal(await balanceOf(A.base, gldId, bob.pubkeyHex), "100");
		const coin = await viewParse<any>(A.base, "coin/sword-99");
		assert.equal(coin?.owner, bob.pubkeyHex);

		await A.base.close(); await A.store.close();
	});
});
