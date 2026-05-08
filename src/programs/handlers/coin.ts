// Coin — UTXO-based fungible token program for glon.
//
// Architecture:
//   - chain.token: metadata only (name, symbol, decimals, owner, total_supply, mint_renounced)
//   - chain.coin.bucket: holds up to 1000 coins as BlockAdd ops with contentType="chain.coin.op"
//   - SQLite coins table: index for O(1) balance queries
//
// This file is the entry point. Core logic lives in:
//   coin-types.ts  — types and constants
//   coin-bucket.ts — UTXO replay, validation, change builders
//   coin-offer.ts  — atomic-swap replay, validation
//
// Importing coin-bucket.ts triggers its side-effect registration of
// the SQL index hook at module load.

import type { ProgramDef, ProgramContext, ProgramActorDef, ValidationResult, Block } from "../runtime.js";
import type { Change } from "../../proto.js";
import { encodeChange, decodeChange } from "../../proto.js";
import {
	parseUint,
	addBounded,
	subChecked,
	U128_MAX,
	BIG_ZERO,
	bigToString,
} from "../../det/math.js";
import { hexEncode, hexDecode } from "../../crypto.js";
import { randomBytes } from "node:crypto";
import { dim, bold, cyan, red, green, yellow } from "../shared.js";
import { X402Authorization, canonicalAuthBytes, verifyX402Auth } from "./coin-x402.js";

// Side-effect: registers the bucket index hook with the kernel.
import "./coin-bucket.js";

import {
	TOKEN_TYPE_KEY,
	BUCKET_TYPE_KEY,
	OFFER_TYPE_KEY,
	OP_CONTENT_TYPE,
	MAX_COINS_PER_BUCKET,
	extractStr,
	extractInt,
	extractBool,
	type CoinOp,
	type OfferTerms,
	type BucketState,
	type OfferState,
	type TokenMeta,
} from "./coin-types.js";

	import {
		replayBucket,
		buildBucketGenesisChange,
		buildCoinOpChange,
		validateBucketChange,
		classifyBucketChange,
		decodeCoinOp,
		encodeCoinOp,
		validator as bucketValidator,
	} from "./coin-bucket.js";

import {
	replayOffer,
	buildOfferGenesisChange,
	validateOfferChange,
	classifyOfferChange,
} from "./coin-offer.js";

function extractStr(v: any): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return "";
}

function extractInt(v: any, fallback: number): number {
	if (v === null || v === undefined) return fallback;
	if (typeof v === "number") return v;
	if (v.intValue !== undefined) {
		const n = v.intValue;
		return typeof n === "number" ? n : Number(n) | 0;
	}
	return fallback;
}

function extractBool(v: any): boolean {
	if (v === null || v === undefined) return false;
	if (typeof v === "boolean") return v;
	if (v.boolValue !== undefined) return !!v.boolValue;
	return false;
}

export async function loadTokenMeta(
	tokenId: string,
	ctx: ProgramContext,
): Promise<TokenMeta> {
	const store = ctx.store as any;
	const obj = await store.get(tokenId);
	if (!obj) throw new Error(`coin: token ${tokenId} not found`);
	if (obj.typeKey !== TOKEN_TYPE_KEY) throw new Error(`coin: ${tokenId} is not a token`);
	const f = obj.fields ?? {};
	return {
		name: extractStr(f.name),
		symbol: extractStr(f.symbol),
		decimals: extractInt(f.decimals, 0),
		ownerPubkey: extractStr(f.owner_pubkey),
		totalSupply: parseUint(extractStr(f.total_supply) || "0"),
		mintRenounced: extractBool(f.mint_renounced),
	};
}

async function buildX402SettleBatch(
	auth: X402Authorization,
	ctx: ProgramContext,
	facilitatorKeyName: string,
): Promise<Array<{ objectId: string; changesBase64: string }>> {
	const { objectActor, dispatchProgram, randomUUID } = ctx;
	const senderPubkey = auth.from;
	const tokenId = auth.asset;
	const amount = auth.value;
	const toPubkey = auth.to;

	const store = ctx.store as any;
	const selected = await store.coinSelect(tokenId, senderPubkey, amount) as { coin_id: string; bucket_id: string; amount: string }[];
	let sum = 0n;
	for (const c of selected) sum += BigInt(c.amount);
	if (sum < BigInt(amount)) {
		throw new Error(`Insufficient balance: have ${sum.toString()}, need ${amount}`);
	}

	const batchEntries: Array<{ objectId: string; changesBase64: string }> = [];

	for (const coin of selected) {
		const bucketActor = objectActor(coin.bucket_id);
		const heads = await bucketActor.getHeads() as string[];
		const spendChange = buildCoinOpChange({
			bucketId: coin.bucket_id,
			parentIds: heads.map(hexDecode),
			timestamp: Date.now(),
			author: "x402-settle",
			op: { kind: "spend", coinId: coin.coin_id },
			blockId: randomUUID().replace(/-/g, "").slice(0, 16),
		});
		const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
		const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
		const { changeB64: signedB64 } = await dispatchProgram("/wallet", "signChange", [{
			name: facilitatorKeyName,
			changeB64: spendB64,
			nonce: nonce + 1,
			fee: 1,
		}]) as { changeB64: string };
		batchEntries.push({ objectId: coin.bucket_id, changesBase64: signedB64 });
	}

	const changeAmount = subChecked(sum, parseUint(amount));
	const outputs: { coinId: string; owner: string; amount: string }[] = [
		{ coinId: randomUUID().replace(/-/g, "").slice(0, 16), owner: toPubkey, amount },
	];
	if (changeAmount > BIG_ZERO) {
		outputs.push({
			coinId: randomUUID().replace(/-/g, "").slice(0, 16),
			owner: senderPubkey,
			amount: bigToString(changeAmount),
		});
	}

	let outputBucketId: string | null = null;
	const allBuckets = await store.list(BUCKET_TYPE_KEY) as { id: string }[];
	for (const ref of allBuckets) {
		const bucket = await store.get(ref.id) as any;
		if (bucket?.fields?.token_id?.linkValue?.targetId !== tokenId) continue;
		const bState = replayBucket(bucket.blocks ?? []);
		let unspentCount = 0;
		for (const c of bState.coins.values()) if (!c.spent) unspentCount++;
		if (unspentCount + outputs.length <= MAX_COINS_PER_BUCKET) {
			outputBucketId = ref.id;
			break;
		}
	}

	if (!outputBucketId) {
		outputBucketId = randomUUID().replace(/-/g, "").slice(0, 24);
		const genesisChange = buildBucketGenesisChange({
			bucketId: outputBucketId,
			timestamp: Date.now(),
			author: "x402-settle",
			tokenId,
		});
		const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
		const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
		const { changeB64: signedGenesisB64 } = await dispatchProgram("/wallet", "signChange", [{
			name: facilitatorKeyName,
			changeB64: genesisB64,
			nonce: nonce + 1,
			fee: 1,
		}]) as { changeB64: string };
		const bucketActor = objectActor(outputBucketId, { createWithInput: { id: outputBucketId } });
		await bucketActor.pushChanges(signedGenesisB64);
	}

	const outBucketActor = objectActor(outputBucketId);
	for (const out of outputs) {
		const heads = await outBucketActor.getHeads() as string[];
		const createChange = buildCoinOpChange({
			bucketId: outputBucketId,
			parentIds: heads.map(hexDecode),
			timestamp: Date.now(),
			author: "x402-settle",
			op: { kind: "create", coinId: out.coinId, ownerPubkey: out.owner, amount: out.amount },
			blockId: randomUUID().replace(/-/g, "").slice(0, 16),
		});
		const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
		const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
		const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
			name: facilitatorKeyName,
			changeB64: createB64,
			nonce: nonce + 1,
			fee: 1,
		}]) as { changeB64: string };
		batchEntries.push({ objectId: outputBucketId, changesBase64: signedCreateB64 });
	}

	return batchEntries;
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print, resolveId, randomUUID, dispatchProgram, objectActor, store } = ctx;

	switch (cmd) {
		case "balance": {
			const rawToken = args[0];
			const pubkey = args[1];
			if (!rawToken || !pubkey) { print(red("Usage: coin balance <token_id> <pubkey_hex>")); break; }
			try {
				const tokenId = (await resolveId(rawToken)) ?? rawToken;
				const bal = await (store as any).coinBalance(tokenId, pubkey) as string;
				const meta = await loadTokenMeta(tokenId, ctx);
				print(`  ${cyan(meta.symbol || "?")}  ${bold(bal)} ` + dim(`(decimals=${meta.decimals})`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "holders": {
			const rawToken = args[0];
			if (!rawToken) { print(red("Usage: coin holders <token_id>")); break; }
			try {
				const tokenId = (await resolveId(rawToken)) ?? rawToken;
				const holders = await (store as any).coinHolders(tokenId) as { pubkey: string; balance: string }[];
				const meta = await loadTokenMeta(tokenId, ctx);
				if (holders.length === 0) {
					print(dim("  (no holders)"));
				} else {
					for (const h of holders) {
						print(`  ${dim(h.pubkey.slice(0, 16) + "...")}  ${bold(h.balance)} ${cyan(meta.symbol)}`);
					}
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "info": {
			const rawToken = args[0];
			if (!rawToken) { print(red("Usage: coin info <token_id>")); break; }
			try {
				const tokenId = (await resolveId(rawToken)) ?? rawToken;
				const meta = await loadTokenMeta(tokenId, ctx);
				const holders = await (store as any).coinHolders(tokenId) as { pubkey: string; balance: string }[];
				let total = 0n;
				for (const h of holders) total += BigInt(h.balance);
				print(bold(`  ${meta.name} (${meta.symbol})`));
				print(dim(`    id:       `) + tokenId);
				print(dim(`    decimals: `) + String(meta.decimals));
				print(dim(`    supply:   `) + total.toString());
				print(dim(`    holders:  `) + String(holders.length));
				print(dim(`    owner:    `) + (meta.ownerPubkey || yellow("(renounced)")));
				print(dim(`    mint:     `) + (meta.mintRenounced ? red("renounced") : green("active")));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "deploy": {
			const name = args[0];
			const symbol = args[1];
			const supplyStr = args[2];
			const decimalsArg = args.find((a) => a.startsWith("--decimals="));
			const decimals = decimalsArg ? Number(decimalsArg.split("=")[1]) : 0;
			const keyArg = args.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (!name || !symbol || !supplyStr) {
				print(red("Usage: coin deploy <name> <symbol> <supply> [--decimals=N] [--key=name]"));
				break;
			}
			if (Number.isNaN(decimals) || decimals < 0 || decimals > 30) {
				print(red("decimals must be in [0, 30]"));
				break;
			}
			try {
				let keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
				if (!keyInfo) {
					print(dim(`Creating wallet key "${keyName}"...`));
					keyInfo = await dispatchProgram("/wallet", "new", [keyName]);
				}
				const pubkey = keyInfo.pubkey as string;
				const supply = parseUint(supplyStr);

				// Create token metadata object
				const tokenId = randomUUID().replace(/-/g, "").slice(0, 24);
				const tokenFields = {
					name: ctx.stringVal(name),
					symbol: ctx.stringVal(symbol),
					decimals: ctx.intVal(decimals),
					owner_pubkey: ctx.stringVal(pubkey),
					total_supply: ctx.stringVal(supplyStr),
					mint_renounced: ctx.boolVal(false),
				};

				const unsignedToken = {
					id: new Uint8Array(0),
					objectId: tokenId,
					parentIds: [],
					ops: [
						{ objectCreate: { typeKey: TOKEN_TYPE_KEY } },
						...Object.entries(tokenFields).map(([key, value]) => ({ fieldSet: { key, value } })),
					],
					timestamp: Date.now(),
					author: "coin-deploy",
				};

				const tokenB64 = Buffer.from(encodeChange(unsignedToken)).toString("base64");
				const { changeB64: signedTokenB64 } = await dispatchProgram("/wallet", "signChange", [{
					name: keyName,
					changeB64: tokenB64,
					nonce: 1,
					fee: 100,
				}]) as { changeB64: string };

				const tokenActor = objectActor(tokenId, { createWithInput: { id: tokenId } });
				await tokenActor.pushChanges(signedTokenB64);

				// Create initial bucket with full supply as one coin
				const bucketId = randomUUID().replace(/-/g, "").slice(0, 24);
				const genesisChange = buildBucketGenesisChange({
					bucketId,
					timestamp: Date.now(),
					author: "coin-deploy",
					tokenId,
				});
				const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
				const { changeB64: signedGenesisB64 } = await dispatchProgram("/wallet", "signChange", [{
					name: keyName,
					changeB64: genesisB64,
					nonce: 2,
					fee: 100,
				}]) as { changeB64: string };

				const bucketActor = objectActor(bucketId, { createWithInput: { id: bucketId } });
				await bucketActor.pushChanges(signedGenesisB64);

				// Mint the initial supply into the bucket
				const coinId = randomUUID().replace(/-/g, "").slice(0, 16);
				const createOp: CoinOp = {
					kind: "create",
					coinId,
					ownerPubkey: pubkey,
					amount: supplyStr,
				};
				const mintChange = buildCoinOpChange({
					bucketId,
					parentIds: [hexDecode(await bucketActor.getHeads().then((h: any) => h[0]))],
					timestamp: Date.now(),
					author: "coin-deploy",
					op: createOp,
					blockId: randomUUID().replace(/-/g, "").slice(0, 16),
				});
				const mintB64 = Buffer.from(encodeChange(mintChange)).toString("base64");
				const nonce3: number = await dispatchProgram("/consensus", "getNonce", [pubkey]) as number;
				const { changeB64: signedMintB64 } = await dispatchProgram("/wallet", "signChange", [{
					name: keyName,
					changeB64: mintB64,
					nonce: nonce3 + 1,
					fee: 10,
				}]) as { changeB64: string };
				await bucketActor.pushChanges(signedMintB64);

				print(green("Coin deployed!"));
				print(dim("  token:  ") + tokenId);
				print(dim("  bucket: ") + bucketId);
				print(dim("  name:   ") + name);
				print(dim("  symbol: ") + symbol);
				print(dim("  supply: ") + supplyStr);
				print(dim("  owner:  ") + pubkey);
			} catch (err: any) {
				print(red("Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "transfer": {
			const rawTokenId = args[0];
			const toPubkey = args[1];
			const amount = args[2];
			const keyArg = args.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (!rawTokenId || !toPubkey || !amount) {
				print(red("Usage: coin transfer <token_id> <to_pubkey> <amount> [--key=name]"));
				break;
			}
			if (!/^[0-9a-f]{64}$/.test(toPubkey)) {
				print(red("recipient pubkey must be 64 hex chars"));
				break;
			}
			try {
				const tokenId = (await resolveId(rawTokenId)) ?? rawTokenId;
				const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
				if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
				const senderPubkey = keyInfo.pubkey as string;

				// Select coins
				const selected = await (store as any).coinSelect(tokenId, senderPubkey, amount) as { coin_id: string; bucket_id: string; amount: string }[];
				let sum = 0n;
				for (const c of selected) sum += BigInt(c.amount);
				if (sum < BigInt(amount)) {
					print(red(`Insufficient balance: have ${sum.toString()}, need ${amount}`));
					break;
				}

				// Build spend changes for each input coin
				const changesToPush: { actor: any; signedB64: string }[] = [];

				for (const coin of selected) {
					const bucketActor = objectActor(coin.bucket_id);
					const heads = await bucketActor.getHeads() as string[];
					const spendChange = buildCoinOpChange({
						bucketId: coin.bucket_id,
						parentIds: heads.map(hexDecode),
						timestamp: Date.now(),
						author: "coin-transfer",
						op: { kind: "spend", coinId: coin.coin_id },
						blockId: randomUUID().replace(/-/g, "").slice(0, 16),
					});
					const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
					const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
					const { changeB64: signedB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: spendB64,
						nonce: nonce + 1,
						fee: 1,
					}]) as { changeB64: string };
					changesToPush.push({ actor: bucketActor, signedB64 });
				}

				// Create output coins
				const changeAmount = subChecked(sum, parseUint(amount));
				const outputs: { coinId: string; owner: string; amount: string }[] = [
					{ coinId: randomUUID().replace(/-/g, "").slice(0, 16), owner: toPubkey, amount },
				];
				if (changeAmount > BIG_ZERO) {
					outputs.push({
						coinId: randomUUID().replace(/-/g, "").slice(0, 16),
						owner: senderPubkey,
						amount: bigToString(changeAmount),
					});
				}

				// Find or create output bucket
				let outputBucketId: string | null = null;
				const allBuckets = await (store as any).list(BUCKET_TYPE_KEY) as { id: string }[];
				for (const ref of allBuckets) {
					const bucket = await (store as any).get(ref.id) as any;
					if (bucket?.fields?.token_id?.linkValue?.targetId !== tokenId) continue;
					const bState = replayBucket(bucket.blocks ?? []);
					let unspentCount = 0;
					for (const c of bState.coins.values()) if (!c.spent) unspentCount++;
					if (unspentCount + outputs.length <= MAX_COINS_PER_BUCKET) {
						outputBucketId = ref.id;
						break;
					}
				}

				if (!outputBucketId) {
					outputBucketId = randomUUID().replace(/-/g, "").slice(0, 24);
					const genesisChange = buildBucketGenesisChange({
						bucketId: outputBucketId,
						timestamp: Date.now(),
						author: "coin-transfer",
						tokenId,
					});
					const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
					const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
					const { changeB64: signedGenesisB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: genesisB64,
						nonce: nonce + 1,
						fee: 1,
					}]) as { changeB64: string };
					const bucketActor = objectActor(outputBucketId, { createWithInput: { id: outputBucketId } });
					await bucketActor.pushChanges(signedGenesisB64);
				}

				const outBucketActor = objectActor(outputBucketId);
				for (const out of outputs) {
					const heads = await outBucketActor.getHeads() as string[];
					const createChange = buildCoinOpChange({
						bucketId: outputBucketId,
						parentIds: heads.map(hexDecode),
						timestamp: Date.now(),
						author: "coin-transfer",
						op: { kind: "create", coinId: out.coinId, ownerPubkey: out.owner, amount: out.amount },
						blockId: randomUUID().replace(/-/g, "").slice(0, 16),
					});
					const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
					const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
					const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: createB64,
						nonce: nonce + 1,
						fee: 1,
					}]) as { changeB64: string };
					changesToPush.push({ actor: outBucketActor, signedB64: signedCreateB64 });
				}

				// Push all changes
				for (const { actor, signedB64 } of changesToPush) {
					await actor.pushChanges(signedB64);
				}

				print(green(`Transferred ${amount} to ${toPubkey.slice(0, 16)}...`));
				print(dim("  token: ") + tokenId);
				if (changeAmount > BIG_ZERO) {
					print(dim("  change: ") + bigToString(changeAmount) + " back to sender");
				}
			} catch (err: any) {
				print(red("Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "mint": {
			const rawTokenId = args[0];
			const toPubkey = args[1];
			const amount = args[2];
			const keyArg = args.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (!rawTokenId || !toPubkey || !amount) {
				print(red("Usage: coin mint <token_id> <to_pubkey> <amount> [--key=name]"));
				break;
			}
			try {
				const tokenId = (await resolveId(rawTokenId)) ?? rawTokenId;
				const meta = await loadTokenMeta(tokenId, ctx);
				const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
				if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
				const senderPubkey = keyInfo.pubkey as string;

				if (meta.mintRenounced) { print(red("Mint has been renounced")); break; }
				if (senderPubkey !== meta.ownerPubkey) { print(red("Only owner can mint")); break; }

				// Find or create bucket
				let bucketId: string | null = null;
				const allBuckets = await (store as any).list(BUCKET_TYPE_KEY) as { id: string }[];
				for (const ref of allBuckets) {
					const bucket = await (store as any).get(ref.id) as any;
					if (bucket?.fields?.token_id?.linkValue?.targetId !== tokenId) continue;
					const bState = replayBucket(bucket.blocks ?? []);
					let unspentCount = 0;
					for (const c of bState.coins.values()) if (!c.spent) unspentCount++;
					if (unspentCount < MAX_COINS_PER_BUCKET) {
						bucketId = ref.id;
						break;
					}
				}


				if (!bucketId) {
					bucketId = randomUUID().replace(/-/g, "").slice(0, 24);
					const genesisChange = buildBucketGenesisChange({
						bucketId,
						timestamp: Date.now(),
						author: "coin-mint",
						tokenId,
					});
					const genesisB64 = Buffer.from(encodeChange(genesisChange)).toString("base64");
					const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
					const { changeB64: signedGenesisB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: genesisB64,
						nonce: nonce + 1,
						fee: 10,
					}]) as { changeB64: string };
					const bucketActor = objectActor(bucketId, { createWithInput: { id: bucketId } });
					await bucketActor.pushChanges(signedGenesisB64);
				}

				const bucketActor = objectActor(bucketId);
				const heads = await bucketActor.getHeads() as string[];
				const createChange = buildCoinOpChange({
					bucketId,
					parentIds: heads.map(hexDecode),
					timestamp: Date.now(),
					author: "coin-mint",
					op: { kind: "create", coinId: randomUUID().replace(/-/g, "").slice(0, 16), ownerPubkey: toPubkey, amount },
					blockId: randomUUID().replace(/-/g, "").slice(0, 16),
				});
				const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
				const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
				const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
					name: keyName,
					changeB64: createB64,
					nonce: nonce + 1,
					fee: 10,
				}]) as { changeB64: string };
				await bucketActor.pushChanges(signedCreateB64);

				print(green(`Minted ${amount} to ${toPubkey.slice(0, 16)}...`));
				print(dim("  token:  ") + tokenId);
				print(dim("  bucket: ") + bucketId);
			} catch (err: any) {
				print(red("Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "burn": {
			const rawTokenId = args[0];
			const amount = args[1];
			const keyArg = args.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (!rawTokenId || !amount) {
				print(red("Usage: coin burn <token_id> <amount> [--key=name]"));
				break;
			}
			try {
				const tokenId = (await resolveId(rawTokenId)) ?? rawTokenId;
				const meta = await loadTokenMeta(tokenId, ctx);
				const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
				if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
				const senderPubkey = keyInfo.pubkey as string;

				if (senderPubkey !== meta.ownerPubkey) { print(red("Only owner can burn")); break; }

				const selected = await (store as any).coinSelect(tokenId, senderPubkey, amount) as { coin_id: string; bucket_id: string; amount: string }[];
				let sum = 0n;
				for (const c of selected) sum += BigInt(c.amount);
				if (sum < BigInt(amount)) {
					print(red(`Insufficient balance: have ${sum.toString()}, need ${amount}`));
					break;
				}

				// Partial burn: if the last selected coin is larger than needed, we need to
				// spend it and create change back to owner for the remainder.
				const burnAmount = parseUint(amount);
				let remaining = burnAmount;

				for (const coin of selected) {
					const coinAmount = BigInt(coin.amount);
					const bucketActor = objectActor(coin.bucket_id);
					const heads = await bucketActor.getHeads() as string[];

					if (coinAmount > remaining) {
						// Spend the whole coin
						const spendChange = buildCoinOpChange({
							bucketId: coin.bucket_id,
							parentIds: heads.map(hexDecode),
							timestamp: Date.now(),
							author: "coin-burn",
							op: { kind: "spend", coinId: coin.coin_id },
							blockId: randomUUID().replace(/-/g, "").slice(0, 16),
						});
						const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
						const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
						const { changeB64: signedSpendB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: spendB64,
							nonce: nonce + 1,
							fee: 1,
						}]) as { changeB64: string };
						await bucketActor.pushChanges(signedSpendB64);

						// Create change coin for remainder in same bucket
						const changeAmount = bigToString(coinAmount - remaining);
						const newHeads = await bucketActor.getHeads() as string[];
						const createChange = buildCoinOpChange({
							bucketId: coin.bucket_id,
							parentIds: newHeads.map(hexDecode),
							timestamp: Date.now(),
							author: "coin-burn",
							op: { kind: "create", coinId: randomUUID().replace(/-/g, "").slice(0, 16), ownerPubkey: senderPubkey, amount: changeAmount },
							blockId: randomUUID().replace(/-/g, "").slice(0, 16),
						});
						const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
						const nonce2: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
						const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: createB64,
							nonce: nonce2 + 1,
							fee: 1,
						}]) as { changeB64: string };
						await bucketActor.pushChanges(signedCreateB64);
						remaining = BIG_ZERO;
						break;
					} else {
						// Spend exact or partial from this coin
						const spendChange = buildCoinOpChange({
							bucketId: coin.bucket_id,
							parentIds: heads.map(hexDecode),
							timestamp: Date.now(),
							author: "coin-burn",
							op: { kind: "spend", coinId: coin.coin_id },
							blockId: randomUUID().replace(/-/g, "").slice(0, 16),
						});
						const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
						const nonce: number = await dispatchProgram("/consensus", "getNonce", [senderPubkey]) as number;
						const { changeB64: signedSpendB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: spendB64,
							nonce: nonce + 1,
							fee: 1,
						}]) as { changeB64: string };
						await bucketActor.pushChanges(signedSpendB64);
						remaining -= coinAmount;
					}
				}

				print(green(`Burned ${amount}`));
				print(dim("  token: ") + tokenId);
			} catch (err: any) {
				print(red("Error: ") + (err?.message ?? String(err)));
			}
			break;
		}


		case "offer": {
			const sub = args[0];
			const rest = args.slice(1);
			const keyArg = rest.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (sub === "create") {
				// offer create <token_id> <amount> <request_token_id> <request_amount> [--key=name]
				const [tokenId, amount, reqTokenId, reqAmount] = rest.filter((a) => !a.startsWith("--"));
				if (!tokenId || !amount || !reqTokenId || !reqAmount) {
					print(red("Usage: coin offer create <token_id> <amount> <request_token_id> <request_amount> [--key=name]"));
					break;
				}
				try {
					const resolvedToken = (await resolveId(tokenId)) ?? tokenId;
					const resolvedReq = (await resolveId(reqTokenId)) ?? reqTokenId;
					const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
					if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
					const makerPubkey = keyInfo.pubkey as string;

					// Select coins to escrow
					const selected = await (store as any).coinSelect(resolvedToken, makerPubkey, amount) as { coin_id: string; bucket_id: string; amount: string }[];
					let sum = 0n;
					for (const c of selected) sum += BigInt(c.amount);
					if (sum < BigInt(amount)) {
						print(red(`Insufficient balance: have ${sum.toString()}, need ${amount}`));
						break;
					}

					// Build batch: bucket spends + offer genesis + offer escrow
					const offerId = randomUUID().replace(/-/g, "").slice(0, 24);
					const batchEntries: Array<{ objectId: string; changesBase64: string }> = [];

					// 1. Spend maker's coins from their bucket(s)
					for (const coin of selected) {
						const bucketActor = objectActor(coin.bucket_id);
						const heads = await bucketActor.getHeads() as string[];
						const spendChange = buildCoinOpChange({
							bucketId: coin.bucket_id,
							parentIds: heads.map(hexDecode),
							timestamp: Date.now(),
							author: "offer-create",
							op: { kind: "spend", coinId: coin.coin_id },
							blockId: randomUUID().replace(/-/g, "").slice(0, 16),
						});
						const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
						const nonce: number = await dispatchProgram("/consensus", "getNonce", [makerPubkey]) as number;
						const { changeB64: signedSpendB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: spendB64,
							nonce: nonce + 1,
							fee: 10,
						}]) as { changeB64: string };
						batchEntries.push({ objectId: coin.bucket_id, changesBase64: signedSpendB64 });
					}

					// 2. Offer genesis
					const genesisChange = await (actorDef.actions!.buildOfferGenesis as any)({}, {
						offerId,
						timestamp: Date.now(),
						author: "offer-create",
						makerPubkey,
						terms: {
							offered: [{ tokenId: resolvedToken, amount }],
							requested: [{ tokenId: resolvedReq, amount: reqAmount }],
						},
					}) as { changeB64: string };
					const nonce2: number = await dispatchProgram("/consensus", "getNonce", [makerPubkey]) as number;
					const { changeB64: signedGenesisB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: genesisChange.changeB64,
						nonce: nonce2 + 1,
						fee: 100,
					}]) as { changeB64: string };
					batchEntries.push({ objectId: offerId, changesBase64: signedGenesisB64 });

					// 3. Escrow coins in offer
					for (const coin of selected) {
						const escrowChange = buildCoinOpChange({
							bucketId: offerId,
							parentIds: [], // genesis is parent
							timestamp: Date.now(),
							author: "offer-create",
							op: {
								kind: "offer_escrow",
								coinId: coin.coin_id,
								ownerPubkey: makerPubkey,
								amount: coin.amount,
								tokenId: resolvedToken,
							},
							blockId: randomUUID().replace(/-/g, "").slice(0, 16),
						});
						const escrowB64 = Buffer.from(encodeChange(escrowChange)).toString("base64");
						const nonce: number = await dispatchProgram("/consensus", "getNonce", [makerPubkey]) as number;
						const { changeB64: signedEscrowB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: escrowB64,
							nonce: nonce + 1,
							fee: 10,
						}]) as { changeB64: string };
						batchEntries.push({ objectId: offerId, changesBase64: signedEscrowB64 });
					}

					// Submit batch
					const client = ctx.client as any;
					const storeActor = client.storeActor.getOrCreate(["root"]);
					await storeActor.pushChangesBatch(JSON.stringify(batchEntries));

					print(green("Offer created!"));
					print(dim("  offer:  ") + offerId);
					print(dim("  maker:  ") + makerPubkey.slice(0, 16) + "...");
					print(dim("  offered: ") + amount + " " + resolvedToken);
					print(dim("  requested: ") + reqAmount + " " + resolvedReq);
				} catch (err: any) {
					print(red("Error: ") + (err?.message ?? String(err)));
				}
				break;
			}

			if (sub === "accept") {
				const offerId = rest[0];
				if (!offerId) { print(red("Usage: coin offer accept <offer_id> [--key=name]")); break; }
				try {
					const offerObj = await store.get(offerId);
					if (!offerObj || offerObj.typeKey !== OFFER_TYPE_KEY) {
						print(red("Not found or not an offer: ") + offerId);
						break;
					}
					const termsJson = extractStr(offerObj.fields?.terms);
					const terms = JSON.parse(termsJson) as OfferTerms;
					const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
					if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
					const takerPubkey = keyInfo.pubkey as string;


					// Select payment coins for each requested token
					const batchEntries: Array<{ objectId: string; changesBase64: string }> = [];
					let insufficient = false;

					for (const req of terms.requested) {
						const selected = await (store as any).coinSelect(req.tokenId, takerPubkey, req.amount) as { coin_id: string; bucket_id: string; amount: string }[];
						let sum = 0n;
						for (const c of selected) sum += BigInt(c.amount);
						if (sum < BigInt(req.amount)) {
							print(red(`Insufficient ${req.tokenId} balance: have ${sum.toString()}, need ${req.amount}`));
							insufficient = true;
							break;
						}
						// Spend taker's payment coins
						for (const coin of selected) {
							const bucketActor = objectActor(coin.bucket_id);
							const heads = await bucketActor.getHeads() as string[];
							const spendChange = buildCoinOpChange({
								bucketId: coin.bucket_id,
								parentIds: heads.map(hexDecode),
								timestamp: Date.now(),
								author: "offer-accept",
								op: { kind: "spend", coinId: coin.coin_id },
								blockId: randomUUID().replace(/-/g, "").slice(0, 16),
							});
							const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
							const nonce: number = await dispatchProgram("/consensus", "getNonce", [takerPubkey]) as number;
							const { changeB64: signedSpendB64 } = await dispatchProgram("/wallet", "signChange", [{
								name: keyName,
								changeB64: spendB64,
								nonce: nonce + 1,
								fee: 10,
							}]) as { changeB64: string };
							batchEntries.push({ objectId: coin.bucket_id, changesBase64: signedSpendB64 });
						}
						// Pay into offer
						for (const coin of selected) {
							const payChange = buildCoinOpChange({
								bucketId: offerId,
								parentIds: [], // will be resolved by validator
								timestamp: Date.now(),
								author: "offer-accept",
								op: {
									kind: "offer_pay",
									coinId: coin.coin_id,
									ownerPubkey: takerPubkey,
									amount: coin.amount,
									tokenId: req.tokenId,
								},
								blockId: randomUUID().replace(/-/g, "").slice(0, 16),
							});
							const payB64 = Buffer.from(encodeChange(payChange)).toString("base64");
							const nonce: number = await dispatchProgram("/consensus", "getNonce", [takerPubkey]) as number;
							const { changeB64: signedPayB64 } = await dispatchProgram("/wallet", "signChange", [{
								name: keyName,
								changeB64: payB64,
								nonce: nonce + 1,
								fee: 10,
							}]) as { changeB64: string };
							batchEntries.push({ objectId: offerId, changesBase64: signedPayB64 });
						}

					}
					if (insufficient) { break; }


					// Build settlement with outputs.
					// and haven't been replayed into offerState yet.
					const outputs: Array<{ coin_id: string; owner_pubkey: string; amount: string; token_id: string }> = [];
					// Maker gets requested tokens
					for (const req of terms.requested) {
						outputs.push({
							coin_id: randomUUID().replace(/-/g, "").slice(0, 16),
							owner_pubkey: extractStr(offerObj.fields?.maker_pubkey),
							amount: req.amount,
							token_id: req.tokenId,
						});
					}
					// Taker gets offered tokens
					for (const off of terms.offered) {
						outputs.push({
							coin_id: randomUUID().replace(/-/g, "").slice(0, 16),
							owner_pubkey: takerPubkey,
							amount: off.amount,
							token_id: off.tokenId,
						});
					}

					const settleChange = buildCoinOpChange({
						bucketId: offerId,
						parentIds: [],
						timestamp: Date.now(),
						author: "offer-accept",
						op: {
							kind: "offer_settle",
							coinId: randomUUID().replace(/-/g, "").slice(0, 16),
							outputs: JSON.stringify(outputs),
						},
						blockId: randomUUID().replace(/-/g, "").slice(0, 16),
					});
					const settleB64 = Buffer.from(encodeChange(settleChange)).toString("base64");
					const nonce: number = await dispatchProgram("/consensus", "getNonce", [takerPubkey]) as number;
					const { changeB64: signedSettleB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: settleB64,
						nonce: nonce + 1,
						fee: 10,
					}]) as { changeB64: string };
					batchEntries.push({ objectId: offerId, changesBase64: signedSettleB64 });

					// Create output coins in offer
					for (const out of outputs) {
						const createChange = buildCoinOpChange({
							bucketId: offerId,
							parentIds: [],
							timestamp: Date.now(),
							author: "offer-accept",
							op: {
								kind: "create",
								coinId: out.coin_id,
								ownerPubkey: out.owner_pubkey,
								amount: out.amount,
								tokenId: out.token_id,
							},
							blockId: out.coin_id,
						});
						const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
						const nonce: number = await dispatchProgram("/consensus", "getNonce", [takerPubkey]) as number;
						const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: createB64,
							nonce: nonce + 1,
							fee: 1,
						}]) as { changeB64: string };
						batchEntries.push({ objectId: offerId, changesBase64: signedCreateB64 });
					}

					// Submit batch
					const client = ctx.client as any;
					const storeActor = client.storeActor.getOrCreate(["root"]);
					await storeActor.pushChangesBatch(JSON.stringify(batchEntries));

					print(green("Offer accepted and settled!"));
					print(dim("  offer:  ") + offerId);
					print(dim("  taker:  ") + takerPubkey.slice(0, 16) + "...");
				} catch (err: any) {
					print(red("Error: ") + (err?.message ?? String(err)));
				}
				break;
			}

			if (sub === "cancel") {
				const offerId = rest[0];
				if (!offerId) { print(red("Usage: coin offer cancel <offer_id> [--key=name]")); break; }
				try {
					const offerObj = await store.get(offerId);
					if (!offerObj || offerObj.typeKey !== OFFER_TYPE_KEY) {
						print(red("Not found or not an offer: ") + offerId);
						break;
					}
					const makerPubkey = extractStr(offerObj.fields?.maker_pubkey);
					const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
					if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
					const signerPubkey = keyInfo.pubkey as string;
					if (signerPubkey !== makerPubkey) {
						print(red("Only the maker can cancel an offer"));
						break;
					}

					const cancelChange = buildCoinOpChange({
						bucketId: offerId,
						parentIds: [],
						timestamp: Date.now(),
						author: "offer-cancel",
						op: {
							kind: "offer_cancel",
							coinId: randomUUID().replace(/-/g, "").slice(0, 16),
						},
						blockId: randomUUID().replace(/-/g, "").slice(0, 16),
					});
					const cancelB64 = Buffer.from(encodeChange(cancelChange)).toString("base64");
					const nonce: number = await dispatchProgram("/consensus", "getNonce", [signerPubkey]) as number;
					const { changeB64: signedCancelB64 } = await dispatchProgram("/wallet", "signChange", [{
						name: keyName,
						changeB64: cancelB64,
						nonce: nonce + 1,
						fee: 10,
					}]) as { changeB64: string };

					const offerActor = objectActor(offerId);
					await offerActor.pushChanges(signedCancelB64);

					print(green("Offer cancelled. Escrow returned to maker."));
					print(dim("  offer: ") + offerId);
				} catch (err: any) {
					print(red("Error: ") + (err?.message ?? String(err)));
				}

				break;
			}

			if (sub === "claim") {
				const offerId = rest[0];
				if (!offerId) { print(red("Usage: coin offer claim <offer_id> [--key=name]")); break; }
				try {
					const offerObj = await store.get(offerId);
					if (!offerObj || offerObj.typeKey !== OFFER_TYPE_KEY) {
						print(red("Not found or not an offer: ") + offerId);
						break;
					}
					const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
					if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
					const claimerPubkey = keyInfo.pubkey as string;

					const state = replayOffer(offerObj.blocks ?? []);
					const myOutputs = Array.from(state.outputs.entries()).filter(([_, o]) => o.owner === claimerPubkey && !o.spent);
					if (myOutputs.length === 0) {
						print(dim("No claimable outputs for this key."));
						break;
					}

					const batchEntries: Array<{ objectId: string; changesBase64: string }> = [];
					for (const [coinId, out] of myOutputs) {
						// Find or create a bucket for this token

						let bucketId: string | null = null;
						const refs = await store.list(BUCKET_TYPE_KEY);
						for (const ref of refs) {

							const b = await store.get(ref.id);

							const tid = b?.fields?.token_id?.linkValue?.targetId as string | undefined;
							if (tid === out.tokenId) {
								bucketId = ref.id;
								break;
							}
						}
						if (!bucketId) {
							print(red(`No bucket found for token ${out.tokenId}`));
							break;
						}
						const bucketActor = objectActor(bucketId);
						const heads = await bucketActor.getHeads() as string[];

						// Spend the output in the offer
						const spendChange = buildCoinOpChange({
							bucketId: offerId,
							parentIds: [],
							timestamp: Date.now(),
							author: "offer-claim",
							op: { kind: "spend", coinId },
							blockId: randomUUID().replace(/-/g, "").slice(0, 16),
						});
						const spendB64 = Buffer.from(encodeChange(spendChange)).toString("base64");
						const nonce1: number = await dispatchProgram("/consensus", "getNonce", [claimerPubkey]) as number;
						const { changeB64: signedSpendB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: spendB64,
							nonce: nonce1 + 1,
							fee: 10,
						}]) as { changeB64: string };
						batchEntries.push({ objectId: offerId, changesBase64: signedSpendB64 });

						// Create the coin in the claimer's bucket
						const createChange = buildCoinOpChange({
							bucketId,
							parentIds: heads.map(hexDecode),
							timestamp: Date.now(),
							author: "offer-claim",
							op: { kind: "create", coinId: randomUUID().replace(/-/g, "").slice(0, 16), ownerPubkey: claimerPubkey, amount: out.amount, tokenId: out.tokenId },
							blockId: randomUUID().replace(/-/g, "").slice(0, 16),
						});
						const createB64 = Buffer.from(encodeChange(createChange)).toString("base64");
						const nonce2: number = await dispatchProgram("/consensus", "getNonce", [claimerPubkey]) as number;
						const { changeB64: signedCreateB64 } = await dispatchProgram("/wallet", "signChange", [{
							name: keyName,
							changeB64: createB64,
							nonce: nonce2 + 1,
							fee: 10,
						}]) as { changeB64: string };
						batchEntries.push({ objectId: bucketId, changesBase64: signedCreateB64 });
					}

					if (batchEntries.length === 0) {
						print(dim("Nothing to claim."));
						break;
					}

					await (store as any).pushChangesBatch(JSON.stringify(batchEntries));
					print(green("Claimed outputs!"));
					for (const [coinId, out] of myOutputs) {
						print(`  ${out.amount} ${cyan(out.tokenId.slice(0, 8) + "...")} → your bucket`);
					}
				} catch (err: any) {
					print(red("Error: ") + (err?.message ?? String(err)));
				}
				break;
			}

			if (sub === "list") {
				try {
					const refs = await store.list(OFFER_TYPE_KEY);
					if (refs.length === 0) { print(dim("  (no offers)")); break; }
					for (const r of refs) {
						const obj = await store.get(r.id);
						const state = replayOffer(obj?.blocks ?? []);
						const status = state.status;
						const termsJson = extractStr(obj?.fields?.terms);
						let termsStr = "";
						try {
							const terms = JSON.parse(termsJson) as OfferTerms;
							const offered = terms.offered.map((o) => `${o.amount} ${o.tokenId.slice(0, 8)}...`).join(", ");
							const requested = terms.requested.map((o) => `${o.amount} ${o.tokenId.slice(0, 8)}...`).join(", ");
							termsStr = `${offered} → ${requested}`;
						} catch {
							termsStr = "(invalid terms)";
						}

						print(`  ${cyan(status.padEnd(10))} ${dim(r.id.slice(0, 16) + "...")}  ${termsStr}`);
					}
				} catch (err: any) {
					print(red("Error: ") + (err?.message ?? String(err)));
				}
				break;
			}

			if (sub === "info") {
				const offerId = rest[0];
				if (!offerId) { print(red("Usage: coin offer info <offer_id>")); break; }
				try {
					const obj = await store.get(offerId);
					if (!obj || obj.typeKey !== OFFER_TYPE_KEY) {
						print(red("Not found or not an offer: ") + offerId);
						break;
					}

					const maker = extractStr(obj.fields?.maker_pubkey);
					const termsJson = extractStr(obj.fields?.terms);
					let terms: OfferTerms | null = null;
					try { terms = JSON.parse(termsJson); } catch { /* ignore */ }

					// Show replay state
					const state = replayOffer(obj.blocks ?? []);
					const status = state.status;


					print(bold("Offer ") + dim(offerId));
					print(dim("  status: ") + cyan(status));
					print(dim("  maker:  ") + (maker ? maker.slice(0, 16) + "..." : "?"));
					if (terms) {
						print(dim("  offered:"));
						for (const o of terms.offered) {
							print(`    ${o.amount} ${cyan(o.tokenId.slice(0, 12) + "...")}`);
						}
						print(dim("  requested:"));
						for (const o of terms.requested) {
							print(`    ${o.amount} ${cyan(o.tokenId.slice(0, 12) + "...")}`);
						}
					}

					if (state.escrowed.size > 0) {
						print(dim("  escrowed:"));
						for (const [id, c] of state.escrowed) {
							print(`    ${id.slice(0, 8)}... ${c.amount} ${c.tokenId.slice(0, 8)}... (${c.spent ? red("spent") : green("active")})`);
						}
					}
					if (state.payments.size > 0) {
						print(dim("  payments:"));
						for (const [id, c] of state.payments) {
							print(`    ${id.slice(0, 8)}... ${c.amount} ${c.tokenId.slice(0, 8)}... (${c.spent ? red("spent") : green("active")})`);
						}
					}
					if (state.outputs.size > 0) {
						print(dim("  outputs (claimable):"));
						for (const [id, c] of state.outputs) {
							print(`    ${id.slice(0, 8)}... ${c.amount} ${c.tokenId.slice(0, 8)}... → ${c.owner.slice(0, 16)}...`);
						}
					}
				} catch (err: any) {
					print(red("Error: ") + (err?.message ?? String(err)));
				}
				break;
			}

			if (sub === "export") {
				const offerId = rest[0];
				const fileArg = rest.find((a) => a.startsWith("--file="));
				if (!offerId) { print(red("Usage: coin offer export <offer_id> [--file=path]")); break; }
				try {
					const obj = await store.get(offerId);
					if (!obj || obj.typeKey !== OFFER_TYPE_KEY) {
						print(red("Not found or not an offer: ") + offerId);
						break;
					}
					const offerFile = {
						version: 1,
						offer_id: offerId,
						nonce: extractStr(obj.fields?.nonce),
						maker_pubkey: extractStr(obj.fields?.maker_pubkey),
						terms: JSON.parse(extractStr(obj.fields?.terms)),
						status: extractStr(obj.fields?.status),
						timestamp: obj.updatedAt,
					};
					const json = JSON.stringify(offerFile, null, 2);
					if (fileArg) {
						const fs = await import("node:fs");
						fs.writeFileSync(fileArg.split("=")[1], json);
						print(green("Offer exported to ") + fileArg.split("=")[1]);
					} else {
						print(json);
					}
				} catch (err: any) {
					print(red("Error: ") + (err?.message ?? String(err)));
				}
				break;
			}

			if (sub === "import") {
				const filePath = rest[0];
				if (!filePath) { print(red("Usage: coin offer import <file>")); break; }
				try {
					const fs = await import("node:fs");
					const json = fs.readFileSync(filePath, "utf-8");
					const offerFile = JSON.parse(json);
					print(bold("Imported offer:"));
					print(dim("  id:     ") + offerFile.offer_id);
					print(dim("  status: ") + cyan(offerFile.status));
					print(dim("  maker:  ") + (offerFile.maker_pubkey?.slice(0, 16) + "..." || "?"));
					if (offerFile.terms) {
						print(dim("  offered:"));
						for (const o of offerFile.terms.offered) {
							print(`    ${o.amount} ${cyan(o.tokenId?.slice(0, 12) + "...")}`);
						}
						print(dim("  requested:"));
						for (const o of offerFile.terms.requested) {
							print(`    ${o.amount} ${cyan(o.tokenId?.slice(0, 12) + "...")}`);
						}
					}
					print(dim("\nTo accept: coin offer accept ") + offerFile.offer_id + " --key=<your-key>");
				} catch (err: any) {
					print(red("Error: ") + (err?.message ?? String(err)));
				}
				break;
			}


			print([
				bold("  Offer") + dim(" — peer-to-peer atomic swaps via chain.coin.offer"),
				`    ${cyan("coin offer create")} ${dim("<token_id> <amount> <request_token_id> <request_amount> [--key=name]")}  create + escrow`,
				`    ${cyan("coin offer accept")} ${dim("<offer_id> [--key=name]")}                              taker pays + settles`,
				`    ${cyan("coin offer cancel")} ${dim("<offer_id> [--key=name]")}                              maker cancels`,
				`    ${cyan("coin offer claim")} ${dim("<offer_id> [--key=name]")}                              claim settled outputs`,
				`    ${cyan("coin offer list")} ${dim("")}                                         all open offers`,
				`    ${cyan("coin offer info")} ${dim("<offer_id>")}                                details + state`,
				`    ${cyan("coin offer export")} ${dim("<offer_id> [--file=path]")}                    JSON offer file`,
				`    ${cyan("coin offer import")} ${dim("<file>")}                                  inspect offer file`,
				dim("  Uses cross-object batch validation (pushChangesBatch) for atomic settlement."),
			].join("\n"));
			break;
		}

		case "authorize": {
			const rawTokenId = args[0];
			const amount = args[1];
			const toPubkey = args[2];
			const validForArg = args.find((a) => a.startsWith("--valid-for="));
			const validForSec = validForArg ? Number(validForArg.split("=")[1]) : 60;
			const keyArg = args.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (!rawTokenId || !amount || !toPubkey) {
				print(red("Usage: coin authorize <token_id> <amount> <recipient_pubkey> [--valid-for=seconds] [--key=name]"));
				break;
			}
			try {
				const tokenId = (await resolveId(rawTokenId)) ?? rawTokenId;
				const keyInfo: any = await dispatchProgram("/wallet", "show", [keyName]);
				if (!keyInfo) { print(red(`Wallet key "${keyName}" not found`)); break; }
				const payerPubkey = keyInfo.pubkey as string;

				// Generate random 32-byte nonce
				const nonceBytes = randomBytes(32);
				const nonceHex = nonceBytes.toString("hex");

				const now = Math.floor(Date.now() / 1000);
				const auth: X402Authorization = {
					scheme: "exact",
					network: "glon:v1",
					from: payerPubkey,
					to: toPubkey,
					value: amount,
					asset: tokenId,
					validAfter: now,
					validBefore: now + validForSec,
					nonce: nonceHex,
				};


				const msg = canonicalAuthBytes(auth);
				const { signature } = await dispatchProgram("/wallet", "sign", [keyName, Buffer.from(msg).toString("base64")]) as { signature: string };

				print(green("Authorization created"));
				print(dim("  from: ") + payerPubkey.slice(0, 16) + "...");
				print(dim("  to:   ") + toPubkey.slice(0, 16) + "...");
				print(dim("  value: ") + amount);
				print(dim("  asset: ") + tokenId.slice(0, 16) + "...");
				print(dim("  valid: ") + auth.validAfter + " → " + auth.validBefore);
				print(dim("  nonce: ") + nonceHex.slice(0, 16) + "...");

				print(JSON.stringify({ authorization: auth, signature }));
			} catch (err: any) {
				print(red("Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "settle": {
			const authJson = args[0];
			const signatureHex = args[1];
			const keyArg = args.find((a) => a.startsWith("--key="));
			const keyName = keyArg ? keyArg.split("=")[1] : "default";

			if (!authJson || !signatureHex) {
				print(red("Usage: coin settle <authorization_json> <signature_hex> [--key=name]"));
				break;
			}
			try {
				const parsed = JSON.parse(authJson);
				const auth: X402Authorization = parsed.authorization ?? parsed;

				if (!verifyX402Auth(auth, signatureHex)) {
					print(red("Invalid authorization signature"));
					break;
				}

				const now = Math.floor(Date.now() / 1000);
				if (now < auth.validAfter) {
					print(red("Authorization not yet valid"));
					break;
				}
				if (now >= auth.validBefore) {
					print(red("Authorization expired"));
					break;
				}

				// Check nonce not consumed
				const consensusStatus: any = await dispatchProgram("/consensus", "status", []);
				if (consensusStatus.authNonces?.includes(auth.nonce)) {
					print(red("Authorization nonce already consumed"));
					break;
				}

				const batch = await buildX402SettleBatch(auth, ctx, keyName);
				await (store as any).pushChangesBatch(JSON.stringify(batch));

				// Record nonce consumed
				await dispatchProgram("/consensus", "recordX402Accepted", [auth.nonce]);

				print(green("Settled!"));
				print(dim("  amount: ") + auth.value);
				print(dim("  to:     ") + auth.to.slice(0, 16) + "...");
				print(dim("  nonce:  ") + auth.nonce.slice(0, 16) + "...");
			} catch (err: any) {
				print(red("Error: ") + (err?.message ?? String(err)));
			}
			break;
		}


		default: {

			print([
				bold("  Coin") + dim(" — UTXO fungible token (chain.coin.bucket / chain.token)"),
				`    ${cyan("coin deploy")} ${dim("<name> <symbol> <supply> [--decimals=N] [--key=name]")}  deploy a new token`,
				`    ${cyan("coin transfer")} ${dim("<token_id> <to_pubkey> <amount> [--key=name]")}  send coins`,
				`    ${cyan("coin mint")} ${dim("<token_id> <to_pubkey> <amount> [--key=name]")}     mint new coins (owner only)`,
				`    ${cyan("coin burn")} ${dim("<token_id> <amount> [--key=name]")}            burn coins (owner only)`,
				`    ${cyan("coin balance")} ${dim("<token_id> <pubkey>")}            balance for one holder`,
				`    ${cyan("coin holders")} ${dim("<token_id>")}                  all balances, descending`,
				`    ${cyan("coin info")} ${dim("<token_id>")}                     metadata + supply + owner`,
				`    ${cyan("coin offer")} ${dim("<subcommand>")}                      peer-to-peer atomic swaps`,
				`    ${cyan("coin authorize")} ${dim("<token_id> <amount> <to_pubkey> [--valid-for=60] [--key=name]")}  sign x402 authorization`,

				`    ${cyan("coin settle")} ${dim("<auth_json> <sig_hex> [--key=name]")}          settle x402 authorization`,
				dim(`  Each token is backed by chain.coin.bucket objects (max ${MAX_COINS_PER_BUCKET} coins each).`),

			].join("\n"));
		}
	}
};

	const actorDef: ProgramActorDef = {
		createState: () => ({}),
		actions: {

			/** Build a signed x402 authorization. Returns { authorization, signature }. */
			authorizePayment: async (ctx: ProgramContext, input: {
				tokenId: string;
				amount: string;
				recipient: string;
				validForSec?: number;
				keyName?: string;
			}): Promise<{ authorization: X402Authorization; signature: string }> => {
				const keyName = input.keyName ?? "default";
				const keyInfo = await ctx.dispatchProgram("/wallet", "show", [keyName]) as { pubkey: string } | null;
				if (!keyInfo) throw new Error(`wallet key "${keyName}" not found`);
				const nonceBytes = randomBytes(32);
				const nonceHex = nonceBytes.toString("hex");
				const now = Math.floor(Date.now() / 1000);
				const auth: X402Authorization = {
					scheme: "exact",
					network: "glon:v1",
					from: keyInfo.pubkey,
					to: input.recipient,
					value: input.amount,
					asset: input.tokenId,
					validAfter: now,
					validBefore: now + (input.validForSec ?? 60),
					nonce: nonceHex,
				};
				const msg = canonicalAuthBytes(auth);
				const { signature } = await ctx.dispatchProgram("/wallet", "sign", [keyName, Buffer.from(msg).toString("base64")]) as { signature: string };
				return { authorization: auth, signature };
			},

			/** Settle an x402 authorization. Returns { ok: true } or throws. */
			settlePayment: async (ctx: ProgramContext, input: {
				authorization: X402Authorization;
				signature: string;
				keyName?: string;
			}): Promise<{ ok: true }> => {
				if (!verifyX402Auth(input.authorization, input.signature)) {
					throw new Error("x402: invalid authorization signature");
				}
				const now = Math.floor(Date.now() / 1000);
				if (now < input.authorization.validAfter) throw new Error("x402: authorization not yet valid");
				if (now >= input.authorization.validBefore) throw new Error("x402: authorization expired");

				const batch = await buildX402SettleBatch(input.authorization, ctx, input.keyName ?? "default");
				const store = ctx.store as any;
				await store.pushChangesBatch(JSON.stringify(batch));

				// Record nonce consumed
				await ctx.dispatchProgram("/consensus", "recordX402Accepted", [input.authorization.nonce]);

				return { ok: true };
			},
		},
		typedActions: {

			validate_op: {
				description: "Validate a coin operation change against current bucket state",
				inputSchema: {
					type: "object",
					required: ["objectId", "changeB64"],
					properties: {
						objectId: { type: "string" },
						changeB64: { type: "string" },
					},
				},
				handler: async (
					ctx: ProgramContext,
					input: { objectId: string; changeB64: string },
				): Promise<ValidationResult> => {
					const store = ctx.store as any;
					const obj = await store.get(input.objectId);
					const priorBlocks = obj?.blocks ?? [];
					const typeKey = obj?.typeKey ?? "";
					const change = decodeChange(new Uint8Array(Buffer.from(input.changeB64, "base64")));
					if (typeKey === OFFER_TYPE_KEY) {
						return validateOfferChange(change, priorBlocks);
					}
					return validateBucketChange(change, priorBlocks);
				},
			},

			buildBucketGenesis: {
				description: "Build a genesis change for a new coin bucket",
				inputSchema: {
					type: "object",
					required: ["bucketId", "timestamp", "author", "tokenId"],
					properties: {
						bucketId: { type: "string" },
						timestamp: { type: "integer" },
						author: { type: "string" },
						tokenId: { type: "string" },
						capacity: { type: "integer" },
					},
				},
				handler: async (_ctx: ProgramContext, args: {
					bucketId: string;
					timestamp: number;
					author: string;
					tokenId: string;
					capacity?: number;
				}): Promise<{ changeB64: string }> => {
					const change = buildBucketGenesisChange(args);
					return { changeB64: Buffer.from(encodeChange(change)).toString("base64") };
				},
			},

			buildCoinOp: {
				description: "Build a change containing a single coin operation",
				inputSchema: {
					type: "object",
					required: ["bucketId", "parentIds", "timestamp", "author", "op", "blockId"],
					properties: {
						bucketId: { type: "string" },
						parentIds: { type: "array", items: { type: "string" } },
						timestamp: { type: "integer" },
						author: { type: "string" },
						op: { type: "object" },
						blockId: { type: "string" },
					},
				},
				handler: async (_ctx: ProgramContext, args: {
					bucketId: string;
					parentIds: string[];
					timestamp: number;
					author: string;
					op: CoinOp;
					blockId: string;
				}): Promise<{ changeB64: string }> => {
					const change = buildCoinOpChange({
						bucketId: args.bucketId,
						parentIds: args.parentIds.map(hexDecode),
						timestamp: args.timestamp,
						author: args.author,
						op: args.op,
						blockId: args.blockId,
					});
					return { changeB64: Buffer.from(encodeChange(change)).toString("base64") };
				},
			},

			replayBucket: {
				description: "Replay a bucket's block tree into derived state",
				inputSchema: { type: "array", items: { type: "object" } },
				handler: async (_ctx: ProgramContext, blocks: Block[]): Promise<BucketState> => {
					return replayBucket(blocks);
				},
			},

			buildOfferGenesis: {
				description: "Build a genesis change for a new coin offer",
				inputSchema: {
					type: "object",
					required: ["offerId", "timestamp", "author", "makerPubkey", "terms"],
					properties: {
						offerId: { type: "string" },
						timestamp: { type: "integer" },
						author: { type: "string" },
						makerPubkey: { type: "string" },
						terms: { type: "object" },
					},
				},
				handler: async (_ctx: ProgramContext, args: {
					offerId: string;
					timestamp: number;
					author: string;
					makerPubkey: string;
					terms: OfferTerms;
				}): Promise<{ changeB64: string }> => {
					const termsJson = JSON.stringify(args.terms);
					const change: Change = {
						id: new Uint8Array(0),
						objectId: args.offerId,
						parentIds: [],
						ops: [
							{ objectCreate: { typeKey: OFFER_TYPE_KEY } },
							{ fieldSet: { key: "maker_pubkey", value: { stringValue: args.makerPubkey } } },
							{ fieldSet: { key: "terms", value: { stringValue: termsJson } } },
							{ fieldSet: { key: "status", value: { stringValue: "open" } } },
							{ fieldSet: { key: "nonce", value: { stringValue: crypto.randomUUID().replace(/-/g, "").slice(0, 16) } } },
						],
						timestamp: args.timestamp,
						author: args.author,
					};
					return { changeB64: Buffer.from(encodeChange(change)).toString("base64") };
				},
			},

			replayOffer: {
				description: "Replay an offer's block tree into derived state",
				inputSchema: { type: "array", items: { type: "object" } },
				handler: async (_ctx: ProgramContext, blocks: Block[]): Promise<OfferState> => {
					return replayOffer(blocks);
				},
			},
		},
	};

const program: ProgramDef = {
	handler,
	actor: actorDef,
	validator: (changes: Change[], context?: import("../runtime.js").BatchValidationContext): ValidationResult => {
		for (const change of changes) {
			// Try bucket classification first
			const bucketC = classifyBucketChange(change);
			if (bucketC.kind !== "Unknown") {
				if (bucketC.kind === "Genesis") {
					const ops = change.ops ?? [];
					const hasTokenLink = ops.some((o) =>
						o.fieldSet?.key === "token_id" && o.fieldSet.value?.linkValue?.targetId
					);
					if (!hasTokenLink) return { valid: false, error: "coin: bucket genesis missing token_id link" };
				}
				continue;
			}

			// Try offer classification
			const offerC = classifyOfferChange(change);
			if (offerC.kind !== "Unknown") {
				if (offerC.kind === "Genesis") {
					const ops = change.ops ?? [];
					const hasMaker = ops.some((o) => o.fieldSet?.key === "maker_pubkey");
					const hasTerms = ops.some((o) => o.fieldSet?.key === "terms");
					if (!hasMaker) return { valid: false, error: "offer: genesis missing maker_pubkey" };
					if (!hasTerms) return { valid: false, error: "offer: genesis missing terms" };
				}
				continue;
			}

			return { valid: false, error: `coin: unrecognised change for ${change.objectId}` };
		}
		return { valid: true };
	},
	validatedTypes: [BUCKET_TYPE_KEY, OFFER_TYPE_KEY],
	chainMode: true,
};


	// Re-exports for backward compatibility (tests and external callers).
	export {
		decodeCoinOp,
		encodeCoinOp,
		replayBucket,
		replayOffer,
		validateBucketChange,
		validateOfferChange,
		classifyBucketChange,
		classifyOfferChange,
		buildBucketGenesisChange,
		buildOfferGenesisChange,
		buildCoinOpChange,
		MAX_COINS_PER_BUCKET,
	};
export default program;

// ── Internal exports for testing ─────────────────────────────────



export const __test = {
	decodeCoinOp,
	encodeCoinOp,
	replayBucket,
	replayOffer,
	validateBucketChange,
	validateOfferChange,
	classifyBucketChange,
	classifyOfferChange,
	buildBucketGenesisChange,
	buildCoinOpChange,
	MAX_COINS_PER_BUCKET,
	canonicalAuthBytes,
	verifyX402Auth,
};
