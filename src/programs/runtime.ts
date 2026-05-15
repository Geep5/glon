/**
 * Program runtime — loads, compiles, and manages program objects.
 *
 * Programs are Glon objects of type "program" with a `manifest` field
 * (ValueMap) mapping filenames to source strings. The `entry` field names
 * the module that `export default`s the program definition. Bundled at
 * load time via esbuild.
 *
 * Programs may export:
 *   - `handler(cmd, args, ctx)` — CLI command handler
 *   - `actor` — actor definition with state, actions, lifecycle, tick
 *   - `validator(changes)` — DAG change validator per object type
 *   - `validatedTypes` — array of type keys the validator applies to
 */

import type { Value, Change, ObjectRef } from "../proto.js";

import { decodeSignature } from "../proto.js";

import { canonicalEncodeChangeForSigning } from "../det/canonical.js";
import { verify as ed25519Verify } from "../det/ed25519.js";

import * as proto from "../proto.js";
import * as swarmHost from "../swarm-host.js";
import * as autobaseHost from "../autobase-host.js";

import type { ObjectState } from "../dag/dag.js";

import { style } from "./shared.js";
	import * as sharedMod from "./shared.js";
import * as cryptoMod from "../crypto.js";
import * as detCanonical from "../det/canonical.js";

// ── Minimal JSON Schema validator ───────────────────────────────

function validateSchema(value: unknown, schema: Record<string, unknown>, path = ""): string | null {
	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return `${path || "root"} must be an object`;
		}
		const obj = value as Record<string, unknown>;
		const required = (schema.required as string[]) ?? [];
		for (const key of required) {
			if (!(key in obj)) {
				return `${path || "root"}.${key} is required`;
			}
		}
		const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
		if (props) {
			for (const [key, subSchema] of Object.entries(props)) {
				if (key in obj) {
					const err = validateSchema(obj[key], subSchema, `${path || "root"}.${key}`);
					if (err) return err;
				}
			}
		}
		return null;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) {
			return `${path || "root"} must be an array`;
		}
		const itemSchema = schema.items as Record<string, unknown> | undefined;
		if (itemSchema) {
			for (let i = 0; i < value.length; i++) {
				const err = validateSchema(value[i], itemSchema, `${path || "root"}[${i}]`);
				if (err) return err;
			}
		}
		return null;
	}
	if (schema.type === "string") {
		if (typeof value !== "string") return `${path || "root"} must be a string`;
		return null;
	}
	if (schema.type === "number") {
		if (typeof value !== "number") return `${path || "root"} must be a number`;
		return null;
	}
	if (schema.type === "integer") {
		if (typeof value !== "number" || !Number.isInteger(value)) return `${path || "root"} must be an integer`;
		return null;
	}
	if (schema.type === "boolean") {
		if (typeof value !== "boolean") return `${path || "root"} must be a boolean`;
		return null;
	}
	return null;
	}

	import * as detMath from "../det/math.js";

import * as detEd25519 from "../det/ed25519.js";
import * as det from "../det/index.js";
import * as esbuild from "esbuild";


/** Context passed to all program code (handlers, actor actions, ticks). */
export interface ProgramContext {
	// Rivet client for actor calls
	client: unknown;
	store: unknown;
	resolveId: (prefix: string) => Promise<string | null>;

	// Proto value constructors
	stringVal: (s: string) => Value;
	intVal: (n: number) => Value;
	floatVal: (n: number) => Value;
	boolVal: (b: boolean) => Value;
	mapVal: (entries: Record<string, Value>) => Value;
	listVal: (items: Value[]) => Value;
	linkVal: (targetId: string, relationKey: string) => Value;
	displayValue: (v: Value) => string;

	// Disk (read-only)
	listChangeFiles: () => string[];
	readChangeByHex: (hex: string) => Change | null;
	hexEncode: (bytes: Uint8Array) => string;

	// Output
	print: (msg: string) => void;


	// Styling
	style: typeof style;

	// Utils
	randomUUID: () => string;

	// ── Program actor extensions ──

	/** Program's persistent state (read/write, survives restarts). */
	state: Record<string, any>;

	/** Emit structured data to subscribers (web frontend, CLI). */
	emit: (channel: string, data: any) => void;

	/** Program identity. */
	programId: string;

	/** Get an object actor handle by ID. */
	objectActor: (id: string, opts?: { createWithInput?: unknown }) => unknown;

	/**
		 * Dispatch an action on another program's actor by prefix.
		 * Throws if no program is running at that prefix or the action is unknown.
		 */
		dispatchProgram: (prefix: string, action: string, args: unknown[]) => Promise<unknown>;

		/** Typed dispatch: passes a single input object to a typedAction handler. */
		dispatchTypedAction: <T = unknown>(prefix: string, action: string, input: T) => Promise<unknown>;
	}

	/** Validation result returned by program validators. */
	export interface ValidationResult {
		valid: boolean;
		error?: string;
	}

	/** Typed action definition with optional JSON Schema validation. */
	export interface ActionDef<TInput = unknown, TOutput = unknown> {
		/** Human-readable description for docs / tool registries. */
		description?: string;
		/** JSON Schema for the single input argument (default: any). */
		inputSchema?: Record<string, unknown>;
		/** Handler receiving (ctx, input). */
		handler: (ctx: ProgramContext, input: TInput) => Promise<TOutput> | TOutput;
	}

	/** Context passed to validators during cross-object batch validation. */
	export interface BatchValidationContext {
		/** All changes in the batch, across all objects. */
		allChanges: Change[];
		/** Hex-encoded Ed25519 pubkey of the signer (from auth extension), if all changes share one. */
		signerPubkey?: string;
	}

	/** A program validator function. Receives changes for its object plus optional batch context. */
	export type ValidatorFn = (changes: Change[], context?: BatchValidationContext) => ValidationResult;

	/** Shape of a program's actor definition (exported from module programs). */
	export interface ProgramActorDef {
		createState?: () => Record<string, any>;
		onCreate?: (ctx: ProgramContext) => Promise<void> | void;
		onDestroy?: (ctx: ProgramContext) => Promise<void> | void;
		/** Legacy untyped actions map. */
		actions?: Record<string, (ctx: ProgramContext, ...args: any[]) => any>;
		/** Typed actions with optional schema metadata. */
		typedActions?: Record<string, ActionDef>;
		tickMs?: number;
		onTick?: (ctx: ProgramContext) => Promise<void> | void;
	}

/** Full program definition (exported from module programs via `export default`). */
export interface ProgramDef {
	handler?: (cmd: string, args: string[], ctx: ProgramContext) => Promise<void> | void;
	actor?: ProgramActorDef;
	validator?: ValidatorFn;
	validatedTypes?: string[];
	/**
		/**
		 * If `true`, every type in `validatedTypes` is a chain-mode type:
		 * the kernel requires `authExtension` on every Change and verifies the
		 * signature before the program's validator runs. Direct mutations
		 * (setField, addBlock, etc.) on chain-mode objects are rejected;
		 * callers must construct a signed Change and submit via pushChanges.
		 */
		chainMode?: boolean;
}

/** A loaded program ready for dispatch. */
export interface ProgramEntry {
	id: string;
	prefix: string;
	name: string;
	commands: Record<string, string>;
	/** CLI handler. */
	handler: (cmd: string, args: string[], ctx: ProgramContext) => Promise<void>;
	/** Full definition. */
	def: ProgramDef | null;
}

/** Live state of a running program actor. */
export interface ProgramActorInstance {
	programId: string;
	prefix: string;
	def: ProgramActorDef;
	state: Record<string, any>;
	tickHandle: ReturnType<typeof setInterval> | null;
}

// ── Module set types ────────────────────────────────────────────

interface ModuleSet {
	entry: string;
	modules: Map<string, string>; // filename → source
}

// ── Field extraction helpers ────────────────────────────────────

/** Extract a plain string from a proto field (raw string or Value wrapper). */
function extractString(field: unknown): string | undefined {
	if (field == null) return undefined;
	if (typeof field === "string") return field;
	if (typeof field === "object" && "stringValue" in (field as any)) {
		return (field as any).stringValue as string;
	}
	return undefined;
}

/** Extract a commands map from a field (plain object or proto ValueMap). */
function extractCommands(field: unknown): Record<string, string> {
	if (field == null) return {};
	if (typeof field === "object" && "mapValue" in (field as any)) {
		const entries = (field as any).mapValue?.entries;
		if (!entries || typeof entries !== "object") return {};
		const result: Record<string, string> = {};
		for (const [key, val] of Object.entries(entries)) {
			const s = extractString(val);
			if (s !== undefined) result[key] = s;
		}
		return result;
	}
	if (typeof field === "object") {
		const result: Record<string, string> = {};
		for (const [key, val] of Object.entries(field as Record<string, unknown>)) {
			const s = typeof val === "string" ? val : extractString(val);
			if (s !== undefined) result[key] = s;
		}
		return result;
	}
	return {};
}

/** Extract a string→string map from a ValueMap field. */
function extractStringMap(field: unknown): Map<string, string> {
	const result = new Map<string, string>();
	if (field == null) return result;
	if (typeof field === "object" && "mapValue" in (field as any)) {
		const entries = (field as any).mapValue?.entries;
		if (entries && typeof entries === "object") {
			for (const [key, val] of Object.entries(entries)) {
				const s = extractString(val);
				if (s !== undefined) result.set(key, s);
			}
		}
	}
	return result;
}

/** Extract a string array from a ValueList field. */
function extractStringArray(field: unknown): string[] {
	if (field == null) return [];
	if (Array.isArray(field)) return field.filter(v => typeof v === "string");
	if (typeof field === "object" && "listValue" in (field as any)) {
		const items = (field as any).listValue?.values;
		if (Array.isArray(items)) {
			return items.map((v: any) => extractString(v)).filter((s): s is string => s !== undefined);
		}
	}
	return [];
}

// ── Module bundler ──────────────────────────────────────────────

/**
 * Bundle a module set into a single evaluable string using esbuild.
 *
 * The entry module's `export default` becomes `module.exports.default`
 * after bundling. We wrap the bundle in a function that returns the exports.
 */
async function bundleModuleSet(ms: ModuleSet): Promise<string> {
	// esbuild virtual filesystem plugin
	const virtualPlugin: esbuild.Plugin = {
		name: "glon-virtual",
		setup(build) {
			// Resolve bare specifiers to virtual paths
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind === "entry-point") {
					return { path: args.path, namespace: "glon" };
				}
				// Resolve relative imports within the module set.
				// TypeScript ESM writes `import … from "./foo.js"` even when the source
				// file on disk is `foo.ts`, so we try both extension swaps before giving up.
				const resolved = args.path.replace(/^\.\//, "");
				const candidates = [
					resolved,
					resolved + ".ts",
					resolved + ".js",
					resolved.endsWith(".js") ? resolved.slice(0, -3) + ".ts" : null,
					resolved.endsWith(".ts") ? resolved.slice(0, -3) + ".js" : null,
				].filter((c): c is string => !!c);
				for (const c of candidates) {
					if (ms.modules.has(c)) {
						return { path: c, namespace: "glon" };
					}
				}
				// External — let it pass through (will be available at runtime via ctx)
				return { external: true };
			});

			build.onLoad({ filter: /.*/, namespace: "glon" }, (args) => {
				const source = ms.modules.get(args.path);
				if (source === undefined) {
					return { errors: [{ text: `Module not found: ${args.path}` }] };
				}
				const loader = args.path.endsWith(".ts") ? "ts" as const : "js" as const;
				return { contents: source, loader };
			});
		},
	};

	const result = await esbuild.build({
		entryPoints: [ms.entry],
		bundle: true,
		write: false,
		format: "cjs",
		platform: "node",
		target: "es2022",
		plugins: [virtualPlugin],
		// Don't fail on missing externals — they're runtime-provided
		logLevel: "silent",
	});

	if (result.errors.length > 0) {
		throw new Error(`esbuild errors: ${result.errors.map(e => e.text).join(", ")}`);
	}

	const bundled = result.outputFiles[0].text;

	// Wrap: the bundled CJS code uses `require()` for external imports.
	// We inject a `require` shim that maps kernel module paths to actual
	// modules provided at eval-time via `arguments[0]` (the externals map).
	return `
		var __externals = arguments[0];
		var __nodeRequire = arguments[1];
		var module = { exports: {} };
		var exports = module.exports;
		var require = function(id) {
			var key = id.replace(/^(\\.\\.\\/)+/, "").replace(/^\\.\\//, "");
			if (__externals[key]) return __externals[key];
			if (__externals[id]) return __externals[id];
			// Node built-ins: only \`node:\`-prefixed imports are allowed through.
			// Programs that want child_process/fs/etc must import them explicitly
			// with the \`node:\` prefix to avoid ambiguity with DAG-provided modules.
			if (__nodeRequire && id.indexOf("node:") === 0) {
				return __nodeRequire(id);
			}
			throw new Error("Cannot resolve module: " + id);
		};
		${bundled}
		return module.exports;
	`;
}

// ── Compilation ─────────────────────────────────────────────────

/**
 * Compile a module-set program (esbuild bundle + eval).
 * The entry module must `export default` a ProgramDef.
 */
async function compileModuleProgram(ms: ModuleSet, name: string): Promise<ProgramDef | null> {
	try {
		const bundled = await bundleModuleSet(ms);
		// Provide kernel modules so bundled CJS `require()` calls resolve.
		const externals: Record<string, unknown> = {
			"proto.js": proto,
			"crypto.js": cryptoMod,
			"det/canonical.js": detCanonical,
			"det/math.js": detMath,
			"det/ed25519.js": detEd25519,
			"det/index.js": det,
			"shared.js": sharedMod,
			"runtime.js": { registerIndexHook, getIndexHook, registerAuthVerifier, getAuthVerifier, getValidator, isChainModeType, registerContentHandler, registerActorContentHandler, getContentHandler },
			// swarm-host's hyperswarm instance is owned by the daemon; bundled
			// programs reach it through this external instead of importing the
			// hyperswarm npm package (which has native deps that can't bundle).
			"swarm-host.js": swarmHost,
			// autobase-host: same reason. corestore/autobase/hyperbee pull in
			// sodium-native; we keep them at the Node level and expose a
			// thin JSON-typed API to bundled programs.
			"autobase-host.js": autobaseHost,
		};
		const factory = new Function(bundled);
		// Node built-ins go through the real require, scoped to node: prefix only
		// (see the shim in bundleModuleSet).
		const { createRequire } = await import("node:module");
		const nodeRequire = createRequire(import.meta.url);
		const exports = factory(externals, nodeRequire);
		const def: ProgramDef = exports.default ?? exports;

		// Validate shape
		if (!def || (typeof def !== "object")) {
			console.warn(`[program] "${name}" does not export a valid program definition`);
			return null;
		}
		return def;
	} catch (err: any) {
		console.warn(`[program] Failed to bundle "${name}": ${err.message}`);
		return null;
	}
}

// ── Manifest extraction ─────────────────────────────────────────

/**
 * Extract a ModuleSet from a program object's fields.
 * Returns null if no manifest or manifest is invalid.
 */
async function extractModuleSet(
	fields: Record<string, unknown>,
	store: { get: (...args: any[]) => any },
): Promise<ModuleSet | null> {
	const manifestField = fields.manifest;
	if (!manifestField) return null;

	const entry = extractString(
		typeof manifestField === "object" && "mapValue" in (manifestField as any)
			? (manifestField as any).mapValue?.entries?.entry
			: (manifestField as any)?.entry
	);
	if (!entry) return null;

	// Extract modules map
	const modulesField =
		typeof manifestField === "object" && "mapValue" in (manifestField as any)
			? (manifestField as any).mapValue?.entries?.modules
			: (manifestField as any)?.modules;

	const moduleRefs = extractStringMap(modulesField);
	if (moduleRefs.size === 0) return null;

	const modules = new Map<string, string>();

	for (const [filename, ref] of moduleRefs) {
		// ref is either inline base64 source or a Glon object ID
		if (ref.length > 40) {
			// Likely base64 inline source
			try {
				modules.set(filename, Buffer.from(ref, "base64").toString("utf-8"));
			} catch {
				modules.set(filename, ref); // treat as raw source
			}
		} else {
			// Object ID reference — load content from store
			try {
				const obj = await store.get(ref);
				if (obj?.content) {
					modules.set(filename, Buffer.from(obj.content, "base64").toString("utf-8"));
				}
			} catch {
				console.warn(`[program] Failed to load module "${filename}" (ref: ${ref})`);
			}
		}
	}

	if (!modules.has(entry)) {
		console.warn(`[program] Entry module "${entry}" not found in manifest`);
		return null;
	}

	return { entry, modules };
}

// ── Validator registry ──────────────────────────────────────────

const validators = new Map<string, ValidatorFn>();
const chainModeTypes = new Set<string>();

/** Register a validator for one or more type keys. */
function registerValidator(typeKeys: string[], fn: ValidatorFn): void {
	for (const key of typeKeys) {
		validators.set(key, fn);
	}
}

/** Mark each type key as chain-mode (requires signed Changes). */
function registerChainModeTypes(typeKeys: string[]): void {
	for (const key of typeKeys) chainModeTypes.add(key);
}

/** Get the validator for a given type key (if any). */
export function getValidator(typeKey: string): ValidatorFn | undefined {
	return validators.get(typeKey);
}

/** Whether a typeKey participates in chain consensus (signature gate, validator dispatch). */
export function isChainModeType(typeKey: string): boolean {
	return chainModeTypes.has(typeKey);
}


// ── Index hook registry ─────────────────────────────────────────

/** Type-specific index hook: called by the kernel after indexing an object's
 *  generic state (objects table + links table). Programs register hooks for
 *  their type keys; the kernel dispatches by type_key without hardcoding. */
export type IndexHookFn = (c: any, computed: ObjectState) => Promise<void>;

const indexHooks = new Map<string, IndexHookFn>();

/** Register an index hook for one or more type keys. */
export function registerIndexHook(typeKeys: string[], fn: IndexHookFn): void {
	for (const key of typeKeys) indexHooks.set(key, fn);
}

/** Get the index hook for a given type key (if any). */
export function getIndexHook(typeKey: string): IndexHookFn | undefined {
	return indexHooks.get(typeKey);
}


// ── Auth verifier registry ──────────────────────────────────────

/** Verifier for a specific auth extension type. Receives the Change and its
 *  payload; returns true if the auth is cryptographically valid.
 *  The canonical bytes (with id and payload zeroed) are computed internally. */
export type AuthVerifierFn = (change: Change, payload: Uint8Array) => boolean;

const authVerifiers = new Map<string, AuthVerifierFn>();

/** Register an auth verifier for an auth extension type (e.g. "ed25519"). */
export function registerAuthVerifier(type: string, fn: AuthVerifierFn): void {
	authVerifiers.set(type, fn);
}

/** Get the auth verifier for a given type (if any). */
export function getAuthVerifier(type: string): AuthVerifierFn | undefined {
	return authVerifiers.get(type);
}


// Built-in Ed25519 verifier: payload is a serialized Signature message.
// pubkey, nonce, fee are committed; signature is verified against canonical bytes.
registerAuthVerifier("ed25519", (change, payload) => {
	try {
		const s = decodeSignature(payload);
		if (!s.pubkey || s.pubkey.length !== 32) return false;
		if (!s.signature || s.signature.length !== 64) return false;
		const signingBytes = canonicalEncodeChangeForSigning(change);
		return ed25519Verify(s.pubkey, signingBytes, s.signature);
	} catch {
		return false;
	}
});


// ── Content handler registry ────────────────────────────────────

/** Handler for incoming transport blobs by content_type.
 *  Receives the decoded TransportEnvelope + parsed payload.
 *  `blobMeta` carries transport-level metadata that isn't part of the
 *  signed envelope — most importantly `fromEndpoint`, the address the
 *  blob arrived from (e.g. `gmail://alice@example.com`). Optional so
 *  legacy handlers can ignore it.
 *  Returns true if handled, false to fall through. */
export interface ContentHandlerBlobMeta {
	fromEndpoint?: string;
	receivedAt?: number;
	transportMetadata?: Record<string, string>;
}
export type ContentHandlerFn = (
	envelope: { contentType: string; payload: Uint8Array; senderPubkey: Uint8Array; metadata: Record<string, string> },
	ctx: ProgramContext,
	blobMeta?: ContentHandlerBlobMeta,
) => Promise<boolean>;

const contentHandlers = new Map<string, ContentHandlerFn>();

/**
 * Register a handler for a content_type string (e.g. "glon/change-bundle").
 *
 * ⚠️  GOTCHA — the handler is invoked from `/transport-router`'s tick with
 *     `/transport-router`'s `ctx`. Any `ctx.state` mutation lands on the
 *     router's state, and `persistIfChanged`-style writes go to the router's
 *     actor — NOT the program you think you're writing for. We hit this with
 *     /directory's peer-request handlers (commit 5215330) and lost incoming
 *     requests until envelopes were re-routed through /directory's actor.
 *
 * If your handler MUTATES PERSISTED STATE, prefer `registerActorContentHandler`
 * below — it dispatches into your program's actor for you. Use the raw
 * `registerContentHandler` only for stateless processing (e.g. logging,
 * routing-by-metadata to another program).
 */
export function registerContentHandler(contentType: string, fn: ContentHandlerFn): void {
	contentHandlers.set(contentType, fn);
}

/**
 * Register a content handler that ROUTES THROUGH an actor program's typed
 * action — the only safe shape for handlers that mutate persisted state.
 *
 * On every incoming envelope of `contentType`, the router will call
 * `ctx.dispatchProgram(programPrefix, action, [{ envelope_b64, content_type, from }])`
 * which executes the action with the OWNING program's `ctx.state` and
 * `ctx.programId`, so `persistIfChanged` writes land on the right actor.
 *
 * Requirements on the program side:
 *   - Define a typed action with this input shape:
 *       { envelope_b64: string; content_type?: string; from?: string }
 *   - In the action body, base64-decode envelope_b64, parse JSON, then
 *     update state and call your own persist helper.
 *
 * Example (in your program's actorDef.typedActions):
 *
 *     handleChat: {
 *       inputSchema: { type: "object", required: ["envelope_b64"], properties: {
 *         envelope_b64: { type: "string" },
 *         content_type: { type: "string" },
 *         from: { type: "string" },
 *       }},
 *       handler: async (ctx, input) => {
 *         const body = JSON.parse(Buffer.from(input.envelope_b64, "base64").toString("utf8"));
 *         ctx.state.messages = ctx.state.messages ?? [];
 *         ctx.state.messages.push({ ...body, from: input.from });
 *         await persistIfChanged(ctx.state, ctx);
 *         return true;
 *       },
 *     },
 *
 * And the registration is one line:
 *
 *     registerActorContentHandler("glon/peer-chat", "/peer-chat", "handleChat");
 */
export function registerActorContentHandler(
	contentType: string,
	programPrefix: string,
	action: string,
): void {
	contentHandlers.set(contentType, async (envelope, ctx, blobMeta) => {
		try {
			await ctx.dispatchProgram(programPrefix, action, [{
				envelope_b64: Buffer.from(envelope.payload).toString("base64"),
				content_type: envelope.contentType,
				from: blobMeta?.fromEndpoint,
			}]);
			return true;
		} catch (err: any) {
			// Program not running, action missing, schema validation, etc.
			// Drop the envelope rather than invoking anything with the wrong
			// ctx — that's the exact failure mode this helper exists to
			// prevent.
			ctx.print?.(`[content-router] dispatch ${programPrefix}.${action} failed: ${err?.message ?? String(err)}`);
			return false;
		}
	});
}

/** Get the handler for a content type (if any). */
export function getContentHandler(contentType: string): ContentHandlerFn | undefined {
	return contentHandlers.get(contentType);
}

// ── Program actor instances ─────────────────────────────────────

const actorInstances = new Map<string, ProgramActorInstance>();

/** Get a running program actor instance by program ID. */
export function getProgramActor(programId: string): ProgramActorInstance | undefined {
	return actorInstances.get(programId);
}

/** Get a running program actor instance by prefix. */
export function getProgramActorByPrefix(prefix: string): ProgramActorInstance | undefined {
	for (const inst of actorInstances.values()) {
		if (inst.prefix === prefix) return inst;
	}
	return undefined;
}
/** List all running program actor instances. */
export function listProgramActors(): Array<{ programId: string; prefix: string; tickMs: number | null; hasTick: boolean }> {
	return Array.from(actorInstances.values()).map((inst) => ({
		programId: inst.programId,
		prefix: inst.prefix,
		tickMs: inst.def.tickMs ?? null,
		hasTick: !!inst.tickHandle,
	}));
}

	/** Start a program actor instance. */
	export async function startProgramActor(
		entry: ProgramEntry,
		makeCtx: (state: Record<string, any>) => ProgramContext,
		client?: any,
	): Promise<ProgramActorInstance | null> {
		const actorDef = entry.def?.actor;
		if (!actorDef) return null;

		const state = actorDef.createState?.() ?? {};
		const instance: ProgramActorInstance = {
			programId: entry.id,
			prefix: entry.prefix,
			def: actorDef,
			state,
			tickHandle: null,
		};

		// Ensure the RivetKit program actor exists with the correct programId.
		// This lets external HTTP callers dispatch through the actor gateway.
		if (client?.programActor) {
			try {
				await client.programActor.getOrCreate([entry.id], {
					createWithInput: { programId: entry.id } as any,
				});
			} catch {
				// Non-fatal: the local instance still works for CLI use.
			}
		}

	// Run onCreate
	if (actorDef.onCreate) {
		try {
			await actorDef.onCreate(makeCtx(state));
		} catch (err: any) {
			console.warn(`[program] "${entry.name}" onCreate failed: ${err.message}`);
		}
	}

	// Start tick loop
	if (actorDef.tickMs && actorDef.onTick) {
		const tickFn = actorDef.onTick;
		instance.tickHandle = setInterval(async () => {
			try {
				await tickFn(makeCtx(state));
			} catch (err: any) {
				console.warn(`[program] "${entry.name}" onTick error: ${err.message}`);
			}
		}, actorDef.tickMs);
	}

	actorInstances.set(entry.id, instance);
	return instance;
}

/** Stop a program actor instance. */
export async function stopProgramActor(
	programId: string,
	makeCtx: (state: Record<string, any>) => ProgramContext,
): Promise<void> {
	const instance = actorInstances.get(programId);
	if (!instance) return;

	if (instance.tickHandle) {
		clearInterval(instance.tickHandle);
		instance.tickHandle = null;
	}

	if (instance.def.onDestroy) {
		try {
			await instance.def.onDestroy(makeCtx(instance.state));
		} catch (err: any) {
			console.warn(`[program] onDestroy failed: ${err.message}`);
		}
	}

	actorInstances.delete(programId);
}

/** Dispatch an action to a program actor. */
export async function dispatchActorAction(
	programId: string,
	action: string,
	args: any[],
	makeCtx: (state: Record<string, any>) => ProgramContext,
): Promise<any> {
	const instance = actorInstances.get(programId);
	if (!instance) throw new Error(`No running program actor: ${programId}`);

	// Prefer typedActions over legacy actions.
	const typed = instance.def.typedActions?.[action];
	if (typed) {
		// typedActions receive a single input object as args[0]. Coerce
		// undefined → {} when the schema expects an object so no-arg
		// actions (status, list, tick, …) work without callers having
		// to pass a placeholder `[{}]`.
		let input = args[0];
		if (input === undefined && (typed.inputSchema as { type?: string } | undefined)?.type === "object") {
			input = {};
		}
		if (typed.inputSchema) {
			const err = validateSchema(input, typed.inputSchema);
			if (err) throw new Error(`Schema validation failed for action "${action}": ${err}`);
		}
		return await typed.handler(makeCtx(instance.state), input);
	}

	const actionFn = instance.def.actions?.[action];
	if (!actionFn) throw new Error(`Unknown action "${action}" on program ${instance.prefix}`);

	return await actionFn(makeCtx(instance.state), ...args);
}

// ── Loader ──────────────────────────────────────────────────────

/**
 * Load all program objects from the store and compile their handlers.
 *
 * - Legacy programs (no manifest): eval'd as function body
 * - Module programs (manifest field): bundled via esbuild, export default
 *
 * Also registers validators and prepares actor definitions.
 */
export async function loadPrograms(
	store: { list: (...args: any[]) => any; get: (...args: any[]) => any },
	client: unknown,
): Promise<ProgramEntry[]> {
	const refs = await store.list("program");
	const programs: ProgramEntry[] = [];

	// Clear previous validator and chain-mode registrations.
	validators.clear();
	chainModeTypes.clear();

	for (const ref of refs) {
		let obj: any;
		try {
			obj = await store.get(ref.id);
		} catch {
			continue;
		}
		if (!obj) continue;

		const fields: Record<string, unknown> = obj.fields ?? {};

		const prefix = extractString(fields.prefix);
		if (!prefix) continue;

		const name = extractString(fields.name) ?? prefix;
		const commands = extractCommands(fields.commands);

		// Extract and compile the module set
		const moduleSet = await extractModuleSet(fields, store);
		if (!moduleSet) continue;

		const def = await compileModuleProgram(moduleSet, name);
		if (!def) continue;

		if (!def) continue;

		// Register validator if present
		if (def.validator && def.validatedTypes?.length) {
			registerValidator(def.validatedTypes, def.validator);
		}
		if (def.chainMode && def.validatedTypes?.length) {
			registerChainModeTypes(def.validatedTypes);
		}

		// Build the handler: prefer def.handler, fall back to actor dispatch help text
		const handler = def.handler
			? async (cmd: string, args: string[], ctx: ProgramContext) => {
					try {
						await def!.handler!(cmd, args, ctx);
					} catch (err: any) {
						ctx.print("Error: " + (err.message ?? String(err)));
					}
				}
			: async (_cmd: string, _args: string[], ctx: ProgramContext) => {
					// Actor-only program with no CLI handler — list available actions
					const actions = def?.actor?.actions;
					if (actions) {
						ctx.print(`Actions: ${Object.keys(actions).join(", ")}`);
					} else {
						ctx.print(`Program "${name}" has no CLI handler.`);
					}
				};

		programs.push({ id: ref.id, prefix, name, commands, handler, def });
	}

	return programs;
}

// ── Dispatcher ──────────────────────────────────────────────────

/**
 * Dispatch a raw command line to the matching program.
 *
 * For programs with an actor definition, routes subcommand to the actor's
 * named actions. For legacy programs, calls the handler directly.
 *
 * Returns true if a program handled the input, false otherwise.
 */
export async function dispatchProgram(
	programs: ProgramEntry[],
	input: string,
	ctx: ProgramContext,
): Promise<boolean> {
	// Ensure input is a string (fix for piped/scripted input)
	if (typeof input !== 'string') {
		console.error(`[dispatch] Invalid input type: ${typeof input}`);
		return false;
	}
	const tokens = input.split(/\s+/);
	const cmd = tokens[0];
	if (!cmd) return false;

	const allArgs = tokens.slice(1);

	const program = programs.find((p) => p.prefix === cmd);
	if (!program) return false;

	// If program has a running actor and the subcommand matches an action, dispatch to actor
	const instance = getProgramActorByPrefix(cmd);
	if (instance) {
		const subCmd = allArgs[0];
		if (subCmd && instance.def.actions?.[subCmd]) {
			try {
				const result = await dispatchActorAction(
					instance.programId,
					subCmd,
					allArgs.slice(1),
					(state) => ({ ...ctx, state, programId: instance.programId }),
				);
				if (result !== undefined) {
					ctx.print(typeof result === "string" ? result : JSON.stringify(result, null, 2));
				}
			} catch (err: any) {
				ctx.print("Error: " + (err.message ?? String(err)));
			}
			return true;
		}
	}

	// Fall through to handler
	await program.handler(allArgs[0] ?? "", allArgs.slice(1), ctx);
	return true;
}
