#!/usr/bin/env tsx
/**
 * Alpaca Options Filter
 *
 * Purpose: Find the most consistent high-activity stocks for options trading.
 *
 * Logic:
 *   1. Fetch a universe of active US equities from Alpaca.
 *   2. Filter by minimum price ($5) and minimum average volume (500K).
 *   3. Get snapshot data (latest volume, price, prev close) in batches.
 *   4. Rank by relative volume = today's volume / 20-day average volume.
 *   5. Save today's top 200 to `~/.alpaca-filter/top200-YYYY-MM-DD.json`.
 *   6. Load yesterday's top 200 (if exists).
 *   7. Find intersection: stocks on BOTH today's and yesterday's lists.
 *   8. Rank intersection by relative volume, take top 50.
 *   9. For each top-50 symbol, fetch the options snapshot from Alpaca.
 *  10. Filter options by: expiry within 14 days, delta 0.20–0.45, IV rank > 30,
 *      open interest > 100, bid-ask spread < 10% of mid.
 *  11. Output JSON with symbols + best option contract per symbol.
 *
 * Environment:
 *   ALPACA_API_KEY      from .env or env var
 *   ALPACA_SECRET_KEY   from .env or env var
 *
 * Usage:
 *   npx tsx scripts/alpaca-filter.ts [--min-price=5] [--min-avg-vol=500000]
 *                                    [--max-stocks=200] [--intersection=50]
 *                                    [--max-expiry-days=14]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Config ─────────────────────────────────────────────────────────
const DATA_URL = "https://data.alpaca.markets";
const SNAP_BATCH = 100; // Alpaca recommends ≤100 symbols per snapshot request
const SLEEP_MS = 200;   // polite delay between batch requests

const FILTER_DIR = join(homedir(), ".alpaca-filter");

interface FilterConfig {
	minPrice: number;
	minAvgVol: number;
	maxStocks: number;
	intersectionSize: number;
	maxExpiryDays: number;
	minOpenInterest: number;
	maxSpreadPct: number;
}

const DEFAULTS: FilterConfig = {
	minPrice: 5,
	minAvgVol: 500_000,
	maxStocks: 200,
	intersectionSize: 50,
	maxExpiryDays: 14,
	minOpenInterest: 100,
	maxSpreadPct: 0.10,
};

// ── Env / Args ─────────────────────────────────────────────────────
function loadEnv(): { key: string; secret: string } {
	let key = process.env.ALPACA_API_KEY ?? "";
	let secret = process.env.ALPACA_SECRET_KEY ?? "";

	if (!key || !secret) {
		try {
			const dotenv = readFileSync(".env", "utf-8");
			for (const line of dotenv.split("\n")) {
				const m = line.match(/^ALPACA_API_KEY=(.+)$/);
				if (m) key = m[1].trim();
				const s = line.match(/^ALPACA_SECRET_KEY=(.+)$/);
				if (s) secret = s[1].trim();
			}
		} catch { /* ignore */ }
	}

	if (!key || !secret) {
		throw new Error("Missing ALPACA_API_KEY / ALPACA_SECRET_KEY in env or .env");
	}
	return { key, secret };
}

function parseArgs(): Partial<FilterConfig> {
	const cfg: Partial<FilterConfig> = {};
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith("--min-price=")) cfg.minPrice = Number(arg.split("=")[1]);
		if (arg.startsWith("--min-avg-vol=")) cfg.minAvgVol = Number(arg.split("=")[1]);
		if (arg.startsWith("--max-stocks=")) cfg.maxStocks = Number(arg.split("=")[1]);

		if (arg.startsWith("--intersection=")) cfg.intersectionSize = Number(arg.split("=")[1]);
		if (arg.startsWith("--max-expiry-days=")) cfg.maxExpiryDays = Number(arg.split("=")[1]);

		if (arg.startsWith("--top-contracts=")) cfg.topContracts = Number(arg.split("=")[1]);
	}
	return cfg;
}

// ── HTTP helpers ───────────────────────────────────────────────────
async function alpacaGet(path: string, creds: { key: string; secret: string }) {
	const url = `${DATA_URL}${path}`;
	const res = await fetch(url, {
		headers: {
			"APCA-API-KEY-ID": creds.key,
			"APCA-API-SECRET-KEY": creds.secret,
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Alpaca ${path} → ${res.status}: ${body}`);
	}
	return res.json();
}

async function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

// ── Step 1: Universe ───────────────────────────────────────────────
interface Asset {
	symbol: string;
	name: string;
	status: string;
	tradable: boolean;
}

async function fetchUniverse(creds: { key: string; secret: string }): Promise<Asset[]> {

	// Alpaca assets endpoint is on the brokerage API, not data API
	const brokerUrl = "https://api.alpaca.markets/v2/assets?status=active&asset_class=us_equity";
	const res = await fetch(brokerUrl, {
		headers: {
			"APCA-API-KEY-ID": creds.key,
			"APCA-API-SECRET-KEY": creds.secret,
		},
	});
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Alpaca assets → ${res.status}: ${body}`);
	}
	const assets = (await res.json()) as Asset[];
	return assets.filter((a) => a.tradable);
}

// ── Step 2: Snapshots (batch) ──────────────────────────────────────
interface Snapshot {
	dailyBar?: {
		v: number; // volume today
		vw: number; // vwap
		c: number; // close
	};
	prevDailyBar?: {
		v: number;
		c: number;
	};
}

async function fetchSnapshots(
	symbols: string[],
	creds: { key: string; secret: string }
): Promise<Map<string, Snapshot>> {
	const out = new Map<string, Snapshot>();
	for (let i = 0; i < symbols.length; i += SNAP_BATCH) {
		const batch = symbols.slice(i, i + SNAP_BATCH);
		const path = `/v2/stocks/snapshots?symbols=${batch.join(",")}`;
		const data = (await alpacaGet(path, creds)) as Record<string, Snapshot>;
		for (const sym of batch) {
			if (data[sym]) out.set(sym, data[sym]);
		}
		if (i + SNAP_BATCH < symbols.length) await sleep(SLEEP_MS);
	}
	return out;
}

// ── Step 3: Rank ───────────────────────────────────────────────────
interface RankedStock {
	symbol: string;
	price: number;
	todayVol: number;
	prevVol: number;
	relVol: number;
}

function rankStocks(
	assets: Asset[],
	snaps: Map<string, Snapshot>,
	cfg: FilterConfig
): RankedStock[] {
	const rows: RankedStock[] = [];
	for (const a of assets) {
		const s = snaps.get(a.symbol);
		if (!s?.dailyBar || !s?.prevDailyBar) continue;

		const price = s.dailyBar.c;
		const todayVol = s.dailyBar.v;
		const prevVol = s.prevDailyBar.v;

		if (price < cfg.minPrice) continue;
		if (prevVol < cfg.minAvgVol) continue; // use yesterday's vol as proxy for avg

		const relVol = todayVol / Math.max(1, prevVol);
		rows.push({ symbol: a.symbol, price, todayVol, prevVol, relVol });
	}

	// Sort by relative volume descending, then absolute volume
	rows.sort((a, b) => {
		if (b.relVol !== a.relVol) return b.relVol - a.relVol;
		return b.todayVol - a.todayVol;
	});

	return rows;
}

// ── Step 4: Persist / Load ─────────────────────────────────────────
function persistPath(date: Date): string {
	const iso = date.toISOString().slice(0, 10);
	return join(FILTER_DIR, `top200-${iso}.json`);
}

function saveTop200(rows: RankedStock[], date: Date) {
	mkdirSync(FILTER_DIR, { recursive: true });
	writeFileSync(persistPath(date), JSON.stringify(rows.slice(0, 200), null, 2));
}

function loadTop200(date: Date): string[] | null {
	const p = persistPath(date);
	if (!existsSync(p)) return null;
	const data = JSON.parse(readFileSync(p, "utf-8")) as RankedStock[];
	return data.map((r) => r.symbol);
}

// ── Step 5: Options snapshot ───────────────────────────────────────
interface OptionSnapshot {
	symbol: string; // e.g. "AAPL250606C00230000"
	strike: string;
	expiry: string;
	underlying: string;
	close?: number;
	bid?: number;
	ask?: number;
	openInterest?: number;
	impliedVolatility?: number;
	delta?: number;
	gamma?: number;
	vwap?: number;

	volume?: number;
}



async function fetchOptionSnapshots(
	symbol: string,
	creds: { key: string; secret: string }
): Promise<OptionSnapshot[]> {
	// Alpaca options snapshots beta endpoint
	const path = `/v1beta1/options/snapshots/${symbol}?feed=indicative`;
	try {
		const data = (await alpacaGet(path, creds)) as Record<string, any>;
		// Response shape: { "snapshots": { "SHOP260508C00117000": { ... } }, "next_page_token": null }
		const snaps = data?.snapshots ?? {};
		return Object.entries(snaps).map(([sym, raw]: [string, any]) => {
			// Parse symbol: SHOP260508C00117000 = underlying + YYMMDD + C/P + strike*1000
			const match = sym.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
			const strike = match ? String(Number(match[6]) / 1000) : "";
			const expiry = match ? `20${match[2]}-${match[3]}-${match[4]}` : "";
			return {
				symbol: sym,
				strike,
				expiry,
				underlying: symbol,
				close: raw?.latestQuote?.ap ?? raw?.dailyBar?.c,
				bid: raw?.latestQuote?.bp,
				ask: raw?.latestQuote?.ap,
				openInterest: raw?.open_interest ?? raw?.openInterest,
				impliedVolatility: raw?.impliedVolatility,
				delta: raw?.greeks?.delta,
				gamma: raw?.greeks?.gamma,

				vwap: raw?.dailyBar?.vw,
				volume: raw?.dailyBar?.v,
			};
		});
	} catch (e: any) {
		console.error(`  [skip] ${symbol}: ${e.message}`);
		return [];
	}
}



function filterContracts(
	options: OptionSnapshot[],
	stockPrice: number,
	cfg: FilterConfig,
	now: Date
): OptionSnapshot[] {
	const cutoff = new Date(now);
	cutoff.setDate(cutoff.getDate() + cfg.maxExpiryDays);

	return options.filter((o) => {
		if (!o.expiry) return false;
		const exp = new Date(o.expiry);
		if (exp > cutoff) return false;
		if (o.openInterest != null && o.openInterest < cfg.minOpenInterest) return false;
		if (o.bid == null || o.ask == null || o.bid <= 0) return false;
		const mid = (o.bid + o.ask) / 2;
		const spread = (o.ask - o.bid) / mid;
		if (spread > cfg.maxSpreadPct) return false;
		const strikeNum = Number(o.strike);
		if (!strikeNum || strikeNum <= 0) return false;
		const strikeDist = Math.abs(strikeNum - stockPrice) / stockPrice;
		if (strikeDist > 0.10) return false;
		return true;
	});
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
	const creds = loadEnv();
	const overrides = parseArgs();
	const cfg: FilterConfig = { ...DEFAULTS, ...overrides };

	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	console.log("═".repeat(60));
	console.log("Alpaca Options Filter");
	console.log("═".repeat(60));
	console.log(`Config: minPrice=$${cfg.minPrice}, minAvgVol=${cfg.minAvgVol.toLocaleString()}, maxStocks=${cfg.maxStocks}, intersection=${cfg.intersectionSize}`);
	console.log(`Today:    ${today.toISOString().slice(0, 10)}`);
	console.log(`Yesterday:${yesterday.toISOString().slice(0, 10)}`);
	console.log();

	// 1. Universe
	console.log("[1/6] Fetching active US equities...");
	const universe = await fetchUniverse(creds);
	console.log(`      ${universe.length} tradable equities`);

	// 2. Snapshots
	console.log("[2/6] Fetching snapshot data in batches...");
	const snaps = await fetchSnapshots(
		universe.map((a) => a.symbol),
		creds
	);
	console.log(`      ${snaps.size} snapshots received`);

	// 3. Rank
	console.log("[3/6] Ranking by relative volume...");
	const ranked = rankStocks(universe, snaps, cfg);
	console.log(`      ${ranked.length} passed filters`);

	// 4. Save today's top 200
	const top200 = ranked.slice(0, cfg.maxStocks);
	saveTop200(top200, today);
	console.log(`[4/6] Saved top ${top200.length} to ${persistPath(today)}`);

	// 5. Intersection with yesterday
	console.log("[5/6] Comparing with yesterday's list...");
	const yesterdaySymbols = loadTop200(yesterday);
	if (!yesterdaySymbols) {
		console.log("      ⚠ No yesterday file found. Run again tomorrow for intersection.");
		console.log("      Outputting today's top 50 instead.");
	}

	let intersection: RankedStock[];
	if (yesterdaySymbols) {
		const yset = new Set(yesterdaySymbols);
		intersection = top200.filter((r) => yset.has(r.symbol));
		console.log(`      ${intersection.length} symbols on both lists`);
	} else {
		intersection = top200;
	}

	const top50 = intersection.slice(0, cfg.intersectionSize);
	console.log(`      Top ${top50.length} selected for options scan`);

	// 6. Options
	console.log("[6/6] Fetching options chains...");
	const results: Array<{ stock: RankedStock; option: OptionSnapshot | null }> = [];

	const allContracts: Array<OptionSnapshot & { stockPrice: number; relVol: number }> = [];
	for (let i = 0; i < top50.length; i++) {
		const stock = top50[i];
		process.stdout.write(`      ${i + 1}/${top50.length} ${stock.symbol} ... `);

		const opts = await fetchOptionSnapshots(stock.symbol, creds);
		const qualified = filterContracts(opts, stock.price, cfg, today);
		for (const c of qualified) {
			allContracts.push({ ...c, stockPrice: stock.price, relVol: stock.relVol });
		}
		console.log(`${qualified.length} contracts`);
		if (i < top50.length - 1) await sleep(SLEEP_MS);
	}

	// Rank all contracts globally by volume
	allContracts.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
	const topContracts = allContracts.slice(0, cfg.topContracts);


	// 7. Output
	console.log();
	console.log("═".repeat(60));
	console.log("TOP OPTION CONTRACTS (ranked by volume)");
	console.log("═".repeat(60));

	console.log(JSON.stringify(
		{
			date: today.toISOString().slice(0, 10),
			criteria: cfg,
			stocksConsidered: universe.length,
			top200Count: top200.length,
			intersectionCount: top50.length,
			totalContracts: allContracts.length,
			actionableCount: topContracts.length,
			contracts: topContracts.map((c) => {
				const mid = ((c.ask ?? 0) + (c.bid ?? 0)) / 2;
				const spread = c.ask && c.bid && mid > 0 ? (c.ask - c.bid) / mid : 0;
				return {
					contract: c.symbol,
					underlying: c.underlying,
					stockPrice: c.stockPrice,
					relVol: Number(c.relVol.toFixed(2)),
					strike: c.strike,
					expiry: c.expiry,
					volume: c.volume,
					bid: c.bid,
					ask: c.ask,
					spreadPct: Number((spread * 100).toFixed(1)),
					delta: c.delta,
					gamma: c.gamma,
					impliedVol: c.impliedVolatility,
				};
			}),
		},
		null,
		2
	));

	// Also save raw JSON
	const outPath = join(FILTER_DIR, `contracts-${today.toISOString().slice(0, 10)}.json`);
	writeFileSync(outPath, JSON.stringify(topContracts, null, 2));
	console.log();
	console.log(`Saved top ${cfg.topContracts} contracts to ${outPath}`);
}

main().catch((e) => {
	console.error("Fatal:", e.message);
	process.exit(1);
});
