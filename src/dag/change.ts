/**
 * Change creation and content-addressing.
 *
 * Every change is content-addressed: id = sha256(encodeChangeForHashing(change)).
 * The id field is zeroed during hashing so the hash covers everything else.
 */

import { sha256, hexEncode } from "../crypto.js";
import {
	encodeChangeForHashing,
	type Change,
	type Operation,
	type Value,
} from "../proto.js";

/** Build a Change, compute its content-address, return it. */
export function createChange(
	objectId: string,
	ops: Operation[],
	parentIds?: Uint8Array[],
	author?: string,
): Change {
	const change: Change = {
		id: new Uint8Array(0), // placeholder — filled after hashing
		objectId,
		parentIds: parentIds ?? [],
		ops,
		timestamp: Date.now(),
		author: author ?? "local",
	};
	change.id = sha256(encodeChangeForHashing(change));
	return change;
}

/** Genesis change: single ObjectCreate op, no parents. */
export function createGenesisChange(
	objectId: string,
	typeKey: string,
	author?: string,
): Change {
	return createChange(
		objectId,
		[{ objectCreate: { typeKey } }],
		undefined,
		author,
	);
}

/** Single FieldSet op with the given key/value. */
export function createFieldChange(
	objectId: string,
	parentIds: Uint8Array[],
	key: string,
	value: Value,
	author?: string,
): Change {
	return createChange(
		objectId,
		[{ fieldSet: { key, value } }],
		parentIds,
		author,
	);
}



/** Single ObjectDelete op. */
export function createDeleteChange(
	objectId: string,
	parentIds: Uint8Array[],
	author?: string,
): Change {
	return createChange(
		objectId,
		[{ objectDelete: {} }],
		parentIds,
		author,
	);
}

/** Hex-encoded content-address of a change. */
export function changeId(change: Change): string {
	return hexEncode(change.id);
}
