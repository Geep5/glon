# Hyperswarm Peering & Autobase Marketplace — Implementation Brief

## Context

Glon currently uses email to bootstrap and carry cross-DAG swap traffic via the `/swap-email` program (see `src/programs/handlers/swap-email.ts`). The email path works but locks the system into ~30-second polling latency, Gmail send quotas, metadata leakage to Google, and a UX that depends on remembering email addresses. We're replacing the *transport* and *first-contact* layers with **Hyperswarm** (the Holepunch P2P discovery library — `npm install hyperswarm`), keeping the rest of the swap protocol intact. Email is removed from the trade path entirely.

The new model is **hybrid public-directory + per-pair private topics**: every Glon joins one well-known directory topic on startup (to discover other Glons), then any two trusted peers move ongoing traffic to a private pair topic that only they can compute. Identity is cryptographic, not email-based. Connections are sub-second-latency, Noise-encrypted, persistent.

This brief is split into two parts:

- **v1 (this brief, ship now):** Hyperswarm-based peering + a renamed `/trade` orchestrator that replaces `/swap-email`. ~13 days of focused work.
- **v2 (sketch only, ship later):** An **Autobase**-based public marketplace / auction house, built on top of v1. ~2 weeks once v1 is stable.

This brief is the entire v1 spec plus a forward-looking sketch of v2 so the implementer keeps the right abstractions in mind from the start.

---

## v1 — Hyperswarm peering

### Goals

- **Sub-second cross-DAG message latency** between trusted peers (vs. the current ~30-second email floor).
- **Zero new infrastructure to run.** The only fixed coordination is the Hyperswarm DHT bootstrap node list (replaceable in config) and one well-known directory topic string. Nothing you have to host yourself.
- **Removable email from the trade path.** `/swap-email` and `transport-gmail`'s role in trades go away. `transport-gmail` the program stays in the codebase for unrelated uses (inviting non-Glon friends, etc.).
- **Honest decentralization.** No designated relay you run, no DNS server you depend on. Hyperswarm's DHT is a shared commons (Holepunch's bootstrap nodes + community participants), bypassable per-peer once you've exchanged keys.

### Important clarification: Hyperswarm ≠ Pear

The implementer should not confuse two things from the same org:

- **Pear** is a *runtime* for shipping P2P desktop/mobile apps (alternative to Electron). Glon is not switching to Pear.
- **Hyperswarm** is the *library* underneath that handles peer discovery and connections. It's an npm package that works inside any Node project. **This is what we're using.**

Glon stays as a Node daemon. We add Hyperswarm as a regular npm dependency.

### Scope

**In scope:**

- A `transport-hyperswarm` program — same shape as the existing `transport-*` programs (`send`, `inbox_drain` typed actions). Wraps a daemon-level Hyperswarm instance.
- A `/directory` program that maintains the local Glon's presence on a public directory topic and surfaces discovered peers.
- A peer-handshake flow: outgoing `glon/peer-request`, user approval via `/user-chat`, on accept both sides record each other as trusted and join the private pair topic.
- A `/trade` program (renamed from `/swap-email`) that drives swaps end-to-end over Hyperswarm. Reuses existing content handlers (`glon/swap-offer`, `glon/swap-response`, `glon/swap-decline`) and the existing `/coin` + `/swap` typed actions for the actual atomic settle.
- Astrolabe UI additions: discovered-peer list with online indicators, peer-request approval surface, trade dialog driven by `/peer` records instead of typed email addresses.
- Removal of `/swap-email`. Removal of `transport-gmail` from the trade path. `transport-gmail` the program *stays* in the codebase — just no longer load-bearing for trades.

**Out of scope (deliberately):**

- Switching Glon to the Pear runtime. Stay on Node.
- Replacing the chain layer, the DAG, validators, agent stack, or any I/O bridge other than the trade path.
- The Autobase marketplace — that's v2.
- Background object-level DAG sync (live `HeadAdvertise` / `HeadRequest` / `ChangePush` over pair connections). The existing `glon/change-bundle` content handler is enough for trades; full background sync is a separate piece of work.
- Multi-party auctions. v1 swaps remain bilateral; auctions are part of v2.

### Dependencies

- `hyperswarm` and transitive deps (`hyperdht`, `udx-native`, `noise-curve-ed`, `b4a`, etc.) installable as regular npm packages. **`udx-native` is a native module** — it will not bundle into a Glon program object. See "Bundler integration" below for the mitigation.
- The existing `/coin` offer create/accept/cancel/claim flow.
- The existing `/swap` `exportOffer` / `importOffer` typed actions.
- `/user-chat` for surfacing peer-request and trade prompts.
- The existing transport-router and content-handler registry (no changes needed).
- `/peer` extended with `pubkey`, `hyperswarm_pubkey`, `trust_level`, `last_seen` fields.

### The model in one paragraph

On startup, every Glon daemon joins the Hyperswarm DHT and `swarm.join(DIRECTORY_TOPIC)` on a hardcoded directory topic. Every 60 seconds it broadcasts a signed `glon/peer-announce` envelope containing its identity pubkey, agent name, and capabilities. Other Glons receive these announcements through the directory connection and upsert local `/peer` records with `trust_level: "discovered"`. When the user clicks "peer with X" in the UI, the local daemon sends a one-shot `glon/peer-request` over the directory connection to X's identity; X's daemon surfaces "Y wants to peer, accept?" via `/user-chat`. On accept, both sides flip the `/peer` record to `trust_level: "trusted"` and `swarm.join(pairTopicForBoth)`. From that moment on, all trade traffic between them flows over the persistent encrypted Hyperswarm connection at sub-second latency; the email path is unused.

### Architecture

```
   alice's daemon                              bob's daemon
   ───────────────                             ──────────────
   transport-hyperswarm  ◄── directory ──►     transport-hyperswarm
       │                  topic, 60s pings           │
       ▼                                             ▼
   /directory                                    /directory
       │                                             │
       │ ── user clicks "peer with bob" ──►          │
       │ ── glon/peer-request via dir ──►            │
       │                                             │
       │                            user approves ◄──┤
       │                            via /user-chat   │
       │                                             │
       │ ◄── glon/peer-accept via dir ────           │
       ▼                                             ▼
   joins pair-topic                              joins pair-topic
   hash("glon:pair:v1:" + sorted(pubA, pubB))    (same)
       │                                             │
       └─────── persistent Noise-encrypted ──────────┘
                  multiplexed duplex stream

   /trade ── glon/swap-offer ──►  /trade
          ◄── glon/swap-response /  glon/swap-decline

   /coin offer ... unchanged settle path
   /swap exportOffer / importOffer ... unchanged
```

### Concrete contracts

#### Topics

- **Directory topic:** `sha256("glon:network:v1")` (32 bytes). Hardcoded constant; env-overridable via `GLON_DIRECTORY_TOPIC`. Every Glon joins this on startup. Different communities can run forks by changing the version suffix.
- **Pair topic:** `sha256("glon:pair:v1:" + lex_sorted(pubkeyA) + ":" + lex_sorted(pubkeyB))`. Both parties can compute it deterministically once they know each other's pubkeys. Knowing the topic requires knowing both pubkeys, so a third party with only one cannot find the pair.
- Future-extensible: per-program topics (marketplace, chat, etc.) can be added later under `glon:<program>:v1` without disturbing this layout.

#### Identity model

Each Glon identity has **two keypairs**, stored together in the existing wallet object:

- **Ed25519 identity pubkey** — already exists. Signs `Change`s, signs envelopes. Continues to be the canonical "who is this peer" identifier.
- **Curve25519 / Noise keypair** — new. Used for Hyperswarm authentication and end-to-end encryption. Generated once at first daemon start; persisted in the wallet.

Don't try to derive one from the other; they have different algebraic structures and unifying them invites subtle security cracks. Two keys, side by side, different jobs.

The implementer can let Hyperswarm generate its own keypair (`new Hyperswarm({ keyPair: undefined })` uses an ephemeral one — *don't*) or pass an explicit `keyPair: { publicKey, secretKey }` derived from a stable seed in the wallet. Use the latter so identity survives restarts.

#### Directory announcement (`glon/peer-announce`)

Posted by every Glon to the directory topic every `DIRECTORY_ANNOUNCE_INTERVAL_S` (default 60s):

```ts
interface PeerAnnounce {
  identity_pubkey: string;      // hex ed25519 (signs Changes)
  hyperswarm_pubkey: string;    // hex curve25519 (network identity)
  agent_name: string;
  capabilities: string[];       // e.g. ["trade", "swap", "listings"]
  announced_at: number;         // ms epoch
  signature: string;            // hex ed25519 sig over the canonical encoding
}
```

Receivers store these as `/peer` records with `trust_level: "discovered"`. Records prune from the discovered set after `DIRECTORY_PRESENCE_TTL_S` (default 300s) without a refresh. Already-trusted peers are *not* affected by pruning — `trust_level: "trusted"` records persist regardless of presence.

#### Peer-request handshake

Three content types, all flowing over the directory topic (not via a pair topic — pair topics don't exist yet at this stage):

- **`glon/peer-request`** — sent by the initiator. Body: `{ requester_identity_pubkey, requester_hyperswarm_pubkey, requester_name, message?, signature }`. Receiver verifies signature, dispatches to `/directory`'s content handler.
- **`glon/peer-accept`** — sent by the receiver after user approval. Body: `{ acceptor_identity_pubkey, acceptor_hyperswarm_pubkey, signature }`. On receipt, both sides write the trusted `/peer` record and `swarm.join(pairTopic)`.
- **`glon/peer-decline`** — sent by the receiver if the user declines or times out. Body: `{ reason: "declined" | "approval_timeout", signature }`. Initiator updates UI; nothing else happens.

Approval timeout: `PEER_REQUEST_APPROVAL_TIMEOUT_S` (default 600s, 10 min). If the receiver's human doesn't respond in time, auto-decline. Use the same `tickWatcher` pattern as `/swap-email`.

#### `transport-hyperswarm` typed actions

Same shape as the existing transports:

```ts
typedActions: {
  send: {
    description: "Send a payload to a peer over Hyperswarm.",
    inputSchema: {
      type: "object",
      required: ["endpoint", "payload_b64", "content_type"],
      properties: {
        endpoint: { type: "string" },        // swarm://<hex_pubkey>
        payload_b64: { type: "string" },
        content_type: { type: "string" },
        metadata: { type: "object" },
      },
    },
    handler: async (ctx, input) => Promise<{ delivery_id: string }>;
  },
  inbox_drain: {
    description: "Drain queued envelopes received over Hyperswarm.",
    inputSchema: { type: "object", properties: {} },
    handler: async (ctx) => Promise<IncomingBlob[]>;
  },
  status: {
    description: "Show swarm connection state.",
    inputSchema: { type: "object", properties: {} },
    handler: async (ctx) => Promise<{ peers_connected: number; pair_topics_joined: number; directory_connected: boolean; last_sent_at: number }>;
  },
}
```

Internal behavior:

- A **daemon-level Hyperswarm instance** is created in `scripts/daemon.ts` and exposed to bundled programs via `globalThis.__GLON_HYPERSWARM` and/or as a runtime external (see "Bundler integration"). The `transport-hyperswarm` program grabs this handle in its `onCreate`.
- `send`: derive `pairTopic` from the local pubkey + the destination pubkey. Look up the cached duplex stream for that topic (open a multiplexed channel on the existing pair connection if needed). Write the envelope (length-prefixed protobuf-encoded `TransportEnvelope`). Resolve the promise with a delivery id derived from a local counter + peer pubkey.
- `inbox_drain`: returns and clears the in-memory queue populated by the swarm's `connection` event handler. Each entry is a parsed `TransportEnvelope` wrapped in an `IncomingBlob` with `from_endpoint: "swarm://<hex_pubkey>"`.
- Reconnect on disconnect: Hyperswarm handles this automatically when you stay joined on the topic. The transport doesn't queue in-flight messages — fail fast on send if the peer is offline, matching the existing transport contract. The caller (`/trade`) is responsible for retry/timeout.

Endpoint format: `swarm://<hex_pubkey>` where pubkey is the destination's **identity pubkey** (not hyperswarm pubkey). The transport resolves identity → hyperswarm pubkey + pair topic via `/peer`.

#### `/directory` typed actions

```ts
typedActions: {
  announce: { ... },          // Force a presence broadcast now
  listDiscovered: { ... },    // Return all peers with trust_level=discovered
  listOnline: { ... },        // Trusted peers + recently-announced
  requestPeering: {           // Send a glon/peer-request
    inputSchema: { ... pubkey ... },
  },
  acceptRequest: { ... },     // Called by user-chat after approval
  declineRequest: { ... },
  status: { ... },
}
```

`/directory` also runs a `tickWatcher` (every 60s by default) that:
- Broadcasts the local peer-announce.
- Prunes discovered peers past TTL.
- Fires auto-decline for pending peer-requests past their approval deadline.

#### `/trade` orchestrator

Renamed and rebuilt from `/swap-email`. CLI:

```
trade start <token-give> <amount> for <token-want> <amount> with <peer-id-or-name> [--timeout=<seconds>]
trade accept <swap-id>
trade decline <swap-id>
trade cancel <swap-id>
trade status [<swap-id>]
trade list
trade tick
```

`<peer-id-or-name>` resolves through `/peer`. The peer must exist with `trust_level: "trusted"` before `trade start` works; otherwise the CLI prints a clear error pointing the user to `/directory listDiscovered` and `/directory requestPeering`.

State machine and content handlers are **unchanged** from `/swap-email`:

- `glon/swap-offer`, `glon/swap-response`, `glon/swap-decline` content types stay.
- Persistence pattern (the `persisted_state` field on the program object) stays.
- **Timeouts shrink** because transport latency drops from minutes to milliseconds:
  - Originator timeout: 48 hours → **30 minutes** default. Env-overridable.
  - Receiver approval timeout: 20 minutes → **5 minutes** default. Env-overridable.
- Originator → receiver routing uses `transport-hyperswarm` (not `transport-gmail`).
- `/trade` doesn't know or care which transport is underneath — it dispatches by peer id, and the resolver picks the transport.

### Phases of work

Total: ~13 days of focused work. Sequence matters; later phases depend on earlier ones.

#### Phase 0 — Setup & spike (½ day)

- `npm install hyperswarm` in `glonFiggies`. Confirm `udx-native` compiles on macOS + Linux dev machines.
- Spike: a standalone Node script that runs two `Hyperswarm` instances in two processes, calls `swarm.join(sameTopic)`, and exchanges a ping. Verify connection establishes locally.
- Optional but valuable: run the same spike across two different networks (one machine on home WiFi, another tethered to phone) to confirm DHT-mediated NAT traversal works for your environment.

If Phase 0 fails (native build issues, NAT punch-through fails for your network), **stop and report** — the rest of the brief depends on Hyperswarm working in your environment. Don't try to ship around it.

#### Phase 1 — `transport-hyperswarm` (3 days)

- Daemon-level Hyperswarm instance created in `scripts/daemon.ts` with a persistent keypair stored in the wallet (or alongside it in `~/.glon/`).
- Expose the instance via `globalThis.__GLON_HYPERSWARM` for the bundled program to grab. Also add `"hyperswarm": HyperswarmInstance` to the runtime externals map in `src/programs/runtime.ts` so `import` resolution works for the bundled program. (See "Bundler integration" below.)
- Create `src/programs/handlers/transport-hyperswarm.ts` mirroring the structure of `transport-discord.ts` (`send`, `inbox_drain`, `status` typed actions; no CLI handler beyond a help screen).
- Connection cache: per-peer-pubkey duplex stream, opened on first send, reused thereafter, torn down on `connection close`.
- Test injection: `globalThis.__HYPERSWARM_FACTORY` for unit tests to substitute a mock swarm.
- Unit tests mirror `test/transport-gmail.test.ts`. Cover send / inbox_drain / reconnect / connection-cache invalidation.

#### Phase 2 — `/directory` program (2 days)

- New `src/programs/handlers/directory.ts`.
- On `onCreate`: `swarm.join(DIRECTORY_TOPIC)`, register the announce tick (`tickMs: 60_000`).
- On `tick`: broadcast `glon/peer-announce`; prune stale discovered peers.
- Register content handlers for `glon/peer-announce` and the three peer-request content types.
- CLI: `directory list`, `directory list --discovered`, `directory ping <peer>`, `directory status`.
- Unit tests: announcement broadcast, discovered-peer upsert, TTL pruning, peer-request inbound flow.

#### Phase 3 — Peer-request handshake (2 days)

- `glon/peer-request` / `glon/peer-accept` / `glon/peer-decline` content handlers.
- `/directory requestPeering` typed action: builds and sends a signed peer-request.
- On inbound `glon/peer-request`: surface via `/user-chat`, store pending state in `/directory`'s `persisted_state`.
- `/directory acceptRequest` / `declineRequest` typed actions: called from `/user-chat`'s reply path (or directly from a CLI command).
- On accept: both sides flip `/peer` record to `trusted`, join the pair topic. The transport's `send` for that peer now uses the persistent pair connection.
- Approval-deadline watcher: auto-decline after `PEER_REQUEST_APPROVAL_TIMEOUT_S`.
- Unit tests covering both the initiator and receiver side, including timeout.

#### Phase 4 — `/trade` orchestrator (3 days)

- Copy `src/programs/handlers/swap-email.ts` to `src/programs/handlers/trade.ts`.
- Strip all email-specific code: subject formatting, Gmail polling, anything referencing `gmail://`, the email-only timeouts.
- Replace transport calls: `dispatchProgram("/transport-gmail", "send", ...)` → `dispatchProgram("/transport-hyperswarm", "send", ...)`. Endpoint becomes `swarm://<peer_identity_pubkey>` resolved from `/peer`.
- Replace recipient-by-email with recipient-by-`peerId`. The CLI parser changes accordingly.
- Tighten timeouts to the new defaults (30 min originator, 5 min receiver).
- Rename test file to `test/trade.test.ts`. Update mocks accordingly.
- Acceptance: a swap initiated on one machine completes on a second machine via Hyperswarm, end to end, in under 10 seconds on a local network.

#### Phase 5 — Astrolabe UI (2 days)

- `glonAstrolabe/server`: new endpoints `GET /api/peers/discovered`, `POST /api/peers/:pubkey/request`, `POST /api/peers/:pubkey/accept`, `POST /api/peers/:pubkey/decline`. All proxy to the corresponding `/directory` typed actions via the existing `dispatchToDaemon` path.
- `glonAstrolabe/public`: a new "Network" panel showing online peers (trusted + discovered), with a "Peer with" button per discovered entry. Peer-request approvals surface in the existing user-chat panel since they already flow through `/user-chat`.
- Trade dialog (the one currently driven by typed email addresses) becomes a dropdown of trusted peers.

#### Phase 6 — Removal & docs (1 day)

- Delete `src/programs/handlers/swap-email.ts`. Delete `test/swap-email.test.ts`. Delete `test/transport-gmail-integration.test.ts` (the env-gated integration test) — keep `test/transport-gmail.test.ts` since the transport program itself stays.
- Remove all references to `swap-email` from `README.md`. Add a new section describing the Hyperswarm-based trade flow.
- Update the project memory file (`~/.claude/projects/.../memory/project_glonfiggies.md`) to reflect the new architecture.
- Bootstrap (`npm run bootstrap`) to push the renamed/new programs into the DAG store.

### Design decisions worth flagging

- **Two keypairs, not one.** Ed25519 for signing Changes; Curve25519 (Noise) for Hyperswarm. Both stored in the wallet, side by side. Don't try to unify.
- **Default directory topic is hardcoded.** `sha256("glon:network:v1")`. Env override allows forks. v1 has no spam mitigation beyond user-vetted peer requests — the network is small enough that this is fine. Document the limitation.
- **Pair topics are computable by both parties only.** Knowledge of both pubkeys = ability to compute the topic. Third parties with one pubkey can't find the pair.
- **`transport-gmail` stays in the codebase** but is no longer load-bearing for trade. Future use: invite-by-email for users not yet on Glon (out of scope for this brief).
- **Connection persistence model:** Hyperswarm streams are duplex and persistent for as long as both peers stay joined on the topic. The transport caches per-peer stream handles. On disconnect, the next `send` reopens. In-flight messages are not queued — fail-fast contract, same as existing transports.
- **No incremental DAG sync in this brief.** Existing `glon/change-bundle` content handler already imports bundles when they arrive. Live `HeadAdvertise` / `HeadRequest` / `ChangePush` over the pair connection is a separate, larger piece of work and explicitly out of scope.

### Bundler integration (important risk + mitigation)

Glon's runtime bundles programs from the DAG via esbuild (see `src/programs/runtime.ts`). External modules are made available via the `externals` map at bundle-eval time. Currently the externals are: `proto.js`, `crypto.js`, `det/*`, `shared.js`, `runtime.js`, plus node built-ins via the `node:` prefix.

`hyperswarm` and its transitive deps **cannot be bundled** because `udx-native` is a native (.node) module. The bundled program code must access the swarm via an external.

The mitigation: in `scripts/daemon.ts`, after creating the Hyperswarm instance, add `"hyperswarm"` (and any helper exports the program needs) to the externals map. The bundled `transport-hyperswarm.ts` then does `import Hyperswarm from "hyperswarm"` and the runtime resolves it to the daemon-level instance.

If the externals-map approach turns out to be fragile (e.g., bundling complains about discovering the import), **Plan B** is to expose the swarm only via `globalThis.__GLON_HYPERSWARM` and have the program grab it inside its `onCreate`. This is uglier but always works.

### Configuration defaults

| Variable | Default | Notes |
|---|---|---|
| `GLON_DIRECTORY_TOPIC` | `sha256("glon:network:v1")` | Override to fork the network. |
| `DIRECTORY_ANNOUNCE_INTERVAL_S` | 60 | How often to broadcast presence. |
| `DIRECTORY_PRESENCE_TTL_S` | 300 | When to prune a stale discovered peer. |
| `PEER_REQUEST_APPROVAL_TIMEOUT_S` | 600 | Receiver-side approval window. |
| `TRADE_ORIGINATOR_TIMEOUT_S` | 1800 (30 min) | Was 48h in swap-email; tightened. |
| `TRADE_RECEIVER_APPROVAL_TIMEOUT_S` | 300 (5 min) | Was 20 min; tightened. |
| `HYPERSWARM_BOOTSTRAP` | (Hyperswarm default) | Comma-separated bootstrap node addresses. Override to self-host. |
| `HYPERSWARM_KEYPAIR_SEED_FILE` | `~/.glon/hyperswarm.key` | Where the Noise keypair is persisted. |

### Risks & open questions

- **Native module compilation.** `udx-native` requires a build toolchain. Document the prerequisites for first-time setup; consider providing pre-built binaries.
- **NAT traversal failures.** Some symmetric NATs can't be punched through. Hyperswarm falls back to DHT-relayed connections — works but slower and metadata-visible to relays. Acceptable v1 behavior.
- **Spam / sybil on the directory.** No rate-limiting in v1. Tolerable while the network is small. Mitigations exist (proof-of-work on announce, friend-of-friend filtering) and can be layered in later without changing the protocol.
- **Existing in-progress swap-email state.** Any swap mid-flight when this lands will time out and cancel. Acceptable since current trade volume is tiny.
- **Bootstrap node availability.** Hyperswarm depends on at least one reachable bootstrap node to enter the DHT. If Holepunch's default bootstrap nodes are blocked in some region, peers there can't join the network. Document the env-var to override.

### Migration & removal

- `/swap-email`'s `persisted_state` is not preserved — any in-flight email-based swap is lost on upgrade. This is fine; the alternative is a migration layer that's not worth building.
- The old `swap-email` CLI commands disappear. Update any tooling/scripts that referenced them.

### What stays untouched

- The kernel, the DAG, the `Change` proto, the validator framework.
- `/coin`, `/swap`, `/wallet`, `/consensus`, `/anchor`.
- `/agent`, `/holdfast`, the multi-provider LLM router.
- All transports except the trade-path usage of `transport-gmail`.
- The Astrolabe live event log, inspector, clock face, mining toggle, planet renders.
- The peer/identity infrastructure (just extended, not replaced).

### Definition of done

- A second Glon instance on a different machine can be discovered through the directory topic without any out-of-band exchange.
- One-tap peer request prompts the other side via `/user-chat`; both sides automatically establish a persistent encrypted pair connection on accept.
- `trade start <terms> with <peer>` initiates a swap that completes end-to-end over Hyperswarm with sub-second message latency in the happy path.
- `swap-email` is removed from the codebase; no remaining references in code, tests, or README.
- The README accurately describes the new trade model and the new decentralization story.
- All existing tests still pass. New tests cover transport-hyperswarm, directory announce/discover, peer-request flow, and end-to-end trade.

---

## v2 — Autobase marketplace (sketch only)

**Not in v1 scope. Documented here so v1 architectural decisions don't accidentally block this.**

### Why Autobase

The "global classifieds / auction house" idea (see prior design discussion in `docs/trading-system-plan.md`) needs a **shared, persistent, multi-writer data structure** — somewhere that every Glon can post listings and every Glon can read all listings, with no central server. That's exactly what [Autobase](https://github.com/holepunchto/autobase) is: a virtual append-only log assembled from multiple per-author Hypercores, merged by all readers using the same view function.

Without Autobase, the alternatives are all worse:
- **Per-peer broadcasts** (the swap-email approach): O(n²) message volume, hard to discover late.
- **A designated relay**: centralized, defeats the decentralization claim.
- **DHT-based listing lookup**: complex, sparse, eventual consistency without ordering.

Autobase gives you, basically for free:
- Every Glon writes its listings to its own Hypercore.
- A single "marketplace autobase" merges all writers' cores into one ordered view.
- Anyone reading sees every listing ever posted, in causal order, with full author attribution (signed by each writer).
- No relay. No designated coordinator. The autobase **is** the marketplace.

### The data structure

```
                    ┌─────────────────────────────┐
                    │ marketplace autobase        │
                    │ (logical view, computed     │
                    │  by every reader)           │
                    └─────────────────────────────┘
                            ▲   ▲   ▲
                            │   │   │
       ┌────────────────────┘   │   └────────────────────┐
       │                        │                        │
  ┌─────────┐              ┌─────────┐              ┌─────────┐
  │alice's  │              │ bob's   │              │ carol's │
  │hypercore│              │hypercore│              │hypercore│
  │(writes  │              │(writes  │              │(writes  │
  │ her own │              │ his own │              │ her own │
  │ listings│              │ listings│              │ listings│
  └─────────┘              └─────────┘              └─────────┘
       ▲                        ▲                        ▲
       │ replicates over the Hyperswarm pair connections │
       │ established in v1, plus a dedicated marketplace │
       │ topic where every Glon meets every Glon         │
       └──────────────────────────────────────────────────┘
```

### How it composes with v1

v1 gives you all the substrate v2 needs:

- **Hyperswarm transport** for replicating hypercores between peers. Already in `transport-hyperswarm`.
- **Identity pubkeys** as writer identifiers. Already in `/peer`.
- **Signed envelopes** as the integrity model. Already used everywhere.
- **`/user-chat`** for surfacing "incoming listing" or "your auction got a bid" prompts. Already exists.

v2 adds three things:

1. A **marketplace autobase** — every Glon has a local writer hypercore that it appends listings to, plus a local copy of every known writer's hypercore. The autobase's `apply` function reduces all of them into a queryable view.
2. A **marketplace discovery topic** — `sha256("glon:marketplace:v1")` — that every Glon listening to marketplaces joins. Used to discover new writers and replicate their hypercores.
3. A **`/market` program** — owns the local autobase, exposes typed actions like `postListing`, `findListings`, `placeBid`, `closeAuction`. Renders the local marketplace state in the Astrolabe UI.

### Concrete contracts (sketch only — not implementation-ready)

#### Listing entry shape

Appended by each writer to their own hypercore:

```ts
interface ListingEntry {
  kind: "listing-create" | "listing-update" | "listing-cancel" | "listing-bid" | "listing-close";
  listing_id: string;          // 16-hex random for create; matches existing for updates
  // For create:
  sells?: { token_id, amount };
  wants?: { token_id, min_amount, max_amount? };
  format?: "fixed-price" | "sealed-bid";
  expires_at?: number;
  // For bid:
  bid_amount?: string;
  encrypted_bid?: string;      // for sealed-bid, encrypted to seller's pubkey
  // For close:
  winner_pubkey?: string;
  winning_bid?: string;
  created_at: number;
}
```

The autobase's `apply` function:
- Folds listings into a current-state map keyed by `listing_id`.
- Enforces "only the original seller can update/cancel/close their listings" by checking writer identity.
- Surfaces newly-discovered active listings to the local UI.

#### Settlement

When a listing closes (fixed-price claim accepted, or sealed-bid auction expires), the seller initiates an existing v1 trade with the winner. **The marketplace doesn't do settlement.** It announces winners; settlement is the v1 atomic-swap protocol. This keeps the marketplace's responsibilities small and its trust assumptions clear.

#### Discovery

When a new Glon joins the marketplace topic, the existing writers send their hypercore keys; the new joiner replicates them and computes its local view. From that point on, normal Hypercore replication keeps everyone in sync. Late joiners get the full history from anyone who has it; no central archive needed.

### Why this is the right next layer

- **It's exactly the data structure the auction-house concept needs.** Every workaround we considered for v1 (forwarding, hub addresses, periodic broadcasts) is a thing you wouldn't have to do if you had Autobase. So once v1 ships, we just stop working around the missing primitive.
- **It composes cleanly with v1.** Same identity model, same transport, same UI surfaces. The seam is small.
- **It's the technically-correct decentralized answer.** No one runs the marketplace; the marketplace is the participants. This is the kind of "decentralized" that holds up to scrutiny.

### Estimated scope

~2 weeks once v1 is stable. Roughly:

- 2 days: marketplace topic + writer hypercore + initial autobase wiring
- 3 days: `/market` program + content handlers + listing CRUD
- 2 days: sealed-bid auction state machine + settlement bridge to v1
- 2 days: Astrolabe UI (listings panel, bid surface, "your auction got a bid" notifications)
- 2 days: tests + migration + docs

### What v1 should NOT do that would block v2

Two small forward-compatibility notes for the v1 implementer:

1. **Keep `/trade` transport-agnostic.** Don't bake `transport-hyperswarm` into it; route via `/peer`'s `transport_preference` field so v2 can introduce additional flows (e.g., trade-from-listing) without modifying `/trade`'s internals.
2. **Don't squat on `glon:marketplace:*` topic strings.** v2 will use `glon:marketplace:v1`; v1 should stay confined to `glon:network:v1` and `glon:pair:v1:*`.

That's it. Everything else in v1 is independent of v2.

---

## Notes for the worker

- **Read [`docs/cross-dag-swap-protocol.md`](cross-dag-swap-protocol.md)** before starting. The atomic-swap mechanics it describes are what `/trade` orchestrates; if you understand the swap, you understand most of the trade program's job.
- **Read the existing [`swap-email.ts`](../src/programs/handlers/swap-email.ts)**, **swap-email tests**, **and the brief that produced it** (which lives in the Git history of `docs/trading-system-plan.md` or thereabouts). `/trade` is mostly a rename + transport swap; don't rewrite the state machine from scratch.
- **Don't switch Glon to the Pear runtime.** That's a separate, much larger project. We're using Hyperswarm as a library, period.
- **The `udx-native` build is the single biggest unknown.** If it fails in your dev env in Phase 0, stop and report rather than trying to work around it. Glon's whole architecture assumes a working swarm at the daemon level.
- **Be conservative with timeouts.** The defaults (30 min / 5 min) are tighter than swap-email's, but if your network's latency or NAT-traversal success rate is worse than expected, longer windows are safer.
- **Identity continuity matters.** A peer's identity pubkey is stable across all trades, all reconnects, all daemon restarts. Don't accidentally regenerate the Noise keypair on every startup — load it from disk.

Anything not specified here that you have to make a call on, default to **matching the existing swap-email patterns** as closely as possible. Consistency with the rest of the codebase is more valuable than micro-optimizations.
