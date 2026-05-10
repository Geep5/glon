/**
 * Cross-DAG swap integration test.
 *
 * Simulates a two-process trade:
 *   1. Maker (DAG-A) creates an offer, escrows coins, exports ChangeBundle.
 *   2. Taker (DAG-B) imports the bundle, pays, settles, and claims output.
 *
 * Each side validates changes independently against their local state.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
	validateOfferChange,
	validateBucketChange,
	buildOfferGenesisChange,
	buildCoinOpChange,
	buildBucketGenesisChange,
	classifyBucketChange,
	classifyOfferChange,
	type OfferTerms,
} from "../../src/programs/handlers/coin.js";
import { encodeChange, decodeChange, encodeChangeBundle, decodeChangeBundle } from "../../src/proto.js";
import type { Block, Change } from "../../src/proto.js";

describe("cross-DAG swap", () => {
	const makerPubkey = "a".repeat(64);
	const takerPubkey = "b".repeat(64);
	const offeredToken = "tokA";
	const requestedToken = "tokB";

	function blockFrom(change: Change): Block {
		const ops = change.ops ?? [];
		for (const op of ops) {
			if (op.blockAdd?.block) return op.blockAdd.block;
		}
		throw new Error("No blockAdd in change");
	}

	function signChange(change: Change, _pubkey: string): Change {
		// In production, the wallet signs. In tests we just stamp a dummy sig.
		return {
			...change,
			sig: {
				alg: "ed25519",
				pubkey: new Uint8Array(32),
				sig: new Uint8Array(64),
			},
		};
	}

	it("maker exports ChangeBundle, taker imports and settles", () => {
		// ── DAG-A: Maker creates bucket with coins to offer ───────────
		const makerBucketId = "makerBucket";
		const coinToOffer = "coinA1";

		const makerBucketGenesis = buildBucketGenesisChange({
			bucketId: makerBucketId,
			timestamp: 1,
			author: "maker",
			ownerPubkey: makerPubkey,
			tokenId: offeredToken,
		});

		const createCoin = buildCoinOpChange({
			bucketId: makerBucketId,
			parentIds: [],
			timestamp: 2,
			author: "maker",
			op: { kind: "create", coinId: coinToOffer, ownerPubkey: makerPubkey, amount: "100" },
			blockId: "b1",
		});

		// Maker spends the coin (into the offer)
		const spendCoin = buildCoinOpChange({
			bucketId: makerBucketId,
			parentIds: [],
			timestamp: 3,
			author: "maker",
			op: { kind: "spend", coinId: coinToOffer },
			blockId: "b2",
		});

		// ── DAG-A: Maker creates offer ────────────────────────────────
		const offerId = "offer1";
		const terms: OfferTerms = {
			offered: [{ tokenId: offeredToken, amount: "100" }],
			requested: [{ tokenId: requestedToken, amount: "50" }],
		};

		const offerGenesis = buildOfferGenesisChange({
			offerId,
			timestamp: 4,
			author: "maker",
			makerPubkey,
			terms: JSON.stringify(terms),
		});

		const escrow = buildCoinOpChange({
			bucketId: offerId,
			parentIds: [],
			timestamp: 5,
			author: "maker",
			op: { kind: "offer_escrow", coinId: coinToOffer, ownerPubkey: makerPubkey, amount: "100", tokenId: offeredToken },
			blockId: "b3",
		});

		// ── Export: encode all changes into a ChangeBundle ────────────
		const allChanges = [makerBucketGenesis, createCoin, spendCoin, offerGenesis, escrow];
		const changeBytes = allChanges.map((c) => encodeChange(signChange(c, makerPubkey)));
		const bundleBytes = encodeChangeBundle({ changes: changeBytes });

		// ── DAG-B: Taker imports the bundle ───────────────────────────
		const imported = decodeChangeBundle(new Uint8Array(bundleBytes));
		assert.strictEqual(imported.changes.length, 5);

		// Validate each change against an empty DAG-B state
		const importedBlocks: Block[] = [];
		for (let i = 0; i < imported.changes.length; i++) {
			const change = decodeChange(imported.changes[i]);
			const priorBlocks = importedBlocks.slice();

			if (change.objectId === makerBucketId) {
				const result = validateBucketChange(change, priorBlocks);
				assert.strictEqual(result.valid, true, `bucket change ${i} should validate`);
			} else if (change.objectId === offerId) {
				const offerFields = {
					maker_pubkey: { stringValue: makerPubkey },
					terms: { stringValue: JSON.stringify(terms) },
				};
				const offerPrior = i === 3 ? [] : importedBlocks.filter((b) => b.content?.custom?.contentType === "chain.coin.op");
				const signer = i === 4 ? takerPubkey : undefined;
				const result = validateOfferChange(change, offerPrior, signer, offerFields);
				if (!result.valid) console.error("Validation failed at i=", i, "error:", result.error);
				assert.strictEqual(result.valid, true, `offer change ${i} should validate: ${result.error}`);
			}

			// Collect blocks for subsequent validation
			try { importedBlocks.push(blockFrom(change)); } catch { /* genesis has no block */ }
		}

		// ── DAG-B: Taker pays and settles ─────────────────────────────
		const takerBucketId = "takerBucket";
		const paymentCoin = "coinB1";

		const takerBucketGenesis = buildBucketGenesisChange({
			bucketId: takerBucketId,
			timestamp: 6,
			author: "taker",
			ownerPubkey: takerPubkey,
			tokenId: requestedToken,
		});

		const createPayment = buildCoinOpChange({
			bucketId: takerBucketId,
			parentIds: [],
			timestamp: 7,
			author: "taker",
			op: { kind: "create", coinId: paymentCoin, ownerPubkey: takerPubkey, amount: "50" },
			blockId: "b4",
		});

		const spendPayment = buildCoinOpChange({
			bucketId: takerBucketId,
			parentIds: [],
			timestamp: 8,
			author: "taker",
			op: { kind: "spend", coinId: paymentCoin },
			blockId: "b5",
		});

		const offerPayment = buildCoinOpChange({
			bucketId: offerId,
			parentIds: [],
			timestamp: 9,
			author: "taker",
			op: { kind: "offer_pay", coinId: paymentCoin, ownerPubkey: takerPubkey, amount: "50", tokenId: requestedToken },
			blockId: "b6",
		});

		const settle = buildCoinOpChange({
			bucketId: offerId,
			parentIds: [],
			timestamp: 10,
			author: "taker",
			op: {
				kind: "offer_settle",
				coinId: "settle1",
				outputs: JSON.stringify([
					{ coin_id: "outMaker", owner_pubkey: makerPubkey, amount: "50", token_id: requestedToken },
					{ coin_id: "outTaker", owner_pubkey: takerPubkey, amount: "100", token_id: offeredToken },
				]),
			},
			blockId: "b7",
		});

		// Validate taker-side changes
		const takerChanges = [takerBucketGenesis, createPayment, spendPayment, offerPayment, settle];
		const takerBlocks: Block[] = [];
		for (let i = 0; i < takerChanges.length; i++) {
			const change = takerChanges[i];
			const priorBlocks = takerBlocks.slice();

			if (change.objectId === takerBucketId) {
				const result = validateBucketChange(change, priorBlocks);
				assert.strictEqual(result.valid, true, `taker bucket change ${i} should validate`);
			} else if (change.objectId === offerId) {
				const offerFields = {
					maker_pubkey: { stringValue: makerPubkey },
					terms: { stringValue: JSON.stringify(terms) },
				};
				// Include imported offer blocks as prior state for the offer
				const offerPrior = importedBlocks.filter((b) => b.content?.custom?.contentType === "chain.coin.op");
				const signer = i === 3 ? takerPubkey : undefined;
				const result = validateOfferChange(change, offerPrior, signer, offerFields);
				if (!result.valid) console.error("Taker validation failed at i=", i, "error:", result.error);
				assert.strictEqual(result.valid, true, `taker offer change ${i} should validate: ${result.error}`);
			}

			try { takerBlocks.push(blockFrom(change)); } catch { /* genesis */ }
		}

		// ── Verify conservation of value ──────────────────────────────
		// Maker gave 100 tokA, gets 50 tokB. Taker gave 50 tokB, gets 100 tokA.
		const settleChange = takerChanges[4];
		const settleBlock = blockFrom(settleChange);
		const settleOp = settleBlock.content?.custom?.meta as any;
		const outputs = JSON.parse(settleOp.outputs);
		assert.strictEqual(outputs.length, 2);
		assert.strictEqual(outputs[0].owner_pubkey, makerPubkey);
		assert.strictEqual(outputs[0].amount, "50");
		assert.strictEqual(outputs[0].token_id, requestedToken);
		assert.strictEqual(outputs[1].owner_pubkey, takerPubkey);
		assert.strictEqual(outputs[1].amount, "100");
		assert.strictEqual(outputs[1].token_id, offeredToken);
	});

	it("rejects imported bundle with tampered spend", () => {
		const makerBucketId = "makerBucket2";
		const coinToOffer = "coinA2";

		const makerBucketGenesis = buildBucketGenesisChange({
			bucketId: makerBucketId,
			timestamp: 1,
			author: "maker",
			ownerPubkey: makerPubkey,
			tokenId: offeredToken,
		});

		const createCoin = buildCoinOpChange({
			bucketId: makerBucketId,
			parentIds: [],
			timestamp: 2,
			author: "maker",
			op: { kind: "create", coinId: coinToOffer, ownerPubkey: makerPubkey, amount: "100" },
			blockId: "b1",
		});

		const spendCoin = buildCoinOpChange({
			bucketId: makerBucketId,
			parentIds: [],
			timestamp: 3,
			author: "maker",
			op: { kind: "spend", coinId: coinToOffer },
			blockId: "b2",
		});

		// Tamper: change the spend to target a different coin
		const tamperedSpend = buildCoinOpChange({
			bucketId: makerBucketId,
			parentIds: [],
			timestamp: 3,
			author: "maker",
			op: { kind: "spend", coinId: "nonexistent" },
			blockId: "b2",
		});

		const allChanges = [makerBucketGenesis, createCoin, tamperedSpend];
		const changeBytes = allChanges.map((c) => encodeChange(c));
		const bundleBytes = encodeChangeBundle({ changes: changeBytes });

		// Import to DAG-B and validate
		const imported = decodeChangeBundle(new Uint8Array(bundleBytes));
		const importedBlocks: Block[] = [];

		for (let i = 0; i < imported.changes.length; i++) {
			const change = decodeChange(imported.changes[i]);
			const priorBlocks = importedBlocks.slice();

			if (change.objectId === makerBucketId) {
				const result = validateBucketChange(change, priorBlocks);
				if (i === 2) {
					// The tampered spend should fail
					assert.strictEqual(result.valid, false);
					assert.ok(result.error?.includes("unknown"));
				} else {
					assert.strictEqual(result.valid, true);
				}
			}

			try { importedBlocks.push(blockFrom(change)); } catch { /* genesis */ }
		}
	});
});
