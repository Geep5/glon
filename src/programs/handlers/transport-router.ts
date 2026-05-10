// transport-router — polls all enabled transports, dispatches by content_type.
//
// No CLI. The actor tick polls every transport-* program's inbox_drain,
// parses each blob as a TransportEnvelope, and dispatches via the
// content_handler registry. Failed dispatches log a warning.

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { getContentHandler, registerContentHandler } from "../runtime.js";
import { dim, bold, cyan, red, green } from "../shared.js";
	import { decodeTransportEnvelope, decodeChange, decodeChangeBundle } from "../../proto.js";

// ── Default handler: glon/change-bundle ──────────────────────────
//
// Registered at module load. Imports each change in the bundle
// via pushChangesBatch, idempotently.

	registerContentHandler("glon/change-bundle", async (envelope, ctx) => {
		try {
			const bundle = decodeChangeBundle(envelope.payload);
			if (!bundle.changes || !Array.isArray(bundle.changes) || bundle.changes.length === 0) {
				ctx.print?.(dim("[router] change-bundle missing changes array"));
				return false;
			}

			// Group by objectId
			const grouped = new Map<string, Uint8Array[]>();
			for (const changeBytes of bundle.changes) {
				const change = decodeChange(changeBytes);
				const oid = change.objectId;
				if (!grouped.has(oid)) grouped.set(oid, []);
				grouped.get(oid)!.push(changeBytes);
			}

			// Push each object's changes via objectActor
			for (const [objectId, changes] of grouped) {
				try {
					const actor = ctx.objectActor(objectId, { createWithInput: { id: objectId } });
					for (const changeBytes of changes) {
						const b64 = Buffer.from(changeBytes).toString("base64");
						await actor.pushChanges(b64);
					}
				} catch (err: any) {
					ctx.print?.(dim(`[router] failed to import changes for ${objectId}: ${err?.message}`));
					return false;
				}
			}
			return true;
		} catch (err: any) {
			ctx.print?.(dim(`[router] change-bundle dispatch failed: ${err?.message}`));
			return false;
		}
	});

// ── Default handler: glon/text ───────────────────────────────────

registerContentHandler("glon/text", async (envelope, ctx) => {
	try {
		const text = new TextDecoder().decode(envelope.payload);
		ctx.print?.(dim(`[router] text message: ${text.slice(0, 100)}`));
		return true;
	} catch (err: any) {
		ctx.print?.(dim(`[router] text dispatch failed: ${err?.message}`));
		return false;
	}
});

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		print(bold("  transport-router"));
		print(dim("  Content handlers:"));
		print(`    ${green("glon/change-bundle")}  → kernel import`);
		print(`    ${green("glon/text")}         → agent inbox`);
		return;
	}
	print([
		bold("  transport-router") + dim(" — polls transports, dispatches by content_type"),
		`    ${cyan("transport-router status")}  show registered handlers`,
		dim("    Auto-polls on tick (every 5s)."),
	].join("\n"));
};

// ── Actor ────────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({ lastPoll: 0, totalDispatched: 0, totalFailed: 0 }),
	tickMs: 5000,
	typedActions: {
		poll: {
			description: "Manually trigger a poll of all transport inboxes.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => {
				return await doPoll(ctx);
			},
		},
	},
	onTick: async (ctx) => {
		await doPoll(ctx);
	},
};

async function doPoll(ctx: ProgramContext): Promise<{ dispatched: number; failed: number }> {
	const { dispatchProgram } = ctx;
	let dispatched = 0;
	let failed = 0;

	const store = ctx.store as any;
	let transports: { prefix: string }[] = [];
	try {
		const programRefs = await store.list("program") as { id: string }[];
		for (const ref of programRefs) {
			const obj = await store.get(ref.id);
			if (obj?.deleted) continue;
			const prefix = obj?.fields?.prefix?.stringValue;
			if (prefix && prefix.startsWith("/transport-") && prefix !== "/transport-router") transports.push({ prefix });
		}
	} catch (_e) { /* ignore discovery errors */ }

	for (const transport of transports) {
		try {
			const result = await dispatchProgram(transport.prefix, "inbox_drain", [{}]) as any;
			const blobs = result ?? [];
			if (!Array.isArray(blobs)) continue;

			for (const blob of blobs) {
				try {
					const payload = Buffer.from(blob.payload_b64, "base64");
					const envelope = decodeTransportEnvelope(payload);
					const handler = getContentHandler(envelope.contentType);
					if (handler) {
						const blobMeta = {
							fromEndpoint: blob.from_endpoint,
							receivedAt: blob.received_at,
							transportMetadata: blob.metadata ?? {},
						};
						const ok = await handler(envelope, ctx, blobMeta);
						if (ok) dispatched++;
						else failed++;
					} else {
						ctx.print?.(dim(`[router] no handler for ${envelope.contentType}`));
						failed++;
					}
				} catch (err: any) {
					ctx.print?.(dim(`[router] failed to process blob: ${err?.message}`));
					failed++;
				}
			}
		} catch (err: any) {
			ctx.print?.(dim(`[router] ${transport.prefix} drain failed: ${err?.message}`));
		}
	}

	const state = ctx.state as any;
	state.totalDispatched = (state.totalDispatched ?? 0) + dispatched;
	state.totalFailed = (state.totalFailed ?? 0) + failed;
	state.lastPoll = Date.now();

	return { dispatched, failed };
}

const program: ProgramDef = { handler, actor: actorDef };
export default program;
