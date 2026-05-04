// Timelord — real Proof of Time (VDF) using chiavdf.
//
// This program shells out to chiavdf-compute and chiavdf-verify binaries
// installed at ~/.glon/bin/. These are built from Chia Network's chiavdf
// (https://github.com/Chia-Network/chiavdf) which uses class groups of
// unknown order and Wesolowski proofs.
//
// To install/rebuild binaries:
//   cd /tmp && git clone https://github.com/Chia-Network/chiavdf.git
//   cd chiavdf && mkdir build && cmake -S src -B build \
//     -DBUILD_PYTHON=OFF -DBUILD_CHIAVDFC=OFF \
//     -DBUILD_VDF_CLIENT=ON -DBUILD_VDF_BENCH=ON
//   cmake --build build --target vdf_compute vdf_verify
//   cp build/vdf_compute ~/.glon/bin/chiavdf-compute
//   cp build/vdf_verify ~/.glon/bin/chiavdf-verify

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { sha256, hexEncode, hexDecode } from "../../crypto.js";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

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

/** Default VDF iterations. Tuned for ~20-45s on modern CPUs. */
export const DEFAULT_VDF_ITERATIONS = 5_000_000;

/** Minimum iterations to prevent trivial VDFs. */
export const MIN_ITERATIONS = 100_000;

/** Discriminant size in bits (Chia mainnet uses 1024). */
export const DISCRIMINANT_SIZE_BITS = 1024;

// ── Binary paths ─────────────────────────────────────────────────

function binDir(): string {
	return process.env.GLON_BIN_DIR ?? join(homedir(), ".glon", "bin");
}

function computeBin(): string {
	return join(binDir(), "chiavdf-compute");
}

function verifyBin(): string {
	return join(binDir(), "chiavdf-verify");
}

// ── VDF types ────────────────────────────────────────────────────

export interface VDFOutput {
	challengeHex: string;
	iterations: number;
	discriminant: string;
	x: string; // serialized generator form
	y: string; // serialized result form
	proof: string; // serialized wesolowski proof
	discriminantSizeBits: number;
	durationMs: number;
}

// ── VDF computation ──────────────────────────────────────────────

/** Compute VDF using chiavdf-compute binary. */
export function computeVDF(challenge: Uint8Array, iterations: number): VDFOutput {
	if (iterations < MIN_ITERATIONS) {
		throw new Error(`VDF iterations must be >= ${MIN_ITERATIONS}`);
	}
	const challengeHex = hexEncode(challenge);
	const bin = computeBin();
	const start = Date.now();
	const result = spawnSync(bin, [challengeHex, String(iterations), String(DISCRIMINANT_SIZE_BITS)], {
		encoding: "utf-8",
		timeout: Math.max(iterations * 2, 30000), // generous timeout
	});
	const durationMs = Date.now() - start;

	if (result.status !== 0 || result.error) {
		throw new Error(`chiavdf-compute failed: ${result.stderr ?? result.error?.message ?? "unknown error"}`);
	}

	const output = JSON.parse(result.stdout.trim()) as {
		challenge_hex: string;
		discriminant: string;
		x: string;
		y: string;
		proof: string;
		iterations: number;
		discriminant_size_bits: number;
		duration_ms: number;
	};

	return {
		challengeHex: output.challenge_hex,
		iterations: output.iterations,
		discriminant: output.discriminant,
		x: output.x,
		y: output.y,
		proof: output.proof,
		discriminantSizeBits: output.discriminant_size_bits,
		durationMs: durationMs,
	};
}

/** Verify a VDF output using chiavdf-verify binary. */
export function verifyVDF(output: VDFOutput): boolean {
	try {
		const bin = verifyBin();
		const result = spawnSync(bin, [
			output.discriminant,
			output.x,
			output.y,
			output.proof,
			String(output.iterations),
		], { encoding: "utf-8", timeout: 30000 });
		return result.status === 0 && result.stdout.trim() === "valid";
	} catch {
		return false;
	}
}

/** Derive a challenge from an anchor's merkle_root for deterministic ordering. */
export function deriveChallenge(merkleRootHex: string): Uint8Array {
	const root = hexDecode(merkleRootHex);
	const salt = new TextEncoder().encode("glon-vdf-challenge-v1");
	const combined = new Uint8Array(root.length + salt.length);
	combined.set(root);
	combined.set(salt, root.length);
	return sha256(combined);
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	switch (cmd) {
		case "compute": {
			const challengeHex = args[0];
			const iterationsArg = args[1];
			if (!challengeHex) {
				print(red("Usage: timelord compute <challenge_hex> [iterations]"));
				break;
			}
			const challenge = hexDecode(challengeHex);
			if (challenge.length !== 32) { print(red("challenge must be 64 hex chars")); break; }
			const iterations = iterationsArg ? Number(iterationsArg) : DEFAULT_VDF_ITERATIONS;
			if (!Number.isFinite(iterations) || iterations < MIN_ITERATIONS) {
				print(red(`iterations must be >= ${MIN_ITERATIONS}`));
				break;
			}
			print(dim(`Computing VDF: ${iterations.toLocaleString()} iterations (${DISCRIMINANT_SIZE_BITS}-bit discriminant)...`));
			const output = computeVDF(challenge, iterations);
			print(green(`Done in ${output.durationMs}ms`));
			print(dim("  discriminant: ") + output.discriminant.slice(0, 30) + "…");
			print(dim("  y:            ") + output.y.slice(0, 16) + "…");
			print(dim("  proof:        ") + output.proof.slice(0, 16) + "…");
			print(dim("  json:         ") + JSON.stringify(output));
			break;
		}

		case "verify": {
			const json = args[0];
			if (!json) { print(red("Usage: timelord verify <output_json>")); break; }
			let output: VDFOutput;
			try { output = JSON.parse(json); } catch { print(red("Invalid JSON")); break; }
			const start = Date.now();
			const valid = verifyVDF(output);
			const elapsed = Date.now() - start;
			print(valid ? green(`Verified in ${elapsed}ms`) : red("Verification FAILED"));
			break;
		}

		case "benchmark": {
			const iterationsArg = args[0];
			const iterations = iterationsArg ? Number(iterationsArg) : 1_000_000;
			print(dim(`Benchmarking VDF with ${iterations.toLocaleString()} iterations (${DISCRIMINANT_SIZE_BITS}-bit discriminant)...`));
			const challenge = new Uint8Array(32);
			crypto.getRandomValues(challenge);
			const output = computeVDF(challenge, iterations);
			print(green(`Completed in ${output.durationMs}ms`));
			const ips = Math.round(iterations / (output.durationMs / 1000));
			print(dim("  speed: ") + `${ips.toLocaleString()} iter/s`);
			const timeFor5M = (5_000_000 / ips * 1000).toFixed(0);
			print(dim(`  estimated time for 5M iter: ${timeFor5M}ms`));
			break;
		}

		case "challenge": {
			const merkleRootHex = args[0];
			if (!merkleRootHex) { print(red("Usage: timelord challenge <merkle_root_hex>")); break; }
			const challenge = deriveChallenge(merkleRootHex);
			print("Challenge: " + hexEncode(challenge));
			break;
		}

		default: {
			print([
				bold("  Timelord") + dim(" — Proof of Time (chiavdf / class-group VDF)"),
				`    ${cyan("timelord compute")} ${dim("<challenge_hex> [iterations]")}  run VDF computation`,
				`    ${cyan("timelord verify")} ${dim("<output_json>")}            verify a VDF output`,
				`    ${cyan("timelord benchmark")} ${dim("[iterations]")}         measure VDF speed`,
				`    ${cyan("timelord challenge")} ${dim("<merkle_root>")}        derive challenge from anchor`,
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ─────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		compute: async (_ctx: ProgramContext, challengeHex: string, iterations: number) => {
			const challenge = hexDecode(challengeHex);
			return computeVDF(challenge, iterations);
		},
		verify: async (_ctx: ProgramContext, outputJson: string) => {
			const output = JSON.parse(outputJson) as VDFOutput;
			return verifyVDF(output);
		},
		deriveChallenge: async (_ctx: ProgramContext, merkleRootHex: string) => {
			return hexEncode(deriveChallenge(merkleRootHex));
		},
	},
};

const program: ProgramDef = {
	handler,
	actor: actorDef,
};

export default program;

export const __test = {
	computeVDF,
	verifyVDF,
	deriveChallenge,
	DEFAULT_VDF_ITERATIONS,
	MIN_ITERATIONS,
	DISCRIMINANT_SIZE_BITS,
};
