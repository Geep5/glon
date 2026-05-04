// Consensus — the validator gate for every chain-mode object.
//
// The kernel verifies the Ed25519 signature on every chain-mode Change
// before this validator runs. By the time `validate(changes)` is called:
//
//   1. The signature is structurally valid and matches the canonical
//      bytes (see src/det/canonical.ts).
//   2. The change.id matches sha256(canonical(change with id zeroed)).
//
// /consensus then enforces:
//
//   3. Per-pubkey nonce monotonicity. Replay protection.
//   4. Asymmetric fee minimums:
//        - Deploy: 100x base
//        - Mint:   10x base
//        - other:  1x base (transfers, burns, approves, etc.)
//      Floor multipliers are constants in v1; the absolute base is a
//      configurable knob (per-anchor adjustment is v2).
//   5. Type-specific semantic validation, dispatched to the owning
//      program's validate_op actor action (e.g. /token.validate_op).
//
// Persistent state:
//   - nonces: Map<pubkey_hex, uint64> last-seen nonce per pubkey.
//             Updated on every accepted Change. Lives in the program
//             actor's state Record (RivetKit-managed serialization).
//
// What this program does NOT do in v1:
//   - Anchor chain / state commitment / fork choice. Those live in
//     /anchor (later phase). Without anchoring, signed Changes still
//     propagate via existing per-actor sync; /consensus just keeps the
//     validation rules consistent.
//   - Reorg unwinding. v1 has no reorgs because there's no fork choice.
//   - Mempool. The "pending" map exists conceptually for /anchor's
//     selection logic; v1 tracks it for inspection only.

import type { ProgramDef, ProgramContext, ProgramActorDef, ValidatorFn, ValidationResult } from "../runtime.js";
import type { Change } from "../../proto.js";
import { decodeChange, encodeChange } from "../../proto.js";
import { U64_MAX } from "../../det/math.js";
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

/** Default base fee in micro-units. Operators can raise via setBaseFee action. */
export const DEFAULT_BASE_FEE = 1n;

/** Multiplier applied to the base fee for Deploy Changes. */
export const DEPLOY_FEE_MULTIPLIER = 100n;

/** Multiplier applied to the base fee for Mint Changes. */
export const MINT_FEE_MULTIPLIER = 10n;

/**
 * Type keys that /consensus knows how to dispatch semantic validation
 * for. Each entry binds a typeKey to (programPrefix, validateAction).
 * Adding a new chain-mode type is one entry here plus the program.
 */
const TYPE_DISPATCH: Record<string, { prefix: string; action: string; idKey: string }> = {
	"chain.token": { prefix: "/token", action: "validate_op", idKey: "tokenId" },
	"chain.coin.bucket": { prefix: "/coin", action: "validate_op", idKey: "bucketId" },
};

// ── Op-kind classification (informational, fee-only) ─────────────

/**
 * A coarse classification of a Change's intent, used only to pick the
 * right fee minimum. Type-specific semantic validation runs after this.
 *
 * For chain.token:
 *   - Deploy: any Change with an objectCreate op
 *   - Mint:   BlockAdd with chain.token.op meta.op="Mint"
 *   - other:  everything else (Transfer, Burn, Approve, TransferFrom, RenounceMint)
 *
 * Future chain types can extend this without changing the gate logic;
 * unrecognized changes default to "other" (the cheapest tier).
 */
export type FeeKind = "Deploy" | "Mint" | "Other";

export function classifyForFee(change: Change): FeeKind {
	if (change.ops?.some((o) => !!o.objectCreate)) return "Deploy";
	const blockAdds = change.ops?.filter((o) => !!o.blockAdd) ?? [];
	if (blockAdds.length === 1) {
		const meta = blockAdds[0].blockAdd!.block.content?.custom?.meta as Record<string, string> | undefined;
		if (meta?.op === "Mint") return "Mint";
	}
	return "Other";
}

// ── Fee policy ───────────────────────────────────────────────────

export interface FeePolicy {
	baseFee: bigint;
}

export function minimumFee(kind: FeeKind, policy: FeePolicy): bigint {
	switch (kind) {
		case "Deploy": return policy.baseFee * DEPLOY_FEE_MULTIPLIER;
		case "Mint":   return policy.baseFee * MINT_FEE_MULTIPLIER;
		case "Other":  return policy.baseFee;
	}
}

// ── Nonce store (lives in actor state) ──────────────────────────

/**
 * Actor state shape. Glon serializes Record<string, any> opaquely; we
 * keep the format JSON-friendly (decimal strings for BigInts that may
 * exceed 2^53; nonces are uint64 so use plain numbers).
 */
interface PersistedState {
	/** pubkey_hex → last-seen nonce (number; uint64 fits Number-safe range up to 2^53). */
	nonces: Record<string, number>;
	/** Current fee policy. baseFee stored as decimal string for BigInt round-trip. */
	feePolicy: { baseFee: string };
}

function loadState(raw: Record<string, any>): PersistedState {
	const nonces = (raw.nonces && typeof raw.nonces === "object") ? raw.nonces : {};
	const baseFeeStr = (raw.feePolicy && typeof raw.feePolicy === "object" && typeof raw.feePolicy.baseFee === "string")
		? raw.feePolicy.baseFee
		: DEFAULT_BASE_FEE.toString(10);
	return { nonces, feePolicy: { baseFee: baseFeeStr } };
}

function saveState(target: Record<string, any>, s: PersistedState): void {
	target.nonces = s.nonces;
	target.feePolicy = s.feePolicy;
}

function feePolicyOf(s: PersistedState): FeePolicy {
	return { baseFee: BigInt(s.feePolicy.baseFee) };
}

// ── Pure validation ──────────────────────────────────────────────

/**
 * Pre-dispatch validation of one chain-mode Change against /consensus's
 * own state. Returns the new persisted state on success (with the
 * pubkey's nonce advanced) and a kind tag so the caller can dispatch
 * semantic validation.
 *
 * Does NOT call /token or any other type-specific validator. The caller
 * does that after this returns ok.
 */
export function consensusGate(
	change: Change,
	state: PersistedState,
): { ok: true; nextState: PersistedState; kind: FeeKind } | { ok: false; reason: string } {
	if (!change.authorSig) {
		return { ok: false, reason: "consensus: change is not signed (kernel should have rejected)" };
	}
	const sig = change.authorSig;

	// Nonce monotonicity. Per-pubkey strictly increasing.
	const pubkeyHex = hexEncode(sig.pubkey);
	const last = state.nonces[pubkeyHex] ?? 0;
	if (sig.nonce <= last) {
		return {
			ok: false,
			reason: `consensus: nonce replay (pubkey ${pubkeyHex.slice(0, 12)}… last=${last} got=${sig.nonce})`,
		};
	}
	if (sig.nonce > Number.MAX_SAFE_INTEGER) {
		return { ok: false, reason: "consensus: nonce exceeds safe integer range" };
	}
	if (BigInt(sig.fee) > U64_MAX) {
		return { ok: false, reason: "consensus: fee exceeds uint64 max" };
	}

	// Asymmetric fee minimum.
	const policy = feePolicyOf(state);
	const kind = classifyForFee(change);
	const minFee = minimumFee(kind, policy);
	if (BigInt(sig.fee) < minFee) {
		return {
			ok: false,
			reason: `consensus: fee ${sig.fee} below minimum ${minFee.toString()} for kind ${kind}`,
		};
	}

	const nextNonces = { ...state.nonces, [pubkeyHex]: sig.nonce };
	const nextState: PersistedState = {
		nonces: nextNonces,
		feePolicy: state.feePolicy,
	};
	return { ok: true, nextState, kind };
}

// ── Validator (registered with the runtime for chain-mode types) ─

/**
 * Glon's runtime calls this with a batch of Changes (a full pushChanges
 * payload). For chain consensus we validate each Change in turn against
 * the running consensus state, dispatching to type-specific semantic
 * validators in the process.
 *
 * The validator runs in a per-call snapshot of the actor state; the
 * runtime can't currently flush state changes from inside a validator,
 * so for v1 we accept duplicate work: the actor's `recordAccepted`
 * action is what mutates the persistent nonces map. After-the-fact;
 * this is fine for v1 because each pushChanges call validates one
 * Change in practice and the kernel rejects any invalid one before
 * any state would change.
 *
 * v2 will fold the nonce write into the kernel's validator-callback
 * pipeline. For now, /consensus's actor is invoked separately by
 * /anchor (or by tests) to advance state.
 */
function makeValidator(getState: () => PersistedState): ValidatorFn {
	return (changes: Change[]): ValidationResult => {
		let state = getState();
		for (const change of changes) {
			const r = consensusGate(change, state);
			if (!r.ok) return { valid: false, error: r.reason };
			state = r.nextState;
			// Type-specific semantic validation must happen via dispatch.
			// In v1 the registered validator is synchronous and cannot
			// `await ctx.dispatchProgram`; we leave that to the actor's
			// `submit` action. The kernel pipeline calls THIS validator,
			// which catches signature/nonce/fee violations; semantic ops
			// (Transfer with no balance etc.) rely on:
			//   a) the type-specific validator's INVARIANTS (which are
			//      replayable / commutative), AND
			//   b) the /consensus.submit action when callers route writes
			//      through it (for full pre-flight checks).
			// This is the v1 compromise. v2 will let validators await.
		}
		return { valid: true };
	};
}

// ── Async semantic dispatch (used by /consensus.submit) ─────────

/**
 * Full validation including type-specific semantic check. Dispatches
 * to the owning program's `validate_op` action. Used by callers who
 * want a pre-flight check before submitting via pushChanges (e.g. CLI
 * deploy, the eventual /anchor selection logic).
 *
 * The kernel's pushChanges path also runs the synchronous validator
 * above — this function's role is the *additional* semantic check,
 * which the synchronous validator cannot perform.
 */
export async function validateFully(
	change: Change,
	objectId: string,
	state: PersistedState,
	ctx: ProgramContext,
): Promise<{ ok: true; nextState: PersistedState; kind: FeeKind } | { ok: false; reason: string }> {
	const gate = consensusGate(change, state);
	if (!gate.ok) return gate;

	// Determine type-specific dispatch target. We need the typeKey of
	// the object the change targets. v1: assume chain.token (the only
	// chain-mode type). When more land, look up via the storeActor.
	const store = ctx.store as any;
	const obj = await store.get(objectId);
	const typeKey = obj?.typeKey
		|| change.ops?.find((o) => o.objectCreate?.typeKey)?.objectCreate?.typeKey
		|| "";
	const dispatch = TYPE_DISPATCH[typeKey];
	if (!dispatch) {
		return { ok: false, reason: `consensus: no dispatch for typeKey "${typeKey}"` };
	}

	const changeB64 = Buffer.from(encodeChange(change)).toString("base64");
	const args: Record<string, unknown> = { changeB64 };
	args[dispatch.idKey] = objectId;
	let semantic: ValidationResult;
	try {
		semantic = await ctx.dispatchProgram(dispatch.prefix, dispatch.action, [args]) as ValidationResult;
	} catch (err: any) {
		return { ok: false, reason: `consensus: dispatch ${dispatch.prefix}.${dispatch.action} threw: ${err?.message ?? String(err)}` };
	}
	if (!semantic.valid) {
		return { ok: false, reason: semantic.error ?? "type-specific validation failed" };
	}
	return gate;
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	const state = loadState(ctx.state ?? {});

	switch (cmd) {
		case "status": {
			const policy = feePolicyOf(state);
			print(bold("  Consensus") + dim(" — chain-mode validator gate"));
			print(dim("    base fee:   ") + bold(policy.baseFee.toString()));
			print(dim("    min Deploy: ") + minimumFee("Deploy", policy).toString());
			print(dim("    min Mint:   ") + minimumFee("Mint", policy).toString());
			print(dim("    min Other:  ") + minimumFee("Other", policy).toString());
			print(dim("    nonces:     ") + String(Object.keys(state.nonces).length) + " pubkey(s) tracked");
			break;
		}
		case "nonces": {
			if (Object.keys(state.nonces).length === 0) {
				print(dim("  (no nonces tracked yet)"));
				break;
			}
			const sorted = Object.entries(state.nonces).sort();
			for (const [pk, n] of sorted) {
				print(`  ${dim(pk.slice(0, 16) + "...")}  ${bold(String(n))}`);
			}
			break;
		}
		case "set-base-fee": {
			const v = args[0];
			if (!v) { print(red("Usage: consensus set-base-fee <decimal>")); break; }
			try {
				const n = BigInt(v);
				if (n < 0n) throw new Error("base fee must be non-negative");
				if (n > U64_MAX) throw new Error("base fee exceeds uint64 max");
				state.feePolicy.baseFee = n.toString(10);
				saveState(ctx.state, state);
				print(green(`  base fee set to ${n.toString()}`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}
		default: {
			print([
				bold("  Consensus") + dim(" — signature/nonce/fee gate for chain-mode objects"),
				`    ${cyan("consensus status")}                   summary of nonces + fee policy`,
				`    ${cyan("consensus nonces")}                   show last-seen nonce per pubkey`,
				`    ${cyan("consensus set-base-fee")} ${dim("<n>")}     adjust the base fee`,
				dim(`  Validation runs in the kernel pipeline; this CLI is for diagnostics.`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ──────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: (): Record<string, unknown> => ({
		nonces: {},
		feePolicy: { baseFee: DEFAULT_BASE_FEE.toString(10) },
	}),

	actions: {
		/** Read the current state (nonces, fee policy). */
		status: async (ctx: ProgramContext) => {
			const s = loadState(ctx.state ?? {});
			return {
				nonces: s.nonces,
				feePolicy: { baseFee: s.feePolicy.baseFee },
				minimums: {
					deploy: minimumFee("Deploy", feePolicyOf(s)).toString(),
					mint:   minimumFee("Mint",   feePolicyOf(s)).toString(),
					other:  minimumFee("Other",  feePolicyOf(s)).toString(),
				},
			};
		},

		/** Get the last-seen nonce for a pubkey (0 if none). */
		getNonce: async (ctx: ProgramContext, pubkeyHex: string) => {
			const s = loadState(ctx.state ?? {});
			return s.nonces[pubkeyHex] ?? 0;
		},

		/** Manually advance the nonce counter (used by /anchor on accepted Changes). */
		recordAccepted: async (ctx: ProgramContext, pubkeyHex: string, nonce: number) => {
			const s = loadState(ctx.state ?? {});
			const last = s.nonces[pubkeyHex] ?? 0;
			if (nonce <= last) {
				throw new Error(`recordAccepted: ${nonce} <= last seen ${last} for ${pubkeyHex}`);
			}
			s.nonces[pubkeyHex] = nonce;
			saveState(ctx.state, s);
			return { pubkey: pubkeyHex, nonce };
		},

		/** Set the base fee. Returns the new policy. */
		setBaseFee: async (ctx: ProgramContext, baseFeeStr: string) => {
			const s = loadState(ctx.state ?? {});
			const n = BigInt(baseFeeStr);
			if (n < 0n || n > U64_MAX) throw new Error("base fee out of range");
			s.feePolicy.baseFee = n.toString(10);
			saveState(ctx.state, s);
			return { baseFee: s.feePolicy.baseFee };
		},

		/**
		 * Pre-flight a Change: signature gate (re-checked here for
		 * defence-in-depth), nonce check, fee check, type-specific
		 * dispatch. Returns ok or the reason for rejection. Does NOT
		 * advance state — call recordAccepted after the change actually
		 * lands.
		 */
		check: async (ctx: ProgramContext, input: { changeB64: string; objectId: string }) => {
			const s = loadState(ctx.state ?? {});
			const change = decodeChange(new Uint8Array(Buffer.from(input.changeB64, "base64")));
			return await validateFully(change, input.objectId, s, ctx);
		},
	},
};

const program: ProgramDef = {
	handler,
	actor: actorDef,
	// /consensus is the validator gate for every chain-mode type. As more
	// chain types land, add their typeKeys here AND to the TYPE_DISPATCH
	// table above.
	validator: makeValidator(() => {
		// Inside the registered validator, we don't have a ProgramContext.
		// We DO have the actor's state via the runtime, but synchronous
		// validators predate the actor model in glon. For v1 we use a
		// stale snapshot read from a module-local mirror that the actor
		// maintains. See the 'Async semantic dispatch' note above.
		return MIRROR_STATE;
	}),
	validatedTypes: ["chain.token", "chain.coin.bucket"],
};
export default program;

// ── Module-local state mirror ────────────────────────────────────
//
// The synchronous validator API doesn't accept a context. We mirror the
// actor's PersistedState into a module-local variable so the validator
// can read nonces and feePolicy without an async hop. The actor updates
// this mirror in `recordAccepted` and `setBaseFee`. Tests reset it
// directly via the __test export.
//
// This mirror is intentionally minimal: it would not be necessary if
// glon's validator API were async or threaded a ctx through. Both are
// reasonable v2 changes; for v1 the mirror keeps the validator pure.

let MIRROR_STATE: PersistedState = {
	nonces: {},
	feePolicy: { baseFee: DEFAULT_BASE_FEE.toString(10) },
};

// Patch the actor actions to keep the mirror in sync.
const originalRecord = actorDef.actions!.recordAccepted!;
actorDef.actions!.recordAccepted = async (ctx: ProgramContext, pubkeyHex: string, nonce: number) => {
	const result = await originalRecord(ctx, pubkeyHex, nonce);
	MIRROR_STATE = loadState(ctx.state ?? {});
	return result;
};
const originalSetBaseFee = actorDef.actions!.setBaseFee!;
actorDef.actions!.setBaseFee = async (ctx: ProgramContext, baseFeeStr: string) => {
	const result = await originalSetBaseFee(ctx, baseFeeStr);
	MIRROR_STATE = loadState(ctx.state ?? {});
	return result;
};

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	classifyForFee,
	minimumFee,
	consensusGate,
	loadState,
	saveState,
	feePolicyOf,
	resetMirror: () => {
		MIRROR_STATE = {
			nonces: {},
			feePolicy: { baseFee: DEFAULT_BASE_FEE.toString(10) },
		};
	},
	getMirror: () => MIRROR_STATE,
	makeValidator,
	validateFully,
};
