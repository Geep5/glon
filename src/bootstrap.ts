/**
 * Bootstrap — seed Glon with its own source files and programs.
 *
 * Each source file becomes a Glon object created through the store actor.
 * Programs (src/programs/handlers/*.ts) are created as type=program objects
 * with manifest fields mapping module filenames to source strings.
 *
 * Usage: npm run bootstrap / npx tsx src/bootstrap.ts
 */

import "./env.js"; // side-effect: load .env into process.env
import { createClient } from "rivetkit/client";
import type { app } from "./index.js";
import { readFileSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { initDisk } from "./disk.js";
import { stringVal, intVal, mapVal } from "./proto.js";
import { resolveEndpoint } from "./endpoint.js";
const ENDPOINT = resolveEndpoint();

const SOURCES = [
	"proto/glon.proto",
	"src/proto.ts",
	"src/crypto.ts",
	"src/dag/change.ts",
	"src/dag/dag.ts",
	"src/disk.ts",
	"src/env.ts",
	"src/endpoint.ts",
	"src/index.ts",
	"src/bootstrap.ts",
	"src/client.ts",
	"src/programs/runtime.ts",
	"src/programs/handlers/help.ts",
	"src/programs/handlers/crud.ts",
	"src/programs/handlers/inspect.ts",
	"src/programs/handlers/ipc.ts",
	"src/programs/handlers/ttt.ts",
	"src/programs/handlers/comment.ts",
	"src/programs/handlers/chat.ts",
	"src/programs/handlers/agent.ts",
	"src/programs/handlers/task.ts",
	"src/programs/handlers/gc.ts",
	"src/programs/handlers/sync.ts",
	"src/programs/handlers/graph.ts",
	"src/programs/handlers/peer.ts",
	"src/programs/handlers/holdfast.ts",
	"src/programs/handlers/discord.ts",
	"src/programs/handlers/anytype.ts",
	"src/programs/handlers/browser.ts",
	"src/programs/handlers/remind.ts",
	"src/programs/handlers/web.ts",
	"src/programs/handlers/memory.ts",
	"src/programs/handlers/todo.ts",
	"src/programs/handlers/google.ts",
	"src/programs/handlers/shell.ts",
	"src/programs/handlers/auth.ts",
	"src/det/index.ts",
	"src/det/canonical.ts",
	"src/det/math.ts",
	"src/det/ed25519.ts",
	"src/programs/handlers/wallet.ts",
	"src/programs/handlers/consensus.ts",
	"src/programs/handlers/anchor.ts",
	"src/programs/handlers/plot.ts",
	"src/programs/handlers/timelord.ts",
	"src/programs/handlers/coin.ts",
	"package.json",
	"tsconfig.json",
];

// Program definitions: manifest → entry + modules
interface ProgramDef {
	prefix: string;
	name: string;
	commands: Record<string, string>;
	entry: string;
	modules: Record<string, string>; // filename → relative file path
}

const PROGRAMS: ProgramDef[] = [
	{
		prefix: "/help",
		name: "Help",
		commands: {
			"": "Show all available programs",
		},
		entry: "help.ts",
		modules: { "help.ts": "src/programs/handlers/help.ts" },
	},
	{
		prefix: "/crud",
		name: "CRUD Operations",
		commands: {
			create: "Create an object",
			list: "List objects",
			get: "Get object details",
			set: "Set a field value",
			delete: "Delete an object",
			search: "Search objects",
		},
		entry: "crud.ts",
		modules: { "crud.ts": "src/programs/handlers/crud.ts" },
	},
	{
		prefix: "/inspect",
		name: "DAG Inspector",
		commands: {
			history: "Object change history",
			change: "Inspect a change",
			heads: "Current DAG heads",
			changes: "List all changes",
			snapshot: "Create snapshot",
			sync: "Sync two objects",
			remote: "Push/pull remote",
			info: "Store info",
			disk: "Disk usage",
		},
		entry: "inspect.ts",
		modules: { "inspect.ts": "src/programs/handlers/inspect.ts" },
	},
	{
		prefix: "/ipc",
		name: "Inter-Process Comm",
		commands: {
			send: "Send a message",
			inbox: "View inbox",
			outbox: "View outbox",
			clear: "Clear messages",
		},
		entry: "ipc.ts",
		modules: { "ipc.ts": "src/programs/handlers/ipc.ts" },
	},
	{
		prefix: "/ttt",
		name: "Tic-Tac-Toe",
		commands: {
			new: "Start a new game",
			board: "Show the board",
			move: "Make a move",
			history: "Move-by-move replay",
		},
		entry: "ttt.ts",
		modules: { "ttt.ts": "src/programs/handlers/ttt.ts" },
	},
	{
		prefix: "/comment",
		name: "Comment",
		commands: {
			post: "Post a message on any object",
			reply: "Reply to a message",
			react: "React to a message with an emoji",
			unreact: "Remove a reaction",
			list: "List messages on an object",
			thread: "List a single thread (root + descendants)",
		},
		entry: "comment.ts",
		modules: { "comment.ts": "src/programs/handlers/comment.ts" },
	},
	{
		prefix: "/chat",
		name: "Chat",
		commands: {
			new: "Create a chat room",
			send: "Send a message",
			read: "Read messages",
			reply: "Reply to a message",
			react: "React to a message",
		},
		entry: "chat.ts",
		modules: { "chat.ts": "src/programs/handlers/chat.ts", "comment.ts": "src/programs/handlers/comment.ts" },
	},
	{
		prefix: "/agent",
		name: "Agent",
		commands: {
			new: "Create an agent",
			ask: "Chat with agent",
			history: "Conversation history",
			config: "Set model/system/name",
			read: "Peek at agent conversation",
			inject: "Inject context from another agent",
			"register-tool": "Register a tool (dispatches to another program)",
			"unregister-tool": "Remove a registered tool",
			tools: "List registered tools",
			status: "Show token usage + compaction state",
			compact: "Manually compact old conversation turns",
			"view-summary": "Show latest compaction summary in full",
			tree: "Render the spawn lineage tree rooted at this agent",
			"list-templates": "List builtin and DAG-defined agent templates",
			"create-template": "Create a new agent_template in the DAG",
			"delete-template": "Tombstone an agent_template by name or id",
			recall: "Re-inject a compacted block back into the agent's live context",
		},
		entry: "agent.ts",
		modules: { "agent.ts": "src/programs/handlers/agent.ts" },
	},
	{
		prefix: "/task",
		name: "Task (subagent spawning)",
		commands: {
			spawn: "Spawn one or more subagents from a JSON batch",
			status: "Show a spawned subagent's depth, parent, and submitted result",
			tree: "Render the spawn lineage tree rooted at an agent",
			cancel: "Request cancellation of a running subagent",
		},
		entry: "task.ts",
		modules: {
			"task.ts": "src/programs/handlers/task.ts",
			"agent.ts": "src/programs/handlers/agent.ts",
		},
	},
	{
		prefix: "/gc",
		name: "Garbage Collection",
		commands: {
			run: "Collect unprotected, unreachable objects",
			protect: "Protect object (transitive via links)",
			unprotect: "Remove protection",
			status: "Show protected roots and reachability",
		},
		entry: "gc.ts",
		modules: { "gc.ts": "src/programs/handlers/gc.ts" },
	},
	{
		prefix: "/sync",
		name: "P2P Sync",
		commands: {
			discover: "Start peer discovery",
			peers: "List known peers",
			sync: "Sync object with peers",
			broadcast: "Broadcast changes",
			add: "Add peer manually",
			remove: "Remove peer",
			status: "Show sync status",
		},
		entry: "sync.ts",
		modules: { "sync.ts": "src/programs/handlers/sync.ts" },
	},
	{
		prefix: "/graph",
		name: "Object Graph",
		commands: {
			links: "Show links for an object",
			traverse: "BFS graph traversal",
			neighbors: "Immediate neighbors with types",
		},
		entry: "graph.ts",
		modules: { "graph.ts": "src/programs/handlers/graph.ts" },
	},
	{
		prefix: "/peer",
		name: "Peer",
		commands: {
			add: "Add a peer (person, agent, service)",
			list: "List peers (filter by --kind / --trust)",
			get: "Show a peer's full record",
			trust: "Change a peer's trust level",
			set: "Set a peer field (display_name, email, notes, ...)",
			remove: "Tombstone a peer",
		},
		entry: "peer.ts",
		modules: { "peer.ts": "src/programs/handlers/peer.ts" },
	},
	{
		prefix: "/holdfast",
		name: "Holdfast",
		commands: {
			setup: "Bootstrap the harness (create agent + self peer)",
			say: "Principal talks to the agent from the shell",
			ingest: "Deliver a message from a peer on a source",
			status: "Show current agent + principal ids",
			"refresh-prompt": "Re-render default system prompt + re-wire tools",
		},
		entry: "holdfast.ts",
		modules: {
			"holdfast.ts": "src/programs/handlers/holdfast.ts",
			"agent.ts": "src/programs/handlers/agent.ts",
			"todo.ts": "src/programs/handlers/todo.ts",
		},
	},
	{
		prefix: "/anytype",
		name: "Anytype",
		commands: {
			help: "Show shell cheatsheet (curl recipes + env vars)",
		},
		entry: "anytype.ts",
		modules: { "anytype.ts": "src/programs/handlers/anytype.ts" },
	},
	{
		prefix: "/browser",
		name: "Browser",
		commands: {
			help: "Show shell cheatsheet (agent-browser primitives + session pattern)",
		},
		entry: "browser.ts",
		modules: { "browser.ts": "src/programs/handlers/browser.ts" },
	},
	{
		prefix: "/discord",
		name: "Discord",
		commands: {
			status: "Show bridge state (bot user, watermarks, channels cached)",
			send: "Send a DM to a peer (diagnostic)",
			poll: "Trigger a poll cycle now (diagnostic)",
		},
		entry: "discord.ts",
		modules: { "discord.ts": "src/programs/handlers/discord.ts" },
	},
	{
		prefix: "/remind",
		name: "Remind",
		commands: {
			schedule: "Schedule a future action",
			list: "List reminders (filter by --peer/--status/--channel/--before)",
			get: "Show a reminder's full record",
			cancel: "Cancel a pending reminder",
			tick: "Run the scheduler once now (diagnostic)",
		},
		entry: "remind.ts",
		modules: { "remind.ts": "src/programs/handlers/remind.ts" },
	},
	{
		prefix: "/web",
		name: "Web",
		commands: {
			help: "Show shell cheatsheet (curl + jq + pandoc recipes)",
		},
		entry: "web.ts",
		modules: { "web.ts": "src/programs/handlers/web.ts" },
	},
	{
		prefix: "/memory",
		name: "Memory",
		commands: {
			facts: "List pinned facts for an agent",
			milestones: "List milestones for an agent",
			get: "Show one milestone in full",
			digest: "System-prompt-ready memory digest",
			recall: "Scoped search over memory",
			"forget-fact": "Tombstone a fact (recoverable via object_history)",
		},
		entry: "memory.ts",
		modules: { "memory.ts": "src/programs/handlers/memory.ts" },
	},
	{
		prefix: "/todo",
		name: "Todo",
		commands: {
			show: "Render an agent's phased task list",
			incomplete: "List pending/in_progress tasks only",
			clear: "Reset list to empty (history preserved)",
		},
		entry: "todo.ts",
		modules: { "todo.ts": "src/programs/handlers/todo.ts" },
	},
	{
		prefix: "/wallet",
		name: "Wallet",
		commands: {
			new: "Generate a fresh Ed25519 keypair (local-only, never synced)",
			list: "List local keys (no private material shown)",
			show: "Show one key's pubkey + creation time",
			remove: "Forget a key (no recovery — back up first)",
		},
		entry: "wallet.ts",
		modules: { "wallet.ts": "src/programs/handlers/wallet.ts" },
	},
	{
		prefix: "/coin",
		name: "Coin",
		commands: {
			deploy: "Deploy a new UTXO token",
			transfer: "Send coins to a pubkey",
			mint: "Mint new coins (owner only)",
			burn: "Burn coins (owner only)",
			balance: "Show one holder's balance",
			holders: "List balances, descending",
			info: "Show metadata + supply + owner",
		},
		entry: "coin.ts",
		modules: { "coin.ts": "src/programs/handlers/coin.ts" },
	},
	{
		prefix: "/consensus",
		name: "Consensus",
		commands: {
			status: "Show nonces + fee policy + minimums",
			nonces: "List last-seen nonce per pubkey",
			"set-base-fee": "Adjust the base fee (Deploy=100x, Mint=10x, Other=1x)",
		},
		entry: "consensus.ts",
		modules: { "consensus.ts": "src/programs/handlers/consensus.ts" },
	},
	{
		prefix: "/anchor",
		name: "Anchor",
		commands: {
			create: "Create a new anchor from current chain-mode state",
			list: "Show recent anchors",
			status: "Latest anchor + pending summary",
			info: "Full anchor details + Merkle verify",
			verify: "Verify Merkle root against stored commits",
		},
		entry: "anchor.ts",
		modules: { "anchor.ts": "src/programs/handlers/anchor.ts" },
	},
	{
		prefix: "/plot",
		name: "Plot",
		commands: {
			create: "Create a simplified plot file",
			list: "List all plot files",
			prove: "Find best proof for a challenge",
			verify: "Verify a proof",
		},
		entry: "plot.ts",
		modules: { "plot.ts": "src/programs/handlers/plot.ts" },
	},
	{
		prefix: "/timelord",
		name: "Timelord",
		commands: {
			compute: "Run VDF computation",
			verify: "Verify a VDF output",
			benchmark: "Measure VDF speed",
			challenge: "Derive challenge from anchor merkle_root",
		},
		entry: "timelord.ts",
		modules: { "timelord.ts": "src/programs/handlers/timelord.ts" },
	},
	{
		prefix: "/google",
		name: "Google",
		commands: {
			help: "Show shell cheatsheet (gws verbs + dry-run pattern)",
		},
		entry: "google.ts",
		modules: { "google.ts": "src/programs/handlers/google.ts" },
	},
	{
		prefix: "/shell",
		name: "Shell",
		commands: {
			exec: "Run a bash command in a persistent session",
			sessions: "List live shell sessions",
			kill: "Kill and discard a session",
		},
		entry: "shell.ts",
		modules: { "shell.ts": "src/programs/handlers/shell.ts" },
	},
	{
		prefix: "/auth",
		name: "Auth",
		commands: {
			login: "Run interactive OAuth, save token",
			status: "Show current credential, expiry",
			refresh: "Force a token refresh",
			logout: "Delete stored credentials",
		},
		entry: "auth.ts",
		modules: { "auth.ts": "src/programs/handlers/auth.ts" },
	},
];

const KIND_MAP: Record<string, string> = {
	".proto": "proto",
	".ts": "typescript",
	".js": "javascript",
	".json": "json",
};

function kindOf(file: string): string {
	return KIND_MAP[extname(file)] ?? "unknown";
}

// Canonicalize a fields object so insertion-order doesn't change equality.
// Used by the bootstrap loop to compare desired vs stored shapes byte-for-byte.
function canonicalFields(value: unknown): string {
	return JSON.stringify(value, function sortKeys(_k, v) {
		if (v && typeof v === "object" && !Array.isArray(v)) {
			const sorted: Record<string, unknown> = {};
			for (const k of Object.keys(v as Record<string, unknown>).sort()) sorted[k] = (v as Record<string, unknown>)[k];
			return sorted;
		}
		return v;
	});
}

async function main() {
	const FORCE = process.argv.includes("--force");
	const projectRoot = resolve(import.meta.dirname ?? ".", "..");

	initDisk();

	const client = createClient<typeof app>(ENDPOINT);
	const store = client.storeActor.getOrCreate(["root"]);

	console.log(FORCE ? "Bootstrapping Glon (force mode: existing objects will be updated)...\n" : "Bootstrapping Glon...\n");
	// Build lookup of existing objects by type+name for idempotency.
	const existingByKey = new Map<string, string>();
	try {
		const allRefs = await store.list() as { id: string; typeKey: string }[];
		for (const ref of allRefs) {
			const obj = await store.get(ref.id) as { fields?: Record<string, any> } | null;
			if (!obj?.fields?.name?.stringValue) continue;
			// Key: "type::name" for source files, "type::prefix" for programs
			existingByKey.set(`${ref.typeKey}::${obj.fields.name.stringValue}`, ref.id);
			if (obj.fields.prefix?.stringValue) {
				existingByKey.set(`program::${obj.fields.prefix.stringValue}`, ref.id);
			}
		}
	} catch {
		// Store may be empty or not ready; proceed with creates.
	}

	let created = 0;
	let updated = 0;
	let skipped = 0;

	for (const relPath of SOURCES) {
		const absPath = resolve(projectRoot, relPath);
		const name = basename(relPath);
		const kind = kindOf(relPath);

		const existingSourceId = existingByKey.get(`${kind}::${name}`);

		let raw: Buffer;
		try {
			raw = readFileSync(absPath);
		} catch {
			console.log(`  SKIP  ${relPath} (not found)`);
			skipped++;
			continue;
		}

		const lineCount = raw.toString("utf-8").split("\n").length;
		const contentBase64 = raw.toString("base64");

		const fieldsJson = JSON.stringify({
			name: stringVal(name),
			path: stringVal(relPath),
			lines: intVal(lineCount),
			size: intVal(raw.byteLength),
		});

		// Content-aware idempotency: skip only when the on-disk content matches
		// what's already stored. --force rewrites unconditionally (useful when
		// you've manually corrupted an object and want a clean reseed).
		if (existingSourceId && !FORCE) {
			const existing = await store.get(existingSourceId);
			const existingContent = String(existing?.content ?? "");
			if (existingContent === contentBase64) {
				console.log(`  UNCHANGED ${relPath.padEnd(24)} ${kind.padEnd(12)} ${existingSourceId.slice(0, 12)}...`);
				skipped++;
				continue;
			}
		}

		try {
			if (existingSourceId) {
				const actor = client.objectActor.getOrCreate([existingSourceId]);
				await actor.setContent(contentBase64);
				await actor.setFields(JSON.stringify({
					lines: intVal(lineCount),
					size: intVal(raw.byteLength),
				}));
				const tag = FORCE ? "FORCED" : "UPDATE";
				console.log(`  ${tag.padEnd(9)} ${relPath.padEnd(24)} ${kind.padEnd(12)} ${existingSourceId.slice(0, 12)}...`);
				updated++;
			} else {
				const id = await store.create(kind, fieldsJson, contentBase64);
				console.log(`  CREATE    ${relPath.padEnd(24)} ${kind.padEnd(12)} ${id.slice(0, 12)}...`);
				created++;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  ERR       ${relPath} \u2014 ${msg}`);
			skipped++;
		}
	}

	// ── Programs ────────────────────────────────────────────────
	console.log("\nSeeding programs...\n");

	for (const prog of PROGRAMS) {
		const existingProgId = existingByKey.get(`program::${prog.prefix}`);

		// Load all module files and build the manifest.
		const moduleEntries: Record<string, ReturnType<typeof stringVal>> = {};
		let allOk = true;
		for (const [filename, relPath] of Object.entries(prog.modules)) {
			const absPath = resolve(projectRoot, relPath);
			try {
				const raw = readFileSync(absPath);
				moduleEntries[filename] = stringVal(raw.toString("base64"));
			} catch {
				console.log(`  SKIP      ${prog.prefix} (missing ${relPath})`);
				allOk = false;
				break;
			}
		}
		if (!allOk) { skipped++; continue; }

		const commandEntries: Record<string, ReturnType<typeof stringVal>> = {};
		for (const [k, v] of Object.entries(prog.commands)) {
			commandEntries[k] = stringVal(v);
		}

		const fieldsJson = JSON.stringify({
			name: stringVal(prog.name),
			prefix: stringVal(prog.prefix),
			commands: mapVal(commandEntries),
			manifest: mapVal({
				entry: stringVal(prog.entry),
				modules: mapVal(moduleEntries),
			}),
		});

		// Content-aware idempotency: compare the full fields shape (commands +
		// manifest + name) against what's already stored. Only skip when nothing
		// changed; --force rewrites unconditionally.
		if (existingProgId && !FORCE) {
			const existing = await store.get(existingProgId);
			const existingFields = canonicalFields(existing?.fields);
			const desiredFields = canonicalFields(JSON.parse(fieldsJson));
			if (existingFields === desiredFields) {
				console.log(`  UNCHANGED ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${existingProgId.slice(0, 12)}...`);
				skipped++;
				continue;
			}
		}

		try {
			if (existingProgId) {
				const actor = client.objectActor.getOrCreate([existingProgId]);
				await actor.setFields(JSON.stringify({
					commands: mapVal(commandEntries),
					manifest: mapVal({
						entry: stringVal(prog.entry),
						modules: mapVal(moduleEntries),
					}),
				}));
				const tag = FORCE ? "FORCED" : "UPDATE";
				console.log(`  ${tag.padEnd(9)} ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${existingProgId.slice(0, 12)}... (${Object.keys(prog.modules).length} modules)`);
				updated++;
			} else {
				const id = await store.create("program", fieldsJson);
				console.log(`  CREATE    ${prog.prefix.padEnd(10)} ${prog.name.padEnd(16)} ${id.slice(0, 12)}... (${Object.keys(prog.modules).length} modules)`);
				created++;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  ERR       ${prog.name} \u2014 ${msg}`);
			skipped++;
		}
	}

	console.log(`\nDone. ${created} created, ${updated} updated, ${skipped} skipped.`);

	try {
		const info = await store.info();
		console.log(`Store: ${info.totalObjects} objects, ${info.totalChanges} changes.`);
		for (const [typeKey, cnt] of Object.entries(info.byType)) {
			console.log(`  ${typeKey}: ${cnt}`);
		}
	} catch {
		// Store info may fail if not fully ready; non-fatal.
	}

	process.exit(0);
}

main().catch((err) => {
	console.error("Bootstrap failed:", err);
	process.exit(1);
});
