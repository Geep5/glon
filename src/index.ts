/**
 * Glon — actor registry.
 *
 * Three actors: objectActor (one per object, sync peer), storeActor
 * (singleton coordinator with SQLite index), and programActor
 * (one per running program, manages state + tick loops).
 * Changes live on disk as .pb files; actors compute state from disk on every wake.
 * Architecture (per Rivet best practices):
 *   state  → minimal persistent data (id, inbox/outbox)
 *   vars   → computed from disk on every wake (fields, blocks, heads, etc.)
 *   disk   → .pb change files, source of truth
 *   SQLite → derived index in the store actor
 *
 * Rivet requires the registry in scope for c.client<typeof app>().
 */

import "./env.js"; // side-effect: load .env into process.env before anything reads it
import { actor, event, setup } from "rivetkit";
import { db } from "rivetkit/db";
import type { Change, Operation, Value, ObjectRef, Block, ObjectLink } from "./proto.js";
import { encodeChange, encodeChangeForHashing, decodeChange, stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue } from "./proto.js";
import { sha256, hexEncode, hexDecode, generateObjectId } from "./crypto.js";
	import {
		createChange,
		createGenesisChange,
		createFieldChange,
		createDeleteChange,
		changeId,
	} from "./dag/change.js";

import { computeState, findHeads, toSnapshot, getPrimaryContent, type ObjectState, type BlockProvenance } from "./dag/dag.js";
import { initDisk, writeChange, readChangeByHex, listChangeFilesForObject, deleteChangesForObject, diskStats } from "./disk.js";

	import { decodeSignature } from "./proto.js";
	import { getValidator, isChainModeType, getIndexHook, getAuthVerifier } from "./programs/runtime.js";
	import type { BatchValidationContext } from "./programs/runtime.js";
	import { canonicalEncodeChange, canonicalEncodeChangeForSigning } from "./det/canonical.js";
	import { verify as ed25519Verify } from "./det/ed25519.js";
import { style } from "./programs/shared.js";
import {
	assertPortAvailable,
	clearEndpointLockfile,
	desiredPort,
	writeEndpointLockfile,
} from "./endpoint.js";

// ── Types ────────────────────────────────────────────────────────

interface IpcMessage {
	fromId: string;
	toId: string;
	action: string;
	payload: string;
	timestamp: number;
}

// Persistent state — survives sleep, crash, restart.
// Minimal: just identity + IPC queues.
interface ObjectActorState {
	id: string;
	inbox: IpcMessage[];
	outbox: IpcMessage[];
}

// Ephemeral vars — recomputed from disk on every wake.
// This is the computed state derived from replaying the Change DAG.
interface ObjectVars {
	typeKey: string;
	fields: Record<string, any>;
	content: string; // base64
	blocks: any[];
	blockProvenance: Record<string, { changeId: string; author: string; timestamp: number }>;
	deleted: boolean;
	createdAt: number;
	updatedAt: number;
	headIds: string[];
	changeCount: number;
}

export interface ObjectInput {
	id: string;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Load all changes for an object from disk and compute state. */
function loadFromDisk(objectId: string): { state: ObjectState; changeCount: number } | null {
	const hexIds = listChangeFilesForObject(objectId);
	const changes: Change[] = [];
	for (const hexId of hexIds) {
		const change = readChangeByHex(hexId, objectId);
		if (change) changes.push(change);
	}
	if (changes.length === 0) return null;
	return { state: computeState(changes), changeCount: changes.length };
}

/** Convert ObjectState into the vars shape (Maps → Records, bytes → base64). */
function computedToVars(computed: ObjectState, changeCount: number): ObjectVars {
	const fields: Record<string, any> = {};
	for (const [k, v] of computed.fields) fields[k] = v;

	const blockProvenance: Record<string, { changeId: string; author: string; timestamp: number }> = {};
	for (const [blockId, p] of computed.blockProvenance) {
		blockProvenance[blockId] = {
			changeId: hexEncode(p.changeId),
			author: p.author,
			timestamp: p.timestamp,
		};
	}

	const primary = getPrimaryContent(computed.blocks);
	return {
		typeKey: computed.typeKey,
		fields,
		content: primary ? Buffer.from(primary).toString("base64") : "",
		blocks: computed.blocks,
		blockProvenance,
		deleted: computed.deleted,
		createdAt: computed.createdAt,
		updatedAt: computed.updatedAt,

		headIds: computed.heads.map((h) => hexEncode(h)),
		changeCount,
	};
}

/** Current head IDs as Uint8Array[] from vars. */
function headBytes(c: { vars: ObjectVars }): Uint8Array[] {
	return c.vars.headIds.map((h) => hexDecode(h));
}

/** Write a change to disk, recompute vars from DAG, broadcast. */
function commitChange(c: any, change: Change): void {
	// Local mutators (setField, addBlock, etc.) cannot produce signed
	// Changes — chain-mode objects MUST go through pushChanges with a
	// pre-built signed Change so the kernel can verify the signature.
	if (c.vars.typeKey && isChainModeType(c.vars.typeKey)) {
		throw new Error(
			`commitChange: object ${c.state.id} has chain-mode type ${c.vars.typeKey}; ` +
			`use pushChanges with a signed Change instead of direct mutators`,
		);
	}
	writeChange(change);
	const result = loadFromDisk(c.state.id);
	if (result) {
		Object.assign(c.vars, computedToVars(result.state, result.changeCount));
	}
	c.broadcast("changed", { id: c.state.id, updatedAt: c.vars.updatedAt });
}

// ── Object Actor ─────────────────────────────────────────────────

const objectActor = actor({
	// Persistent state: minimal. Just the object ID and IPC queues.
	createState: (_c, input?: ObjectInput): ObjectActorState => ({
		id: input?.id ?? "",
		inbox: [],
		outbox: [],
	}),

	// Ephemeral vars: recomputed from disk on every wake.
	// This is the computed state derived from replaying the Change DAG.
	createVars: (c): ObjectVars => {
		if (!c.state.id) {
			// Actor not yet initialized (no id). Return empty vars.
			return {
				typeKey: "", fields: {}, content: "", blocks: [],
				blockProvenance: {}, deleted: false, createdAt: 0,
				updatedAt: 0, headIds: [], changeCount: 0,
			};
		}
		initDisk();
		const result = loadFromDisk(c.state.id);
		if (!result) {
			// No changes on disk yet (actor just created, genesis not written yet).
			return {
				typeKey: "", fields: {}, content: "", blocks: [],
				blockProvenance: {}, deleted: false, createdAt: 0,
				updatedAt: 0, headIds: [], changeCount: 0,
			};
		}
		return computedToVars(result.state, result.changeCount);
	},

	events: {
		changed: event<{ id: string; updatedAt: number }>(),
		synced: event<{ id: string; headIds: string[] }>(),
	},

	actions: {
		// ── Read ──────────────────────────────────────────────────
		// Returns the computed state (from vars) + identity (from state).

		read: (c) => ({
			id: c.state.id,
			typeKey: c.vars.typeKey,
			fields: c.vars.fields,
			content: c.vars.content,
			blocks: c.vars.blocks,
			blockProvenance: c.vars.blockProvenance,
			deleted: c.vars.deleted,
			createdAt: c.vars.createdAt,
			updatedAt: c.vars.updatedAt,
			headIds: c.vars.headIds,
			changeCount: c.vars.changeCount,
		}),

		readContent: (c): string => {
			if (!c.vars.content) return "";
			return Buffer.from(c.vars.content, "base64").toString("utf-8");
		},

		// ── Mutation ─────────────────────────────────────────────
		//
		// Every mutation: build Change → write to disk → recompute
		// vars from DAG → broadcast.

		setField: (c, key: string, valueJson: string) => {
			const value: Value = JSON.parse(valueJson);
			const change = createFieldChange(c.state.id, headBytes(c), key, value);
			commitChange(c, change);
		},

		setFields: (c, fieldsJson: string) => {
			const fields: Record<string, Value> = JSON.parse(fieldsJson);
			const ops: Operation[] = Object.entries(fields).map(([key, value]) => ({
				fieldSet: { key, value },
			}));
			const change = createChange(c.state.id, ops, headBytes(c));
			commitChange(c, change);
		},

		setContent: (c, contentBase64: string) => {
			const contentBytes = Buffer.from(contentBase64, "base64");
			const hasContentBlock = c.vars.blocks?.some((b: any) => b.id === "__content__");
			const op: Operation = hasContentBlock
				? {
					blockUpdate: {
						blockId: "__content__",
						content: {
							custom: {
								contentType: "glon/raw",
								data: contentBytes,
								meta: {},
							},
						},
					},
				}
				: {
					blockAdd: {
						parentId: "",
						afterId: "",
						block: {
							id: "__content__",
							childrenIds: [],
							content: {
								custom: {
									contentType: "glon/raw",
									data: contentBytes,
									meta: {},
								},
							},
						},
					},
				};
			const change = createChange(c.state.id, [op], headBytes(c));
			commitChange(c, change);
		},

		deleteField: (c, key: string) => {
			const change = createChange(c.state.id, [{ fieldDelete: { key } }], headBytes(c));
			commitChange(c, change);
		},

		markDeleted: (c) => {
			const change = createDeleteChange(c.state.id, headBytes(c));
			commitChange(c, change);
		},

		addBlock: (c, blockJson: string) => {
			const block: Block = JSON.parse(blockJson);
			const change = createChange(c.state.id, [{ blockAdd: { parentId: "", afterId: "", block } }], headBytes(c));
			commitChange(c, change);
		},
		removeBlock: (c, blockId: string) => {
			const change = createChange(c.state.id, [{ blockRemove: { blockId } }], headBytes(c));
			commitChange(c, change);
		},


		createSnapshot: (c): string => {
			const result = loadFromDisk(c.state.id);
			if (!result) throw new Error("no changes on disk");
			const snapshot = toSnapshot(result.state);
			const change: Change = {
				id: new Uint8Array(0),
				objectId: c.state.id,
				parentIds: headBytes(c),
				ops: [],
				snapshot,
				timestamp: Date.now(),
				author: "local",
			};
			change.id = sha256(encodeChangeForHashing(change));
			commitChange(c, change);
			return hexEncode(change.id);
		},

		// ── Sync protocol ────────────────────────────────────────

		getHeads: (c): string[] => c.vars.headIds,

		getAllChangeIds: (_c, objectId: string): string => {
			return listChangeFilesForObject(objectId).join(",");
		},

		advertiseHeads: (_c, objectId: string, remoteChangeHexIds: string): string => {
			const remoteSet = new Set(remoteChangeHexIds.split(",").filter(Boolean));
			const localIds = listChangeFilesForObject(objectId);
			const localSet = new Set(localIds);
			const missingLocally: string[] = [];
			for (const id of remoteSet) {
				if (!localSet.has(id)) missingLocally.push(id);
			}
			const missingRemotely: string[] = [];
			for (const id of localSet) {
				if (!remoteSet.has(id)) missingRemotely.push(id);
			}
			return missingLocally.join(",") + "|" + missingRemotely.join(",");
		},

		getChanges: (c, hexIds: string): string => {
			const ids = hexIds.split(",").filter(Boolean);
			const results: string[] = [];
			for (const hexId of ids) {
				const change = readChangeByHex(hexId, c.state.id);
				if (change) {
					const encoded = encodeChange(change);
					results.push(Buffer.from(encoded).toString("base64"));
				}
			}
			return results.join(",");
		},

		pushChanges: async (c, changesBase64: string) => {
			initDisk();
			const parts = changesBase64.split(",").filter(Boolean);
			const decoded: Change[] = [];
			for (const b64 of parts) {
				const bytes = Buffer.from(b64, "base64");
				decoded.push(decodeChange(new Uint8Array(bytes)));
			}

			// Resolve type for validator lookup.
			// c.vars.typeKey is empty for brand-new objects whose first change is in this
			// batch — fall back to scanning the batch for an objectCreate so new-object
			// pushes get validated the same as amendments.
			let effectiveTypeKey = c.vars.typeKey;
			if (!effectiveTypeKey) {
				outer: for (const ch of decoded) {
					for (const op of ch.ops ?? []) {
						if (op.objectCreate?.typeKey) {
							effectiveTypeKey = op.objectCreate.typeKey;
							break outer;
						}
					}
				}
			}


			// ── Chain-mode auth gate ───────────────────────────────────
			// Dispatch to registered auth verifiers by extension type.
			if (effectiveTypeKey && isChainModeType(effectiveTypeKey)) {
				for (const change of decoded) {
					if (!change.authExtension) {
						throw new Error(
							`auth gate: chain-mode change for object ${change.objectId} is missing authExtension`,
						);
					}
					const verifier = getAuthVerifier(change.authExtension.type);
					if (!verifier) {
						throw new Error(
							`auth gate: no verifier registered for type "${change.authExtension.type}"`,
						);
					}
					const verified = verifier(change, change.authExtension.payload);
					if (!verified) {
						throw new Error(`auth gate: invalid auth for change in ${change.objectId}`);
					}

					// Content-address check: id MUST equal sha256(canonical(change with id zeroed)).
					const expectedId = sha256(canonicalEncodeChange(change));
					if (hexEncode(expectedId) !== hexEncode(change.id)) {
						throw new Error(`auth gate: change id does not match canonical hash`);
					}
				}
			}


			const validator = getValidator(effectiveTypeKey);
			if (validator) {
				const context: BatchValidationContext = { allChanges: decoded };
				const result = validator(decoded, context);
				if (!result.valid) {
					throw new Error(`Validation rejected: ${result.error}`);
				}
			}

			// Validation passed — write to disk
			for (const change of decoded) {
				writeChange(change);
			}
			const result = loadFromDisk(c.state.id);
			if (result) {
				Object.assign(c.vars, computedToVars(result.state, result.changeCount));
			}
			// Index synced changes in store's SQLite
			const client = c.client<typeof app>();
			const store = client.storeActor.getOrCreate(["root"]);
			for (const change of decoded) {
				await store.indexSyncedChange(
					hexEncode(change.id),
					change.objectId,
					change.timestamp,
					change.parentIds.map(p => hexEncode(p)),
				);
			}
			if (result) {
				await store.indexSyncedObject(
					result.state.id,
					result.state.typeKey,
					result.state.deleted,
					result.state.createdAt,
					result.state.updatedAt,
				);
			}

			if (result) {
				await store.runIndexHook(result.state.id);
			}
			c.broadcast("synced", { id: c.state.id, headIds: c.vars.headIds });
		},

		// ── IPC ──────────────────────────────────────────────────

		sendMessage: (c, toId: string, action: string, payload: string): IpcMessage => {
			const msg: IpcMessage = {
				fromId: c.state.id,
				toId,
				action,
				payload,
				timestamp: Date.now(),
			};
			c.state.outbox.push(msg);
			return msg;
		},

		receiveMessage: (c, fromId: string, action: string, payload: string, timestamp: number) => {
			const msg: IpcMessage = { fromId, toId: c.state.id, action, payload, timestamp };
			c.state.inbox.push(msg);
			c.broadcast("changed", { id: c.state.id, updatedAt: c.vars.updatedAt });
		},

		getInbox: (c): IpcMessage[] => c.state.inbox,
		getOutbox: (c): IpcMessage[] => c.state.outbox,

		// ── Meta ─────────────────────────────────────────────────

		ref: (c): ObjectRef => ({
			id: c.state.id,
			typeKey: c.vars.typeKey,
			createdAt: c.vars.createdAt,
			updatedAt: c.vars.updatedAt,
		}),

		destroy: (c) => {
			c.destroy();
		},
	},
});

// ── Store Actor ──────────────────────────────────────────────────

const storeActor = actor({
	state: { objectCount: 0 },

	db: db({
		onMigrate: async (database) => {
			await database.execute(`
				CREATE TABLE IF NOT EXISTS objects (
					id TEXT PRIMARY KEY,
					type_key TEXT NOT NULL DEFAULT '',
					deleted INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL DEFAULT 0,
					updated_at INTEGER NOT NULL DEFAULT 0
				)
			`);
			await database.execute(`
				CREATE TABLE IF NOT EXISTS changes (
					id TEXT PRIMARY KEY,
					object_id TEXT NOT NULL,
					timestamp INTEGER NOT NULL,
					is_head INTEGER NOT NULL DEFAULT 1
				)
			`);
			await database.execute(`
				CREATE TABLE IF NOT EXISTS change_parents (
					change_id TEXT NOT NULL,
					parent_id TEXT NOT NULL,
					PRIMARY KEY (change_id, parent_id)
				)
			`);
			await database.execute("CREATE INDEX IF NOT EXISTS idx_changes_object ON changes(object_id)");
			await database.execute("CREATE INDEX IF NOT EXISTS idx_objects_type ON objects(type_key)");
			await database.execute(`
				CREATE TABLE IF NOT EXISTS links (
					source_id TEXT NOT NULL,
					target_id TEXT NOT NULL,
					relation_key TEXT NOT NULL,
					field_key TEXT NOT NULL,
					PRIMARY KEY (source_id, field_key)
				)
			`);
			await database.execute("CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_id)");
			await database.execute("CREATE INDEX IF NOT EXISTS idx_links_relation ON links(relation_key)");
			await database.execute(`
				CREATE TABLE IF NOT EXISTS coins (
					coin_id TEXT NOT NULL,
					bucket_id TEXT NOT NULL,
					token_id TEXT NOT NULL,
					owner_pubkey TEXT NOT NULL,
					amount TEXT NOT NULL,
					spent INTEGER NOT NULL DEFAULT 0,
					created_at INTEGER NOT NULL DEFAULT 0,
					PRIMARY KEY (coin_id, token_id)
				)
			`);
			await database.execute("CREATE INDEX IF NOT EXISTS idx_coins_token_owner ON coins(token_id, owner_pubkey, spent)");
			await database.execute("CREATE INDEX IF NOT EXISTS idx_coins_bucket ON coins(bucket_id)");
		},
	}),

	actions: {
		create: async (c, typeKey: string, fieldsJson?: string, contentBase64?: string): Promise<string> => {
			const objectId = generateObjectId();
			initDisk();

			// Build changes: genesis + optional fields + optional content.
			const genesis = createGenesisChange(objectId, typeKey);
			writeChange(genesis);
			await indexChange(c, genesis);
			let lastHeads = [genesis.id];

			if (fieldsJson) {
				const fields: Record<string, Value> = JSON.parse(fieldsJson);
				const ops: Operation[] = Object.entries(fields).map(([key, value]) => ({
					fieldSet: { key, value },
				}));
				const fieldChange = createChange(objectId, ops, lastHeads);
				writeChange(fieldChange);
				await indexChange(c, fieldChange);
				lastHeads = [fieldChange.id];
			}

			if (contentBase64) {
				const contentBytes = Buffer.from(contentBase64, "base64");
				const contentChange = createChange(objectId, [{
					blockAdd: {
						parentId: "",
						afterId: "",
						block: {
							id: "__content__",
							childrenIds: [],
							content: {
								custom: {
									contentType: "glon/raw",
									data: contentBytes,
									meta: {},
								},
							},
						},
					},
				}], lastHeads);
				writeChange(contentChange);
				await indexChange(c, contentChange);
				lastHeads = [contentChange.id];
			}

			// Compute state and index the object.
			const result = loadFromDisk(objectId);
			if (result) {
				await indexObject(c, result.state);
			}

			// Spawn the object actor. createVars will load state from disk.
			const client = c.client<typeof app>();
			const objActor = client.objectActor.getOrCreate([objectId], {
				createWithInput: { id: objectId } as ObjectInput,
			});
			await objActor.ref();

			c.state.objectCount++;
			return objectId;
		},

		list: async (c, typeKey?: string): Promise<ObjectRef[]> => {
			let sql = "SELECT id, type_key AS typeKey, created_at AS createdAt, updated_at AS updatedAt FROM objects WHERE deleted = 0";
			const params: any[] = [];
			if (typeKey) {
				sql += " AND type_key = ?";
				params.push(typeKey);
			}
			sql += " ORDER BY type_key, created_at";
			return (await c.db.execute(sql, ...params)) as unknown as ObjectRef[];
		},

		get: async (c, id: string): Promise<any | null> => {
			const rows = (await c.db.execute(
				"SELECT id FROM objects WHERE id = ?", id,
			)) as unknown as { id: string }[];
			if (rows.length === 0) return null;


			// Always load fresh from disk so pushChangesBatch mutations
			// are visible immediately without waiting for actor vars sync.
			initDisk();
			const result = loadFromDisk(id);
			if (!result) return null;
			const vars = computedToVars(result.state, result.changeCount);
			return {
				id,
				typeKey: vars.typeKey,
				fields: vars.fields,
				content: vars.content,
				blocks: vars.blocks,
				blockProvenance: vars.blockProvenance,
				deleted: vars.deleted,
				createdAt: vars.createdAt,
				updatedAt: vars.updatedAt,
				headIds: vars.headIds,
				changeCount: vars.changeCount,
			};
		},

		getRef: async (c, id: string): Promise<ObjectRef | null> => {
			const rows = (await c.db.execute(
				"SELECT id, type_key AS typeKey, created_at AS createdAt, updated_at AS updatedAt FROM objects WHERE id = ?",
				id,
			)) as unknown as ObjectRef[];
			return rows[0] ?? null;
		},

		search: async (c, query: string): Promise<ObjectRef[]> => {
			return (await c.db.execute(
				"SELECT id, type_key AS typeKey, created_at AS createdAt, updated_at AS updatedAt FROM objects WHERE id LIKE ? AND deleted = 0",
				`%${query}%`,
			)) as unknown as ObjectRef[];
		},

		delete: async (c, id: string): Promise<boolean> => {
			const rows = (await c.db.execute("SELECT id FROM objects WHERE id = ?", id)) as unknown as { id: string }[];
			if (rows.length === 0) return false;
			try {
				const client = c.client<typeof app>();
				const objActor = client.objectActor.getOrCreate([id]);
				await objActor.destroy();
			} catch {
				// Actor already gone.
			}
			// Clean up SQLite (parents before changes due to FK-like dependency)
			await c.db.execute(
				"DELETE FROM change_parents WHERE change_id IN (SELECT id FROM changes WHERE object_id = ?)",
				id,
			);
			await c.db.execute("DELETE FROM changes WHERE object_id = ?", id);
			await c.db.execute("UPDATE objects SET deleted = 1 WHERE id = ?", id);
			await c.db.execute("DELETE FROM coins WHERE bucket_id = ?", id);
			// Clean up disk
			deleteChangesForObject(id);
			c.state.objectCount = Math.max(0, c.state.objectCount - 1);
			return true;
		},

		exists: async (c, id: string): Promise<boolean> => {
			const rows = (await c.db.execute(
				"SELECT id FROM objects WHERE id = ? AND deleted = 0", id,
			)) as unknown as { id: string }[];
			return rows.length > 0;
		},

		resolvePrefix: async (c, prefix: string): Promise<string> => {
			const rows = (await c.db.execute(
				"SELECT id FROM objects WHERE id LIKE ? AND deleted = 0", prefix + "%",
			)) as unknown as { id: string }[];
			if (rows.length === 1) return rows[0].id;
			return "";
		},

		info: async (c) => {
			const countRows = (await c.db.execute(
				"SELECT COUNT(*) as cnt FROM objects WHERE deleted = 0",
			)) as unknown as { cnt: number }[];
			const changeRows = (await c.db.execute(
				"SELECT COUNT(*) as cnt FROM changes",
			)) as unknown as { cnt: number }[];
			const typeRows = (await c.db.execute(
				"SELECT type_key, COUNT(*) as cnt FROM objects WHERE deleted = 0 GROUP BY type_key ORDER BY cnt DESC",
			)) as unknown as { type_key: string; cnt: number }[];

			const byType: Record<string, number> = {};
			for (const row of typeRows) byType[row.type_key] = row.cnt;

			return {
				totalObjects: countRows[0]?.cnt ?? 0,
				totalChanges: changeRows[0]?.cnt ?? 0,
				byType,
			};
		},

		getHeadIds: async (c, objectId: string): Promise<string[]> => {
			const rows = (await c.db.execute(
				"SELECT id FROM changes WHERE object_id = ? AND is_head = 1", objectId,
			)) as unknown as { id: string }[];
			return rows.map(r => r.id);
		},

		indexSyncedChange: async (c, hexId: string, objectId: string, timestamp: number, parentHexIds: string[]): Promise<void> => {
			await c.db.execute(
				"INSERT OR IGNORE INTO changes (id, object_id, timestamp, is_head) VALUES (?, ?, ?, 1)",
				hexId, objectId, timestamp,
			);
			for (const parentHex of parentHexIds) {
				await c.db.execute(
					"INSERT OR IGNORE INTO change_parents (change_id, parent_id) VALUES (?, ?)",
					hexId, parentHex,
				);
				await c.db.execute("UPDATE changes SET is_head = 0 WHERE id = ?", parentHex);
			}
		},

		indexSyncedObject: async (c, id: string, typeKey: string, deleted: boolean, createdAt: number, updatedAt: number): Promise<void> => {
			await c.db.execute(
				`INSERT INTO objects (id, type_key, deleted, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   type_key = excluded.type_key,
				   deleted = excluded.deleted,
				   created_at = excluded.created_at,
				   updated_at = excluded.updated_at`,
				id, typeKey, deleted ? 1 : 0, createdAt, updatedAt,
			);
		},


		runIndexHook: async (c, objectId: string): Promise<void> => {
			const result = loadFromDisk(objectId);
			if (result) {
				const hook = getIndexHook(result.state.typeKey);
				if (hook) await hook(c, result.state);
			}
		},

		// ── Link queries ─────────────────────────────────────────

		getLinks: async (c, objectId: string): Promise<{ targetId: string; relationKey: string; fieldKey: string }[]> => {
			return (await c.db.execute(
				"SELECT target_id AS targetId, relation_key AS relationKey, field_key AS fieldKey FROM links WHERE source_id = ?",
				objectId,
			)) as unknown as { targetId: string; relationKey: string; fieldKey: string }[];
		},

		getBacklinks: async (c, objectId: string): Promise<{ sourceId: string; relationKey: string; fieldKey: string }[]> => {
			return (await c.db.execute(
				"SELECT source_id AS sourceId, relation_key AS relationKey, field_key AS fieldKey FROM links WHERE target_id = ?",
				objectId,
			)) as unknown as { sourceId: string; relationKey: string; fieldKey: string }[];
		},

		getLinkedObjects: async (c, objectId: string, relationKey: string): Promise<{ targetId: string; fieldKey: string }[]> => {
			return (await c.db.execute(
				"SELECT target_id AS targetId, field_key AS fieldKey FROM links WHERE source_id = ? AND relation_key = ?",
				objectId, relationKey,
			)) as unknown as { targetId: string; fieldKey: string }[];
		},

		neighbors: async (c, objectId: string): Promise<{ outbound: any[]; inbound: any[] }> => {
			const outbound = (await c.db.execute(
				`SELECT l.target_id AS id, l.relation_key AS relationKey, l.field_key AS fieldKey, o.type_key AS typeKey
				 FROM links l LEFT JOIN objects o ON o.id = l.target_id WHERE l.source_id = ?`,
				objectId,
			)) as unknown as any[];
			const inbound = (await c.db.execute(
				`SELECT l.source_id AS id, l.relation_key AS relationKey, l.field_key AS fieldKey, o.type_key AS typeKey
				 FROM links l LEFT JOIN objects o ON o.id = l.source_id WHERE l.target_id = ?`,
				objectId,
			)) as unknown as any[];
			return { outbound, inbound };
		},

		getTypeDefinition: async (c, typeKey: string): Promise<any | null> => {
			const refs = (await c.db.execute(
				"SELECT id FROM objects WHERE type_key = 'type' AND deleted = 0",
			)) as unknown as { id: string }[];
			for (const ref of refs) {
				const client = c.client<typeof app>();
				const objActor = client.objectActor.getOrCreate([ref.id]);
				const obj = await objActor.read();
				if (obj?.fields?.key?.stringValue === typeKey) return obj;
			}
			return null;
		},

		// ── Coin index queries ───────────────────────────────────
		coinBalance: async (c, tokenId: string, pubkey: string): Promise<string> => {
			const rows = (await c.db.execute(
				"SELECT amount FROM coins WHERE token_id = ? AND owner_pubkey = ? AND spent = 0",
				tokenId, pubkey,
			)) as unknown as { amount: string }[];
			let total = 0n;
			for (const row of rows) total += BigInt(row.amount);
			return total.toString();
		},

		coinHolders: async (c, tokenId: string): Promise<{ pubkey: string; balance: string }[]> => {
			const rows = (await c.db.execute(
				"SELECT owner_pubkey as pubkey, amount FROM coins WHERE token_id = ? AND spent = 0",
				tokenId,
			)) as unknown as { pubkey: string; amount: string }[];
			const balances = new Map<string, bigint>();
			for (const row of rows) {
				const prev = balances.get(row.pubkey) ?? 0n;
				balances.set(row.pubkey, prev + BigInt(row.amount));
			}
			const result = Array.from(balances.entries()).map(([pubkey, balance]) => ({ pubkey, balance: balance.toString() }));
			result.sort((a, b) => {
				const na = BigInt(a.balance);
				const nb = BigInt(b.balance);
				if (na < nb) return 1;
				if (na > nb) return -1;
				return 0;
			});
			return result;
		},

		coinStats: async (c): Promise<Record<string, { totalSupply: string; holders: number; buckets: number }>> => {
			const rows = (await c.db.execute(
				"SELECT token_id, amount, owner_pubkey, bucket_id FROM coins WHERE spent = 0",
			)) as unknown as { token_id: string; amount: string; owner_pubkey: string; bucket_id: string }[];
			const byToken = new Map<string, { totalSupply: bigint; holders: Set<string>; buckets: Set<string> }>();
			for (const row of rows) {
				let entry = byToken.get(row.token_id);
				if (!entry) {
					entry = { totalSupply: 0n, holders: new Set(), buckets: new Set() };
					byToken.set(row.token_id, entry);
				}
				entry.totalSupply += BigInt(row.amount);
				entry.holders.add(row.owner_pubkey);
				entry.buckets.add(row.bucket_id);
			}
			const result: Record<string, { totalSupply: string; holders: number; buckets: number }> = {};
			for (const [tokenId, entry] of byToken) {
				result[tokenId] = {
					totalSupply: entry.totalSupply.toString(),
					holders: entry.holders.size,
					buckets: entry.buckets.size,
				};
			}
			return result;
		},
		coinSelect: async (c, tokenId: string, pubkey: string, minAmount?: string): Promise<{ coin_id: string; bucket_id: string; amount: string }[]> => {
			const rows = (await c.db.execute(
				"SELECT coin_id, bucket_id, amount FROM coins WHERE token_id = ? AND owner_pubkey = ? AND spent = 0",
				tokenId, pubkey,
			)) as unknown as { coin_id: string; bucket_id: string; amount: string }[];
			rows.sort((a, b) => {
				const na = BigInt(a.amount);
				const nb = BigInt(b.amount);
				if (na < nb) return 1;
				if (na > nb) return -1;
				return 0;
			});
			if (!minAmount) return rows;
			let sum = 0n;
			const selected: typeof rows = [];
			for (const row of rows) {
				selected.push(row);
				sum += BigInt(row.amount);
				if (sum >= BigInt(minAmount)) break;
			}
			return selected;
		},

		rebuildCoinIndex: async (c) => {
			await c.db.execute("DELETE FROM coins");
			const refs = (await c.db.execute(
				"SELECT id FROM objects WHERE type_key = ? AND deleted = 0",
				"chain.coin.bucket",
			)) as unknown as { id: string }[];

			for (const ref of refs) {
				const result = loadFromDisk(ref.id);
				if (result) {
					const hook = getIndexHook(result.state.typeKey);
					if (hook) await hook(c, result.state);
				}
			}
			return { rebuilt: refs.length };
		},

		graphQuery: async (c, rootId: string, depth: number, relationKey?: string): Promise<any[]> => {
			const visited = new Set<string>();
			const result: any[] = [];
			const queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];
			while (queue.length > 0) {
				const { id, depth: d } = queue.shift()!;
				if (visited.has(id) || d > depth) continue;
				visited.add(id);
				const ref = (await c.db.execute(
					"SELECT id, type_key AS typeKey FROM objects WHERE id = ? AND deleted = 0", id,
				)) as unknown as { id: string; typeKey: string }[];
				if (ref.length === 0) continue;
				let sql = "SELECT target_id AS targetId, relation_key AS relationKey, field_key AS fieldKey FROM links WHERE source_id = ?";
				const params: any[] = [id];
				if (relationKey) { sql += " AND relation_key = ?"; params.push(relationKey); }
				const links = (await c.db.execute(sql, ...params)) as unknown as any[];
				result.push({ id, typeKey: ref[0].typeKey, depth: d, links });
				for (const link of links) {
					if (!visited.has(link.targetId)) queue.push({ id: link.targetId, depth: d + 1 });
				}
			}
			return result;

		},

		/** Cross-object batch push: validates and writes changes for multiple objects
		 *  atomically — either all pass validation or none are written.
		 *
		 *  Input: JSON array of { objectId: string, changesBase64: string }
		 *  Each changesBase64 is comma-separated base64-encoded Change protobufs.
		 */
		pushChangesBatch: async (c, entriesJson: string) => {
			const entries = JSON.parse(entriesJson) as Array<{ objectId: string; changesBase64: string }>;
			if (!Array.isArray(entries) || entries.length === 0) {
				throw new Error("pushChangesBatch: expected non-empty array of { objectId, changesBase64 }");
			}

			initDisk();

			// Decode all changes, group by objectId.
			const groupMap = new Map<string, Change[]>();
			const allChanges: Change[] = [];

			for (const entry of entries) {
				const parts = entry.changesBase64.split(",").filter(Boolean);
				const decoded: Change[] = [];
				for (const b64 of parts) {
					const bytes = Buffer.from(b64, "base64");
					decoded.push(decodeChange(new Uint8Array(bytes)));
				}
				const existing = groupMap.get(entry.objectId) ?? [];
				groupMap.set(entry.objectId, existing.concat(decoded));
				allChanges.push(...decoded);
			}

			// For each group: resolve typeKey, run signature gate.
			const typeKeyMap = new Map<string, string>();
			for (const [objectId, changes] of groupMap) {
				let effectiveTypeKey = "";
				const objRows = (await c.db.execute(
					"SELECT type_key FROM objects WHERE id = ? AND deleted = 0",
					objectId,
				)) as unknown as { type_key: string }[];
				if (objRows.length > 0) {
					effectiveTypeKey = objRows[0].type_key;
				}
				if (!effectiveTypeKey) {
					for (const ch of changes) {
						for (const op of ch.ops ?? []) {
							if (op.objectCreate?.typeKey) {
								effectiveTypeKey = op.objectCreate.typeKey;
								break;
							}
						}
						if (effectiveTypeKey) break;
					}
				}
				if (!effectiveTypeKey) {
					throw new Error(`pushChangesBatch: cannot resolve typeKey for object ${objectId}`);
				}
				typeKeyMap.set(objectId, effectiveTypeKey);

				// Signature gate
				if (isChainModeType(effectiveTypeKey)) {
					for (const change of changes) {
						if (!change.authExtension || change.authExtension.type !== "ed25519") {
							throw new Error(`signature gate: chain-mode change for object ${change.objectId} is missing ed25519 authExtension`);
						}
						const sig = decodeSignature(change.authExtension.payload);
						if (!sig.pubkey || sig.pubkey.length === 0) {
							throw new Error(`signature gate: chain-mode change for object ${change.objectId} is missing pubkey`);
						}
						if (sig.pubkey.length !== 32) {
							throw new Error(`signature gate: pubkey must be 32 bytes (got ${sig.pubkey.length})`);
						}
						if (!sig.signature || sig.signature.length !== 64) {
							throw new Error(`signature gate: signature must be 64 bytes (got ${sig.signature?.length ?? 0})`);
						}
						const signingBytes = canonicalEncodeChangeForSigning(change);
						const ok = ed25519Verify(sig.pubkey, signingBytes, sig.signature);
						if (!ok) {
							throw new Error(`signature gate: invalid signature for change in ${change.objectId}`);
						}
						const expectedId = sha256(canonicalEncodeChange(change));
						if (hexEncode(expectedId) !== hexEncode(change.id)) {
							throw new Error(`signature gate: change id does not match canonical hash`);
						}
					}
				}
			}

			// Run validators with full batch context.
			const batchContext: BatchValidationContext = { allChanges };
			for (const [objectId, changes] of groupMap) {
				const effectiveTypeKey = typeKeyMap.get(objectId)!;
				const validator = getValidator(effectiveTypeKey);
				if (validator) {
					const result = validator(changes, batchContext);
					if (!result.valid) {
						throw new Error(`Validation rejected for ${objectId}: ${result.error}`);
					}
				}
			}

			// All validation passed — write to disk, recompute, index.
			for (const change of allChanges) {
				writeChange(change);
			}


			// Recompute + index each object.
			for (const objectId of groupMap.keys()) {
				const result = loadFromDisk(objectId);
				if (result) {
					await indexObject(c, result.state);
				}

				for (const change of groupMap.get(objectId)!) {
					await indexChange(c, change);
				}



			}


			return { ok: true, objects: Array.from(groupMap.keys()) };
		},
	},
});

// ── Store helpers ────────────────────────────────────────────────

async function indexChange(c: any, change: Change): Promise<void> {
	const hexId = hexEncode(change.id);
	await c.db.execute(
		"INSERT OR IGNORE INTO changes (id, object_id, timestamp, is_head) VALUES (?, ?, ?, 1)",
		hexId, change.objectId, change.timestamp,
	);
	for (const pid of change.parentIds) {
		const parentHex = hexEncode(pid);
		await c.db.execute(
			"INSERT OR IGNORE INTO change_parents (change_id, parent_id) VALUES (?, ?)",
			hexId, parentHex,
		);
		await c.db.execute("UPDATE changes SET is_head = 0 WHERE id = ?", parentHex);
	}
}

/** Recursively extract ObjectLinks from a Value (handles ValueList nesting). */
function extractLinks(fieldKey: string, v: Value): { targetId: string; relationKey: string; fieldKey: string }[] {
	if (v.linkValue) {
		return [{ targetId: v.linkValue.targetId, relationKey: v.linkValue.relationKey, fieldKey }];
	}
	if (v.valuesValue) {
		return v.valuesValue.items.flatMap(item => extractLinks(fieldKey, item));
	}
	if (v.mapValue) {
		return Object.entries(v.mapValue.entries).flatMap(([k, val]) => extractLinks(`${fieldKey}.${k}`, val));
	}
	return [];
}

async function indexObject(c: any, computed: ObjectState): Promise<void> {
	await c.db.execute(
		`INSERT INTO objects (id, type_key, deleted, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   type_key = excluded.type_key,
		   deleted = excluded.deleted,
		   created_at = excluded.created_at,
		   updated_at = excluded.updated_at`,
		computed.id, computed.typeKey, computed.deleted ? 1 : 0,
		computed.createdAt, computed.updatedAt,
	);

	// Reindex links: clear stale, scan fields for ObjectLink values
	await c.db.execute("DELETE FROM links WHERE source_id = ?", computed.id);
	for (const [key, value] of computed.fields) {
		for (const link of extractLinks(key, value)) {
			await c.db.execute(
				`INSERT OR REPLACE INTO links (source_id, target_id, relation_key, field_key) VALUES (?, ?, ?, ?)`,
				computed.id, link.targetId, link.relationKey, link.fieldKey,
			);
		}
	}

	const hook = getIndexHook(computed.typeKey);
	if (hook) await hook(c, computed);
}


// ── Program Actor ─────────────────────────────────────────────────
//
// One instance per running program. Manages program-defined state,
// action dispatch, and tick loops. The kernel treats program state as
// an opaque JSON blob — programs own their own serialization.

interface ProgramActorState {
	programId: string;
	programState: string; // JSON-serialized program state
}

const programActor = actor({
	createState: (_c, input?: { programId: string }): ProgramActorState => ({
		programId: input?.programId ?? "",
		programState: "{}",
	}),

	events: {
		programEvent: event<{ programId: string; channel: string; data: string }>(),
	},

	actions: {
		/** Generic action dispatch: route to the program's named action. */
		dispatch: async (c, action: string, argsJson: string): Promise<string> => {
			const { dispatchActorAction } = await import("./programs/runtime.js");
			const args: any[] = JSON.parse(argsJson);
			const makeCtx = (state: Record<string, any>) => ({
				client: c.client<typeof app>(),
				store: c.client<typeof app>().storeActor.getOrCreate(["root"]),
				resolveId: async (prefix: string) => {
					const store = c.client<typeof app>().storeActor.getOrCreate(["root"]);
					const resolved = await store.resolvePrefix(prefix);
					return resolved || null;
				},
				stringVal, intVal, floatVal, boolVal, mapVal, listVal, linkVal, displayValue,
				listChangeFiles: () => [],
				readChangeByHex: () => null,
				hexEncode,
				print: (msg: string) => console.log(msg),

				style,
				randomUUID: () => generateObjectId(),
				state,
				emit: (channel: string, data: any) => {
					c.broadcast("programEvent", {
						programId: c.state.programId,
						channel,
						data: JSON.stringify(data),
					});
				},
				programId: c.state.programId,
				objectActor: (id: string) => c.client<typeof app>().objectActor.getOrCreate([id]),
				dispatchProgram: async (prefix: string, actionName: string, actionArgs: unknown[]) => {
					const { getProgramActorByPrefix, dispatchActorAction: dispatch2 } = await import("./programs/runtime.js");
					const inst = getProgramActorByPrefix(prefix);
					if (!inst) throw new Error(`Program not running: ${prefix}`);
					return await dispatch2(inst.programId, actionName, actionArgs, makeCtx);
				},
				dispatchTypedAction: async (prefix: string, actionName: string, input: unknown) => {
					const { getProgramActorByPrefix, dispatchActorAction: dispatch2 } = await import("./programs/runtime.js");
					const inst = getProgramActorByPrefix(prefix);
					if (!inst) throw new Error(`Program not running: ${prefix}`);
					return await dispatch2(inst.programId, actionName, [input], makeCtx);
				},
			});
			const result = await dispatchActorAction(c.state.programId, action, args, makeCtx);
			return JSON.stringify(result ?? null);
		},

		/** Get the program's current state (for diagnostics). */
		getState: (c): string => c.state.programState,

		/** Update persisted state (called by runtime after mutations). */
		saveState: (c, stateJson: string) => {
			c.state.programState = stateJson;
		},
	},
});

// ── Registry ─────────────────────────────────────────────────────

const MANAGER_PORT = desiredPort();

export const app = setup({
	use: { objectActor, storeActor, programActor },
	// Explicit port instead of RivetKit's silent fallback: we fail fast in
	// startServer() if it's busy so clients never see 6420 answered by nothing.
	managerPort: MANAGER_PORT,
	// Program manifests (base64 source) routinely exceed the default message
	// cap; bump to 10MB so large programs like /agent + compaction fit.
	maxIncomingMessageSize: 10_000_000,
});

async function startServer(): Promise<void> {
	try {
		await assertPortAvailable(MANAGER_PORT);
	} catch (err) {
		console.error((err as Error).message);
		process.exit(1);
	}
	writeEndpointLockfile(MANAGER_PORT);
	const cleanup = () => {
		clearEndpointLockfile();
		process.exit(0);
	};
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);
	process.on("exit", clearEndpointLockfile);
	app.start();
}

// Run immediately when invoked as the entry point (not when imported for types).
// Using a top-level await-less IIFE keeps this file valid under CJS-style bundles.
void startServer();
