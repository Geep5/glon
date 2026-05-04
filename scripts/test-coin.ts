#!/usr/bin/env tsx
/**
 * Coin UTXO integration test.
 * Requires dev server on :6420.
 *
 * Uses direct imports from src/programs/handlers/coin.js (same pattern
 * as demo-crypto-simple.ts) to bypass the esbuild bundling issue that
 * breaks dynamic imports inside loaded programs.
 */

import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { resolveEndpoint } from "../src/endpoint.js";
import { randomUUID } from "node:crypto";
import { hexDecode, hexEncode } from "../src/crypto.js";
import { encodeChange, stringVal, intVal, boolVal } from "../src/proto.js";
import {
  buildBucketGenesisChange,
  buildCoinOpChange,
  TOKEN_TYPE_KEY,
  BUCKET_TYPE_KEY,
  OP_CONTENT_TYPE,
  type CoinOp,
} from "../src/programs/handlers/coin.js";

const ENDPOINT = resolveEndpoint();
const client = createClient<typeof app>(ENDPOINT);
const store = client.storeActor.getOrCreate(["root"]);

async function main() {
  console.log("=== Coin UTXO Integration Test ===\n");

  // ── Wallet keys ──
  const { __test: walletTest } = await import("../src/programs/handlers/wallet.js");
  const walletPath = `${process.env.HOME}/.glon/wallet.json`;
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

  let nonce = 1;

  // ── Deploy token metadata ──
  console.log("\n--- Deploy token metadata ---");
  const tokenId = randomUUID().replace(/-/g, "").slice(0, 24);
  const tokenFields = {
    name: stringVal("TestCoin"),
    symbol: stringVal("TCN"),
    decimals: intVal(0),
    owner_pubkey: stringVal(alice.pubkey),
    total_supply: stringVal("10000"),
    mint_renounced: boolVal(false),
  };

  const unsignedToken = {
    id: new Uint8Array(0),
    objectId: tokenId,
    parentIds: [] as Uint8Array[],
    ops: [
      { objectCreate: { typeKey: TOKEN_TYPE_KEY } },
      ...Object.entries(tokenFields).map(([key, value]) => ({ fieldSet: { key, value } })),
    ],
    timestamp: Date.now(),
    author: "coin-test",
  };

  const tokenB64 = Buffer.from(encodeChange(unsignedToken)).toString("base64");
  const { changeB64: signedTokenB64 } = walletTest.doSignChange({
    name: "alice",
    changeB64: tokenB64,
    nonce: nonce++,
    fee: 100,
  }, walletPath);

  const tokenActor = client.objectActor.getOrCreate([tokenId], { createWithInput: { id: tokenId } });
  await tokenActor.pushChanges(signedTokenB64);
  console.log("Token deployed:", tokenId);

  // ── Deploy bucket + initial coin ──
  console.log("\n--- Deploy bucket + mint ---");
  const bucketId = randomUUID().replace(/-/g, "").slice(0, 24);

  const genesisChange = buildBucketGenesisChange({
    bucketId,
    timestamp: Date.now(),
    author: "coin-test",
    tokenId,
  });
  const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
  const { changeB64: signedGenesisB64 } = walletTest.doSignChange({
    name: "alice",
    changeB64: genesisB64,
    nonce: nonce++,
    fee: 100,
  }, walletPath);

  const bucketActor = client.objectActor.getOrCreate([bucketId], { createWithInput: { id: bucketId } });
  await bucketActor.pushChanges(signedGenesisB64);

  const coinId = randomUUID().replace(/-/g, "").slice(0, 16);
  const mintChange = buildCoinOpChange({
    bucketId,
    parentIds: [hexDecode(await bucketActor.getHeads().then((h: any) => h[0]))],
    timestamp: Date.now(),
    author: "coin-test",
    op: { kind: "create", coinId, ownerPubkey: alice.pubkey, amount: "10000" },
    blockId: randomUUID().replace(/-/g, "").slice(0, 16),
  });
  const mintB64 = Buffer.from(encodeChange(mintChange)).toString("base64");
  const { changeB64: signedMintB64 } = walletTest.doSignChange({
    name: "alice",
    changeB64: mintB64,
    nonce: nonce++,
    fee: 10,
  }, walletPath);
  await bucketActor.pushChanges(signedMintB64);
  console.log("Bucket + initial coin created:", bucketId, "coin:", coinId);

  // ── Balance check (deployer should hold full supply) ──
  console.log("\n--- Initial Balance ---");
  const balAlice = await (store as any).coinBalance(tokenId, alice.pubkey) as string;
  const balBob = await (store as any).coinBalance(tokenId, bob.pubkey) as string;
  console.log("alice balance:", balAlice);
  console.log("bob balance:  ", balBob);

  if (balAlice !== "10000") throw new Error(`Expected alice balance 10000, got ${balAlice}`);
  if (balBob !== "0") throw new Error(`Expected bob balance 0, got ${balBob}`);

  // ── Transfer ──
  console.log("\n--- Transfer ---");
  const transferAmount = "2500";

  // Spend alice's coin
  const heads = await bucketActor.getHeads() as string[];
  const spendChange = buildCoinOpChange({
    bucketId,
    parentIds: heads.map(hexDecode),
    timestamp: Date.now(),
    author: "coin-test",
    op: { kind: "spend", coinId },
    blockId: randomUUID().replace(/-/g, "").slice(0, 16),
  });
  const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
  const { changeB64: signedSpendB64 } = walletTest.doSignChange({
    name: "alice",
    changeB64: spendB64,
    nonce: nonce++,
    fee: 1,
  }, walletPath);
  await bucketActor.pushChanges(signedSpendB64);

  // Create output coins: one for bob, one for alice (change)
  const outHeads = await bucketActor.getHeads() as string[];
  const createBobChange = buildCoinOpChange({
    bucketId,
    parentIds: outHeads.map(hexDecode),
    timestamp: Date.now(),
    author: "coin-test",
    op: { kind: "create", coinId: randomUUID().replace(/-/g, "").slice(0, 16), ownerPubkey: bob.pubkey, amount: transferAmount },
    blockId: randomUUID().replace(/-/g, "").slice(0, 16),
  });
  const createBobB64 = Buffer.from(encodeChange(createBobChange)).toString("base64");
  const { changeB64: signedCreateBobB64 } = walletTest.doSignChange({
    name: "alice",
    changeB64: createBobB64,
    nonce: nonce++,
    fee: 1,
  }, walletPath);
  await bucketActor.pushChanges(signedCreateBobB64);

  const outHeads2 = await bucketActor.getHeads() as string[];
  const createAliceChange = buildCoinOpChange({
    bucketId,
    parentIds: outHeads2.map(hexDecode),
    timestamp: Date.now(),
    author: "coin-test",
    op: { kind: "create", coinId: randomUUID().replace(/-/g, "").slice(0, 16), ownerPubkey: alice.pubkey, amount: "7500" },
    blockId: randomUUID().replace(/-/g, "").slice(0, 16),
  });
  const createAliceB64 = Buffer.from(encodeChange(createAliceChange)).toString("base64");
  const { changeB64: signedCreateAliceB64 } = walletTest.doSignChange({
    name: "alice",
    changeB64: createAliceB64,
    nonce: nonce++,
    fee: 1,
  }, walletPath);
  await bucketActor.pushChanges(signedCreateAliceB64);

  // ── Post-transfer balances ──
  console.log("\n--- Post-transfer Balances ---");
  const balAlice2 = await (store as any).coinBalance(tokenId, alice.pubkey) as string;
  const balBob2 = await (store as any).coinBalance(tokenId, bob.pubkey) as string;
  console.log("alice balance:", balAlice2);
  console.log("bob balance:  ", balBob2);

  if (balAlice2 !== "7500") throw new Error(`Expected alice balance 7500, got ${balAlice2}`);
  if (balBob2 !== transferAmount) throw new Error(`Expected bob balance ${transferAmount}, got ${balBob2}`);

  // ── Holders ──
  console.log("\n--- Holders ---");
  const holders = await (store as any).coinHolders(tokenId) as { pubkey: string; balance: string }[];
  console.log("Holder count:", holders.length);
  for (const h of holders) {
    console.log(`  ${h.pubkey.slice(0, 16)}...  ${h.balance}`);
  }

  // ── Validate bucket state via actor action ──
  console.log("\n--- Bucket replay state ---");
  const bucketObj = await store.get(bucketId) as any;
  const { replayBucket } = await import("../src/programs/handlers/coin.js");
  const state = replayBucket(bucketObj.blocks ?? []);
  console.log("Coins in bucket:", state.coins.size);
  let unspent = 0;
  for (const [id, c] of state.coins) {
    console.log(`  ${id.slice(0, 8)}...  owner=${c.owner.slice(0, 16)}...  amount=${c.amount}  spent=${c.spent}`);
    if (!c.spent) unspent++;
  }
  console.log("Unspent coins:", unspent);

  console.log("\n=== All tests passed ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n=== Test failed ===");
  console.error(err);
  process.exit(1);
});
