#!/usr/bin/env tsx
/**
 * Simple crypto demo — imports modules directly, no program loader.
 */
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";
import { randomUUID } from "node:crypto";
import { hexDecode } from "../src/crypto.js";

const ENDPOINT = resolveEndpoint();
const client = createClient<typeof app>(ENDPOINT);
const store = client.storeActor.getOrCreate(["root"]);

async function main() {
  console.log("=== Glon Crypto Demo ===\n");

  // ── Wallet (direct file import) ──
  console.log("--- Wallet ---");
  const { __test: walletTest } = await import("../src/programs/handlers/wallet.js");
  const walletPath = process.env.GLON_DATA
    ? `${process.env.GLON_DATA}/wallet.json`
    : `${process.env.HOME}/.glon/wallet.json`;

  let keys = walletTest.doList(walletPath);
  let alice = keys.find((k: any) => k.name === "alice");
  let bob = keys.find((k: any) => k.name === "bob");

  if (!alice) {
    alice = walletTest.doNew("alice", Date.now(), walletPath);
    console.log("Created alice:", alice.pubkey.slice(0, 24) + "...");
  } else {
    console.log("Reusing alice:", alice.pubkey.slice(0, 24) + "...");
  }
  if (!bob) {
    bob = walletTest.doNew("bob", Date.now(), walletPath);
    console.log("Created bob:  ", bob.pubkey.slice(0, 24) + "...");
  } else {
    console.log("Reusing bob:  ", bob.pubkey.slice(0, 24) + "...");
  }

  // ── Token Deploy ──
  console.log("\n--- Token Deploy ---");
  const { __test: tokenTest } = await import("../src/programs/handlers/token.js");
  const tokenId = randomUUID().replace(/-/g, "").slice(0, 24);

  const deployChange = tokenTest.buildDeployChange({
    tokenId,
    timestamp: Date.now(),
    author: "demo",
    name: "Figgies",
    symbol: "FIG",
    decimals: 0,
    ownerPubkeyHex: alice.pubkey,
    initialSupply: 1000n,
  });

  const { encodeChange } = await import("../src/proto.js");
  const deployB64 = Buffer.from(encodeChange(deployChange)).toString("base64");

  const deploySigned = walletTest.doSignChange({
    name: "alice",
    changeB64: deployB64,
    nonce: 1,
    fee: 100,
  }, walletPath);

  const objActor = client.objectActor.getOrCreate([tokenId], { createWithInput: { id: tokenId } });
  await objActor.pushChanges(deploySigned.changeB64);
  console.log("Deployed Figgies (FIG) supply=1000 id=" + tokenId);

  // ── Token State ──
  const obj = await store.get(tokenId) as any;
  const state = tokenTest.replayState(obj.fields ?? {}, obj.blocks ?? []);
  console.log("Token:", state.name, "(" + state.symbol + ")", "supply=" + state.totalSupply.toString(), "holders=" + state.balances.size);

  // ── Transfer ──
  console.log("\n--- Transfer ---");
  const headIds = await store.getHeadIds(tokenId) as string[];
  const transferChange = tokenTest.buildOpChange({
    tokenId,
    parentIds: headIds.map((h) => hexDecode(h)),
    timestamp: Date.now(),
    author: "demo",
    op: { kind: "Transfer", to: bob.pubkey, amount: "250" },
    signerPubkeyHex: alice.pubkey,
    blockId: randomUUID().replace(/-/g, "").slice(0, 16),
  });

  const transferB64 = Buffer.from(encodeChange(transferChange)).toString("base64");

  // Get nonce from consensus actor via store
  const { __test: consensusTest } = await import("../src/programs/handlers/consensus.js");
  // We need the consensus state from the daemon actor — can't easily get it without dispatch.
  // Use a fixed nonce: alice used nonce 1 for deploy, so transfer uses nonce 2.
  const transferSigned = walletTest.doSignChange({
    name: "alice",
    changeB64: transferB64,
    nonce: 2,
    fee: 1,
  }, walletPath);

  await objActor.pushChanges(transferSigned.changeB64);
  console.log("Transferred 250 FIG from alice to bob");

  // ── Balances ──
  const afterObj = await store.get(tokenId) as any;
  const afterState = tokenTest.replayState(afterObj.fields ?? {}, afterObj.blocks ?? []);
  console.log("\n--- Balances ---");
  for (const [pk, bal] of afterState.balances) {
    const name = pk === alice.pubkey ? "alice" : pk === bob.pubkey ? "bob" : pk.slice(0, 16);
    console.log(`  ${name}: ${bal.toString()}`);
  }

  // ── Anchor ──
  console.log("\n--- Anchor ---");
  // Use daemon dispatch for anchor creation
  const consensus = await import("../src/programs/handlers/consensus.js");
  const anchor = await import("../src/programs/handlers/anchor.js");

  // Build context for anchor
  const { buildContext } = await import("../src/programs/runtime.js");
  // Anchor handler needs ProgramContext with store
  const ctx = {
    client,
    store,
    resolveId: async (raw: string) => {
      if (!raw) return null;
      const exact = await store.exists(raw);
      if (exact) return raw;
      const resolved = await store.resolvePrefix(raw);
      return resolved ?? null;
    },
    stringVal: (await import("../src/proto.js")).stringVal,
    intVal: (await import("../src/proto.js")).intVal,
    state: {},
    print: (msg: string) => console.log(msg),
    randomUUID,
  } as any;

  await (anchor.default.handler as any)("create", [], ctx);

  console.log("\n=== Demo Complete ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});