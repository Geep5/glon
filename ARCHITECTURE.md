# glon — Architecture

## Layers

```
+---------------------------------------------------------------+
|  Programs (src/programs/)                                     |
|  EVERYTHING is a program: help, CRUD, inspect, IPC, agent,    |
|  tic-tac-toe, chat, wallet, token, consensus.                 |
|  Even /help is just a program loaded from the store!          |
+---------------------------------------------------------------+
|  Shell (src/client.ts)                                        |
|  Pure program loader. ZERO built-in commands.                 |
+---------------------------------------------------------------+
|  Store Actor (coordinator)                                    |
|  SQLite index: objects, changes, DAG edges, links             |
|  Creates/destroys object actors                               |
+---------------------------------------------------------------+
|  Object Actors (one per entity)                               |
|  Ephemeral vars: recomputed from disk on every wake           |
|  Sync protocol: advertiseHeads, pushChanges, getChanges       |
|  IPC: sendMessage, receiveMessage                             |
+---------------------------------------------------------------+
|  Change DAG (src/dag/)                                        |
|  Topological sort, state computation, content-addressing      |
+---------------------------------------------------------------+
|  Disk (src/disk.ts)          |  Proto (src/proto.ts)          |
|  ~/.glon/changes/<oid>/*.pb  |  Typed encode/decode           |
+---------------------------------------------------------------+
```

## The Change DAG

Every mutation is a `Change` — an immutable protobuf message.

```
Change {
  id: bytes           SHA-256 of the wire bytes (id field zeroed)
  object_id: string   stable UUID of the object
  parent_ids: bytes[] DAG edges to parent changes
  ops: Operation[]    mutations in this change
  timestamp: int64    unix ms
  author: string      device/user identifier
  author_sig: {       present only for chain-mode changes
    pubkey: bytes     32-byte Ed25519 public key
    signature: bytes  64-byte Ed25519 signature
    nonce: int64      per-pubkey monotonic counter
    fee: int64        fee paid in micro-units
  }
}
```

**Content-addressed.** `id = SHA-256(encode(change with id zeroed))`. Same mutation always produces the same hash.

**DAG structure.** Parent edges form the graph. No parents = genesis. Multiple parents = merge of concurrent changes. Heads = changes with no children.

**State = replay.** Current state is computed by topological sort (Kahn's BFS, ties broken by hex id) from genesis to heads, applying operations in order:

| Operation | Effect |
|---|---|
| `ObjectCreate` | Set type key, created timestamp |
| `FieldSet` | Set a typed field (values can nest via ValueMap/ValueList/ObjectLink) |
| `FieldDelete` | Remove a field |
| `ContentSet` | Set raw byte content |
| `ObjectDelete` | Tombstone flag |
| `BlockAdd/Remove/Update` | Block tree mutations (TextContent or CustomContent) |

## Actor State Model

Follows Rivet's `state` vs `vars` pattern:

```
state (persistent)           vars (ephemeral)
────────────────────────────  ────────────────────────────
id (object UUID)             typeKey
inbox (IPC messages)         fields, content, blocks
outbox (IPC messages)        blockProvenance
                             deleted, createdAt, updatedAt
                             headIds, changeCount
```

**`state`** is persistent — survives sleep, crash, restart. Holds only the object's UUID and IPC message queues. Minimal by design.

**`vars`** is ephemeral — recomputed via `createVars` every time the actor wakes. Reads all changes from disk for this object, replays the DAG via topological sort, and produces fresh computed state. No stale cache. The DAG on disk is always truth.

**`commitChange`** (the mutation path) writes the new change to disk, then reloads `vars` by recomputing from the full DAG. The actor never holds computed state that's out of sync with disk.

**Store actor:**
- SQLite index for cross-object queries
- Link index: scans fields for `ObjectLink` values, maintains `links` table for forward/reverse link queries and graph traversal
- Creates/destroys object actors via `c.client()`
- Indexes synced changes and objects for efficient `list`, `get`, `search`

## Storage

```
~/.glon/
  changes/
    <object-id>/            one subdirectory per object
      <sha256-hex>.pb       raw protobuf wire bytes
```

The `.pb` files are the source of truth. The SQLite index in the store actor is derived — it tracks objects, changes, DAG edges, and inter-object links for efficient queries. Delete the index and it rebuilds from disk.

Per-object subdirectories keep actor wake O(own changes) — an actor reads only its own directory, not the full change set.

## Programs

Programs are glon objects with type `program`. They sync between instances, have full change history, and are individually addressable.

### Object Shape

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Display name ("Agent") |
| `prefix` | string | Shell command prefix ("/agent") |
| `commands` | ValueMap | Subcommand names to descriptions |
| `manifest` | ValueMap | Module filenames → base64 source |

### Compilation

The `manifest` maps filenames to source strings. At load time, the runtime feeds them into esbuild's virtual filesystem plugin and produces a single CJS bundle. The entry module `export default`s a `ProgramDef`:

```typescript
export default {
  handler: async (cmd, args, ctx) => { ... },  // CLI handler
  actor: { ... },                                // stateful actor (optional)
  validator: (changes) => { ... },               // DAG validator (optional)
  validatedTypes: ["chain.token"],               // types to validate (optional)
  chainMode: true,                               // require signed Changes (optional)
};
```

**Discovery.** The shell calls `store.list()` at startup, extracts each program's manifest, bundles the modules, and compiles handlers. **ZERO hardcoded commands** — even `/help` is just another program loaded from the store.

**Execution.** When you type `/agent ask 9b2e Hello`, the shell matches the `/agent` prefix, calls the handler with `("ask", ["9b2e", "Hello"], ctx)`.

### Program Actors

Programs that export an `actor` definition get a managed lifecycle:

- `createState()` — initial persistent state
- `onCreate(ctx)` / `onDestroy(ctx)` — lifecycle hooks
- `actions: { name: (ctx, ...args) => result }` — RPC endpoints
- `tickMs` + `onTick(ctx)` — periodic tick loop

The runtime creates one actor instance per program. The kernel's `programActor` provides RPC dispatch and event broadcast.

### ProgramContext

The context object passed to all program code:

| Field | Purpose |
|---|---|
| `client` | Rivet client for actor calls |
| `store` | Actor client for CRUD, list, search |
| `resolveId` | Resolve an id prefix to a full id |
| `state` | Program's persistent state (read/write) |
| `emit(channel, data)` | Broadcast structured events |
| `programId` | This program's glon object ID |
| `objectActor(id, opts?)` | Typed access to any object actor |
| `dispatchProgram` | Call another program's actor action |
| `stringVal` / `intVal` / `mapVal` / ... | Proto value constructors |
| `print(msg)` | Output to the shell |
| `randomUUID()` | UUID generator |

### Validators

Programs register validators for specific object types. When `pushChanges` receives synced changes, the validator runs **before** writing to disk. Rejected changes throw and are not persisted.

For chain-mode types, the validator runs **after** the kernel's signature gate (Ed25519 verify + canonical hash check).

### Typed Output (Events)

Programs call `ctx.emit(channel, data)` which broadcasts `{ programId, channel, data }` to all subscribers. The 3D viewer glonAstrolabe subscribes to these events for live updates.

## Agents: Conversation, Tools, Compaction, Memory, Todos

`/agent` treats an `agent`-typed glon object as the durable home of a conversation. Every prompt, assistant text, `tool_use`, `tool_result`, and `compaction_summary` is a block in that object's DAG.

### Conversation view

The model-facing view is derived, not stored:

1. Classify blocks into typed items (user_text, assistant_text, tool_use, tool_result, compaction).
2. If a `compaction_summary` block exists, filter to items at or after `first_kept_block_id` and inject the latest summary into the system prompt.
3. Group contiguous same-role items into Anthropic-shaped turns.

Pre-compaction blocks stay in the DAG. Any peer replaying the history can ignore compaction blocks and see the full original conversation.

### Tool registration and `bound_args`

Agents register tools as ValueMap entries on their `tools` field. Each tool carries a target (`target_prefix`, `target_action`) that dispatches to another program's actor action, plus an optional `bound_args` map. At tool-use time the dispatcher merges `bound_args` **over** the model's input before calling the target — so callers can bind identity (e.g. `owner = agentId`) that the model cannot spoof.

### Compaction (two-stage)

Before each ask, `shouldAutoCompact` estimates tokens against `contextWindow - reserveTokens`. Over threshold triggers `doCompact`:

- **Stage A (opt-in, `memory_extraction_enabled`):** a private tool set exposes `/memory.upsert_fact`, `upsert_milestone`, `amend_milestone`, `list_*`, and `recall`, each with `bound_args = { owner: agentId }`. A tool-using summariser reads the pre-cut region and writes structured facts and milestones into the store.
- **Stage B (always):** single LLM call produces a narrative `compaction_summary` block covering the kept region.

An Anthropic context-overflow during an ask triggers a one-time mid-flight compaction + retry.

### Todo follow-ups

When an agent registers the `todo_write` tool, the follow-up loop checks after each compaction and idle period whether any tasks are pending or in_progress. If so, it injects a system reminder nudging the agent to continue. This bridges the gap between long-running tasks and the agent's finite context window.

## Memory: Facts and Milestones

`/memory` gives agents two object types for durable knowledge that survives compaction and syncs between instances like any other glon object.

### Object types

```
pinned_fact
  owner: ObjectLink<agent>
  key: string                 unique per (owner, key)
  value: string
  confidence: low | med | high
  sourced_from_block_id?: string

milestone
  owner: ObjectLink<agent>
  title: string
  narrative: string
  topics: string[]
  peers: ObjectLink<peer>[]
  supersedes: ObjectLink<milestone>[]   # amendment/replacement chain
  status: active | completed | superseded
  confidence: low | med | high
  sourced_from_blocks: string[]
  started_at / ended_at: int (ms)
```

### Write paths

- `upsert_fact(owner, key, value, ...)` — one row per `(owner, key)`. Same key replaces value in place via `FieldSet`; prior value stays in `object_history`.
- `upsert_milestone(owner, {...}, supersedes?)` — creates a new milestone and flips each `supersedes` target's `status` to `superseded`.
- `amend_milestone(id, {...})` — `FieldSet` on specific fields of an existing milestone.

### Read paths

- `list_facts(owner, key?)`, `list_milestones(owner, {status?, topic?, peer_id?, limit?})` — enumerate.
- `recall(owner, {query?, topics?, peer_ids?, time_range?})` — scoped search.
- `digest(owner)` — markdown digest ready for system-prompt injection, superseded milestones excluded, capped at `max_facts=40 / max_milestones=8`.

### Why objects, not a flat summary

One `pinned_fact` object per `(owner, key)` means an update is one `FieldSet` op, not a blob rewrite. The full edit chain is recoverable from `object_history`. Milestones supersede via `ObjectLink`, which the store's link index tracks in both directions.

## Chain layer

A signed-token chain on the same per-actor DAG primitives. Three programs (`/wallet`, `/token`, `/consensus`) plus a `chainMode` flag on `ProgramDef` plus a kernel-level signature gate.

### Trust model

Two assumptions, separately costed:

1. **Signature integrity** — the safety assumption. Ed25519 over canonical-encoded bytes; if the math is sound, no other party can forge a user's transaction.
2. **Honest majority of plotted disk space** — the liveness/finality assumption, applicable when proof-of-space-and-time anchors land in a later phase.

v1 has assumption (1) live and assumption (2) deferred. Signed Changes propagate via existing per-actor sync; there is no global ordering yet.

### Chain-mode flag

A program declares its types as chain-mode by setting `chainMode: true` on `ProgramDef` alongside `validatedTypes`:

```typescript
export default {
  validatedTypes: ["chain.token"],
  chainMode: true,
  // ...
};
```

`runtime.ts` builds a `Set<typeKey>` of chain-mode types from every program with `chainMode: true && validatedTypes`. The kernel queries it via `isChainModeType(typeKey)` at two chokepoints:

- `pushChanges` — the peer-sync write path. Verifies the signature on every Change before any program validator runs.
- `commitChange` — the local-mutator write path used by `setField`, `addBlock`, etc. Rejects all writes to chain-mode objects; callers must construct a signed Change and submit via `pushChanges`.

Non-chain objects continue to use the existing protobufjs encoding and the legacy mutator actions. Nothing changes for `/agent`, `/chat`, `/ttt`, etc.

### Canonical encoding (src/det/canonical.ts)

Protobuf3 wire format is byte-stable EXCEPT for `map<>` field encoding order, which is implementation-defined. Two protobufjs versions, or protobufjs vs protobuf-go vs protobuf-c++, can produce byte-different output for the same logical message. This breaks consensus the moment any node disagrees on a Change's hash.

`canonicalEncodeChange` recursively walks the message and sorts every `map<>` entry set by UTF-8 byte order before handing to the standard protobufjs encoder. Maps appear at three nesting points:

- `ValueMap.entries` (recursive — contained Values can themselves contain ValueMap)
- `ObjectSnapshot.fields`
- `CustomContent.meta`

Two encoders ship:

- **`canonicalEncodeChange(c)`** — bytes used to compute `change.id`. The `id` field is zeroed; `authorSig` (if present) is included. Different signatures therefore produce different ids.
- **`canonicalEncodeChangeForSigning(c)`** — bytes the author signs. Both `id` AND `authorSig.signature` are zeroed; `authorSig.pubkey`, `nonce`, `fee` are present. The signer commits to all four metadata fields, so changing fee or nonce after signing invalidates the signature.

Scope: only chain-mode objects use canonical encoding in v1. Non-chain objects keep the existing `encodeChangeForHashing`. Going global-canonical would change every existing object's id (one-time migration), deferred.

### Signature gate (src/index.ts)

For every chain-mode Change in a `pushChanges` batch, the kernel verifies:

1. `authorSig` is present.
2. `pubkey.length === 32`.
3. `signature.length === 64`.
4. Ed25519 signature verifies against `canonicalEncodeChangeForSigning(change)`.
5. `change.id === sha256(canonicalEncodeChange(change))`.

Any failure throws and rejects the entire batch. The Ed25519 implementation lives in `src/det/ed25519.ts`: raw 32-byte keys, wrapped in SPKI/PKCS8 DER for Node's built-in `node:crypto.{sign, verify}`. No new package dependency.

### Determinism substrate (src/det/)

Three modules, all importable by chain-mode programs as kernel externals:

- **`canonical.ts`** — the two encoders above.
- **`math.ts`** — `BigInt`-only helpers: `parseUint(s, max)`, `addBounded(a, b, max)`, `subChecked(a, b)`, `bigToString(n)`, plus `U128_MAX`, `U64_MAX`, `BIG_ZERO` constants. Strict input rejection — no hex prefixes, no negatives, no scientific notation.
- **`ed25519.ts`** — `generateKeyPair()`, `sign(privateKey, message)`, `verify(publicKey, message, signature)`. All three take/return raw byte arrays; the SPKI/PKCS8 wrapping is internal.

`test/chain/det-lint.test.ts` scans the consensus paths for banned APIs (`Date.now`, `Math.random`, `Number(`, etc.). Inline suppressions via `// det-lint-ignore: <reason>` are allowed for error-message formatting where the output is never hashed.

`test/chain/determinism.test.ts` runs the same Change through `canonicalEncodeChange` in the test process AND in a fresh subprocess spawned via `npx tsx -e <script>`, then asserts byte-identical output.

### `/wallet` — local-only keychain

`/wallet` is local-only; **not** chain-mode. Private material lives in `${GLON_DATA}/wallet.json` (mode 0600), written atomically via `.tmp` + rename. Same pattern `/auth` uses for Anthropic credentials.

```
${GLON_DATA}/wallet.json    mode 0600
  {
    version: 1,
    keys: {
      "alice": {
        pubkey: "...",     // 32-byte hex
        privateKey: "...", // 32-byte hex (Ed25519 seed)
        createdAt: 1234,
      }
    }
  }
```

The wallet exposes `signChange({name, changeB64, nonce, fee})` as an actor action. It decodes the unsigned Change, fills in `authorSig`, computes the canonical signing payload, signs, computes the canonical id, and returns the fully-formed signed Change as base64. Private material is exposed by NO action — `list`, `show`, `keyForPubkey` all return metadata only.

CLI: `wallet new <name>`, `wallet list`, `wallet show <name>`, `wallet remove <name>`.

### `/token` — state via DAG replay

Each token is one Glon object with `typeKey: "chain.token"`.

- **Static metadata in fields**: `name`, `symbol`, `decimals`, `owner_pubkey`, `initial_supply`, `storage_credit` (reserved for v2 rent; always `"0"` in v1). Set once at deploy time via `FieldSet` ops in the genesis Change.
- **Operations as `CustomContent` blocks**: each op is one `BlockAdd` with `contentType: "chain.token.op"`. `meta` carries the op kind plus parameters plus the signer's pubkey hex.

State (balances, total_supply, allowances) is **derived** from `fields + blocks` via `replayState`. Initial supply is credited to `owner_pubkey` implicitly during replay. State is never stored — same model `/agent` uses for conversation views.

Six op kinds: `Mint`, `Transfer`, `Approve`, `TransferFrom`, `Burn`, `RenounceMint`. All semantic invariants (only-owner mints, allowance underflow, U128_MAX overflow, mint-after-renounce rejection) live in `applyOpToState`, which throws on any violation. The validator runs it against a clone of current state in try/catch; thrown errors become `{valid: false, error}` returns.

CLI: `token deploy <name> <symbol> <supply> [--decimals=N] [--key=name]`, `token transfer <token_id> <to_pubkey> <amount> [--key=name]`, `token info <token_id>`, `token balance <token_id> <pubkey>`, `token holders <token_id>`.

`/token` exposes its rules via the `validate_op` actor action rather than registering a top-level validator. `/consensus` is the sole registered validator for `chain.token`, dispatching to `validate_op` after its own checks pass.

### `/consensus` — validator pipeline

The kernel calls `/consensus`'s validator before disk-write. Pipeline per chain-mode Change (after the kernel signature gate has fired):

```
kernel pushChanges
  ├─ Ed25519 sig verified, change.id matches canonical hash
  └─ getValidator("chain.token") → /consensus's validator
       ├─ consensusGate(change, state)
       │    ├─ nonce > last seen for pubkey? (replay protection)
       │    └─ fee >= minimumFee(kind, policy)?
       │         Deploy: base × 100
       │         Mint:   base × 10
       │         Other:  base × 1   (Transfer / Burn / Approve / etc.)
       └─ on accept: state advances (per-pubkey nonce updated)

asynchronous follow-up:
  └─ dispatchProgram("/token", "validate_op", {tokenId, changeB64})
       └─ /token replays prior state, applies op to a clone, checks invariants
```

The split is necessary because Glon's registered-validator API is synchronous and can't `await dispatchProgram`. The synchronous validator catches all signature/nonce/fee violations in the kernel pipeline; semantic violations (a Transfer with no balance, a Mint by a non-owner) are caught by `/token.validate_op`.

Per-pubkey nonce store lives in `/consensus`'s actor state as `nonces: Record<pubkey_hex, number>`. The synchronous validator reads from a module-local mirror that the actor's `recordAccepted` action keeps in sync.

CLI: `consensus status`, `consensus nonces`, `consensus set-base-fee <n>`.

### `/anchor` — state commitment and ordering

Inspired by Chia's separation of consensus-critical "trunk" from payload "foliage":
the `merkle_root` field is the trunk (determines fork choice); the `commits_json` field
is the foliage (inspection only, not consensus-critical).

Each anchor is a `chain.anchor` object with:

| Field | Purpose |
|---|---|
| `height` | Sequential index (genesis = 0) |
| `previous_anchor` | Object ID of previous anchor ("" for genesis) |
| `merkle_root` | Hex SHA-256 root of binary Merkle tree over all chain-mode heads |
| `timestamp` | Unix ms |
| `creator` | Pubkey or "system" (v1) |
| `commit_count` | Number of committed object heads |
| `commits_json` | JSON array of `{objectId, headId}` (for inspection/verification) |
| `vdf_output` | VDF proof JSON (optional in testnet, required for mainnet) |
| `plot_proof` | Plot proof JSON (optional in testnet, required for mainnet) |
| `plot_quality` | Quality score of plot proof (higher = better) |


**Merkle tree:**
1. Leaf = `sha256(utf8Bytes(objectId + ":" + headId))`
2. Sort leaves by hex string (deterministic)
3. Pair adjacent: `node = sha256(left + right)`
4. If odd count, duplicate last leaf
5. Repeat until one hash remains = root

**Fork choice (v1):** longest chain (highest `height`). Ties broken by earlier timestamp.
In v1 with typically one creator, forks are unlikely.

**Finality:** a Change is "finalized" when its object's head appears in an anchor.
Changes after the latest anchor are "pending".

CLI: `anchor create`, `anchor list [limit]`, `anchor status`, `anchor info <id>`, `anchor verify <id>`.
Actor auto-ticks every 60s.

### PoST — Real Proof of Space and Time

glon uses Chia Network's production PoST libraries via subprocess CLI binaries
installed at `~/.glon/bin/`.

**`/plot`** — Proof of Space (chiapos):
  - Plots are created with `chiapos create -k <size> -f <file> -i <id>`
  - k=25 = ~600MB (testing), k=32 = ~101GB (mainnet)
  - Challenge = 32-byte hash derived from previous anchor's merkle_root
  - Proof = lookup in the plot using Chia's secure proof-of-space construction
  - Multiple proofs may be returned; quality is derived from proof size
  - Binary: `~/.glon/bin/chiapos` (built from github.com/Chia-Network/chiapos)

**`/timelord`** — Proof of Time (chiavdf):
  - VDF = repeated squaring in class groups of unknown order
  - Proof = Wesolowski proof (two serialized group elements)
  - Verification = `chiavdf-verify` binary validates the Wesolowski proof
  - Discriminant size: 1024 bits (Chia mainnet standard)
  - Default iterations: 5,000,000 (~20-45s on modern CPUs)
  - Binary: `~/.glon/bin/chiavdf-compute` and `~/.glon/bin/chiavdf-verify`
    (built from github.com/Chia-Network/chiavdf)

**`/anchor` PoST gate:**
  - Anchor creation optionally accepts a VDF proof (`--vdf`)
  - If VDF proof is provided, it is validated via `chiavdf-verify`
  - Future: plot proofs will determine winning anchor among competing creators

**Inflation rewards:**
  - Every anchor carries a `reward_amount` and `reward_pubkey`
  - Base reward: 5 FIG per anchor
  - Halving: reward halves every 1,000 anchors
  - Minimum reward: 1 unit (effectively zero after many halvings)
  - Total supply approaches a finite cap

### What's deferred

- **Reorg / fork choice**: requires anchor chain + cumulative-VDF-iterations comparison.
- **Adversarial sync hardening**: peer scoring, ban list, bounded buffer.
- **State rent / storage_credit accounting**: every full node stores all chain state forever in v1. The `storage_credit` field is reserved on every `chain.token` object (always `"0"` today).

## Sync Protocol

The sync system is pull-based over HTTP with protobuf `Envelope` messages. Two peers exchange head advertisements, compute missing changes via set difference, and push topologically sorted change batches.

**Messages:** `HeadAdvertise`, `HeadRequest`, `ChangePush`, `ChangeRequest`, `ObjectSubscribe`, `ObjectEvent`.

**For chain-mode objects:** the signature gate on `pushChanges` means a peer cannot slip an invalid Change into a sync batch. Even if a malicious peer sends a forged Change, the kernel rejects it before it reaches disk. Nonce and fee checks in `/consensus` provide replay and spam protection.

**Current state:** `src/programs/handlers/sync.ts` is a stub. Discovery via mDNS and full P2P hardening (Bloom filters, reputation scoring, eclipse defense) are deferred.

## Garbage Collection

GC is a tool, not a policy. The `/gc` program provides protection, link-based reachability, and collection.

**Algorithm:**
1. **Roots:** explicitly protected object IDs (set by programs or users)
2. **Reachability:** BFS from roots following outbound links in the object graph
3. **Collect:** delete objects that are neither roots nor reachable

```
/gc protect <id>     # mark as root (transitive via links)
/gc unprotect <id>   # remove root
/gc run [--dry-run]  # collect unreachable objects
/gc status           # show roots and reachability
```

## Data Flow

**Write:** Shell → handler → build Change → objectActor.pushChanges → kernel verifies sig (chain-mode) → validator runs → write .pb to disk → reload vars from DAG → broadcast event → Store indexes in SQLite

**Read:** Shell → Store → Object Actor (vars, computed from disk) or SQLite (list queries)

**Wake:** Actor wakes → `createVars` runs → reads all changes from disk for this object → replays DAG → vars populated → ready

**Sync:** Actor A advertises heads → Actor B computes missing → B requests changes → A pushes topologically sorted batch → both reload vars

## Extensibility

### Recursive Values

`Value` is recursive. `ValueMap` and `ValueList` contain `Value`s, so programs can express arbitrarily nested structures using only `FieldSet` operations. glon never interprets these structures — programs define their own conventions on top of the typed primitives.

### Custom Block Content

`BlockContent` has an escape hatch for program-defined block types:

```
CustomContent {
  string content_type          = 1;  // e.g. "image", "table", "chain.token.op"
  bytes  data                  = 2;  // program-encoded payload
  map<string, string> meta     = 3;  // fallback display metadata
}
```

glon stores, content-addresses, syncs, and replays custom blocks through the standard Change DAG. Peers that don't understand a `CustomContent` block fall back to displaying the `meta` map.

### Discussion convention: `message` and `reaction` blocks

Two `CustomContent` content_type values "message" and "reaction" carry a discussion-on-any-object convention that `/comment` implements:

**`message` block:** `meta.text` (required), `meta.creator`, `meta.reply_to`, `meta.attachments`, `meta.created_at`.

**`reaction` block:** `meta.target` (block_id of message), `meta.emoji`, `meta.creator`.

Reactions live as siblings of the message they target; the relationship is logical (`meta.target`), not structural. Threading is logical too: replies are sibling messages with `meta.reply_to` pointing at the parent.

Programs that want comments on their own object types just dispatch `/comment.post` at any object id. `/chat` is the canonical consumer.

## Source Layout

```
src/programs/
  runtime.ts                 module bundler, actor lifecycle, validators, chain-mode registry
  handlers/
    help.ts                  list available programs
    crud.ts                  CRUD operations on any object
    inspect.ts               DAG inspection (history, changes, heads, sync)
    ipc.ts                   inter-object messaging (inbox/outbox)
    graph.ts                 object graph traversal and link queries
    ttt.ts                   tic-tac-toe
    chat.ts                  chat rooms
    comment.ts               discussions on any object
    agent.ts                 LLM agent: conversation, tool use, auto-compaction, memory digest
    task.ts                  subagent spawning batch CLI
    memory.ts                pinned_fact + milestone objects, recall/digest
    peer.ts                  identity + trust for people and agents
    remind.ts                scheduled actions
    discord.ts               Discord bridge
    holdfast.ts              generic agent harness: identity-aware ingest + tools
    web.ts                   shell cheatsheet (curl/jq/pandoc recipes)
    google.ts                shell cheatsheet for gws CLI
    anytype.ts               shell cheatsheet for local Anytype REST API
    gc.ts                    reachability-based garbage collection
    accounts.ts              multi-user auth & per-object permissions (stub)
    sync.ts                  P2P synchronization & discovery (stub)
    auth.ts                  Anthropic credential management
    todo.ts                  phased task lists for agents
    wallet.ts                local Ed25519 keychain
    token.ts                 fungible-token program
    consensus.ts             chain-mode validator gate
    anchor.ts                state commitment: Merkle-root anchor blocks
    shell.ts                 persistent bash sessions
scripts/
  daemon.ts                  headless host: no stdin, HTTP dispatch endpoint
  dispatch.ts                thin HTTP client for the daemon
  read-agent-blocks.ts       diagnostic: dump an agent's conversation blocks
  tail-blocks.ts             tail an object's last N blocks
  inspect-id.ts              dump an object's typeKey, fields, block count
  list-reminders.ts          dump every reminder in the store
  dump-tooluse.ts            dump tool_use / tool_result blocks
  dump-system.ts             print an agent's system prompt
  dump-handler-source.ts     read a typescript object's content from the DAG
  agent-info.ts              name, model, tool count, system length, compaction tuning
  check-mti.ts               read or set max_tool_iterations
  prune-tools.ts             drop wired tools by prefix
  rename-agent.ts            rename agent + rewrite system prompt
  capture-setup.ts           snapshot agent + principal config as JSON
  test-steer-live.ts         steering / multi-runner integration check
```

### Daemon vs Shell

Two entry points share the same program loader:

- `src/client.ts` — interactive REPL. Reads stdin, prints to stdout.
- `scripts/daemon.ts` — headless. Same program set, no stdin, exposes `POST /dispatch {prefix, action, args}` on `127.0.0.1:6430`.

Both connect to the same actor registry on `:6420`. Running them in parallel is valid — the actors hold their own state, clients only dispatch.
