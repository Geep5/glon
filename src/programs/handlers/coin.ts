// /coin — fungible token program backed by the auction-house autobase.
//
// This is the autobase-native rewrite. The old DAG-bucket model lived under
// chain.coin.bucket objects; that's gone. Balances now live as keys in the
// hyperbee view: `balance/<token_id>/<pubkey>` → "<decimal string>".
//
// Commands all become single autobase appends:
//   coin deploy   → coin.deploy op
//   coin mint     → coin.mint op
//   coin transfer → coin.transfer op
//   coin burn     → coin.burn op
//   coin balance  → hyperbee read
//   coin holders  → hyperbee prefix scan
//   coin info     → hyperbee read of token entry
//
// Signatures are Ed25519 over the canonical-sorted JSON of the op without
// `signature`. Apply verifies in ledger-host.verifyOpSignature.
//
// Token ids are content-addressed: sha256(canonical(coin.deploy op without
// id/signature)) — same scheme as auction ids. Stable across nodes.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, green, red, yellow } from "../shared.js";
import { sha256, hexEncode } from "../../crypto.js";
import {
	appendOp,
	viewGet,
	viewList,
	isReady as autobaseReady,
	type AuctionOp,
	type CoinDeployOp,
	type CoinMintOp,
	type CoinTransferOp,
	type CoinBurnOp,
} from "../../ledger-host.js";

// ── Helpers ──────────────────────────────────────────────────────

function requireAutobase(): void {
	if (!autobaseReady()) {
		throw new Error("coin: autobase not initialised (start daemon with GLON_AUCTION=1)");
	}
}

function canonicalSigningBytes(op: Record<string, unknown>): Uint8Array {
	const copy: Record<string, unknown> = {};
	for (const k of Object.keys(op).sort()) {
		if (k === "signature" || k === "id") continue;
		copy[k] = op[k];
	}
	return new TextEncoder().encode(JSON.stringify(copy));
}

async function signOp(ctx: ProgramContext, keyName: string, op: Omit<AuctionOp, "signature">): Promise<string> {
	const messageB64 = Buffer.from(canonicalSigningBytes(op as Record<string, unknown>)).toString("base64");
	const result = await ctx.dispatchProgram("/wallet", "sign", [keyName, messageB64]) as { signature: string; pubkey: string };
	return result.signature;
}

async function walletPubkey(ctx: ProgramContext, keyName: string): Promise<string> {
	const info = await ctx.dispatchProgram("/wallet", "show", [keyName]) as { pubkey: string } | null;
	if (!info) throw new Error(`coin: wallet key "${keyName}" not found`);
	return info.pubkey;
}

/** Token id = sha256 of canonical(deploy op without id/signature), hex-truncated. */
function deriveTokenId(opNoSig: Omit<CoinDeployOp, "token_id" | "signature">): string {
	return hexEncode(sha256(canonicalSigningBytes(opNoSig as Record<string, unknown>))).slice(0, 32);
}

// ── Core operations ──────────────────────────────────────────────

interface DeployInput {
	name: string;
	symbol: string;
	supply: string;
	decimals?: number;
	mintRenounced?: boolean;
	keyName?: string;
}

async function doDeploy(ctx: ProgramContext, input: DeployInput): Promise<{ tokenId: string; ownerPubkey: string }> {
	requireAutobase();
	const keyName = input.keyName ?? "default";
	const owner = await walletPubkey(ctx, keyName);
	const opCore = {
		kind: "coin.deploy" as const,
		token_id: "", // placeholder — filled below
		name: input.name,
		symbol: input.symbol,
		decimals: input.decimals ?? 0,
		supply: input.supply,
		owner_pubkey: owner,
		mint_renounced: input.mintRenounced ?? false,
		created_at: Date.now(),
	};
	const { token_id: _, ...withoutId } = opCore;
	const tokenId = deriveTokenId(withoutId);
	const opNoSig: Omit<CoinDeployOp, "signature"> = { ...opCore, token_id: tokenId };
	const signature = await signOp(ctx, keyName, opNoSig);
	await appendOp({ ...opNoSig, signature });
	return { tokenId, ownerPubkey: owner };
}

async function doMint(ctx: ProgramContext, input: { tokenId: string; toPubkey: string; amount: string; keyName?: string }): Promise<void> {
	requireAutobase();
	const keyName = input.keyName ?? "default";
	const opNoSig: Omit<CoinMintOp, "signature"> = {
		kind: "coin.mint",
		token_id: input.tokenId,
		to_pubkey: input.toPubkey,
		amount: input.amount,
		created_at: Date.now(),
	};
	const signature = await signOp(ctx, keyName, opNoSig);
	await appendOp({ ...opNoSig, signature });
}

async function doTransfer(ctx: ProgramContext, input: { tokenId: string; toPubkey: string; amount: string; keyName?: string }): Promise<void> {
	requireAutobase();
	const keyName = input.keyName ?? "default";
	const from = await walletPubkey(ctx, keyName);
	const opNoSig: Omit<CoinTransferOp, "signature"> = {
		kind: "coin.transfer",
		token_id: input.tokenId,
		from_pubkey: from,
		to_pubkey: input.toPubkey,
		amount: input.amount,
		created_at: Date.now(),
	};
	const signature = await signOp(ctx, keyName, opNoSig);
	await appendOp({ ...opNoSig, signature });
}

async function doBurn(ctx: ProgramContext, input: { tokenId: string; amount: string; keyName?: string }): Promise<void> {
	requireAutobase();
	const keyName = input.keyName ?? "default";
	const from = await walletPubkey(ctx, keyName);
	const opNoSig: Omit<CoinBurnOp, "signature"> = {
		kind: "coin.burn",
		token_id: input.tokenId,
		from_pubkey: from,
		amount: input.amount,
		created_at: Date.now(),
	};
	const signature = await signOp(ctx, keyName, opNoSig);
	await appendOp({ ...opNoSig, signature });
}

async function doBalance(tokenId: string, pubkey: string): Promise<string> {
	requireAutobase();
	const v = await viewGet<string>(`balance/${tokenId}/${pubkey}`);
	return v ?? "0";
}

async function doHolders(tokenId: string): Promise<Array<{ pubkey: string; balance: string }>> {
	requireAutobase();
	const prefix = `balance/${tokenId}/`;
	const rows = await viewList<string>(prefix);
	const out: Array<{ pubkey: string; balance: string }> = [];
	for (const r of rows) {
		out.push({ pubkey: r.key.slice(prefix.length), balance: r.value });
	}
	out.sort((a, b) => (BigInt(b.balance) - BigInt(a.balance) > 0n ? 1 : -1));
	return out;
}

async function doInfo(tokenId: string): Promise<CoinDeployOp | null> {
	requireAutobase();
	return await viewGet<CoinDeployOp>(`token/${tokenId}`);
}

async function doListTokens(): Promise<CoinDeployOp[]> {
	requireAutobase();
	const rows = await viewList<CoinDeployOp>("token/");
	return rows.map((r) => r.value);
}

// ── CLI handler ──────────────────────────────────────────────────

function parseFlags(args: string[]): { positional: string[]; keyName: string; decimals: number; mintRenounced: boolean } {
	const positional: string[] = [];
	let keyName = "default";
	let decimals = 0;
	let mintRenounced = false;
	for (const a of args) {
		if (a.startsWith("--key=")) keyName = a.split("=")[1];
		else if (a.startsWith("--decimals=")) decimals = parseInt(a.split("=")[1], 10);
		else if (a === "--mint-renounced") mintRenounced = true;
		else positional.push(a);
	}
	return { positional, keyName, decimals, mintRenounced };
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	switch (cmd) {
		case "deploy": {
			const f = parseFlags(args);
			const [name, symbol, supply] = f.positional;
			if (!name || !symbol || !supply) { print(red("Usage: coin deploy <name> <symbol> <supply> [--decimals=N] [--mint-renounced] [--key=name]")); break; }
			try {
				const r = await doDeploy(ctx, { name, symbol, supply, decimals: f.decimals, mintRenounced: f.mintRenounced, keyName: f.keyName });
				print(green("Token deployed"));
				print(dim("  token_id: ") + r.tokenId);
				print(dim("  owner:    ") + r.ownerPubkey);
				print(dim("  supply:   ") + supply + " (" + name + ")");
			} catch (err: any) { print(red("  Error: ") + (err?.message ?? String(err))); }
			break;
		}

		case "transfer": {
			const f = parseFlags(args);
			const [tokenId, toPubkey, amount] = f.positional;
			if (!tokenId || !toPubkey || !amount) { print(red("Usage: coin transfer <token_id> <to_pubkey> <amount> [--key=name]")); break; }
			try {
				await doTransfer(ctx, { tokenId, toPubkey, amount, keyName: f.keyName });
				print(green("Transfer sent") + dim(` (${amount} → ${toPubkey.slice(0, 12)}…)`));
			} catch (err: any) { print(red("  Error: ") + (err?.message ?? String(err))); }
			break;
		}

		case "mint": {
			const f = parseFlags(args);
			const [tokenId, toPubkey, amount] = f.positional;
			if (!tokenId || !toPubkey || !amount) { print(red("Usage: coin mint <token_id> <to_pubkey> <amount> [--key=name]")); break; }
			try {
				await doMint(ctx, { tokenId, toPubkey, amount, keyName: f.keyName });
				print(green("Minted") + dim(` (${amount} → ${toPubkey.slice(0, 12)}…)`));
			} catch (err: any) { print(red("  Error: ") + (err?.message ?? String(err))); }
			break;
		}

		case "burn": {
			const f = parseFlags(args);
			const [tokenId, amount] = f.positional;
			if (!tokenId || !amount) { print(red("Usage: coin burn <token_id> <amount> [--key=name]")); break; }
			try {
				await doBurn(ctx, { tokenId, amount, keyName: f.keyName });
				print(green("Burned") + dim(` ${amount}`));
			} catch (err: any) { print(red("  Error: ") + (err?.message ?? String(err))); }
			break;
		}

		case "balance": {
			const [tokenId, pubkey] = args;
			if (!tokenId || !pubkey) { print(red("Usage: coin balance <token_id> <pubkey>")); break; }
			try {
				const bal = await doBalance(tokenId, pubkey);
				print(dim("  balance: ") + bold(bal));
			} catch (err: any) { print(red("  Error: ") + (err?.message ?? String(err))); }
			break;
		}

		case "holders": {
			const [tokenId] = args;
			if (!tokenId) { print(red("Usage: coin holders <token_id>")); break; }
			try {
				const rows = await doHolders(tokenId);
				if (rows.length === 0) { print(dim("  (no holders)")); break; }
				for (const r of rows) print(`  ${dim(r.pubkey.slice(0, 16) + "...")} ${bold(r.balance)}`);
			} catch (err: any) { print(red("  Error: ") + (err?.message ?? String(err))); }
			break;
		}

		case "info": {
			const [tokenId] = args;
			if (!tokenId) { print(red("Usage: coin info <token_id>")); break; }
			try {
				const t = await doInfo(tokenId);
				if (!t) { print(red("Token not found")); break; }
				print(bold(`  ${t.name}`) + dim(` (${t.symbol})`));
				print(dim("  token_id:       ") + t.token_id);
				print(dim("  owner:          ") + t.owner_pubkey);
				print(dim("  supply:         ") + t.supply);
				print(dim("  decimals:       ") + String(t.decimals));
				print(dim("  mint_renounced: ") + (t.mint_renounced ? yellow("yes") : "no"));
			} catch (err: any) { print(red("  Error: ") + (err?.message ?? String(err))); }
			break;
		}

		case "list": {
			try {
				const tokens = await doListTokens();
				if (tokens.length === 0) { print(dim("  No tokens deployed yet on this network.")); break; }
				for (const t of tokens) {
					print(`  ${bold(t.symbol.padEnd(6))} ${dim(t.token_id.slice(0, 12))} supply=${t.supply} owner=${t.owner_pubkey.slice(0, 12)}…`);
				}
			} catch (err: any) { print(red("  Error: ") + (err?.message ?? String(err))); }
			break;
		}

		default: {
			print([
				bold("  Coin") + dim(" — fungible tokens on the auction-house autobase"),
				`    ${cyan("coin deploy")} ${dim("<name> <symbol> <supply> [--decimals=N] [--mint-renounced] [--key=name]")}`,
				`    ${cyan("coin transfer")} ${dim("<token_id> <to_pubkey> <amount> [--key=name]")}`,
				`    ${cyan("coin mint")} ${dim("<token_id> <to_pubkey> <amount> [--key=name]")}`,
				`    ${cyan("coin burn")} ${dim("<token_id> <amount> [--key=name]")}`,
				`    ${cyan("coin balance")} ${dim("<token_id> <pubkey>")}`,
				`    ${cyan("coin holders")} ${dim("<token_id>")}`,
				`    ${cyan("coin info")} ${dim("<token_id>")}`,
				`    ${cyan("coin list")}                          all tokens deployed on the network`,
				dim(`  Balances live in the hyperbee view as balance/<token_id>/<pubkey>.`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ──────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		deploy:   async (ctx: ProgramContext, input: DeployInput) => doDeploy(ctx, input),
		mint:     async (ctx: ProgramContext, input: { tokenId: string; toPubkey: string; amount: string; keyName?: string }) => doMint(ctx, input),
		transfer: async (ctx: ProgramContext, input: { tokenId: string; toPubkey: string; amount: string; keyName?: string }) => doTransfer(ctx, input),
		burn:     async (ctx: ProgramContext, input: { tokenId: string; amount: string; keyName?: string }) => doBurn(ctx, input),
		balance:  async (_ctx: ProgramContext, input: { tokenId: string; pubkey: string }) => doBalance(input.tokenId, input.pubkey),
		holders:  async (_ctx: ProgramContext, input: { tokenId: string }) => doHolders(input.tokenId),
		info:     async (_ctx: ProgramContext, input: { tokenId: string }) => doInfo(input.tokenId),
		list:     async (_ctx: ProgramContext) => doListTokens(),
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
