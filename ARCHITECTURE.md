# glon — Architecture

## Layers

```
+---------------------------------------------------------------+
|  Programs (src/programs/)                                     |
|  EVERYTHING is a program: help, CRUD, inspect, IPC, agent,    |
|  tic-tac-toe, chat, GC, accounts, P2P sync, graph.            |
|  Even /help is just a program loaded from the store!          |
+------------------------------+--------------------------------+
|  Shell (src/client.ts)       |  Bootstrap (src/bootstrap.ts)  |
|  Pure program loader         |  Seed source & programs        |
|  ZERO built-in commands      |  as glon objects               |
+------------------------------+--------------------------------+
|  Store Actor (coordinator)                                    |
|  SQLite index: objects, changes, DAG edges, links             |
|  Creates/destroys object actors                               |
+------------------------------+--------------------------------+
|  Object Actors (one per entity)                               |
|  Ephemeral vars: recomputed from disk on every wake           |
|  Sync protocol: advertiseHeads, pushChanges, getChanges       |
|  IPC: sendMessage, receiveMessage                             |
+------------------------------+--------------------------------+
|  Change DAG (src/dag/)                                        |
|  Topological sort, state computation, content-addressing      |
+------------------------------+--------------------------------+
|  Disk (src/disk.ts)          |  Proto (src/proto.ts)          |
|  ~/.glon/changes/<oid>/*.pb  |  Typed encode/decode           |
+------------------------------+--------------------------------+
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
}
```

**Content-addressed.** `id = SHA-256(encode(change with id zeroed))`.
Same mutation always produces the same hash.

**DAG structure.** Parent edges form the graph. No parents = genesis.
Multiple parents = merge of concurrent changes. Heads = changes with
no children.

**State = replay.** Current state is computed by topological sort
(Kahn's BFS, ties broken by hex id) from genesis to heads, applying
operations in order:

| Operation | Effect |
|---|---|
| `ObjectCreate` | Set type key, created timestamp |
| `FieldSet` | Set a typed field (values can nest via ValueMap/ValueList/ObjectLink) |
| `FieldDelete` | Remove a field |
| `ContentSet` | Set raw byte content |
| `ObjectDelete` | Tombstone flag |
| `BlockAdd/Remove/Update` | Block tree mutations (TextContent or CustomContent) |

## Sync Protocol

### P2P Architecture

The sync system operates peer-to-peer without central servers:

**Discovery:** mDNS for local network, manual addition for cross-network
**Transport:** HTTP with protobuf `Envelope` messages
**Selection:** Bloom filters for efficient content advertising
**Trust:** Reputation scoring based on successful syncs

### Messages

| Message | Purpose |
|---|---|
| `HeadAdvertise` | "Here are my heads for this object" |
| `HeadRequest` | "Send me changes between these ancestors and these heads" |
| `ChangePush` | "Here are changes you're missing" (topologically sorted) |
| `ChangeRequest` | "Send me these specific changes by hash" |
| `ObjectSubscribe` | "Notify me when this object changes" |
| `ObjectEvent` | "This object changed, here are the new heads + changes" |
| `AppMessage` | Free-form IPC between objects |
| `BloomFilter` | "Here's what content I have" (space-efficient) |
| `PeerAnnounce` | "I'm a glon peer at this endpoint" (mDNS) |

### Sync Handshake

1. Peers exchange Bloom filters (probabilistic content sets)
2. Compute likely differences (what each might be missing)
3. Request specific missing changes by hash
4. Push confirmed missing changes to the peer
5. Both recompute state from the merged DAG
6. Update peer reputation based on sync success

### Peer Management

```typescript
interface Peer {
  id: string;           // SHA-256 of endpoint
  endpoint: string;     // HTTP URL
  lastSeen: number;     // Unix timestamp
  reputation: number;   // 0-100 score
  bloomFilter: Uint8Array;  // Compressed content set
}
```

Peers track reputation: successful syncs increase score, failures
decrease. High-reputation peers are preferred for sync operations.

## Storage

```
~/.glon/
  changes/
    <object-id>/            one subdirectory per object
      <sha256-hex>.pb       raw protobuf wire bytes
```

The `.pb` files are the source of truth. The SQLite index in the
store actor is derived — it tracks objects, changes, DAG edges,
and inter-object links for efficient queries. Delete the index
and it rebuilds from disk.

Per-object subdirectories keep actor wake O(own changes) — an actor
reads only its own directory, not the full change set.

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

**`state`** is persistent — survives sleep, crash, restart. Holds only
the object's UUID and IPC message queues. Minimal by design.

**`vars`** is ephemeral — recomputed via `createVars` every time the
actor wakes. Reads all changes from disk for this object, replays
the DAG via topological sort, and produces fresh computed state.
No stale cache. The DAG on disk is always truth.

**`commitChange`** (the mutation path) writes the new change to disk,
then reloads `vars` by recomputing from the full DAG. The actor
never holds computed state that's out of sync with disk.

**Rivet actors over HTTP.** Each object actor is a globally-addressable
endpoint that wakes on demand, hibernates when idle, survives crashes.
The `createVars` hook runs on every wake, so computed state is always
fresh from disk.

**Store actor:**
- SQLite index for cross-object queries
- Link index: scans fields for `ObjectLink` values, maintains `links` table
  for forward/reverse link queries and graph traversal
- Creates/destroys object actors via `c.client()`
- Validates existence for IPC routing

## Programs

Programs are glon objects with type `program`. They sync between
instances, have full change history, and are individually addressable.

### Object Shape

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Display name ("Agent") |
| `prefix` | string | Shell command prefix ("/agent") |
| `commands` | ValueMap | Subcommand names to descriptions |
| `manifest` | ValueMap | Module filenames → base64 source |

### Compilation

The `manifest` maps filenames to source strings. At load time,
the runtime feeds them into esbuild's virtual filesystem plugin and
produces a single CJS bundle. The entry module `export default`s
a `ProgramDef`:

```typescript
export default {
  handler: async (cmd, args, ctx) => { ... },  // CLI handler
  actor: { ... },                                // stateful actor (optional)
  validator: (changes) => { ... },               // DAG validator (optional)
  validatedTypes: ["character", "item"],         // types to validate (optional)
};
```

Simple programs (ttt, chat, agent) have one module. Complex programs
(godly) have many. Same compilation path — no special cases.

**Discovery.** The shell calls `store.list("program")` at startup,
extracts each program's manifest, bundles the modules, and compiles
handlers. **ZERO hardcoded commands** — even `/help` is just another
program loaded from the store. The shell is a pure program loader.

**Execution.** When you type `/agent ask 9b2e Hello`, the shell
matches the `/agent` prefix, calls the handler with
`("ask", ["9b2e", "Hello"], ctx)`. The handler validates, calls
actor actions, and prints output.

### Program Actors

Programs that export an `actor` definition get a managed lifecycle:

- `createState()` — initial persistent state
- `onCreate(ctx)` / `onDestroy(ctx)` — lifecycle hooks
- `actions: { name: (ctx, ...args) => result }` — RPC endpoints
- `tickMs` + `onTick(ctx)` — periodic tick loop

The runtime creates one actor instance per program. Programs manage
their own sub-instances (e.g. active fights) in state. The kernel's
`programActor` provides RPC dispatch and event broadcast.

### ProgramContext

The context object passed to all program code:

| Field | Purpose |
|---|---|
| `store` | Actor client for CRUD, list, search |
| `state` | Program's persistent state (read/write) |
| `emit(channel, data)` | Broadcast structured events |
| `programId` | This program's glon object ID |
| `objectActor(id)` | Typed access to any object actor |
| `proto` | Encode/decode helpers (`stringVal`, `mapVal`, etc.) |
| `print(msg)` | Output to the shell |

### Validators

Programs register validators for specific object types. When
`pushChanges` receives synced changes, the validator runs **before**
writing to disk. Rejected changes throw and are not persisted.

### Typed Output (Events)

The kernel's `programActor` has a `programEvent` Rivet event.
Programs call `ctx.emit(channel, data)` which broadcasts
`{ programId, channel, data }` to all subscribers.

### Source Layout

```
src/programs/
  runtime.ts                 module bundler, actor lifecycle, validators
  handlers/
    help.ts                  list available programs (even this is a program!)
    crud.ts                  CRUD operations on any object
    inspect.ts               DAG inspection (history, changes, heads, sync)
    ipc.ts                   inter-object messaging (inbox/outbox)
    graph.ts                 object graph traversal and link queries
    ttt.ts                   tic-tac-toe
    chat.ts                  chat rooms
    agent.ts                 LLM agent: conversation, tool use, auto-compaction, memory digest
    memory.ts                pinned_fact + milestone objects, recall/digest, validator
    peer.ts                  identity + trust for people and agents
    remind.ts                scheduled actions (DM, agent-compose, email)
    discord.ts               Discord bridge: Gateway WS for online presence + REST poll for DMs -> /holdfast.ingest
    holdfast.ts              generic agent harness: identity-aware ingest + tools, configured per setup
    web.ts                   shell cheatsheet (curl/jq/pandoc recipes; no actor)
    google.ts                shell cheatsheet for the gws CLI (no actor)
    anytype.ts               shell cheatsheet for the local Anytype REST API (no actor)
    gc.ts                    reachability-based garbage collection
    accounts.ts              multi-user auth & per-object permissions
    sync.ts                  P2P synchronization & discovery
scripts/
  daemon.ts                  headless host: no stdin, HTTP dispatch endpoint
  dispatch.ts                thin HTTP client for the daemon
  read-agent-blocks.ts       diagnostic: dump an agent's conversation blocks
```

### Daemon vs Shell

Two entry points share the same program loader:

- `src/client.ts` — interactive REPL. Reads stdin, prints to stdout. Good for
  exploring, debugging, ad-hoc chat with an agent.
- `scripts/daemon.ts` — headless. Same program set, no stdin, exposes
  `POST /dispatch {prefix, action, args}` on `127.0.0.1:6430`. Good for running
  the Discord bridge, the reminder tick loop, or anything that should keep running
  without a terminal attached.

Both connect to the same actor registry on `:6420`. Running them in parallel is
valid — the actors hold their own state, clients only dispatch.

## Agents: Conversation, Tools, Compaction, Memory

`/agent` is a program that treats an `agent`-typed glon object as the durable
home of a conversation. Every prompt, assistant text, `tool_use`, `tool_result`,
and `compaction_summary` is a block in that object's DAG.

### Conversation view

The model-facing view of the conversation is derived, not stored:

1. Classify blocks into typed items (user_text, assistant_text, tool_use,
   tool_result, compaction).
2. If a `compaction_summary` block exists, filter to items at or after
   `first_kept_block_id` and inject the latest summary into the system prompt
   as `<conversation-summary>`.
3. Group contiguous same-role items into Anthropic-shaped turns.

Pre-compaction blocks stay in the DAG. Any peer replaying the history can ignore
compaction blocks and see the full original conversation.

### Tool registration and `bound_args`

Agents register tools as ValueMap entries on their `tools` field. Each tool
carries a target (`target_prefix`, `target_action`) that dispatches to another
program's actor action, plus an optional `bound_args` map. At tool-use time the
dispatcher merges `bound_args` **over** the model's input before calling the
target — so callers can bind identity (e.g. `owner = agentId`) that the model
cannot spoof by passing its own value.

This turns registered tools into partially-applied program actions: the model
provides the task-specific arguments, the registrar provides the identity-
scoped ones.

### Compaction (two-stage)

Before each ask, `shouldAutoCompact` estimates the effective system prompt +
messages + memory digest against `contextWindow - reserveTokens`. Over threshold
triggers `doCompact`:

- **Stage A (opt-in, `memory_extraction_enabled`):** a private tool set exposes
  `/memory.upsert_fact`, `upsert_milestone`, `amend_milestone`, `list_*`, and
  `recall`, each with `bound_args = { owner: agentId }`. A tool-using summariser
  reads the pre-cut region, inspects existing memory first, then writes structured
  facts and milestones directly into the store. Failures degrade to Stage B.
- **Stage B (always):** single LLM call produces a narrative `compaction_summary`
  block covering the kept region. Knows Stage A ran, so it focuses on arc
  (goal / progress / next steps) rather than re-listing facts memory already holds.

An Anthropic context-overflow during an ask triggers a one-time mid-flight
compaction + retry.

## Memory: Facts and Milestones

`/memory` gives agents two object types for durable knowledge that survives
compaction and syncs between instances like any other glon object.

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

- `upsert_fact(owner, key, value, ...)` — one row per `(owner, key)`. Same key
  replaces value in place via `FieldSet`; prior value stays in `object_history`.
- `upsert_milestone(owner, {...}, supersedes?)` — creates a new milestone and
  flips each `supersedes` target's `status` to `superseded`.
- `amend_milestone(id, {...})` — `FieldSet` on specific fields of an existing
  milestone. Every amendment is a `Change` in that milestone's DAG.

Local writes go through these action helpers (input validation). Peer-synced
writes hit a registered validator that enforces required fields on create
batches and enum shape on amendments. The validator is registered on
`validatedTypes: ["pinned_fact", "milestone"]` and fires before disk write
in `pushChanges`.

### Read paths

- `list_facts(owner, key?)`, `list_milestones(owner, {status?, topic?, peer_id?, limit?})` — enumerate.
- `recall(owner, {query?, topics?, peer_ids?, time_range?})` — scoped search.
- `digest(owner)` — markdown digest ready for system-prompt injection,
  superseded milestones excluded, capped at `max_facts=40 / max_milestones=8`.

When an agent has `memory_digest_enabled: true`, `runAsk` prepends the digest
to the effective system prompt. Facts and milestones the model just wrote or
amended are visible on the next turn. `shouldAutoCompact` also counts digest
tokens in its threshold estimate.

### Why objects, not a flat summary

One `pinned_fact` object per `(owner, key)` means an update is one `FieldSet`
op, not a blob rewrite. The full edit chain is recoverable from `object_history`.
Milestones supersede via `ObjectLink`, which the store's link index tracks in
both directions — "what replaced milestone X?" is a cheap reverse-link query.

### Ownership model

Everything in `/memory` is agent-scoped through the `owner` `ObjectLink` field.
Two agents sharing a glon store have independent memory. An agent reading its
own store is a regular `object_list type_key=pinned_fact/milestone` query; no
special read path.


## Chain layer

A signed-token chain on the same per-actor DAG primitives. Three programs
(`/wallet`, `/token`, `/consensus`) plus a `chainMode` flag on `ProgramDef`
plus a kernel-level signature gate. Tokens, balances, and allowances are
regular Glon objects whose state is computed by replaying the DAG.

### Trust model

Two assumptions, separately costed:

1. **Signature integrity** — the safety assumption. Ed25519 over canonical-
   encoded bytes; if the math is sound, no other party can forge a user's
   transaction.
2. **Honest majority of plotted disk space** — the liveness/finality
   assumption, applicable when proof-of-space-and-time anchors land in a
   later phase.

v1 has assumption (1) live and assumption (2) deferred. Signed Changes
propagate via existing per-actor sync; there is no global ordering yet.

### Chain-mode flag

A program declares its types as chain-mode by setting `chainMode: true` on
`ProgramDef` alongside `validatedTypes`:

```typescript
export default {
  validatedTypes: ["chain.token"],
  chainMode: true,
  // ...
};
```

`runtime.ts` builds a `Set<typeKey>` of chain-mode types from every program
with `chainMode: true && validatedTypes`. The kernel queries it via
`isChainModeType(typeKey)` at two chokepoints:

- `pushChanges` — the peer-sync write path. Verifies the signature on every
  Change before any program validator runs.
- `commitChange` — the local-mutator write path used by `setField`,
  `addBlock`, etc. Rejects all writes to chain-mode objects; callers must
  construct a signed Change and submit via `pushChanges`.

Non-chain objects continue to use the existing protobufjs encoding and the
legacy mutator actions. Nothing changes for `/agent`, `/chat`, `/ttt`, etc.

### Canonical encoding (src/det/canonical.ts)

Protobuf3 wire format is byte-stable EXCEPT for `map<>` field encoding
order, which is implementation-defined. Two protobufjs versions, or
protobufjs vs protobuf-go vs protobuf-c++, can produce byte-different
output for the same logical message. This breaks consensus the moment any
node disagrees on a Change's hash.

`canonicalEncodeChange` recursively walks the message and sorts every
`map<>` entry set by UTF-8 byte order before handing to the standard
protobufjs encoder. Maps appear at three nesting points:

- `ValueMap.entries` (recursive — contained Values can themselves contain ValueMap)
- `ObjectSnapshot.fields` (only relevant when a snapshot is embedded)
- `CustomContent.meta`

Two encoders ship:

- **`canonicalEncodeChange(c)`** — bytes used to compute `change.id`. The
  `id` field is zeroed; `authorSig` (if present) is included. Different
  signatures therefore produce different ids — a witness can't substitute
  another signer's authorization at the same id.
- **`canonicalEncodeChangeForSigning(c)`** — bytes the author signs.
  Both `id` AND `authorSig.signature` are zeroed; `authorSig.pubkey`,
  `nonce`, `fee` are present. The signer commits to all four metadata
  fields, so changing fee or nonce after signing invalidates the signature.

Scope: only chain-mode objects use canonical encoding in v1. Non-chain
objects keep the existing `encodeChangeForHashing`. Going global-canonical
would change every existing object's id (one-time migration), deferred.

### Signature gate (src/index.ts)

For every chain-mode Change in a `pushChanges` batch, the kernel verifies:

1. `authorSig` is present.
2. `pubkey.length === 32`.
3. `signature.length === 64`.
4. Ed25519 signature verifies against `canonicalEncodeChangeForSigning(change)`.
5. `change.id === sha256(canonicalEncodeChange(change))`.

Any failure throws and rejects the entire batch — peers can't slip an
invalid Change in alongside valid ones. The Ed25519 implementation lives
in `src/det/ed25519.ts`: raw 32-byte keys, wrapped in SPKI/PKCS8 DER for
Node's built-in `node:crypto.{sign, verify}`. No new package dependency.

### Determinism substrate (src/det/)

Three modules, all importable by chain-mode programs as kernel externals
(via the same mechanism that exposes `proto.js` and `crypto.js`):

- **`canonical.ts`** — the two encoders above.
- **`math.ts`** — `BigInt`-only helpers: `parseUint(s, max)`, `toBigInt(v)`,
  `addBounded(a, b, max)`, `subChecked(a, b)`, `bigToString(n)`,
  `bigCompare(a, b)`, plus `U128_MAX`, `U64_MAX`, `BIG_ZERO` constants.
  Strict input rejection — no hex prefixes, no negatives, no scientific
  notation. `Number` values above `Number.MAX_SAFE_INTEGER` are rejected.
- **`ed25519.ts`** — `generateKeyPair()`, `sign(privateKey, message)`,
  `verify(publicKey, message, signature)`. All three take/return raw byte
  arrays; the SPKI/PKCS8 wrapping is internal.

`test/chain/det-lint.test.ts` scans the consensus paths for banned APIs
(`Date.now`, `Math.random`, `Math.floor`/`ceil`/`round`/`max`/`min`,
`parseInt`, `parseFloat`, `Number(`, `JSON.stringify`). Inline suppressions
via `// det-lint-ignore: <reason>` are allowed for cases like error-message
formatting where the output is never hashed. The scanner self-tests on a
synthetic input and fails the suite if any banned use slips into a
registered consensus file.

`test/chain/determinism.test.ts` runs the same Change through
`canonicalEncodeChange` in the test process AND in a fresh subprocess
spawned via `npx tsx -e <script>`, then asserts byte-identical output.
This is the only test that catches divergence between independent Node
processes — the closest analog the harness has to "two nodes on the
network agreeing on a hash."

### `/wallet` — two-tier storage

`/wallet` is local-only; **not** chain-mode. Its private material would
be a disaster to put in the DAG (every peer would have your keys). Same
pattern `/auth` uses for Anthropic credentials:

```
${GLON_DATA}/wallet.json    mode 0600, atomic write via .tmp + rename
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

The wallet exposes `signChange({name, changeB64, nonce, fee})` as an actor
action. It decodes the unsigned Change, fills in `authorSig` (pubkey +
empty signature placeholder + nonce + fee), computes the canonical signing
payload, signs, fills in the signature bytes, computes the canonical id,
and returns the fully-formed signed Change as base64. Private material is
exposed by NO action — `list`, `show`, `keyForPubkey` all return metadata
only.

### `/token` — state via DAG replay

Each token is one Glon object with `typeKey: "chain.token"`. Two storage
conventions, neither novel for Glon:

- **Static metadata in fields**: `name`, `symbol`, `decimals`,
  `owner_pubkey`, `initial_supply`, `storage_credit` (reserved for v2 rent;
  always `"0"` in v1). Set once at deploy time via `FieldSet` ops in the
  genesis Change.
- **Operations as `CustomContent` blocks**: each op is one `BlockAdd`
  with `contentType: "chain.token.op"`. `meta` carries the op kind plus
  parameters plus the signer's pubkey hex. Block ids and DAG order are
  the canonical sequence.

State (balances, total_supply, allowances) is **derived** from `fields +
blocks` via `replayState`. Initial supply is credited to `owner_pubkey`
implicitly during replay. State is never stored — same model `/agent` uses
for conversation views and `/comment` uses for thread structure.

Six op kinds: `Mint`, `Transfer`, `Approve`, `TransferFrom`, `Burn`,
`RenounceMint`. All semantic invariants (only-owner mints, allowance
underflow, U128_MAX overflow, mint-after-renounce rejection) live in
`applyOpToState`, which throws on any violation. The validator runs it
against a clone of current state in try/catch; thrown errors become
`{valid: false, error}` returns.

`/token` exposes its rules via the `validate_op` actor action rather than
registering a top-level validator. `/consensus` is the sole registered
validator for `chain.token`, dispatching to `validate_op` after its own
checks pass.

### `/consensus` — validator pipeline

The kernel calls `/consensus`'s validator before disk-write. Pipeline per
chain-mode Change (after the kernel signature gate has fired):

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

asynchronous follow-up (via /consensus.check or future anchor pipeline):
  └─ dispatchProgram("/token", "validate_op", {tokenId, changeB64})
       └─ /token replays prior state, applies op to a clone, checks invariants
```

The split is necessary because Glon's registered-validator API is
synchronous and can't `await dispatchProgram`. The synchronous validator
catches all signature/nonce/fee violations in the kernel pipeline; semantic
violations (a Transfer with no balance, a Mint by a non-owner) are caught
by `/token.validate_op` either via explicit pre-flight (`/consensus.check`)
or by replay invariants that surface on read. v2 will fold the dispatch
into the validator API and remove the asynchrony gap.

Per-pubkey nonce store lives in `/consensus`'s actor state as
`nonces: Record<pubkey_hex, number>`. The synchronous validator reads from
a module-local mirror that the actor's `recordAccepted` action keeps in
sync; the mirror exists only because the synchronous validator can't take
a context. Tests reset the mirror via `__test.resetMirror()` between cases.

### What's deferred

- **`/anchor` program**: anchor blocks committing to a Merkle root over
  every chain-mode object's head. Once anchors land, finalized Changes
  carry global ordering and can survive reorgs. Anchor block format
  already includes `state_root` and `vdf_iterations_target` fields in the
  cleanroom spec; the placeholder implementation can sign anchors with a
  bootstrap key while PoST integration follows.
- **PoST cryptography**: [`chiapos`](https://github.com/Chia-Network/chiapos)
  for proof-of-space, [`chiavdf`](https://github.com/Chia-Network/chiavdf)
  for verifiable delay functions. Both libraries are C++ with Apache 2.0
  licenses; the integration plan is subprocess-only via the bundled CLI
  binaries (`ProofOfSpace`, `vdf_client`) — Node bindings would be a
  multi-week side quest the v1 spec deliberately avoids.
- **Reorg / fork choice**: requires anchor chain + cumulative-VDF-iterations
  comparison. Without anchors there's nothing to fork.
- **Adversarial sync hardening**: the existing pushChanges path is the
  signature gate's enforcement point, but real P2P sync (peer scoring,
  ban list, bounded buffer, eclipse defense) remains TBD; `src/programs/handlers/sync.ts`
  is currently a stub.
- **State rent / storage_credit accounting**: every full node stores all
  chain state forever in v1. The `storage_credit` field is reserved on
  every `chain.token` object (always `"0"` today) so the rent migration
  doesn't require a per-object schema change.

## Security Model

### Accounts & Authentication

Users authenticate with username/password, stored as bcrypt hashes.
Sessions use JWT tokens with configurable expiry.

```typescript
interface Account {
  id: string;              // UUID
  username: string;        // Unique identifier
  passwordHash: string;    // bcrypt hash
  role: "admin" | "user" | "guest";
  createdAt: number;       // Unix timestamp
  permissions: Permission[];
}
```

### Permissions

Object access is controlled by ownership and explicit permissions:

| Permission | Scope | Effect |
|---|---|---|
| `read` | Per-object | View object state and history |
| `write` | Per-object | Modify fields and content |
| `delete` | Per-object | Soft-delete the object |
| `admin` | Global | All operations on all objects |

Programs can only modify objects they created or have permission
to access. The store actor enforces permissions before mutations.

### Object Ownership

Every object tracks its owner (the account that created it):

```typescript
interface ObjectMetadata {
  ownerId: string;         // Account ID
  createdBy: string;       // Program that created it
  sharedWith: string[];    // Account IDs with access
}
```

## Garbage Collection

GC is a tool, not a policy. The `/gc` program provides protection,
link-based reachability, and collection. It has no opinions about
retention — programs decide what to protect by calling GC's actor
actions (`protect`, `unprotect`, `isRetained`, `getRetained`).

### Algorithm

1. **Roots:** explicitly protected object IDs (set by programs or users)
2. **Reachability:** BFS from roots following outbound links in the
   object graph — everything reachable from a root is retained
3. **Collect:** delete objects that are neither roots nor reachable

```
/gc protect <id>     # mark as root (transitive via links)
/gc unprotect <id>   # remove root
/gc run [--dry-run]  # collect unreachable objects
/gc status           # show roots and reachability
```

## Data Flow

**Write:** Shell → Object Actor → create Change → write .pb to disk
→ reload vars from DAG → broadcast event → Store indexes in SQLite

**Read:** Shell → Store → Object Actor (vars, computed from disk)
or SQLite (list queries)

**Wake:** Actor wakes → `createVars` runs → reads all changes from
disk for this object → replays DAG → vars populated → ready

**Sync:** Actor A.getAllChangeIds() → Actor B.getAllChangeIds() →
set difference → exchange missing changes → both reload vars

## Extensibility

Programs express complex state without modifying `glon.proto`:

### Recursive Values

`Value` is recursive. `ValueMap` and `ValueList` contain `Value`s,
so programs can express arbitrarily nested structures using only
`FieldSet` operations:

```
Value {
  oneof kind {
    string     string_value  = 1;
    int64      int_value     = 2;
    double     float_value   = 3;
    bool       bool_value    = 4;
    bytes      bytes_value   = 5;
    StringList list_value    = 6;
    ValueMap   map_value     = 7;   // nested key-value
    ValueList  values_value  = 8;   // heterogeneous typed list
  }
}
```

glon never interprets these structures. The DAG replay code does
`state.fields.set(key, value)` — it doesn't look inside the Value.
Programs define their own conventions on top of the typed primitives.

### Custom Block Content

`BlockContent` has an escape hatch for program-defined block types:

```
CustomContent {
  string content_type          = 1;  // e.g. "image", "table", "embed"
  bytes  data                  = 2;  // program-encoded payload
  map<string, string> meta     = 3;  // fallback display metadata
}
```

glon stores, content-addresses, syncs, and replays custom blocks
through the standard Change DAG. Peers that don't understand a
`CustomContent` block fall back to displaying the `meta` map.

### Discussion convention: `message` and `reaction` blocks

Glon doesn't have a built-in comment type. Instead, two `CustomContent`
content_type values "message" and "reaction" carry a discussion-on-any-object
convention that the `/comment` program implements and any other program can
host. The convention pins per-message metadata onto the message itself
(rather than the parent object's field map), which keeps each post atomic
across sync, deletion, and rendering.

**`message` block**

```
CustomContent {
  content_type: "message"
  data: <unused>
  meta: {
    text: <required, the message body>,
    creator?: <object_id of the peer/agent who posted>,
    reply_to?: <block_id of the parent message, for threading>,
    attachments?: <JSON-encoded [{object_id, kind}, ...]>,
    created_at?: <epoch ms as string>
  }
}
```

**`reaction` block**

```
CustomContent {
  content_type: "reaction"
  meta: {
    target: <required, block_id of the message being reacted to>,
    emoji: <required>,
    creator?: <object_id of the reactor>,
    created_at?: <epoch ms as string>
  }
}
```

Reactions live as siblings of the message they target rather than children
of it; the relationship is logical (`meta.target`), not structural. Removing
a reaction is `removeBlock(reaction_block_id)`. Threading is logical too:
replies are sibling messages with `meta.reply_to` pointing at the parent.
/comment's `thread` action walks the implied DAG.

Programs that want comments on their own object types just dispatch
`/comment.post` (and friends) at any object id. `/chat` is the canonical
consumer; future programs (per-milestone notes, per-reminder annotations,
per-peer threads) reuse the same primitive without introducing new types.


### Why Not Program-Defined Protobufs?

**Custom Operations (programs bring their own reducers):** glon
would need each program's code to replay the DAG. A peer without
the program couldn't compute state. Breaks "any peer can recompute
from changes alone."

**Custom Value schemas (opaque bytes with type URLs):** glon
could carry but not inspect the data. Loses field indexing, value
queries, and state diffing.

Recursive Value avoids both traps: glon always replays the DAG
(Operations are unchanged), always inspects values (typed all the
way down), and programs compose arbitrary structures from a fixed
set of primitives. `glon.proto` is stable.
