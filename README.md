# glon

A distributed operating environment for content-addressed objects, durable actors, and programs that act on them.

LLM agents are **applications** that run on this substrate — they reuse the kernel's objects, DAG, actors, and sync rather than reinvent them. Conversation history is just blocks in a DAG. Memory is just typed objects. Tools are just calls to other programs. Subagents are just more agent objects.

glon is inspired by [Anytype](https://anytype.io)'s philosophy — no hierarchy, just objects and the links between them — and built on two primitives that hold up at scale: [Rivet](https://rivet.gg) actors (how games, telecom, and Discord avoid shared-state problems) and content-addressed protobuf (how Git and IPFS make data self-verifying and conflict-free). Every object is a durable actor, every mutation is an immutable change in a DAG, and the graph of relations between objects is the only structure.

## Layered architecture

```
                +-----------------------------------------------+
   apps         |  Holdfast · automations · custom UIs          |   ← configurations of programs
                +-----------------------------------------------+
   programs     |  /agent /memory /chat /peer /wallet /token …  |   ← user-space, all hot-loadable
                +-----------------------------------------------+
   chain layer  |  /consensus · signature gate · canonical enc  |   ← only fires for chain-mode types
                +-----------------------------------------------+
   kernel       |  objects · actors · DAG · sync · programs      |   ← every primitive is content-addressed
                +-----------------------------------------------+
   transport    |  protobuf wire format · HTTP · sqlite cache    |
                +-----------------------------------------------+
```

The kernel knows nothing about LLMs. The fact that `/agent` exists at the program layer is convention; remove it and glon is still a working distributed object store with `/chat`, `/ttt`, and any other program you write.

## The kernel — five primitives

**Objects, not files.** There are no folders, no directories, no tree. Every entity is a typed object in a flat graph. Objects relate to each other through typed `ObjectLink` fields — the structure emerges from the connections, not from where something is placed.

**Changes, not state.** Every mutation is a `Change` — an immutable protobuf message appended to a DAG, identified by the SHA-256 of its wire bytes. Current state is computed by replaying the DAG from genesis to heads. Nothing is overwritten; full history is preserved.

**Actors, not databases.** Each object is a [Rivet actor](https://rivet.gg/docs/actors) — durable, globally addressable, hibernatable. Actor types: `objectActor` (one per object, sync peer), `storeActor` (singleton index), `programActor` (program state and RPC dispatch).

**Everything is a program.** The shell has zero built-in commands. It loads every command — including `/help` — from the store at startup. Programs are glon objects: they have change history, sync between instances, and are discoverable at runtime.

**Self-describing.** On bootstrap, the environment loads its own source files as objects. You can query glon for the code that built it.

## Getting started

**Prerequisites**
- Node 20+ (the dev server uses the built-in `node:sqlite`).
- For LLM agents: either an Anthropic API key (`ANTHROPIC_API_KEY`) or a Claude Pro/Max plan (set up via `/auth login anthropic`). Discord bot token if you want the bridge.
- For agents that browse the web: [`browser-use`](https://github.com/browser-use/browser-use) on `$PATH`. Install once on the host machine:

**Install**
```bash
git clone https://github.com/Geep5/glon.git
cd glon && npm install
cp .env.example .env        # fill in secrets (see sections below)

# If any agent on this harness will browse the web, also install browser-use:
pipx install browser-use    # or: pip install --user browser-use
browser-use install         # downloads Chromium + system deps
browser-use doctor          # verifies the install
```

**Run**
```bash
# Terminal 1 — RivetKit actor host. Stays running.
npm run dev

# Terminal 2 — seed source files + programs. Only on first run.
npm run bootstrap

# Terminal 3 — interactive shell.
npm run client
```

Every script auto-loads `.env` from the project root, so `ANTHROPIC_API_KEY` and `DISCORD_BOT_TOKEN` are picked up without inline prefixes. Inline still works (`ANTHROPIC_API_KEY=sk-... npm run client`).

**Port collisions.** The dev server fails fast if `6420` is already bound instead of silently sliding to the next port. Either free it or set `GLON_PORT=6520` in `.env`. Clients auto-discover the chosen port via a lockfile at `~/.glon/.endpoint`, so you never have to tell them.

## Programs

| Command | Purpose |
|---|---|
| `/help` | List available programs |
| `/crud` | Create, list, get, set, delete, search objects |
| `/inspect` | DAG history, change details, sync state, disk usage |
| `/ipc` | Inter-object messaging (inbox/outbox) |
| `/graph` | Object link traversal, neighbours, BFS |
| `/ttt` | Tic-tac-toe — every move is a content-addressed change |
| `/chat` | Chat rooms — thin alias around `/comment` |
| `/comment` | Discussions on any object: message, reply, react, thread |
| `/agent` | LLM agents with DAG-backed conversation, tool dispatch, auto-compaction, subagent spawning, block recall, Anthropic prompt caching |
| `/task` | Thin CLI front-end for spawning subagent batches |
| `/memory` | Durable agent memory: pinned facts and milestone arcs |
| `/peer` | People and agents: identity, trust level, contact handles |
| `/remind` | Scheduled actions: DM at a time, prompt agent to compose then send |
| `/discord` | Discord bridge: Gateway WebSocket + REST poll for DMs |
| `/holdfast` | Generic agent harness: wraps `/agent` with identity-aware ingest, memory, reminders, shell, subagents. Configure once with `/holdfast setup --name <NAME>` |
| `/web` | Shell cheatsheet for HTTP from the REPL — curl + jq + pandoc recipes |
| `/browser` | Shell cheatsheet for `browser-use` CLI — the canonical browser path for agents |
| `/shell` | Persistent bash sessions an agent can drive |
| `/google` | Shell cheatsheet for `gws` CLI (calendar / gmail / drive / sheets / docs) |
| `/anytype` | Shell cheatsheet for the local Anytype REST API |
| `/gc` | Garbage collection with protection and reachability |
| `/accounts` | Multi-user auth and per-object permissions (stub) |
| `/auth` | Anthropic credential management: OAuth or API key |
| `/sync` | P2P sync via mDNS discovery and HTTP (stub) |
| `/todo` | Phased task lists for agents: show, incomplete, clear |
| `/wallet` | Local-only Ed25519 keychain. Stored at `${GLON_DATA}/wallet.json` mode 0600, never synced |
| `/token` | Fungible-token program. Deploy, transfer, balance, holders |
| `/consensus` | Validator gate for chain-mode: nonce + fee + semantic checks |
 `/plot` | Proof of Space (chiapos). Create plots, find/verify proofs |
 `/timelord` | Proof of Time (chiavdf). Class-group VDF compute/verify |
 `/anchor` | State commitment + PoST gate + inflation rewards |
Every program `export default`s a `ProgramDef`:

```typescript
export default {
  handler: async (cmd, args, ctx) => { ... },  // CLI handler (required)
  actor: { ... },                                // persistent state + RPC (optional)
  validator: (changes) => { ... },               // DAG gating (optional)
  validatedTypes: ["chain.token"],               // types to validate (optional)
  chainMode: true,                               // require signed Changes (optional)
};
```

A handler-only program is a stateless command. Add an `actor` for persistent state and a tick loop. Add a `validator` to gate synced changes before they reach disk.

## Agents on glon

An LLM agent is one configuration of the kernel's primitives — nothing about it requires a new subsystem.

| Agent feature | Built on which kernel primitive |
|---|---|
| Conversation history | content-addressed `Change`s in a DAG (one `objectActor` per agent) |
| User / assistant turn | `Block` with `text` content and a style tag |
| Tool call / result | `Block` with `custom` content and a `tool_use_id` for pairing |
| Compaction | A `compaction_summary` block that points at `firstKeptBlockId`. Older blocks remain in the DAG; the next ask just skips them |
| Tool registration | A scalar field on the agent listing `{name, description, target_prefix, target_action, bound_args}` — at call time dispatches via `ctx.dispatchProgram(prefix, action, args)` |
| Memory | Separate `pinned_fact` / `milestone` objects with `owner` link back to the agent |
| Identity-aware ingest | `/peer` objects carry `display_name`, `kind`, `trust_level`, `email`, `discord_id`. `/holdfast` tags inbound text with `[from {name} on {source}, trust={level}]` |
| Subagents | More `objectActor`s of `typeKey="agent"`, with a `spawn_parent` link back to the caller |
| Block recall | A new `user_text` block that quotes a previous block (compacted or otherwise). Lands after the latest compaction's cut |
| Prompt caching | `cache_control: {type: "ephemeral"}` on the last system block, last tool definition, and last message. Verified ~30x cost reduction in continuous-chat workloads |
| Todo lists | Phased task lists via `todo_write` tool, owner-scoped, with follow-up reminder loop |

That's the entire picture. The agent doesn't have a database; the DAG is the database. The agent doesn't have a context manager; compaction blocks are the context manager. The agent doesn't have a job runner for subagents; rivet actors are the job runner.

### Example: solo agent

```
glon> /agent new analyst --system "You are a concise data analyst."
glon> /agent ask 9b2e What are the tradeoffs of event sourcing vs CRUD?
  assistant (847+312 tokens)
  Event sourcing trades write simplicity for read complexity. ...

glon> /agent inject c41a 9b2e       # inject analyst's full conversation into another agent
glon> /agent ask c41a What did the analyst get wrong?
```

### Example: subagent batch

```
glon> /task spawn c07aa4d3 '{
  "context": "looking at the codebase shape",
  "schema": {"type":"object","required":["findings"],"properties":{"findings":{"type":"array"}}},
  "tasks": [
    {"id":"a","agentTemplate":"explore","assignment":"map src/programs/handlers"},
    {"id":"b","agentTemplate":"explore","assignment":"map src/dag"}
  ]
}'

glon> /agent tree c07aa4d3
spawn tree rooted at c07aa4d3
· Graice [agent]  c07aa4d3
├─ ✓ explore-a [explore] task=a  child-12
└─ ✓ explore-b [explore] task=b  child-13
  2 subagent(s) total
```

### Example: Holdfast in action

```
glon> /holdfast setup --name Graice --principal-name Grant --principal-discord 123456789012345678
  Holdfast ready — Graice
  agent:     7f141408-… (created)
  principal: 9a3c5d20-… (created)
  tools:     peer_list, peer_get, peer_add, … (50 wired)

  Next: `/holdfast say hello`

glon> /holdfast say My wife's name is Sarah. Save that.
  Graice (to Grant)
  Saved. wife_name=Sarah.
  (one tool call: memory_upsert_fact)

# Restart the daemon, start a fresh session — the fact survives.
glon> /holdfast say What's my wife's name?
  Graice (to Grant)
  Sarah.
  (no tool calls — served from her memory digest)
```

### Example: todo follow-ups

Agents can maintain phased task lists via the `todo_write` tool. When tasks are pending, a follow-up loop nudges the agent to continue after compaction or idle periods:

```
glon> /agent new planner --system "You are a project planner. Use todo_write to track phases."
glon> /agent ask planner Plan a token launch
  ... todo_write phases: Research → Design → Deploy → Verify ...

  (after compaction, the follow-up loop fires)
  planner (reminder)
  Phase "Research" has 2 pending tasks. Continue?
```

## Chain on glon

A signed-token chain layered on the same per-actor DAG primitives. Three programs (`/wallet`, `/token`, `/consensus`) plus a `chainMode` flag on `ProgramDef`, plus a kernel hook that verifies an Ed25519 signature on every chain-mode `Change` before any program validator sees it. Tokens, balances, and allowances are regular Glon objects whose state is computed by replaying the DAG — same model `/chat`, `/agent`, and every other program use.

| Chain feature | Built on which kernel primitive |
|---|---|
| Signed transactions | `Change.author_sig` (Ed25519 + nonce + fee). Kernel verifies sig + canonical hash before validator dispatch |
| Replay protection | Per-pubkey monotonic nonce in `/consensus`'s actor state |
| Asymmetric fees | `/consensus` enforces base × {100, 10, 1} for {Deploy, Mint, Other} |
| Token state | `chain.token` object — fields hold static metadata; ops are `CustomContent` blocks; balances derived by DAG replay |
| Wallet | Local-only `${GLON_DATA}/wallet.json` (mode 0600). Same pattern as `/auth` |
| Determinism | `src/det/` — canonical proto encoder, BigInt-only math, raw Ed25519 via `node:crypto`. `det-lint` test scans consensus paths for banned APIs |

### Example: deploy and transfer

```
glon> /wallet new alice
  Wallet key created
    name:   alice
    pubkey: a1b2c3d4...
    Stored in /Users/you/.glon/wallet.json (mode 0600)

glon> /token deploy Figgies FIG 1000 --decimals=0 --key=alice
  Token deployed!
    id:     90c86a5aa43e4a5db979e659
    name:   Figgies
    symbol: FIG
    supply: 1000
    owner:  a1b2c3d4...

glon> /token info 90c86a5aa43e4a5db979e659
  Figgies (FIG)
    id:       90c86a5aa43e4a5db979e659
    decimals: 0
    supply:   1000
    holders:  1
    owner:    a1b2c3d4...

glon> /token transfer 90c86a5aa43e4a5db979e659 \
         b2c3d4e5...recipient_pubkey...f6a7b8c9 500 --key=alice
  Transferred 500 to b2c3d4e5...
    token: 90c86a5aa43e4a5db979e659

glon> /token holders 90c86a5aa43e4a5db979e659
  a1b2c3d4...  500
  b2c3d4e5...  500
```

### What runs today

- Signed `Change` propagation across instances via existing per-actor sync.
- Validator pipeline: signature gate (kernel) → nonce monotonicity + asymmetric fee (`/consensus`) → semantic check (`/token.validate_op`).
- Per-pubkey nonces, replay rejection, U128 overflow protection.
- `token deploy`, `token transfer`, `token balance`, `token holders`, `token info` CLI commands.
- `/anchor create/list/status/info/verify` — Merkle-root state commitment, auto-tick every 60s, longest-chain fork choice.
- 133 chain-layer tests including subprocess-isolation determinism check.

### What's deferred

- **PoST cryptography** ([chiapos](https://github.com/Chia-Network/chiapos), [chiavdf](https://github.com/Chia-Network/chiavdf)): subprocess-only via bundled CLI binaries. Anchor creation will require a PoST proof.
- **Reorg / fork choice**: requires the anchor chain + cumulative-VDF-iterations comparison.
- **Adversarial sync hardening**: peer scoring, ban list, bounded buffer.
- **State rent / storage_credit**: reserved field on every `chain.token` object (always `"0"` today).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full chain layer spec: canonical encoding, signature gate flow, and the `/consensus` validator pipeline.

## Anthropic plan setup (Claude Pro/Max)

`/agent` and `/holdfast` work with two kinds of Anthropic credentials:

- **API key** from [console.anthropic.com](https://console.anthropic.com) — set `ANTHROPIC_API_KEY` in your `.env`. Pay per token.
- **Claude Pro/Max subscription** — run `/auth login anthropic` once. Requests authenticate as the official `claude` CLI and are billed against your plan.

If both are configured, the OAuth credential wins.

### First-time login

1. **Start Glon and a shell.**
   ```bash
   npm run dev          # terminal 1 — RivetKit actor host
   npm run bootstrap    # first time only — seeds programs as objects
   npm run client       # terminal 2 — the shell
   ```
2. **Start the OAuth flow.**
   ```
   glon> /auth login anthropic
     Open this URL in your browser:
     https://claude.ai/oauth/authorize?code=true&client_id=…
   ```
3. **Open the URL, sign in, approve scopes.** Copy the `CODE#STATE` string.
4. **Paste it back.**
   ```
   glon> /auth login anthropic CODE#STATE
     Logged in. Token expires in 23h 58m.
     Stored in /home/you/.glon/auth.json
   ```

Tokens auto-refresh in the background when within 5 minutes of expiry. Inspect with `/auth status`, force refresh with `/auth refresh`, delete with `/auth logout`.

## Discord bridge setup

1. **Create the application.** Visit [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**. Name it what you want your bot to be called.
2. **Grab the bot token.** Bot tab → **Reset Token** → copy into `.env` as `DISCORD_BOT_TOKEN=...`.
3. **Invite the bot.** OAuth2 → URL Generator → scope `bot`, permissions `Send Messages` + `Read Message History`. Open the URL and add it to a guild.
4. **Find your Discord user id.** Settings → Advanced → enable **Developer Mode**. Right-click your name → **Copy User ID**. This goes into `/holdfast setup --principal-discord <id>`.
5. **DM the bot.** Messages flow through `/discord`'s REST poll into `/holdfast.ingest`, replies posted back. The bot also holds a Gateway WebSocket for online presence.

Add more people later:
```
glon> /peer add display_name=Sarah kind=human trust_level=family discord_id=987654321098765432
```

## Headless operation

For background use (Discord polling, scheduled reminders, agent memory writes, subagent runs) without a shell:

```bash
npx tsx scripts/daemon.ts
```

This loads every program, starts their actor instances, and exposes a local HTTP dispatch endpoint on `127.0.0.1:6430` for `POST /dispatch {prefix, action, args}`. Example:

```bash
curl -sS -X POST http://127.0.0.1:6430/dispatch \
  -H 'Content-Type: application/json' \
  -d '{"prefix":"/holdfast","action":"say","args":["What is on my calendar today?"]}'
```

The dispatch endpoint is also what [glonAstrolabe](https://github.com/Geep5/glonAstrolabe) uses.

## Deploying handler changes

**Programs run from the DAG, not from disk.** When the daemon starts, the runtime reads each program's source out of `typescript` objects in the store, compiles them, and starts the actors. Editing a handler file under `src/programs/handlers/` after that has no effect.

To deploy a handler-code change:

```bash
# 1. Push the new disk source into the DAG.
npm run bootstrap   # re-reads disk, writes new typescript objects, updates manifests

# 2. Restart the daemon so it re-loads programs from the updated DAG.
kill $(cat .run/daemon.pid)
npx tsx scripts/daemon.ts &
```

Two things this doesn't apply to:
- **Agent fields** (system prompt, model, tools, compaction knobs). Direct `setField` writes, take effect on the next `/agent ask`.
- **DAG content the agent itself writes** (memory, conversation, reminders, peers). Same — normal object operations, immediate.

Only `typescript` source-file objects need the bootstrap-then-restart cycle.

## The protocol

**Change DAG** — every mutation is a `Change` protobuf, content-addressed by SHA-256, linked to parents via DAG edges. Operations: `ObjectCreate`, `FieldSet`, `FieldDelete`, `ContentSet`, `ObjectDelete`, plus block tree ops (`BlockAdd`, `BlockRemove`, `BlockUpdate`, `BlockMove`).

**Sync** — typed protobuf `Envelope` messages between actors. Pull-based: advertise heads, push what's missing.

**Computed State** — derived by replaying the DAG. Never the source of truth. The SQLite index is a cache; delete it and it rebuilds from disk.

**Snapshots** — checkpoint full state into the DAG. Replay skips everything before the snapshot. History is never lost.

## Project structure

```
proto/glon.proto              the protocol
src/
  crypto.ts                   SHA-256 content-addressing
  proto.ts                    typed encode/decode
  dag/                        change creation, topological sort, state computation
  disk.ts                     per-object .pb file storage
  env.ts                      .env loader (zero-dep, side-effect import)
  endpoint.ts                 port lockfile + resolver shared by all entry points
  index.ts                    actor definitions (object, store, program)
  bootstrap.ts                seed source files + programs as objects
  client.ts                   CLI shell (pure program loader)
  programs/
    runtime.ts                module bundler, actor lifecycle, validators, chain-mode registry
    handlers/                 one file per program (29 today)
  det/                        chain-mode determinism substrate
    canonical.ts              proto encoder with sorted map<> entries (consensus-grade)
    math.ts                   BigInt helpers; banned-API alternatives
    ed25519.ts                raw 32-byte Ed25519 sign/verify via node:crypto
    index.ts                  re-exports
scripts/
  daemon.ts                   headless host: load programs, run actors, HTTP dispatch
  dispatch.ts                 thin HTTP client for the daemon
  read-agent-blocks.ts        diagnostic: dump an agent's recent blocks
  tail-blocks.ts <id> [N]     tail an object's last N blocks
  inspect-id.ts <id>          dump an object's typeKey, fields, block count
  list-reminders.ts           dump every reminder in the store
  dump-tooluse.ts <id> [k]    dump tool_use / tool_result blocks
  dump-system.ts <id>         print an agent's system prompt
  dump-handler-source.ts      read a typescript object's content from the DAG
  agent-info.ts <id>          name, model, tool count, system length, compaction tuning
  check-mti.ts <id> [N]       read or set max_tool_iterations
  prune-tools.ts <id> <pfx>   drop wired tools by prefix
  rename-agent.ts <id> <old> <new>
  capture-setup.ts <agent> <peer>
  test-steer-live.ts          steering / multi-runner integration check
test/
  dag.test.ts                 DAG replay, snapshots
  runtime.test.ts             program actor lifecycle
  agent-compaction.test.ts    compaction view, cut-point, summary
  agent-tooluse.test.ts       tool registration + tool-use loop
  agent-spawn.test.ts         core subagent spawning
  agent-spawn-advanced.test.ts schema validation, timeout, retry, progress events, tree
  agent-recall.test.ts        block recall framing + truncation
  agent-steering.test.ts      multi-runner / steering coordination
  agent-followup.test.ts      todo follow-up reminder loop
  agent-todo-followup.test.ts todo tool registration + reminder dispatch
  task-program.test.ts        /task CLI dispatch + Holdfast wiring
  peer.test.ts                peer CRUD + find-or-create
  remind.test.ts              scheduling, tick, payload + target validation
  discord.test.ts             bridge polling + send
  holdfast.test.ts            ingest wrapping + setup idempotency
  comment.test.ts             /comment post / reply / react / unreact / list / thread
  chat.test.ts                /chat alias to /comment dispatch + legacy block render
  introspection.test.ts       agent reads its own source via /crud
  todo.test.ts                todo program: owner-scoped task lists
  chain/
    determinism.test.ts       canonical encoder; subprocess-isolation hash check
    det-lint.test.ts          banned-API scanner over consensus paths
    signature-gate.test.ts    Ed25519 verify, tamper detection, id↔canonical hash
    wallet.test.ts            local keychain, mode-0600 storage, signing round-trip
    token.test.ts             chain.token classification, replay, all op kinds, U128 boundary
    consensus.test.ts         nonce monotonicity, asymmetric fees, validator dispatch
    anchor.test.ts            Merkle tree, root verification, deterministic ordering, inflation rewards
    plot.test.ts              chiapos integration: registry, proof verification
    timelord.test.ts          chiavdf integration: VDF compute, verify, deriveChallenge
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for internals: DAG replay, actor state model, program context, memory, chain layer, and extensibility.

## Companion projects

- **[glonAstrolabe](https://github.com/Geep5/glonAstrolabe)** — interactive 3D viewer for any glon environment. Visualizes objects, programs, the agent's full conversation, memory-surfaced blocks, subagent lineage, and adds click-to-recall affordance.

## License

MIT
