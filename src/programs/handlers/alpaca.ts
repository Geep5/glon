// alpaca — generic Alpaca Markets backend.
//
// One program per data source. Actions are SYMBOL-AGNOSTIC: each takes
// {symbol} (or no symbol for account-level reads). Agent tools bind
// the symbol via `bound_args` so a "BTC agent" calls
//   /alpaca getPrice {}
// with bound_args { symbol: "BTC/USD" } pre-set in its tool spec —
// the LLM never has to remember the symbol.
//
// Adding a new tradeable asset = spawn an agent + register the same
// tools with different bound_args. Adding a new EXCHANGE = new program
// alongside this one (e.g. /coinbase, /kraken). Asset complexity scales
// across agents; exchange complexity scales across programs.
//
// Auth: ALPACA_API_KEY + ALPACA_SECRET_KEY in env (loaded by env.ts
// from ~/.glon/secrets.env or project-local .env).
//
// Endpoints:
//   data.alpaca.markets/v1beta3/crypto/us/...   crypto market data (free)
//   paper-api.alpaca.markets/v2/...             paper trading
//   api.alpaca.markets/v2/...                   live trading — INTENTIONALLY
//                                               not wired; paper-only by default

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, red, green } from "../shared.js";

const ALPACA_DATA_BASE  = "https://data.alpaca.markets/v1beta3/crypto/us";
const ALPACA_PAPER_BASE = "https://paper-api.alpaca.markets/v2";

function headers(): Record<string, string> {
	const key    = process.env.ALPACA_API_KEY;
	const secret = process.env.ALPACA_SECRET_KEY;
	if (!key || !secret) {
		throw new Error("alpaca: ALPACA_API_KEY and ALPACA_SECRET_KEY must be in env (see ~/.glon/secrets.env)");
	}
	return {
		"APCA-API-KEY-ID":     key,
		"APCA-API-SECRET-KEY": secret,
		"Accept":              "application/json",
	};
}

// ── Actions ────────────────────────────────────────────────────

interface PriceInput { symbol: string }
async function getPrice(_ctx: ProgramContext, input: PriceInput) {
	if (!input?.symbol) throw new Error("alpaca getPrice: {symbol} required (e.g. 'BTC/USD')");
	const url = `${ALPACA_DATA_BASE}/latest/bars?symbols=${encodeURIComponent(input.symbol)}`;
	const res = await fetch(url, { headers: headers() });
	if (!res.ok) throw new Error(`alpaca getPrice: ${res.status} ${await res.text()}`);
	const json = await res.json() as { bars?: Record<string, { c: number; h: number; l: number; o: number; t: string; v: number }> };
	const bar = json.bars?.[input.symbol];
	if (!bar) return { symbol: input.symbol, error: "no bar in response", raw: json };
	return {
		symbol:    input.symbol,
		price_usd: bar.c,
		open:      bar.o,
		high:      bar.h,
		low:       bar.l,
		volume:    bar.v,
		bar_time:  bar.t,
	};
}

interface BarsInput { symbol: string; timeframe?: string; limit?: number }
async function getBars(_ctx: ProgramContext, input: BarsInput) {
	if (!input?.symbol) throw new Error("alpaca getBars: {symbol} required");
	const tf = input.timeframe ?? "1Min";
	const limit = input.limit ?? 100;
	const url = `${ALPACA_DATA_BASE}/bars?symbols=${encodeURIComponent(input.symbol)}&timeframe=${encodeURIComponent(tf)}&limit=${limit}`;
	const res = await fetch(url, { headers: headers() });
	if (!res.ok) throw new Error(`alpaca getBars: ${res.status} ${await res.text()}`);
	return await res.json();
}

async function getAccount(_ctx: ProgramContext, _input: unknown = {}) {
	const res = await fetch(`${ALPACA_PAPER_BASE}/account`, { headers: headers() });
	if (!res.ok) throw new Error(`alpaca getAccount: ${res.status} ${await res.text()}`);
	return await res.json();
}

async function getPositions(_ctx: ProgramContext, _input: unknown = {}) {
	const res = await fetch(`${ALPACA_PAPER_BASE}/positions`, { headers: headers() });
	if (!res.ok) throw new Error(`alpaca getPositions: ${res.status} ${await res.text()}`);
	return await res.json();
}

interface OrderInput {
	symbol: string;
	side: "buy" | "sell";
	qty: number;
	type?: "market" | "limit";
	limit_price?: number;
	time_in_force?: "gtc" | "ioc" | "day";
}
async function placeOrder(_ctx: ProgramContext, input: OrderInput) {
	if (!input?.symbol || !input.side || !input.qty) {
		throw new Error("alpaca placeOrder: requires {symbol, side, qty}");
	}
	const body: Record<string, unknown> = {
		symbol:        input.symbol,
		qty:           String(input.qty),
		side:          input.side,
		type:          input.type ?? "market",
		time_in_force: input.time_in_force ?? "gtc",
	};
	if (input.limit_price) body.limit_price = String(input.limit_price);
	const res = await fetch(`${ALPACA_PAPER_BASE}/orders`, {
		method:  "POST",
		headers: { ...headers(), "Content-Type": "application/json" },
		body:    JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`alpaca placeOrder: ${res.status} ${await res.text()}`);
	return await res.json();
}

// ── CLI handler ────────────────────────────────────────────────

const handler = async (cmd: string, _args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		const have = !!(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
		print(bold("  alpaca"));
		print(dim(`    creds: ${have ? green("present") : red("MISSING — set ALPACA_API_KEY / ALPACA_SECRET_KEY")}`));
		return;
	}
	print([
		bold("  alpaca") + dim(" — Alpaca crypto market data + paper trading backend"),
		`    ${cyan("/alpaca status")}    show credential availability`,
		dim("    Actions: getPrice, getBars, getAccount, getPositions, placeOrder"),
		dim("    Asset agents bind symbol via bound_args in their tool spec."),
	].join("\n"));
};

// ── Actor ──────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		getPrice:     async (ctx, input) => getPrice(ctx, input as PriceInput),
		getBars:      async (ctx, input) => getBars(ctx, input as BarsInput),
		getAccount:   async (ctx, input) => getAccount(ctx, input),
		getPositions: async (ctx, input) => getPositions(ctx, input),
		placeOrder:   async (ctx, input) => placeOrder(ctx, input as OrderInput),
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
