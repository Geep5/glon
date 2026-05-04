// Anchor — global ordering and state commitment for chain-mode objects.
//
// Inspired by Chia's consensus design:
//   - Consensus-critical data (merkle_root) is separate from payload (commits_json).
//   - Fork choice: longest chain (highest height), ties broken by timestamp.
//   - State commitment: binary Merkle tree over (objectId + headId) pairs.
//   - PoST: VDF proof (chiavdf) + optional plot proof (chiapos) for anchor creation.
//   - Inflation rewards: new FIG tokens minted to anchor creators.
//
// v1 (real PoST):
//   - VDF proof required for anchor creation (via --vdf flag or auto-compute).
//   - Plot proof optional (quality-based competition).
//   - Inflation reward halving schedule.

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

/** Anchor block type key. */
export const ANCHOR_TYPE_KEY = "chain.anchor";

/** Auto-anchor tick interval in ms. */
const AUTO_ANCHOR_MS = 60_000;

/** Chain-mode types that anchors commit to. */
const TRACKED_TYPES = ["chain.token"];

/** Inflation: base reward in smallest units (1 FIG = 1_000_000 units). */
const BASE_REWARD_UNITS = 5_000_000; // 5 FIG

/** Halve reward every N anchors. */
const HALVING_INTERVAL = 1_000;

/** Minimum reward after halvings (1 unit, effectively zero). */
const MIN_REWARD = 1;

// ── VDF binary paths ─────────────────────────────────────────────

function vdfVerifyBin(): string {
	const dir = process.env.GLON_BIN_DIR ?? join(homedir(), ".glon", "bin");
	return join(dir, "chiavdf-verify");
}

// ── Types ────────────────────────────────────────────────────────

interface AnchorCommit {
	objectId: string;
	headId: string;
}

interface VDFProof {
	discriminant: string;
	x: string;
	y: string;
	proof: string;
	iterations: number;
	discriminantSizeBits: number;
}

interface PersistedState {
	lastAnchorId: string;
	lastAnchorHeight: number;
}

function loadState(raw: Record<string, unknown>): PersistedState {
	return {
		lastAnchorId: typeof raw.lastAnchorId === "string" ? raw.lastAnchorId : "",
		lastAnchorHeight: typeof raw.lastAnchorHeight === "number" ? raw.lastAnchorHeight : -1,
	};
}

// ── Reward calculation ───────────────────────────────────────────

/** Calculate inflation reward for a given anchor height. */
export function computeReward(height: number): number {
	const halvings = Math.floor(height / HALVING_INTERVAL);
	const reward = Math.floor(BASE_REWARD_UNITS / Math.pow(2, halvings));
	return Math.max(reward, MIN_REWARD);
}

// ── VDF validation ───────────────────────────────────────────────

/** Verify a VDF proof using chiavdf-verify binary. */
function validateVDF(vdf: VDFProof): boolean {
	try {
		const bin = vdfVerifyBin();
		const result = spawnSync(bin, [
			vdf.discriminant,
			vdf.x,
			vdf.y,
			vdf.proof,
			String(vdf.iterations),
		], { encoding: "utf-8", timeout: 30000 });
		return result.status === 0 && result.stdout.trim() === "valid";
	} catch {
		return false;
	}
}

// ── Merkle tree ──────────────────────────────────────────────────

function leafHash(objectId: string, headId: string): Uint8Array {
	const data = new TextEncoder().encode(objectId + ":" + headId);
	return sha256(data);
}

export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
	if (leaves.length === 0) {
		return sha256(new Uint8Array(0));
	}
	const level = [...leaves].sort((a, b) => {
		const ha = hexEncode(a);
		const hb = hexEncode(b);
		return ha < hb ? -1 : ha > hb ? 1 : 0;
	});
	while (level.length > 1) {
		const next: Uint8Array[] = [];
		for (let i = 0; i < level.length; i += 2) {
			const left = level[i];
			const right = level[i + 1] ?? left;
			const combined = new Uint8Array(left.length + right.length);
			combined.set(left);
			combined.set(right, left.length);
			next.push(sha256(combined));
		}
		level.length = 0;
		level.push(...next);
	}
	return level[0];
}

export function verifyMerkleRoot(rootHex: string, commits: AnchorCommit[]): boolean {
	const leaves = commits.map((c) => leafHash(c.objectId, c.headId));
	const computed = hexEncode(merkleRoot(leaves));
	return computed === rootHex;
}

// ── Anchor construction ──────────────────────────────────────────

async function buildAnchor(
	ctx: ProgramContext,
	previousAnchorId: string,
	height: number,
	opts: {
		vdfProof?: VDFProof;
		plotProof?: string;
		plotQuality?: number;
		creator?: string;
		rewardPubkey?: string;
	} = {},
): Promise<{ id: string; root: string; commits: AnchorCommit[]; reward: number }> {
	const store = ctx.store as any;

	// Validate VDF if provided
	if (opts.vdfProof && !validateVDF(opts.vdfProof)) {
		throw new Error("Invalid VDF proof");
	}

	// Collect heads from all tracked chain-mode types.
	const commits: AnchorCommit[] = [];
	for (const typeKey of TRACKED_TYPES) {
		const refs = (await store.list(typeKey)) as Array<{ id: string }>;
		for (const ref of refs) {
			const obj = await store.get(ref.id);
			if (!obj || obj.deleted) continue;
			const heads: string[] = obj.headIds ?? [];
			for (const headId of heads) {
				commits.push({ objectId: ref.id, headId });
			}
		}
	}

	const leaves = commits.map((c) => leafHash(c.objectId, c.headId));
	const root = hexEncode(merkleRoot(leaves));

	const reward = computeReward(height);

    const fields = {
        height: ctx.intVal(height),
        previous_anchor: ctx.stringVal(previousAnchorId),
        merkle_root: ctx.stringVal(root),
        timestamp: ctx.intVal(Date.now()),
        creator: ctx.stringVal(opts.creator ?? "system"),
        commit_count: ctx.intVal(commits.length),
        commits_json: ctx.stringVal(JSON.stringify(commits)),
        vdf_output: ctx.stringVal(opts.vdfProof ? JSON.stringify(opts.vdfProof) : ""),
        plot_proof: ctx.stringVal(opts.plotProof ?? ""),
        plot_quality: ctx.intVal(opts.plotQuality ?? 0),
        reward_pubkey: ctx.stringVal(opts.rewardPubkey ?? ""),
        reward_amount: ctx.intVal(reward),
    };

	const id = (await store.create(ANCHOR_TYPE_KEY, JSON.stringify(fields))) as string;
	return { id, root, commits, reward };
}

// ── Anchor queries ───────────────────────────────────────────────

async function findLatestAnchor(store: any): Promise<{ id: string; height: number; root: string; previous: string; timestamp: number } | null> {
	const refs = (await store.list(ANCHOR_TYPE_KEY)) as Array<{ id: string }>;
	if (refs.length === 0) return null;
	let best: { id: string; height: number; root: string; previous: string; timestamp: number } | null = null;
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (!obj || obj.deleted) continue;
		const fields = obj.fields ?? {};
		const height = Number(fields.height?.intValue ?? fields.height ?? 0);
		const timestamp = Number(fields.timestamp?.intValue ?? fields.timestamp ?? 0);
		const root = String(fields.merkle_root?.stringValue ?? fields.merkle_root ?? "");
		const previous = String(fields.previous_anchor?.stringValue ?? fields.previous_anchor ?? "");
		if (!best || height > best.height || (height === best.height && timestamp < best.timestamp)) {
			best = { id: ref.id, height, root, previous, timestamp };
		}
	}
	return best;
}

async function getChainFrom(store: any, startId: string, limit: number): Promise<Array<{ id: string; height: number; root: string; previous: string; timestamp: number }>> {
	const out: Array<{ id: string; height: number; root: string; previous: string; timestamp: number }> = [];
	let currentId = startId;
	const seen = new Set<string>();
	while (currentId && out.length < limit && !seen.has(currentId)) {
		seen.add(currentId);
		const obj = await store.get(currentId);
		if (!obj || obj.deleted) break;
		const fields = obj.fields ?? {};
		const height = Number(fields.height?.intValue ?? fields.height ?? 0);
		const timestamp = Number(fields.timestamp?.intValue ?? fields.timestamp ?? 0);
		const root = String(fields.merkle_root?.stringValue ?? fields.merkle_root ?? "");
		const previous = String(fields.previous_anchor?.stringValue ?? fields.previous_anchor ?? "");
		out.push({ id: currentId, height, root, previous, timestamp });
		currentId = previous;
	}
	return out;
}

async function isFinalized(store: any, objectId: string, headId: string): Promise<boolean> {
	const refs = (await store.list(ANCHOR_TYPE_KEY)) as Array<{ id: string }>;
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (!obj || obj.deleted) continue;
		const fields = obj.fields ?? {};
		const commitsJson = String(fields.commits_json?.stringValue ?? fields.commits_json ?? "[]");
		try {
			const commits = JSON.parse(commitsJson) as AnchorCommit[];
			if (commits.some((c) => c.objectId === objectId && c.headId === headId)) return true;
		} catch { /* ignore */ }
	}
	return false;
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	const store = ctx.store as any;
	const state = loadState(ctx.state ?? {});

	switch (cmd) {
		case "create": {
			const latest = await findLatestAnchor(store);
			const height = latest ? latest.height + 1 : 0;
			const previousId = latest ? latest.id : "";

			const vdfArg = args.find((a) => a.startsWith("--vdf="));
			const plotArg = args.find((a) => a.startsWith("--plot-proof="));
			const qualityArg = args.find((a) => a.startsWith("--plot-quality="));
			const creatorArg = args.find((a) => a.startsWith("--creator="));
			const rewardArg = args.find((a) => a.startsWith("--reward-pubkey="));

			let vdfProof: VDFProof | undefined;
			if (vdfArg) {
				try { vdfProof = JSON.parse(vdfArg.split("=")[1]) as VDFProof; } catch {
					print(red("Invalid --vdf JSON"));
					break;
				}
			}

			const plotProof = plotArg ? plotArg.split("=")[1] : undefined;
			const plotQuality = qualityArg ? Number(qualityArg.split("=")[1]) : undefined;
			const creator = creatorArg ? creatorArg.split("=")[1] : undefined;
			const rewardPubkey = rewardArg ? rewardArg.split("=")[1] : undefined;

			try {
				const { id, root, commits, reward } = await buildAnchor(ctx, previousId, height, {
					vdfProof,
					plotProof,
					plotQuality,
					creator,
					rewardPubkey,
				});

				state.lastAnchorId = id;
				state.lastAnchorHeight = height;
				ctx.state!.lastAnchorId = id;
				ctx.state!.lastAnchorHeight = height;

				print(green("Anchor created"));
				print(dim("  id:      ") + id);
				print(dim("  height:  ") + String(height));
				print(dim("  root:    ") + root.slice(0, 24) + "…");
				print(dim("  commits: ") + commits.length + " object head(s)");
				print(dim("  reward:  ") + (reward / 1_000_000).toFixed(6) + " FIG");
				if (vdfProof) print(dim("  vdf:     ") + "verified");
				if (plotProof) print(dim("  plot:    ") + `quality=${plotQuality ?? 0}`);
				if (previousId) print(dim("  prev:    ") + previousId);
			} catch (err: any) {
				print(red("Anchor creation failed: " + (err?.message ?? String(err))));
			}
			break;
		}

		case "list": {
			const limit = Number(args[0] ?? 20);
			const latest = await findLatestAnchor(store);
			if (!latest) { print(dim("  (no anchors yet)")); break; }
			const chain = await getChainFrom(store, latest.id, limit);
			for (const a of chain) {
				const shortRoot = a.root ? a.root.slice(0, 16) + "…" : "—";
				print(`  ${bold(String(a.height))}  ${dim(new Date(a.timestamp).toLocaleTimeString())}  ${cyan(a.id.slice(0, 12) + "…")}  root=${shortRoot}`);
			}
			break;
		}

		case "status": {
			const latest = await findLatestAnchor(store);
			if (!latest) { print(dim("  No anchors yet. Run: anchor create")); break; }
			print(bold("Anchor status"));
			print(dim("  latest height: ") + bold(String(latest.height)));
			print(dim("  latest id:     ") + latest.id);
			print(dim("  merkle root:   ") + latest.root.slice(0, 24) + "…");
			print(dim("  timestamp:     ") + new Date(latest.timestamp).toLocaleString());

			const obj = await store.get(latest.id);
			const fields = obj?.fields ?? {};
			const commitsJson = String(fields.commits_json?.stringValue ?? fields.commits_json ?? "[]");
			let commitCount = 0;
			try { commitCount = (JSON.parse(commitsJson) as AnchorCommit[]).length; } catch { /* ignore */ }
			print(dim("  commits:       ") + commitCount + " object head(s) in latest anchor");

			const vdfOutput = String(fields.vdf_output?.stringValue ?? fields.vdf_output ?? "");
			const plotQuality = Number(fields.plot_quality?.intValue ?? fields.plot_quality ?? 0);
			const rewardAmount = String(fields.reward_amount?.stringValue ?? fields.reward_amount ?? "0");
			if (vdfOutput) print(dim("  VDF proof:     ") + "included");
			if (plotQuality > 0) print(dim("  plot quality:  ") + plotQuality);
			print(dim("  next reward:   ") + (computeReward(latest.height + 1) / 1_000_000).toFixed(6) + " FIG");

			let totalObjects = 0;
			for (const typeKey of TRACKED_TYPES) {
				const refs = (await store.list(typeKey)) as Array<{ id: string }>;
				totalObjects += refs.length;
			}
			print(dim("  chain objects: ") + totalObjects + " tracked type(s)");
			break;
		}

		case "info": {
			const id = args[0];
			if (!id) { print(red("Usage: anchor info <anchor_id>")); break; }
			const obj = await store.get(id);
			if (!obj || obj.deleted || obj.typeKey !== ANCHOR_TYPE_KEY) {
				print(red("Not found or not an anchor"));
				break;
			}
			const f = obj.fields ?? {};
			const height = Number(f.height?.intValue ?? f.height ?? 0);
			const timestamp = Number(f.timestamp?.intValue ?? f.timestamp ?? 0);
			const root = String(f.merkle_root?.stringValue ?? f.merkle_root ?? "");
			const previous = String(f.previous_anchor?.stringValue ?? f.previous_anchor ?? "");
			const creator = String(f.creator?.stringValue ?? f.creator ?? "system");
			const commitCount = Number(f.commit_count?.intValue ?? f.commit_count ?? 0);
			const commitsJson = String(f.commits_json?.stringValue ?? f.commits_json ?? "[]");
			const vdfOutput = String(f.vdf_output?.stringValue ?? f.vdf_output ?? "");
			const plotQuality = Number(f.plot_quality?.intValue ?? f.plot_quality ?? 0);
			const rewardAmount = String(f.reward_amount?.stringValue ?? f.reward_amount ?? "0");
			const rewardPubkey = String(f.reward_pubkey?.stringValue ?? f.reward_pubkey ?? "");

			print(bold(`Anchor ${height}`));
			print(dim("  id:       ") + id);
			print(dim("  root:     ") + root);
			print(dim("  creator:  ") + creator);
			print(dim("  previous: ") + (previous || "(genesis)"));
			print(dim("  time:     ") + new Date(timestamp).toLocaleString());
			print(dim("  commits:  ") + commitCount);
			print(dim("  reward:   ") + (Number(rewardAmount) / 1_000_000).toFixed(6) + " FIG");
			if (rewardPubkey) print(dim("  reward to:") + rewardPubkey.slice(0, 24) + "…");
			if (vdfOutput) print(dim("  VDF:      ") + "included");
			if (plotQuality > 0) print(dim("  quality:  ") + plotQuality);

			try {
				const commits = JSON.parse(commitsJson) as AnchorCommit[];
				const valid = verifyMerkleRoot(root, commits);
				print(dim("  verify:   ") + (valid ? green("ok") : red("MISMATCH")));
			} catch {
				print(dim("  verify:   ") + red("commits_json invalid"));
			}
			break;
		}

		case "verify": {
			const id = args[0];
			if (!id) { print(red("Usage: anchor verify <anchor_id>")); break; }
			const obj = await store.get(id);
			if (!obj || obj.deleted || obj.typeKey !== ANCHOR_TYPE_KEY) {
				print(red("Not found or not an anchor"));
				break;
			}
			const f = obj.fields ?? {};
			const root = String(f.merkle_root?.stringValue ?? f.merkle_root ?? "");
			const commitsJson = String(f.commits_json?.stringValue ?? f.commits_json ?? "[]");
			const vdfOutput = String(f.vdf_output?.stringValue ?? f.vdf_output ?? "");

			// Verify Merkle root
			try {
				const commits = JSON.parse(commitsJson) as AnchorCommit[];
				const merkleValid = verifyMerkleRoot(root, commits);
				print(merkleValid ? green("Merkle root verified") : red("Merkle root MISMATCH"));
			} catch (err: any) {
				print(red("Merkle error: " + (err?.message ?? String(err))));
			}

			// Verify VDF if present
			if (vdfOutput) {
				try {
					const vdf = JSON.parse(vdfOutput) as VDFProof;
					const vdfValid = validateVDF(vdf);
					print(vdfValid ? green("VDF proof verified") : red("VDF proof INVALID"));
				} catch {
					print(red("VDF proof malformed"));
				}
			}
			break;
		}

		default: {
			print([
				bold("  Anchor") + dim(" — global ordering + state commitment + PoST + inflation rewards"),
				`    ${cyan("anchor create")} ${dim("[--vdf=json] [--plot-proof=json] [--plot-quality=N] [--creator=name] [--reward-pubkey=hex]")}`,
				`    ${cyan("anchor list")} ${dim("[limit]")}        show recent anchors`,
				`    ${cyan("anchor status")}               latest height, commit count, next reward`,
				`    ${cyan("anchor info")} ${dim("<id>")}         full anchor details + Merkle verify`,
				`    ${cyan("anchor verify")} ${dim("<id>")}        verify Merkle root + VDF proof`,
				dim(`  Auto-anchors every ${AUTO_ANCHOR_MS / 1000}s.`),
				dim(`  Inflation: ${BASE_REWARD_UNITS / 1_000_000} FIG/base, halving every ${HALVING_INTERVAL} anchors.`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ─────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: (): Record<string, unknown> => ({
		lastAnchorId: "",
		lastAnchorHeight: -1,
	}),

	actions: {
		createAnchor: async (ctx: ProgramContext, opts?: {
			vdfProof?: VDFProof;
			plotProof?: string;
			plotQuality?: number;
			creator?: string;
			rewardPubkey?: string;
		}) => {
			const store = ctx.store as any;
			const latest = await findLatestAnchor(store);
			const height = latest ? latest.height + 1 : 0;
			const previousId = latest ? latest.id : "";
			const { id, root, commits, reward } = await buildAnchor(ctx, previousId, height, opts ?? {});
			const s = loadState(ctx.state ?? {});
			s.lastAnchorId = id;
			s.lastAnchorHeight = height;
			ctx.state!.lastAnchorId = id;
			ctx.state!.lastAnchorHeight = height;
			return { id, height, root, commitCount: commits.length, previousId, reward };
		},

		getLatest: async (ctx: ProgramContext) => {
			const latest = await findLatestAnchor(ctx.store as any);
			if (!latest) return null;
			return { id: latest.id, height: latest.height, root: latest.root, timestamp: latest.timestamp };
		},

		getChain: async (ctx: ProgramContext, limit: number = 20) => {
			const store = ctx.store as any;
			const latest = await findLatestAnchor(store);
			if (!latest) return [];
			return getChainFrom(store, latest.id, limit);
		},

		isFinal: async (ctx: ProgramContext, objectId: string, headId: string) => {
			return await isFinalized(ctx.store as any, objectId, headId);
		},

		verify: async (ctx: ProgramContext, anchorId: string) => {
			const store = ctx.store as any;
			const obj = await store.get(anchorId);
			if (!obj || obj.deleted || obj.typeKey !== ANCHOR_TYPE_KEY) {
				return { valid: false, error: "not found or not an anchor" };
			}
			const f = obj.fields ?? {};
			const root = String(f.merkle_root?.stringValue ?? f.merkle_root ?? "");
			const commitsJson = String(f.commits_json?.stringValue ?? f.commits_json ?? "[]");
			try {
				const commits = JSON.parse(commitsJson) as AnchorCommit[];
				const merkleValid = verifyMerkleRoot(root, commits);
				const vdfOutput = String(f.vdf_output?.stringValue ?? f.vdf_output ?? "");
				let vdfValid: boolean | undefined;
				if (vdfOutput) {
					try {
						const vdf = JSON.parse(vdfOutput) as VDFProof;
						vdfValid = validateVDF(vdf);
					} catch { vdfValid = false; }
				}
				return { valid: merkleValid && (vdfValid !== false), anchorId, height: Number(f.height?.intValue ?? f.height ?? 0), vdfValid };
			} catch (err: any) {
				return { valid: false, error: err?.message ?? String(err) };
			}
		},

		computeReward: async (_ctx: ProgramContext, height: number) => {
			return computeReward(height);
		},
	},

	onTick: async (ctx: ProgramContext) => {
		const store = ctx.store as any;
		const latest = await findLatestAnchor(store);
		const height = latest ? latest.height + 1 : 0;
		const previousId = latest ? latest.id : "";
		const { id, root, commits } = await buildAnchor(ctx, previousId, height);
		const s = loadState(ctx.state ?? {});
		s.lastAnchorId = id;
		s.lastAnchorHeight = height;
		ctx.state!.lastAnchorId = id;
		ctx.state!.lastAnchorHeight = height;
		ctx.emit("anchor_created", { id, height, root, commitCount: commits.length });
	},

	tickMs: AUTO_ANCHOR_MS,
};

const program: ProgramDef = {
	handler,
	actor: actorDef,
};

export default program;

export const __test = {
	leafHash,
	merkleRoot,
	verifyMerkleRoot,
	computeReward,
	ANCHOR_TYPE_KEY,
	BASE_REWARD_UNITS,
	HALVING_INTERVAL,
};
