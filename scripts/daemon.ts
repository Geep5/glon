/**
 * Glon program daemon.
 *
 * Loads every program from the store, starts their actor instances
 * (tickers, IPC handlers, state), and stays resident. Unlike the REPL
 * client this has no stdin — it's headless, suitable for background
 * `nohup` operation.
 *
 * Run: npx tsx scripts/daemon.ts
 */

import "../src/env.js"; // side-effect: load .env into process.env
import { createClient } from "rivetkit/client";
import type { app } from "../src/index.js";
import { diskStats, readChangeByHex, listChangeFiles } from "../src/disk.js";
import { hexEncode } from "../src/crypto.js";
import { stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "../src/proto.js";
import {
	loadPrograms,
	startProgramActor,
	dispatchActorAction,
	getProgramActorByPrefix,
	type ProgramContext,
	type ProgramEntry,
} from "../src/programs/runtime.js";
import { randomUUID } from "node:crypto";
import { resolveEndpoint } from "../src/endpoint.js";

const ENDPOINT = resolveEndpoint();
const client = createClient<typeof app>(ENDPOINT);
const store = client.storeActor.getOrCreate(["root"]);

async function resolveId(raw: string): Promise<string | null> {
	if (!raw) return null;
	const exact = await store.exists(raw);
	if (exact) return raw;
	const resolved = await store.resolvePrefix(raw);
	return resolved ?? null;
}

function buildContext(overrides: Partial<ProgramContext> = {}): ProgramContext {
	return {
		client,
		store,
		resolveId,
		stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
		listChangeFiles,
		readChangeByHex,
		hexEncode,
		print: (msg: string) => console.log(msg),
		randomUUID,
		state: {},
		emit: () => {},
		programId: "",
		objectActor: (id: string) => client.objectActor.getOrCreate([id]),
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
		...overrides,
	};
}

async function main() {
	console.log(`[daemon] connecting to ${ENDPOINT}`);
	const programs: ProgramEntry[] = await loadPrograms(store, client);
	console.log(`[daemon] loaded ${programs.length} programs`);

	let started = 0;
	for (const prog of programs) {
		try {
			const inst = await startProgramActor(prog, (state) => buildContext({ state, programId: prog.id }));
			if (inst) {
				console.log(`[daemon] started ${prog.prefix} (actor=${!!prog.def?.actor}, tickMs=${prog.def?.actor?.tickMs ?? "-"})`);
				started++;
			}
		} catch (err: any) {
			console.log(`[daemon] failed to start ${prog.prefix}: ${err?.message ?? err}`);
		}
	}
	console.log(`[daemon] ${started} actor(s) running. Diskstats:`, diskStats());

	// Local HTTP dispatch: POST /dispatch {prefix, action, args} → runs in this process.
	const { createServer } = await import("node:http");
	const httpPort = Number(process.env.GLON_DAEMON_PORT ?? 6430);
	const server = createServer((req, res) => {
		if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
		let body = "";
		req.on("data", (c) => { body += c; });
		req.on("end", async () => {
			try {
				const { prefix, action, args } = JSON.parse(body || "{}");
				const inst = getProgramActorByPrefix(prefix);
				if (!inst) throw new Error(`Program not running: ${prefix}`);
				const result = await dispatchActorAction(
					inst.programId,
					action,
					Array.isArray(args) ? args : [args],
					(state) => buildContext({ state, programId: inst.programId }),
				);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, result }));
			} catch (err: any) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
			}

		});
	});

	server.listen(httpPort, "127.0.0.1", () => {
		console.log(`[daemon] dispatch http listening on 127.0.0.1:${httpPort}`);
	});

	// Trading round tick: every 5 minutes during market hours
	try {
		const { startRound, checkRoundTimeout } = await import("./trading-rounds.js");
		setInterval(async () => {
			try {
				await checkRoundTimeout();
				await startRound();
			} catch (e: any) {
				console.error("[daemon] trading round error:", e.message);
			}
		}, 5 * 60 * 1000);
		console.log("[daemon] trading round tick every 5 min");
	} catch {
		console.log("[daemon] trading rounds not available");
	}

	// Heartbeat every 60s so log shows the daemon is alive.
	setInterval(() => {
		console.log(`[daemon] alive (${new Date().toISOString()})`);
	}, 60_000);

	// Graceful shutdown.
	const shutdown = () => {
		console.log("[daemon] shutting down");
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((err) => {
	console.error("[daemon] fatal:", err);
	process.exit(1);
});
