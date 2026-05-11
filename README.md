# glon
A distributed object environment where every mutation is a content-addressed protobuf message in a DAG, every object is a durable actor, and every program — including the ones running the shell — is itself an object you can replay, sync, and inspect.

> **Sister repo:** [glonAstrolabe](https://github.com/Geep5/glonAstrolabe) — a live 3D dashboard that reads the DAG directly and visualizes objects, agents, coins, and changes in real time.


There is no folder hierarchy and no central database. Objects are typed, link to each other, and live in a flat graph. State is never written; it is *computed* by replaying changes from genesis to heads.

## The big idea, in one breath

Take Git's content-addressed history, give each object its own durable actor (Rivet) with a sync inbox, replace files-and-folders with typed objects-and-links, and let programs be just another kind of object that happens to define a handler, an actor, and a validator. You end up with a substrate where a tic-tac-toe game, an LLM agent's conversation, a Discord bridge, a UTXO ledger, and the runtime that loads them are all the same kind of thing.

## The kernel — five primitives

**1. Objects, not files.** Each entity is a typed object identified by a UUID with a `type_key` (`agent`, `peer`, `chain.coin.bucket`, `program`, …). Structure emerges from `ObjectLink` field values, not from where something is "placed."

**2. Changes, not state.** Every mutation is a `Change` protobuf — a list of `Operation`s (`ObjectCreate`, `ObjectDelete`, `FieldSet`, `FieldDelete`, `BlockAdd/Remove/Update/Move`) — whose id is `SHA-256` of its canonical bytes with id zeroed. Parents form the DAG; multiple parents are merges of concurrent edits. The `.pb` file on disk *is* the change; nothing supersedes it.

**3. Actors, not databases.** Three actor kinds live in `src/index.ts`: `objectActor` (one per object, holds the inbox/outbox and serves sync), `storeActor` (singleton coordinator with a SQLite index that's a pure cache — delete it and it rebuilds from disk), and `programActor` (one per running program, owns its persistent state and tick loop).

**4. Programs are objects, dispatched by type.** Programs live in the DAG as type=`program` objects with a `manifest` ValueMap of filenames → source. `src/programs/runtime.ts` esbuild-compiles them at load time and starts their actors. The shell has zero built-ins — even `/help` is loaded from the store. Programs register their type-specific behavior at module load: index hooks via `registerIndexHook(typeKeys, fn)`, change-level auth verifiers via `registerAuthVerifier(authType, fn)`, validators via `registerValidator(typeKeys, fn)`. The kernel dispatches by `type_key` and never imports a specific handler — adding `/coin` doesn't require editing `src/index.ts`.

**5. Self-hosted.** Bootstrap walks `src/`, `proto/`, and `scripts/`, hashes every file, and creates or updates the corresponding objects in the store. The proto, the kernel, the runtime, every handler — all queryable as Glon objects. You can ask the system for the code that built it, and the manifest is the filesystem rather than a parallel registry.

## The protocol (proto/glon.proto)

Three layers, deliberately separated:

| Layer | Messages | Role |
|-------|----------|------|
| Change DAG | `Change`, `Operation`, `ObjectCreate/Delete`, `FieldSet/Delete`, `Block*`, `AuthExtension` | Source of truth. Immutable, content-addressed. |
| Sync | `Envelope` wrapping `HeadAdvertise`, `HeadRequest`, `ChangePush`, `ChangeRequest`, `ObjectSubscribe`, `ObjectEvent`, `AppMessage` | Pull-based DAG exchange between actors. Typed, no JSON-on-the-wire. |
| Transport | `TransportEnvelope` wrapping `ChangeBundle`, `TextMessage`, or custom payloads | Cross-DAG delivery. Fail-fast, identity-in-signatures, transport-agnostic. |
| Computed State | `ObjectSnapshot`, `ObjectRef`, `Block`, `Value` (recursive `ValueMap`/`ValueList`/`ObjectLink`) | Derived from replay. `ObjectSnapshot` can be embedded in a Change as a replay-skip checkpoint, never as truth. |

Values are recursive and typed at the protobuf level — string/int/float/bool/bytes/list/map/`ObjectLink` — so a browser can store cookie jars as nested maps and a spreadsheet can store cell metadata as typed lists without anyone touching `glon.proto`.

A `Change` carries one optional auth field: `auth_extension`, a generic `{type: string, payload: bytes}` shape. The kernel looks up a registered `AuthVerifierFn` by `type` and verifies the payload against the change's canonical bytes before any program validator sees the change. The chain layer registers `"ed25519"`; payment programs register their own (e.g. `"x402"`). The kernel itself knows nothing about either.

There is no separate `ContentSet` op for raw byte content. An object that wants a primary blob — a source file, an image, a binary — stores it in a designated block with id `__content__` whose `CustomContent` carries the bytes. `getPrimaryContent(blocks)` extracts it. One concept (blocks) instead of two (blocks + content).

## What lives on top — the application layer

Every directory under `src/programs/handlers/` is a hot-loadable program. They all use the same `ProgramDef` shape: an optional `handler` (CLI), optional `actor` (persistent state + actions + tick), and optional `validator` (gates synced changes for given `validatedTypes`).

Actor actions can be declared as `typedActions: Record<string, ActionDef>`, where each `ActionDef` carries a description, an `inputSchema` (JSON Schema), and a handler taking `(ctx, input)`. The runtime validates inputs against the schema at dispatch time. The `/agent` program walks any registered program's typed actions and auto-generates tool descriptions for the LLM — wiring a new program as an agent tool is zero code on the agent side.

There are roughly four families of programs in this repo:

**Object plumbing.** `crud` (create/list/get/set/delete), `inspect` (DAG history, change details, sync state), `graph` (link traversal, BFS), `ipc` (inter-object messaging), `gc` (retention policies), `sync` (mDNS + HTTP P2P sync — service name `_glon._tcp.local`), `help`.

**Generic apps.** `ttt` (tic-tac-toe where every move is a content-addressed change), `comment` (threaded discussions), `chat` (thin alias on top of `comment`, with legacy block fallback for the pre-migration history), `todo`, `remind` (scheduled actions), `peer` (people and agents — display name, kind, trust level, contact handles, identity pubkey, endpoints, preferred transport).

**Agent stack.** This is the bulk of the code:

- `agent` — an LLM agent as a regular object. Every user prompt, assistant reply, tool_use, tool_result, and `compaction_summary` is a content-addressed Block. Tools dispatch into other programs via `ctx.dispatchProgram(prefix, action, args)` or `ctx.dispatchTypedAction(prefix, action, input)`. ReAct loop with auto-compaction at `contextWindow - reserveTokens`, walking back to the first user boundary that fits the kept-region budget. Subagents are real `agent` objects with a `spawn_parent` link; the parent's DAG records a single tool_use/tool_result whose payload is the compressed batch result. **Multi-provider LLM with auto-selection:** the agent's `model` field is a hint, not a hard requirement — `agent-llm.ts` keeps a `PROVIDERS` registry (currently Anthropic Claude + Moonshot Kimi, extensible in one place) and resolves each request through `pickProvider()`. If the model's native provider has credentials (env var or `~/.glon/auth.json`), the request goes through unchanged. If not, the agent transparently falls back to the first provider that does have credentials, using its default model, and logs the swap. Query `/agent providers` for a status survey (which provider, env-var-set, auth-path, default-model) or `/agent whichProvider <model>` to see what would happen for a given model without making a network call.
- `holdfast` — the generic harness. Configure once with `--name <agent>` and `--principal-<...>`, get back an agent wired with identity-aware ingest (every inbound message tagged `[from {name} on {source}, trust={level}]`), a peer directory, durable memory, scheduled reminders, shell access, and subagent spawning. Holds only a cache of `{agentId, agentName, principalPeerId}`; truth lives in the DAG.
- `memory` — durable `pinned_fact` and `milestone` objects with `owner` links back to the agent and `sourced_from_blocks` references. Survives compaction because they're independent objects with their own DAGs.
- `task` — thin CLI wrapper around `/agent.spawn` for batch subagent runs.
- `auth` — Anthropic OAuth (Claude Pro/Max impersonating the official `claude` CLI) and API-key fallback. Credentials live in `~/.glon/auth.json`, mode 0600, never synced to peers.

**I/O bridges.** `discord` (Gateway WS for presence + 3-second REST poll for DMs, routes inbound to `/holdfast.ingest`), `google` (cheatsheet for the `gws` CLI), `browser` (cheatsheet for a local Skyvern instance on :8000), `web` (curl/jq/pandoc recipes), `shell` (persistent bash sessions an agent can drive), `anytype` (local Anytype REST API), `user-chat` (generic "tell the user something" surface — fans out to `ctx.emit`, optional Discord channel/DM, and daemon logs so programs don't have to bake in a specific chat surface).

**Transport layer.** Cross-DAG communication is transport-agnostic. Any program that implements `send` and `inbox_drain` typed actions can move `TransportEnvelope` bytes:

- `transport-file` — writes raw protobuf envelopes to `.glonenv` files. Address format: `file:///path/to/inbox`. Used for local testing.
- `transport-discord` — sends payloads as Discord DMs via the existing `/discord` program. Address format: `discord://<user_id>`.
- `transport-http` — POSTs JSON envelopes to a remote endpoint. Address format: `https://host:port/path`.
- `transport-gmail` — sends and receives envelopes via Gmail using the local `gcloud` CLI's OAuth token (no separate OAuth app to register). Address format: `gmail://<email-address>`. Kept in the codebase for occasional use (e.g. inviting non-Glon friends), but no longer load-bearing for trades after the Hyperswarm migration.
- `transport-hyperswarm` — sends and receives envelopes over **Hyperswarm**, the peer-to-peer networking stack from Holepunch. The daemon owns one Hyperswarm instance (bring up with `GLON_SWARM=1` in env); the `transport-hyperswarm` program is a thin wrapper that calls into the daemon-level `swarm-host` module. Address format: `swarm://<64-hex-hyperswarm-pubkey>`. Connections are end-to-end Noise-encrypted; framing is a 4-byte BE length prefix per envelope. Two peers find each other through the public **directory topic** (`sha256("glon:network:v1")`) or through any **pair topic** they both know (`sha256("glon:pair:v1:" + sorted_concat(pubkeys))`). Used by `/directory` for peer presence + handshake and by `/trade` for the actual swap traffic.
- `transport-router` — polls every registered transport's `inbox_drain`, dispatches by `content_type` through a content-handler registry (`registerContentHandler` in `runtime.ts`). Built-in handlers: `glon/change-bundle` (imports each Change via `objectActor.pushChanges`), `glon/text` (logs to stdout). The handler signature includes `blobMeta.fromEndpoint` so content handlers can authenticate by the address the blob arrived from.

**Chain layer.** A small Chia-style proof-of-spacetime blockchain runs on top of the same kernel:

- `wallet` — local Ed25519 keys, never on the DAG. Receives an unsigned `Change`, fills in the signature payload, returns it content-addressed.
- `consensus` — validator gate for chain-mode types. Per-pubkey monotonic nonce, asymmetric fee floors (deploy 100×, mint 10×, other 1×), dispatches type-specific semantic checks to the owning program through its declared typed actions.
- `coin` — UTXO-based fungible tokens. `chain.token` holds metadata; `chain.coin.bucket` objects hold up to 1000 coins each as `BlockAdd` ops. Atomic swaps via `chain.coin.offer` objects with two-pass replay so `settle` can land before its `escrow`/`pay`. Registers an `IndexHookFn` for `chain.coin.bucket` so the kernel maintains the SQL coin index without importing anything from this file. Cross-DAG sends package spend+create changes into a `ChangeBundle` dispatched through the transport layer.
- `coin-x402` — pure helpers for x402 payment authorization (canonical encoding, signature verification). Used by `coin.ts` for offer settlement; could be picked up by other programs that want the same payment shape.
- `anchor` — global ordering and Merkle state commitment over chain-mode head ids. Longest-chain fork choice with timestamp tiebreak. Inflation rewards in FIG (5 FIG base, halving every 1000 anchors) paid to anchor creators. Each anchor change carries `state_root` (Merkle root of chain head ids), `prev_anchor_id` (parent anchor for linear ordering), and optional `pospace_proof` (hex proof bytes for future PoSpace integration).
- `plot` — real Proof of Space via shelling out to `chiapos` (Chia's plotter), default `k=25` (~600 MB) for testing, `k=32` (~101 GB) for mainnet-equivalent.
- `timelord` — real Proof of Time via `chiavdf` (Wesolowski VDFs, class groups of unknown order, 1024-bit discriminant), default 5M iterations.
- `trade` — drives a full atomic swap end-to-end over **Hyperswarm**. User says "trade 5 FIG for 10 GOOTECK with bob" in any chat surface; the program resolves bob via `/peer` (must be `trust_level: "trusted"` — see `/directory`), builds and escrows the offer locally, exports the changes as a `ChangeBundle`, sends them via `/transport-hyperswarm` with `content_type=glon/swap-offer` to bob's hyperswarm pubkey. The receiver's flow is symmetric: incoming `glon/swap-offer` from an untrusted swarm pubkey is dropped silently; from a trusted peer it surfaces to the human via `/user-chat`, `/trade accept <id>` pays + settles + claims and replies with `glon/swap-response`, `/trade decline <id>` (or the 5-min approval-deadline expiring) replies with `glon/swap-decline`. Originator timeout default 30 min with cancel-return on expiry; receiver-approval default 5 min — both env-overridable. Per-swap state lives in the program object's `persisted_state` field and survives daemon restarts. *(This replaces the earlier `/swap-email` program, which was removed in v1 of the Hyperswarm peering work; see `docs/hyperswarm-peering.md`.)*
- `directory` — Hyperswarm peer presence + first-contact handshake. On daemon start with `GLON_SWARM=1`, joins a well-known directory topic and broadcasts a signed `glon/peer-announce` every 60s. Other Glons' announces upsert into local `/peer` as `trust_level: "discovered"`. When the user clicks "peer with" (UI button in Astrolabe's Network panel, or `/directory peer <pubkey>` in chat), this program sends a `glon/peer-request` unicast to that peer; the receiver surfaces "Alice wants to peer, accept?" via `/user-chat`. On accept both sides flip the `/peer` record to `trust_level: "trusted"`. After that, `/trade` traffic between them flows over the persistent pair-topic connection.

The chain layer is genuinely separate from the object/agent kernel — it just rides the same `Change` DAG, registers an Ed25519 verifier with the kernel for `auth_extension.type = "ed25519"`, and uses `consensus.validate()` to gate which changes survive before the kernel writes them to disk.

## Stack

- **Language.** TypeScript, ESM. ~99.8% of the repo by line count.
- **Runtime.** Node 20+ via `tsx` (no build step in dev). Uses `node:sqlite` for the store index and `node:dgram` for mDNS.
- **Actors.** `rivetkit` 2.x. `objectActor` and `storeActor` are defined in `src/index.ts`; `programActor` is dynamically materialized per program by `runtime.ts`.
- **Wire format.** `protobufjs`. Schema in `proto/glon.proto`. Canonical encoding for signing lives in `src/det/canonical.ts`.
- **Crypto.** SHA-256 for content addressing (`src/crypto.ts`); Ed25519 for chain signatures (`src/det/ed25519.ts`); `randomBytes` for nonces. Transport envelopes carry a `sender_pubkey` hint, but trust is in the Ed25519 signatures on each individual Change.
- **Determinism.** `src/det/` carries the bits the chain layer needs to be reproducible across machines: canonical proto encoding, signing, big-int math (`U64_MAX`, `U128_MAX`, bounded add, checked sub).
- **Bundler.** `esbuild`, used at runtime to compile programs out of the DAG.
- **Optional native binaries.** `chiapos` and `chiavdf` under `~/.glon/bin/` if you want real PoSpace/PoT. Optional Skyvern at `127.0.0.1:8000` if agents need a real browser.
- **Other deps.** `nostr-tools` is in `package.json` (presumably for an identity/event-bridge experiment, no handler imports it directly in this snapshot).

## Quick start

```bash
git clone https://github.com/Geep5/glon.git
cd glon && npm install
cp .env.example .env

# terminal 1 — actor host
npm run dev

# terminal 2 — first run only: seed source files + programs into the DAG
npm run bootstrap

# terminal 3 — interactive shell
npm run client
```

The dev server fails fast if port 6420 is taken; override with `GLON_PORT`. Clients auto-discover the chosen port via `~/.glon/.endpoint`.

For headless/automated use there's `scripts/daemon.ts`, which loads every program, runs their actors and tick loops, and exposes `POST /dispatch {prefix, action, args}` on `127.0.0.1:6430` so any external orchestrator can drive Glon without holding API keys. Run it with `--dev` to enable a file watcher: when a `src/programs/handlers/*.ts` file changes, the daemon re-bootstraps the affected program object (disk → DAG), stops its actor, recompiles from the updated source, and restarts. Without `--dev`, programs only update on explicit `npm run bootstrap` followed by a daemon restart.

The bootstrap is content-aware: it hashes each source file, compares against what's in the store, and prints `UNCHANGED` for no-op runs. Add `--force` to rewrite unconditionally if you've corrupted an object and want a clean reseed.

## Notable design choices, in case you forget why later

- **The kernel knows nothing about specific programs.** Type-specific behavior — replay-time indexing, change-level auth verification, validator semantics, primary-content semantics — is registered by programs at module load. The kernel dispatches by `type_key` strings. `src/index.ts` does not import a single thing from `src/programs/handlers/`. Add a new program, register a hook, and the kernel routes work to it without any kernel change.
- **Snapshots are never truth.** They live inside `Change` messages as a replay-skip optimization. The op DAG is canonical. This keeps full history recoverable even after aggressive checkpointing.
- **The SQLite index is a cache.** Delete `~/.glon/index.db` and the next wake rebuilds it from `.pb` files on disk. This is the property that makes "every wake reads disk" tolerable.
- **Programs run from the DAG, not from disk.** Editing a handler under `src/programs/handlers/` after bootstrap has *no effect* on the running daemon by default. To deploy a handler change in a non-dev process: `npm run bootstrap` (push new source into typescript objects), then restart the daemon. In `--dev` mode the watcher does both for you on save. Agent fields (system prompt, model, wired tools) are direct `object_set_field` writes — those take effect immediately regardless of mode.
- **The agent doesn't have a database; the DAG is the database.** Conversation history, tool calls, compaction summaries, memory facts, subagent transcripts — all the same kind of thing, all replayable, all syncable, all inspectable from another peer that was never given an API key.
- **Chain mode is opt-in per type.** Non-chain objects sync on a trust-the-peer basis. Chain-mode types route through `consensus.validate()` before the kernel writes anything to disk, with the relevant `AuthVerifierFn` (`"ed25519"` for the chain) verified by the kernel itself before any program validator sees the change.
- **Auth on a Change is one generic field, not a fixed list.** The kernel sees `auth_extension: {type, payload}` and dispatches by type. Adding a new auth flavor — passkey signatures, attestations, future payment standards — is a new program registering a verifier, not a proto change.
- **Local-only credentials.** Wallet keys (`~/.glon/wallet.json`) and Anthropic tokens (`~/.glon/auth.json`) are mode 0600, written atomically via `.tmp` + rename, and explicitly *never* part of the sync set. The chain knows you only by your raw pubkey.
- **Shared utilities, not copy-paste.** ANSI styling and typed value extraction (`getString`, `getInt`, `getLink`, …) live in `src/programs/shared.ts` and are imported by every handler. No more 30 copies of `const DIM = "\x1b[2m"` and no more `obj.fields.foo?.stringValue` ladders.

## Repo layout

```
proto/glon.proto              the protocol — single source of schema truth
src/
  proto.ts                    typed encode/decode wrappers around protobufjs
  crypto.ts                   SHA-256, hex, object-id generation
  disk.ts                     per-object .pb file storage + listing
  endpoint.ts                 port lockfile shared by every entry point
  env.ts                      side-effect .env loader
  index.ts                    objectActor / storeActor / programActor + Rivet registry
  bootstrap.ts                walks src/, proto/, scripts/; hashes files;
                              creates or updates the corresponding store objects
  client.ts                   the CLI shell (a pure program loader, no built-ins)
  dag/
    change.ts                 change construction + content-address hashing
    dag.ts                    topological sort, snapshot replay, head computation,
                              getPrimaryContent for the __content__ block
  det/                        determinism layer for the chain
    canonical.ts              canonical encoding for signing
    ed25519.ts                signing + verification
    math.ts                   bounded big-int arithmetic
  sync/                       mDNS discovery + peer types (the wire layer)
  programs/
    runtime.ts                module bundler, actor lifecycle, dispatch table,
                              registries (validator, indexHook, authVerifier)
    shared.ts                 ANSI styling + typed field extractors
    handlers/                 one file per program (~35, see Application Layer above)
scripts/                      operational tools (daemon, dispatch, dumps, repairs)
test/                         unit tests for kernel, agents, chain, programs, transports
docs/                         design notes (coin offers, transports, trading system)
```

## License

MIT.
