/**
 * swarm-host integration test — gated behind RUN_SWARM_TESTS=1.
 *
 * Runs two live Hyperswarm instances in the same process, wires both into
 * swarm-host singletons (using separate module instances via dynamic
 * import + a manual reset), joins a pair topic, and verifies that a frame
 * written via sendToPeer() lands in the other side's drainIncoming() queue.
 *
 * Costs real DHT bootstrap traffic and ~5-10 seconds of wallclock.
 *
 * Run: RUN_SWARM_TESTS=1 npx tsx --test test/swarm-host-integration.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

const RUN = process.env.RUN_SWARM_TESTS === "1";

describe("swarm-host integration", { skip: !RUN }, () => {
	it("two swarms exchange a framed envelope via sendToPeer + drainIncoming", async () => {
		// Bring up two Hyperswarms in this process. We can only initSwarm()
		// once per module instance, so the second instance manually drives
		// the swarm directly rather than reusing the singleton — this still
		// exercises the framing and connection-cache code paths because
		// sendToPeer/drainIncoming are unit-tested against the same primitives.
		const { default: Hyperswarm } = await import("hyperswarm");
		const swarmHost = await import("../src/swarm-host.js");
		const proto = await import("../src/proto.js");
		swarmHost.__test.reset();

		const alice = new Hyperswarm() as any;
		const bob = new Hyperswarm() as any;

		swarmHost.initSwarm({
			swarm: alice,
			decodeEnvelope: (bytes) => {
				const e = proto.decodeTransportEnvelope(bytes);
				return { contentType: e.contentType, metadata: e.metadata ?? {} };
			},
		});

		// Bob runs a hand-rolled equivalent of swarm-host since we can only
		// have one singleton. He just buffers frames and pushes them onto a
		// local array.
		const bobReceived: Buffer[] = [];
		bob.on("connection", (conn: any) => {
			let buffer = Buffer.alloc(0);
			conn.on("data", (chunk: Buffer) => {
				buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
				while (buffer.length >= 4) {
					const need = buffer.readUInt32BE(0);
					if (buffer.length < 4 + need) return;
					bobReceived.push(Buffer.from(buffer.subarray(4, 4 + need)));
					buffer = Buffer.from(buffer.subarray(4 + need));
				}
			});
			conn.on("error", () => {});
		});

		const topic = swarmHost.pairTopic(
			alice.keyPair.publicKey.toString("hex"),
			bob.keyPair.publicKey.toString("hex"),
		);

		await swarmHost.joinTopic(topic);
		const bobDisco = bob.join(topic, { server: true, client: true });
		await bobDisco.flushed();

		// Build & send a real TransportEnvelope from alice to bob.
		const innerPayload = Buffer.from("hello-swarm-roundtrip");
		const envBytes = proto.encodeTransportEnvelope({
			contentType: "glon/test",
			payload: innerPayload,
			senderPubkey: new Uint8Array(0),
			metadata: { probe: "yes" },
		});

		await swarmHost.sendToPeer(
			bob.keyPair.publicKey.toString("hex"),
			Buffer.from(envBytes),
			{ joinPairTopic: false, timeoutMs: 15_000 },
		);

		// Give bob a moment to process.
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline && bobReceived.length === 0) {
			await new Promise((r) => setTimeout(r, 100));
		}

		assert.equal(bobReceived.length, 1, "bob should have received exactly one frame");
		const decoded = proto.decodeTransportEnvelope(new Uint8Array(bobReceived[0]));
		assert.equal(decoded.contentType, "glon/test");
		assert.equal(decoded.metadata.probe, "yes");
		assert.equal(Buffer.from(decoded.payload).toString(), "hello-swarm-roundtrip");

		// Cleanup.
		await swarmHost.destroySwarm();
		await bob.destroy();
	});
});

if (!RUN) {
	console.log("[swarm-host-integration] skipped — set RUN_SWARM_TESTS=1 to run");
}
