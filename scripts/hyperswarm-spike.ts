/**
 * Hyperswarm Phase 0 spike. Two swarm instances in one process join the
 * same topic and ping each other. Confirms the install + API + bundling
 * basics work before we wire any of this into Glon proper.
 *
 * Run: npx tsx scripts/hyperswarm-spike.ts
 */

import Hyperswarm from "hyperswarm";
import { createHash } from "node:crypto";

const TOPIC = createHash("sha256").update("glon:spike:v0").digest();

async function run() {
	const alice = new Hyperswarm();
	const bob = new Hyperswarm();

	let aliceGotMessage = false;
	let bobGotMessage = false;

	alice.on("connection", (conn, info) => {
		console.log("[alice] connected to peer", info.publicKey.toString("hex").slice(0, 12));
		conn.on("data", (data: Buffer) => {
			console.log("[alice] recv:", data.toString());
			aliceGotMessage = true;
		});
		conn.on("error", () => {});
		conn.write("hello from alice");
	});

	bob.on("connection", (conn, info) => {
		console.log("[bob] connected to peer", info.publicKey.toString("hex").slice(0, 12));
		conn.on("data", (data: Buffer) => {
			console.log("[bob] recv:", data.toString());
			bobGotMessage = true;
		});
		conn.on("error", () => {});
		conn.write("hello from bob");
	});

	console.log("alice pubkey:", alice.keyPair.publicKey.toString("hex").slice(0, 16));
	console.log("bob   pubkey:", bob.keyPair.publicKey.toString("hex").slice(0, 16));
	console.log("topic:", TOPIC.toString("hex").slice(0, 16));

	console.log("[alice] joining...");
	const aliceDisco = alice.join(TOPIC, { server: true, client: true });
	await aliceDisco.flushed();
	console.log("[alice] flushed");

	console.log("[bob] joining...");
	const bobDisco = bob.join(TOPIC, { server: true, client: true });
	await bobDisco.flushed();
	console.log("[bob] flushed");

	// Give them a moment to discover each other + exchange.
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && (!aliceGotMessage || !bobGotMessage)) {
		await new Promise((r) => setTimeout(r, 250));
	}

	console.log("---result---");
	console.log("alice received bob's message:", aliceGotMessage);
	console.log("bob   received alice's message:", bobGotMessage);

	await alice.destroy();
	await bob.destroy();
	process.exit(aliceGotMessage && bobGotMessage ? 0 : 1);
}

run().catch((err) => {
	console.error("spike failed:", err);
	process.exit(2);
});
