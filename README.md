# glon

An autonomous-agent operating environment where every agent has a wallet, a DAG-backed long-term memory, and the ability to recall any object from the past.

glon is a single stack with three layers designed together:

1. **A distributed object kernel.** Every entity is a content-addressed object in a DAG. Changes are immutable, signed, and replayable. Objects are actors: they wake, compute state from their history, and sleep. No external database.


2. **An agent harness (Holdfast).** Identity-aware conversation ingest, durable memory (pinned facts + milestone arcs), scheduled reminders, persistent shell sessions, and subagent batching. An agent's entire conversation lives as blocks in its object's DAG. Compaction keeps context windows bounded without losing history.

3. **Native crypto.** Every agent owns an Ed25519 keypair in a local wallet. Agents deploy UTXO tokens, create atomic swap offers, sign transactions, and hold balances. The same signature gate that protects chain-mode objects also authenticates agent actions.
What makes this an ideal environment for agents:

- **Nothing is ever lost.** Deleted objects and compacted conversation blocks remain in the DAG. Agents can `recall` any past block or `inject` any object — even tombstoned ones — back into their active context.
- **Agents are stateful by default.** Memory, tools, conversation history, and scheduled tasks are all native object types, not external integrations.
- **Agents have money.** Wallet keys are agent-owned and local-only. Token operations are signed changes in the same DAG as everything else.
- **Self-describing.** The system bootstraps its own source code into the store. Query glon for the code that built it.

Inspired by [Anytype](https://anytype.io)'s object-graph philosophy, [Rivet](https://rivet.gg)'s durable actors, [Chia](https://www.chia.net/)'s proof-of-space-and-time consensus, and [oh-my-pi](https://github.com/can1357/oh-my-pi)'s agent harness.

## Quick start

```bash
git clone https://github.com/Geep5/glon.git
cd glon && npm install
cp .env.example .env        # add at least one LLM API key

# Terminal 1 — actor host (keep running)
npm run dev

# Terminal 2 — seed programs into the store (first run only)
npm run bootstrap

# Terminal 3 — interactive shell
npm run client
```

In the client, create your agent:

```
glon> /holdfast setup --name Graice --principal-name Grant
```

Then talk to it:

```
glon> /holdfast say Hello!
```

Every script auto-loads `.env`. The dev server binds `:6420` (set `GLON_PORT` to override). Clients auto-discover via `~/.glon/.endpoint`.

**Models:** Set the agent's `model` field to switch providers.
- Anthropic (default): `claude-sonnet-4-20250514`
- Kimi (Moonshot): `moonshot-v1-8k`, `moonshot-v1-32k`, etc.

- Kimi Coding (`sk-kimi-*` keys): `kimi-for-coding`

**Headless:** `npx tsx scripts/daemon.ts` loads programs and exposes `POST /dispatch` on `:6430`.

---

## Programs

Zero built-in commands. Every feature below is a program loaded from the store at startup.

| Program | Layer | Purpose |
| --- | --- | --- |
| `/help` | — | List available programs |
| `/crud` | Kernel | Create, list, get, set, delete, search objects |
| `/inspect` | Kernel | DAG history, change details, sync state |
| `/ipc` | Kernel | Inter-object messaging (inbox/outbox) |
| `/graph` | Kernel | Object link traversal, neighbours, BFS |
| `/agent` | Harness | LLM agents with DAG-backed conversation, tool dispatch, auto-compaction, subagent spawning |
| `/memory` | Harness | Durable agent memory: pinned facts and milestone arcs |
| `/peer` | Harness | Identity, trust level, contact handles |
| `/remind` | Harness | Scheduled actions |
| `/discord` | Harness | Discord bridge |
| `/holdfast` | Harness | Agent harness: identity-aware ingest + memory + reminders + shell + subagents |
| `/wallet` | Crypto | Local-only Ed25519 keychain |
| `/coin` | Crypto | UTXO tokens + atomic offers (chain.coin.offer) |
| `/consensus` | Crypto | Validator gate for chain-mode: nonce + fee + semantic checks |
| `/anchor` | Crypto | State commitment + PoST gate + inflation rewards |
| `/plot` | Crypto | Proof of Space (chiapos) |
| `/timelord` | Crypto | Proof of Time (chiavdf) |

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

**Auth:** Anthropic: API key (`ANTHROPIC_API_KEY` in `.env`) or Claude Pro/Max subscription (`/auth login anthropic`). Kimi (Moonshot AI): API key (`KIMI_API_KEY` in `.env`) or `/auth login kimi <key>`. Set the agent's `model` field to a kimi model (e.g. `moonshot-v1-8k`) to route requests there.

---

## Crypto

A signed-token chain layered on the same per-actor DAG primitives. Four programs (`/wallet`, `/coin`, `/consensus`, `/anchor`) plus a kernel-level Ed25519 signature gate.

| Feature | Primitive |
|---|---|
| Signed transactions | `Change.author_sig` (Ed25519 + nonce + fee). Kernel verifies sig + canonical hash before validator dispatch |
| Replay protection | Per-pubkey monotonic nonce in `/consensus` actor state |
| Asymmetric fees | Deploy: base×100, Mint: base×10, Other: base×1 |
| Wallet | Local-only `${GLON_DATA}/wallet.json` (mode 0600) |
| Determinism | `src/det/` — canonical proto encoder (sorted map<> entries), BigInt-only math, raw Ed25519 via `node:crypto` |

### `/coin` — UTXO model

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

### `/coin offer` — atomic swaps

Peer-to-peer N-for-M token trades with cross-object batch atomicity. Offers never expire.

- `chain.coin.offer` objects hold terms (`offered` vs `requested`), escrowed coins, and payment coins.
- `offer_escrow` — maker deposits offered coins.
- `offer_pay` — taker deposits requested coins.
- `offer_settle` — atomic batch writes spend+pay+settle across bucket(s) and offer object.
- `offer_cancel` — maker refunds escrow.
- `offer_claim` — each party spends their output coins from the settled offer into their own bucket.

```
glon> /coin offer create <token_id> <amount> <request_token_id> <request_amount> --key=alice
glon> /coin offer accept <offer_id> --key=bob
glon> /coin offer claim <offer_id> --key=alice
glon> /coin offer list
glon> /coin offer info <offer_id>
```

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

**State rent.** Reserved `storage_credit` field on coin metadata objects (`chain.token` typed, always `"0"` in v1). Deferred.

**Sync.** Pull-based over HTTP with protobuf `Envelope`. Chain-mode signature gate means forged Changes are rejected before disk. Full P2P hardening (mDNS discovery, Bloom filters, reputation) is deferred.

## License

MIT
