// Plot — real Proof of Space using chiapos.
//
// This program shells out to the chiapos binary installed at ~/.glon/bin/chiapos.
// The binary is built from Chia Network's chiapos (https://github.com/Chia-Network/chiapos).
//
// To install/rebuild:
//   cd /tmp && git clone https://github.com/Chia-Network/chiapos.git
//   cd chiapos && mkdir build && cd build && cmake .. && cmake --build . -- -j$(nproc)
//   cp build/ProofOfSpace ~/.glon/bin/chiapos
//
// Plot sizes (k parameter):
//   k=25 → ~600MB  (good for testing)
//   k=32 → ~101GB  (Chia mainnet minimum)

import type { ProgramDef, ProgramContext } from "../runtime.js";
import { sha256, hexEncode, hexDecode } from "../../crypto.js";
import { randomBytes } from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
	statSync,
	readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }

// ── Constants ────────────────────────────────────────────────────

/** Default plot k-size. k=25 = ~600MB, good for testing. */
export const DEFAULT_K = 25;

/** Minimum k-size (Chia minimum is ~k=18 for tiny test plots). */
export const MIN_K = 18;

/** Maximum k-size (Chia mainnet uses k=32). */
export const MAX_K = 36;

/** Default plot count. */
export const DEFAULT_PLOT_COUNT = 1;

// ── Paths ────────────────────────────────────────────────────────

function plotDir(): string {
	return process.env.GLON_PLOT_DIR ?? join(homedir(), ".glon", "plots");
}

function binDir(): string {
	return process.env.GLON_BIN_DIR ?? join(homedir(), ".glon", "bin");
}

function chiaposBin(): string {
	return join(binDir(), "chiapos");
}

function plotPath(name: string): string {
	return join(plotDir(), `${name}.plot`);
}

function registryPath(): string {
	return join(plotDir(), ".registry.json");
}

// ── Registry ─────────────────────────────────────────────────────

interface PlotEntry {
	name: string;
	path: string;
	k: number;
	id: string; // 32-byte hex seed used during creation
	pubkeyHex: string;
	memo: string;
	createdAt: number;
}

function readRegistry(): PlotEntry[] {
	try {
		const data = readFileSync(registryPath(), "utf-8");
		return JSON.parse(data) as PlotEntry[];
	} catch {
		return [];
	}
}

function writeRegistry(entries: PlotEntry[]) {
	mkdirSync(plotDir(), { recursive: true });
	writeFileSync(registryPath(), JSON.stringify(entries, null, 2));
}

function findPlot(name: string): PlotEntry | undefined {
	return readRegistry().find((p) => p.name === name);
}

// ── Plot creation ────────────────────────────────────────────────

async function createPlot(
	name: string,
	k: number,
	pubkeyHex: string,
	memo?: string,
	onProgress?: (line: string) => void,
): Promise<PlotEntry> {
	const dir = plotDir();
	mkdirSync(dir, { recursive: true });
	const path = plotPath(name);

	// Derive deterministic 32-byte plot ID from pubkey + name
	const idInput = new TextEncoder().encode(`glon-plot-id:${pubkeyHex}:${name}`);
	const idBytes = sha256(idInput);
	const idHex = hexEncode(idBytes);

	const memoHex = memo ? hexEncode(new TextEncoder().encode(memo)) : "0x00";

	return new Promise((resolve, reject) => {
		const { spawn } = require("node:child_process");
		const proc = spawn(chiaposBin(), [
			"create",
			"-k", String(k),
			"-f", path,
			"-i", idHex,
			"-m", memoHex,
		]);

		let stderr = "";
		proc.stdout.on("data", (data: Buffer) => {
			const lines = data.toString("utf-8").split("\n");
			for (const line of lines) {
				if (onProgress && line.trim()) onProgress(line.trim());
			}
		});
		proc.stderr.on("data", (data: Buffer) => {
			stderr += data.toString("utf-8");
		});
		proc.on("close", (code: number) => {
			if (code !== 0) {
				reject(new Error(`chiapos create failed (exit ${code}): ${stderr}`));
				return;
			}
			const entry: PlotEntry = {
				name,
				path,
				k,
				id: idHex,
				pubkeyHex,
				memo: memoHex,
				createdAt: Date.now(),
			};
			const registry = readRegistry();
			registry.push(entry);
			writeRegistry(registry);
			resolve(entry);
		});
	});
}

// ── Proof generation ─────────────────────────────────────────────

export interface PlotProof {
	plotName: string;
	challengeHex: string;
	proofs: string[]; // multiple proofs from chiapos
	quality: number; // best quality among proofs (0..255, higher = better)
	k: number;
	plotId: string;
}

/** Find proofs in a plot for a given challenge. */
function findProofs(plot: PlotEntry, challenge: Uint8Array): PlotProof | null {
	const challengeHex = hexEncode(challenge);
	const result = spawnSync(chiaposBin(), [
		"prove",
		"-f", plot.path,
		challengeHex,
	], { encoding: "utf-8", timeout: 30000 });

	if (result.status !== 0) {
		return null;
	}

	// Parse output: each line is "Proof: 0x<hex>"
	const proofs: string[] = [];
	for (const line of result.stdout.split("\n")) {
		const match = line.match(/Proof:\s*(0x[0-9a-fA-F]+)/);
		if (match) proofs.push(match[1]);
	}

	if (proofs.length === 0) return null;

	// Quality: use proof length as proxy (longer = higher quality in Chia's scheme)
	// For a more accurate quality, we'd need to parse the proof bits
	const quality = Math.min(255, proofs[0].length / 2);

	return {
		plotName: plot.name,
		challengeHex,
		proofs,
		quality,
		k: plot.k,
		plotId: plot.id,
	};
}

// ── Proof verification ───────────────────────────────────────────

/** Verify a proof using chiapos. */
export function verifyProof(
	proof: PlotProof,
	challenge: Uint8Array,
	plot: PlotEntry,
): boolean {
	const challengeHex = hexEncode(challenge);
	// chiapos verify syntax: verify <proof_hex> <challenge_hex>
	// It derives k from proof length
	const result = spawnSync(chiaposBin(), [
		"verify",
		proof.proofs[0],
		challengeHex,
	], { encoding: "utf-8", timeout: 30000 });

	return result.status === 0 && result.stdout.includes("suceeded");
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	switch (cmd) {
		case "create": {
			const name = args[0];
			if (!name) { print(red("Usage: plot create <name> [k-size] [--pubkey=hex] [--memo=text]")); break; }
			const kArg = args[1];
			const k = kArg ? Number(kArg) : DEFAULT_K;
			if (!Number.isFinite(k) || k < MIN_K || k > MAX_K) {
				print(red(`k-size must be between ${MIN_K} and ${MAX_K}`));
				break;
			}
			const pkArg = args.find((a) => a.startsWith("--pubkey="));
			const pubkeyHex = pkArg ? pkArg.split("=")[1] : "testnet";
			const memoArg = args.find((a) => a.startsWith("--memo="));
			const memo = memoArg ? memoArg.slice(7) : undefined;

			print(dim(`Creating plot "${name}" with k=${k} (~${(Math.pow(2, k) * 0.00078 / 1024).toFixed(1)}GB expected)...`));
			print(dim("  This may take several minutes. Progress:"));
			const start = Date.now();
			const entry = await createPlot(name, k, pubkeyHex, memo, (line) => {
				print(dim("  " + line));
			});
			const elapsed = ((Date.now() - start) / 1000).toFixed(1);
			const sizeMB = statSync(entry.path).size / 1024 / 1024;
			print(green(`Plot created in ${elapsed}s`));
			print(dim("  path: ") + entry.path);
			print(dim("  size: ") + `${sizeMB.toFixed(1)} MB`);
			print(dim("  k:    ") + entry.k);
			print(dim("  id:   ") + entry.id.slice(0, 16) + "…");
			break;
		}

		case "list": {
			const registry = readRegistry();
			if (registry.length === 0) { print(dim("  (no plots)")); break; }
			for (const p of registry) {
				const sizeMB = existsSync(p.path) ? statSync(p.path).size / 1024 / 1024 : 0;
				const exists = existsSync(p.path) ? "" : dim(" (missing)");
				print(`  ${cyan(p.name)}  k=${p.k}  ${sizeMB.toFixed(1)} MB${exists}`);
			}
			break;
		}

		case "prove": {
			const name = args[0];
			const challengeHex = args[1];
			if (!name || !challengeHex) {
				print(red("Usage: plot prove <name> <challenge_hex>"));
				break;
			}
			const plot = findPlot(name);
			if (!plot) { print(red(`Plot "${name}" not found`)); break; }
			if (!existsSync(plot.path)) { print(red(`Plot file missing: ${plot.path}`)); break; }
			const challenge = hexDecode(challengeHex);
			if (challenge.length !== 32) { print(red("challenge must be 64 hex chars (32 bytes)")); break; }

			const start = Date.now();
			const proof = findProofs(plot, challenge);
			const elapsed = Date.now() - start;

			if (!proof || proof.proofs.length === 0) { print(red("No proofs found")); break; }

			print(green(`Found ${proof.proofs.length} proof(s) in ${elapsed}ms`));
			print(dim("  quality: ") + proof.quality);
			for (let i = 0; i < Math.min(proof.proofs.length, 3); i++) {
				print(dim(`  proof[${i}]: `) + proof.proofs[i].slice(0, 32) + "…");
			}
			print(dim("  json:    ") + JSON.stringify(proof));
			break;
		}

		case "verify": {
			const name = args[0];
			const challengeHex = args[1];
			const proofHex = args[2];
			if (!name || !challengeHex || !proofHex) {
				print(red("Usage: plot verify <name> <challenge_hex> <proof_hex>"));
				break;
			}
			const plot = findPlot(name);
			if (!plot) { print(red(`Plot "${name}" not found`)); break; }
			const challenge = hexDecode(challengeHex);
			const proof: PlotProof = {
				plotName: name,
				challengeHex,
				proofs: [proofHex],
				quality: 0,
				k: plot.k,
				plotId: plot.id,
			};
			const valid = verifyProof(proof, challenge, plot);
			print(valid ? green("Proof valid") : red("Proof INVALID"));
			break;
		}

		default: {
			print([
				bold("  Plot") + dim(" — Proof of Space (chiapos / Chia)"),
				`    ${cyan("plot create")} ${dim("<name> [k-size] [--pubkey=hex] [--memo=text]")}  create a plot file`,
				`    ${cyan("plot list")}                         list all plot files`,
				`    ${cyan("plot prove")} ${dim("<name> <challenge>")}     find proofs for challenge`,
				`    ${cyan("plot verify")} ${dim("<name> <challenge> <proof_hex>")} verify a proof`,
				dim("  k=25 = ~600MB (test), k=32 = ~101GB (mainnet)"),
			].join("\n"));
		}
	}
};

// ── Exports ──────────────────────────────────────────────────────

const program: ProgramDef = {
	handler,
};

export default program;

export const __test = {
	findPlot,
	findProofs,
	verifyProof,
	DEFAULT_K,
	MIN_K,
	MAX_K,
};
