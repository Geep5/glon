// Balance-aware coin operations + auction lifecycle.
//
// Exercises the full autobase-native /coin: deploy → mint → transfer →
// balance/holders queries, plus an auction settle that actually moves
// fungible balances.
//
// No Hyperswarm involved — exercises the apply function directly.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import Autobase from "autobase";
import Hyperbee from "hyperbee";
import {
	apply,
	canonicalSigningBytes,
} from "../src/autobase-host.ts";
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
	const dir = mkdtempSync(join(tmpdir(), "glon-coin-"));
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

/** Stable token id derivation, matching /coin handler. */
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

describe("coin operations on the autobase", () => {
	after(() => {
		for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
		tmpDirs.length = 0;
	});

	it("deploy credits the full supply to the owner", async () => {
		const A = await makeNode();
		const alice = newSigner();

		const opCore = {
			kind: "coin.deploy" as const,
			name: "Figgies",
			symbol: "FIG",
			decimals: 0,
			supply: "1000000",
			owner_pubkey: alice.pubkeyHex,
			mint_renounced: false,
			created_at: Date.now(),
		};
		const tokenId = deriveTokenId(opCore as Record<string, unknown>);
		const opNoSig = { ...opCore, token_id: tokenId };
		await A.base.append(JSON.stringify({ ...opNoSig, signature: signOp(opNoSig, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		assert.equal(await balanceOf(A.base, tokenId, alice.pubkeyHex), "1000000");
		const token = await viewParse<any>(A.base, `token/${tokenId}`);
		assert.equal(token.symbol, "FIG");
		assert.equal(token.owner_pubkey, alice.pubkeyHex);

		await A.base.close(); await A.store.close();
	});

	it("transfer moves balance and conserves supply", async () => {
		const A = await makeNode();
		const alice = newSigner();
		const bob = newSigner();

		// Deploy 100 FIG to Alice
		const deployCore = {
			kind: "coin.deploy" as const,
			name: "Figgies", symbol: "FIG", decimals: 0,
			supply: "100", owner_pubkey: alice.pubkeyHex, mint_renounced: false,
			created_at: 1,
		};
		const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
		const deployOp = { ...deployCore, token_id: tokenId };
		await A.base.append(JSON.stringify({ ...deployOp, signature: signOp(deployOp, alice) }));

		// Alice transfers 30 to Bob
		const xferOp = {
			kind: "coin.transfer" as const,
			token_id: tokenId,
			from_pubkey: alice.pubkeyHex,
			to_pubkey: bob.pubkeyHex,
			amount: "30",
			created_at: 2,
		};
		await A.base.append(JSON.stringify({ ...xferOp, signature: signOp(xferOp, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		assert.equal(await balanceOf(A.base, tokenId, alice.pubkeyHex), "70");
		assert.equal(await balanceOf(A.base, tokenId, bob.pubkeyHex), "30");

		await A.base.close(); await A.store.close();
	});

	it("rejects a transfer for more than the sender's balance", async () => {
		const A = await makeNode();
		const alice = newSigner();
		const bob = newSigner();

		const deployCore = {
			kind: "coin.deploy" as const, name: "Figgies", symbol: "FIG", decimals: 0,
			supply: "10", owner_pubkey: alice.pubkeyHex, mint_renounced: false, created_at: 1,
		};
		const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
		const deployOp = { ...deployCore, token_id: tokenId };
		await A.base.append(JSON.stringify({ ...deployOp, signature: signOp(deployOp, alice) }));

		// Alice tries to transfer 50 — only has 10
		const xferOp = {
			kind: "coin.transfer" as const, token_id: tokenId,
			from_pubkey: alice.pubkeyHex, to_pubkey: bob.pubkeyHex, amount: "50", created_at: 2,
		};
		await A.base.append(JSON.stringify({ ...xferOp, signature: signOp(xferOp, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		// Balances unchanged.
		assert.equal(await balanceOf(A.base, tokenId, alice.pubkeyHex), "10");
		assert.equal(await balanceOf(A.base, tokenId, bob.pubkeyHex), "0");

		await A.base.close(); await A.store.close();
	});

	it("mint credits new supply (owner only) and bumps supply", async () => {
		const A = await makeNode();
		const alice = newSigner();
		const bob = newSigner();
		const attacker = newSigner();

		const deployCore = {
			kind: "coin.deploy" as const, name: "Figgies", symbol: "FIG", decimals: 0,
			supply: "100", owner_pubkey: alice.pubkeyHex, mint_renounced: false, created_at: 1,
		};
		const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
		const deployOp = { ...deployCore, token_id: tokenId };
		await A.base.append(JSON.stringify({ ...deployOp, signature: signOp(deployOp, alice) }));

		// Owner (alice) mints 50 to bob.
		const mintOp = { kind: "coin.mint" as const, token_id: tokenId, to_pubkey: bob.pubkeyHex, amount: "50", created_at: 2 };
		await A.base.append(JSON.stringify({ ...mintOp, signature: signOp(mintOp, alice) }));

		// Attacker tries to mint without authority — must be rejected.
		const forgedMint = { kind: "coin.mint" as const, token_id: tokenId, to_pubkey: attacker.pubkeyHex, amount: "9999", created_at: 3 };
		await A.base.append(JSON.stringify({ ...forgedMint, signature: signOp(forgedMint, attacker) }));

		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		assert.equal(await balanceOf(A.base, tokenId, bob.pubkeyHex), "50");
		assert.equal(await balanceOf(A.base, tokenId, attacker.pubkeyHex), "0", "forged mint must not credit attacker");
		const token = await viewParse<any>(A.base, `token/${tokenId}`);
		assert.equal(token.supply, "150");

		await A.base.close(); await A.store.close();
	});

	it("full auction lifecycle: post escrows seller, settle pays winner + credits seller", async () => {
		const A = await makeNode();
		const alice = newSigner();    // seller, owner of FIG
		const bob = newSigner();      // buyer

		// Deploy 1000 FIG to alice; mint 500 GLD to alice.
		const figDeploy = {
			kind: "coin.deploy" as const, name: "Figgies", symbol: "FIG", decimals: 0,
			supply: "1000", owner_pubkey: alice.pubkeyHex, mint_renounced: false, created_at: 1,
		};
		const figId = deriveTokenId(figDeploy as Record<string, unknown>);
		const figOp = { ...figDeploy, token_id: figId };
		await A.base.append(JSON.stringify({ ...figOp, signature: signOp(figOp, alice) }));

		const gldDeploy = {
			kind: "coin.deploy" as const, name: "Gold", symbol: "GLD", decimals: 0,
			supply: "500", owner_pubkey: alice.pubkeyHex, mint_renounced: false, created_at: 2,
		};
		const gldId = deriveTokenId(gldDeploy as Record<string, unknown>);
		const gldOp = { ...gldDeploy, token_id: gldId };
		await A.base.append(JSON.stringify({ ...gldOp, signature: signOp(gldOp, alice) }));

		// Give bob 200 FIG to bid with.
		const xferToBob = {
			kind: "coin.transfer" as const, token_id: figId,
			from_pubkey: alice.pubkeyHex, to_pubkey: bob.pubkeyHex, amount: "200", created_at: 3,
		};
		await A.base.append(JSON.stringify({ ...xferToBob, signature: signOp(xferToBob, alice) }));

		// Alice posts auction: 100 GLD for 150 FIG.
		const auctionCore = {
			kind: "auction.create" as const,
			id: "auction-fig-for-gld",
			seller_pubkey: alice.pubkeyHex,
			give: [{ token: gldId, amount: "100" }],
			want: [{ token: figId, amount: "150" }],
			expiry_ms: Date.now() + 60_000,
			created_at: 4,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		// Alice's GLD escrowed: 500 - 100 = 400.
		assert.equal(await balanceOf(A.base, gldId, alice.pubkeyHex), "400");
		const auctionStatus = (await viewParse<any>(A.base, `auction/${auctionCore.id}`)).status;
		assert.equal(auctionStatus, "open");

		// Alice settles in favor of bob (production path would be after bob.bid).
		const settleOp = {
			kind: "auction.settle" as const,
			auction_id: auctionCore.id,
			winner_pubkey: bob.pubkeyHex,
			created_at: 5,
		};
		await A.base.append(JSON.stringify({ ...settleOp, signature: signOp(settleOp, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		// Bob gets 100 GLD; Alice gets back her escrow PLUS 150 FIG from Bob.
		assert.equal(await balanceOf(A.base, gldId, bob.pubkeyHex), "100");
		assert.equal(await balanceOf(A.base, gldId, alice.pubkeyHex), "400", "alice's GLD escrow stays out");
		assert.equal(await balanceOf(A.base, figId, bob.pubkeyHex), "50", "bob paid 150 FIG of his 200");
		assert.equal(await balanceOf(A.base, figId, alice.pubkeyHex), "950", "alice got 800 + 150 from settle");
		const settled = await viewParse<any>(A.base, `auction/${auctionCore.id}`);
		assert.equal(settled.status, "settled");
		assert.equal(settled.winner_pubkey, bob.pubkeyHex);

		await A.base.close(); await A.store.close();
	});

	it("auction cancel refunds the seller's escrow", async () => {
		const A = await makeNode();
		const alice = newSigner();

		const deployCore = {
			kind: "coin.deploy" as const, name: "Figgies", symbol: "FIG", decimals: 0,
			supply: "500", owner_pubkey: alice.pubkeyHex, mint_renounced: false, created_at: 1,
		};
		const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
		const deployOp = { ...deployCore, token_id: tokenId };
		await A.base.append(JSON.stringify({ ...deployOp, signature: signOp(deployOp, alice) }));

		const auctionCore = {
			kind: "auction.create" as const,
			id: "auction-cancel-test",
			seller_pubkey: alice.pubkeyHex,
			give: [{ token: tokenId, amount: "100" }],
			want: [{ object_id: "imaginary-sword" }],
			expiry_ms: Date.now() + 60_000,
			created_at: 2,
		};
		await A.base.append(JSON.stringify({ ...auctionCore, signature: signOp(auctionCore, alice) }));
		await new Promise((r) => setTimeout(r, 50));
		await A.base.update();
		assert.equal(await balanceOf(A.base, tokenId, alice.pubkeyHex), "400");

		const cancelOp = {
			kind: "auction.cancel" as const,
			auction_id: auctionCore.id,
			created_at: 3,
		};
		await A.base.append(JSON.stringify({ ...cancelOp, signature: signOp(cancelOp, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		assert.equal(await balanceOf(A.base, tokenId, alice.pubkeyHex), "500", "cancel refunds full escrow");
		const cancelled = await viewParse<any>(A.base, `auction/${auctionCore.id}`);
		assert.equal(cancelled.status, "cancelled");

		await A.base.close(); await A.store.close();
	});
});
