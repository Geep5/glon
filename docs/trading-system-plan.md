# Trading Agent System: Design Plan (v2)

## Overview

A multi-agent options analysis and trading game built on glon. Agents only exist during discrete "rounds." Each round: pair neighbors, debate, vote, move on hex grid. Winners advance toward the top of a pyramid where real trades execute.

## Core Loop

```
Market Open
    |
    v
[Filter] → Top N option contracts
    |
    v
[Spawn] → N agents, 1 contract each
    |
    v
[Round 1]: [Pair] → [Debate] → [Vote] → [Move]
    |
    v
[Round 2]: [Pair] → [Debate] → [Vote] → [Move]
    |
    v
...
    |
    v
End of Day: [Pyramid trade] top-ranked agents' contracts
```

A **round** is a discrete event. Agents are dormant between rounds. All activity — data fetching, messaging, analysis, voting — happens inside the round.

---

## Phase 1: Contract Discovery (Filter)

**What it does:** Runs at market open. Produces the day's option pool.

**Output:** `~/.alpaca-filter/contracts-YYYY-MM-DD.json` — array of top contracts.

**For v1:** Top 5 contracts.

---

## Phase 2: Agent Factory

**What it does:** Creates N agent objects, assigns each one contract.

**Agent object schema:**
```
typeKey: "trading_agent"
fields:
  name: "Trader-1"
  assigned_contract: "POET260508C00010000"
  contract_metadata: { strike, expiry, underlying, entry_price, entry_delta }
  hex_position: { q: 0, r: 0 }
  wins: 0
  losses: 0
  ties: 0
  last_peer_id: ""       // who they debated last
  peers_faced: []        // all peer IDs ever faced
  round_history: []      // [{ round, peer_id, my_vote, peer_vote, outcome }]
  model: "moonshot-v1-8k"
```

**System prompt template:**
```
You are {{name}}. You own the option contract {{contract}}.

Contract: {{underlying}} ${{stockPrice}} | Strike {{strike}} | Expiry {{expiry}}

This is a TRADING ROUND. You have been paired with {{peer_name}} who owns {{peer_contract}}.

Your task:
1. Fetch fresh data on BOTH contracts (yours and your peer's)
2. Analyze: price action, delta, IV, volume since last round
3. MESSAGE your peer via ipc_send — discuss your analysis, ask questions
4. Wait for their response (they may message you back)
5. Formulate your final assessment
6. CAST YOUR VOTE: which contract is the stronger trade RIGHT NOW?
   - vote "self" if you believe your contract is stronger
   - vote "peer" if you believe their contract is stronger
   - vote "tie" if you genuinely think they're equal

Base your vote on:
- Your contract's performance since you got it
- What you learned from your peer in this round
- Your past round history (which strategies have worked)

Be honest. A wrong vote hurts you on the hex grid.
```

**Tools (only available during a round):**
| Tool | Purpose |
|------|---------|
| `alpaca_option_snapshot` | Latest quote, greeks, volume for any contract |
| `ipc_send` | Message your paired peer |
| `ipc_inbox` | Read messages from your peer |
| `get_peer_history` | Past interactions with this specific peer |
| `get_my_history` | Your full round history |
| `cast_vote` | Submit your vote: "self", "peer", or "tie" |

---

## Phase 3: Round Engine

### Round Lifecycle

```
ORCHESTRATOR triggers round
    |
    v
[1. PAIR]     — Pair agents into debating pairs
    |
    v
[2. DEBATE]   — Each agent wakes, fetches data, messages peer, thinks
    |
    v
[3. VOTE]     — Each agent casts vote independently
    |
    v
[4. SCORE]    — Compare votes, determine outcome
    |
    v
[5. MOVE]     — Update hex positions based on outcome
    |
    v
Round ends. Agents sleep. Orchestrator waits for next tick.
```

### 1. Pairing

**Goal:** Pair agents who are hex neighbors but haven't debated recently.

**Algorithm:**
```
unpaired = all agents shuffled
pairs = []

while len(unpaired) >= 2:
    a = unpaired.pop()
    
    # Find best match among unpaired:
    # 1. Prefer agents who haven't faced each other
    # 2. Prefer agents close on hex grid (neighbors)
    # 3. Prefer agents who haven't debated in longest time
    
    candidates = [b for b in unpaired if b.id != a.last_peer_id]
    if not candidates:
        candidates = unpaired  # fallback: anyone available
    
    # Score each candidate
    best = min(candidates, key=lambda b: (
        hex_distance(a, b),           # closer = better
        0 if b.id not in a.peers_faced else 1,  # new = better
        rounds_since_last_debate(a, b)  # longer = better
    ))
    
    unpaired.remove(best)
    pairs.append((a, best))
```

**Edge case:** Odd number of agents. One agent gets a "bye" — no debate, no movement this round.

### 2. Debate

**Trigger:** Orchestrator sends IPC message to both agents: "You are paired with X. Round begins."

**Agent behavior (within one LLM call or multi-turn):**

Option A: **Single-turn debate**
- Agent fetches data on both contracts
- Agent reads IPC inbox (may be empty if peer hasn't messaged yet)
- Agent formulates analysis + sends ONE message to peer
- Agent immediately casts vote
- Simple, fast, one LLM call per agent

Option B: **Multi-turn debate**
- Agent sends message, waits for peer response
- Agent reads response, sends counter
- Repeat N times or until timeout
- Agent casts final vote
- Richer conversation, slower, more LLM calls

**Recommendation for v1:** Single-turn. Agents get one message exchange per round. This keeps rounds short (~30-60 seconds) and costs predictable.

**Debate timeout:** 2 minutes. If agent doesn't vote by then, auto-cast "tie".

### 3. Voting

Each agent independently submits one vote:
- `"self"` — my contract is stronger
- `"peer"` — my peer's contract is stronger  
- `"tie"` — they're equal

### 4. Scoring

Compare the two votes. Four outcomes:

| Agent A votes | Agent B votes | Result | Hex movement |
|---------------|---------------|--------|--------------|
| self | peer | **A wins** (agreement) | A moves +1, B moves -1 |
| peer | self | **B wins** (agreement) | B moves +1, A moves -1 |
| self | self | **Dispute** | No movement (both think they win) |
| peer | peer | **Dispute** | No movement (both think other wins — interesting!) |
| tie | anything | **Tie** | No movement |

**Why this works:**
- If both agents honestly assess and agree, the "better" contract moves up.
- If they disagree, neither moves — the market was unclear.
- An agent that always votes "self" will never win (needs peer to agree they're worse).
- An agent that always votes "peer" will never win either (needs peer to agree they're better).
- Honest assessment is the dominant strategy.

### 5. Hex Movement

**Grid:** Axial-coordinate hex grid.

**Movement:**
- Winner: move +1 in a random hex direction (6 neighbors)
- Loser: move -1 toward center (or stay at center)
- Tie/Dispute: no movement
- Bye: no movement

**Boundary:** Grid is finite. Agents at edge who win stay at edge.

**Hex directions (axial):**
```
const HEX_DIRS = [
  { q: 1, r: 0 },   // east
  { q: 1, r: -1 },  // northeast
  { q: 0, r: -1 },  // northwest
  { q: -1, r: 0 },  // west
  { q: -1, r: 1 },  // southwest
  { q: 0, r: 1 },   // southeast
];
```

**Effect on future pairings:**
- Agents cluster by performance over time
- Winners face winners (harder to agree = more disputes)
- Losers face losers (easier to identify the better of two bad options)
- Natural stratification

---

## Phase 4: Pyramid Trading

**Trigger:** End-of-day or after N rounds (e.g., 20 rounds).

**Selection:**
- Rank agents by hex distance from center (farthest = best)
- Tie-break by win count, then win/loss ratio
- Top K agents (e.g., top 2) have their contracts traded

**Trade execution:**
- Alpaca API: buy the option contract (paper trading for v1)
- Track entry price
- Hold overnight or until expiry
- Close position next day, calculate PnL

**Agent reset:**
- All agents return to hex center
- New contracts assigned for next day
- Win/loss stats persist for lifetime leaderboard

---

## Phase 5: Dynamic Scaling (Future)

**Adding agents mid-day:**
- New filter run → new contracts
- Spawn new agent objects with new contracts
- New agents start at hex center
- They receive full debate history of all existing agents (so they can catch up)
- Eligible for pairing immediately in next round

**Removing agents:**
- Agent at hex center for 3 consecutive rounds with no wins → auto-removed
- Or: manual removal via orchestrator command

**Contract rotation:**
- Agent can voluntarily swap contract with another agent (both must agree)
- Or: orchestrator forces swap if a contract has zero volume for 5 rounds

**Scaling:**
- Works with any number of agents: 5, 10, 20, 50
- Pairing algorithm handles odd counts (bye)
- Hex grid naturally accommodates more agents (more cells occupied)

---

## Phase 6: State & Persistence

**Per agent:**
```
assigned_contract: string
contract_metadata: JSON
hex_position: { q: number, r: number }
wins: number
losses: number
ties: number
last_peer_id: string
peers_faced: string[]
round_history: Array<{
  round: number,
  peer_id: string,
  peer_contract: string,
  my_vote: "self" | "peer" | "tie",
  peer_vote: "self" | "peer" | "tie" | null,  // may not know peer's vote
  outcome: "win" | "loss" | "tie" | "dispute",
  timestamp: number
}>
```

**Per orchestrator:**
```
current_round: number
active_pairs: Array<[agent_id, agent_id]>
round_in_progress: boolean
contract_pool: Array<OptionContract>
leaderboard: Array<{ agent_id, hex_dist, wins, losses }>
```

---

## Phase 7: Daemon Integration

**Tick:** Every 5 minutes (configurable).

```
every tick:
  if market_open and not round_in_progress:
    start_round()
  
  if round_in_progress and all_votes_received:
    end_round()
    
  if round_in_progress and timeout_reached:
    force_end_round()  // auto-cast tie for missing votes
```

**start_round():**
1. Load all trading_agent objects
2. Pair agents
3. For each pair, send IPC: "Round {N} begins. You are paired with {peer}."
4. Set round_in_progress = true
5. Set round_start_time = now

**end_round():**
1. Collect all votes
2. For each pair, determine outcome
3. Update hex positions
4. Update win/loss/tie counts
5. Record round history
6. Update leaderboard
7. Set round_in_progress = false

---

## Implementation Order

| Phase | Work | Files |
|-------|------|-------|
| 1 | Filter (exists) | `scripts/alpaca-filter.ts` |
| 2 | Hex grid math | `src/programs/handlers/trading.ts` |
| 3 | Agent handler + tools | `src/programs/handlers/trading.ts` |
| 4 | Orchestrator handler | `src/programs/handlers/trading.ts` or `trading-orchestrator.ts` |
| 5 | Round engine (pair, debate, vote, score, move) | In orchestrator |
| 6 | Daemon tick integration | `scripts/daemon.ts` |
| 7 | Pyramid trade execution | Alpaca order tool |
| 8 | End-to-end test | Manual |

---

## MVP Scope (v1)

- 5 agents, 5 contracts, fixed all day
- Single-turn debates (one message exchange per round)
- 5-minute rounds, 20 rounds total
- Agents vote, consensus wins, disputes = no move
- Hex grid movement
- Paper trades at end of day for top 2
- All state in glon DAG

---

*Last updated: 2026-05-05*
