/**
 * Determinism lint — scans consensus-critical paths for banned APIs.
 *
 * Glon doesn't have a project-wide linter today. Adding one is overkill
 * for v1; we just need to enforce a small set of rules on a few files.
 * This test does the enforcement directly: read the source of every
 * file in `CONSENSUS_PATHS` and assert no banned pattern appears.
 *
 * Banned in consensus paths:
 *   - `Date.now`           — local clock; produces drift between nodes
 *   - `Math.random`        — non-deterministic
 *   - `Math.floor`/`ceil`/`round` — fine on integers, but easy to misuse
 *                                    on floats; banned to keep the rule
 *                                    auditable. Use BigInt math instead.
 *   - `parseInt`/`parseFloat`        — silently accept hex/octal/whitespace.
 *                                       Use parseUint from src/det/math.ts.
 *   - `Number(`                       — coerces strings via JS casts,
 *                                       lossy above 2^53. Use toBigInt.
 *   - `JSON.stringify` for hashed bytes — JS object key order is
 *                                          insertion-order, NOT sorted.
 *                                          Use canonicalEncodeChange.
 *   - `Math.max`/`Math.min`           — fine on Numbers, but consensus
 *                                       values are BigInt. Banned to
 *                                       prevent accidental mixing.
 *
 * The point isn't aesthetics; it's that determinism reviews are easier
 * when banned APIs literally do not appear. If you need one in a chain
 * file, audit it explicitly with a `// det-lint-ignore: <reason>`
 * suppression comment.
 *
 * Run: npx tsx --test test/chain/det-lint.test.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Files under det-lint enforcement ────────────────────────────

/**
 * Every file listed here MUST be free of banned APIs unless explicitly
 * suppressed inline. New consensus code added in later phases should be
 * appended here.
 */
const CONSENSUS_PATHS = [
	"src/det/canonical.ts",
	"src/det/math.ts",
	"src/det/index.ts",
];

// ── Banned patterns ─────────────────────────────────────────────

interface Rule {
	name: string;
	pattern: RegExp;
	rationale: string;
}

const RULES: Rule[] = [
	{ name: "Date.now",       pattern: /\bDate\.now\b/,          rationale: "local clock — caller passes timestamps as data" },
	{ name: "Math.random",    pattern: /\bMath\.random\b/,       rationale: "non-deterministic" },
	{ name: "Math.floor",     pattern: /\bMath\.floor\b/,        rationale: "use BigInt division" },
	{ name: "Math.ceil",      pattern: /\bMath\.ceil\b/,         rationale: "use BigInt arithmetic" },
	{ name: "Math.round",     pattern: /\bMath\.round\b/,        rationale: "use BigInt arithmetic" },
	{ name: "Math.max",       pattern: /\bMath\.max\b/,          rationale: "Number-typed; consensus uses BigInt" },
	{ name: "Math.min",       pattern: /\bMath\.min\b/,          rationale: "Number-typed; consensus uses BigInt" },
	{ name: "parseInt",       pattern: /\bparseInt\(/,           rationale: "accepts hex/octal/whitespace; use parseUint from det/math" },
	{ name: "parseFloat",     pattern: /\bparseFloat\(/,         rationale: "floating point in consensus is banned outright" },
	{ name: "Number(",        pattern: /\bNumber\(/,             rationale: "lossy above 2^53; use toBigInt from det/math" },
	{ name: "JSON.stringify", pattern: /\bJSON\.stringify\(/,    rationale: "key order is implementation-defined; use canonical encoder" },
];

const SUPPRESSION = /det-lint-ignore:/;

// ── Scanner ─────────────────────────────────────────────────────

interface Finding {
	file: string;
	line: number;
	rule: string;
	rationale: string;
	excerpt: string;
}

function scanFile(file: string, contents: string): Finding[] {
	const lines = contents.split(/\r?\n/);
	const findings: Finding[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Skip comment-only lines (purely // or *) so docstrings about
		// "Date.now is banned" don't flag themselves.
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
			continue;
		}
		if (SUPPRESSION.test(line)) continue;
		for (const rule of RULES) {
			if (rule.pattern.test(line)) {
				findings.push({
					file,
					line: i + 1,
					rule: rule.name,
					rationale: rule.rationale,
					excerpt: line.trim(),
				});
			}
		}
	}
	return findings;
}

function repoRoot(): string {
	// This test lives at <repo>/test/chain/det-lint.test.ts; walk two up.
	return path.resolve(import.meta.dirname ?? ".", "..", "..");
}

// ── Tests ───────────────────────────────────────────────────────

describe("det-lint", () => {
	it("every file under CONSENSUS_PATHS exists and is readable", () => {
		const root = repoRoot();
		for (const rel of CONSENSUS_PATHS) {
			const abs = path.join(root, rel);
			assert.ok(fs.existsSync(abs), `expected ${rel} to exist`);
			fs.accessSync(abs, fs.constants.R_OK);
		}
	});

	it("CONSENSUS_PATHS contains no banned APIs", () => {
		const root = repoRoot();
		const allFindings: Finding[] = [];
		for (const rel of CONSENSUS_PATHS) {
			const abs = path.join(root, rel);
			const contents = fs.readFileSync(abs, "utf-8");
			allFindings.push(...scanFile(rel, contents));
		}
		if (allFindings.length > 0) {
			const lines = allFindings.map(
				(f) => `  ${f.file}:${f.line}  [${f.rule}]  ${f.excerpt}\n     → ${f.rationale}`,
			);
			throw new Error(
				`det-lint: ${allFindings.length} banned-API use(s) in consensus paths:\n` + lines.join("\n"),
			);
		}
	});

	it("the scanner detects banned APIs in a synthetic input", () => {
		// Sanity-check the scanner itself: hand it source that should fail.
		const synthetic = [
			"const t = Date.now();",
			"const r = Math.random();",
			"const x = parseInt(\"42\", 10);",
			"const y = Number(\"100\");",
			"const z = JSON.stringify({a:1});",
		].join("\n");
		const findings = scanFile("synthetic.ts", synthetic);
		// Expect 5 findings — one per line.
		assert.equal(findings.length, 5);
		const ruleNames = findings.map((f) => f.rule).sort();
		assert.deepEqual(
			ruleNames,
			["Date.now", "JSON.stringify", "Math.random", "Number(", "parseInt"].sort(),
		);
	});

	it("the scanner respects the // det-lint-ignore suppression comment", () => {
		const synthetic = "const t = Date.now(); // det-lint-ignore: explicit timestamp source";
		const findings = scanFile("synthetic.ts", synthetic);
		assert.equal(findings.length, 0);
	});

	it("the scanner ignores comment-only lines that mention banned APIs", () => {
		const synthetic = [
			"// We banned Date.now from this path",
			"/* Date.now is forbidden here */",
			" * Math.random must not appear",
		].join("\n");
		const findings = scanFile("synthetic.ts", synthetic);
		assert.equal(findings.length, 0);
	});
});
