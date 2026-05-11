// transport-gmail — send and receive Glon envelopes via Gmail.
//
// Auth: shells out to `gcloud auth print-access-token` to borrow the user's
// already-authenticated OAuth token. No separate OAuth app or service
// account — whatever account the user ran `gcloud auth login` with becomes
// the address this transport sends/receives on.
//
// Address format: `gmail://<email-address>` e.g. `gmail://alice@example.com`
//
// Subjects: `[GLON] <subject>` — `subject` defaults to "message" but the
// sender can pass `metadata.subject = "swap-offer abc12345"` to make it
// agent-readable. The leading prefix is the inbox filter; only messages
// whose subject starts with `[GLON] ` are picked up.
//
// Body: two-part. A human-readable preamble explaining what Glon is, then
// the base64-encoded TransportEnvelope between `-----GLON ENVELOPE BEGIN-----`
// and `-----GLON ENVELOPE END-----` markers. Recipients without Glon see
// the preamble. Recipients with Glon's transport-gmail extract the bytes
// between the markers.
//
// Inbox poll gating: transport-router calls inbox_drain every 5s, but we
// only actually hit Gmail every GMAIL_POLL_INTERVAL_SECONDS (default 30s)
// to stay clear of rate limits. Errors trigger exponential backoff capped
// at 5 min.
//
// Test injection points:
//   globalThis.__GMAIL_TOKEN_FN  — () => Promise<string>  (skip gcloud)
//   globalThis.__GMAIL_FETCH     — (req: { method, url, headers, body }) => Promise<{ ok, status, json, text }>

import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
import { dim, bold, cyan, green, red } from "../shared.js";
import { execFile } from "node:child_process";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const SUBJECT_PREFIX = "[GLON]";
const ENVELOPE_BEGIN = "-----GLON ENVELOPE BEGIN-----";
const ENVELOPE_END = "-----GLON ENVELOPE END-----";
const PROCESSED_LABEL_NAME = "Glon/Processed";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const POLL_BACKOFF_CAP_MS = 300_000;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

// ── Config ───────────────────────────────────────────────────────

function pollIntervalMs(): number {
	const raw = process.env.GMAIL_POLL_INTERVAL_SECONDS;
	if (!raw) return DEFAULT_POLL_INTERVAL_MS;
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 10) return DEFAULT_POLL_INTERVAL_MS;
	return n * 1000;
}

function maxBodyBytes(): number {
	const raw = process.env.SWAP_MAX_EMAIL_BODY_BYTES;
	if (!raw) return DEFAULT_MAX_BODY_BYTES;
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1024) return DEFAULT_MAX_BODY_BYTES;
	return n;
}

// ── Auth ─────────────────────────────────────────────────────────

interface FetchReq { method: string; url: string; headers: Record<string, string>; body?: string; }
interface FetchResp { ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string>; }

async function getAccessToken(): Promise<string> {
	const inj = (globalThis as any).__GMAIL_TOKEN_FN as undefined | (() => Promise<string>);
	if (inj) return await inj();
	return await new Promise<string>((resolve, reject) => {
		execFile("gcloud", ["auth", "application-default", "print-access-token"], { timeout: 15_000 }, (err, stdout, stderr) => {
			if (err) {
				const hint = "transport-gmail requires gcloud ADC with Gmail scope. Run: gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/gmail.modify";
				reject(new Error(`${hint}\nUnderlying: ${stderr?.trim() || err.message}`));
				return;
			}
			const tok = stdout.trim();
			if (!tok) {
				reject(new Error("transport-gmail: gcloud returned empty ADC token. Re-run `gcloud auth application-default login --scopes=...gmail.modify`."));
				return;
			}
			resolve(tok);
		});
	});
}

async function gmailFetch(req: FetchReq): Promise<FetchResp> {
	const inj = (globalThis as any).__GMAIL_FETCH as undefined | ((r: FetchReq) => Promise<FetchResp>);
	if (inj) return await inj(req);
	const resp = await fetch(req.url, {
		method: req.method,
		headers: req.headers,
		body: req.body,
	});
	const text = await resp.text();
	return {
		ok: resp.ok,
		status: resp.status,
		text: async () => text,
		json: async () => { try { return JSON.parse(text); } catch { return null; } },
	};
}

async function gmailRequest(method: string, path: string, opts: { token: string; body?: any; query?: Record<string, string> } = { token: "" }): Promise<any> {
	let url = `${GMAIL_API}${path}`;
	if (opts.query) {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(opts.query)) params.set(k, v);
		url += `?${params.toString()}`;
	}
	const headers: Record<string, string> = { "Authorization": `Bearer ${opts.token}` };
	let body: string | undefined;
	if (opts.body !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(opts.body);
	}
	const resp = await gmailFetch({ method, url, headers, body });
	if (!resp.ok) {
		const t = await resp.text();
		throw new Error(`Gmail ${method} ${path} failed: ${resp.status} ${t.slice(0, 300)}`);
	}
	return await resp.json();
}

// ── Encoding helpers ─────────────────────────────────────────────

/** Base64url encode (Gmail's RFC-4648 §5 variant: '+'→'-', '/'→'_', no padding). */
export function base64UrlEncode(bytes: Uint8Array | Buffer): string {
	const b = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
	return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64url decode → Buffer. */
export function base64UrlDecode(s: string): Buffer {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/");
	const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
	return Buffer.from(padded + pad, "base64");
}

/** Build an RFC822 message with our two-part body. Pure — testable. */
export function buildRfc822({ from, to, subject, preamble, payloadB64 }: {
	from: string;
	to: string;
	subject: string;
	preamble: string;
	payloadB64: string;
}): string {
	// Bare-bones text/plain. Gmail will rewrite Date and Message-ID.
	const headers = [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`MIME-Version: 1.0`,
		`Content-Type: text/plain; charset=utf-8`,
		`Content-Transfer-Encoding: 8bit`,
	];
	const body = [
		preamble.trim(),
		"",
		ENVELOPE_BEGIN,
		// Wrap to 76 chars so Gmail/most clients don't fold us awkwardly.
		(payloadB64.match(/.{1,76}/g) ?? [payloadB64]).join("\n"),
		ENVELOPE_END,
		"",
	].join("\n");
	return headers.join("\r\n") + "\r\n\r\n" + body;
}

/** Parse the GLON envelope payload out of an email body. Returns the
 *  original base64 string, or null if not found. Tolerant of CRLF and
 *  whitespace inside the markers. Pure — testable. */
export function extractEnvelopeFromBody(body: string): string | null {
	const start = body.indexOf(ENVELOPE_BEGIN);
	if (start === -1) return null;
	const after = start + ENVELOPE_BEGIN.length;
	const end = body.indexOf(ENVELOPE_END, after);
	if (end === -1) return null;
	const inner = body.slice(after, end);
	// Strip whitespace; base64 doesn't tolerate it.
	return inner.replace(/\s+/g, "");
}

/** Pull a header value out of Gmail's payload.headers list. */
function getHeader(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
	if (!headers) return "";
	const lower = name.toLowerCase();
	for (const h of headers) if (h.name?.toLowerCase() === lower) return h.value ?? "";
	return "";
}

/** Recursively flatten a Gmail message payload into a plain text string.
 *  Most Glon emails are text/plain so this just decodes a single part,
 *  but multipart bodies (e.g. if the recipient's client appends signatures)
 *  are concatenated. */
export function flattenPayloadText(payload: any): string {
	if (!payload) return "";
	const parts: string[] = [];
	const walk = (node: any) => {
		if (!node) return;
		if (node.body?.data) {
			try { parts.push(base64UrlDecode(node.body.data).toString("utf-8")); }
			catch { /* ignore part-level decode failure */ }
		}
		if (Array.isArray(node.parts)) for (const p of node.parts) walk(p);
	};
	walk(payload);
	return parts.join("\n");
}

/** Parse an "Alice <alice@example.com>" From: header → bare email. */
export function extractEmailAddress(header: string): string {
	if (!header) return "";
	const m = header.match(/<([^>]+)>/);
	if (m) return m[1].trim().toLowerCase();
	return header.trim().toLowerCase();
}

// ── Send ─────────────────────────────────────────────────────────

interface SendInput {
	endpoint: string;
	payload_b64: string;
	content_type: string;
	metadata?: Record<string, string>;
}

async function whoAmI(token: string, state: Record<string, any>): Promise<string> {
	if (state.selfEmail) return state.selfEmail as string;
	const profile = await gmailRequest("GET", "/users/me/profile", { token });
	const addr = String(profile?.emailAddress ?? "").toLowerCase();
	if (!addr) throw new Error("transport-gmail: could not resolve own email from gcloud token");
	state.selfEmail = addr;
	return addr;
}

async function doSend(ctx: ProgramContext, input: SendInput): Promise<{ delivery_id: string }> {
	const recipient = input.endpoint.replace(/^gmail:\/\//, "");
	if (!recipient || !recipient.includes("@")) {
		throw new Error(`transport-gmail: invalid endpoint ${input.endpoint} (expected gmail://<email>)`);
	}
	const token = await getAccessToken();
	const state = ctx.state as any;
	const from = await whoAmI(token, state);

	const meta = input.metadata ?? {};
	const subjectSuffix = meta.subject || meta.subject_suffix || "message";
	const subject = `${SUBJECT_PREFIX} ${subjectSuffix}`;

	const preamble = [
		`This is a Glon message (content-type: ${input.content_type}).`,
		``,
		`Glon is a peer-to-peer agent protocol; this email is a programmatic`,
		`payload that the sender's agent emitted on the user's behalf. If you`,
		`are not running Glon, you can safely ignore or reply with questions.`,
		``,
		`More info: https://github.com/Geep5/glon`,
		``,
		`The encoded payload follows; everything between the BEGIN/END markers`,
		`is the data your agent will read.`,
	].join("\n");

	const rfc822 = buildRfc822({
		from,
		to: recipient,
		subject,
		preamble,
		payloadB64: input.payload_b64,
	});
	const max = maxBodyBytes();
	if (Buffer.byteLength(rfc822, "utf8") > max) {
		throw new Error(`transport-gmail: message exceeds SWAP_MAX_EMAIL_BODY_BYTES (${max})`);
	}

	const raw = base64UrlEncode(Buffer.from(rfc822, "utf8"));
	const sent = await gmailRequest("POST", "/users/me/messages/send", {
		token,
		body: { raw },
	});
	const id = String(sent?.id ?? `gmail-${Date.now()}`);
	state.sentCount = (state.sentCount ?? 0) + 1;
	state.lastSentAt = Date.now();
	return { delivery_id: id };
}

// ── Inbox ────────────────────────────────────────────────────────

interface IncomingBlob {
	from_endpoint: string;
	payload_b64: string;
	content_type: string;
	received_at: number;
	metadata: Record<string, string>;
}

async function ensureProcessedLabel(token: string, state: Record<string, any>): Promise<string | null> {
	if (state.processedLabelId) return state.processedLabelId as string;
	const labels = await gmailRequest("GET", "/users/me/labels", { token });
	const list: Array<{ id: string; name: string }> = Array.isArray(labels?.labels) ? labels.labels : [];
	const existing = list.find((l) => l.name === PROCESSED_LABEL_NAME);
	if (existing) {
		state.processedLabelId = existing.id;
		return existing.id;
	}
	try {
		const created = await gmailRequest("POST", "/users/me/labels", {
			token,
			body: {
				name: PROCESSED_LABEL_NAME,
				labelListVisibility: "labelShow",
				messageListVisibility: "show",
			},
		});
		state.processedLabelId = String(created?.id ?? "");
		return state.processedLabelId || null;
	} catch (err: any) {
		// If we can't create the label, fall back to just removing UNREAD.
		// This isn't ideal (we'll see the same message twice if it's
		// re-marked unread) but it's not catastrophic.
		state.processedLabelId = null;
		return null;
	}
}

async function listGlonMessageIds(token: string): Promise<string[]> {
	// Filter: subject starts with our prefix AND not already labeled processed.
	const q = `subject:"${SUBJECT_PREFIX}" -label:${PROCESSED_LABEL_NAME.replace(/\//g, "-")}`;
	const result = await gmailRequest("GET", "/users/me/messages", {
		token,
		query: { q, maxResults: "20" },
	});
	const msgs: Array<{ id: string }> = Array.isArray(result?.messages) ? result.messages : [];
	return msgs.map((m) => m.id);
}

async function fetchMessage(token: string, id: string): Promise<any> {
	return await gmailRequest("GET", `/users/me/messages/${id}`, {
		token,
		query: { format: "full" },
	});
}

async function markProcessed(token: string, id: string, processedLabelId: string | null): Promise<void> {
	const addLabelIds: string[] = ["INBOX" as any].slice(0, 0); // empty
	const removeLabelIds: string[] = ["UNREAD"];
	if (processedLabelId) addLabelIds.push(processedLabelId);
	try {
		await gmailRequest("POST", `/users/me/messages/${id}/modify`, {
			token,
			body: { addLabelIds, removeLabelIds },
		});
	} catch (err: any) {
		// Non-fatal — worst case the message is processed again next poll
		// and produces a duplicate dispatch (content handlers should be
		// idempotent at the kernel level via change ids).
	}
}

async function doInboxDrain(ctx: ProgramContext): Promise<IncomingBlob[]> {
	const state = ctx.state as any;
	const now = Date.now();
	const interval = pollIntervalMs();

	// Honour the internal poll-interval gate. transport-router ticks every
	// 5s but we don't want to hit Gmail that aggressively.
	const last = state.lastPolledAt ?? 0;
	if (now - last < interval) return [];

	// Honour exponential backoff on errors.
	if (state.backoffUntil && now < state.backoffUntil) return [];

	let token: string;
	try {
		token = await getAccessToken();
	} catch (err: any) {
		ctx.print?.(red(`  [transport-gmail] auth failed: ${err?.message ?? String(err)}`));
		bumpBackoff(state, interval);
		state.lastPolledAt = now;
		return [];
	}

	state.lastPolledAt = now;

	let ids: string[];
	try {
		ids = await listGlonMessageIds(token);
	} catch (err: any) {
		ctx.print?.(dim(`  [transport-gmail] list failed: ${err?.message ?? String(err)}`));
		bumpBackoff(state, interval);
		return [];
	}

	if (ids.length === 0) {
		// Reset backoff on a clean (empty) poll.
		state.backoffUntil = 0;
		state.consecutiveErrors = 0;
		return [];
	}

	const processedLabelId = await ensureProcessedLabel(token, state);
	const blobs: IncomingBlob[] = [];

	for (const id of ids) {
		try {
			const msg = await fetchMessage(token, id);
			const headers = msg?.payload?.headers as Array<{ name: string; value: string }> | undefined;
			const subject = getHeader(headers, "Subject");
			const from = getHeader(headers, "From");
			if (!subject.startsWith(`${SUBJECT_PREFIX} `)) {
				// Wrong subject (Gmail's q is fuzzy). Mark processed so we
				// don't keep re-fetching it.
				await markProcessed(token, id, processedLabelId);
				continue;
			}
			const subjectRest = subject.slice(SUBJECT_PREFIX.length + 1);
			const senderEmail = extractEmailAddress(from);
			const bodyText = flattenPayloadText(msg?.payload);
			const envelopeB64 = extractEnvelopeFromBody(bodyText);
			if (!envelopeB64) {
				ctx.print?.(dim(`  [transport-gmail] skip ${id}: no envelope markers`));
				await markProcessed(token, id, processedLabelId);
				continue;
			}
			// Light content-type sniff: decode the envelope just enough to
			// surface its content_type to the router. Router will decode again
			// for real, but we want to populate IncomingBlob.content_type
			// for diagnostics.
			let contentType = "";
			let envelopeMeta: Record<string, string> = {};
			try {
				const { decodeTransportEnvelope } = await import("../../proto.js");
				const env = decodeTransportEnvelope(new Uint8Array(Buffer.from(envelopeB64, "base64")));
				contentType = env.contentType;
				envelopeMeta = env.metadata ?? {};
			} catch { /* router will report decode failure */ }
			blobs.push({
				from_endpoint: `gmail://${senderEmail}`,
				payload_b64: envelopeB64,
				content_type: contentType,
				received_at: Date.now(),
				metadata: { ...envelopeMeta, subject: subjectRest, gmail_id: id },
			});
			await markProcessed(token, id, processedLabelId);
		} catch (err: any) {
			ctx.print?.(dim(`  [transport-gmail] msg ${id.slice(0, 8)} processing failed: ${err?.message ?? String(err)}`));
			// Don't mark processed on failure — try again next poll.
		}
	}

	// All done with no exceptions: clear backoff.
	state.backoffUntil = 0;
	state.consecutiveErrors = 0;
	state.drainedCount = (state.drainedCount ?? 0) + blobs.length;
	state.lastDrainAt = Date.now();
	return blobs;
}

function bumpBackoff(state: Record<string, any>, baseMs: number): void {
	const errs = (state.consecutiveErrors ?? 0) + 1;
	state.consecutiveErrors = errs;
	const wait = Math.min(baseMs * Math.pow(2, errs - 1), POLL_BACKOFF_CAP_MS);
	state.backoffUntil = Date.now() + wait;
}

// ── Handler (CLI) ────────────────────────────────────────────────

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print } = ctx;
	if (cmd === "status") {
		const state = ctx.state as any;
		print(bold("  transport-gmail"));
		print(dim("    self email:    ") + (state.selfEmail ?? "(unresolved)"));
		print(dim("    sent:          ") + (state.sentCount ?? 0));
		print(dim("    drained:       ") + (state.drainedCount ?? 0));
		print(dim("    last poll:     ") + (state.lastPolledAt ? new Date(state.lastPolledAt).toISOString() : "(never)"));
		print(dim("    backoff until: ") + (state.backoffUntil ? new Date(state.backoffUntil).toISOString() : "(none)"));
		print(dim("    poll interval: ") + (pollIntervalMs() / 1000) + "s");
		return;
	}
	if (cmd === "ping") {
		try {
			const token = await getAccessToken();
			const state = ctx.state as any;
			const me = await whoAmI(token, state);
			print(green(`gcloud auth OK — ${me}`));
		} catch (err: any) {
			print(red(err?.message ?? String(err)));
		}
		return;
	}
	print([
		bold("  transport-gmail") + dim(" — Gmail send/receive transport"),
		`    ${cyan("transport-gmail status")}  show wiring + counters`,
		`    ${cyan("transport-gmail ping")}    verify gcloud auth + Gmail profile`,
		dim("    Address format: gmail://<email-address>"),
		dim("    Requires `gcloud auth login` with Gmail scope. Subject prefix: " + SUBJECT_PREFIX),
	].join("\n"));
};

// ── Actor ────────────────────────────────────────────────────────

const actorDef: ProgramActorDef = {
	createState: () => ({
		sentCount: 0,
		drainedCount: 0,
		lastPolledAt: 0,
		lastDrainAt: 0,
		lastSentAt: 0,
		backoffUntil: 0,
		consecutiveErrors: 0,
		selfEmail: "",
		processedLabelId: null,
	}),
	typedActions: {
		send: {
			description: "Send a payload to a Gmail recipient. Throws on delivery failure.",
			inputSchema: {
				type: "object",
				required: ["endpoint", "payload_b64", "content_type"],
				properties: {
					endpoint: { type: "string" },
					payload_b64: { type: "string" },
					content_type: { type: "string" },
					metadata: { type: "object" },
				},
			},
			handler: async (ctx, input: SendInput) => doSend(ctx, input),
		},
		inbox_drain: {
			description: "Drain new Glon-tagged emails from the inbox. Internally rate-limited.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => doInboxDrain(ctx),
		},
		ping: {
			description: "Verify gcloud auth and resolve the configured Gmail address.",
			inputSchema: { type: "object", properties: {} },
			handler: async (ctx) => {
				const token = await getAccessToken();
				const me = await whoAmI(token, ctx.state as any);
				return { ok: true, email: me };
			},
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

export const __test = {
	doSend,
	doInboxDrain,
	buildRfc822,
	extractEnvelopeFromBody,
	extractEmailAddress,
	flattenPayloadText,
	base64UrlEncode,
	base64UrlDecode,
	pollIntervalMs,
	bumpBackoff,
	SUBJECT_PREFIX,
	ENVELOPE_BEGIN,
	ENVELOPE_END,
	PROCESSED_LABEL_NAME,
};
