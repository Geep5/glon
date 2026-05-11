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

# 3. Start Astrolabe (in a third terminal)
cd glonAstrolabe
npm run dev
```

Open `http://127.0.0.1:4173`.

## Prerequisites

```bash
cd Graice
npm install
npm install hyperswarm   # required for p2p/Network panel

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
| `GLON_HOST_PORT` | 6420 | Main server port |
| `GLON_DISPATCH_PORT` | 6430 | Daemon dispatch port |
| `GLON_DATA` | `~/.glon` | Data directory |

## Health Checks

```bash
curl -s http://127.0.0.1:6420/health
curl -s http://127.0.0.1:6430/dispatch
curl -s http://127.0.0.1:4173/api/network/status
curl -s http://127.0.0.1:4173/api/state | head -c 100
```
