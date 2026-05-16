// Real Hyperswarm replication test.
//
// Spins up a localhost DHT testnet (no public network involved), creates
// two Hyperswarm instances pointed at that testnet, and verifies that
// two autobases discover each other via the DHT and replicate their
// hypercores end-to-end.
//
// This is the strongest possible proof of the "two strangers find each
// other on Hyperswarm and trade" property, short of running on the real
// public DHT. The piped-stream test in auction-replication.test.ts
// validates the merge logic; this one validates the network plumbing.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import Autobase from "autobase";
import Hyperbee from "hyperbee";
import Hyperswarm from "hyperswarm";
import createTestnet from "hyperdht/testnet.js";
import { apply, canonicalSigningBytes, type AuctionCreateOp } from "../src/ledger-host.ts";
import { generateKeyPair, sign as ed25519Sign } from "../src/det/ed25519.ts";
import { hexEncode } from "../src/crypto.ts";

function newSigner() {
	const kp = generateKeyPair();
	return { ...kp, pubkeyHex: hexEncode(kp.publicKey) };
}
function signOpForTest(op: Record<string, unknown>, signer: ReturnType<typeof newSigner>): string {
	return hexEncode(ed25519Sign(signer.privateKey, canonicalSigningBytes(op)));
}

const tmpDirs: string[] = [];
const swarms: any[] = [];

function openView(store: any) {
	return new Hyperbee(store.get("auction-view"), {
		keyEncoding: "utf-8",
		valueEncoding: "utf-8",
	});
}

async function makeNode(bootstrap: Buffer | null, dhtBootstrap: any[]) {
	const dir = mkdtempSync(join(tmpdir(), "glon-hs-test-"));
	tmpDirs.push(dir);
	const store = new Corestore(dir);
	await store.ready();
	const base = new Autobase(store, bootstrap, {
		open: openView,
		apply,
		ackInterval: 100,
	});
	await base.ready();

	const swarm = new Hyperswarm({ bootstrap: dhtBootstrap });
	swarm.on("connection", (conn: any) => {
		store.replicate(conn);
	});
	swarm.join(base.discoveryKey, { server: true, client: true });
	await swarm.flush();
	swarms.push(swarm);

	return { store, base, swarm, dir };
}

async function waitFor<T>(pred: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await pred();
		if (v) return v;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function cleanup() {
	for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
	tmpDirs.length = 0;
}

describe("autobase replication over real Hyperswarm (localhost DHT)", () => {
	after(async () => {
		for (const s of swarms) {
			try { await s.destroy(); } catch { /* */ }
		}
		swarms.length = 0;
		cleanup();
	});

	it("two nodes find each other via DHT and replicate an auction op", async () => {
		// 3-node DHT testnet — enough for routing/discovery to work.
		const testnet = await createTestnet(3, { teardown: () => {} });

		const A = await makeNode(null, testnet.bootstrap);
		const B = await makeNode(A.base.key, testnet.bootstrap);
		const sellerB = newSigner();

		// A admits B as a writer (founder bootstraps). Join is signed by B's
		// chain key as proof B consented.
		const joinOpNoSig = {
			kind: "peer.join" as const,
			writer_pubkey: B.base.local.key.toString("hex"),
			chain_pubkey: sellerB.pubkeyHex,
			created_at: Date.now(),
		};
		await A.base.append(JSON.stringify({ ...joinOpNoSig, signature: signOpForTest(joinOpNoSig, sellerB) }));

		// Wait for B to become writable via DHT-replicated state.
		await waitFor(async () => {
			await B.base.update();
			return B.base.writable ? true : null;
		}, 15_000);

		// B writes an auction, A picks it up.
		const opNoSig = {
			kind: "auction.create" as const,
			id: "dht-auction-1",
			seller_pubkey: sellerB.pubkeyHex,
			give: [{ object_id: "dht-sword" }],
			want: [{ token: "FIG", amount: "42" }],
			expiry_ms: Date.now() + 60_000,
			created_at: Date.now(),
		};
		const op: AuctionCreateOp = { ...opNoSig, signature: signOpForTest(opNoSig, sellerB) };
		await B.base.append(JSON.stringify(op));

		const view = await waitFor(async () => {
			await A.base.update();
			return await A.base.view.get("auction/dht-auction-1");
		}, 15_000);

		const value = JSON.parse(typeof view.value === "string" ? view.value : view.value.toString("utf-8"));
		assert.equal(value.id, "dht-auction-1");
		assert.equal(value.status, "open");
		assert.equal(value.give[0].object_id, "dht-sword");

		await A.base.close(); await B.base.close();
		await A.store.close(); await B.store.close();
		await testnet.destroy();
	});
});
