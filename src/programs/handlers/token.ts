// Token — fungible-token program over Glon's chain-mode object model.
//
// Each token is one Glon object with typeKey "chain.token". Static metadata
// (name, symbol, decimals, owner_pubkey, initial_supply, storage_credit)
// lives in the object's fields, set during the deploy genesis Change.
// Operations (Mint, Transfer, Approve, TransferFrom, Burn, RenounceMint)
// are appended as blocks with CustomContent contentType="chain.token.op".
//
// State (balances, total_supply, allowances) is COMPUTED by replaying the
// block tree in DAG order. It is never stored — same pattern as every
// other glon object. Two nodes replaying the same block list compute the
// same state.
//
// chainMode: true means every Change to a chain.token object MUST carry
// a valid Ed25519 author_sig. The kernel verifies the signature; this
// program's validator (registered for "chain.token") verifies semantics.
// The /consensus program (later phase) wraps this validator with nonce
// and fee enforcement.

import type { ProgramDef, ProgramContext, ProgramActorDef, ValidatorFn, ValidationResult } from "../runtime.js";
import type { Change, Block, Value } from "../../proto.js";
import type {} from "../../det/index.js";
import {
	parseUint,
	bigToString,
	addBounded,
	subChecked,
	U128_MAX,
	BIG_ZERO,
} from "../../det/math.js";
import { hexEncode } from "../../crypto.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }

// ── Constants ────────────────────────────────────────────────────

export const TYPE_KEY = "chain.token";
export const OP_CONTENT_TYPE = "chain.token.op";
export const MAX_DECIMALS = 30;

// ── Field name conventions ───────────────────────────────────────

const FIELD_NAME = "name";
const FIELD_SYMBOL = "symbol";
const FIELD_DECIMALS = "decimals";
const FIELD_OWNER = "owner_pubkey";        // hex string of 32-byte pubkey, or "" after renounce
const FIELD_INITIAL_SUPPLY = "initial_supply"; // decimal string
const FIELD_STORAGE_CREDIT = "storage_credit"; // decimal string; reserved for v2 rent, v1=0

// ── Op kinds ─────────────────────────────────────────────────────

export type TokenOpKind =
	| "Mint"
	| "Transfer"
	| "Approve"
	| "TransferFrom"
	| "Burn"
	| "RenounceMint";

const ALL_OP_KINDS: readonly TokenOpKind[] = [
	"Mint", "Transfer", "Approve", "TransferFrom", "Burn", "RenounceMint",
] as const;

export interface TokenOp {
	kind: TokenOpKind;
	/** Recipient pubkey hex for Mint/Transfer/TransferFrom. */
	to?: string;
	/** Token-holder pubkey hex for TransferFrom (the funds source). */
	from?: string;
	/** Spender pubkey hex for Approve. */
	spender?: string;
	/** Decimal-string amount for Mint/Transfer/Burn/Approve/TransferFrom. */
	amount?: string;
}

// ── Computed state ───────────────────────────────────────────────

export interface TokenState {
	name: string;
	symbol: string;
	decimals: number;
	ownerPubkey: string;          // empty after renounce
	balances: Map<string, bigint>;
	allowances: Map<string, Map<string, bigint>>; // owner → spender → amount
	totalSupply: bigint;
	storageCredit: bigint;
}

function zeroState(): TokenState {
	return {
		name: "",
		symbol: "",
		decimals: 0,
		ownerPubkey: "",
		balances: new Map(),
		allowances: new Map(),
		totalSupply: BIG_ZERO,
		storageCredit: BIG_ZERO,
	};
}

// ── Field extraction ─────────────────────────────────────────────

function extractStr(v: any): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return "";
}

function extractInt(v: any, fallback: number): number {
	if (v === null || v === undefined) return fallback;
	if (typeof v === "number") return v;
	if (v.intValue !== undefined) {
		const n = v.intValue;
		return typeof n === "number" ? n : Number(n) | 0;
	}
	return fallback;
}

// ── Op decoding ──────────────────────────────────────────────────

/** Decode a token op from a CustomContent block's meta map. */
export function decodeOp(meta: Record<string, string> | undefined): TokenOp | null {
	if (!meta || typeof meta !== "object") return null;
	const kind = meta.op as TokenOpKind | undefined;
	if (!kind || !ALL_OP_KINDS.includes(kind)) return null;
	const op: TokenOp = { kind };
	if (typeof meta.to === "string") op.to = meta.to;
	if (typeof meta.from === "string") op.from = meta.from;
	if (typeof meta.spender === "string") op.spender = meta.spender;
	if (typeof meta.amount === "string") op.amount = meta.amount;
	return op;
}

/**
 * Build the meta map for a TokenOp. Used by the CLI/wallet flow when
 * constructing a Change before signing.
 */
export function encodeOp(op: TokenOp): Record<string, string> {
	const out: Record<string, string> = { op: op.kind };
	if (op.to !== undefined) out.to = op.to;
	if (op.from !== undefined) out.from = op.from;
	if (op.spender !== undefined) out.spender = op.spender;
	if (op.amount !== undefined) out.amount = op.amount;
	return out;
}

// ── Change classification ────────────────────────────────────────

export type ChangeKind =
	| { kind: "Deploy" }
	| { kind: "Op"; op: TokenOp }
	| { kind: "Unknown"; reason: string };

/**
 * Classify a Change against the token domain. A Deploy carries
 * ObjectCreate + the static-metadata FieldSets. An Op carries exactly
 * one BlockAdd with our CustomContent kind. Anything else is rejected.
 */
export function classifyChange(change: Change): ChangeKind {
	const ops = change.ops ?? [];
	const hasObjectCreate = ops.some((o) => !!o.objectCreate);
	const blockAdds = ops.filter((o) => !!o.blockAdd);

	if (hasObjectCreate) {
		// Deploy genesis. Allow any number of FieldSet ops alongside.
		// Reject if there are also BlockAdds — a Deploy doesn't ship ops.
		if (blockAdds.length > 0) {
			return { kind: "Unknown", reason: "Deploy Change must not contain BlockAdd ops" };
		}
		return { kind: "Deploy" };
	}

	if (blockAdds.length === 0) {
		return { kind: "Unknown", reason: "Op Change must contain exactly one BlockAdd" };
	}
	if (blockAdds.length > 1) {
		return { kind: "Unknown", reason: "Op Change must contain at most one BlockAdd" };
	}
	const block = blockAdds[0].blockAdd!.block;
	const custom = block.content?.custom;
	if (!custom || custom.contentType !== OP_CONTENT_TYPE) {
		return { kind: "Unknown", reason: `Op block must use contentType=${OP_CONTENT_TYPE}` };
	}
	const op = decodeOp(custom.meta as Record<string, string>);
	if (!op) {
		return { kind: "Unknown", reason: "Op block meta is missing or malformed (op kind?)" };
	}
	// Reject mixed FieldSet/etc. ops — Op Changes are pure.
	const otherOps = ops.filter((o) => !o.blockAdd);
	if (otherOps.length > 0) {
		return { kind: "Unknown", reason: "Op Change must contain ONLY a BlockAdd op" };
	}
	return { kind: "Op", op };
}

// ── State replay ─────────────────────────────────────────────────

/** Build a TokenState from the object's fields and replayed block tree. */
export function replayState(
	fields: Record<string, any>,
	blocks: Block[],
): TokenState {
	const state = zeroState();
	state.name = extractStr(fields[FIELD_NAME]);
	state.symbol = extractStr(fields[FIELD_SYMBOL]);
	state.decimals = extractInt(fields[FIELD_DECIMALS], 0);
	state.ownerPubkey = extractStr(fields[FIELD_OWNER]);
	const initialSupplyStr = extractStr(fields[FIELD_INITIAL_SUPPLY]);
	if (initialSupplyStr) {
		state.totalSupply = parseUint(initialSupplyStr);
		// Initial supply is credited to the owner at deploy time.
		if (state.ownerPubkey) state.balances.set(state.ownerPubkey, state.totalSupply);
	}
	const storageCreditStr = extractStr(fields[FIELD_STORAGE_CREDIT]);
	if (storageCreditStr) {
		state.storageCredit = parseUint(storageCreditStr);
	}

	// Apply each op block in DAG order.
	for (const block of blocks) {
		const meta = block.content?.custom?.meta as Record<string, string> | undefined;
		const op = decodeOp(meta);
		if (!op) continue;
		applyOpToState(state, op, /* signer */ inferSignerFromBlock(block));
	}
	return state;
}

/**
 * Operation block provenance carries the signer pubkey via a meta entry
 * we set at construction time (`signer`). We trust this only because the
 * kernel signature gate has already verified that the block was authored
 * by this pubkey on the Change containing it.
 */
function inferSignerFromBlock(block: Block): string {
	const meta = block.content?.custom?.meta as Record<string, string> | undefined;
	return meta?.signer ?? "";
}

// ── Op application ───────────────────────────────────────────────

function getBalance(state: TokenState, pubkey: string): bigint {
	return state.balances.get(pubkey) ?? BIG_ZERO;
}

function setBalance(state: TokenState, pubkey: string, value: bigint): void {
	if (value === BIG_ZERO) state.balances.delete(pubkey);
	else state.balances.set(pubkey, value);
}

function getAllowance(state: TokenState, owner: string, spender: string): bigint {
	return state.allowances.get(owner)?.get(spender) ?? BIG_ZERO;
}

function setAllowance(state: TokenState, owner: string, spender: string, value: bigint): void {
	let m = state.allowances.get(owner);
	if (!m) {
		m = new Map();
		state.allowances.set(owner, m);
	}
	if (value === BIG_ZERO) m.delete(spender);
	else m.set(spender, value);
	if (m.size === 0) state.allowances.delete(owner);
}

/**
 * Apply one op to mutate `state` in place. Throws on invariant violation;
 * the validator runs this in a try/catch and converts thrown errors into
 * validator-level rejections. Callers MUST pre-verify the signer/auth.
 */
export function applyOpToState(state: TokenState, op: TokenOp, signer: string): void {
	switch (op.kind) {
		case "Mint": {
			if (!signer) throw new Error("Mint: signer pubkey missing");
			if (!state.ownerPubkey) throw new Error("Mint: ownership has been renounced");
			if (signer !== state.ownerPubkey) {
				throw new Error("Mint: only owner_pubkey can mint");
			}
			if (!op.to || !op.amount) throw new Error("Mint: to + amount required");
			const amount = parseUint(op.amount);
			if (amount === BIG_ZERO) throw new Error("Mint: amount must be > 0");
			state.totalSupply = addBounded(state.totalSupply, amount, U128_MAX);
			setBalance(state, op.to, addBounded(getBalance(state, op.to), amount, U128_MAX));
			return;
		}
		case "Transfer": {
			if (!signer) throw new Error("Transfer: signer pubkey missing");
			if (!op.to || !op.amount) throw new Error("Transfer: to + amount required");
			const amount = parseUint(op.amount);
			if (amount === BIG_ZERO) throw new Error("Transfer: amount must be > 0");
			const balance = getBalance(state, signer);
			setBalance(state, signer, subChecked(balance, amount));
			setBalance(state, op.to, addBounded(getBalance(state, op.to), amount, U128_MAX));
			return;
		}
		case "Approve": {
			if (!signer) throw new Error("Approve: signer pubkey missing");
			if (!op.spender || op.amount === undefined) {
				throw new Error("Approve: spender + amount required");
			}
			const amount = parseUint(op.amount);
			setAllowance(state, signer, op.spender, amount);
			return;
		}
		case "TransferFrom": {
			if (!signer) throw new Error("TransferFrom: signer pubkey missing");
			if (!op.from || !op.to || !op.amount) {
				throw new Error("TransferFrom: from + to + amount required");
			}
			const amount = parseUint(op.amount);
			if (amount === BIG_ZERO) throw new Error("TransferFrom: amount must be > 0");
			const allowance = getAllowance(state, op.from, signer);
			const newAllowance = subChecked(allowance, amount);
			const balance = getBalance(state, op.from);
			setBalance(state, op.from, subChecked(balance, amount));
			setBalance(state, op.to, addBounded(getBalance(state, op.to), amount, U128_MAX));
			setAllowance(state, op.from, signer, newAllowance);
			return;
		}
		case "Burn": {
			if (!signer) throw new Error("Burn: signer pubkey missing");
			if (!op.amount) throw new Error("Burn: amount required");
			const amount = parseUint(op.amount);
			if (amount === BIG_ZERO) throw new Error("Burn: amount must be > 0");
			const balance = getBalance(state, signer);
			setBalance(state, signer, subChecked(balance, amount));
			state.totalSupply = subChecked(state.totalSupply, amount);
			return;
		}
		case "RenounceMint": {
			if (!signer) throw new Error("RenounceMint: signer pubkey missing");
			if (!state.ownerPubkey) throw new Error("RenounceMint: already renounced");
			if (signer !== state.ownerPubkey) {
				throw new Error("RenounceMint: only current owner can renounce");
			}
			state.ownerPubkey = "";
			return;
		}
	}
}

// ── Validator ────────────────────────────────────────────────────

/**
 * Validate a Deploy Change in isolation: required fields are present,
 * decimals is in range, initial_supply parses, owner_pubkey is a 64-char
 * hex string (or empty for ownerless deploys, which can never mint).
 */
function validateDeploy(change: Change): ValidationResult {
	const ops = change.ops ?? [];
	const fields: Record<string, Value> = {};
	for (const op of ops) {
		if (op.fieldSet) fields[op.fieldSet.key] = op.fieldSet.value;
	}
	const required = [FIELD_NAME, FIELD_SYMBOL, FIELD_DECIMALS, FIELD_OWNER, FIELD_INITIAL_SUPPLY];
	for (const k of required) {
		if (!fields[k]) {
			return { valid: false, error: `token deploy: missing required field ${k}` };
		}
	}
	const name = extractStr(fields[FIELD_NAME]);
	const symbol = extractStr(fields[FIELD_SYMBOL]);
	if (!name) return { valid: false, error: "token deploy: name must be non-empty" };
	if (!symbol) return { valid: false, error: "token deploy: symbol must be non-empty" };
	const decimals = extractInt(fields[FIELD_DECIMALS], -1);
	if (decimals < 0 || decimals > MAX_DECIMALS) {
		return { valid: false, error: `token deploy: decimals must be in [0, ${MAX_DECIMALS}]` };
	}
	const owner = extractStr(fields[FIELD_OWNER]);
	if (owner && !/^[0-9a-f]{64}$/.test(owner)) {
		return { valid: false, error: "token deploy: owner_pubkey must be 64 hex chars (or empty)" };
	}
	const initialStr = extractStr(fields[FIELD_INITIAL_SUPPLY]);
	try {
		parseUint(initialStr);
	} catch (err: any) {
		return { valid: false, error: `token deploy: bad initial_supply: ${err.message}` };
	}
	// Deployer must be the owner_pubkey (so the deploy is self-attested).
	if (owner && change.authorSig) {
		const signer = hexEncode(change.authorSig.pubkey);
		if (signer !== owner) {
			return { valid: false, error: "token deploy: signer must equal owner_pubkey" };
		}
	}
	return { valid: true };
}

/**
 * Validate an Op Change against current state. State has already been
 * computed by the caller via `replayState` over the prior block list.
 */
function validateOp(state: TokenState, op: TokenOp, signer: string): ValidationResult {
	try {
		// applyOpToState throws on invariant violations. We run it on a clone
		// of the state so the caller's state object isn't mutated.
		const clone: TokenState = {
			...state,
			balances: new Map(state.balances),
			allowances: new Map(
				Array.from(state.allowances.entries()).map(([k, m]) => [k, new Map(m)]),
			),
		};
		applyOpToState(clone, op, signer);
		return { valid: true };
	} catch (err: any) {
		return { valid: false, error: `token op: ${err.message}` };
	}
}

/**
 * Top-level validator entry point. Used by /consensus when validating
 * incoming chain.token Changes; also exposed as the actor's `validate_op`
 * action so tests and the CLI can invoke it directly.
 *
 * Inputs:
 *   - change: the Change being validated (signature already verified by kernel)
 *   - priorFields: the object's fields BEFORE this Change (empty on Deploy)
 *   - priorBlocks: the object's blocks BEFORE this Change
 *
 * Returns: { valid: true } on success, { valid: false, error } otherwise.
 */
export function validateChange(
	change: Change,
	priorFields: Record<string, any>,
	priorBlocks: Block[],
): ValidationResult {
	if (!change.authorSig) {
		// The kernel should have already rejected this; defensive double-check.
		return { valid: false, error: "token: chain-mode change without signature" };
	}
	const signer = hexEncode(change.authorSig.pubkey);

	const classification = classifyChange(change);
	switch (classification.kind) {
		case "Deploy":
			// Deploy can only be the genesis Change (no prior state for this object).
			if (priorBlocks.length > 0 || Object.keys(priorFields).length > 0) {
				return { valid: false, error: "token: deploy must be the genesis change" };
			}
			return validateDeploy(change);
		case "Op": {
			if (priorBlocks.length === 0 && Object.keys(priorFields).length === 0) {
				return { valid: false, error: "token: op before deploy" };
			}
			const state = replayState(priorFields, priorBlocks);
			return validateOp(state, classification.op, signer);
		}
		case "Unknown":
			return { valid: false, error: `token: ${classification.reason}` };
	}
}

// ── Validator function for the runtime registry ──────────────────

/**
 * Adapter to the runtime's batch-validator signature. Glon validators run
 * over a batch of Changes (one full pushChanges payload). For chain-mode
 * tokens we expect one Change per push in v1, but support batches by
 * validating each in turn.
 *
 * Critical: the registered validator does NOT have access to the existing
 * object state, so it cannot replay prior blocks. It defers semantic
 * validation to the actor's `validate_op` action which is dispatched by
 * /consensus with current state. This validator simply checks Change
 * SHAPE (Deploy vs Op vs Unknown). The /consensus layer is the place
 * where state-dependent rules fire.
 */
export const validator: ValidatorFn = (changes: Change[]): ValidationResult => {
	for (const change of changes) {
		const c = classifyChange(change);
		if (c.kind === "Unknown") {
			return { valid: false, error: `token: ${c.reason}` };
		}
		if (c.kind === "Deploy") {
			const r = validateDeploy(change);
			if (!r.valid) return r;
		}
		// Op semantic validation defers to /consensus → /token.validate_op
		// which runs after this validator passes (kernel order).
	}
	return { valid: true };
};

// ── Change construction helpers (CLI and consumers) ─────────────

/**
 * Construct an unsigned Op Change. Caller signs via /wallet.signChange,
 * then submits via objectActor.pushChanges.
 *
 * The block carries a `signer` meta entry that records the signer's
 * pubkey hex. State replay reads this meta entry to know who authored
 * each op. We trust the meta entry only because the kernel signature
 * gate has already verified the Change was signed by that pubkey.
 */
export function buildOpChange(args: {
	tokenId: string;
	parentIds: Uint8Array[];
	timestamp: number;
	author: string;
	op: TokenOp;
	signerPubkeyHex: string;
	blockId: string;
}): Change {
	const meta = encodeOp(args.op);
	meta.signer = args.signerPubkeyHex;
	return {
		id: new Uint8Array(0),
		objectId: args.tokenId,
		parentIds: args.parentIds,
		ops: [{
			blockAdd: {
				parentId: "",
				afterId: "",
				block: {
					id: args.blockId,
					childrenIds: [],
					content: {
						custom: {
							contentType: OP_CONTENT_TYPE,
							data: new Uint8Array(0),
							meta,
						},
					},
				},
			},
		}],
		timestamp: args.timestamp,
		author: args.author,
	};
}

/**
 * Construct an unsigned Deploy Change. Caller signs and submits.
 * `tokenId` is generated externally (UUID); pass it in.
 */
export function buildDeployChange(args: {
	tokenId: string;
	timestamp: number;
	author: string;
	name: string;
	symbol: string;
	decimals: number;
	ownerPubkeyHex: string;
	initialSupply: bigint;
}): Change {
	return {
		id: new Uint8Array(0),
		objectId: args.tokenId,
		parentIds: [],
		ops: [
			{ objectCreate: { typeKey: TYPE_KEY } },
			{ fieldSet: { key: FIELD_NAME, value: { stringValue: args.name } } },
			{ fieldSet: { key: FIELD_SYMBOL, value: { stringValue: args.symbol } } },
			{ fieldSet: { key: FIELD_DECIMALS, value: { intValue: args.decimals } } },
			{ fieldSet: { key: FIELD_OWNER, value: { stringValue: args.ownerPubkeyHex } } },
			{ fieldSet: { key: FIELD_INITIAL_SUPPLY, value: { stringValue: bigToString(args.initialSupply) } } },
			{ fieldSet: { key: FIELD_STORAGE_CREDIT, value: { stringValue: "0" } } },
		],
		timestamp: args.timestamp,
		author: args.author,
	};
}

// ── Read-side helpers ────────────────────────────────────────────

async function loadTokenState(
	tokenId: string,
	ctx: ProgramContext,
): Promise<TokenState> {
	const store = ctx.store as any;
	const obj = await store.get(tokenId);
	if (!obj) throw new Error(`token: object ${tokenId} not found`);
	if (obj.typeKey !== TYPE_KEY) throw new Error(`token: ${tokenId} is not a chain.token`);
	if (obj.deleted) throw new Error(`token: ${tokenId} has been tombstoned`);
	return replayState(obj.fields ?? {}, obj.blocks ?? []);
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print, resolveId } = ctx;

	switch (cmd) {
		case "balance": {
			const raw = args[0];
			const pubkey = args[1];
			if (!raw || !pubkey) { print(red("Usage: token balance <token_id> <pubkey_hex>")); break; }
			try {
				const tokenId = (await resolveId(raw)) ?? raw;
				const state = await loadTokenState(tokenId, ctx);
				const balance = state.balances.get(pubkey) ?? BIG_ZERO;
				print(`  ${cyan(state.symbol || "?")}  ${bold(bigToString(balance))} ` +
					dim(`(decimals=${state.decimals})`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "info": {
			const raw = args[0];
			if (!raw) { print(red("Usage: token info <token_id>")); break; }
			try {
				const tokenId = (await resolveId(raw)) ?? raw;
				const state = await loadTokenState(tokenId, ctx);
				print(bold(`  ${state.name} (${state.symbol})`));
				print(dim(`    id:       `) + tokenId);
				print(dim(`    decimals: `) + String(state.decimals));
				print(dim(`    supply:   `) + bigToString(state.totalSupply));
				print(dim(`    holders:  `) + String(state.balances.size));
				print(dim(`    owner:    `) + (state.ownerPubkey || yellow("(renounced)")));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		case "holders": {
			const raw = args[0];
			if (!raw) { print(red("Usage: token holders <token_id>")); break; }
			try {
				const tokenId = (await resolveId(raw)) ?? raw;
				const state = await loadTokenState(tokenId, ctx);
				const sorted = Array.from(state.balances.entries()).sort((a, b) => {
					if (a[1] < b[1]) return 1;
					if (a[1] > b[1]) return -1;
					return 0;
				});
				if (sorted.length === 0) {
					print(dim("  (no holders)"));
				} else {
					for (const [pk, bal] of sorted) {
						print(`  ${dim(pk.slice(0, 16) + "...")}  ${bold(bigToString(bal))}`);
					}
				}
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Token") + dim(" — chain-mode fungible token (chain.token)"),
				`    ${cyan("token info")} ${dim("<token_id>")}            metadata + supply + owner`,
				`    ${cyan("token balance")} ${dim("<token_id> <pubkey>")} balance for one holder`,
				`    ${cyan("token holders")} ${dim("<token_id>")}          all balances, descending`,
				dim(`  Mint/transfer/etc happen via signed Changes; see the actor API.`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ─────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		/** Read full state (for tests and the CLI). */
		state: async (ctx: ProgramContext, tokenId: string) => {
			const s = await loadTokenState(tokenId, ctx);
			return {
				name: s.name,
				symbol: s.symbol,
				decimals: s.decimals,
				ownerPubkey: s.ownerPubkey,
				totalSupply: bigToString(s.totalSupply),
				balances: Object.fromEntries(
					Array.from(s.balances.entries()).map(([k, v]) => [k, bigToString(v)]),
				),
				allowances: Object.fromEntries(
					Array.from(s.allowances.entries()).map(([owner, m]) => [
						owner,
						Object.fromEntries(
							Array.from(m.entries()).map(([sp, v]) => [sp, bigToString(v)]),
						),
					]),
				),
			};
		},

		/** Read one balance. Returns "0" if no entry. */
		balanceOf: async (ctx: ProgramContext, tokenId: string, pubkeyHex: string) => {
			const s = await loadTokenState(tokenId, ctx);
			return bigToString(s.balances.get(pubkeyHex) ?? BIG_ZERO);
		},

		/**
		 * Validate a Change against the token's current state. Used by /consensus
		 * to perform the semantic check after signature/nonce/fee gating.
		 */
		validate_op: async (
			ctx: ProgramContext,
			input: { tokenId: string; changeB64: string },
		): Promise<ValidationResult> => {
			const store = ctx.store as any;
			const obj = await store.get(input.tokenId);
			const priorFields = obj?.fields ?? {};
			const priorBlocks = obj?.blocks ?? [];
			const { decodeChange } = await import("../../proto.js");
			const change = decodeChange(new Uint8Array(Buffer.from(input.changeB64, "base64")));
			return validateChange(change, priorFields, priorBlocks);
		},

		/** Build an unsigned Deploy Change. Caller signs + submits. */
		buildDeploy: async (
			_ctx: ProgramContext,
			args: {
				tokenId: string;
				timestamp: number;
				author: string;
				name: string;
				symbol: string;
				decimals: number;
				ownerPubkeyHex: string;
				initialSupply: string;
			},
		): Promise<{ changeB64: string }> => {
			const change = buildDeployChange({
				...args,
				initialSupply: parseUint(args.initialSupply),
			});
			const { encodeChange } = await import("../../proto.js");
			return { changeB64: Buffer.from(encodeChange(change)).toString("base64") };
		},

		/** Build an unsigned Op Change (Mint/Transfer/etc). Caller signs + submits. */
		buildOp: async (
			_ctx: ProgramContext,
			args: {
				tokenId: string;
				parentIds: string[];           // hex
				timestamp: number;
				author: string;
				op: TokenOp;
				signerPubkeyHex: string;
				blockId: string;
			},
		): Promise<{ changeB64: string }> => {
			const { encodeChange } = await import("../../proto.js");
			const { hexDecode } = await import("../../crypto.js");
			const change = buildOpChange({
				tokenId: args.tokenId,
				parentIds: args.parentIds.map(hexDecode),
				timestamp: args.timestamp,
				author: args.author,
				op: args.op,
				signerPubkeyHex: args.signerPubkeyHex,
				blockId: args.blockId,
			});
			return { changeB64: Buffer.from(encodeChange(change)).toString("base64") };
		},
	},
};

const program: ProgramDef = {
	handler,
	actor: actorDef,
	// Top-level validator is /consensus. /token exposes its semantic
	// rules through the `validate_op` actor action, which /consensus
	// dispatches to after running its signature/nonce/fee checks.
	validatedTypes: [TYPE_KEY],
	chainMode: true,
};
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	classifyChange,
	decodeOp,
	encodeOp,
	replayState,
	validateChange,
	validateDeploy,
	applyOpToState,
	buildDeployChange,
	buildOpChange,
	zeroState,
};
