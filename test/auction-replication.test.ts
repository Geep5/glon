// Two-node autobase replication test.
//
// Spins up two in-memory corestores, points node B at node A's autobase
// bootstrap key, pipes their replication streams, and verifies that:
//   1. An op appended on A propagates to B's view.
//   2. B can also append (via optimistic mode) and A picks it up.
//   3. Conflicting ops from A and B converge to the same final view on
//      both sides (the CRDT property).
//
// No Hyperswarm involved — this exercises the autobase merge logic and
// the apply function in src/autobase-host.ts directly. The real-network
// integration test will use Hyperswarm in a separate file.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import Autobase from "autobase";
import Hyperbee from "hyperbee";
import { apply, canonicalSigningBytes, type AuctionCreateOp } from "../src/autobase-host.ts";
import { generateKeyPair, sign as ed25519Sign } from "../src/det/ed25519.ts";
import { hexEncode } from "../src/crypto.ts";

interface SignerKey { publicKey: Uint8Array; privateKey: Uint8Array; pubkeyHex: string; }
function newSigner(): SignerKey {
	const kp = generateKeyPair();
	return { ...kp, pubkeyHex: hexEncode(kp.publicKey) };
}
function signOpForTest(op: Record<string, unknown>, signer: SignerKey): string {
	const bytes = canonicalSigningBytes(op);
	return hexEncode(ed25519Sign(signer.privateKey, bytes));
}

const tmpDirs: string[] = [];

function openView(store: any) {
	return new Hyperbee(store.get("auction-view"), {
		keyEncoding: "utf-8",
		valueEncoding: "utf-8",
	});
}

async function makeNode(bootstrap: Buffer | null) {
	const dir = mkdtempSync(join(tmpdir(), "glon-test-"));
	tmpDirs.push(dir);
	const store = new Corestore(dir);
	await store.ready();
	const base = new Autobase(store, bootstrap, {
		open: openView,
		apply,
		optimistic: true,
		ackInterval: 100,
	});
	await base.ready();
	return { store, base, dir };
}

function cleanupDirs(): void {
	for (const d of tmpDirs) {
		try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
	}
	tmpDirs.length = 0;
}

function pipeReplication(storeA: any, storeB: any) {
	const a = storeA.replicate(true);
	const b = storeB.replicate(false);
	a.pipe(b).pipe(a);
	return { a, b };
}

/** Wait until `pred()` returns truthy, polling at `intervalMs`. */
async function waitFor<T>(pred: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 5000, intervalMs = 50): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await pred();
		if (v) return v;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function makeCreateOp(signer: SignerKey, overrides: Partial<AuctionCreateOp> = {}): AuctionCreateOp {
	const opNoSig = {
		kind: "auction.create" as const,
		id: overrides.id ?? "test-auction-1",
		seller_pubkey: overrides.seller_pubkey ?? signer.pubkeyHex,
		give: overrides.give ?? [{ object_id: "sword-1" }],
		want: overrides.want ?? [{ token: "FIG", amount: "10" }],
		expiry_ms: overrides.expiry_ms ?? Date.now() + 60_000,
		created_at: overrides.created_at ?? Date.now(),
		recipient_pubkey: overrides.recipient_pubkey,
	};
	return { ...opNoSig, signature: signOpForTest(opNoSig, signer) };
}

function makeJoinOp(signer: SignerKey, writerKeyHex: string): Record<string, unknown> {
	const opNoSig = {
		kind: "peer.join" as const,
		writer_pubkey: writerKeyHex,
		chain_pubkey: signer.pubkeyHex,
		created_at: Date.now(),
	};
	return { ...opNoSig, signature: signOpForTest(opNoSig, signer) };
}

describe("autobase replication (two tmpdir-backed nodes)", () => {
	after(() => cleanupDirs());

	it("propagates an op from A to B's view", async () => {
		const A = await makeNode(null);
		const B = await makeNode(A.base.key);
		const streams = pipeReplication(A.store, B.store);
		const sellerA = newSigner();

		const op = makeCreateOp(sellerA, { id: "auction-from-a" });
		await A.base.append(JSON.stringify(op));

		// Let replication + apply settle on B.
		const view = await waitFor(async () => {
			await B.base.update();
			const node = await B.base.view.get("auction/auction-from-a");
			return node ? node : null;
		}, 5000);

		const value = JSON.parse(typeof view.value === "string" ? view.value : view.value.toString("utf-8"));
		assert.equal(value.id, "auction-from-a");
		assert.equal(value.status, "open");
		assert.equal(value.give[0].object_id, "sword-1");

		streams.a.destroy(); streams.b.destroy();
		await A.base.close(); await B.base.close();
		await A.store.close(); await B.store.close();
	});

	it("a new peer joins via peer.join and then writes auctions A sees", async () => {
		// "Permissionless join": B sends a peer.join op via A (using A as
		// a transient bootstrap rendezvous). A's apply auto-admits B as
		// an indexer. After that, B writes auctions directly and they
		// propagate back to A.
		const A = await makeNode(null);
		const B = await makeNode(A.base.key);
		const streams = pipeReplication(A.store, B.store);
		const sellerB = newSigner();

		// A appends the join on B's behalf — in production this would be
		// an out-of-band gossip protocol where any existing writer relays
		// a join op for a new peer. The join is signed by B's chain key
		// so apply can prove the joiner actually consented.
		await A.base.append(JSON.stringify(makeJoinOp(sellerB, B.base.local.key.toString("hex"))));

		// Wait for B to learn it's a writer.
		await waitFor(async () => {
			await B.base.update();
			return B.base.writable ? true : null;
		}, 5000);

		// Now B can write a normal auction.
		const op = makeCreateOp(sellerB, { id: "auction-from-b", give: [{ object_id: "shield-1" }] });
		await B.base.append(JSON.stringify(op));

		const view = await waitFor(async () => {
			await A.base.update();
			const node = await A.base.view.get("auction/auction-from-b");
			return node ? node : null;
		}, 5000);

		const value = JSON.parse(typeof view.value === "string" ? view.value : view.value.toString("utf-8"));
		assert.equal(value.id, "auction-from-b");
		assert.equal(value.status, "open");

		streams.a.destroy(); streams.b.destroy();
		await A.base.close(); await B.base.close();
		await A.store.close(); await B.store.close();
	});

	it("conflict on same coin resolves deterministically across both nodes", async () => {
		// Both A and B post auctions trying to escrow the same item.
		// Autobase deterministically orders the writes; both nodes apply
		// the same merge rule and must compute the same outcome.
		const A = await makeNode(null);
		const B = await makeNode(A.base.key);
		const streams = pipeReplication(A.store, B.store);
		const sellerA = newSigner();
		const sellerB = newSigner();

		// Admit B as a writer first (founder bootstraps the peer).
		await A.base.append(JSON.stringify(makeJoinOp(sellerB, B.base.local.key.toString("hex"))));
		await waitFor(async () => { await B.base.update(); return B.base.writable ? true : null; }, 5000);

		// Both append a conflicting auction.
		const opFromA = makeCreateOp(sellerA, { id: "auction-a", give: [{ object_id: "contested-orb" }], created_at: 1_000 });
		const opFromB = makeCreateOp(sellerB, { id: "auction-b", give: [{ object_id: "contested-orb" }], created_at: 2_000 });
		await Promise.all([
			A.base.append(JSON.stringify(opFromA)),
			B.base.append(JSON.stringify(opFromB)),
		]);

		// Wait until both sides have both auctions in their view.
		await waitFor(async () => {
			await A.base.update();
			await B.base.update();
			const a1 = await A.base.view.get("auction/auction-a");
			const a2 = await A.base.view.get("auction/auction-b");
			const b1 = await B.base.view.get("auction/auction-a");
			const b2 = await B.base.view.get("auction/auction-b");
			return a1 && a2 && b1 && b2 ? true : null;
		}, 5000);

		const aA = JSON.parse((await A.base.view.get("auction/auction-a")).value);
		const aB = JSON.parse((await A.base.view.get("auction/auction-b")).value);
		const bA = JSON.parse((await B.base.view.get("auction/auction-a")).value);
		const bB = JSON.parse((await B.base.view.get("auction/auction-b")).value);

		assert.equal(aA.status, bA.status, "A's view of auction-a must equal B's view of auction-a");
		assert.equal(aB.status, bB.status, "A's view of auction-b must equal B's view of auction-b");

		const statuses = [aA.status, aB.status].sort();
		assert.deepEqual(statuses, ["invalid_double_escrow", "open"], `expected one open + one invalid, got ${JSON.stringify(statuses)}`);

		streams.a.destroy(); streams.b.destroy();
		await A.base.close(); await B.base.close();
		await A.store.close(); await B.store.close();
	});

	it("rejects a forged op whose signature doesn't verify", async () => {
		// Alice signs an auction, then the attacker tampers with `want.amount`
		// to lower the price. The signature no longer matches the canonical
		// bytes → apply skips the op → no record appears in the view.
		const A = await makeNode(null);
		const sellerA = newSigner();
		const op = makeCreateOp(sellerA, { id: "auction-forged", want: [{ token: "FIG", amount: "1000" }] });

		// Tamper: bidder is trying to convince the ledger that Alice was
		// asking for only 1 FIG instead of 1000.
		const tampered = { ...op, want: [{ token: "FIG", amount: "1" }] };

		await A.base.append(JSON.stringify(tampered));
		await new Promise((r) => setTimeout(r, 200));
		await A.base.update();

		const node = await A.base.view.get("auction/auction-forged");
		assert.equal(node, null, "tampered op must not be applied to the view");

		await A.base.close(); await A.store.close();
	});

	it("rejects an op with an empty/missing signature", async () => {
		const A = await makeNode(null);
		const op = {
			kind: "auction.create",
			id: "auction-unsigned",
			seller_pubkey: "a".repeat(64),
			give: [{ object_id: "sword-x" }],
			want: [{ token: "FIG", amount: "1" }],
			expiry_ms: Date.now() + 60_000,
			signature: "", // empty
			created_at: Date.now(),
		};
		await A.base.append(JSON.stringify(op));
		await new Promise((r) => setTimeout(r, 200));
		await A.base.update();

		const node = await A.base.view.get("auction/auction-unsigned");
		assert.equal(node, null, "unsigned op must not be applied to the view");

		await A.base.close(); await A.store.close();
	});
});
