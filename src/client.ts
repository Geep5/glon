/**
 * Glon CLI shell — pure program loader.
 *
 * The shell has ZERO built-in commands. Everything is a program loaded
 * from the store, even /help. Programs are Glon objects that can be
 * created, modified, synced, and versioned like any other object.
 *
 * Usage: npm run client / npx tsx src/client.ts
 */

import "./env.js"; // side-effect: load .env into process.env
import { createClient } from "rivetkit/client";
import type { app } from "./index.js";
import { createInterface } from "node:readline";
import { diskStats, readChangeByHex, listChangeFiles } from "./disk.js";
import { hexEncode } from "./crypto.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "./proto.js";
import { loadPrograms, dispatchProgram, startProgramActor, dispatchActorAction, getProgramActorByPrefix, type ProgramContext, type ProgramEntry } from "./programs/runtime.js";
import { randomUUID } from "node:crypto";

import { style, dim, bold, cyan, red, green } from "./programs/shared.js";
import { resolveEndpoint } from "./endpoint.js";

const ENDPOINT = resolveEndpoint();


// ── Client setup ─────────────────────────────────────────────────
const client = createClient<typeof app>(ENDPOINT);
const store = client.storeActor.getOrCreate(["root"]);

/** Resolve an id prefix to a full id. Returns null if not found/ambiguous. */
async function resolveId(raw: string): Promise<string | null> {
	if (!raw) return null;
	const exact = await store.exists(raw);
	if (exact) return raw;
	const resolved = await store.resolvePrefix(raw);
	if (resolved) return resolved;
	return null;
}

// ── Program runtime ──────────────────────────────────────────────
let programs: ProgramEntry[] = [];

function buildContext(overrides?: Partial<ProgramContext>): ProgramContext {
	return {
		client,
		store,
		resolveId,
		stringVal,
		intVal,
		floatVal,
		boolVal,
		mapVal,
		listVal,
		linkVal,
		displayValue,
		listChangeFiles,
		readChangeByHex,
		hexEncode,
		print: (msg: string) => console.log(msg),

		style,
		randomUUID,
		// v2 defaults (overridden by program actors)
		state: {},
		emit: () => {},
		programId: "",
		objectActor: (id: string, opts?: { createWithInput?: unknown }) => client.objectActor.getOrCreate([id], opts),
		dispatchProgram: async (prefix: string, action: string, args: unknown[]) => {
			const inst = getProgramActorByPrefix(prefix);
			if (!inst) throw new Error(`Program not running: ${prefix}`);
			return await dispatchActorAction(
				inst.programId,
				action,
				args,
				(state) => buildContext({ state, programId: inst.programId }),
			);
		},
		dispatchTypedAction: async (prefix: string, action: string, input: unknown) => {
			const inst = getProgramActorByPrefix(prefix);
			if (!inst) throw new Error(`Program not running: ${prefix}`);
			return await dispatchActorAction(
				inst.programId,
				action,
				[input],
				(state) => buildContext({ state, programId: inst.programId }),
			);
		},
		...overrides,
	};
}


// ── Main REPL ────────────────────────────────────────────────────
async function main() {
	console.log(dim("Glon — connecting to " + ENDPOINT));

	// Load programs from store
	try {
		const ctx = buildContext();
		programs = await loadPrograms(store, client);
		if (programs.length > 0) {
			console.log(green(`Loaded ${programs.length} programs.`));

			// Start program actors
			for (const prog of programs) {
				try {
					await startProgramActor(prog, (state) => buildContext({ state, programId: prog.id }), client);
				} catch (err) {
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.log(red(`Failed to start ${prog.prefix}: ${msg}`));
				}
			}
		} else {
			console.log(red("No programs found!"));
			console.log(dim("Run 'npm run bootstrap' to seed the initial programs."));
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(red("Failed to load programs: ") + msg);
		console.log(dim("Is the server running? Try 'npm run dev' first."));
		process.exit(1);
	}

	// Start REPL
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		prompt: "glon> ",
	});

	rl.prompt();

	rl.on("line", async (line: string) => {
		const input = line.trim();
		if (!input) {
			rl.prompt();
			return;
		}

		// Special case: exit/quit (the ONLY special case)
		if (input === "exit" || input === "quit" || input === "/exit" || input === "/quit") {
			process.exit(0);
		}

		// Everything else goes to programs
		const ctx = buildContext();
		const handled = await dispatchProgram(programs, input, ctx);

		if (!handled) {
			console.log(red("Unknown command: ") + input);
			console.log(dim("Available programs: " + programs.map(p => p.prefix).join(", ")));
		}

		rl.prompt();
	});

	rl.on("SIGINT", () => process.exit(0));
}

// ── Run ──────────────────────────────────────────────────────────
main().catch(err => {
	console.error(red("Fatal error:"), err);
	process.exit(1);
});