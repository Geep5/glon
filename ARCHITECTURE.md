# glon — Architecture

## Overview

```
+---------------------------------------------------------------+
|  Programs (src/programs/)                                     |
|  EVERYTHING is a program. Zero built-in commands.             |
+---------------------------------------------------------------+
|  Shell (src/client.ts)                                        |
|  Pure program loader. Matches prefix → handler call.          |
+---------------------------------------------------------------+
|  Store Actor (coordinator)                                    |
|  SQLite index: objects, changes, DAG edges, links, coins      |
|  Creates/destroys object actors                               |
+---------------------------------------------------------------+
|  Object Actors (one per entity)                               |
|  Ephemeral vars: recomputed from disk on every wake           |
|  Sync: advertiseHeads, pushChanges, getChanges                |
|  IPC: sendMessage, receiveMessage                             |
+---------------------------------------------------------------+
|  Change DAG (src/dag/)                                        |
|  Topological sort, state computation, content-addressing      |
+---------------------------------------------------------------+
|  Disk (src/disk.ts)          |  Proto (src/proto.ts)          |
|  ~/.glon/changes/<oid>/*.pb  |  Typed encode/decode           |
+---------------------------------------------------------------+
```

---

## The Change DAG

Every mutation is a `Change` — an immutable protobuf message.

```
Change {
  id: bytes           SHA-256 of wire bytes (id field zeroed)
  object_id: string   stable UUID
  parent_ids: bytes[] DAG edges
  ops: Operation[]    mutations
  timestamp: int64
  author: string
  author_sig: {       present only for chain-mode
    pubkey: bytes
    signature: bytes
    nonce: int64
    fee: int64
  }
}
```

**Content-addressed.** `id = SHA-256(encode(change with id zeroed))`.

**State = replay.** Topological sort (Kahn's BFS, ties broken by hex id) from genesis to heads. Operations: `ObjectCreate`, `FieldSet`, `FieldDelete`, `ContentSet`, `ObjectDelete`, `BlockAdd/Remove/Update`.

**Storage.** `~/.glon/changes/<object-id>/<sha256-hex>.pb` — source of truth. SQLite index is derived; delete it and it rebuilds from disk.

---

## Actor State Model

Follows Rivet's `state` vs `vars` pattern:

```
state (persistent)           vars (ephemeral)
────────────────────────────  ────────────────────────────
id (object UUID)             typeKey
inbox (IPC messages)         fields, content, blocks
outbox (IPC messages)        blockProvenance, headIds
                             deleted, createdAt, updatedAt
                             changeCount
```

**`state`** survives sleep, crash, restart. Holds only UUID and IPC queues.

**`vars`** is recomputed on every wake: read all changes from disk, replay DAG, produce fresh state. The DAG on disk is always truth.

**Store actor** maintains SQLite indexes for cross-object queries (`list`, `get`, `search`), link traversal, and the coin index.

---

## Programs

Programs are glon objects with `typeKey: "program"`. They sync, have change history, and are discoverable at runtime.

**Compilation.** The `manifest` field maps filenames → source strings. At load time, the runtime feeds them into esbuild's virtual filesystem plugin and produces a single CJS bundle. The entry module `export default`s a `ProgramDef`.

**Program actors** get managed lifecycle: `createState`, `onCreate`/`onDestroy`, `actions` (RPC endpoints), `tickMs` + `onTick`.

**Validators** gate synced changes before disk write. For chain-mode types, the validator runs after the kernel's signature gate.

---

## Holdfast and Agents

### `/agent` — Conversation as a DAG

An `agent`-typed object is the durable home of a conversation. Every prompt, assistant text, `tool_use`, `tool_result`, and `compaction_summary` is a block.

**Conversation view** (derived, not stored):
1. Classify blocks into typed items.
2. If a `compaction_summary` exists, filter to items at or after `firstKeptBlockId` and inject the summary into the system prompt.
3. Group contiguous same-role items into Anthropic-shaped turns.

**Tool registration.** Agents register tools as a `tools` field (ValueMap). Each entry carries `target_prefix`, `target_action`, and optional `bound_args`. At dispatch, `bound_args` is merged **over** the model's input before calling the target — callers can bind identity the model cannot spoof.

**Compaction (two-stage).**
- Stage A (opt-in): a private tool set (`/memory.upsert_fact`, `upsert_milestone`, etc.) reads the pre-cut region and writes structured facts/milestones.
- Stage B (always): single LLM call produces a `compaction_summary` block.

**Todo follow-ups.** When `todo_write` is registered, a follow-up loop checks after compaction/idle for pending tasks and injects a system reminder.

### `/holdfast` — Agent Harness

Wraps `/agent` with:
- **Identity-aware ingest** — tags inbound text with `[from {name} on {source}, trust={level}]` via `/peer` objects.
- **Memory** — auto-wires `/memory` tools with `bound_args = { owner: agentId }`.
- **Reminders** — scheduled actions via `/remind`.
- **Shell** — persistent bash sessions via `/shell`.
- **Subagents** — batch spawning via `/task`.

### `/memory` — Facts and Milestones

| Type | Fields |
|---|---|
| `pinned_fact` | `owner` (link→agent), `key`, `value`, `confidence`, `sourced_from_block_id` |
| `milestone` | `owner`, `title`, `narrative`, `topics`, `peers`, `supersedes`, `status`, `confidence`, `sourced_from_blocks` |

Write paths: `upsert_fact`, `upsert_milestone`, `amend_milestone`. Read paths: `list_facts`, `list_milestones`, `recall`, `digest` (markdown for system-prompt injection).

---

## Crypto Layer

A signed-token chain on the same per-actor DAG primitives. Three programs (`/wallet`, `/coin`, `/consensus`) plus a kernel-level signature gate.

### Trust model

1. **Signature integrity** — Ed25519 over canonical-encoded bytes. Safety assumption.
2. **Honest majority of plotted disk space** — liveness/finality, deferred until PoST anchors are required.

### Chain-mode flag

Programs declare `chainMode: true` alongside `validatedTypes`. The kernel queries `isChainModeType(typeKey)` at two chokepoints:
- `pushChanges` — verifies signature before any validator runs.
- `commitChange` — rejects all writes to chain-mode objects; callers must construct a signed Change and submit via `pushChanges`.

### Canonical encoding (`src/det/canonical.ts`)

Protobuf3 wire format is byte-stable EXCEPT for `map<>` encoding order. `canonicalEncodeChange` recursively sorts every `map<>` entry set by UTF-8 byte order before encoding.

- `canonicalEncodeChange(c)` — bytes for `change.id`. `id` zeroed; `authorSig` included.
- `canonicalEncodeChangeForSigning(c)` — bytes the author signs. `id` AND `signature` zeroed; `pubkey`, `nonce`, `fee` present.

### Signature gate (`src/index.ts`)

For every chain-mode Change:
1. `authorSig` present.
2. `pubkey.length === 32`.
3. `signature.length === 64`.
4. Ed25519 verifies against `canonicalEncodeChangeForSigning`.
5. `change.id === sha256(canonicalEncodeChange(change))`.

### `/wallet`

Local-only; **not** chain-mode. `${GLON_DATA}/wallet.json` (mode 0600), atomic write via `.tmp` + rename.

Exposes `signChange({name, changeB64, nonce, fee})` — decodes, fills `authorSig`, computes canonical signing payload, signs, computes id, returns signed Change as base64. Private material exposed by no action.


Scales as O(total tx history) per balance query because the entire DAG must be replayed.

### `/coin` — UTXO Model

**Architecture:**
- `chain.token` — metadata only (name, symbol, decimals, owner, total_supply, mint_renounced).
- `chain.coin.bucket` — holds up to 1000 coins as `BlockAdd` ops with `contentType: "chain.coin.op"`.
- SQLite `coins` table — index for O(1) balance/holder queries.

**Coin ops:**
- `create` — `{coin_id, owner_pubkey, amount}`
- `spend` — `{coin_id}`

**Bucket replay.** `replayBucket(blocks)` iterates blocks in DAG order, building a `Map<coinId, {owner, amount, spent}>`. Create adds; spend sets `spent = true`.

**Validator.** `validateBucketChange` checks:
- Genesis must be first change and contain a `token_id` link.
- Create: `owner_pubkey` and `amount` present; amount parses as uint; bucket not at capacity; no duplicate `coin_id`.
- Spend: coin must exist and not already be spent (double-spend prevention).

**Transfer flow:**
1. `coinSelect(tokenId, senderPubkey, amount)` queries SQLite for unspent coins, sorted descending by amount, returns enough to cover the transfer.
2. Build `spend` changes for each input coin.
3. Build `create` changes for outputs: one to recipient, one for change back to sender.
4. Find or create an output bucket with capacity.
5. All changes are signed individually and pushed.

**SQLite integration.** `indexCoins(c, computed)` is called from `indexObject` when `typeKey === "chain.coin.bucket"`. It deletes stale rows for the bucket, replays blocks, and inserts one row per coin into the `coins` table. The store actor exposes:
- `coinBalance(tokenId, pubkey)` — sums `amount WHERE spent = 0`.
- `coinHolders(tokenId)` — groups by pubkey, sorted descending.
- `coinSelect(tokenId, pubkey, minAmount)` — greedy selection.
- `rebuildCoinIndex()` — full rebuild from all buckets.

**Scaling.** Balance queries are O(unspent coins in SQLite) rather than O(total tx history in DAG replay). Buckets shard the coin set across multiple objects, so no single actor replays more than 1000 coins.

### `/consensus` — Validator Pipeline

Pipeline per chain-mode Change (after kernel signature gate):

```
kernel pushChanges
  ├─ Ed25519 sig verified, change.id matches canonical hash
	  └─ getValidator("chain.coin.bucket") → /consensus validator
       ├─ nonce > last seen for pubkey?
       └─ fee >= minimumFee?
            Deploy: base × 100
            Mint:   base × 10
            Other:  base × 1
       └─ on accept: nonce state advances

async follow-up:
	  └─ dispatchProgram("/coin", "validate_op", ...)
       └─ replays prior state, applies op to clone, checks invariants
```

The split is necessary because the registered-validator API is synchronous and cannot `await dispatchProgram`. The sync validator catches signature/nonce/fee violations; semantic violations are caught by the program's `validate_op` action.

### `/anchor` — State Commitment

Each anchor is a `chain.anchor` object:
- `height` — sequential index
- `previous_anchor` — parent anchor ID
- `merkle_root` — SHA-256 binary Merkle tree over all chain-mode heads
- `timestamp`, `creator`, `commit_count`, `commits_json`
- `vdf_output`, `plot_proof`, `plot_quality` — PoST fields

**Merkle tree:** leaf = `sha256(utf8Bytes(objectId + ":" + headId))`, sort by hex, pair adjacent, duplicate last if odd.

**Fork choice:** longest chain (highest `height`). Ties broken by earlier timestamp.

**PoST:** VDF via `chiavdf` (Wesolowski proof, 1024-bit discriminant). Plot proofs via `chiapos` (k=25 for testing, k=32 for mainnet). Inflation rewards: 5 FIG base, halving every 1,000 anchors, minimum 1 unit.

---

## Sync Protocol

Pull-based over HTTP with protobuf `Envelope`. Two peers exchange head advertisements, compute missing changes via set difference, and push topologically sorted batches.

For chain-mode objects, the signature gate on `pushChanges` rejects forged Changes before disk. Nonce and fee checks provide replay/spam protection.

Full P2P hardening (mDNS discovery, Bloom filters, reputation scoring, eclipse defense) is deferred.

---

## Data Flow

**Write:** Shell → handler → build Change → `objectActor.pushChanges` → kernel sig verify (chain-mode) → validator → write `.pb` → reload vars → broadcast event → Store indexes in SQLite.

**Read:** Shell → Store → Object Actor (vars from disk) or SQLite (list queries).

**Wake:** Actor wakes → `createVars` → read changes → replay DAG → vars populated → ready.

**Sync:** Actor A advertises heads → B computes missing → B requests → A pushes sorted batch → both reload vars.
