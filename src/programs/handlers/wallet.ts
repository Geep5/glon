// Wallet — local-only Ed25519 key management and Change signing.
//
// Mirrors the storage pattern of /auth: keys live in a flat JSON file
// under GLON_DATA, mode 0600, written atomically via .tmp + rename. Keys
// NEVER touch the DAG. Wallet objects are not chain-mode; they're a local
// utility, like a private keychain.
//
// Two responsibilities:
//   1. Generate, store, list named keypairs.
//   2. Sign a Change on behalf of a named key. The wallet receives an
//      unsigned Change (without `author_sig`), fills in pubkey/nonce/fee,
//      computes canonical signing bytes, signs them, and returns the
//      fully-formed signed Change with content-addressed `id` filled in.
//
// What the wallet does NOT do:
	//   - Construct token operations (that's /coin's job)
//   - Maintain on-chain state (the wallet is local; on-chain identity is
//     just the raw pubkey)
//   - Verify signatures (the kernel does that on push)

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { encodeChange, decodeChange, type Change, type Signature } from "../../proto.js";
import { canonicalEncodeChange, canonicalEncodeChangeForSigning } from "../../det/canonical.js";
import { generateKeyPair, sign as ed25519Sign } from "../../det/ed25519.js";
import { sha256, hexEncode, hexDecode } from "../../crypto.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

// ── Wallet file format ────────────────────────────────────────────

interface KeyEntry {
	/** Hex-encoded 32-byte Ed25519 public key. */
	pubkey: string;
	/** Hex-encoded 32-byte Ed25519 private key seed. NEVER leaves the wallet file. */
	privateKey: string;
	/** Unix ms when this key was created. Tests inject explicitly; production uses Date.now. */
	createdAt: number;
}

interface WalletFile {
	version: 1;
	keys: Record<string, KeyEntry>;
}

function walletFilePath(): string {
	const root = process.env.GLON_DATA ?? join(homedir(), ".glon");
	return join(root, "wallet.json");
}

function readWalletFile(path?: string): WalletFile {
	const p = path ?? walletFilePath();
	if (!existsSync(p)) return { version: 1, keys: {} };
	try {
		const raw = readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && parsed.version === 1) {
			return {
				version: 1,
				keys: (parsed.keys && typeof parsed.keys === "object") ? parsed.keys : {},
			};
		}
	} catch {
		// Corrupt file: treat as empty so a fresh `wallet new` resets it.
	}
	return { version: 1, keys: {} };
}

function writeWalletFile(file: WalletFile, path?: string): void {
	const p = path ?? walletFilePath();
	const dir = p.slice(0, p.lastIndexOf("/"));
	mkdirSync(dir, { recursive: true });
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
	try { chmodSync(tmp, 0o600); } catch { /* best-effort on non-POSIX */ }
	renameSync(tmp, p);
}

function deleteWalletFile(path?: string): void {
	const p = path ?? walletFilePath();
	try { unlinkSync(p); } catch { /* missing is fine */ }
}

// ── Core operations ──────────────────────────────────────────────

interface NewKeyResult {
	name: string;
	pubkey: string;
	createdAt: number;
}

interface KeyInfo {
	name: string;
	pubkey: string;
	createdAt: number;
}

function doNew(name: string, now: number, path?: string): NewKeyResult {
	if (!name || typeof name !== "string") throw new Error("wallet.new: name required");
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
		throw new Error("wallet.new: name must be 1-64 chars [a-zA-Z0-9_-]");
	}
	const file = readWalletFile(path);
	if (file.keys[name]) {
		throw new Error(`wallet.new: key "${name}" already exists`);
	}
	const kp = generateKeyPair();
	file.keys[name] = {
		pubkey: hexEncode(kp.publicKey),
		privateKey: hexEncode(kp.privateKey),
		createdAt: now,
	};
	writeWalletFile(file, path);
	return { name, pubkey: file.keys[name].pubkey, createdAt: now };
}

function doList(path?: string): KeyInfo[] {
	const file = readWalletFile(path);
	const out: KeyInfo[] = [];
	for (const [name, entry] of Object.entries(file.keys)) {
		out.push({ name, pubkey: entry.pubkey, createdAt: entry.createdAt });
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

function doShow(name: string, path?: string): KeyInfo | null {
	const file = readWalletFile(path);
	const entry = file.keys[name];
	if (!entry) return null;
	return { name, pubkey: entry.pubkey, createdAt: entry.createdAt };
}

function doRemove(name: string, path?: string): boolean {
	const file = readWalletFile(path);
	if (!file.keys[name]) return false;
	delete file.keys[name];
	if (Object.keys(file.keys).length === 0) {
		deleteWalletFile(path);
	} else {
		writeWalletFile(file, path);
	}
	return true;
}

/** Look up a key by raw pubkey (hex). Useful when a Change tells you the pubkey but not the name. */
function doKeyForPubkey(pubkeyHex: string, path?: string): KeyInfo | null {
	const file = readWalletFile(path);
	for (const [name, entry] of Object.entries(file.keys)) {
		if (entry.pubkey === pubkeyHex) return { name, pubkey: entry.pubkey, createdAt: entry.createdAt };
	}
	return null;
}

// ── Signing ──────────────────────────────────────────────────────

interface SignChangeInput {
	/** Wallet key name to sign with. */
	name: string;
	/** Base64-encoded Change to sign (without author_sig.signature). */
	changeB64: string;
	/** Per-pubkey monotonic nonce. Caller must obtain from /consensus. */
	nonce: number;
	/** Fee in micro-units. Caller decides. */
	fee: number;
}

interface SignChangeResult {
	/** Base64-encoded fully-formed signed Change with id and signature filled in. */
	changeB64: string;
	/** Hex-encoded change id (for caller logging). */
	id: string;
	/** Hex-encoded signer pubkey (for caller logging). */
	pubkey: string;
}

function doSignChange(input: SignChangeInput, path?: string): SignChangeResult {
	const file = readWalletFile(path);
	const entry = file.keys[input.name];
	if (!entry) throw new Error(`wallet.sign: no key named "${input.name}"`);
	if (typeof input.nonce !== "number" || !Number.isInteger(input.nonce) || input.nonce < 1) {
		throw new Error("wallet.sign: nonce must be a positive integer");
	}
	if (typeof input.fee !== "number" || !Number.isInteger(input.fee) || input.fee < 0) {
		throw new Error("wallet.sign: fee must be a non-negative integer");
	}

	// Decode the unsigned change.
	const change = decodeChange(new Uint8Array(Buffer.from(input.changeB64, "base64")));

	// Build the signature stub (pubkey, zeroed sig bytes, nonce, fee).
	const sigStub: Signature = {
		pubkey: hexDecode(entry.pubkey),
		signature: new Uint8Array(64),
		nonce: input.nonce,
		fee: input.fee,
	};
	const candidate: Change = { ...change, authorSig: sigStub };

	// Compute the bytes the signer commits to: canonical(change with id zeroed and sig zeroed).
	const signingBytes = canonicalEncodeChangeForSigning(candidate);
	const signature = ed25519Sign(hexDecode(entry.privateKey), signingBytes);

	// Insert signature, then compute the content-address.
	candidate.authorSig = { ...sigStub, signature };
	candidate.id = sha256(canonicalEncodeChange(candidate));

	const encoded = encodeChange(candidate);
	return {
		changeB64: Buffer.from(encoded).toString("base64"),
		id: hexEncode(candidate.id),
		pubkey: entry.pubkey,
	};
}

// ── CLI ──────────────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;

	switch (cmd) {
		case "new": {
			const name = args[0];
			if (!name) { print(red("Usage: wallet new <name>")); break; }
			try {
				// CLI uses real wall-clock for createdAt; tests use the action with explicit time.
				const r = doNew(name, Date.now());
				print(green("Wallet key created"));
				print(dim(`  name:   `) + bold(r.name));
				print(dim(`  pubkey: `) + r.pubkey);
				print(dim(`  Stored in ${walletFilePath()} (mode 0600)`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "list": {
			const keys = doList();
			if (keys.length === 0) {
				print(dim("  No wallet keys. Run `/wallet new <name>` to generate one."));
			} else {
				for (const k of keys) {
					const created = new Date(k.createdAt).toISOString();
					print(`  ${bold(k.name)}  ${dim(k.pubkey)}  ${dim(created)}`);
				}
			}
			break;
		}

		case "show": {
			const name = args[0];
			if (!name) { print(red("Usage: wallet show <name>")); break; }
			const k = doShow(name);
			if (!k) { print(red(`Key not found: ${name}`)); break; }
			print(bold(`  ${k.name}`));
			print(dim(`  pubkey:  `) + k.pubkey);
			print(dim(`  created: `) + new Date(k.createdAt).toISOString());
			break;
		}

		case "remove": {
			const name = args[0];
			if (!name) { print(red("Usage: wallet remove <name>")); break; }
			const ok = doRemove(name);
			print(ok ? green(`Removed key "${name}"`) : red(`Key not found: ${name}`));
			break;
		}

		default: {
			print([
				bold("  Wallet") + dim(" — Ed25519 keys (local-only, never synced)"),
				`    ${cyan("wallet new")} ${dim("<name>")}        generate a fresh keypair`,
				`    ${cyan("wallet list")}                  list keys (no private material shown)`,
				`    ${cyan("wallet show")} ${dim("<name>")}       show one key's pubkey + creation time`,
				`    ${cyan("wallet remove")} ${dim("<name>")}     forget a key (no key recovery — back up first)`,
				dim(`  Signing happens via the actor API; /coin uses it to construct signed Changes.`),
				dim(`  Storage: ${walletFilePath()} (mode 0600).`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ──────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		/** Generate a key. Returns { name, pubkey, createdAt }. */
		new: async (_ctx: ProgramContext, name: string, opts?: { now?: number; path?: string }) => {
			return doNew(name, opts?.now ?? Date.now(), opts?.path);
		},
		/** List all keys. Returns Array<{ name, pubkey, createdAt }>. */
		list: async (_ctx: ProgramContext, opts?: { path?: string }) => {
			return doList(opts?.path);
		},
		/** Inspect one key. Returns null if not found. Private key is NEVER exposed. */
		show: async (_ctx: ProgramContext, name: string, opts?: { path?: string }) => {
			return doShow(name, opts?.path);
		},
		/** Reverse lookup by pubkey hex. */
		keyForPubkey: async (_ctx: ProgramContext, pubkeyHex: string, opts?: { path?: string }) => {
			return doKeyForPubkey(pubkeyHex, opts?.path);
		},
		/** Forget a key. Returns true on success. */
		remove: async (_ctx: ProgramContext, name: string, opts?: { path?: string }) => {
			return doRemove(name, opts?.path);
		},
		/** Sign an unsigned Change. Returns { changeB64, id, pubkey }. */
		signChange: async (_ctx: ProgramContext, input: SignChangeInput, opts?: { path?: string }) => {
			return doSignChange(input, opts?.path);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	doNew,
	doList,
	doShow,
	doRemove,
	doKeyForPubkey,
	doSignChange,
	readWalletFile,
	writeWalletFile,
	walletFilePath,
};
