/**
 * Canonical protobuf encoding for chain-mode objects.
 *
 * Protobuf3 wire format is byte-stable EXCEPT for `map<>` fields, where the
 * encoding order of entries is implementation-defined. Two protobufjs
 * versions, or protobufjs versus protobuf-go versus protobuf-c++, can
 * produce byte-different output for the same logical message.
 *
 * For chain consensus, every node must compute the same SHA-256 over the
 * same logical Change. We achieve this by recursively walking the Change
 * and sorting every map<> entry set by its key (lexicographic on UTF-8
 * bytes) before handing to protobufjs's standard encoder.
 *
 * ## Two encoders
 *
 * - `canonicalEncodeChange(change)` → bytes for content-addressing the
 *   change. The `id` field is zeroed; the `authorSig` field is preserved
 *   intact (the id commits to the signature, which prevents anyone from
 *   re-signing a change and having it land at the same id).
 *
 * - `canonicalEncodeChangeForSigning(change)` → bytes the author signs.
 *   Both `id` AND `authorSig.signature` are zeroed; pubkey/nonce/fee on
 *   the signature ARE present (the signature commits to them). This
 *   prevents a witness from re-binding a signature to different
 *   nonce/fee/pubkey values.
 *
 * ## Scope
 *
 * v1: only chain-mode objects use canonical encoding. Non-chain objects
 * keep using the existing `encodeChangeForHashing` from proto.ts so on-disk
 * .pb files for /agent, /chat, /token-pre-chain etc. stay valid. If we
 * ever go global-canonical, every existing object's id changes, which is
 * a one-time migration we deferred from v1.
 */

import type { Change, Value, ValueMap, ObjectSnapshot, Block, BlockContent, CustomContent, Operation } from "../proto.js";
import * as proto from "../proto.js";

// ── Sort helper ──────────────────────────────────────────────────

/**
 * Return a new object whose keys are inserted in lexicographic order over
 * UTF-8 byte sequences. ES2015 guarantees string-keyed property iteration
 * in insertion order, so the protobufjs encoder will emit map entries in
 * this order. UTF-8 byte ordering is the same as JS string ordering for
 * ASCII; for non-ASCII keys we explicitly sort by Buffer comparison.
 */
function sortKeyed<T>(record: Record<string, T>): Record<string, T> {
	const keys = Object.keys(record);
	keys.sort((a, b) => {
		// Buffer compare gives byte-level order, matching the protobuf reference
		// for canonical-form serialization tools.
		return Buffer.from(a, "utf-8").compare(Buffer.from(b, "utf-8"));
	});
	const out: Record<string, T> = {};
	for (const k of keys) out[k] = record[k];
	return out;
}

// ── Recursive canonicalization ───────────────────────────────────

function canonicalizeValue(v: Value): Value {
	if (v.mapValue !== undefined) {
		const sortedEntries = sortKeyed(v.mapValue.entries);
		const out: Record<string, Value> = {};
		for (const [k, vv] of Object.entries(sortedEntries)) {
			out[k] = canonicalizeValue(vv);
		}
		return { mapValue: { entries: out } };
	}
	if (v.valuesValue !== undefined) {
		return { valuesValue: { items: v.valuesValue.items.map(canonicalizeValue) } };
	}
	// stringValue, intValue, floatValue, boolValue, bytesValue, listValue, linkValue:
	// no map<> nesting, no canonicalization needed.
	return v;
}

function canonicalizeCustomContent(c: CustomContent): CustomContent {
	return {
		contentType: c.contentType,
		data: c.data,
		meta: sortKeyed(c.meta ?? {}),
	};
}

function canonicalizeBlockContent(content: BlockContent | undefined): BlockContent | undefined {
	if (!content) return content;
	if (content.custom) {
		return { custom: canonicalizeCustomContent(content.custom) };
	}
	// TextContent has no map<> fields.
	return content;
}

function canonicalizeBlock(block: Block): Block {
	return {
		id: block.id,
		childrenIds: block.childrenIds,
		content: canonicalizeBlockContent(block.content) ?? block.content,
	};
}

function canonicalizeOperation(op: Operation): Operation {
	if (op.fieldSet) {
		return { fieldSet: { key: op.fieldSet.key, value: canonicalizeValue(op.fieldSet.value) } };
	}
	if (op.blockAdd) {
		return {
			blockAdd: {
				parentId: op.blockAdd.parentId,
				afterId: op.blockAdd.afterId,
				block: canonicalizeBlock(op.blockAdd.block),
			},
		};
	}
	if (op.blockUpdate) {
		return {
			blockUpdate: {
				blockId: op.blockUpdate.blockId,
				content: canonicalizeBlockContent(op.blockUpdate.content) ?? op.blockUpdate.content,
			},
		};
	}
	// objectCreate / objectDelete / fieldDelete / contentSet / blockRemove / blockMove:
	// no map<> nesting.
	return op;
}

function canonicalizeSnapshot(snap: ObjectSnapshot): ObjectSnapshot {
	const sortedFields = sortKeyed(snap.fields ?? {});
	const fields: Record<string, Value> = {};
	for (const [k, v] of Object.entries(sortedFields)) {
		fields[k] = canonicalizeValue(v);
	}
	return {
		id: snap.id,
		typeKey: snap.typeKey,
		fields,
		content: snap.content,
		blocks: (snap.blocks ?? []).map(canonicalizeBlock),
		deleted: snap.deleted,
		createdAt: snap.createdAt,
		updatedAt: snap.updatedAt,
	};
}

/**
 * Produce a Change with every map<> entry sort-keyed in lexicographic
 * order. The returned object can be passed to any standard protobuf
 * encoder and will produce byte-identical output across implementations.
 */
function canonicalizeChange(change: Change): Change {
	return {
		id: change.id,
		objectId: change.objectId,
		parentIds: change.parentIds,           // order-significant; do not sort
		ops: change.ops.map(canonicalizeOperation),
		timestamp: change.timestamp,
		author: change.author,
		authorSig: change.authorSig,           // signature struct itself has no map<>
		snapshot: change.snapshot ? canonicalizeSnapshot(change.snapshot) : undefined,
	};
}

// ── Public encoders ──────────────────────────────────────────────

/**
 * Bytes used to compute the content-address (id) of a chain-mode change.
 * `id` is zeroed before encoding, but the `authorSig` (if present) is
 * included — meaning two changes with the same content but different
 * signatures produce different ids.
 */
export function canonicalEncodeChange(change: Change): Uint8Array {
	const copy = canonicalizeChange(change);
	copy.id = new Uint8Array(0);
	return proto.encodeChange(copy);
}

/**
 * Bytes the author signs. Both `id` AND `authorSig.signature` are zeroed
 * (the signer doesn't know the id yet, and is producing the signature).
 * `authorSig.pubkey`, `nonce`, `fee` ARE present and committed to.
 */
export function canonicalEncodeChangeForSigning(change: Change): Uint8Array {
	const copy = canonicalizeChange(change);
	copy.id = new Uint8Array(0);
	if (copy.authorSig) {
		copy.authorSig = {
			pubkey: copy.authorSig.pubkey,
			signature: new Uint8Array(0),
			nonce: copy.authorSig.nonce,
			fee: copy.authorSig.fee,
		};
	}
	return proto.encodeChange(copy);
}
