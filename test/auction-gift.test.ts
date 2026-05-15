// Gift auto-settle test.
//
// A gift = auction.create with `recipient_pubkey` set AND `want` empty.
// Apply transfers the give[] atomically on creation — no separate
// auction.settle op required. The auction record exists in the view
// (status=settled, auto_settled_gift=true) so the AH ledger has a
// transparent trail of every gift.

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

const tmpDirs: string[] = [];

function openView(store: any) {
	return new Hyperbee(store.get("auction-view"), {
		keyEncoding: "utf-8",
		valueEncoding: "utf-8",
	});
}

async function makeNode() {
	const dir = mkdtempSync(join(tmpdir(), "glon-gift-"));
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

describe("gift auto-settle (recipient + empty want)", () => {
	after(() => {
		for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
		tmpDirs.length = 0;
	});

	it("fungible gift transfers atomically on a single auction.create op", async () => {
		const A = await makeNode();
		const alice = newSigner();
		const bob = newSigner();

		// Alice deploys 1000 FIG.
		const deployCore = {
			kind: "coin.deploy" as const,
			name: "Figgies", symbol: "FIG", decimals: 0,
			supply: "1000", owner_pubkey: alice.pubkeyHex, mint_renounced: false, created_at: 1,
		};
		const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
		const deployOp = { ...deployCore, token_id: tokenId };
		await A.base.append(JSON.stringify({ ...deployOp, signature: signOp(deployOp, alice) }));

		// One op: alice gifts 250 FIG to bob.
		const giftOp = {
			kind: "auction.create" as const,
			id: "gift-fig-to-bob",
			seller_pubkey: alice.pubkeyHex,
			recipient_pubkey: bob.pubkeyHex,
			give: [{ token: tokenId, amount: "250" }],
			want: [],
			expiry_ms: 1_000_000,
			created_at: 10,
		};
		await A.base.append(JSON.stringify({ ...giftOp, signature: signOp(giftOp, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		// After the single op, balances should be updated.
		assert.equal(await balanceOf(A.base, tokenId, alice.pubkeyHex), "750");
		assert.equal(await balanceOf(A.base, tokenId, bob.pubkeyHex), "250");

		// The auction record exists and is settled.
		const a = await viewParse<any>(A.base, "auction/gift-fig-to-bob");
		assert.equal(a.status, "settled");
		assert.equal(a.winner_pubkey, bob.pubkeyHex);
		assert.equal(a.auto_settled_gift, true);
		assert.equal(a.settled_at, 10);

		await A.base.close(); await A.store.close();
	});

	it("unique-item gift flips ownership atomically", async () => {
		const A = await makeNode();
		const alice = newSigner();
		const bob = newSigner();

		const giftOp = {
			kind: "auction.create" as const,
			id: "gift-sword",
			seller_pubkey: alice.pubkeyHex,
			recipient_pubkey: bob.pubkeyHex,
			give: [{ object_id: "legendary-sword" }],
			want: [],
			expiry_ms: 1_000_000,
			created_at: 1,
		};
		await A.base.append(JSON.stringify({ ...giftOp, signature: signOp(giftOp, alice) }));
		await new Promise((r) => setTimeout(r, 100));
		await A.base.update();

		// coin/<id> should have owner=bob, NOT escrowed_in.
		const coin = await viewParse<any>(A.base, "coin/legendary-sword");
		assert.equal(coin.owner, bob.pubkeyHex);
		assert.equal(coin.escrowed_in, undefined);

		const a = await viewParse<any>(A.base, "auction/gift-sword");
		assert.equal(a.status, "settled");
		assert.equal(a.auto_settled_gift, true);

		await A.base.close(); await A.store.close();
	});

	it("non-gift auctions (no recipient OR non-empty want) do NOT auto-settle", async () => {
		// Regression: auto-settle must only kick in for true gifts.
		const A = await makeNode();
		const alice = newSigner();

		const deployCore = {
			kind: "coin.deploy" as const,
			name: "Figgies", symbol: "FIG", decimals: 0,
			supply: "100", owner_pubkey: alice.pubkeyHex, mint_renounced: false, created_at: 1,
		};
		const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
		const deployOp = { ...deployCore, token_id: tokenId };
		await A.base.append(JSON.stringify({ ...deployOp, signature: signOp(deployOp, alice) }));

		// Open auction: no recipient, no want.
		const openOp = {
			kind: "auction.create" as const,
			id: "open-no-recipient",
			seller_pubkey: alice.pubkeyHex,
			give: [{ token: tokenId, amount: "10" }],
			want: [],
			expiry_ms: 1_000_000,
			created_at: 2,
		};
		await A.base.append(JSON.stringify({ ...openOp, signature: signOp(openOp, alice) }));
		await new Promise((r) => setTimeout(r, 50));
		await A.base.update();

		const a = await viewParse<any>(A.base, "auction/open-no-recipient");
		assert.equal(a.status, "open", "no recipient → not a gift → must stay open");
		assert.equal(a.auto_settled_gift, undefined);

		await A.base.close(); await A.store.close();
	});

	it("gift fails cleanly when seller lacks balance — no transfer, no settle", async () => {
		const A = await makeNode();
		const alice = newSigner();
		const bob = newSigner();

		// Alice has zero FIG (never deployed). Try to gift 50.
		const giftOp = {
			kind: "auction.create" as const,
			id: "gift-broke",
			seller_pubkey: alice.pubkeyHex,
			recipient_pubkey: bob.pubkeyHex,
			give: [{ token: "abcdef0123456789abcdef0123456789", amount: "50" }],
			want: [],
			expiry_ms: 1_000_000,
			created_at: 1,
		};
		await A.base.append(JSON.stringify({ ...giftOp, signature: signOp(giftOp, alice) }));
		await new Promise((r) => setTimeout(r, 50));
		await A.base.update();

		const a = await viewParse<any>(A.base, "auction/gift-broke");
		assert.equal(a.status, "invalid_insufficient_balance");
		assert.equal(await balanceOf(A.base, "abcdef0123456789abcdef0123456789", bob.pubkeyHex), "0");

		await A.base.close(); await A.store.close();
	});
});
