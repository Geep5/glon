// hyperliquid — generic Hyperliquid perpetuals DEX backend.
//
// One program per data source. Actions take {coin} (or no coin for
// account-level reads); asset agents bind the coin via `bound_args`
// in their tool spec.
//
// Auth model is split:
//   - Public reads (allMids, l2Book, clearinghouseState, meta) work
//     unauthenticated via POST to /info.
//   - Trading (place/cancel/modify orders, update leverage) needs
//     EIP-712 typed-data signing with HYPERLIQUID_SECRET_KEY. NOT
//     YET WIRED — would pull a non-trivial crypto dep (viem or a
//     hand-rolled secp256k1 + keccak). The signature shape is:
//
//       POST /exchange
//       body: { action, nonce, signature, vaultAddress? }
//       where signature = ecsign(typedDataHash(action, nonce), key)
//
//     Adding this is the next iteration once we pick an approach.
//
//   HYPERLIQUID_WALLET should be the lowercase hex address (with or
//   without 0x prefix) that the secret key controls — used as the
//   default `user` for clearinghouseState reads.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, red, green } from "../shared.js";

const HL_API = "https://api.hyperliquid.xyz";

async function postInfo(body: Record<string, unknown>) {
	const res = await fetch(`${HL_API}/info`, {
		method:  "POST",
		headers: { "Content-Type": "application/json", "Accept": "application/json" },
		body:    JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`hyperliquid: ${res.status} ${await res.text()}`);
	return await res.json();
}

function normaliseWallet(raw: string | undefined): string {
	const v = (raw ?? "").trim().toLowerCase();
	if (!v) return "";
	return v.startsWith("0x") ? v : `0x${v}`;
}

// ── Actions ────────────────────────────────────────────────────

interface PriceInput { coin: string }
async function getPrice(_ctx: ProgramContext, input: PriceInput) {
	if (!input?.coin) throw new Error("hyperliquid getPrice: {coin} required (e.g. 'BTC')");
	const coin = input.coin.toUpperCase();
	// allMids returns { "BTC": "62300.5", "ETH": "2421.1", ... }
	const mids = await postInfo({ type: "allMids" }) as Record<string, string>;
	const mid  = mids[coin];
	if (!mid) {
		return {
			coin,
			error: "coin not in allMids",
			hint: "Use action `meta` to list all tradeable coins.",
			available_count: Object.keys(mids).length,
		};
	}
	return { coin, mid_price: Number(mid), source: "hyperliquid:allMids" };
}

interface OrderbookInput { coin: string; depth?: number }
async function getOrderbook(_ctx: ProgramContext, input: OrderbookInput) {
	if (!input?.coin) throw new Error("hyperliquid getOrderbook: {coin} required");
	const coin  = input.coin.toUpperCase();
	const depth = input.depth ?? 5;
	const book  = await postInfo({ type: "l2Book", coin }) as { coin: string; levels: Array<Array<{ px: string; sz: string; n: number }>> };
	const [bids = [], asks = []] = book.levels ?? [];
	return {
		coin,
		bids: bids.slice(0, depth).map((b) => ({ price: Number(b.px), size: Number(b.sz), orders: b.n })),
		asks: asks.slice(0, depth).map((a) => ({ price: Number(a.px), size: Number(a.sz), orders: a.n })),
	};
}

interface AccountInput { wallet?: string }
async function getAccount(_ctx: ProgramContext, input: AccountInput = {}) {
	const wallet = normaliseWallet(input.wallet ?? process.env.HYPERLIQUID_WALLET);
	if (!wallet) throw new Error("hyperliquid getAccount: pass {wallet} or set HYPERLIQUID_WALLET in env");
	return await postInfo({ type: "clearinghouseState", user: wallet });
}

async function getMeta(_ctx: ProgramContext, _input: unknown = {}) {
	// Returns the universe of tradeable perps + their szDecimals.
	return await postInfo({ type: "meta" });
}

// ── CLI handler ────────────────────────────────────────────────

const handler = async (cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		const hasKey    = !!process.env.HYPERLIQUID_SECRET_KEY;
		const hasWallet = !!process.env.HYPERLIQUID_WALLET;
		print(bold("  hyperliquid"));
		print(dim(`    secret key (for trading, not yet wired): ${hasKey    ? green("present") : red("missing")}`));
		print(dim(`    wallet (for account reads):              ${hasWallet ? green("present") : red("missing")}`));
		return;
	}
	print([
		bold("  hyperliquid") + dim(" — Hyperliquid perp DEX backend (public reads only)"),
		`    ${cyan("/hyperliquid status")}   show credential availability`,
		dim("    Actions: getPrice, getOrderbook, getAccount, getMeta"),
		dim("    Trading endpoints (placeOrder etc) intentionally deferred —"),
		dim("    needs EIP-712 typed-data signing with HYPERLIQUID_SECRET_KEY."),
	].join("\n"));
};

// ── Actor ──────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		getPrice:     async (ctx, input) => getPrice(ctx, input as PriceInput),
		getOrderbook: async (ctx, input) => getOrderbook(ctx, input as OrderbookInput),
		getAccount:   async (ctx, input) => getAccount(ctx, input as AccountInput),
		getMeta:      async (ctx, input) => getMeta(ctx, input),
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
