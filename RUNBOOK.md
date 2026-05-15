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

### Alice gifts Bob some FIG (auction with recipient + empty want)

In Terminal 1:

```
/auction gift 100 <FIG token_id> to <bob pubkey> with alice
```

In Terminal 2, after a few seconds:

```
/coin balance <FIG token_id> <bob pubkey>        # should print 100
```

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

In Terminal 2:

```
/auction settle <auctionId> <alice pubkey> with bob
```

Both terminals:

```
/auction list                                    # status=settled on both nodes
/coin balance <FIG token_id> <bob pubkey>        # bob: 150 (100 gift + 50 from trade)
/coin balance <FIG token_id> <alice pubkey>     # alice: 850 (1000 - 100 gift - 50 trade)
```

The settle propagates over Hyperswarm replication; both nodes' apply functions deterministically debit Alice's 50 FIG and credit Bob's. **Same state on both ends, no leader, no consensus protocol.**

## Astrolabe Auctions Panel

When the daemon is running with `GLON_AUCTION=1`, the Astrolabe UI at `http://127.0.0.1:4173` exposes:
- **Auctions panel** (spell-bar slot "A") — live list of all auctions in the autobase view; shows status badges (open / settled / cancelled / invalid_*) and a cancel button for your own open auctions.
- **`GET /api/auctions`** — JSON list for headless consumers.
- **`GET /api/auction/status`** — local ledger health (bootstrap key, writer key, view length).
- **`GET /api/coins`** — all deployed tokens.
- **`GET /api/coins/:id/holders`** — top holders descending.


## Health Checks

```bash
curl -s http://127.0.0.1:6420/health
curl -s http://127.0.0.1:6430/dispatch
curl -s http://127.0.0.1:4173/api/network/status
curl -s http://127.0.0.1:4173/api/state | head -c 100
```
