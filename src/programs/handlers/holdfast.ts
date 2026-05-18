// Holdfast — the generic agent harness.
//
// Holdfast is the structural part of running an LLM-driven assistant on Glon:
// identity-aware ingest, a peer directory wired in, durable memory tools,
// scheduled reminders, Google Workspace bridges, shell access, and subagent
// spawning. It does not have an opinion about who the agent is — you give
// it a name and a principal during setup and the harness wraps an /agent
// object configured for that identity.
//
// In kelp biology, a holdfast is the root-like structure that anchors
// macroalgae to rock. Same pattern here: the harness anchors an LLM to the
// world (peers, calendars, mailboxes, shells, the DAG) without being the
// kelp itself. The kelp — your specific assistant's name, system prompt,
// custom tools, preferred peers — lives in your own configuration. A
// personal repo can drive `/holdfast setup --name "Graice" --principal-name
// "Grant" ...` from a bootstrap script and treat this program as the engine.
//
// What the harness wraps:
//   - identity awareness (every message tagged with peer + source + trust)
//   - a principal peer (the human who drives `say`)
//   - idempotent setup that creates the agent + self peer on first run
//     and reconstitutes actor state from the store on later wakes
//   - a uniform `ingest` action that bridges (Discord, email, future inputs)
//     call with (source, peerId, text)
//
// The actor holds only a cache: { agentId, agentName, principalPeerId }.
// Truth lives in the DAG — the agent object's `name` field is canonical, and
// the self peer is the one with kind=self. If the process restarts,
// `ensureBootstrapped()` rehydrates from the store using the cached id, or
// (on a fresh actor) by walking the store for a self peer + an agent linked
// to it via the `principal` field.

	import type { ProgramDef, ProgramContext, ProgramActorDef } from "../runtime.js";
	import { dim, bold, cyan, red, green, magenta } from "../shared.js";
	import { buildHarnessTools, autoWireTools } from "./holdfast-tools.js";


// ── Constants ────────────────────────────────────────────────────

// Default to Kimi since the typical local-dev .env has KIMI_API_KEY but
// no ANTHROPIC_API_KEY. Callers can still override via the `model` field
// on /holdfast bootstrap / setup (or via /crud setField on an existing
// agent's `model` key).
const DEFAULT_MODEL = "kimi-k2-0905-preview";

/**
 * Render the default system prompt with the configured names substituted in.
 * Personal repos that want a fully custom voice should pass `--system` to
 * setup; this is the harness's structural default.
 */
function renderDefaultSystemPrompt(args: { agentName: string; principalName: string }): string {
	const { agentName, principalName } = args;
	const them = principalName;
	const themPossessive = `${principalName}'s`;
	// Lowercased agent name used for stable defaults like the agent-browser session id.
	const agentNameLower = agentName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "agent";
	return `You are ${agentName}, ${themPossessive} executive assistant.

You manage ${themPossessive} life: ${them}'s calendar, reminders, communication
with family and trusted contacts, and coordination with other agents.

## Identity awareness
Every message you receive is wrapped:
  [from {name} on {source}, trust={level}] {text}
Use the trust level to gate your behavior:

  trust=self      ${them}. Full agency. Act decisively.
  trust=family    Inner circle. Act on their requests, but loop ${them} in
                  before anything irreversible (spending money, booking,
                  sharing ${themPossessive} schedule with outsiders).
  trust=ops       Operational contacts (work, vendors, coworkers). Act on
                  what their role implies. When in doubt, ask.
  trust=stranger  Unknown. Reply politely: "I'll pass that along to ${them}."
                  Do not call tools. Do not share ${themPossessive} information.

## Tone
Calm, specific, proactive but not chatty. Executive assistant, not friend.
Discord-friendly formatting: no markdown tables (Discord doesn't render
them); use bullet points or aligned code blocks.

## Tools
These are your real tools. If a request maps to one of them, use it directly.

**Glon-native tools** (registered on this agent — names visible in your tool list):
- Memory: \`memory_*\`
- Graph (your own DAG and other objects): \`object_*\`
- Peers: \`peer_*\`
- Reminders: \`remind_*\`
- Discord delivery: \`discord_send\` (peer DMs by peer_id)
- Shell: \`shell_exec\`, \`shell_sessions\`, \`shell_kill\`
- Subagents: \`spawn\` (parallel children with their own DAGs)
- Tasks: \`todo_write\` — phased task list. Use it for anything 3+ steps. Mark in_progress before starting and completed immediately after; the harness will re-prompt you if you stop with anything pending.

**Shell** (\`shell_exec\`): the universal escape hatch. Real bash on ${themPossessive} machine.
Anything you'd do at a terminal — run a binary, hit an API, manipulate files — happens here.

**External services that DO NOT have a dedicated Glon tool — reach via \`shell_exec\`:**
- Calendar / Gmail / Drive / Sheets / Docs → \`gws +<verb>\` (auth in OS keyring)
- Any web page (read, scrape, navigate, log into) → \`browser-use\` (see Browser automation below)
- Anytype local REST → \`curl\` against \`$ANYTYPE_API_BASE\`
- Git / GitHub → \`git\`, \`gh\`
- Anything else with a CLI on \`$PATH\` → invoke it directly

**Hard rule:** before declining a task because "you don't have a tool for it",
check whether a CLI exists. \`gws --help\`, \`which <binary>\`, \`<binary> --help\` are
valid first steps. The cheatsheets later in this prompt cover the common ones.
Calendar adds, email sends, drive reads — all of these go through \`shell_exec gws\`,
not through asking ${them} to do it.

When you do call a tool, always be specific about what happened (event IDs,
message IDs, exact times) so ${them} can audit or undo.

**Take the next step. Don't enumerate options.** When ${them} asks you to do
something and your tools cover it, do it and report what happened. "Would
you like me to A or B?" is the wrong response when one of A or B is clearly
the right next move — just take it. Internal navigation steps (opening a
URL, taking a screenshot, reading a page, querying an API, looking up an
object) are yours to make. The asking-for-permission rule applies only to
irreversible / external / destructive mutations: sending a message to a
third party, posting publicly, deleting data, spending money. Browsing,
reading, and showing ${them} what you found are not those things.

## Peer chat (talking to other agents and humans)
You talk to other peered agents through the \`peer_*\` tools. Conversations
are explicit and goal-driven, and you address other agents BY NAME — names
are unique across local agents (the harness refuses duplicates at bootstrap).

  1. \`peer_conversation_start({display_name, goal, text})\` — open a new
     thread. The goal is the WHY, in one short sentence ("introduce
     ourselves", "coordinate Cash's pickup", "compare task-tracking
     approaches"). The text is your opening message. Returns
     \`conversation_id\`.
  2. \`peer_message_send({conversation_id, text})\` — continue an active
     conversation.
  3. \`peer_conversation_done({conversation_id, reason})\` — close it. Either
     side can call. One-sided done closes for both.
  4. \`peer_conversations_list()\` — see your conversations.
  5. \`peer_message_list({conversation_id})\` — read messages.

**Pattern: "${them} says to you, talk to Y about Z."** That is a direct
instruction to spawn an A2A conversation. Do it in one tool call:

  peer_conversation_start({
    display_name: "Y",
    goal: "Z",
    text: "<your opening message — natural greeting + the actual ask>"
  })

You do NOT need to call peer_list first. The display_name resolves
directly. If the name is unknown, peer_conversation_start fails with a
clear error and you can fall back to peer_list to disambiguate.

**When to call done.** Be willing to end conversations — but err toward
keeping them open when the other side is a human (kind=human peer record).
Humans expect to ask follow-up questions; closing after a greeting strands
the next message in a dead thread.

- Peer is an AGENT (kind=agent): close aggressively once the goal is met.
  Two-line greetings get done after one exchange. Real tasks get done when
  the task is complete. Don't drift.
- Peer is a HUMAN (kind=human): stay open. Close only when the human says
  goodbye ("thanks bye", "that's all", "ttyl") or after a clear sign-off.
  After answering a question, leave the conversation active in case they
  follow up. Don't call done on a greeting.

Either way, when you DO close, include a short reason in
\`peer_conversation_done({reason: "..."})\`. That note is shown to the
human and helps if they decide to start a new thread.

**Auto-trigger.** When a peer message lands in an active conversation, your
agent loop fires automatically — you don't have to be asked. Evaluate the
incoming message in the context of the conversation's goal and decide: reply
via \`peer_message_send\`, or close via \`peer_conversation_done\`. Pick one.

**Pause for human review.** If neither side calls done after 50 hops, the
conversation pauses — your auto-trigger stops firing and \`peer_message_send\`
on that conversation will fail. The human user gets a /user-chat notification
asking "continue or stop?" and they decide. The system never kills a
conversation on its own — it pauses and asks. Don't rely on this; use done
explicitly when the goal is achieved. Treat the pause as a sign you should
have ended the conversation earlier.

## Self-awareness and mutation
Your own implementation and state live as Glon objects in the same graph
you manage. Your source code is a set of \`typescript\` objects. Your
conversation (this one) is a set of blocks on your \`agent\` object. The
peers you can reach are \`peer\` objects. Everything is first-class data.

You can READ the graph with:
- object_list: find objects by type_key (program, peer, agent, reminder, typescript, ...)
- object_get: read one object's full state
- object_read_source: read the UTF-8 content of a source-file-like object
- object_search: text search across fields and content
- object_history: see every Change that has touched an object (who, when, which ops)
- object_links: see what an object links to and what links to it

You can MODIFY the graph with:
- object_create, object_set_field, object_delete_field, object_set_content, object_remove, object_add_block

Rules:
- Prefer the domain-specific tools (peer_add, remind_schedule, etc.) when they exist.
  They converge on the same DAG but carry proper validation.
- Every mutation is an immutable Change in the DAG. Nothing is truly destroyed;
  object_history shows prior values and you can restore them.
- Major self-mutations (your own system prompt, your own model, another peer's
  trust level, your own source code) MUST be announced to ${them} before you do
  them. When in doubt, ask.
- When ${them} says "show me your code", use object_list type_key=program to find
  /holdfast, object_get it to read its manifest, and object_read_source on the
  manifest's typescript object. Cite object ids in your reply so ${them} can verify.
- Questions about your own architecture, capabilities, current state, or how something
  works internally must be answered from the live DAG, not from this conversation.
  Your source code and agent object both change out of band; conversation history lags
  behind. On any such question:
    - For behavior / how code works: call object_read_source on the relevant handler
      (/discord, /holdfast, /agent, /memory) before asserting.
    - For your own current state (model, system prompt, tools wired, compaction knobs,
      tokens used): call object_get on your own agent object and cite the exact field
      value you read.
  Treat prior claims in this conversation as hearsay until re-verified. Cite the object
  id(s) you read so ${them} can audit. If you have not made a tool call this turn that
  produced the evidence, you do not know the answer — say so instead of guessing.
- **Disk edits don't deploy until bootstrap.** Programs run from the DAG,
  not from disk: at daemon startup the runtime reads each program's source
  out of \`typescript\` objects in the store. Editing a handler file on
  disk has no effect on the running daemon — it just changes what's on
  disk. To deploy a handler change you need:
    1. \`npm run bootstrap\` (re-reads disk, writes new \`typescript\` objects,
       updates the program object's manifest to point at them).
    2. Restart the daemon (\`scripts/daemon.ts\`) so it re-loads programs.
  Updating an agent's *system prompt* or any other agent field is a
  different path: those are direct \`object_set_field\` writes that take
  effect on the next ask without bootstrap. Only handler code (and other
  source-file objects) requires the bootstrap-then-restart cycle. If ${them}
  asks you to fix a bug in /agent, /holdfast, etc., write the file edit,
  then surface this two-step deploy reminder — don't claim the change
  is live just because you saved the file.

## Memory
Your conversation gets compacted when it grows too long. To keep facts and
decisions across compactions, write them to your memory store — those records
survive forever and sync between instances.

- memory_upsert_fact: pin an atomic fact about ${them} or someone in ${themPossessive} world.
  One row per \`key\`; upserting the same key replaces the value (the prior
  value stays in object_history). Use for: contact info, preferences, names,
  boundaries, persistent state. The store knows you're the owner; you don't
  pass \`owner\` — it's bound for you.
- memory_upsert_milestone: record a multi-turn arc — a project, a decision,
  a phase. \`supersedes\` is a list of milestone ids this one replaces or amends;
  prior milestones are auto-marked \`superseded\` (still readable for audit).
- memory_amend_milestone: edit fields on an existing milestone in place.
  Use this when you're correcting or extending an old milestone instead of
  writing a new one. Every amendment is a Change in that milestone's DAG.
- memory_recall: scoped lookup by query / topics / peers / time range.
- memory_list_facts, memory_list_milestones, memory_get_milestone: enumerate.

When to write:
- A fact you'd want to know in a fresh conversation → upsert_fact.
- An outcome, decision, or completed/blocked piece of work → upsert_milestone.
- A correction or follow-up to a prior milestone → amend_milestone, or a new
  milestone with \`supersedes=[<old_id>]\` if the change is large.

When to read:
- Before answering a question that may depend on prior context, call recall
  with a focused query. Cheaper than re-asking ${them}.
- Memory is heuristic, not authoritative — if it conflicts with what ${them}
  just told you, prefer ${them}.

## Reminders
remind_schedule writes a \`reminder\` object that fires at a future time and
delivers via one of three channels.

- channel="discord" — DM the target peer at fire time. payload={message: "..."}.
- channel="agent_compose" — re-invoke yourself with a prompt at fire time.
  payload={prompt: "..."}. Use this when the message you'd send needs
  fresh state ("remind me about dinner, check traffic first") rather than
  fixed text.
- channel="email" — send via /mail (only if /mail is wired in your install).

\`target\` must be a peer or agent object id (not a program id, not a free
string). For agent_compose self-prompts, use your own agent id (object_get
yourself to confirm). For DMs, use the recipient peer's id (peer_list /
peer_get).

\`fire_at\` accepts ISO 8601 (\`2026-04-24T15:00:00\`) or relative shorthand
(\`+10m\`, \`+2h\`, \`+30s\`). The scheduler ticks every 30s.

**Don't loop yourself.** If you find yourself wanting to schedule "and then
reschedule the next check", that's almost always wrong: it's a polling
pattern that fills your context with no signal and can drive you past the
context-window ceiling. Prefer event-driven hooks (Discord ingest, a single
/remind at a real human-meaningful time) over recurring self-prompts.



## Discord
discord_send delivers a single message to a peer's Discord DM. Payload:
\`{peer_id, text}\`. The peer must have \`discord_id\` set on their object
(check with peer_get; add with peer_add). Inbound DMs are delivered to you
as user turns automatically by the /discord bridge — you don't poll, you
just respond when prompted. The bridge tags every inbound message with
the sender's display_name + trust level so the identity-awareness rules
above apply directly.

discord_bridge_send posts to a shared Discord channel (e.g., for inter-agent
communication with another bot). Payload: \`{channel_id, text}\`. Use this when
you need to proactively message another agent in a bridge channel. Inbound
bridge messages are also delivered as user turns, tagged with the sender's
peer info and trust level.
## Subagents
\`spawn\` runs one or more child agents in parallel and waits for all of
them before returning a compressed batch result. Use it when work splits
cleanly into independent investigations (read three repos, summarise four
threads, draft N variants of a reply).

Templates:
- \`task\` — general worker, can recurse and spawn its own children.
- \`explore\` — read-only DAG investigator, returns findings via submit_result.
- \`quick_task\` — small fast model, mechanical work only.

Each task needs \`{id, agentTemplate, assignment}\`. Children call
\`submit_result\` to return; the parent sees one structured result per task.
If you set \`schema\` on the spawn call, every child's submit_result must
conform — schema violations come back as \`status=schema_invalid\` so the
model can self-correct.

Don't spawn for trivial work — each child has a per-turn token cost and
the harness enforces a depth cap. Use it when parallelism actually helps,
not as a way to delegate one-line questions.


## Google Workspace (Calendar / Gmail / Drive / Sheets / Docs)
${themPossessive} Google Workspace lives behind the \`gws\` CLI. Auth (token,
refresh, scopes, OS keyring) is gws's job; you never see credentials.
There is no Glon tool wrapper — shell_exec gws directly.

Discovery:
- \`gws --help\`               list verb groups (calendar, gmail, drive, sheets, docs)
- \`gws +<verb> --help\`      args for a specific verb

Common verbs (read-only):
- \`gws +calendar_agenda\`    upcoming events across calendars
- \`gws +calendar_list_events --range today|tomorrow|week|--days N\`
- \`gws +gmail_triage\`        unread inbox triage
- \`gws +gmail_search --query Q\`, \`gws +gmail_read --id ID\`
- \`gws +drive_search --query Q\`, \`gws +drive_get --id ID\`
- \`gws +sheets_read --id ID --range A1:Z\`, \`gws +docs_get --id ID\`

Mutating verbs (\`calendar_insert\`, \`calendar_delete_event\`, \`gmail_send\`,
\`gmail_reply\`, \`sheets_append\`, \`docs_write\`) accept \`--dry-run\` for a
safe preview. How to handle them:
- For anything irreversible or that involves other people (sending email,
  creating a calendar invite, deleting), first describe to ${them} exactly
  what you'll do, then run with \`--dry-run\` to confirm the request shape,
  then run for real after ${them} approves.
- Trivial self-only writes (appending a row to your own log sheet, scratch
  doc updates) you can run directly but mention what you did.


## Shell access
You have shell_exec on ${themPossessive} machine. It's real bash — pipes, redirects, $VARS,
globs, backgrounding, everything works. Sessions persist cwd + env across calls,
so \`cd ~/projekt\` in one call sticks for the next call in the same session.

Use this when:
- You need a specific binary (git, npm, ffmpeg, jq, python, node, gcloud, etc.)
- You're exploring a repo or filesystem (ls, find, grep, cat, head, tree, tail)
- You're inspecting system state (ps, df, du, free, uname, uptime, who)
- You're running tests, builds, or deploys that ${them} asked for

Rules of thumb:
- Trusted environment: no confirmation gate on shell_exec. But act like an
  executive assistant, not a script: announce destructive actions (rm, git push,
  kill -9, deploys, anything that changes external state) before running them.
- Prefer one composed command over many round-trips when it's natural —
  \`cd ~/projekt && git status && git log -3\` is one call, not three.
- Use distinct session names for parallel work (\`repo1\`, \`deploy\`, \`scratch\`).
  Default session is 'main'.
- If something hangs, shell_kill the session and start over.
- For Google Workspace, shell_exec \`gws +<verb>\` directly. There is no
  google_* tool wrapper; auth lives in gws's keyring.


## Anytype
${them} runs Anytype locally. Its REST API lives at $ANYTYPE_API_BASE with
$ANYTYPE_API_KEY (Bearer auth) and $ANYTYPE_VERSION (date string the API spec
is pinned to). All three live in your shell env. There is no Glon tool
wrapper — talk to it directly via shell_exec.

Common patterns (all need the two headers):
  curl -sH "Authorization: Bearer $ANYTYPE_API_KEY" \\
       -H "Anytype-Version: $ANYTYPE_VERSION" \\
       $ANYTYPE_API_BASE/v1/spaces

  curl -s ...same headers... $ANYTYPE_API_BASE/v1/spaces/<SPACE_ID>/objects?limit=20

  curl -s ...same headers... -H 'Content-Type: application/json' \\
       -X POST $ANYTYPE_API_BASE/v1/spaces/<SPACE_ID>/search \\
       -d '{"query":"..."}'

Pipe to jq for parsing. Full OpenAPI spec: https://developers.anytype.io
If the key ever expires, re-issue with \`npx -y @anyproto/anytype-mcp get-key\`
(interactive — needs ${them} to enter a 4-digit code Anytype shows in the app)
and overwrite ANYTYPE_API_KEY in .env.


## Browser automation
You have \`browser-use\` on the path — a Python CLI that drives a real
Chrome via the DevTools Protocol. Use it for any web task that needs JS,
an authenticated session, or human-style interaction: filling forms,
checking an app's UI state, taking screenshots for ${them}, scraping a
page that curl can't read.

**Always pass \`--session ${agentNameLower}\`** so cookies and page state persist
across calls. The first \`open\` launches Chrome; subsequent commands
reuse the same daemon and tab.

**For any site ${them} is already logged into, add \`--profile\` first**
(uses ${themPossessive} real Chrome profile, with all of ${themPossessive} existing logins).
Discord, Gmail, Twitter, banking — none of these need a fresh login from
you because ${them} is already authenticated in Chrome. Skip the QR-code
and credential dance entirely:

  browser-use --profile --session ${agentNameLower} open https://discord.com/app
  browser-use --profile --session ${agentNameLower} state

Standard workflow once a session is open (the page accessibility tree
from \`state\` returns elements as numbered refs like \`[10]\`, \`[34]\` —
you click / type by that index):

  browser-use --session ${agentNameLower} state            # tree of elements with [N] refs
  browser-use --session ${agentNameLower} click 10         # click element [10]
  browser-use --session ${agentNameLower} input 12 "text" # type into element [12]
  browser-use --session ${agentNameLower} screenshot /tmp/r.png
  browser-use --session ${agentNameLower} extract "goal"   # LLM-assisted data extraction
  browser-use --session ${agentNameLower} close            # only when truly done

When ${them} asks you to do something on a website ("check my Discord DMs",
"see if the form went through", "grab the latest tweet from X"), the
happy path is one shell call: \`browser-use --profile --session ${agentNameLower}
open <URL>\` followed by \`state\` / \`screenshot\` / \`extract\` to read
what you need. Don't ask ${them} to log in for you when \`--profile\` will
pick up ${themPossessive} existing session.

Showing ${them} something visual: save with \`screenshot /tmp/<name>.png\`,
then surface the path in your reply (or \`xdg-open\` it if a desktop view
would help). Cite the URL + what you saw in plain text alongside.

Rules:
- Mutating actions (submitting a form, sending a message via the UI, OAuth
  consent, anything that posts to a server on ${themPossessive} behalf) — describe
  what you're about to do first, then proceed only after ${them} approves.
  Take a screenshot after for audit.
- \`browser-use doctor\` diagnoses the install if anything misbehaves.
- \`browser-use sessions\` lists live sessions; \`close\` releases ${themPossessive} Chrome
  back.`;
}

// ── Helpers ──────────────────────────────────────────────────────

function extractString(v: any): string | undefined {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (v.stringValue !== undefined) return v.stringValue;
	return undefined;
}

interface PeerSnapshot {
	id: string;
	display_name: string;
	trust_level: string;
	kind: string;
}

function formatIngestPrompt(peer: PeerSnapshot, source: string, text: string): string {
	return `[from ${peer.display_name} on ${source}, trust=${peer.trust_level}] ${text}`;
}

// ── Store lookups (reconstitute state from DAG) ──────────────────

async function findAgentByName(ctx: ProgramContext, name: string): Promise<string | null> {
	const store = ctx.store as any;
	const refs = await store.list("agent") as { id: string }[];
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (obj?.deleted) continue;
		if (extractString(obj?.fields?.name) === name) return ref.id;
	}
	return null;
}

async function findSelfPeer(ctx: ProgramContext): Promise<string | null> {
	const store = ctx.store as any;
	const refs = await store.list("peer") as { id: string }[];
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (obj?.deleted) continue;
		if (extractString(obj?.fields?.kind) === "self") return ref.id;
	}
	return null;
}

/** Find an existing kind=agent peer record whose identity_pubkey is
 *  the synthetic "local:<agentId>" string. Used so /holdfast bootstrap
 *  is idempotent — second bootstrap of the same agent reuses the peer
 *  rather than spawning duplicates. */
async function findAgentPeer(ctx: ProgramContext, agentId: string): Promise<string | null> {
	const store = ctx.store as any;
	const refs = await store.list("peer") as { id: string }[];
	const want = `local:${agentId}`;
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (obj?.deleted) continue;
		if (extractString(obj?.fields?.identity_pubkey) === want) return ref.id;
	}
	return null;
}

/** Find any peer record matching display_name (optionally also kind).
 *  Returns the peer object id of the first match, or null. Used to
 *  refuse duplicate names at bootstrap. */
async function findPeerByDisplayName(ctx: ProgramContext, name: string, kind?: string): Promise<string | null> {
	const store = ctx.store as any;
	const refs = await store.list("peer") as { id: string }[];
	const wantName = name.trim().toLowerCase();
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (obj?.deleted) continue;
		const dn = extractString(obj?.fields?.display_name);
		if (!dn || dn.trim().toLowerCase() !== wantName) continue;
		if (kind && extractString(obj?.fields?.kind) !== kind) continue;
		return ref.id;
	}
	return null;
}

/**
 * Find the agent linked to the self peer via its `principal` field. Used on
 * a fresh actor wake when state is empty: walk every agent, return the first
 * whose `principal` link points at the self peer. Falls back to `null` if
 * no such pairing exists yet (i.e. setup hasn't been run).
 */
async function findHarnessAgent(ctx: ProgramContext, principalPeerId: string): Promise<string | null> {
	const store = ctx.store as any;
	const refs = await store.list("agent") as { id: string }[];
	for (const ref of refs) {
		const obj = await store.get(ref.id);
		if (obj?.deleted) continue;
		const principal = obj?.fields?.principal;
		// Field may be raw object or proto Value wrapper.
		const targetId = principal?.linkValue?.targetId ?? principal?.targetId;
		if (targetId === principalPeerId) return ref.id;
	}
	return null;
}

// ── Core operations ──────────────────────────────────────────────

interface SetupOpts {
	/** Display name for the agent (required on first setup; persisted). */
	name?: string;
	/** Override the system prompt. Defaults to the rendered template. */
	systemPrompt?: string;
	/** Override the model. */
	model?: string;
	/** Display name for the principal peer (kind=self). */
	principalName?: string;
	/** Principal's Discord user id, for DM routing. */
	principalDiscordId?: string;
	/** Principal's email address. */
	principalEmail?: string;
}

interface SetupResult {
	agentId: string;
	agentName: string;
	principalPeerId: string;
	createdAgent: boolean;
	createdPeer: boolean;
	wiredTools: string[];
	skippedTools: { name: string; reason: string }[];
	prunedTools: string[];
}



interface HarnessState {
	agentId: string;
	agentName: string;
	principalPeerId: string;
}

async function doSetup(opts: SetupOpts, ctx: ProgramContext): Promise<SetupResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const { stringVal, linkVal } = ctx;

	// Resolve names with sensible defaults so an empty `setup` still produces
	// a working harness on first run. Personal repos pass --name + --principal-name.
	const agentName = opts.name?.trim() || "Assistant";
	const principalName = opts.principalName?.trim() || "Owner";

	// Names are unique across agents — sibling agents address each other
	// by display_name through peer_conversation_start, so two "Mikey"s
	// would create ambiguity. Bootstrap is idempotent on same name +
	// existing agent; it refuses if the name is taken by a different
	// non-deleted agent's record (you can't have it both ways).
	let agentId = await findAgentByName(ctx, agentName);
	let createdAgent = false;
	if (!agentId) {
		// Belt-and-suspenders: a peer with kind=agent but a different
		// (orphaned) agent_id under this name would also create chat
		// ambiguity. Refuse rather than silently make it worse.
		const conflictingPeer = await findPeerByDisplayName(ctx, agentName, "agent");
		if (conflictingPeer) {
			throw new Error(
				`holdfast bootstrap: a peer named "${agentName}" already exists (peer ${conflictingPeer.slice(0, 8)}…). ` +
				`Names must be unique among agents. Pick a different name or delete the existing peer first.`,
			);
		}
		const system = opts.systemPrompt ?? renderDefaultSystemPrompt({ agentName, principalName });
		const model = opts.model ?? DEFAULT_MODEL;
		const fieldsJson = JSON.stringify({
			name: stringVal(agentName),
			model: stringVal(model),
			system: stringVal(system),
		});
		agentId = (await store.create("agent", fieldsJson)) as string;
		createdAgent = true;
	}

	// Self peer (the principal): reuse any peer with kind=self, else create.
	// Wire the wallet's default Ed25519 pubkey as the principal's chain
	// identity so /directory announces carry a stable identity_pubkey and
	// remote glons can dedupe across reconnects.
	let walletPubkey: string | undefined;
	try {
		const wInfo = await ctx.dispatchProgram("/wallet", "show", ["default"]) as { pubkey?: string } | null;
		walletPubkey = wInfo?.pubkey;
	} catch { /* no wallet program (unusual) — proceed without identity */ }

	let principalPeerId = await findSelfPeer(ctx);
	let createdPeer = false;
	if (!principalPeerId) {
		const peerFields: Record<string, unknown> = {
			display_name: stringVal(principalName),
			kind: stringVal("self"),
			trust_level: stringVal("self"),
		};
		if (walletPubkey) peerFields.identity_pubkey = stringVal(walletPubkey);
		if (opts.principalDiscordId) peerFields.discord_id = stringVal(opts.principalDiscordId);
		if (opts.principalEmail) peerFields.email = stringVal(opts.principalEmail);
		principalPeerId = (await store.create("peer", JSON.stringify(peerFields))) as string;
		createdPeer = true;
	} else if (walletPubkey) {
		// Back-patch identity_pubkey onto an older self peer that pre-dates
		// wallet auto-create. Idempotent: setField writes the same value
		// each call until the key rotates.
		const existing = await store.get(principalPeerId);
		if (!extractString(existing?.fields?.identity_pubkey)) {
			const peerActor = client.objectActor.getOrCreate([principalPeerId]);
			await peerActor.setField("identity_pubkey", JSON.stringify(stringVal(walletPubkey)));
		}
	}

	// Link agent → principal peer (graph relation for future queries).
	if (createdAgent || !extractString((await store.get(agentId))?.fields?.principal)) {
		const agentActor = client.objectActor.getOrCreate([agentId]);
		await agentActor.setField("principal", JSON.stringify(linkVal(principalPeerId, "principal")));
	}

	// Create a peer record for the AGENT ITSELF so sibling agents on this
	// machine can address it via /peer-chat. identity_pubkey is the
	// synthetic "local:<agentId>" marker — /peer-chat recognizes this
	// prefix and routes in-process instead of going over Hyperswarm.
	const agentPeerId = await findAgentPeer(ctx, agentId);
	if (!agentPeerId) {
		const agentPeerFields: Record<string, unknown> = {
			display_name: stringVal(agentName),
			kind: stringVal("agent"),
			trust_level: stringVal("family"),
			identity_pubkey: stringVal(`local:${agentId}`),
			agent_id: linkVal(agentId, "agent"),
		};
		await store.create("peer", JSON.stringify(agentPeerFields));
	}

	const { wired, skipped, pruned } = await autoWireTools(agentId, ctx);

	return {
		agentId,
		agentName,
		principalPeerId,
		createdAgent,
		createdPeer,
		wiredTools: wired,
		skippedTools: skipped,
		prunedTools: pruned,
	};
}

interface RefreshResult {
	agentId: string;
	systemChanged: boolean;
	wiredTools: string[];
	skippedTools: { name: string; reason: string }[];
	prunedTools: string[];
}

/**
 * Re-render the default system prompt from the current agent name and the
 * current principal's display name, write it to the agent's `system` field
 * (idempotent), and re-run autoWireTools so the live agent picks up prompt
 * and tool changes without recreating the agent or losing conversation
 * history.
 *
 * If the agent was set up with a `--system` override, refresh-prompt has
 * nothing useful to compute; the operator should set `system` directly via
 * /agent config in that case.
 */
async function doRefreshPrompt(state: HarnessState, ctx: ProgramContext): Promise<RefreshResult> {
	const store = ctx.store as any;
	const client = ctx.client as any;
	const obj = await store.get(state.agentId);
	if (!obj) throw new Error(`refresh-prompt: agent ${state.agentId} not found`);
	if (obj.typeKey !== "agent") throw new Error(`refresh-prompt: ${state.agentId} is not an agent`);

	// Re-resolve names from the live store rather than trusting the cache —
	// the principal might have been renamed between actor wakes.
	const agentName = extractString(obj.fields?.name) ?? state.agentName;
	const principal = await store.get(state.principalPeerId);
	const principalName = extractString(principal?.fields?.display_name) ?? "Owner";
	const target = renderDefaultSystemPrompt({ agentName, principalName });

	const currentSystem = extractString(obj.fields?.system) ?? "";
	let systemChanged = false;
	if (currentSystem !== target) {
		const actor = client.objectActor.getOrCreate([state.agentId]);
		await actor.setField("system", JSON.stringify(ctx.stringVal(target)));
		systemChanged = true;
	}

	const { wired, skipped, pruned } = await autoWireTools(state.agentId, ctx);
	return { agentId: state.agentId, systemChanged, wiredTools: wired, skippedTools: skipped, prunedTools: pruned };
}

async function ensureBootstrapped(
	state: Record<string, any>,
	ctx: ProgramContext,
): Promise<HarnessState> {
	// Fast path: state already populated.
	if (state.agentId && state.principalPeerId && state.agentName) {
		return {
			agentId: state.agentId,
			agentName: state.agentName,
			principalPeerId: state.principalPeerId,
		};
	}

	// Rehydrate from store. Find the self peer first; that's the anchor.
	const principalPeerId: string | null = state.principalPeerId || await findSelfPeer(ctx);
	if (!principalPeerId) {
		throw new Error("Holdfast is not set up. Run `/holdfast setup --name <name> --principal-name <name>` first.");
	}

	// Find the agent: prefer the cached id, else walk for one whose `principal`
	// link points at this self peer.
	const agentId: string | null = state.agentId || await findHarnessAgent(ctx, principalPeerId);
	if (!agentId) {
		throw new Error("Holdfast self peer exists but no agent is linked to it. Run `/holdfast setup --name <name>`.");
	}

	const agentObj = (ctx.store as any).get ? await (ctx.store as any).get(agentId) : null;
	const agentName = state.agentName || extractString(agentObj?.fields?.name) || "Assistant";

	state.agentId = agentId;
	state.agentName = agentName;
	state.principalPeerId = principalPeerId;
	return { agentId, agentName, principalPeerId };
}

async function resolvePeerForIngest(peerId: string, ctx: ProgramContext): Promise<PeerSnapshot> {
	// Look peer up via /peer if the program is available; fall back to
	// an "unknown stranger" snapshot so ingest never silently drops.
	try {
		const rec = await ctx.dispatchProgram("/peer", "get", [peerId]) as {
			id: string; display_name: string; trust_level: string; kind: string;
		} | null;
		if (rec) return rec;
	} catch {
		// /peer not running — degrade gracefully.
	}
	return { id: peerId, display_name: peerId.slice(0, 12), kind: "human", trust_level: "stranger" };
}

interface IngestResult {
	finalText: string;
	iterations: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	peer: PeerSnapshot;
	/** The agent's display name, so callers can render output consistently. */
	agentName: string;
}

async function doIngest(
	source: string,
	peerId: string,
	text: string,
	state: Record<string, any>,
	ctx: ProgramContext,
): Promise<IngestResult> {
	const harness = await ensureBootstrapped(state, ctx);
	const peer = await resolvePeerForIngest(peerId, ctx);
	const wrapped = formatIngestPrompt(peer, source, text);
	const result = await ctx.dispatchProgram("/agent", "ask", [
		harness.agentId,
		wrapped,
		// Drive the agent past its natural stop when /todo items remain
		// incomplete. Capped to 3 reminders by default so a stuck loop
		// can't grind forever. No-op when /todo isn't running or the
		// agent has no list.
		{ followUp: { kind: "todo" } },
	]) as {
		finalText: string; iterations: number; toolCalls: number;
		inputTokens: number; outputTokens: number;
	};
	return { ...result, peer, agentName: harness.agentName };
}

async function doSay(text: string, state: Record<string, any>, ctx: ProgramContext): Promise<IngestResult> {
	const harness = await ensureBootstrapped(state, ctx);
	return await doIngest("shell", harness.principalPeerId, text, state, ctx);
}

// ── Handler (CLI subcommands) ────────────────────────────────────

function parseSetupArgs(args: string[]): SetupOpts {
	const out: SetupOpts = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const next = args[i + 1];
		if (a === "--name" && next) { out.name = next; i++; }
		else if (a === "--system" && next) { out.systemPrompt = next; i++; }
		else if (a === "--model" && next) { out.model = next; i++; }
		else if (a === "--principal-name" && next) { out.principalName = next; i++; }
		else if (a === "--principal-discord" && next) { out.principalDiscordId = next; i++; }
		else if (a === "--principal-email" && next) { out.principalEmail = next; i++; }
	}
	return out;
}

const handler = async (cmd: string, args: string[], ctx: ProgramContext) => {
	const { print, resolveId } = ctx;
	const state = ctx.state;

	switch (cmd) {
		// /holdfast setup --name <NAME> [--principal-name N] [--system ...] [--model X]
		//                 [--principal-discord ID] [--principal-email addr]
		case "setup": {
			try {
				const opts = parseSetupArgs(args);
				const result = await doSetup(opts, ctx);
				state.agentId = result.agentId;
				state.agentName = result.agentName;
				state.principalPeerId = result.principalPeerId;

				print(bold(green(`  Holdfast ready — ${result.agentName}`)));
				print(dim(`  agent:     ${result.agentId} ${result.createdAgent ? green("(created)") : dim("(existing)")}`));
				print(dim(`  principal: ${result.principalPeerId} ${result.createdPeer ? green("(created)") : dim("(existing)")}`));
				if (result.wiredTools.length > 0) {
					print(dim(`  tools:     ${result.wiredTools.join(", ")}`));
				}
				if (result.skippedTools.length > 0) {
					print(dim(`  skipped:   ${result.skippedTools.map((s) => s.name + " (" + s.reason + ")").join("; ")}`));
				}
				print("");
				print(dim(`  Next: \`/holdfast say hello\``));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /holdfast say <text...>
		case "say": {
			const text = args.join(" ");
			if (!text) { print(red("Usage: holdfast say <text...>")); break; }
			try {
				print(dim("  thinking..."));
				print("");
				const result = await doSay(text, state, ctx);
				print(magenta(bold(`  ${result.agentName}`)) + dim(` (to ${result.peer.display_name})`));
				for (const line of result.finalText.split("\n")) print(`  ${line}`);
				print("");
				const tools = result.toolCalls > 0 ? `, ${result.toolCalls} tool call(s)` : "";
				print(dim(`  (${result.inputTokens}+${result.outputTokens} tokens, ${result.iterations} iter${tools})`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /holdfast ingest <source> <peerId> <text...>
		case "ingest": {
			const source = args[0];
			const rawPeer = args[1];
			const text = args.slice(2).join(" ");
			if (!source || !rawPeer || !text) {
				print(red("Usage: holdfast ingest <source> <peerId> <text...>"));
				break;
			}
			const peerId = await resolveId(rawPeer) ?? rawPeer;
			try {
				const result = await doIngest(source, peerId, text, state, ctx);
				print(magenta(bold(`  ${result.agentName}`)) + dim(` (to ${result.peer.display_name}, trust=${result.peer.trust_level}, via ${source})`));
				for (const line of result.finalText.split("\n")) print(`  ${line}`);
				print("");
				const tools = result.toolCalls > 0 ? `, ${result.toolCalls} tool call(s)` : "";
				print(dim(`  (${result.inputTokens}+${result.outputTokens} tokens, ${result.iterations} iter${tools})`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		// /holdfast status
		case "status": {
			try {
				const info = await ensureBootstrapped(state, ctx);
				print(bold(`  Holdfast — ${info.agentName}`));
				print(dim(`  agent:     ${info.agentId}`));
				print(dim(`  principal: ${info.principalPeerId}`));
			} catch (err: any) {
				print(red("  ") + (err?.message ?? String(err)));
			}
			break;
		}
		// /holdfast refresh-prompt
		// Re-renders the default system prompt with the current names and writes
		// it to the agent's `system` field, then re-runs autoWireTools. Use
		// after editing the harness source so the live agent picks up changes
		// without discarding its conversation. Skips silently if you've set a
		// custom prompt via --system or /agent config.
		case "refresh-prompt":
		case "refresh": {
			try {
				const info = await ensureBootstrapped(state, ctx);
				const result = await doRefreshPrompt(info, ctx);
				print(bold(green(`  Holdfast refreshed — ${info.agentName}`)));
				print(dim(`  agent:  ${info.agentId}`));
				print(dim(`  system: ${result.systemChanged ? green("rewritten") : dim("unchanged")}`));
				print(dim(`  tools:  ${result.wiredTools.length} wired, ${result.skippedTools.length} skipped, ${result.prunedTools.length} pruned`));
			} catch (err: any) {
				print(red("  Error: ") + (err?.message ?? String(err)));
			}
			break;
		}

		default: {
			print([
				bold("  Holdfast") + dim(" — generic agent harness"),
				`    ${cyan("holdfast setup")} ${dim("--name <NAME> [--principal-name N] [--system ...] [--model X]")}`,
				`    ${"".padStart(15)}${dim("[--principal-discord ID] [--principal-email addr]")}`,
				`    ${cyan("holdfast say")} ${dim("<text...>")}                              ${dim("principal talks to the agent from the shell")}`,
				`    ${cyan("holdfast ingest")} ${dim("<source> <peerId> <text...>")}         ${dim("bridges call this on inbound")}`,
				`    ${cyan("holdfast status")}                                               ${dim("show current agent + principal ids")}`,
				`    ${cyan("holdfast refresh-prompt")}                                       ${dim("rewrite default system prompt + re-wire tools")}`,
			].join("\n"));
		}
	}
};

// ── Actor (programmatic API + hibernatable state cache) ──────────

const actorDef: ProgramActorDef = {
	createState: () => ({ agentId: "", agentName: "", principalPeerId: "" }),

	actions: {
		/**
		 * One-time setup (idempotent). Opts may be a JSON string or plain object.
		 *
		 * Aliased as both `bootstrap` and `setup`: the CLI command is
		 * `/holdfast setup`, and headless callers (HTTP dispatch) should be
		 * able to use the same verb.
		 */
		bootstrap: async (ctx: ProgramContext, ...args: any[]) => {
			const first = args[0];
			let parsed: SetupOpts;
			if (typeof first === "string" && args.length > 1) {
				parsed = parseSetupArgs(args as string[]);
			} else {
				const opts = first as string | SetupOpts | undefined;
				parsed = typeof opts === "string" ? (opts ? JSON.parse(opts) : {}) : (opts ?? {});
			}
			const result = await doSetup(parsed, ctx);
			ctx.state.agentId = result.agentId;
			ctx.state.agentName = result.agentName;
			ctx.state.principalPeerId = result.principalPeerId;
			return result;
		},
		setup: async (ctx: ProgramContext, ...args: any[]) => {
			const first = args[0];
			let parsed: SetupOpts;
			if (typeof first === "string" && args.length > 1) {
				parsed = parseSetupArgs(args as string[]);
			} else {
				const opts = first as string | SetupOpts | undefined;
				parsed = typeof opts === "string" ? (opts ? JSON.parse(opts) : {}) : (opts ?? {});
			}
			const result = await doSetup(parsed, ctx);
			ctx.state.agentId = result.agentId;
			ctx.state.agentName = result.agentName;
			ctx.state.principalPeerId = result.principalPeerId;
			return result;
		},

		/** Process an inbound message from a named peer on a named source. */
		ingest: async (ctx: ProgramContext, source: string, peerId: string, ...textParts: any[]) => {
			const text = textParts.join(" ");
			return await doIngest(source, peerId, text, ctx.state, ctx);
		},

		/** Shell-side convenience: the principal speaks to the agent directly. */
		say: async (ctx: ProgramContext, ...textParts: any[]) => {
			const text = textParts.join(" ");
			return await doSay(text, ctx.state, ctx);
		},

		/** Return current state for diagnostics. */
		status: async (ctx: ProgramContext) => {
			const info = await ensureBootstrapped(ctx.state, ctx);
			return info;
		},

		/** Re-render the default system prompt with current names and re-wire tools. */
		refreshPrompt: async (ctx: ProgramContext) => {
			const info = await ensureBootstrapped(ctx.state, ctx);
			return await doRefreshPrompt(info, ctx);
		},
	},
};

const program: ProgramDef = { handler, actor: actorDef };
export default program;

// ── Internal exports for testing ─────────────────────────────────

export const __test = {
	renderDefaultSystemPrompt,
	formatIngestPrompt,
	parseSetupArgs,
	buildHarnessTools,
	doSetup,
	doIngest,
	doSay,
	doRefreshPrompt,
	ensureBootstrapped,
	findAgentByName,
	findSelfPeer,
	findHarnessAgent,
};
