// Auto peer.join test — verifies the broadcast + relay flow.
//
// The mechanics: a joiner (not yet a writer) calls broadcastJoinAnnounce,
// which goes through /transport-hyperswarm. An existing writer receives
// the envelope via handleJoinAnnounce, which appends a signed peer.join
// op to the autobase. The autobase apply auto-admits via host.addWriter.
//
// In this test we exercise the auction.ts logic with mocked dispatchProgram
// to simulate the swarm boundary. The end-to-end DHT path is covered by
// auction-hyperswarm.test.ts.

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
	initAutobase,
	isWritable,
	type JoinOp,
} from "../src/ledger-host.ts";
import { generateKeyPair, sign as ed25519Sign } from "../src/det/ed25519.ts";
import { hexEncode } from "../src/crypto.ts";

const tmpDirs: string[] = [];

function openView(store: any) {
	return new Hyperbee(store.get("auction-view"), {
		keyEncoding: "utf-8",
		valueEncoding: "utf-8",
	});
}

async function makeNodeRaw(bootstrap: Buffer | null) {
	const dir = mkdtempSync(join(tmpdir(), "glon-aj-"));
	tmpDirs.push(dir);
	const store = new Corestore(dir);
	await store.ready();
	const base = new Autobase(store, bootstrap, { open: openView, apply, ackInterval: 100 });
	await base.ready();
	return { store, base, dir };
}

function pipeReplication(storeA: any, storeB: any) {
	const a = storeA.replicate(true);
	const b = storeB.replicate(false);
	a.pipe(b).pipe(a);
	return { a, b };
}

async function waitFor<T>(pred: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = await pred();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function newSigner() {
	const kp = generateKeyPair();
	return { ...kp, pubkeyHex: hexEncode(kp.publicKey) };
}

function signOp(op: Record<string, unknown>, signer: ReturnType<typeof newSigner>): string {
	return hexEncode(ed25519Sign(signer.privateKey, canonicalSigningBytes(op)));
}

describe("auto peer.join over relay", () => {
	after(() => {
		for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
		tmpDirs.length = 0;
	});

	it("joiner's signed peer.join, relayed by writer, makes joiner writable", async () => {
		// A is the founder; B is the joiner. Replication is piped directly
		// (no real Hyperswarm) to focus on the apply-time admission logic.
		const A = await makeNodeRaw(null);
		const B = await makeNodeRaw(A.base.key);
		const streams = pipeReplication(A.store, B.store);
		const signerB = newSigner();

		// Simulate the join broadcast: B builds a signed peer.join. In production
		// this gets sent via /transport-hyperswarm.broadcast; in this test we
		// hand it directly to A's autobase (which is what handleJoinAnnounce
		// would do once decoded).
		const joinNoSig = {
			kind: "peer.join" as const,
			writer_pubkey: B.base.local.key.toString("hex"),
			chain_pubkey: signerB.pubkeyHex,
			created_at: Date.now(),
		};
		const joinSigned: JoinOp & { signature: string } = {
			...joinNoSig,
			signature: signOp(joinNoSig, signerB),
		};

		// A receives the envelope and (acting as writer) appends to autobase.
		await A.base.append(JSON.stringify(joinSigned));

		// B should become writable once the apply runs on its replicated view.
		await waitFor(async () => {
			await B.base.update();
			return B.base.writable ? true : null;
		}, 5000);

		assert.equal(B.base.writable, true, "B is now a writer");

		// And the peer/<chain>/writer view entry exists.
		const peerEntry = await A.base.view.get(`peer/${signerB.pubkeyHex}/writer`);
		assert.ok(peerEntry, "A's view should contain a peer entry for B's chain key");

		streams.a.destroy(); streams.b.destroy();
		await A.base.close(); await B.base.close();
		await A.store.close(); await B.store.close();
	});

	it("rejects a forged join op (signature doesn't match chain_pubkey)", async () => {
		// Attacker tries to admit themselves to A's autobase using a join op
		// with a fake signature. Apply must reject; B's writer key should NOT
		// appear in the peer view.
		const A = await makeNodeRaw(null);
		const attacker = newSigner();   // signs with this key
		const victim = newSigner();     // pretends to be this

		const joinNoSig = {
			kind: "peer.join" as const,
			writer_pubkey: "f".repeat(64),
			chain_pubkey: victim.pubkeyHex,    // claims to be victim
			created_at: Date.now(),
		};
		const forged = {
			...joinNoSig,
			signature: signOp(joinNoSig, attacker),  // signed by attacker, not victim
		};

		await A.base.append(JSON.stringify(forged));
		await new Promise((r) => setTimeout(r, 200));
		await A.base.update();

		const peerEntry = await A.base.view.get(`peer/${victim.pubkeyHex}/writer`);
		assert.equal(peerEntry, null, "forged peer.join must not appear in the view");

		await A.base.close(); await A.store.close();
	});

	it("isWritable() reflects autobase state correctly", async () => {
		const A = await makeNodeRaw(null);
		initAutobase({
			corestore: A.store,
			autobase: A.base,
			view: A.base.view,
			writerPubkey: A.base.local.key,
		});
		// A is the founder of its own autobase — should be writable.
		assert.equal(isWritable(), true, "founder must be writable");
		// (Subsequent re-init would throw; we just close here.)
		await A.base.close();
		await A.store.close();
	});
});
