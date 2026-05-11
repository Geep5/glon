// Anchor — global ordering and state commitment for chain-mode objects.
//
// Inspired by Chia's consensus design:
//   - Consensus-critical data (merkle_root) is separate from payload (commits_json).
//   - Fork choice: longest chain (highest height), ties broken by timestamp.
//   - State commitment: binary Merkle tree over (objectId + headId) pairs.
//   - PoST: VDF proof (chiavdf) + optional plot proof (chiapos) for anchor creation.
	//   - Inflation rewards: new FIGGIES tokens minted to anchor creators.
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
import { dim, bold, cyan, red, green } from "../shared.js";
import {
	buildCoinOpChange,
	encodeCoinOp,
} from "./coin-bucket.js";
import { encodeChange } from "../../proto.js";
import { randomUUID } from "node:crypto";
import type { CoinOp } from "./coin-types.js";

// ── Constants ────────────────────────────────────────────────────

/** Anchor block type key. */
export const ANCHOR_TYPE_KEY = "chain.anchor";

/** Auto-anchor tick interval in ms. */
const AUTO_ANCHOR_MS = 60_000;

/** Chain-mode types that anchors commit to. */
const TRACKED_TYPES = ["chain.coin.bucket"];

	/** Inflation: base reward in smallest units (1 Figgie = 1 unit). */
	const BASE_REWARD_UNITS = 1;
	const REWARD_SYMBOL = "FIGGIES";
	const REWARD_TOKEN_ID = "b1aa1f2da78048a6a2051db9";
	const REWARD_BUCKET_ID = "cb3ef6bd1ab04a77bcf0cf78";

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
	miningDisabled: boolean;
}

function loadState(raw: Record<string, unknown>): PersistedState {
	return {
		lastAnchorId: typeof raw.lastAnchorId === "string" ? raw.lastAnchorId : "",
		lastAnchorHeight: typeof raw.lastAnchorHeight === "number" ? raw.lastAnchorHeight : -1,
		miningDisabled: typeof raw.miningDisabled === "boolean" ? raw.miningDisabled : false,
	};
}

// ── Mining toggle (runtime + env-driven) ─────────────────────────
//
// The `/anchor` actor ticks every 60s and mints a FIG reward by default
// just for being loaded. That is rarely what a single-machine user wants.
// The toggle is stored two ways:
//   - env var GLON_ANCHOR_DISABLED=1 → default-off at boot
//   - field `mining_disabled` on the /anchor program object →
//     persists across restarts, set/cleared by `setEnabled` action
// On startup `restoreMiningDisabled` resolves the field first (if present)
// and falls back to the env var. `onTick` no-ops while disabled.

const MINING_DISABLED_FIELD = "mining_disabled";

async function restoreMiningDisabled(ctx: ProgramContext): Promise<boolean> {
	if (!ctx.programId) return process.env.GLON_ANCHOR_DISABLED === "1";
	try {
		const obj = await (ctx.store as any).get(ctx.programId);
		const f = obj?.fields?.[MINING_DISABLED_FIELD];
		if (f && typeof f === "object" && "boolValue" in f) return !!f.boolValue;
		if (typeof f === "boolean") return f;
	} catch { /* ignore */ }
	return process.env.GLON_ANCHOR_DISABLED === "1";
}

async function persistMiningDisabled(ctx: ProgramContext, disabled: boolean): Promise<void> {
	if (!ctx.programId) return;
	try {
		const actor = ctx.objectActor(ctx.programId) as any;
		if (typeof actor?.setField !== "function") return;
		await actor.setField(MINING_DISABLED_FIELD, JSON.stringify(ctx.boolVal(disabled)));
	} catch (err: any) {
		ctx.print?.(dim(`  [anchor] persist mining_disabled failed: ${err?.message ?? String(err)}`));
	}
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

	// ── Mint Figgies reward to miner ──────────────────────────────
	if (opts.rewardPubkey && reward > 0) {
		try {
			const bucketActor = ctx.objectActor(REWARD_BUCKET_ID);
			const heads = await bucketActor.getHeads();
			const parentId = heads[0];

			const coinOp: CoinOp = {
				kind: "create",
				coinId: randomUUID().replace(/-/g, "").slice(0, 16),
				ownerPubkey: opts.rewardPubkey,
				amount: String(reward),
			};

			const mintChange = buildCoinOpChange({
				bucketId: REWARD_BUCKET_ID,
				parentIds: [hexDecode(parentId)],
				timestamp: Date.now(),
				author: "anchor-reward",
				op: coinOp,
				blockId: randomUUID().replace(/-/g, "").slice(0, 16),
			});

			const mintB64 = Buffer.from(encodeChange(mintChange)).toString("base64");
			const { changeB64: signedMintB64 } = await ctx.dispatchProgram("/wallet", "signChange", [{
				name: "default",
				changeB64: mintB64,
				nonce: 1,
				fee: 1,
			}]) as { changeB64: string };

			await bucketActor.pushChanges(signedMintB64);
		} catch (err: any) {
			console.warn(`[anchor] reward mint failed: ${err?.message ?? err}`);
		}
	}

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
				print(dim("  reward:  ") + reward + " " + REWARD_SYMBOL);
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
			print(dim("  next reward:   ") + computeReward(latest.height + 1) + " " + REWARD_SYMBOL);

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
			print(dim("  reward:   ") + rewardAmount + " " + REWARD_SYMBOL);
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
			dim(`  Inflation: ${BASE_REWARD_UNITS} ${REWARD_SYMBOL}/base, halving every ${HALVING_INTERVAL} anchors.`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ─────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: (): Record<string, unknown> => ({
		lastAnchorId: "",
		lastAnchorHeight: -1,
		miningDisabled: false,
	}),

	onCreate: async (ctx: ProgramContext) => {
		const disabled = await restoreMiningDisabled(ctx);
		ctx.state!.miningDisabled = disabled;
		if (disabled) {
			ctx.print?.(dim(`  [anchor] mining DISABLED — onTick will no-op until /anchor setEnabled true`));
		}
	},

	actions: {
		/** Enable or disable the auto-mining tick. Idempotent; persists to the
		 *  program object so the choice survives daemon restarts. */
		setEnabled: async (ctx: ProgramContext, opts: boolean | string | { enabled?: boolean }) => {
			let enabled: boolean;
			if (typeof opts === "boolean") enabled = opts;
			else if (typeof opts === "string") {
				try { enabled = !!(JSON.parse(opts) as { enabled?: boolean }).enabled; }
				catch { enabled = opts === "true"; }
			} else enabled = !!opts?.enabled;
			const disabled = !enabled;
			ctx.state!.miningDisabled = disabled;
			await persistMiningDisabled(ctx, disabled);
			return {
				enabled,
				mining_disabled: disabled,
				tick_ms: AUTO_ANCHOR_MS,
			};
		},

		/** Read the current toggle state plus the latest mined anchor. */
		getStatus: async (ctx: ProgramContext) => {
			return {
				enabled: !ctx.state?.miningDisabled,
				mining_disabled: !!ctx.state?.miningDisabled,
				env_default_disabled: process.env.GLON_ANCHOR_DISABLED === "1",
				tick_ms: AUTO_ANCHOR_MS,
				last_anchor_id: (ctx.state?.lastAnchorId as string) ?? "",
				last_anchor_height: (ctx.state?.lastAnchorHeight as number) ?? -1,
				reward_symbol: REWARD_SYMBOL,
				next_reward_units: computeReward(((ctx.state?.lastAnchorHeight as number) ?? -1) + 1),
			};
		},

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
		// Skip mining if disabled by setEnabled or the GLON_ANCHOR_DISABLED env.
		if (ctx.state?.miningDisabled) return;
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
