
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  decodeCoinOp,
  encodeCoinOp,
  replayBucket,
  validateBucketChange,
  classifyBucketChange,
  buildBucketGenesisChange,
  buildCoinOpChange,
  MAX_COINS_PER_BUCKET,
} from "../../src/programs/handlers/coin.js";
import { encodeChange, decodeChange } from "../../src/proto.js";

describe("coin UTXO", () => {
  it("decodes a create op", () => {
    const op = { kind: "create" as const, coinId: "abc", ownerPubkey: "pub", amount: "100" };
    const meta = encodeCoinOp(op);
    assert.strictEqual(meta.op, "create");
    assert.strictEqual(meta.coin_id, "abc");
  });

  it("replays bucket state", () => {
    const blocks = [
      {
        id: "b1",
        childrenIds: [],
        content: {
          custom: {
            contentType: "chain.coin.op",
            data: new Uint8Array(0),
            meta: { op: "create", coin_id: "c1", owner_pubkey: "alice", amount: "100" },
          },
        },
      },
      {
        id: "b2",
        childrenIds: [],
        content: {
          custom: {
            contentType: "chain.coin.op",
            data: new Uint8Array(0),
            meta: { op: "create", coin_id: "c2", owner_pubkey: "bob", amount: "50" },
          },
        },
      },
      {
        id: "b3",
        childrenIds: [],
        content: {
          custom: {
            contentType: "chain.coin.op",
            data: new Uint8Array(0),
            meta: { op: "spend", coin_id: "c1" },
          },
        },
      },
    ];
    const state = replayBucket(blocks as any);
    assert.strictEqual(state.coins.size, 2);
    assert.strictEqual(state.coins.get("c1")?.spent, true);
    assert.strictEqual(state.coins.get("c2")?.spent, false);
    assert.strictEqual(state.coins.get("c2")?.amount, "50");
  });

  it("validates genesis", () => {
    const change = buildBucketGenesisChange({ bucketId: "b1", timestamp: 1, author: "a", tokenId: "t1" });
    const result = validateBucketChange(change, []);
    assert.strictEqual(result.valid, true);
  });

  it("rejects double spend", () => {
    const blocks = [
      {
        id: "b1",
        childrenIds: [],
        content: {
          custom: {
            contentType: "chain.coin.op",
            data: new Uint8Array(0),
            meta: { op: "create", coin_id: "c1", owner_pubkey: "alice", amount: "100" },
          },
        },
      },
      {
        id: "b2",
        childrenIds: [],
        content: {
          custom: {
            contentType: "chain.coin.op",
            data: new Uint8Array(0),
            meta: { op: "spend", coin_id: "c1" },
          },
        },
      },
    ];
    const spendChange = buildCoinOpChange({
      bucketId: "b1",
      parentIds: [],
      timestamp: 2,
      author: "a",
      op: { kind: "spend", coinId: "c1" },
      blockId: "b3",
    });
    const result = validateBucketChange(spendChange, blocks as any);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("double spend"));
  });

  it("rejects unknown spend", () => {
    const spendChange = buildCoinOpChange({
      bucketId: "b1",
      parentIds: [],
      timestamp: 2,
      author: "a",
      op: { kind: "spend", coinId: "missing" },
      blockId: "b2",
    });
    const result = validateBucketChange(spendChange, []);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes("unknown coin"));
  });
});
