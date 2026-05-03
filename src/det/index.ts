/**
 * Determinism module — safe-only primitives for chain-mode code.
 *
 * Chain consensus requires byte-identical state on every node from the
 * same input DAG. JS/TS makes this nontrivial:
 *
 *   - protobufjs map<> ordering is implementation-defined → use
 *     `canonicalEncodeChange` from `./canonical`.
 *   - `Number` truncates above 2^53, ruining token math →
 *     use BigInt helpers from `./math`.
 *   - `Date.now()`, `Math.random()`, `Math.floor()` on non-integers
 *     produce drift between nodes → consensus paths import nothing
 *     from those globals (enforced by `test/chain/det-lint.test.ts`).
 *   - `Object.keys` iteration order is insertion-order for string keys
 *     (deterministic per ES2015), but only if you control insertion →
 *     `sortKeyed` (used internally by canonical encode) makes order
 *     explicit at every map boundary.
 *
 * Consensus-critical files import only from `./det/`. The lint test
 * verifies it.
 */

export {
	canonicalEncodeChange,
	canonicalEncodeChangeForSigning,
} from "./canonical.js";

export {
	U128_MAX,
	U64_MAX,
	BIG_ZERO,
	parseUint,
	toBigInt,
	addBounded,
	subChecked,
	bigToString,
	bigCompare,
} from "./math.js";
