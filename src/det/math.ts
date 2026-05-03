/**
 * Deterministic math helpers for chain-mode code.
 *
 * Consensus-relevant arithmetic MUST use BigInt — `Number` rounds at
 * 2^53, which is well below the magnitudes a token supply or accumulated
 * fees can reach (a token with 18 decimals and 10M supply has 10^25 raw
 * units = 2^83). Silent truncation produces a hash divergence between
 * nodes the moment any value crosses the safe-integer boundary.
 *
 * This module provides BigInt-only helpers for parsing, serialization,
 * and bounded arithmetic. The det-lint test scans consensus paths for
 * banned APIs (`Number(`, `Math.*`, `parseInt`, `parseFloat`) and points
 * authors at these helpers.
 */

// ── Limits ───────────────────────────────────────────────────────

/** Largest unsigned integer representable in protobuf's uint128 family. */
export const U128_MAX: bigint = (1n << 128n) - 1n;

/** Largest unsigned integer for fees (proto field is uint64). */
export const U64_MAX: bigint = (1n << 64n) - 1n;

/** Zero — useful for renounced ownership and starting balances. */
export const BIG_ZERO: bigint = 0n;

// ── Parsing ──────────────────────────────────────────────────────

/**
 * Parse a decimal string into a BigInt. Throws on negative, on non-digit
 * characters, on empty input, and on overflow against an optional max.
 *
 * Why not `BigInt(s)`? It accepts hex/octal prefixes and silently coerces
 * trailing whitespace. Consensus parsers must reject anything ambiguous.
 */
export function parseUint(s: string, max: bigint = U128_MAX): bigint {
	if (typeof s !== "string" || s.length === 0) {
		throw new Error("parseUint: input must be a non-empty string");
	}
	if (!/^[0-9]+$/.test(s)) {
		throw new Error(`parseUint: not a decimal-digit string: ${JSON.stringify(s)}`); // det-lint-ignore: error message only, never hashed
	}
	const n = BigInt(s);
	if (n > max) {
		throw new Error(`parseUint: ${s} exceeds max ${max.toString()}`);
	}
	return n;
}

/**
 * Coerce a value (string, number, or BigInt) into a BigInt. Numbers are
 * checked for safe-integer range; values outside [0, MAX_SAFE_INTEGER]
 * are rejected. Strings are parsed via `parseUint`.
 */
export function toBigInt(v: unknown, max: bigint = U128_MAX): bigint {
	if (typeof v === "bigint") {
		if (v < 0n) throw new Error("toBigInt: negative value");
		if (v > max) throw new Error(`toBigInt: ${v.toString()} exceeds max ${max.toString()}`);
		return v;
	}
	if (typeof v === "string") {
		return parseUint(v, max);
	}
	if (typeof v === "number") {
		// Only safe integers are coercible without precision loss.
		if (!Number.isInteger(v)) {
			throw new Error(`toBigInt: not an integer: ${v}`);
		}
		if (v < 0) throw new Error(`toBigInt: negative number: ${v}`);
		if (v > Number.MAX_SAFE_INTEGER) {
			throw new Error(`toBigInt: ${v} above MAX_SAFE_INTEGER; pass a string instead`);
		}
		const n = BigInt(v);
		if (n > max) throw new Error(`toBigInt: ${n.toString()} exceeds max ${max.toString()}`);
		return n;
	}
	throw new Error(`toBigInt: cannot coerce ${typeof v}`);
}

// ── Bounded arithmetic ──────────────────────────────────────────

/**
 * Add two BigInts and assert the sum doesn't overflow `max`. Use this for
 * total_supply mints, balance adds, etc. Native BigInt cannot overflow
 * (it grows unbounded), but token operations have a logical bound.
 */
export function addBounded(a: bigint, b: bigint, max: bigint = U128_MAX): bigint {
	const s = a + b;
	if (s > max) throw new Error(`addBounded: ${s.toString()} exceeds max ${max.toString()}`);
	if (s < a || s < b) throw new Error("addBounded: arithmetic invariant violated");
	return s;
}

/**
 * Subtract two BigInts and assert the result is non-negative. Use this for
 * balance debits, allowance decrements, total_supply burns. Returns the
 * difference; throws on underflow (insufficient balance / allowance).
 */
export function subChecked(a: bigint, b: bigint): bigint {
	if (b > a) throw new Error(`subChecked: underflow ${a.toString()} - ${b.toString()}`);
	return a - b;
}

// ── Serialization ────────────────────────────────────────────────

/**
 * Serialize a BigInt for storage in a string-typed field (e.g. a
 * Glon string Value, or a JSON-encoded operation). Always decimal,
 * never scientific. Round-trips exactly with `parseUint`.
 */
export function bigToString(n: bigint): string {
	if (n < 0n) throw new Error("bigToString: negative");
	return n.toString(10);
}

/**
 * Compare two BigInts. Returns -1, 0, or 1 (suitable for `Array.sort`).
 * Avoids accidental coercion to `Number`.
 */
export function bigCompare(a: bigint, b: bigint): -1 | 0 | 1 {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
