# Glon System Runbook

How to get a full Glon node running from scratch.

## Architecture

Three processes:

| Process | Port | Purpose |
|---------|------|---------|
| Graice main | 6420 | RivetKit actor host, HTTP gateway, store |
| Graice daemon | 6430 | Program actors, Hyperswarm, timed ticks |
| Astrolabe | 4173 | 3D visualization UI |

Astrolabe polls the daemon (6430) for program dispatch and the main server (6420) for store reads.

## Quick Start

```bash
# 1. Start Graice main
cd Graice && npm run dev

# 2. Start Graice daemon (in another terminal)
cd Graice
# Basic mode:
npx tsx scripts/daemon.ts
# With p2p networking:
GLON_SWARM=1 npx tsx scripts/daemon.ts
# Full auction-house mode (p2p + autobase ledger):
GLON_SWARM=1 GLON_AUCTION=1 npx tsx scripts/daemon.ts

# 3. Start Astrolabe (in a third terminal)
cd glonAstrolabe
npm run dev
```

Open `http://127.0.0.1:4173`.

## Prerequisites

```bash
cd Graice
npm install
# Required deps for the auction house: autobase, corestore, hyperbee,
# hypercore, b4a, hyperswarm, random-access-memory. All installed by
# the base npm install.

cd glonAstrolabe
npm install
# Fix glon symlink (points to Graice/src)
rm -f node_modules/glon
ln -s ../../Graice/src node_modules/glon
```

## Troubleshooting

### "glon daemon unreachable at http://127.0.0.1:6430"

The daemon isn't running. Start it (Step 2 above).

### Network panel empty / "swarm offline"

The `/directory` and `/transport-hyperswarm` programs must be deployed as glon objects. If you see `Program not running: /transport-hyperswarm` in the daemon log, deploy them:

```bash
cd Graice

# Deploy /directory
npx tsx -e "
import { createClient } from 'rivetkit/client';
import { resolveEndpoint } from './src/endpoint.js';
import { encodeChange } from './src/proto.js';
import { sha256, hexEncode } from './src/crypto.js';
import * as detCanonical from './src/det/canonical.js';
import { readFileSync } from 'node:fs';

const client = createClient(resolveEndpoint());
const ID = crypto.randomUUID();
const src = readFileSync('./src/programs/handlers/directory.ts', 'utf8');
const b64 = Buffer.from(src).toString('base64');

const change = {
  id: new Uint8Array(0),
  objectId: ID,
  parentIds: [],
  ops: [
    { objectCreate: { typeKey: 'program' } },
    { fieldSet: { key: 'prefix', value: { stringValue: '/directory' } } },
    { fieldSet: { key: 'name', value: { stringValue: 'Directory' } } },
    { fieldSet: { key: 'manifest', value: { mapValue: { entries: { entry: { stringValue: 'directory.ts' }, modules: { mapValue: { entries: { 'directory.ts': { stringValue: b64 } } } } } } } } },
  ],
  timestamp: Date.now(),
  author: 'deploy',
};
change.id = sha256(detCanonical.canonicalEncodeChange(change));
await client.objectActor.getOrCreate([ID]).pushChanges(
  Buffer.from(encodeChange(change)).toString('base64')
);
console.log('Directory deployed:', ID);
"

# Deploy /transport-hyperswarm (same pattern, prefix /transport-hyperswarm, name Transport Hyperswarm)
```

After deploying, **restart the daemon with GLON_SWARM=1**.

### "Program not running: /transport-hyperswarm" after restart

This is a load-order bug: `/directory` starts before `/transport-hyperswarm`. Manually join the topic after startup:

```bash
# Compute topic hash and join
cd Graice
TOPIC=$(node -e "console.log(require('crypto').createHash('sha256').update('glon:network:v1').digest('hex'))")
curl -sf -X POST http://127.0.0.1:6430/dispatch \
  -H 'Content-Type: application/json' \
  -d "{\"prefix\":\"/transport-hyperswarm\",\"action\":\"joinTopic\",\"args\":[{\"topic\":\"$TOPIC\"}]}"
```

### Port 4173 already in use

```bash
fuser -k 4173/tcp
```

### "Cannot find package 'glon'"

```bash
cd glonAstrolabe
rm -f node_modules/glon
ln -s ../../Graice/src node_modules/glon
```

## Verifying Network Discovery

On your machine:
```bash
curl -s http://127.0.0.1:4173/api/network/status
```

Expected when working:
```json
{
  "hyperswarm_pubkey": "...",
  "peers_connected": 1,
  "topics_joined": 1,
  "is_announcing": true
}
```

If `topics_joined` is 0, run the manual join command above.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GLON_SWARM` | unset | Set to `1` to enable Hyperswarm p2p |
| `GLON_AUCTION` | unset | Set to `1` to bring up the autobase auction-house ledger |
| `GLON_AUTOBASE_BOOTSTRAP` | unset | 64-hex pubkey to join an existing network (instead of generating a fresh one) |
| `GLON_AUTOBASE_DIR` | `~/.glon/autobase` | Where the corestore lives on disk |
| `GLON_AUCTION_SKIP_VERIFY` | unset | Set to `1` to bypass op signature checks (dev migration only — never in production) |
| `GLON_HOST_PORT` | 6420 | Main server port |
| `GLON_DISPATCH_PORT` | 6430 | Daemon dispatch port |
| `GLON_DATA` | `~/.glon` | Data directory |

## Auction Modes

Auctions are a single primitive — what the seller fills in determines the behavior. The apply function detects the mode at op time:

| `give` | `want` (asking price) | `recipient_pubkey` | Mode | Settlement |
|---|---|---|---|---|
| ✓ | ✓ | unset | **Fixed-price** | Anyone can bid; seller picks a winner via `--bid-at`; default payment is `want` |
| ✓ | unset | unset | **Open auction** | Anyone can bid with any token / basket; seller MUST pass `--bid-at` to pick which bid |
| ✓ | unset | ✓ | **Gift** | **Auto-settles atomically on creation** — single op, no separate settle needed |
| ✓ | ✓ | ✓ | **Directed sale (private)** | Only the named recipient is intended; seller still settles manually |

Key invariants:
- Every auction must have an `expiry_ms > created_at`. Apply rejects auctions that would be born expired.
- Late ops (`bid` / `settle` / `cancel` arriving after `expiry_ms`) lazy-expire the auction: seller is refunded, the late op is dropped.
- Open auctions REQUIRE `--bid-at` on settle (the seller picks which of the received bids wins). Apply stamps `invalid_open_settle_needs_bid` if you forget.
- Settling a fixed-price auction can optionally pass `--bid-at` to accept a **counter-offer** in different tokens than the posted `want`.

## Holistic Two-Daemon Auction House Test

This walks two glon nodes (running on the same machine for simplicity) through deploy → gift → bid → settle, exercising the full auction-house stack with **real balance tracking** on the autobase.

### Terminal 1 — node A (founder)

```bash
GLON_DATA=/tmp/glon-A \
GLON_AUTOBASE_DIR=/tmp/glon-A/autobase \
GLON_SWARM=1 GLON_AUCTION=1 \
npx tsx scripts/daemon.ts
```

Then in the glon CLI:

```
/wallet new alice
/auction status                                  # copy the "bootstrap key"
/coin deploy Figgies FIG 1000 --key=alice        # deploy 1000 FIG, alice gets the supply
/coin balance <token_id> <alice pubkey>          # should print 1000
```

### Terminal 2 — node B (joiner), pointed at A's autobase via env

```bash
GLON_DATA=/tmp/glon-B \
GLON_AUTOBASE_DIR=/tmp/glon-B/autobase \
GLON_AUTOBASE_BOOTSTRAP=<paste-A's-bootstrap-key> \
GLON_SWARM=1 GLON_AUCTION=1 \
npx tsx scripts/daemon.ts
```

Then in B's CLI:

```
/wallet new bob
/auction join                                    # broadcasts a join request to the network
                                                 # wait ~15s for A's daemon to relay
/auction status                                  # should now show writable: yes
/coin list                                       # should show Figgies (replicated from A)
```

### Alice gifts Bob some FIG (single op, atomic transfer)

In Terminal 1:

```
/auction gift 100 <FIG token_id> to <bob pubkey> with alice
```

Gifts **auto-settle on creation** — the recipient's balance updates in the same apply pass that creates the auction record. No separate settle step. In Terminal 2, after replication:

```
/coin balance <FIG token_id> <bob pubkey>        # should print 100
```

The auction record stays in the AH ledger (`status: settled`, `auto_settled_gift: true`) so every gift leaves an auditable trail.

### Trade — Bob auctions an item, Alice buys it

In Terminal 2:

```
/auction post sword-1 for 50 FIG with bob        # bob's unique sword for 50 FIG
/auction list
```

In Terminal 1:

```
/auction list                                    # should show bob's sword auction
/auction bid <auctionId> 50 <FIG token_id> with alice
```

In Terminal 2 (settle the fixed-price auction; `--bid-at` is optional since the payment matches the posted `want`):

```
/auction settle <auctionId> <alice pubkey> with bob
```

> For **open auctions** (no `for`), the seller must pass `--bid-at=<bid created_at ms>` to pick which of the received bids to honor. Get the timestamps via `curl -s http://127.0.0.1:4173/api/auctions/<id>/bids`. The Astrolabe UI's per-bid Accept button does this for you in one click.

Both terminals:

```
/auction list                                    # status=settled on both nodes
/coin balance <FIG token_id> <bob pubkey>        # bob: 150 (100 gift + 50 from trade)
/coin balance <FIG token_id> <alice pubkey>     # alice: 850 (1000 - 100 gift - 50 trade)
```

The settle propagates over Hyperswarm replication; both nodes' apply functions deterministically debit Alice's 50 FIG and credit Bob's. **Same state on both ends, no leader, no consensus protocol.**

## Astrolabe UI — the auction house, no CLI needed

When the daemon is running with `GLON_SWARM=1 GLON_AUCTION=1`, http://127.0.0.1:4173 exposes the full auction-house surface as a UI:

### 3D scene
- A **cyan octahedron** orbits near the local sun. That's the auction house. Hover for tooltip; click to fly the camera in and pop the panel open.
- Clicking any row in the **Coins** panel also tweens the camera to the auction-house node — coins "live" at the AH.

### Auctions panel (spell-bar slot `A`)
- Live list of auctions from the autobase view, sorted open → settled → cancelled → expired.
- Each row shows give → want, status badge, expiry countdown (`in 23h 45m`), and (for your own auctions) a cyan **"you"** badge with a left-border highlight.
- **`+ post auction`** opens an inline form. Live mode chip tells you which mode you're about to create (open / gift / fixed / directed) based on whether `asking price` and `directed to` are filled.
- **`+ bid`** (per row, only on others' auctions) — inline mini-form: offer `<amount> <token_id>` + signing key, submit.
- **`▸ bids`** (per open row) — expands the bid list inline. Shows bidder, offer basket, age. For your own auctions, each bid has a cyan **accept** button that fires `auction.settle` with the right `winning_bid_at`. One click settles to that specific bidder.
- **`cancel`** (per row, only on your own open auctions) — closes the auction; escrowed assets refund to you immediately.

### Coins panel (spell-bar slot `4`)
- All tokens deployed on this network. Each row shows name, symbol, supply, mint-renounced state, and the top 4 holders (with `(owner)` tag for the original deployer).
- Click any row → flies camera to the AH and opens its panel ("this is where these coins move").

### API surface (proxied to the daemon's `/dispatch`)

| Endpoint | Purpose |
|---|---|
| `GET /api/auction/status` | local ledger health (bootstrap key, writer key, view length) |
| `GET /api/auctions` | all auctions in the local view |
| `GET /api/auctions/:id` | one auction's full record (incl. status, escrow flags, settle details) |
| `GET /api/auctions/:id/bids` | all bids on an auction, newest first |
| `POST /api/auctions/post` | `{ give, want, recipient?, expiryMs, keyName }` |
| `POST /api/auctions/gift` | shorthand for directed + empty-want post |
| `POST /api/auctions/bid` | `{ auctionId, offer, keyName }` |
| `POST /api/auctions/settle` | `{ auctionId, winner, winningBidAt?, keyName }` |
| `POST /api/auctions/cancel` | `{ auctionId, keyName }` |
| `GET /api/coins` | all deployed tokens |
| `GET /api/coins/:id/holders` | top holders descending |
| `GET /api/wallet` | local chain pubkeys (used by the UI for "is this mine?" checks) |


## Health Checks

```bash
curl -s http://127.0.0.1:6420/health
curl -s http://127.0.0.1:6430/dispatch
curl -s http://127.0.0.1:4173/api/network/status
curl -s http://127.0.0.1:4173/api/state | head -c 100
```
