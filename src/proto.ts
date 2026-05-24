/**
 * Proto layer — typed encode/decode for every message in glon.proto.
 *
 * One type system. Protobuf types throughout. The .proto file is
 * the single source of truth for all data shapes.
 *
 * Binary data is Uint8Array. Integers are numbers (JS safe range).
 * No JSON-safe parallel types — serialization boundaries are handled
 * at the edges (actor state, wire), not in the type system.
 */

import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTO_PATH = resolve(__dirname, "../proto/glon.proto");

// ── Load schema ─────────────────────────────────────────────────

const root = protobuf.loadSync(PROTO_PATH);


const ChangeType = root.lookupType("glon.Change");
const EnvelopeType = root.lookupType("glon.Envelope");
const ObjectSnapshotType = root.lookupType("glon.ObjectSnapshot");
const SignatureType = root.lookupType("glon.Signature");

// ── TypeScript interfaces ───────────────────────────────────────

export interface ObjectLink {
	targetId: string;
	relationKey: string;
}

export interface Value {
	kind?: string;
	stringValue?: string;
	intValue?: number;
	floatValue?: number;
	boolValue?: boolean;
	bytesValue?: Uint8Array;
	listValue?: { values: string[] };
	mapValue?: { entries: Record<string, Value> };
	valuesValue?: { items: Value[] };
	linkValue?: ObjectLink;
}

export interface TextContent {
	text: string;
	style: number;
}

export interface CustomContent {
	contentType: string;
	data: Uint8Array;
	meta: Record<string, string>;
}

export interface BlockContent {
	text?: TextContent;
	custom?: CustomContent;
}

export interface Block {
	id: string;
	childrenIds: string[];
	content: BlockContent;
}

export interface ObjectCreate { typeKey: string; }
export interface ObjectDelete {}
export interface FieldSet { key: string; value: Value; }
export interface FieldDelete { key: string; }
export interface BlockAdd { parentId: string; afterId: string; block: Block; }
export interface BlockRemove { blockId: string; }
export interface BlockUpdate { blockId: string; content: BlockContent; }
export interface BlockMove { blockId: string; newParentId: string; afterId: string; }

export interface Operation {
	objectCreate?: ObjectCreate;
	objectDelete?: ObjectDelete;
	fieldSet?: FieldSet;
	fieldDelete?: FieldDelete;
	blockAdd?: BlockAdd;
	blockRemove?: BlockRemove;
	blockUpdate?: BlockUpdate;
	blockMove?: BlockMove;
}


	export interface Change {
		id: Uint8Array;
		objectId: string;
		parentIds: Uint8Array[];
		ops: Operation[];
		snapshot?: ObjectSnapshot;
		timestamp: number;
		author: string;
	}

export interface Signature {
	/** 32-byte Ed25519 public key. */
	pubkey: Uint8Array;
	/** 64-byte Ed25519 signature; empty when computing the signing payload. */
	signature: Uint8Array;
}


export interface ObjectSnapshot {
	id: string;
	typeKey: string;
	fields: Record<string, Value>;
	/** @deprecated Content moved to primary block. Kept for backwards compat. */
	content?: Uint8Array;
	blocks: Block[];
	deleted: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface ObjectRef {
	id: string;
	typeKey: string;
	createdAt: number;
	updatedAt: number;
}

// ── Sync protocol messages ──────────────────────────────────────

export interface HeadAdvertise {
	objectId: string;
	headIds: Uint8Array[];
}

export interface HeadRequest {
	objectId: string;
	knownIds: Uint8Array[];
	targetIds: Uint8Array[];
}

export interface ChangePush {
	objectId: string;
	changes: Change[];
}

export interface ChangeRequest {
	objectId: string;
	changeIds: Uint8Array[];
}

export interface ObjectSubscribe {
	objectId: string;
}

export interface ObjectEvent {
	objectId: string;
	newHeadIds: Uint8Array[];
	changes: Change[];
}

export interface AppMessage {
	action: string;
	payload: Uint8Array;
}

export interface Envelope {
	fromId: string;
	toId: string;
	timestamp: number;
	headAdvertise?: HeadAdvertise;
	headRequest?: HeadRequest;
	changePush?: ChangePush;
	changeRequest?: ChangeRequest;
	objectSubscribe?: ObjectSubscribe;
	objectEvent?: ObjectEvent;
	appMessage?: AppMessage;
}

// ── Codec options ───────────────────────────────────────────────

const DECODE_OPTS = { bytes: Uint8Array, longs: Number, defaults: true, oneofs: true } as const;

// ── Change codec ────────────────────────────────────────────────

export function encodeChange(c: Change): Uint8Array {
	const err = ChangeType.verify(c);
	if (err) throw new Error(`Change verify: ${err}`);
	return ChangeType.encode(ChangeType.create(c)).finish();
}

export function decodeChange(bytes: Uint8Array): Change {
	const msg = ChangeType.decode(bytes);
	return ChangeType.toObject(msg, DECODE_OPTS) as unknown as Change;
}

/** Encode with id zeroed — hash these bytes to get the content address. */
export function encodeChangeForHashing(c: Change): Uint8Array {
	const copy = { ...c, id: new Uint8Array(0) };
	return ChangeType.encode(ChangeType.create(copy)).finish();
}

// ── Snapshot codec ──────────────────────────────────────────────

export function encodeSnapshot(s: ObjectSnapshot): Uint8Array {
	return ObjectSnapshotType.encode(ObjectSnapshotType.create(s)).finish();
}

export function decodeSnapshot(bytes: Uint8Array): ObjectSnapshot {
	const msg = ObjectSnapshotType.decode(bytes);
	return ObjectSnapshotType.toObject(msg, DECODE_OPTS) as unknown as ObjectSnapshot;
}

// ── Envelope codec ──────────────────────────────────────────────

export function encodeEnvelope(e: Envelope): Uint8Array {
	return EnvelopeType.encode(EnvelopeType.create(e)).finish();
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
	const msg = EnvelopeType.decode(bytes);
	return EnvelopeType.toObject(msg, DECODE_OPTS) as unknown as Envelope;
}


// ── Signature codec ─────────────────────────────────────────────

export function encodeSignature(s: Signature): Uint8Array {
	return SignatureType.encode(SignatureType.create(s)).finish();
}

export function decodeSignature(bytes: Uint8Array): Signature {
	const msg = SignatureType.decode(bytes);
	return SignatureType.toObject(msg, DECODE_OPTS) as unknown as Signature;
}

// ── Value helpers ───────────────────────────────────────────────

export function stringVal(s: string): Value { return { stringValue: s }; }
export function intVal(n: number): Value { return { intValue: n }; }
export function floatVal(n: number): Value { return { floatValue: n }; }
export function boolVal(b: boolean): Value { return { boolValue: b }; }
export function bytesVal(b: Uint8Array): Value { return { bytesValue: b }; }
export function linkVal(targetId: string, relationKey: string): Value {
	return { linkValue: { targetId, relationKey } };
}

/** Create a Value containing a nested map of Values. */
export function mapVal(entries: Record<string, Value>): Value {
	return { mapValue: { entries } };
}

/** Create a Value containing a heterogeneous list of Values. */
export function listVal(items: Value[]): Value {
	return { valuesValue: { items } };
}

export type UnwrappedValue = string | number | boolean | Uint8Array | string[] | Record<string, Value> | Value[] | ObjectLink | null;

export function unwrapValue(v: Value): UnwrappedValue {
	// Decoded values have a 'kind' discriminator from protobufjs oneofs:true
	if (v.kind) {
		switch (v.kind) {
			case "stringValue": return v.stringValue!;
			case "intValue": return v.intValue!;
			case "floatValue": return v.floatValue!;
			case "boolValue": return v.boolValue!;
			case "bytesValue": return v.bytesValue!;
			case "listValue": return v.listValue!.values;
			case "mapValue": return v.mapValue!.entries;
			case "valuesValue": return v.valuesValue!.items;
			case "linkValue": return v.linkValue!;
		}
	}
	// Constructed values (via stringVal/intVal/etc.) — only one field is set
	if (v.mapValue !== undefined) return v.mapValue.entries;
	if (v.valuesValue !== undefined) return v.valuesValue.items;
	if (v.listValue !== undefined) return v.listValue.values;
	if (v.bytesValue !== undefined) return v.bytesValue;
	if (v.stringValue !== undefined) return v.stringValue;
	if (v.intValue !== undefined) return v.intValue;
	if (v.floatValue !== undefined) return v.floatValue;
	if (v.boolValue !== undefined) return v.boolValue;
	if (v.linkValue !== undefined) return v.linkValue;
	return null;
}

export function displayValue(v: Value): string {
	if (v.linkValue !== undefined) {
		const short = v.linkValue.targetId.length > 12 ? v.linkValue.targetId.slice(0, 12) + "..." : v.linkValue.targetId;
		return `→ ${short} (${v.linkValue.relationKey})`;
	}
	if (v.mapValue !== undefined) {
		const entries = Object.entries(v.mapValue.entries);
		if (entries.length === 0) return "{}";
		const inner = entries.map(([k, val]) => `${k}: ${displayValue(val)}`).join(", ");
		return `{${inner}}`;
	}
	if (v.valuesValue !== undefined) {
		if (v.valuesValue.items.length === 0) return "[]";
		return `[${v.valuesValue.items.map(displayValue).join(", ")}]`;
	}
	const raw = unwrapValue(v);
	if (raw === null) return "(empty)";
	if (Array.isArray(raw)) return raw.join(", ");
	if (raw instanceof Uint8Array) return `<${raw.byteLength} bytes>`;
	return String(raw);
}

// ── Transport types ──────────────────────────────────────────────

const TransportEnvelopeType = root.lookupType("glon.TransportEnvelope");
const ChangeBundleType = root.lookupType("glon.ChangeBundle");
const TextMessageType = root.lookupType("glon.TextMessage");

export interface TransportEnvelope {
	contentType: string;
	payload: Uint8Array;
	senderPubkey: Uint8Array;
	metadata: Record<string, string>;
}

export interface ChangeBundle {
	changes: Uint8Array[];
}

export interface TextMessage {
	text: string;
}

export function encodeTransportEnvelope(e: TransportEnvelope): Uint8Array {
	return TransportEnvelopeType.encode(TransportEnvelopeType.create({
		contentType: e.contentType,
		payload: e.payload,
		senderPubkey: e.senderPubkey,
		metadata: e.metadata,
	})).finish();
}

export function decodeTransportEnvelope(bytes: Uint8Array): TransportEnvelope {
	const d = TransportEnvelopeType.decode(bytes) as any;
	return {
		contentType: String(d.contentType ?? ""),
		payload: d.payload ? new Uint8Array(d.payload) : new Uint8Array(0),
		senderPubkey: d.senderPubkey ? new Uint8Array(d.senderPubkey) : new Uint8Array(0),
		metadata: d.metadata ? Object.fromEntries(Object.entries(d.metadata)) : {},
	};
}

export function encodeChangeBundle(b: ChangeBundle): Uint8Array {
	return ChangeBundleType.encode(ChangeBundleType.create({
		changes: b.changes,
	})).finish();
}

export function decodeChangeBundle(bytes: Uint8Array): ChangeBundle {
	const d = ChangeBundleType.decode(bytes) as any;
	return {
		changes: (d.changes ?? []).map((c: any) => new Uint8Array(c)),
	};
}

export function encodeTextMessage(m: TextMessage): Uint8Array {
	return TextMessageType.encode(TextMessageType.create({
		text: m.text,
	})).finish();
}

export function decodeTextMessage(bytes: Uint8Array): TextMessage {
	const d = TextMessageType.decode(bytes) as any;
	return { text: String(d.text ?? "") };
}
