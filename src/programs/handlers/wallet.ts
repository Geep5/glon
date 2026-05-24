// Wallet — local-only Ed25519 key management for transport-level signing.
//
// Mirrors the storage pattern of /auth: keys live in a flat JSON file
// under GLON_DATA, mode 0600, written atomically via .tmp + rename. Keys
// NEVER touch the DAG. The wallet is a local utility, like a private
// keychain. Other programs (e.g. /peer-chat) request a signature on an
// arbitrary byte string via the `sign` action.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
	import { generateKeyPair, sign as ed25519Sign } from "../../det/ed25519.js";
	import { hexEncode, hexDecode } from "../../crypto.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dim, bold, cyan, red, green } from "../shared.js";

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
				dim(`  Programs sign arbitrary bytes via the actor API (action: sign).`),
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

		/** Sign an arbitrary message (base64). Returns { signature: hex, pubkey: hex }. */
		sign: async (_ctx: ProgramContext, name: string, messageB64: string, opts?: { path?: string }) => {
			const file = readWalletFile(opts?.path);
			const entry = file.keys[name];
			if (!entry) throw new Error(`wallet.sign: no key named "${name}"`);
			const msg = new Uint8Array(Buffer.from(messageB64, "base64"));
			const signature = ed25519Sign(hexDecode(entry.privateKey), msg);
			return { signature: hexEncode(signature), pubkey: entry.pubkey };
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
	readWalletFile,
	writeWalletFile,
	walletFilePath,
};
