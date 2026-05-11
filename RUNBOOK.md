# Glon System Runbook

How to get a full Glon node (Graice + Astrolabe) running from scratch.

## Architecture

Three processes:

| Process | Port | Purpose |
|---------|------|---------|
| Graice main | 6420 | RivetKit actor host, HTTP gateway, store |
| Graice daemon | 6430 | Program actors, Hyperswarm, timed ticks |
| Astrolabe | 4173 | 3D visualization UI, polls both Graice processes |

The daemon runs program actors that the main server does not. The Astrolabe UI talks to the daemon (port 6430) for program dispatch and to the main server (port 6420) for store reads.

## Prerequisites

```bash
# In Graice repo
cd Graice
npm install

# For p2p networking features (Network panel, peer discovery)
npm install hyperswarm

# In Astrolabe repo
cd glonAstrolabe
npm install

# Fix the glon symlink (points to Graice/src for shared types)
rm -f node_modules/glon
ln -s ../../Graice/src node_modules/glon
```

## Step 1: Start Graice Main Server

```bash
cd Graice
npm run dev
```

Wait for:
```
[server] Loaded N programs.
```

## Step 2: Start Graice Daemon

In a **second terminal**:

```bash
cd Graice
# Basic mode (no p2p)
npx tsx scripts/daemon.ts

# With Hyperswarm p2p networking
GLON_SWARM=1 npx tsx scripts/daemon.ts
```

Wait for:
```
[daemon] loaded N programs
[daemon] N actor(s) running.
[daemon] dispatch http listening on 127.0.0.1:6430
```

If `GLON_SWARM=1`:
```
[daemon] swarm online -- hyperswarm pubkey: XXXX...
```

## Step 3: Start Astrolabe

In a **third terminal**:

```bash
cd glonAstrolabe
npm run dev
```

Wait for:
```
glonAstrolabe -> http://127.0.0.1:4173
loaded: N objects (M programs, K agents) with L links
```

Open `http://127.0.0.1:4173` in your browser.

## Troubleshooting

### Astrolabe shows "glon daemon unreachable at http://127.0.0.1:6430"

The daemon is not running. Start it (Step 2 above).

### Network panel is empty / "swarm offline"

1. Make sure daemon is running with `GLON_SWARM=1`
2. Make sure `hyperswarm` is installed: `npm install hyperswarm`
3. The `/directory` and `/transport-hyperswarm` programs must be deployed as glon objects (see Deploying Programs below)

### "Program not running: /directory" or "Program not running: /transport-hyperswarm"

These programs exist as source files but may not be deployed as glon objects in the store. Deploy them:

```bash
cd Graice
npx tsx scripts/deploy-program.ts src/programs/handlers/directory.ts /directory "Directory"
npx tsx scripts/deploy-program.ts src/programs/handlers/transport-hyperswarm.ts /transport-hyperswarm "Transport Hyperswarm"
```

Then restart both Graice processes.

### "Cannot find package 'glon' imported from .../astrolabe/server/reader.ts"

The `node_modules/glon` symlink in Astrolabe is broken. Fix it:

```bash
cd glonAstrolabe
rm -f node_modules/glon
ln -s ../../Graice/src node_modules/glon
```

### Astrolabe port 4173 already in use

```bash
fuser -k 4173/tcp
```

## Deploying a New Program

Programs are TypeScript files that export a `ProgramDef`. To make them available:

1. Write the program handler in `src/programs/handlers/my-program.ts`
2. Deploy it as a glon object:

```bash
cd Graice
npx tsx scripts/deploy-program.ts src/programs/handlers/my-program.ts /my-prefix "My Program"
```

3. Restart the daemon (it loads programs from the store on startup)

## Key Program IDs

| Program | ID | Prefix |
|---------|-----|--------|
| Coin | 001952f9-0971-4625-b273-2807d0bc9116 | /coin |
| Wallet | 003a04da-8156-4a57-965b-7de5e29e13b2 | /wallet |
| Consensus | 85aa67af-a734-4dcd-a313-e002f7590784 | /consensus |
| Swap | c370719a-8eef-4cae-94a8-adf85bfb89ed | /swap |
| Directory | (deployed) | /directory |
| Transport Hyperswarm | (deployed) | /transport-hyperswarm |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `GLON_SWARM` | unset | Set to `1` to enable Hyperswarm p2p |
| `GLON_HOST_PORT` | 6420 | Main server port |
| `GLON_DISPATCH_PORT` | 6430 | Daemon dispatch port |
| `GLON_DATA` | `~/.glon` | Data directory |
| `HYPERSWARM_KEYPAIR_FILE` | `~/.glon/hyperswarm.key` | Persistent Noise keypair |

## Quick Health Check

```bash
# Main server
curl -s http://127.0.0.1:6420/health || echo "main down"

# Daemon
curl -s http://127.0.0.1:6430/dispatch || echo "daemon down"

# Network status
curl -s http://127.0.0.1:4173/api/network/status

# Astrolabe
curl -s http://127.0.0.1:4173/api/state | head -c 100
```
