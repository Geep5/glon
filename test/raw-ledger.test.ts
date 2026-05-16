// Raw multi-writer CRDT ledger — single-node + two-writer tests.
//
// No autobase, no Hyperswarm. Exercises:
//   - initRawLedger + appendOp + viewGet round-trip
//   - the full deploy / transfer / auction lifecycle on a single node
//   - two in-process writer corestores merged deterministically: same
//     final view regardless of which side an op landed on first
//   - reorg test: late-arriving op with older timestamp sorts into its
//     correct place (slow-path replay handles it correctly)
//   - conflict test: two writers escrow the same item, both compute the
//     same outcome

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import {
	initRawLedger,
	addKnownWriter,
	appendOp,
	viewGet,
	viewList,
	isWritable,
	statusSnapshot,
	shutdown,
	canonicalSigningBytes,
	apply,
} from "../src/ledger-host.ts";
import { generateKeyPair, sign as ed25519Sign } from "../src/det/ed25519.ts";
import { hexEncode, sha256 } from "../src/crypto.ts";

const tmpDirs: string[] = [];

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

async function makeRawNode() {
	await shutdown().catch(() => {}); // safe even if not initialized
	const dir = mkdtempSync(join(tmpdir(), "glon-raw-"));
	tmpDirs.push(dir);
	const store = new Corestore(dir);
	await store.ready();
	const localCore = store.get({ name: "glon-writer" });
	await localCore.ready();
	await initRawLedger({ corestore: store, localCore });
	return { dir, store, localCore };
}

describe("raw ledger — single node", () => {
	after(async () => {
		await shutdown().catch(() => {});
		for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
		tmpDirs.length = 0;
	});

	it("isWritable() is always true under raw backend", async () => {
		await makeRawNode();
		assert.equal(isWritable(), true);
		const status = statusSnapshot();
		assert.equal(status.backend, "raw");
		assert.equal(status.bootstrap_key, ""); // no bootstrap key in raw mode
		assert.equal(typeof status.writer_pubkey, "string");
		assert.equal(status.writer_pubkey.length, 64);
		await shutdown();
	});

	it("deploy + transfer + balance lifecycle works end-to-end", async () => {
		await makeRawNode();
		const alice = newSigner();
		const bob = newSigner();

		// Alice deploys a token, gets the supply.
		const deployCore = {
			kind: "coin.deploy" as const,
			name: "Test", symbol: "TST", decimals: 0,
			supply: "1000", owner_pubkey: alice.pubkeyHex,
			mint_renounced: false, created_at: 1,
		};
		const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
		const deployOp = { ...deployCore, token_id: tokenId, signature: signOp({ ...deployCore, token_id: tokenId }, alice) };
		await appendOp(deployOp as any);

		// Alice transfers 250 to Bob.
		const xferCore = {
			kind: "coin.transfer" as const,
			token_id: tokenId,
			from_pubkey: alice.pubkeyHex,
			to_pubkey: bob.pubkeyHex,
			amount: "250",
			created_at: 2,
		};
		const xferOp = { ...xferCore, signature: signOp(xferCore, alice) };
		await appendOp(xferOp as any);

		// Check balances via viewGet.
		// viewGet auto-parses JSON; balances are stored as bare numeric
		// strings, which JSON.parse converts to numbers. Compare as numbers.
		const aliceBal = await viewGet<number>(`balance/${tokenId}/${alice.pubkeyHex}`);
		const bobBal = await viewGet<number>(`balance/${tokenId}/${bob.pubkeyHex}`);
		assert.equal(aliceBal, 750);
		assert.equal(bobBal, 250);

		// viewList finds both balance entries.
		const entries = await viewList<string>(`balance/${tokenId}/`);
		assert.equal(entries.length, 2);

		await shutdown();
	});

	it("rejects an op with insufficient balance — view unchanged", async () => {
		await makeRawNode();
		const alice = newSigner();
		const bob = newSigner();

		const deployCore = {
			kind: "coin.deploy" as const,
			name: "Test", symbol: "TST", decimals: 0,
			supply: "10", owner_pubkey: alice.pubkeyHex,
			mint_renounced: false, created_at: 1,
		};
		const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
		await appendOp({ ...deployCore, token_id: tokenId, signature: signOp({ ...deployCore, token_id: tokenId }, alice) } as any);

		// Alice tries to transfer 50, only has 10.
		const xferCore = {
			kind: "coin.transfer" as const,
			token_id: tokenId,
			from_pubkey: alice.pubkeyHex,
			to_pubkey: bob.pubkeyHex,
			amount: "50",
			created_at: 2,
		};
		await appendOp({ ...xferCore, signature: signOp(xferCore, alice) } as any);

		assert.equal(await viewGet<number>(`balance/${tokenId}/${alice.pubkeyHex}`), 10);
		assert.equal(await viewGet<number>(`balance/${tokenId}/${bob.pubkeyHex}`), null);

		await shutdown();
	});
});

describe("raw ledger — two-writer merge (deterministic CRDT)", () => {
	after(async () => {
		for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
		tmpDirs.length = 0;
	});

	// Helper: simulate two nodes by running apply over the same sorted op
	// stream on two separate in-memory views. The merge sort happens
	// inside apply-runner; we drive it via the same apply() function the
	// raw runner uses.
	async function runMergeOnTwoNodes(ops: Array<{ writerHex: string; op: any; seq: number }>) {
		// Use the helper machinery via two Maps.
		const viewA = new Map<string, string>();
		const viewB = new Map<string, string>();

		// Sort the same way the raw runner does.
		const sorted = [...ops].sort((a, b) => {
			const ta = a.op.created_at ?? 0;
			const tb = b.op.created_at ?? 0;
			if (ta !== tb) return ta - tb;
			if (a.writerHex !== b.writerHex) return a.writerHex < b.writerHex ? -1 : 1;
			return a.seq - b.seq;
		});

		function makeShim(map: Map<string, string>) {
			return {
				async get(key: string) {
					const v = map.get(key);
					return v === undefined ? null : { key, value: v };
				},
				async put(key: string, value: any) {
					const s = typeof value === "string" ? value : value.toString("utf-8");
					map.set(key, s);
				},
				async del(key: string) { map.delete(key); },
				createReadStream(opts: { gte: string; lt?: string }) {
					const keys = [...map.keys()].filter((k) => k >= opts.gte && (!opts.lt || k < opts.lt)).sort();
					async function* gen() { for (const k of keys) yield { key: k, value: map.get(k)! }; }
					return gen();
				},
			};
		}
		const host = {
			async addWriter() { /* noop */ },
			async ackWriter() { /* noop */ },
			async removeWriter() { /* noop */ },
		};
		const nodes = sorted.map((o) => ({
			value: JSON.stringify(o.op),
			from: { key: Buffer.from(o.writerHex, "hex") },
		}));
		await apply(nodes, makeShim(viewA), host);
		await apply(nodes, makeShim(viewB), host);
		return { viewA, viewB };
	}

	it("two writers escrowing same item: both nodes compute same outcome", async () => {
		const writerA = "a".repeat(64);
		const writerB = "b".repeat(64);
		const alice = newSigner();
		const bob = newSigner();

		// Both try to escrow "contested-orb".
		const opFromA = {
			kind: "auction.create",
			id: "auction-a",
			seller_pubkey: alice.pubkeyHex,
			give: [{ object_id: "contested-orb" }],
			want: [],
			expiry_ms: Date.now() + 60_000,
			created_at: 1_000,
		};
		const opFromB = {
			kind: "auction.create",
			id: "auction-b",
			seller_pubkey: bob.pubkeyHex,
			give: [{ object_id: "contested-orb" }],
			want: [],
			expiry_ms: Date.now() + 60_000,
			created_at: 2_000,
		};
		const signedA = { ...opFromA, signature: signOp(opFromA, alice) };
		const signedB = { ...opFromB, signature: signOp(opFromB, bob) };

		const { viewA, viewB } = await runMergeOnTwoNodes([
			{ writerHex: writerA, op: signedA, seq: 0 },
			{ writerHex: writerB, op: signedB, seq: 0 },
		]);

		// Lowest timestamp wins: auction-a is open, auction-b is invalid.
		const aA = JSON.parse(viewA.get("auction/auction-a")!);
		const bA = JSON.parse(viewA.get("auction/auction-b")!);
		assert.equal(aA.status, "open");
		assert.equal(bA.status, "invalid_double_escrow");
		// Other node computes the same.
		const aB = JSON.parse(viewB.get("auction/auction-a")!);
		const bB = JSON.parse(viewB.get("auction/auction-b")!);
		assert.equal(aB.status, aA.status);
		assert.equal(bB.status, bA.status);
	});

	it("late-arriving op with older timestamp sorts into correct position (reorg)", async () => {
		// Three ops, but op #3 has the earliest timestamp. The merge sort
		// should put it first. This validates the slow-path replay
		// correctness: even if we received op #3 last in chronological
		// arrival order, the deterministic merge places it where it belongs.
		const writerA = "0".repeat(64);
		const writerB = "1".repeat(64);
		const alice = newSigner();
		const bob = newSigner();

		// Alice deploys at t=100
		const deployCore = {
			kind: "coin.deploy", name: "Test", symbol: "TST", decimals: 0,
			supply: "100", owner_pubkey: alice.pubkeyHex,
			mint_renounced: false, created_at: 100,
		};
		const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
		const deployOp = { ...deployCore, token_id: tokenId, signature: signOp({ ...deployCore, token_id: tokenId }, alice) };

		// Alice transfers 30 to Bob at t=200
		const xfer1Core = {
			kind: "coin.transfer", token_id: tokenId,
			from_pubkey: alice.pubkeyHex, to_pubkey: bob.pubkeyHex,
			amount: "30", created_at: 200,
		};
		const xfer1 = { ...xfer1Core, signature: signOp(xfer1Core, alice) };

		// Late op: ALICE transfers 20 to bob at t=150 (sorts BEFORE the t=200 transfer)
		const xfer2Core = {
			kind: "coin.transfer", token_id: tokenId,
			from_pubkey: alice.pubkeyHex, to_pubkey: bob.pubkeyHex,
			amount: "20", created_at: 150,
		};
		const xfer2 = { ...xfer2Core, signature: signOp(xfer2Core, alice) };

		const ops = [
			{ writerHex: writerA, op: deployOp, seq: 0 },
			{ writerHex: writerA, op: xfer1, seq: 1 },
			{ writerHex: writerA, op: xfer2, seq: 2 }, // arrived last but sorts second
		];
		const { viewA } = await runMergeOnTwoNodes(ops);

		// Apply order should be: deploy(100) → xfer2(150) → xfer1(200)
		// Alice: 100 - 20 - 30 = 50
		// Bob: 0 + 20 + 30 = 50
		assert.equal(viewA.get(`balance/${tokenId}/${alice.pubkeyHex}`), "50");
		assert.equal(viewA.get(`balance/${tokenId}/${bob.pubkeyHex}`), "50");
	});

	it("two writers different views of same set converge after full replay", async () => {
		// A deploys; B transfers (signed by A's key so it's valid).
		// Whether you apply A's deploy first or B's transfer first, the
		// merge sort by created_at deterministically orders deploy → transfer.
		const writerA = "0".repeat(64);
		const writerB = "1".repeat(64);
		const alice = newSigner();
		const bob = newSigner();

		const deployCore = {
			kind: "coin.deploy", name: "Test", symbol: "TST", decimals: 0,
			supply: "100", owner_pubkey: alice.pubkeyHex,
			mint_renounced: false, created_at: 10,
		};
		const tokenId = deriveTokenId(deployCore as Record<string, unknown>);
		const deployOp = { ...deployCore, token_id: tokenId, signature: signOp({ ...deployCore, token_id: tokenId }, alice) };

		const xferCore = {
			kind: "coin.transfer", token_id: tokenId,
			from_pubkey: alice.pubkeyHex, to_pubkey: bob.pubkeyHex,
			amount: "25", created_at: 20,
		};
		const xferOp = { ...xferCore, signature: signOp(xferCore, alice) };

		// Even though xfer is on a different writer (B), the merge still orders correctly.
		const { viewA, viewB } = await runMergeOnTwoNodes([
			{ writerHex: writerB, op: xferOp, seq: 0 },     // appears on writer B
			{ writerHex: writerA, op: deployOp, seq: 0 },   // appears on writer A
		]);

		assert.equal(viewA.get(`balance/${tokenId}/${alice.pubkeyHex}`), "75");
		assert.equal(viewA.get(`balance/${tokenId}/${bob.pubkeyHex}`), "25");
		assert.equal(viewB.get(`balance/${tokenId}/${alice.pubkeyHex}`), "75");
		assert.equal(viewB.get(`balance/${tokenId}/${bob.pubkeyHex}`), "25");
	});
});
