# glon

A distributed operating environment for content-addressed objects, durable actors, and programs that act on them.

LLM agents are **applications** that run on this substrate — they reuse the kernel's objects, DAG, actors, and sync rather than reinvent them. Conversation history is just blocks in a DAG. Memory is just typed objects. Tools are just calls to other programs. Subagents are just more agent objects.

glon is inspired by [Anytype](https://anytype.io)'s philosophy — no hierarchy, just objects and the links between them — and built on two primitives that hold up at scale: [Rivet](https://rivet.gg) actors and content-addressed protobuf. Every object is a durable actor, every mutation is an immutable change in a DAG, and the graph of relations between objects is the only structure.

## Quick start

```bash
git clone https://github.com/Geep5/glon.git
cd glon && npm install
cp .env.example .env        # fill in secrets

# Terminal 1 — actor host
npm run dev

# Terminal 2 — first run only
npm run bootstrap

# Terminal 3 — interactive shell
npm run client
```

Every script auto-loads `.env`. The dev server binds `:6420` (set `GLON_PORT` to override). Clients auto-discover via `~/.glon/.endpoint`.

**Headless:** `npx tsx scripts/daemon.ts` loads programs and exposes `POST /dispatch` on `:6430`.

---

## What glon is

Five kernel primitives:

| Primitive | What it means |
|---|---|
| **Objects, not files** | No folders, no tree. Typed entities in a flat graph linked via `ObjectLink` fields. Structure emerges from connections. |
| **Changes, not state** | Every mutation is a `Change` protobuf, content-addressed by SHA-256, appended to a DAG. State is computed by replay. |
| **Actors, not databases** | Each object is a Rivet actor. `objectActor` (one per object), `storeActor` (singleton index), `programActor` (state + RPC). |
| **Everything is a program** | Zero built-in commands. `/help`, `/crud`, `/agent`, `/token` — all loaded from the store at startup. |
| **Self-describing** | Bootstrap seeds the source files as objects into the store. Query glon for the code that built it. |

Programs export a `ProgramDef`:

```typescript
export default {
  handler: async (cmd, args, ctx) => { ... },  // CLI
  actor: { createState: () => ({}), actions: { ... }, tickMs: 5000 },
  validator: (changes) => { return { valid: true }; },
  validatedTypes: ["chain.token"],
  chainMode: true,  // require Ed25519 signed Changes
};
```

| Program | Purpose |
|---|---|
| `/help` | List available programs |
| `/crud` | Create, list, get, set, delete, search objects |
| `/inspect` | DAG history, change details, sync state |
| `/ipc` | Inter-object messaging (inbox/outbox) |
| `/graph` | Object link traversal, neighbours, BFS |
| `/agent` | LLM agents with DAG-backed conversation, tool dispatch, auto-compaction, subagent spawning |
| `/memory` | Durable agent memory: pinned facts and milestone arcs |
| `/peer` | Identity, trust level, contact handles |
| `/remind` | Scheduled actions |
| `/discord` | Discord bridge |
| `/holdfast` | Agent harness: identity-aware ingest + memory + reminders + shell + subagents |
| `/wallet` | Local-only Ed25519 keychain |
| `/coin` | **UTXO-based fungible tokens** (recommended for new tokens) |
| `/token` | Account-model fungible tokens (legacy) |
| `/consensus` | Validator gate for chain-mode: nonce + fee + semantic checks |
| `/anchor` | State commitment + PoST gate + inflation rewards |
| `/plot` | Proof of Space (chiapos) |
| `/timelord` | Proof of Time (chiavdf) |

---

## Agents and Holdfast

`/agent` treats an `agent`-typed glon object as the durable home of a conversation. Every prompt, assistant text, `tool_use`, `tool_result`, and `compaction_summary` is a block in that object's DAG.

| Agent feature | Kernel primitive |
|---|---|
| Conversation history | Content-addressed `Change`s in a DAG (one `objectActor` per agent) |
| User / assistant turn | `Block` with `text` content and style tag |
| Tool call / result | `Block` with `custom` content and `tool_use_id` pairing |
| Compaction | `compaction_summary` block pointing at `firstKeptBlockId`; older blocks stay in DAG |
| Tool registration | Scalar `tools` field listing `{name, description, target_prefix, target_action, bound_args}` |
| Memory | `pinned_fact` / `milestone` objects with `owner` link back to the agent |
| Subagents | More `objectActor`s of `typeKey="agent"` with `spawn_parent` link |
| Block recall | New `user_text` block quoting a previous block, landing after latest compaction cut |
| Todo lists | `todo_write` tool with follow-up reminder loop after compaction/idle |

**`/holdfast`** wraps `/agent` with identity-aware ingest, memory, reminders, shell, and subagents. Configure once:

```
glon> /holdfast setup --name Graice --principal-name Grant
  Holdfast ready — Graice
  agent:     7f141408-…
  principal: 9a3c5d20-…
  tools:     50 wired

glon> /holdfast say My wife's name is Sarah. Save that.
  Graice (to Grant)
  Saved. wife_name=Sarah.
  (memory_upsert_fact)

# Restart — the fact survives.
glon> /holdfast say What's my wife's name?
  Sarah.
  (no tool calls — served from memory digest)
```

**Subagent batch:**

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
  · Graice [agent]  c07aa4d3
  ├─ ✓ explore-a [explore] task=a
  └─ ✓ explore-b [explore] task=b
```

**Auth:** Two credential kinds for Anthropic: API key (`ANTHROPIC_API_KEY` in `.env`) or Claude Pro/Max subscription (`/auth login anthropic`). OAuth wins if both configured.

---

## Crypto

A signed-token chain layered on the same per-actor DAG primitives. Four programs (`/wallet`, `/token`, `/coin`, `/consensus`) plus a kernel-level Ed25519 signature gate.

| Feature | Primitive |
|---|---|
| Signed transactions | `Change.author_sig` (Ed25519 + nonce + fee). Kernel verifies sig + canonical hash before validator dispatch |
| Replay protection | Per-pubkey monotonic nonce in `/consensus` actor state |
| Asymmetric fees | Deploy: base×100, Mint: base×10, Other: base×1 |
| Wallet | Local-only `${GLON_DATA}/wallet.json` (mode 0600) |
| Determinism | `src/det/` — canonical proto encoder (sorted map<> entries), BigInt-only math, raw Ed25519 via `node:crypto` |

### `/coin` — UTXO model (recommended)

- `chain.token` objects hold metadata only (name, symbol, decimals, owner, supply).
- `chain.coin.bucket` objects hold up to 1000 coins as `BlockAdd` ops with `contentType="chain.coin.op"`.
- Each coin is a block: `create {coin_id, owner_pubkey, amount}` or `spend {coin_id}`.
- SQLite `coins` table indexes unspent outputs for O(1) balance/holder queries.
- Transfer = spend input coins + create output coins (recipient + change back to sender).

```
glon> /wallet new alice
glon> /coin deploy Figgies FIG 1000 --decimals=0 --key=alice
  Coin deployed!
    token:  90c86a5a...
    bucket: 7b3d2e1f...

glon> /coin transfer 90c86a5a... b2c3d4e5... 250 --key=alice
  Transferred 250 to b2c3d4e5...
    change: 750 back to sender

glon> /coin balance 90c86a5a... a1b2c3d4...
  FIG  750
```

### `/token` — account model (legacy)

- One `chain.token` object per token. Balances derived by replaying the full op history.
- Six ops: `Mint`, `Transfer`, `Approve`, `TransferFrom`, `Burn`, `RenounceMint`.
- Fine for small-scale use; `/coin` scales better because balance queries are O(unspent coins) via SQLite rather than O(total tx history).

### `/anchor` — state commitment

- `chain.anchor` objects with `merkle_root` (SHA-256 binary Merkle tree over chain-mode heads), `height`, `previous_anchor`.
- Fork choice: longest chain. Auto-tick every 60s.
- PoST: VDF proofs via `chiavdf`, plot proofs via `chiapos`. Inflation rewards halve every 1,000 anchors.

---

## Sister projects

- **[glonAstrolabe](https://github.com/Geep5/glonAstrolabe)** — interactive 3D viewer for any glon environment. Objects as planets, live event stream, inspector panel, search, click-to-recall.

---

## FAQ / Misc

**Deploying handler changes.** Programs run from the DAG, not disk. Edit `src/programs/handlers/*.ts`, then `npm run bootstrap` to push source into the store, then restart the daemon. Agent fields (system prompt, model, tools) take effect immediately via `setField`.

**Port collisions.** The dev server fails fast if `:6420` is bound. Set `GLON_PORT` in `.env` to override. All clients read `~/.glon/.endpoint` so they auto-track the port.

**Discord bridge.** Create app at [Discord Developer Portal](https://discord.com/developers/applications) → Bot tab → copy token into `.env` as `DISCORD_BOT_TOKEN`. OAuth2 URL Generator: scope `bot`, permissions `Send Messages` + `Read Message History`. Find your user id (Settings → Advanced → Developer Mode → right-click name → Copy User ID) for `/holdfast setup --principal-discord <id>`.

**State rent.** Reserved `storage_credit` field on every `chain.token` object (always `"0"` in v1). Deferred.

**Sync.** Pull-based over HTTP with protobuf `Envelope`. Chain-mode signature gate means forged Changes are rejected before disk. Full P2P hardening (mDNS discovery, Bloom filters, reputation) is deferred.

## License

MIT
