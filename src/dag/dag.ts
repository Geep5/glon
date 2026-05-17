/**
 * DAG traversal, topological sort, and state computation.
 *
 * Changes form a DAG via parentIds. State is computed by topologically
 * sorting the DAG (Kahn's BFS, tie-breaking on hex id) and applying
 * each change's operations in order.
 */

import { hexEncode } from "../crypto.js";
import type { Change, Value, Block, ObjectSnapshot } from "../proto.js";

// ── State ────────────────────────────────────────────────────────────

/** Provenance of a block: which Change created or last modified it. */
export interface BlockProvenance {
	changeId: Uint8Array;
	author: string;
	timestamp: number;
}


export interface ObjectState {
	id: string;
	typeKey: string;
	fields: Map<string, Value>;
	blocks: Block[];
	/** Tracks which Change created or last modified each block. */
	blockProvenance: Map<string, BlockProvenance>;
	deleted: boolean;
	createdAt: number;
	updatedAt: number;
	heads: Uint8Array[];
}

// ── Compute ────────────────────────────────────────────────────────

/** Compute object state from a complete set of changes. */
export function computeState(changes: Change[]): ObjectState {
	if (changes.length === 0) throw new Error("computeState: no changes");

	const objectId = changes[0].objectId;
	for (let i = 1; i < changes.length; i++) {
		if (changes[i].objectId !== objectId) {
			throw new Error(
				`computeState: mixed objectIds — expected ${objectId}, got ${changes[i].objectId}`,
			);
		}
	}

	const sorted = topoSort(changes);
	const heads = findHeads(changes);

	// Find the most recent snapshot to skip replay prefix.
	let snapshotIdx = -1;
	let snapshotTs = -1;
	for (let i = 0; i < sorted.length; i++) {
		if (sorted[i].snapshot && sorted[i].timestamp > snapshotTs) {
			snapshotIdx = i;
			snapshotTs = sorted[i].timestamp;
		}
	}


	const state: ObjectState = {
		id: objectId,
		typeKey: "",
		fields: new Map(),
		blocks: [],
		blockProvenance: new Map(),
		deleted: false,
		createdAt: 0,
		updatedAt: 0,
		heads,
	};


	// If a snapshot exists, initialize from it and skip earlier changes.
	let startIdx = 0;
	if (snapshotIdx >= 0) {
		const snap = sorted[snapshotIdx].snapshot!;
		state.typeKey = snap.typeKey;
		state.deleted = snap.deleted;
		state.createdAt = snap.createdAt;
		state.updatedAt = snap.updatedAt;
		state.blocks = snap.blocks ? [...snap.blocks] : [];
		if (snap.fields) {
			for (const [k, v] of Object.entries(snap.fields)) {
				state.fields.set(k, v);
			}
		}
		// Migrate deprecated content field to primary block.
		if (snap.content && snap.content.length > 0) {
			const idx = state.blocks.findIndex((b) => b.id === "__content__");
			const block: Block = {
				id: "__content__",
				childrenIds: [],
				content: {
					custom: {
						contentType: "glon/raw",
						data: snap.content,
						meta: {},
					},
				},
			};
			if (idx >= 0) {
				state.blocks[idx] = block;
			} else {
				state.blocks.push(block);
			}
			state.blockProvenance.set("__content__", {
				changeId: new Uint8Array(0),
				author: "",
				timestamp: 0,
			});
		}
		// Provenance isn't in the snapshot — blocks created before the
		// snapshot lose individual provenance. That's the tradeoff:
		// you trade per-block authorship history for replay speed.
		// Blocks added AFTER the snapshot get provenance tracked normally.
		startIdx = snapshotIdx + 1;
	}

	let maxTimestamp = 0;

	for (let i = startIdx; i < sorted.length; i++) {
		const change = sorted[i];
		if (change.timestamp > maxTimestamp) maxTimestamp = change.timestamp;

		for (const op of change.ops) {
			if (op.objectCreate) {
				state.typeKey = op.objectCreate.typeKey;
				state.createdAt = change.timestamp;
			} else if (op.fieldSet) {
				state.fields.set(op.fieldSet.key, op.fieldSet.value);
			} else if (op.fieldDelete) {
				state.fields.delete(op.fieldDelete.key);



			} else if (op.objectDelete) {
				state.deleted = true;
			} else if (op.blockAdd) {
				state.blocks.push(op.blockAdd.block);
				state.blockProvenance.set(op.blockAdd.block.id, {
					changeId: change.id,
					author: change.author,
					timestamp: change.timestamp,
				});
			} else if (op.blockRemove) {
				state.blocks = state.blocks.filter(
					(b) => b.id !== op.blockRemove!.blockId,
				);
				state.blockProvenance.delete(op.blockRemove.blockId);
			} else if (op.blockUpdate) {
				const idx = state.blocks.findIndex(
					(b) => b.id === op.blockUpdate!.blockId,
				);
				if (idx !== -1) {
					state.blocks[idx] = {
						...state.blocks[idx],
						content: op.blockUpdate.content,
					};
					state.blockProvenance.set(op.blockUpdate.blockId, {
						changeId: change.id,
						author: change.author,
						timestamp: change.timestamp,
					});
				}
			}
			// blockMove: no-op (future)
		}
	}

	state.updatedAt = maxTimestamp;
	return state;
}

// ── Heads ──────────────────────────────────────────────────────────

/** Find head changes — those not referenced as a parent by any other change. */
export function findHeads(changes: Change[]): Uint8Array[] {
	const referenced = new Set<string>();
	for (const c of changes) {
		for (const pid of c.parentIds) {
			referenced.add(hexEncode(pid));
		}
	}
	const heads: Uint8Array[] = [];
	for (const c of changes) {
		if (!referenced.has(hexEncode(c.id))) {
			heads.push(c.id);
		}
	}
	return heads;
}


// ── Snapshot ────────────────────────────────────────────────────────

	/** Extract primary content from a block tree (the __content__ block). */
	export function getPrimaryContent(blocks: Block[]): Uint8Array | undefined {
		const block = blocks.find((b) => b.id === "__content__");
		return block?.content?.custom?.data;
	}

/** Convert ObjectState to ObjectSnapshot (Map → Record). */
export function toSnapshot(state: ObjectState): ObjectSnapshot {
	const fields: Record<string, Value> = {};
	for (const [k, v] of state.fields) {
		fields[k] = v;
	}
	return {
		id: state.id,
		typeKey: state.typeKey,
		fields,
		// content removed — use getPrimaryContent(state.blocks) instead
		blocks: state.blocks,
		deleted: state.deleted,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
	};
}
// ── Topological sort ───────────────────────────────────────────────

/** Kahn's BFS topological sort, tie-breaking on hex id (lexicographic). */
function topoSort(changes: Change[]): Change[] {
	const byHex = new Map<string, Change>();
	const inDegree = new Map<string, number>();
	// adjacency: parent → children that depend on it
	const children = new Map<string, string[]>();

	for (const c of changes) {
		const hex = hexEncode(c.id);
		byHex.set(hex, c);
		inDegree.set(hex, 0);
	}

	// Count in-degrees (only among changes in this set)
	for (const c of changes) {
		const hex = hexEncode(c.id);
		let deg = 0;
		for (const pid of c.parentIds) {
			const phex = hexEncode(pid);
			if (byHex.has(phex)) {
				deg++;
				const list = children.get(phex);
				if (list) list.push(hex);
				else children.set(phex, [hex]);
			}
		}
		inDegree.set(hex, deg);
	}

	// Seed queue with zero-degree nodes, sorted for determinism
	const queue: string[] = [];
	for (const [hex, deg] of inDegree) {
		if (deg === 0) queue.push(hex);
	}
	queue.sort();

	const result: Change[] = [];

	while (queue.length > 0) {
		const hex = queue.shift()!;
		result.push(byHex.get(hex)!);

		const deps = children.get(hex);
		if (!deps) continue;

		// Collect newly-freed nodes, sort before enqueueing for determinism
		const freed: string[] = [];
		for (const childHex of deps) {
			const d = inDegree.get(childHex)! - 1;
			inDegree.set(childHex, d);
			if (d === 0) freed.push(childHex);
		}
		freed.sort();
		for (const f of freed) queue.push(f);
	}

	if (result.length !== changes.length) {
		throw new Error("topoSort: cycle detected in change DAG");
	}

	return result;
}
