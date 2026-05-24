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
		stopProgramActor,
		dispatchActorAction,
		getProgramActorByPrefix,
		listProgramActors,
		type ProgramContext,
		type ProgramEntry,
	} from "../src/programs/runtime.js";
	import { randomUUID } from "node:crypto";
	import { resolveEndpoint } from "../src/endpoint.js";
	import { readFileSync, watch } from "node:fs";
	import { resolve, basename } from "node:path";
	import { style } from "../src/programs/shared.js";
	import { bootstrapStore } from "../src/bootstrap.js";

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
			style,
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

	async function main() {
		const DEV = process.argv.includes("--dev");
		console.log(`[daemon] connecting to ${ENDPOINT}${DEV ? " (dev mode)" : ""}`);

		let programs: ProgramEntry[] = await loadPrograms(store, client);
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

		// ── Wallet bootstrap ──────────────────────────────────────
		// Every glon needs a chain identity (Ed25519 keypair). Auto-create
		// a "default" key on first run so the principal's /peer record
		// carries a stable identity_pubkey for cross-glon dedup.
		try {
			const walletCtx = buildContext({ state: {}, programId: "daemon-bootstrap" });
			const existing = await walletCtx.dispatchProgram("/wallet", "show", ["default"]) as { pubkey?: string } | null;
			if (!existing) {
				const created = await walletCtx.dispatchProgram("/wallet", "new", ["default"]) as { pubkey?: string };
				console.log(`[daemon] wallet: created default key ${created?.pubkey?.slice(0, 16)}...`);
			} else {
				console.log(`[daemon] wallet: default key ${existing.pubkey?.slice(0, 16)}...`);
			}
		} catch (err: any) {
			console.log(`[daemon] wallet auto-create skipped: ${err?.message ?? err}`);
		}

		// ── Dev-mode file watcher ──────────────────────────────────
		// Hot-reload programs when their handler source files change.
		if (DEV) {
			const handlersDir = resolve(import.meta.dirname ?? ".", "../src/programs/handlers");
			const debounceMs = 300;
			const pending = new Map<string, ReturnType<typeof setTimeout>>();

			watch(handlersDir, { recursive: true }, (eventType, filename) => {
				if (!filename || !filename.endsWith(".ts")) return;
				const existing = pending.get(filename);
				if (existing) clearTimeout(existing);
				pending.set(
					filename,
					setTimeout(async () => {
						pending.delete(filename);
						console.log(`[dev] ${filename} changed → bootstrapping + reloading`);

						try {
							// Stop all running actors.
							for (const prog of programs) {
								try {
									await stopProgramActor(prog.id, (state) =>
										buildContext({ state, programId: prog.id }),
									);
								} catch {
									// ignore stop errors
								}
							}

							// Bootstrap disk changes into the store first.
							await bootstrapStore(store, client, { quiet: true });

							// Reload all programs (recompiles from store).
							programs = await loadPrograms(store, client);

							// Restart actors.
							for (const prog of programs) {
								try {
									const inst = await startProgramActor(prog, (state) =>
										buildContext({ state, programId: prog.id }),
									);
									if (inst) {
										console.log(`[dev] reloaded ${prog.prefix}`);
									}
								} catch (err: any) {
									console.log(`[dev] failed to start ${prog.prefix}: ${err?.message ?? err}`);
								}
							}
						} catch (err: any) {
							console.log(`[dev] reload failed: ${err?.message ?? err}`);
						}
					}, debounceMs),
				);
			});
			console.log(`[dev] watching ${handlersDir}`);
		}
	// Track recurring tasks for inspection / toggling
	const taskHandles: Map<string, ReturnType<typeof setInterval> | null> = new Map();

	// Local HTTP dispatch: POST /dispatch {prefix, action, args} → runs in this process.
	const { createServer } = await import("node:http");
	const httpPort = Number(process.env.GLON_DAEMON_PORT ?? 6430);
	const server = createServer(async (req, res) => {
		// CORS preflight
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
			});
			res.end();
			return;
		}

		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

		// ── GET /tasks ─────────────────────────────────────────────
		if (req.method === "GET" && url.pathname === "/tasks") {
			const running = new Map(listProgramActors().map((a) => [a.prefix, a]));
			const actorTasks = programs
				.filter((p) => p.def?.actor?.tickMs != null)
				.map((p) => {
					const inst = running.get(p.prefix);
					return {
						id: p.prefix,
						name: p.prefix,
						type: "actor",
						enabled: inst ? inst.hasTick : false,
						intervalMs: p.def!.actor!.tickMs,
						programId: p.id,
					};
				});
			const daemonTasks = Array.from(taskHandles.entries()).map(([name, handle]) => ({
				id: name,
				name,
				type: "daemon",
				enabled: handle !== null,
				intervalMs: name === "trading-rounds" ? 5 * 60 * 1000 : 60_000,
			}));
			res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
			res.end(JSON.stringify({ ok: true, tasks: [...actorTasks, ...daemonTasks] }));
			return;
		}


		// ── GET /programs ────────────────────────────────────────────
		if (req.method === "GET" && url.pathname === "/programs") {
			const payload = programs.map((p) => ({
				id: p.id,
				prefix: p.prefix,
				name: p.name,
				typedActions: p.def?.actor?.typedActions
					? Object.fromEntries(
						Object.entries(p.def.actor.typedActions).map(([k, v]) => [
							k,
							{ description: v.description, inputSchema: v.inputSchema },
						]),
					)
					: undefined,
				tickMs: p.def?.actor?.tickMs ?? undefined,
			}));
			res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
			res.end(JSON.stringify({ ok: true, programs: payload }));
			return;
		}
		// ── POST /tasks/:id/toggle ─────────────────────────────────
		if (req.method === "POST" && url.pathname.startsWith("/tasks/")) {
			const match = url.pathname.match(/^\/tasks\/(.+?)\/toggle$/);
			const rawId = match ? decodeURIComponent(match[1]) : "";
			if (rawId) {
				try {
					// Daemon-level tasks have no leading slash (e.g. "heartbeat", "trading-rounds")
					if (taskHandles.has(rawId)) {
						const handle = taskHandles.get(rawId);
						if (handle) {
							clearInterval(handle);
							taskHandles.set(rawId, null);
							console.log(`[daemon] paused task ${rawId}`);
						} else {
							// Restart the task
							if (rawId === "trading-rounds") {
								if (!tradingRoundsMod) throw new Error("Trading rounds not available");
								const h = setInterval(async () => {
									try { await tradingRoundsMod!.checkRoundTimeout(); await tradingRoundsMod!.startRound(); }
									catch (e: any) { console.error("[daemon] trading round error:", e.message); }
								}, 5 * 60 * 1000);
								taskHandles.set(rawId, h);
							} else if (rawId === "heartbeat") {
								const h = setInterval(() => {
									console.log(`[daemon] alive (${new Date().toISOString()})`);
								}, 60_000);
								taskHandles.set(rawId, h);
							}
							console.log(`[daemon] resumed task ${rawId}`);
						}
					} else {
						// Program actor tasks have a leading slash (e.g. "/auction")
						const taskId = rawId.startsWith("/") ? rawId : "/" + rawId;
						const inst = getProgramActorByPrefix(taskId);
						if (inst && inst.tickHandle) {
							await stopProgramActor(inst.programId, (state) => buildContext({ state, programId: inst.programId }));
							console.log(`[daemon] paused actor ${taskId}`);
						} else {
							// Find the program entry and restart it
							const prog = programs.find((p) => p.prefix === taskId);
							if (!prog) throw new Error(`Program entry not found for ${taskId}`);
							await startProgramActor(prog, (state) => buildContext({ state, programId: prog.id }));
							console.log(`[daemon] resumed actor ${taskId}`);
						}
					}
					res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
					res.end(JSON.stringify({ ok: true, id: rawId }));
				} catch (err: any) {
					res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
					res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
				}
				return;
			}
		}

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
				res.writeHead(200, {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				});
				res.end(JSON.stringify({ ok: true, result }));
			} catch (err: any) {
				res.writeHead(500, {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
				});
				res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
			}
		});
	});

	server.listen(httpPort, "127.0.0.1", () => {
		console.log(`[daemon] dispatch http listening on 127.0.0.1:${httpPort}`);
	});

	// Trading round tick: every 5 minutes during market hours
	let tradingRoundsMod: { startRound: () => Promise<void>; checkRoundTimeout: () => Promise<void> } | null = null;
	try {
		tradingRoundsMod = await import("./trading-rounds.js");
		const h = setInterval(async () => {
			try { await tradingRoundsMod!.checkRoundTimeout(); await tradingRoundsMod!.startRound(); }
			catch (e: any) { console.error("[daemon] trading round error:", e.message); }
		}, 5 * 60 * 1000);
		taskHandles.set("trading-rounds", h);
		console.log("[daemon] trading round tick every 5 min");
	} catch {
		console.log("[daemon] trading rounds not available");
	}

	// Heartbeat every 60s so log shows the daemon is alive.
	const heartbeatHandle = setInterval(() => {
		console.log(`[daemon] alive (${new Date().toISOString()})`);
	}, 60_000);
	taskHandles.set("heartbeat", heartbeatHandle);

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
