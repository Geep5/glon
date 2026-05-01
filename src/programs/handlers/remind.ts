// Remind — scheduled action scheduler for Holdfast (and any Glon agent).
//
// Reminders are first-class Glon objects (type "reminder"). They carry
// an ISO fire time, a delivery channel, a target (peer id or address),
// a payload, and a status. Because they're Glon objects, they sync to
// peers, survive restarts, and carry their own DAG history.
//
// The actor's tick loop runs every 30 seconds:
//   1. list("reminder") → filter to status=pending AND fire_at_ms <= now
//   2. Atomically mark status='sending' (setField) before dispatching.
//   3. Dispatch per channel:
//        discord         → /discord.send { peer_id, text }
//        email           → /mail.send    { to, subject, body }
//        agent_compose   → /holdfast.ingest (scheduler, created_by, narrative)
//   4. Mark status='sent' with sent_at_ms, or status='failed' with last_error.
//
// Actions exposed as harness tools:
//   - schedule({channel, target, fire_at, payload, created_by?, note?})
//   - cancel(reminder_id)
//   - list({peer_id?, status?, before_iso?})
//   - get(reminder_id)

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";

// ── ANSI ─────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

function dim(s: string) { return `${DIM}${s}${RESET}`; }
function bold(s: string) { return `${BOLD}${s}${RESET}`; }
function cyan(s: string) { return `${CYAN}${s}${RESET}`; }
function red(s: string) { return `${RED}${s}${RESET}`; }
function green(s: string) { return `${GREEN}${s}${RESET}`; }
function yellow(s: string) { return `${YELLOW}${s}${RESET}`; }
function magenta(s: string) { return `${MAGENTA}${s}${RESET}`; }

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_TICK_MS = 30_000;
const TYPE_KEY = "reminder";

export const CHANNELS = ["discord", "email", "agent_compose"] as const;
type Channel = typeof CHANNELS[number];

export const STATUSES = ["pending", "sending", "sent", "failed", "cancelled"] as const;
type Status = typeof STATUSES[number];

// ── Types ────────────────────────────────────────────────────────

export interface ReminderRecord {
	id: string;
	fire_at_ms: number;
	channel: Channel;
	target: string;
	payload: Record<string, unknown>;
	created_by: string;
	status: Status;
	last_error?: string;
	sent_at_ms?: number;
	note?: string;
	created_at_ms?: number;
}

// ── Field helpers ────────────────────────────────────────────────

function extractString(v: any): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return undefined;
}

function extractInt(v: any): number | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "number") return v;
	if (v.intValue !== undefined) return Number(v.intValue);
	if (v.stringValue !== undefined) {
		const n = parseInt(v.stringValue, 10);
		return Number.isFinite(n) ? n : undefined;
	}
	return undefined;
}

function recordFromState(id: string, fields: Record<string, any>): ReminderRecord | null {
	const fire_at_ms = extractInt(fields?.fire_at_ms);
	const channel = extractString(fields?.channel);
	const target = extractString(fields?.target);
	if (fire_at_ms === undefined || !channel || !target) return null;
	const payloadStr = extractString(fields?.payload) ?? "{}";
	const payload = parsePayloadField(payloadStr);

	return {
		id,
		fire_at_ms,
		channel: channel as Channel,
		target,
		payload,
		created_by: extractString(fields?.created_by) ?? "unknown",
		status: (extractString(fields?.status) ?? "pending") as Status,
		last_error: extractString(fields?.last_error),
		sent_at_ms: extractInt(fields?.sent_at_ms),
		note: extractString(fields?.note),
		created_at_ms: extractInt(fields?.created_at_ms),
	};
}

function parseFireAt(input: unknown): number {
	if (typeof input === "number") return input;
	if (typeof input === "string") {
		// "+10m" / "+2h" / "+30s" shorthand for quick testing
		const rel = /^\+(\d+)([smh])$/.exec(input);
		if (rel) {
			const n = parseInt(rel[1], 10);
			const unit = rel[2] === "s" ? 1000 : rel[2] === "m" ? 60_000 : 3_600_000;
			return Date.now() + n * unit;
		}
		const ms = Date.parse(input);
		if (!Number.isFinite(ms)) throw new Error(`invalid fire_at: ${input}`);
		return ms;
	}
	throw new Error("fire_at must be an ISO date string or a number (epoch ms)");
}

// ── Payload + target validation ──────────────────────────────────
//
// Models routinely pass `payload` as a JSON-encoded string instead of an
// object, even when the schema says `type: object`. We accept both shapes,
// store the canonical encoding, and reject anything that isn't an object
// at heart so legacy double-encoded payloads can't quietly slip through.

/** Normalize a schedule payload from a model. Accepts an object or a
 *  JSON-string-of-an-object. Throws on garbage so the model self-corrects
 *  on the next iteration instead of writing a useless reminder. */
function normalizePayload(raw: unknown): Record<string, unknown> {
	if (raw === null || raw === undefined) return {};
	if (typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed === "") return {};
		let parsed: unknown;
		try { parsed = JSON.parse(trimmed); }
		catch (err: any) {
			throw new Error(`payload string is not valid JSON: ${err?.message ?? err}`);
		}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		throw new Error(`payload string must encode a JSON object, got ${typeof parsed}`);
	}
	throw new Error(`payload must be an object or a JSON-encoded object string, got ${typeof raw}`);
}

/** Defensive read for stored payload strings.
 *  Recovers legacy double-encoded payloads (a bug shipped in earlier
 *  /remind schedule that JSON.stringified a payload that was already a
 *  JSON string). Returns {} on any unparseable input rather than throwing,
 *  so a corrupted reminder still returns a record callers can introspect. */
function parsePayloadField(payloadStr: string): Record<string, unknown> {
	if (!payloadStr) return {};
	try {
		let parsed: unknown = JSON.parse(payloadStr);
		let hops = 0;
		while (typeof parsed === "string" && hops < 4) {
			try { parsed = JSON.parse(parsed); } catch { break; }
			hops++;
		}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch { /* ignore */ }
	return {};
}

/** Per-channel payload contract. Reminders that don't satisfy the contract
 *  for their channel would either fail at dispatch (silently for sent
 *  reminders) or, worse, deliver an empty fallback message. Fail at
 *  schedule time instead. */
function validatePayloadForChannel(channel: Channel, payload: Record<string, unknown>): void {
	switch (channel) {
		case "agent_compose": {
			const prompt = payload.prompt;
			if (typeof prompt !== "string" || !prompt.trim()) {
				throw new Error("agent_compose payload requires a non-empty 'prompt' string");
			}
			return;
		}
		case "discord": {
			const message = payload.message;
			if (typeof message !== "string" || !message.trim()) {
				throw new Error("discord payload requires a non-empty 'message' string");
			}
			return;
		}
		case "email": {
			if (typeof payload.subject !== "string" || !(payload.subject as string).trim()) {
				throw new Error("email payload requires a non-empty 'subject' string");
			}
			const body = payload.body ?? payload.message;
			if (typeof body !== "string" || !body.trim()) {
				throw new Error("email payload requires a non-empty 'body' (or 'message') string");
			}
			return;
		}
	}
}

/** Validate the `target` field for a given channel. For Glon-id channels
 *  (discord, agent_compose) the target must resolve to a peer or agent
 *  object — picking a program/reminder/etc. id is a common LLM mis-pick
 *  that produces self-talk loops where the harness can't recognise the
 *  sender. */
async function validateTarget(channel: Channel, target: string, ctx: ProgramContext): Promise<void> {
	if (channel === "email") {
		if (!target.includes("@") || target.length < 3) {
			throw new Error(`email target must be an email address, got '${target}'`);
		}
		return;
	}
	// discord + agent_compose: target must be a Glon peer or agent.
	const store = ctx.store as any;
	const obj = await store.get(target);
	if (!obj || obj.deleted) {
		throw new Error(`target object not found: ${target}`);
	}
	if (obj.typeKey !== "peer" && obj.typeKey !== "agent") {
		throw new Error(
			`target must be a peer or agent (got typeKey='${obj.typeKey}'). ` +
			`Use peer_list to find a recipient peer id, or your own agent id for self-scheduled prompts.`,
		);
	}
}

// ── Core operations ──────────────────────────────────────────────

export interface ScheduleInput {
	channel: Channel | string;
	target: string;
	fire_at: string | number;
	/** Channel-specific data. Object form preferred; JSON-string is accepted for
	 *  models that ignore the `type: object` schema and stringify the payload. */
	payload?: Record<string, unknown> | string;
	created_by?: string;
	note?: string;
}

async function doSchedule(input: ScheduleInput, ctx: ProgramContext): Promise<{ id: string; fire_at_ms: number }> {
	if (!input?.channel) throw new Error("schedule: channel required");
	if (!input?.target) throw new Error("schedule: target required");
	if (!CHANNELS.includes(input.channel as Channel)) {
		throw new Error(`schedule: unknown channel '${input.channel}' (must be one of: ${CHANNELS.join(", ")})`);
	}
	const channel = input.channel as Channel;
	const fire_at_ms = parseFireAt(input.fire_at);
	const payload = normalizePayload(input.payload);
	validatePayloadForChannel(channel, payload);
	await validateTarget(channel, input.target, ctx);

	const store = ctx.store as any;
	const fields: Record<string, unknown> = {
		fire_at_ms: ctx.intVal(fire_at_ms),
		channel: ctx.stringVal(channel),
		target: ctx.stringVal(input.target),
		payload: ctx.stringVal(JSON.stringify(payload)),
		created_by: ctx.stringVal(input.created_by ?? "system"),
		status: ctx.stringVal("pending"),
		created_at_ms: ctx.intVal(Date.now()),
	};
	if (input.note) fields.note = ctx.stringVal(input.note);

	const id = await store.create(TYPE_KEY, JSON.stringify(fields));
	return { id, fire_at_ms };
}

async function doCancel(reminderId: string, ctx: ProgramContext): Promise<{ ok: boolean; was: Status }> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const state = await store.get(reminderId);
	if (!state || state.typeKey !== TYPE_KEY) throw new Error(`reminder not found: ${reminderId}`);
	const rec = recordFromState(reminderId, state.fields);
	if (!rec) throw new Error(`reminder is malformed: ${reminderId}`);
	if (rec.status !== "pending") return { ok: false, was: rec.status };
	const actor = client.objectActor.getOrCreate([reminderId]);
	await actor.setField("status", JSON.stringify(ctx.stringVal("cancelled")));
	return { ok: true, was: rec.status };
}

interface ListFilter {
	peer_id?: string;
	status?: Status | string;
	before_iso?: string;
	channel?: Channel | string;
}

async function doList(filter: ListFilter | undefined, ctx: ProgramContext): Promise<ReminderRecord[]> {
	const store = ctx.store as any;
	const refs = await store.list(TYPE_KEY) as { id: string }[];
	const before = filter?.before_iso ? Date.parse(filter.before_iso) : undefined;

	const records: ReminderRecord[] = [];
	for (const ref of refs) {
		const state = await store.get(ref.id);
		if (!state || state.deleted) continue;
		const rec = recordFromState(ref.id, state.fields);
		if (!rec) continue;
		if (filter?.peer_id && rec.created_by !== filter.peer_id && rec.target !== filter.peer_id) continue;
		if (filter?.status && rec.status !== filter.status) continue;
		if (filter?.channel && rec.channel !== filter.channel) continue;
		if (before !== undefined && rec.fire_at_ms > before) continue;
		records.push(rec);
	}
	records.sort((a, b) => a.fire_at_ms - b.fire_at_ms);
	return records;
}

async function doGet(reminderId: string, ctx: ProgramContext): Promise<ReminderRecord | null> {
	const store = ctx.store as any;
	const state = await store.get(reminderId);
	if (!state || state.typeKey !== TYPE_KEY || state.deleted) return null;
	return recordFromState(reminderId, state.fields);
}

// ── Dispatch a single reminder ───────────────────────────────────

// Transient error patterns that warrant one retry before giving up. These
// are network-blip signatures (most often `fetch failed` from Node when a
// TCP/TLS handshake is interrupted). A single retry has been observed to
// recover the recurring 'Auth-driven job scheduler' chain that otherwise
// dies permanently on a one-off blip — once a reminder is marked failed,
// nothing reschedules the next cycle.
const TRANSIENT_ERROR_PATTERNS = [
	/fetch failed/i,
	/econnreset/i,
	/etimedout/i,
	/enotfound/i,
	/eai_again/i,
	/socket hang up/i,
	/network error/i,
];
const DEFAULT_SCHEDULER_RETRY_DELAY_MS = 2000;
let schedulerRetryDelayMs = DEFAULT_SCHEDULER_RETRY_DELAY_MS;

function isTransientError(err: unknown): boolean {
	const msg = String((err as any)?.message ?? err);
	return TRANSIENT_ERROR_PATTERNS.some(p => p.test(msg));
}

/** Dispatch with one retry on transient (network-blip) errors. */
async function dispatchWithRetry(rec: ReminderRecord, ctx: ProgramContext): Promise<void> {
	try {
		await dispatchReminder(rec, ctx);
		return;
	} catch (err) {
		if (!isTransientError(err)) throw err;
		const raw = String((err as any)?.message ?? err);
		ctx.print(yellow(`  [remind] transient on ${rec.id.slice(0, 8)}: ${raw.slice(0, 120)} — retrying in ${schedulerRetryDelayMs}ms`));
		await new Promise(r => setTimeout(r, schedulerRetryDelayMs));
		await dispatchReminder(rec, ctx);
	}
}

async function dispatchReminder(rec: ReminderRecord, ctx: ProgramContext): Promise<void> {
	switch (rec.channel) {
		case "discord": {
			const message = typeof rec.payload.message === "string"
				? rec.payload.message
				: `[reminder fired] ${JSON.stringify(rec.payload)}`;
			await ctx.dispatchProgram("/discord", "send", [{ peer_id: rec.target, text: message }]);
			return;
		}
		case "email": {
			const subject = typeof rec.payload.subject === "string" ? rec.payload.subject : "Reminder";
			const body = typeof rec.payload.body === "string" ? rec.payload.body : String(rec.payload.message ?? "");
			await ctx.dispatchProgram("/mail", "send", [{
				to: rec.target, subject, body,
				cc: rec.payload.cc, bcc: rec.payload.bcc,
			}]);
			return;
		}
		case "agent_compose": {
			const prompt = typeof rec.payload.prompt === "string"
				? rec.payload.prompt
				: `Follow up: ${JSON.stringify(rec.payload)}`;
			await ctx.dispatchProgram("/holdfast", "ingest", [
				"scheduler",
				rec.target || rec.created_by,
				`[scheduled reminder fired] ${prompt}`,
			]);
			return;
		}
		default:
			throw new Error(`unknown reminder channel: ${rec.channel}`);
	}
}

/** Run the scheduler: find due reminders, dispatch them, mark status. */
export async function runSchedulerTick(ctx: ProgramContext): Promise<{ scanned: number; fired: number; failed: number }> {
	const now = Date.now();
	const refs = await (ctx.store as any).list(TYPE_KEY) as { id: string }[];
	const client = ctx.client as any;

	let scanned = 0;
	let fired = 0;
	let failed = 0;

	for (const ref of refs) {
		scanned++;
		const state = await (ctx.store as any).get(ref.id);
		if (!state || state.deleted) continue;
		const rec = recordFromState(ref.id, state.fields);
		if (!rec) continue;
		if (rec.status !== "pending") continue;
		if (rec.fire_at_ms > now) continue;

		const actor = client.objectActor.getOrCreate([rec.id]);
		// Idempotency guard: mark sending before dispatch. If we crash mid-dispatch,
		// the reminder stays in 'sending' — a subsequent manual audit resolves it.
		await actor.setField("status", JSON.stringify(ctx.stringVal("sending")));

		try {
			await dispatchWithRetry(rec, ctx);
			await actor.setFields(JSON.stringify({
				status: ctx.stringVal("sent"),
				sent_at_ms: ctx.intVal(Date.now()),
			}));
			fired++;
		} catch (err: any) {
			const raw = String(err?.message ?? err);
			await actor.setFields(JSON.stringify({
				status: ctx.stringVal("failed"),
				last_error: ctx.stringVal(raw.slice(0, 1000)),
			}));
			ctx.print(red(`  [remind] FAILED ${rec.id.slice(0, 8)} (${rec.channel}→${rec.target.slice(0, 8)}): ${raw.slice(0, 200)}`));
			failed++;
		}
	}

	return { scanned, fired, failed };
}

// ── Handler (CLI subcommands) ────────────────────────────────────

function statusColor(status: Status): (s: string) => string {
	switch (status) {
		case "pending": return yellow;
		case "sending": return cyan;
		case "sent": return green;
		case "failed": return red;
		case "cancelled": return dim;
		default: return dim;
	}
}

function channelLabel(channel: Channel): string {
	switch (channel) {
		case "discord": return magenta("discord");
		case "email": return cyan("email");
		case "agent_compose": return green("agent-compose");
		default: return channel;
	}
}

function formatReminder(rec: ReminderRecord): string {
	const when = new Date(rec.fire_at_ms).toLocaleString();
	const status = statusColor(rec.status)(rec.status);
	const chan = channelLabel(rec.channel);
	const note = rec.note ? ` ${dim(`"${rec.note}"`)}` : "";
	const err = rec.last_error ? `  ${red("err: " + rec.last_error.slice(0, 60))}` : "";
	return `    ${dim(rec.id.slice(0, 8))}  ${when.padEnd(22)}  ${status.padEnd(18)}  ${chan} → ${rec.target.slice(0, 16)}${note}${err}`;
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { resolveId, print } = ctx;

	switch (cmd) {
		// /remind schedule <channel> <target> <fire_at> <message...>
		case "schedule": {
			const channel = args[0];
			const target = args[1];
			const fire_at = args[2];
			const message = args.slice(3).join(" ");
			if (!channel || !target || !fire_at) {
				print(red("Usage: remind schedule <channel> <target> <fire_at> [message...]"));
				print(dim(`  channel: ${CHANNELS.join(" | ")}`));
				print(dim(`  fire_at: ISO date (e.g. 2026-04-24T15:00:00) or relative (+10m, +2h, +30s)`));
				print(dim(`  message: for discord/email channels, becomes payload.message`));
				break;
			}
			const payload: Record<string, unknown> = {};
			if (channel === "discord" && message) payload.message = message;
			if (channel === "email" && message) payload.body = message;
			if (channel === "agent_compose" && message) payload.prompt = message;

			try {
				const r = await doSchedule({
					channel: channel as Channel,
					target: await resolveId(target) ?? target,
					fire_at,
					payload,
				}, ctx);
				const when = new Date(r.fire_at_ms).toLocaleString();
				print(green("  scheduled: ") + bold(r.id));
				print(dim(`  fires at ${when}`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /remind list [--peer X] [--status Y] [--channel Z] [--before ISO]
		case "list": {
			const filter: ListFilter = {};
			for (let i = 0; i < args.length; i++) {
				const a = args[i];
				const n = args[i + 1];
				if (a === "--peer" && n) { filter.peer_id = n; i++; }
				else if (a === "--status" && n) { filter.status = n; i++; }
				else if (a === "--channel" && n) { filter.channel = n; i++; }
				else if (a === "--before" && n) { filter.before_iso = n; i++; }
			}
			const records = await doList(filter, ctx);
			if (records.length === 0) { print(dim("  (no reminders match)")); break; }
			print(bold(`  ${records.length} reminder(s)`));
			for (const rec of records) print(formatReminder(rec));
			break;
		}

		// /remind get <id>
		case "get": {
			const raw = args[0];
			if (!raw) { print(red("Usage: remind get <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			const rec = await doGet(id, ctx);
			if (!rec) { print(red("Reminder not found: ") + id); break; }
			print(formatReminder(rec));
			print(dim(`  payload: ${JSON.stringify(rec.payload)}`));
			print(dim(`  created_by: ${rec.created_by}`));
			if (rec.created_at_ms) print(dim(`  created_at: ${new Date(rec.created_at_ms).toLocaleString()}`));
			if (rec.sent_at_ms) print(dim(`  sent_at: ${new Date(rec.sent_at_ms).toLocaleString()}`));
			break;
		}

		// /remind cancel <id>
		case "cancel": {
			const raw = args[0];
			if (!raw) { print(red("Usage: remind cancel <id>")); break; }
			const id = await resolveId(raw);
			if (!id) { print(red("Not found: ") + raw); break; }
			try {
				const r = await doCancel(id, ctx);
				if (r.ok) print(green("  cancelled"));
				else print(dim(`  cannot cancel: status was ${r.was}`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /remind tick — run scheduler once now (manual trigger)
		case "tick": {
			try {
				const r = await runSchedulerTick(ctx);
				print(dim(`  scanned ${r.scanned}, fired ${r.fired}, failed ${r.failed}`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Remind") + dim(" — scheduled actions"),
				`    ${cyan("remind schedule")} ${dim("<channel> <target> <fire_at> [message...]")}`,
				`    ${cyan("remind list")} ${dim("[--peer X] [--status Y] [--channel Z] [--before ISO]")}`,
				`    ${cyan("remind get")} ${dim("<id>")}`,
				`    ${cyan("remind cancel")} ${dim("<id>")}`,
				`    ${cyan("remind tick")}                             ${dim("run scheduler once now")}`,
				"",
				dim(`  channels: ${CHANNELS.join(", ")}`),
				dim(`  fire_at: ISO date (2026-04-24T15:00:00) or +Ns / +Nm / +Nh`),
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API + tick loop) ─────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({ tickInProgress: false }),

	tickMs: DEFAULT_TICK_MS,

	onTick: async (ctx: ProgramContext) => {
		if (ctx.state.tickInProgress) return;
		ctx.state.tickInProgress = true;
		try {
			await runSchedulerTick(ctx);
		} catch (err: any) {
			ctx.print(dim(`  [remind] tick error: ${err?.message ?? String(err)}`));
		} finally {
			ctx.state.tickInProgress = false;
		}
	},

	actions: {
		schedule: async (ctx: ProgramContext, input: string | ScheduleInput) => {
			const parsed = typeof input === "string" ? JSON.parse(input) : input;
			return await doSchedule(parsed, ctx);
		},
		list: async (ctx: ProgramContext, filter?: string | ListFilter) => {
			const parsed = typeof filter === "string" ? (filter ? JSON.parse(filter) : undefined) : filter;
			return await doList(parsed, ctx);
		},
		get: async (ctx: ProgramContext, input: string | { reminder_id: string }) => {
			const reminderId = typeof input === "string" ? input : input?.reminder_id;
			if (!reminderId) throw new Error("remind.get: reminder_id required");
			return await doGet(reminderId, ctx);
		},
		cancel: async (ctx: ProgramContext, input: string | { reminder_id: string }) => {
			const reminderId = typeof input === "string" ? input : input?.reminder_id;
			if (!reminderId) throw new Error("remind.cancel: reminder_id required");
			return await doCancel(reminderId, ctx);
		},
		tick: async (ctx: ProgramContext) => {
			return await runSchedulerTick(ctx);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	doSchedule,
	doList,
	doGet,
	doCancel,
	runSchedulerTick,
	parseFireAt,
	recordFromState,
	normalizePayload,
	parsePayloadField,
	validatePayloadForChannel,
	validateTarget,
	/** Override scheduler retry delay (tests). Reset by passing undefined. */
	setRetryDelayMs(ms: number | undefined) {
		schedulerRetryDelayMs = ms ?? DEFAULT_SCHEDULER_RETRY_DELAY_MS;
	},
};
