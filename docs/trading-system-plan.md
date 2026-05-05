# Trading Agent System: Design Plan

## Overview

A multi-agent options analysis and trading game built on glon. 5+ agents each "own" an option contract. They analyze, debate, and compete on a hex-grid ranking system. Winners advance toward the top of a pyramid where real trades execute.

## Core Loop

```
Market Open
    |
    v
[Filter] → Top 5 option contracts
    |
    v
[Spawn] → 5 agents, 1 contract each
    |
    v
Every 5 min: [Pair] → [Debate] → [Score] → [Move on hex grid]
    |
    v
End of Day: [Pyramid trade] top-ranked agents' contracts
```

---

## Phase 1: Contract Discovery (Filter)

**What it does:** Runs at market open (or on-demand). Produces the day's option pool.

**Current state:** `scripts/alpaca-filter.ts` — one-shot script.

**Decision needed:**
- **Fixed pool:** Contracts locked at 9:30 AM. Agents hold same contract all day. Simple, predictable.
- **Rolling pool:** Re-run filter every N hours. Agents may get new contracts. More dynamic, harder to reason about.

**Recommendation:** Fixed pool for v1. Agents build deep context on one contract. Rebalancing adds complexity without clear benefit.

**Output:** `~/.alpaca-filter/contracts-YYYY-MM-DD.json` — array of top contracts.

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
  hex_position: { q: 0, r: 0 }  // axial coords
  win_count: 0
  loss_count: 0
  total_pnl: "0"
  peers_faced: []  // [{ peer_id, contract, my_score, their_score, timestamp }]
  model: "moonshot-v1-8k"
```

**System prompt template:**
```
You are {{name}}, a trading analyst. You OWN the option contract {{contract}}.

Your contract details:
- Underlying: {{underlying}} @ ${{stockPrice}}
- Strike: {{strike}}, Expiry: {{expiry}}
- Entry: bid={{bid}}, ask={{ask}}, delta={{delta}}

Your job:
1. MONITOR your contract's performance using the market data tools
2. DEBATE with other agents when paired — argue why your contract is the better trade
3. LEARN from past debates — review your history with each peer

When paired with another agent:
- Fetch fresh data on BOTH contracts
- Analyze: price action, delta change, IV movement, volume
- Message the peer. Be persuasive but honest.
- Cast a vote: which contract would you rather hold right now?

You advance on a hex grid. Wins move you up. Losses move you down.
Top of the pyramid = real trades executed on your contract.
```

**Tools wired to each agent:**
| Tool | Purpose |
|------|---------|
| `alpaca_option_snapshot` | Latest quote, greeks, volume for a contract |
| `alpaca_stock_snapshot` | Underlying stock price, volume |
| `ipc_send` | Message another trading_agent |
| `ipc_inbox` | Read pending messages |
| `get_debate_history` | Past interactions with a specific peer |
| `get_contract_history` | Time-series of your contract's performance |
| `cast_vote` | Submit your decision in a debate |

---

## Phase 3: Pairing & Debate Engine

**Orchestrator:** A `trading_orchestrator` object (or daemon tick function) that runs every 5 minutes.

**Pairing algorithm:**
```python
def pair_agents(agents):
    # Sort by hex distance — agents close on grid debate more often
    # Add randomness to prevent stuck loops
    # Ensure every agent debates at least once per hour
    
    unpaired = list(agents)
    pairs = []
    
    while len(unpaired) >= 2:
        a = unpaired.pop(0)
        # Find closest unpaired agent, weighted by time-since-last-debate
        b = min(unpaired, key=lambda x: hex_dist(a, x) + time_penalty(x))
        unpaired.remove(b)
        pairs.append((a, b))
    
    return pairs
```

**Debate round (per pair):**
1. **Trigger** both agents simultaneously (via daemon tick or IPC)
2. Each agent:
   - Fetches fresh data on their own contract
   - Fetches fresh data on peer's contract (shared via tool)
   - Reads IPC inbox for any peer messages
   - Formulates analysis + argument
   - Sends message to peer via `ipc_send`
   - Waits for response (with timeout)
   - Casts final vote via `cast_vote`
3. **Scoring:**
   - Both agents vote independently
   - Compare votes to a neutral benchmark (e.g., which contract had better price action in last 5 min)
   - OR: votes are the score (both think they win = tie, both think other wins = interesting, split = winner clear)
   - **Recommendation for v1:** External judge evaluates based on actual price performance

**Judge logic (v1):**
```
score_a = (contract_a_current_price - contract_a_entry_price) / contract_a_entry_price
score_b = (contract_b_current_price - contract_b_entry_price) / contract_b_entry_price

if score_a > score_b:
    winner = a, loser = b
else:
    winner = b, loser = a
```

This is objective and prevents agents from gaming the system by always voting for themselves.

---

## Phase 4: Hex Grid Ranking

**Grid type:** Axial-coordinate hex grid (honeycomb).

**Layout:**
```
        (0,-2)  (1,-2)
    (-1,-1)  (0,-1)  (1,-1)
(-2,0)  (-1,0)  (0,0)  (1,0)  (2,0)
    (-1,1)   (0,1)   (1,1)
        (0,2)   (1,2)
```

**Movement rules:**
- Start all agents at `(0, 0)`
- Win: move +1 in a random hex direction (up/outward)
- Loss: move -1 toward center (or stay at center if already there)
- Tie: no movement
- **Boundary:** Grid is finite (e.g., radius 3). Agents at edge who win stay put.

**Grid visualization (ASCII):**
```
         [A]
       [B] [C]
     [D] [E] [F]
       [G] [H]
         [I]
```

**Effect on pairings:** Agents closer in hex distance are more likely to be paired. This means:
- Winning agents face other winning agents (harder competition)
- Losing agents face other losing agents (easier to recover)
- Natural stratification over time

**Pyramid connection:**
- After N rounds (e.g., end of day), agents at hex radius ≥ 2 are "in the pyramid"
- Their contracts are candidates for real trades
- Top 1-2 agents' contracts get executed

---

## Phase 5: Pyramid Trading

**Trigger:** End-of-day or after a set number of rounds (e.g., 20 rounds = 100 minutes).

**Selection:**
- Rank agents by hex distance from center (farthest = best)
- Tie-break by win/loss ratio, then total PnL
- Top K agents (e.g., top 2) have their contracts traded

**Trade execution:**
- Use Alpaca API to submit real order (paper trading for v1)
- Contract held overnight or until expiry
- PnL tracked in agent's state

**Agent reset:**
- After pyramid trade, all agents reset to center of hex grid
- New contracts assigned for next day (or same contracts if multi-day hold)
- Win/loss stats persist for leaderboard

---

## Phase 5b: Dynamic Agent Admission (Future)

**Problem:** v1 starts with 5 agents at market open. Later you may want 10, 20, or rotate in fresh blood mid-day.

**Solution:** A "bullpen" of inactive agents + a promotion/demotion system.

**Bullpen:**
- Larger pool of contracts from filter (e.g., top 50 instead of top 5)
- Inactive agents assigned to contracts 6-50 sit in bullpen
- They still monitor their contract but do NOT debate

**Promotion triggers:**
- Every N rounds (e.g., every 5 rounds = 25 min), evaluate bullpen
- If a bullpen contract's volume/price action exceeds an active agent's, swap them
- OR: Agent in bullpen with best "paper track record" gets promoted
- Demoted agent goes to bullpen, keeps contract but stops debating

**Mid-day spawn:**
- Orchestrator can receive `add_agent` action with new contract
- New agent starts at hex center
- Gets full history of all past debates (so they can catch up)
- Eligible for pairing immediately

**Hex grid with many agents:**
- Grid radius scales with agent count (radius = ceil(sqrt(N)))
- Multiple agents can occupy same hex cell (no collision)
- Pairing still uses distance + time-since-debate
- Visual: leaderboard shows top 10 regardless of grid position

**Contract rotation (advanced):**
- Re-run filter at midday (e.g., 12 PM)
- Top 5 new contracts get offered to bottom 2 active agents
- Agents choose: keep current contract or swap
- This prevents agents from being stuck on a dead contract all day

---

## Phase 6: Persistence & State

**What gets stored:**

Per agent (in DAG object fields):
```
assigned_contract: string
contract_metadata: JSON
hex_position: { q: number, r: number }
wins: number
losses: number
ties: number
total_pnl: string
round_history: Array<{
  round: number,
  peer_id: string,
  peer_contract: string,
  my_score: number,
  their_score: number,
  outcome: "win" | "loss" | "tie",
  timestamp: number
}>
```

Per orchestrator:
```
current_round: number
active_pairs: Array<[agent_id, agent_id]>
contract_pool: Array<OptionContract>
leaderboard: Array<{ agent_id, hex_dist, wins, losses, pnl }>
```

**No external DB needed** — all state is in glon DAG objects.

---

## Phase 7: Daemon Integration

**New daemon tick:**
```
every 5 minutes:
  if market_open:
    load trading_orchestrator state
    if no active debate for agent:
      pair unpaired agents
      trigger debate for each pair
    else:
      skip (agents still debating)
    if round_complete:
      score debates
      move agents on hex grid
      increment round counter
    if end_of_day or round >= 20:
      run pyramid
      submit trades
      reset for next day
```

---

## Implementation Order

| Phase | Work | Files |
|-------|------|-------|
| 1 | Run filter, save top 5 | `scripts/alpaca-filter.ts` (exists) |
| 2 | Create `trading_agent` handler + tools | `src/programs/handlers/trading.ts` |
| 3 | Create `trading_orchestrator` handler | `src/programs/handlers/trading.ts` or new file |
| 4 | Hex grid math + visualization | In orchestrator |
| 5 | Daemon tick integration | `scripts/daemon.ts` |
| 6 | Pyramid trade execution | Alpaca order tool in trading handler |
| 7 | End-to-end test | Manual or scripted |

---

## Open Questions

1. **Fixed vs rolling contracts?** Fixed for v1.
2. **Debate duration?** 2-3 minutes max per round (agents have time to message back and forth).
3. **Judge: external (price) or internal (votes)?** External for v1 — objective and simple.
4. **Real money or paper?** Paper trading for v1. Add live toggle later.
5. **How many rounds per day?** 20 rounds × 5 min = 100 min. Could run faster (2 min) for testing.
6. **Agent model cost?** 5 agents × 20 rounds × ~2 LLM calls = 200 calls/day. With Kimi 8k, this is cheap.

---

## MVP Scope (v1)

- 5 agents, 5 contracts, fixed for the day
- 5-minute rounds, 20 rounds total
- External judge (price performance)
- Hex grid movement
- Paper trades at end of day for top 2 agents
- All state in glon DAG
- Runs via daemon tick

---

*Last updated: 2026-05-05*
