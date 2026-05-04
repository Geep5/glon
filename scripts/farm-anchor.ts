#!/usr/bin/env tsx
/**
 * Farm Anchor — automated PoST anchor creation script.
 *
 * One-shot or loop mode:
 *   npx tsx scripts/farm-anchor.ts          # create one anchor
 *   npx tsx scripts/farm-anchor.ts --loop   # keep farming anchors
 *
 * Prerequisites:
 *   - glon daemon running (port 6430)
 *   - glon actor host running (port 6420)
 *   - chiapos binary at ~/.glon/bin/chiapos
 *   - chiavdf-compute binary at ~/.glon/bin/chiavdf-compute
 *   - wallet with pubkey for rewards
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { hexEncode } from "../src/crypto.js";

const ENDPOINT = "http://localhost:6420";
const DAEMON_DISPATCH = "http://localhost:6430";
const WALLET_PATH = process.env.GLON_DATA
	? join(process.env.GLON_DATA, "wallet.json")
	: join(homedir(), ".glon-data", "wallet.json");

// ── Utilities ────────────────────────────────────────────────────

function readWalletPubkey(): string {
	const wallet = JSON.parse(readFileSync(WALLET_PATH, "utf-8"));
	const keys = Object.values(wallet.keys) as Array<{ pubkey: string }>;
	if (keys.length === 0) throw new Error("No keys in wallet");
	return keys[0].pubkey;
}

function bin(name: string): string {
	const dir = process.env.GLON_BIN_DIR ?? join(homedir(), ".glon", "bin");
	return join(dir, name);
}

function dispatch(prefix: string, action: string, args: unknown[]): any {
	const res = spawnSync("curl", [
		"-s", "-X", "POST", DAEMON_DISPATCH,
		"-H", "Content-Type: application/json",
		"-d", JSON.stringify({ prefix, action, args }),
	], { encoding: "utf-8", timeout: 120_000 });
	if (res.status !== 0) throw new Error(`dispatch failed: ${res.stderr}`);
	const body = JSON.parse(res.stdout);
	if (!body.ok) throw new Error(`dispatch error: ${body.error}`);
	return body.result;
}

function run(cmd: string, args: string[], timeoutMs = 300_000): string {
	const res = spawnSync(cmd, args, { encoding: "utf-8", timeout: timeoutMs });
	if (res.status !== 0) throw new Error(`${cmd} failed: ${res.stderr || res.stdout}`);
	return res.stdout;
}

function log(...args: any[]) {
	console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

// ── Plot management ──────────────────────────────────────────────

function listPlots(): Array<{ name: string; k: number; id: string }> {
	try {
		const registry = JSON.parse(readFileSync(join(homedir(), ".glon", "plots", ".registry.json"), "utf-8"));
		return registry;
	} catch {
		return [];
	}
}

function ensurePlot(k = 25): { name: string; path: string; k: number } {
	const plots = listPlots();
	const existing = plots.find((p) => p.k === k);
	if (existing) {
		log("Using existing plot:", existing.name, `(k=${existing.k})`);
		return { name: existing.name, path: join(homedir(), ".glon", "plots", `${existing.name}.plot`), k: existing.k };
	}

	const name = `farm-k${k}-${Date.now()}`;
	log("Creating plot:", name, `(k=${k}, ~${(Math.pow(2, k) * 0.00078 / 1024).toFixed(1)}GB)...`);
	const start = Date.now();
	const wallet = JSON.parse(readFileSync(WALLET_PATH, "utf-8"));
	const pubkey = Object.values(wallet.keys)[0] as { pubkey: string };

	const plotDir = join(homedir(), ".glon", "plots");
	const path = join(plotDir, `${name}.plot`);
	mkdirSync(plotDir, { recursive: true });

	const idInput = new TextEncoder().encode(`glon-plot-id:${pubkey.pubkey}:${name}`);
	const idHex = hexEncode(createHash("sha256").update(idInput).digest());

	log("  running chiapos create... (this takes ~90s for k=25)");
	const out = run(bin("chiapos"), [
		"create", "-k", String(k), "-f", path,
		"-i", idHex, "-m", "0x00",
	]);
	log("  chiapos output:", out.split("\n").filter((l) => l.includes("Total time") || l.includes("Final File")).join(" "));

	const registryPath = join(plotDir, ".registry.json");
	let registry: any[] = [];
	try { registry = JSON.parse(readFileSync(registryPath, "utf-8")); } catch { /* empty */ }
	registry.push({ name, path, k, id: idHex, pubkeyHex: pubkey.pubkey, memo: "0x00", createdAt: Date.now() });
	writeFileSync(registryPath, JSON.stringify(registry, null, 2));

	log("Plot created in", ((Date.now() - start) / 1000).toFixed(1) + "s");
	return { name, path, k };
}

// ── Main flow ────────────────────────────────────────────────────

async function farmOne() {
	const pubkey = readWalletPubkey();
	log("Wallet pubkey:", pubkey.slice(0, 16) + "…");

	// 1. Ensure we have a plot
	const plot = ensurePlot(25);

	// 2. Get latest anchor
	log("Fetching latest anchor…");
	const latest = dispatch("/anchor", "getLatest", []);
	if (!latest) {
		log("No anchors yet. Creating genesis anchor without VDF.");
		const result = dispatch("/anchor", "createAnchor", [{ creator: "farm-script", rewardPubkey: pubkey }]);
		log("Genesis anchor created:", result.id, "height=", result.height, "reward=", (result.reward / 1_000_000).toFixed(6), "FIG");
		return result;
	}
	log("Latest anchor:", latest.id.slice(0, 12) + "…", "height=", latest.height, "root=", latest.root.slice(0, 16) + "…");

	// 3. Derive challenge from merkle root
	log("Deriving challenge from merkle root…");
	const challengeHex: string = dispatch("/timelord", "deriveChallenge", [latest.root]);
	log("Challenge:", challengeHex.slice(0, 16) + "…");

	// 4. Compute VDF
	const iterations = 100_000; // fast for testing; use 5_000_000 for production
	log(`Computing VDF (${iterations.toLocaleString()} iterations)…`);
	const vdfStart = Date.now();
	const vdfJson = run(bin("chiavdf-compute"), [challengeHex, String(iterations), "1024"]);
	const vdf = JSON.parse(vdfJson);
	log("VDF done in", (Date.now() - vdfStart) + "ms", "y=", vdf.y.slice(0, 16) + "…");

	log("Finding plot proof…");
	const proveOut = run(bin("chiapos"), ["prove", challengeHex, "-f", plot.path]);
	const proofs: string[] = [];
	for (const line of proveOut.split("\n")) {
		const m = line.match(/Proof:\s*(0x[0-9a-fA-F]+)/);
		if (m) proofs.push(m[1]);
	}
	log("Plot proofs found:", proofs.length);

	// 6. Create anchor with VDF proof
	log("Creating anchor…");
	const vdfProof = {
		discriminant: vdf.discriminant,
		x: vdf.x,
		y: vdf.y,
		proof: vdf.proof,
		iterations: vdf.iterations,
		discriminantSizeBits: vdf.discriminant_size_bits,
	};
	const result = dispatch("/anchor", "createAnchor", [{
		vdfProof,
		plotProof: proofs[0] ?? undefined,
		plotQuality: proofs.length > 0 ? Math.min(255, proofs[0].length / 2) : 0,
		creator: "farm-script",
		rewardPubkey: pubkey,
	}]);
	log("Anchor created:", result.id, "height=", result.height, "reward=", (result.reward / 1_000_000).toFixed(6), "FIG");
	return result;
}

// ── Entrypoint ───────────────────────────────────────────────────

async function main() {
	const loop = process.argv.includes("--loop");
	const delay = Number(process.env.FARM_DELAY_MS ?? "60_000");

	log("=== Farm Anchor ===");
	log("Daemon:", DAEMON_DISPATCH);
	log("Actor host:", ENDPOINT);
	log("Plot bin:", bin("chiapos"));
	log("VDF bin:", bin("chiavdf-compute"));

	do {
		try {
			await farmOne();
		} catch (err: any) {
			log("ERROR:", err?.message ?? String(err));
		}
		if (loop) {
			log(`Waiting ${delay}ms before next anchor…`);
			await new Promise((r) => setTimeout(r, delay));
		}
	} while (loop);
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
