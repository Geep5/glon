// Peer — identity + trust for every human and agent the harness talks to.
//
// A peer is a first-class Glon object (type "peer"). The principal, their
// family, trusted contacts, external agents — all peers, unified under one
// abstraction.
// Because peers are Glon objects, they sync across instances and carry
// replayable history (when was trust bumped, when was a note added).
//
// Fields:
//   display_name: human-readable name
//   kind:         self | human | agent | service
//   trust_level:  self | family | ops | stranger
//   discord_id?:  Discord user id (for DM routing)
//   email?:       email address (for mail tools)
//   notes?:       free-text, owner-editable
//
// The set of valid `kind` / `trust_level` values is soft — the harness's
// system prompt and downstream programs interpret them. New categories
// can be added without schema changes.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";


import { dim, bold, cyan, red, green, yellow, magenta } from "../shared.js";

// ── Types ────────────────────────────────────────────────────────

	export interface PeerRecord {
		id: string;
		display_name: string;
		kind: string;
		trust_level: string;
		identity_pubkey?: string;
		hyperswarm_pubkey?: string;
		endpoints?: string;
		preferred_transport?: string;
		key_verified_at?: string;
		attestations?: string;
		discord_id?: string;
		email?: string;
		notes?: string;
		last_seen?: string;
	}

/**
 * Trust hierarchy (highest → lowest):
 *   self    — this daemon's own identity
 *   family  — human-marked highest-trust peer
 *   friend  — human-marked second-highest
 *   trusted — peered via /directory handshake (the default after peer-accept)
 *   discovered — seen on the swarm but no handshake yet
 *   stranger — default for /peer add with no trust set
 *
 * `isPeered()` is the gate every peer-to-peer feature should use (chat,
 * trade, capability discovery). Strict equality on "trusted" is wrong —
 * a peer manually upgraded to "family" should not lose access. Trust
 * RAISES, never lowers, capabilities.
 */
export const PEER_TRUSTED_LEVELS: ReadonlySet<string> = new Set(["trusted", "friend", "family", "self"]);
export function isPeered(trust_level: string | undefined | null): boolean {
	return !!trust_level && PEER_TRUSTED_LEVELS.has(trust_level);
}

// Recognised field keys for peer objects. Any other field is ignored by
// the read path but preserved on disk.
//   hyperswarm_pubkey — current Noise pubkey learned via /directory announce.
//                       May rotate; rewritten on every upsertPeer.
//   last_seen          — wall-clock ms of last announce/handshake. Used by
//                       UIs and the trade orchestrator to pick a fresh peer.
//   agents_json — JSON-encoded array of {id, name} from the peer's most
//                 recent announce. Lets UIs render that peer's specific
//                 agents and (later) address messages to them by id.
	const PEER_FIELDS = ["display_name", "kind", "trust_level", "identity_pubkey", "hyperswarm_pubkey", "endpoints", "preferred_transport", "key_verified_at", "attestations", "discord_id", "email", "notes", "last_seen", "agents_json"] as const;

// ── Helpers ──────────────────────────────────────────────────────

function extractString(v: any): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return undefined;
}

	function recordFromState(id: string, fields: Record<string, any>): PeerRecord {
		return {
			id,
			display_name: extractString(fields?.display_name) ?? "",
			kind: extractString(fields?.kind) ?? "human",
			trust_level: extractString(fields?.trust_level) ?? "stranger",
			identity_pubkey: extractString(fields?.identity_pubkey),
			hyperswarm_pubkey: extractString(fields?.hyperswarm_pubkey),
			endpoints: extractString(fields?.endpoints),
			preferred_transport: extractString(fields?.preferred_transport),
			key_verified_at: extractString(fields?.key_verified_at),
			attestations: extractString(fields?.attestations),
			discord_id: extractString(fields?.discord_id),
			email: extractString(fields?.email),
			notes: extractString(fields?.notes),
			last_seen: extractString(fields?.last_seen),
		};
	}

function trustColor(level: string): (s: string) => string {
	switch (level) {
		case "self": return magenta;
		case "family": return green;
		case "ops": return cyan;
		case "stranger": return yellow;
		default: return dim;
	}
}

// ── Core operations (shared between handler + actor) ─────────────

async function doAdd(spec: Partial<Omit<PeerRecord, "id">> & { display_name: string }, ctx: ProgramContext): Promise<string> {
	const store = ctx.store as any;
	const fields: Record<string, unknown> = {};
	for (const key of PEER_FIELDS) {
		const v = (spec as any)[key];
		if (v !== undefined && v !== "") {
			fields[key] = ctx.stringVal(String(v));
		}
	}
	// Defaults
	if (!fields.kind) fields.kind = ctx.stringVal("human");
	if (!fields.trust_level) fields.trust_level = ctx.stringVal("stranger");
	const id = await store.create("peer", JSON.stringify(fields));
	return id;
}

async function doList(filter: { kind?: string; trust_level?: string } | undefined, ctx: ProgramContext): Promise<PeerRecord[]> {
	const store = ctx.store as any;
	const refs = await store.list("peer") as { id: string; typeKey: string }[];
	const records: PeerRecord[] = [];
	for (const ref of refs) {
		const state = await store.get(ref.id);
		if (!state || state.deleted) continue;
		const rec = recordFromState(ref.id, state.fields);
		if (filter?.kind && rec.kind !== filter.kind) continue;
		if (filter?.trust_level && rec.trust_level !== filter.trust_level) continue;
		records.push(rec);
	}
	return records;
}

async function doGet(peerId: string, ctx: ProgramContext): Promise<PeerRecord | null> {
	const store = ctx.store as any;
	const state = await store.get(peerId);
	if (!state || state.deleted) return null;
	if (state.typeKey !== "peer") return null;
	return recordFromState(peerId, state.fields);
}

async function doFindOrCreate(
	externalKey: string,
	externalValue: string,
	defaults: Partial<Omit<PeerRecord, "id">>,
	ctx: ProgramContext,
): Promise<{ id: string; created: boolean }> {
	if (!externalKey || !externalValue) throw new Error("findOrCreate: externalKey and externalValue required");
	if (!PEER_FIELDS.includes(externalKey as any)) {
		throw new Error(`findOrCreate: unknown external key '${externalKey}' (recognized: ${PEER_FIELDS.join(", ")})`);
	}

	const existing = await doList(undefined, ctx);
	for (const rec of existing) {
		if ((rec as any)[externalKey] === externalValue) {
			return { id: rec.id, created: false };
		}
	}

	const spec: Omit<PeerRecord, "id"> = {
		display_name: defaults.display_name || externalValue,
		kind: defaults.kind || "human",
		trust_level: defaults.trust_level || "stranger",
		discord_id: defaults.discord_id,
		email: defaults.email,
		notes: defaults.notes,
	};
	(spec as any)[externalKey] = externalValue;
	const id = await doAdd(spec, ctx);
	return { id, created: true };
}

async function doSetField(peerId: string, key: string, value: string, ctx: ProgramContext): Promise<void> {
	if (!PEER_FIELDS.includes(key as any)) {
		throw new Error(`setField: unknown field '${key}' (recognized: ${PEER_FIELDS.join(", ")})`);
	}
	const client = ctx.client as any;
	const actor = client.objectActor.getOrCreate([peerId]);
	await actor.setField(key, JSON.stringify(ctx.stringVal(value)));
}

async function doSetTrust(peerId: string, level: string, ctx: ProgramContext): Promise<void> {
	await doSetField(peerId, "trust_level", level, ctx);
}

async function doRemove(peerId: string, ctx: ProgramContext): Promise<void> {
	const client = ctx.client as any;
	const actor = client.objectActor.getOrCreate([peerId]);
	await actor.markDeleted();
}

// ── Handler (CLI subcommands) ────────────────────────────────────

interface AddArgs {
	display_name: string;
	kind?: string;
	trust_level?: string;
	discord_id?: string;
	email?: string;
	notes?: string;
}

function parseAddArgs(args: string[]): AddArgs | string {
	if (args.length === 0) return "Usage: peer add <name> [--kind X] [--trust Y] [--discord ID] [--email addr] [--notes \"...\"]";
	const result: AddArgs = { display_name: "" };
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const next = args[i + 1];
		if (a === "--kind" && next) { result.kind = next; i++; }
		else if (a === "--trust" && next) { result.trust_level = next; i++; }
		else if (a === "--discord" && next) { result.discord_id = next; i++; }
		else if (a === "--email" && next) { result.email = next; i++; }
		else if (a === "--notes" && next) { result.notes = next; i++; }
		else positional.push(a);
	}
	result.display_name = positional.join(" ");
	if (!result.display_name) return "Usage: peer add <name> [...flags]";
	return result;
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { resolveId, print } = ctx;

	switch (cmd) {
		// /peer add <name> [--kind X] [--trust Y] [--discord ID] [--email addr] [--notes "..."]
		case "add": {
			const parsed = parseAddArgs(args);
			if (typeof parsed === "string") { print(red(parsed)); break; }
			try {
				const id = await doAdd(parsed, ctx);
				print(green("  Peer created: ") + bold(id));
				print(dim(`  name: ${parsed.display_name}`));
				if (parsed.kind) print(dim(`  kind: ${parsed.kind}`));
				if (parsed.trust_level) print(dim(`  trust: ${parsed.trust_level}`));
				if (parsed.discord_id) print(dim(`  discord: ${parsed.discord_id}`));
				if (parsed.email) print(dim(`  email: ${parsed.email}`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /peer list [--kind X] [--trust Y]
		case "list": {
			const filter: { kind?: string; trust_level?: string } = {};
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "--kind" && args[i + 1]) { filter.kind = args[++i]; }
				else if (args[i] === "--trust" && args[i + 1]) { filter.trust_level = args[++i]; }
			}
			const peers = await doList(filter, ctx);
			if (peers.length === 0) { print(dim("  (no peers)")); break; }
			print(bold(`  ${peers.length} peer(s)`));
			for (const p of peers) {
				const trustLabel = trustColor(p.trust_level)(p.trust_level);
				const kindLabel = dim(`(${p.kind})`);
				const handles: string[] = [];
				if (p.discord_id) handles.push(`discord:${p.discord_id}`);
				if (p.email) handles.push(p.email);
				const handlesStr = handles.length ? dim(`  ${handles.join("  ")}`) : "";
				print(`    ${p.id.slice(0, 8)}  ${bold(p.display_name.padEnd(16))}  ${trustLabel}  ${kindLabel}${handlesStr}`);
			}
			break;
		}

		// /peer get <id>
		case "get": {
			const raw = args[0];
			if (!raw) { print(red("Usage: peer get <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			const rec = await doGet(id, ctx);
			if (!rec) { print(red("Peer not found: ") + id); break; }
			print(bold(`  ${rec.display_name}`));
			print(dim(`  id: ${rec.id}`));
			print(dim(`  kind: ${rec.kind}`));
			print(dim(`  trust: ${rec.trust_level}`));
			if (rec.discord_id) print(dim(`  discord: ${rec.discord_id}`));
			if (rec.email) print(dim(`  email: ${rec.email}`));
			if (rec.notes) print(dim(`  notes: ${rec.notes}`));
			break;
		}

		// /peer trust <id> <level>
		case "trust": {
			const raw = args[0];
			const level = args[1];
			if (!raw || !level) { print(red("Usage: peer trust <id> <level>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				await doSetTrust(id, level, ctx);
				print(green("  trust = ") + trustColor(level)(level));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /peer set <id> <key> <value...>
		case "set": {
			const raw = args[0];
			const key = args[1];
			const value = args.slice(2).join(" ");
			if (!raw || !key || !value) {
				print(red("Usage: peer set <id> <key> <value>"));
				print(dim(`  Keys: ${PEER_FIELDS.join(", ")}`));
				break;
			}
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				await doSetField(id, key, value, ctx);
				print(dim(`  ${key} = ${value}`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /peer remove <id>
		case "remove": {
			const raw = args[0];
			if (!raw) { print(red("Usage: peer remove <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			await doRemove(id, ctx);
			print(green("  removed ") + id);
			break;
		}

		default: {
			print([
				bold("  Peer"),
				`    ${cyan("peer add")} ${dim("<name> [--kind X] [--trust Y] [--discord ID] [--email addr] [--notes \"...\"]")}`,
				`    ${cyan("peer list")} ${dim("[--kind X] [--trust Y]")}`,
				`    ${cyan("peer get")} ${dim("<id>")}`,
				`    ${cyan("peer trust")} ${dim("<id> <level>")}                 ${dim("self | family | ops | stranger")}`,
				`    ${cyan("peer set")} ${dim("<id> <key> <value>")}              ${dim("keys: " + PEER_FIELDS.join(", "))}`,
				`    ${cyan("peer remove")} ${dim("<id>")}`,
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API) ─────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({}),
	actions: {
		add: async (ctx: ProgramContext, spec: string | Omit<PeerRecord, "id">) => {
			const parsed = typeof spec === "string" ? JSON.parse(spec) : spec;
			return await doAdd(parsed, ctx);
		},
		list: async (ctx: ProgramContext, filter?: string | { kind?: string; trust_level?: string }) => {
			const parsed = typeof filter === "string" ? (filter ? JSON.parse(filter) : undefined) : filter;
			return await doList(parsed, ctx);
		},
		get: async (ctx: ProgramContext, input: string | { peer_id: string }) => {
			const peerId = typeof input === "string" ? input : input?.peer_id;
			if (!peerId) throw new Error("peer.get: peer_id required");
			return await doGet(peerId, ctx);
		},
		findOrCreate: async (
			ctx: ProgramContext,
			externalKeyOrInput: string | { external_key: string; external_value: string; defaults?: Partial<Omit<PeerRecord, "id">> },
			externalValue?: string,
			defaults?: string | Partial<Omit<PeerRecord, "id">>,
		) => {
			if (typeof externalKeyOrInput === "object") {
				const inp = externalKeyOrInput;
				return await doFindOrCreate(inp.external_key, inp.external_value, inp.defaults ?? {}, ctx);
			}
			const parsed = typeof defaults === "string" ? (defaults ? JSON.parse(defaults) : {}) : (defaults ?? {});
			return await doFindOrCreate(externalKeyOrInput, externalValue ?? "", parsed, ctx);
		},
		setTrust: async (ctx: ProgramContext, peerIdOrInput: string | { peer_id: string; level: string }, level?: string) => {
			if (typeof peerIdOrInput === "object") {
				await doSetTrust(peerIdOrInput.peer_id, peerIdOrInput.level, ctx);
			} else {
				if (!level) throw new Error("peer.setTrust: level required");
				await doSetTrust(peerIdOrInput, level, ctx);
			}
			return { ok: true };
		},
		setField: async (ctx: ProgramContext, peerIdOrInput: string | { peer_id: string; key: string; value: string }, key?: string, value?: string) => {
			if (typeof peerIdOrInput === "object") {
				await doSetField(peerIdOrInput.peer_id, peerIdOrInput.key, peerIdOrInput.value, ctx);
			} else {
				if (!key || value === undefined) throw new Error("peer.setField: key and value required");
				await doSetField(peerIdOrInput, key, value, ctx);
			}
			return { ok: true };
		},
		remove: async (ctx: ProgramContext, input: string | { peer_id: string }) => {
			const peerId = typeof input === "string" ? input : input?.peer_id;
			if (!peerId) throw new Error("peer.remove: peer_id required");
			await doRemove(peerId, ctx);
			return { ok: true };
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;
