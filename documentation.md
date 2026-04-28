# Agent Documentation

## Overview

This is a BDI (Belief-Desire-Intention) autonomous agent for the Deliveroo.js simulator. The agent collects parcels from spawn tiles and delivers them to delivery tiles, maximizing score subject to parcel reward decay over time.

The codebase is organized in five modules:

| File | Responsibility |
|---|---|
| `main.ts` | Entry point, event wiring, BDI loop orchestration |
| `Belief.ts` | World model — tiles, parcels, agents, crates |
| `Desire.ts` | Utility-based desire generation |
| `Intentions.ts` | Intention revision and validation |
| `utils.ts` / `path_finding.ts` | Pathfinding and helper functions |

---

## 1. Architecture

### 1.1 BDI Loop

The agent runs a reactive BDI loop triggered by two sources:

- **`socket.onSensing`** — fires every time the server sends a sensing update (parcels, agents, crates visible in range)
- **Heartbeat** — `setInterval(bdiStep, 500)` ensures the agent keeps acting even if sensing is slow

Both sources call `bdiStep()`, which is guarded by an `isRunning` mutex to prevent concurrent execution.

```
onSensing / heartbeat
        │
        ▼
    bdiStep()
        │
        ├─ Priority check: on delivery tile with parcels? → emitPutdown immediately
        │
        ├─ generateDesires()     → ranked list of Desire objects
        │
        ├─ reviseIntention()     → pick or keep current intention
        │
        └─ execute intention     → emitMove / emitPickup / emitPutdown
```

### 1.2 Event Sequence at Startup

```
onConfig  → parse movementDuration, parcelDecayIntervalMs, agentObsDistance
onMap     → build World, call tryInitReachability()
onYou     → set myAgent position, call tryInitReachability()
```

`tryInitReachability()` runs once when both `worldMap` and `myAgent` are available. It performs a directed BFS from the agent's spawn position and removes all structurally unreachable tiles from `worldMap.tiles` in-place (see §3.3).

---

## 2. Belief Model (`Belief.ts`)

### 2.1 World

```
World
├── tiles: Map<"x,y", tileType>   '0'=wall, '1'=spawn, '2'=delivery, '↑↓←→'=one-way
├── parcels: Map<id, Parcel>
├── other_agents: Map<id, OpponentAgent>
├── crates: Map<id, Crate>
├── movementDuration: number       ms per movement step
├── parcelDecayIntervalMs: number  ms per 1 reward point lost
└── decayPerStep (getter)          = movementDuration / parcelDecayIntervalMs
```

### 2.2 Parcel Decay

Each parcel has a `reward` that decreases over time at the rate defined by the server config field `decaying_event` (e.g. `"1s"` → loses 1 reward point every 1000 ms).

The per-step decay rate used in all utility calculations is:

$$\delta = \frac{\text{movementDuration}}{\text{parcelDecayIntervalMs}}$$

For example, with `movementDuration = 200ms` and `decaying_event = "1s"`:

$$\delta = \frac{200}{1000} = 0.2 \text{ reward/step}$$

### 2.3 Parcel Belief Updates (`update_parcels`)

Each sensing update replaces known parcels with fresh data. Parcels not seen for longer than `lifespan = 1500ms` are pruned from the belief set (they likely expired or were picked up out of range).

### 2.4 OpponentAgent State

Each opponent agent tracks:
- `direction` — computed from position delta between sensing updates (`up/down/left/right/none`)
- `stationaryTicks` — incremented each sensing update the agent has `direction === 'none'`; reset to 0 on any movement

Agents with `stationaryTicks >= 3` are treated as permanent BFS obstacles.

---

## 3. Pathfinding (`path_finding.ts`, `utils.ts`)

### 3.1 BFS

Standard breadth-first search on the tile graph. Notable features:

- **One-way tiles**: a tile of type `↑/↓/←/→` can only be *exited* in the designated direction
- **Blocked set**: merges stationary-agent positions (≥3 ticks) with any externally provided `extraBlocked` cells (used for bounce-loop recovery)
- **Path reconstruction**: uses a `parentMap` instead of copying arrays at each node — O(1) per node, O(K) reconstruction

### 3.2 Collision Prediction (`get_predicted_occupied_cells`)

Before each `emitMove`, the agent checks a set of predicted occupied cells built from current opponent positions and directions:

- **Direction known, moving**: blocks current position + predicted next position + source tile (locked during animation transit)
- **Direction unknown** (first observation): conservatively blocks all 4 neighbours
- **Stationary**: only current position

If the next cell is in this set, the move is skipped (path kept, agent waits one tick).

### 3.3 Reachability Pruning (`computeReachableTiles`)

On map load, a directed flood-fill BFS from the agent's spawn position computes all structurally reachable tiles, respecting one-way constraints. Unreachable tiles are deleted from `worldMap.tiles` in-place.

This means all downstream operations (pathfinding, desire scoring, delivery lookup) automatically ignore the unreachable portion of the map, with no additional parameters needed.

---

## 4. Desire Generation (`Desire.ts`)

Each tick `generateDesires()` produces a list of `Desire` objects sorted by descending utility. There are three desire types.

### 4.1 `go_delivery`

Generated only when `carrying.length > 0`.

**Enemy filtering first**: delivery tiles are split into free tiles (no stationary enemy) and blocked tiles. The 3 closest free tiles are used as candidates; only if all tiles are blocked does the agent fall back to using blocked tiles (with heavy penalty).

For each candidate delivery tile at Manhattan distance $d$:

$$U_{\text{delivery}} = \max\!\left(\text{carriedReward} - n_c \cdot \delta \cdot d,\ 0.01\right)$$

where $n_c$ = number of carried parcels, $\delta$ = decay per step.

If the tile is enemy-blocked (fallback case):

$$U_{\text{delivery}} \mathrel{*}= 0.1$$

The floor of $0.01$ guarantees that delivery is never silently abandoned even when decay renders the net reward negative.

### 4.2 `go_pickup`

Generated for every visible, non-carried parcel. The utility models the **absolute net reward** that would be scored at delivery after completing the full trip: agent → parcel → delivery.

Let:
- $r_c$ = total reward of currently carried parcels  
- $r_p$ = reward of the candidate parcel  
- $d_1$ = Manhattan distance: agent → parcel  
- $d_2$ = Manhattan distance: parcel → closest delivery  
- $n_c$ = number of currently carried parcels  

$$U_{\text{pickup}} = \underbrace{\bigl(r_c - n_c \cdot \delta \cdot (d_1 + d_2)\bigr)}_{\text{carried value at delivery}} + \underbrace{\bigl(r_p - \delta \cdot d_2\bigr)}_{\text{new parcel value at delivery}}$$

Desires with $U_{\text{pickup}} \leq 0$ are discarded (trip would cost more than it earns).

**Competitive penalties**:
- An opponent closer to the parcel than the agent: $\times\ 0.4$
- A stationary enemy on the parcel tile: $\times\ 0.05$ (nearly unreachable)

### 4.3 `explore`

Generated only when no `go_pickup` or `go_delivery` desires exist (i.e. no visible parcels and not carrying).

Uses a cluster-aware scoring of all spawn tiles. For each spawn tile $s$ at distance $d$ from the agent, with $t_{\text{recency}}$ = milliseconds since last visited:

$$\text{baseScore}(s) = \max\!\left(\frac{t_{\text{recency}}}{d+1} - \delta \cdot d \cdot 1000,\ 0\right)$$

The density bonus aggregates neighboring spawn tiles within a cluster radius $R = 5$ tiles:

$$\text{totalScore}(s) = \text{baseScore}(s) + \sum_{\substack{o \neq s \\ \|o - s\|_1 \leq R}} \frac{0.3 \cdot \text{baseScore}(o)}{\|o-s\|_1 + 1}$$

The best-scoring spawn tile is selected and its utility is clamped:

$$U_{\text{explore}} = \text{clamp}\!\left(\frac{\text{totalScore}}{100000},\ 0.001,\ 0.5\right)$$

The intentionally small range $[0.001, 0.5]$ ensures any `go_pickup` or `go_delivery` desire (typically in the range $[1, \infty)$) always dominates.

**Early stop**: if the explore target is already within `agentObsDistance` tiles, it is marked visited immediately without walking all the way to it (the agent can already see it).

---

## 5. Intention Revision (`Intentions.ts`)

### 5.1 `reviseIntention`

Each tick, the current intention is reconsidered:

1. If the current list is empty → `null`
2. If the current intention is **invalid** → switch to best desire
3. If the current intention is `explore` and best desire is `go_pickup`/`go_delivery` → **immediate switch** (explore never blocks productive actions)
4. If best desire utility $> 1.2 \times$ current utility → switch (20% hysteresis prevents thrashing)
5. Otherwise → keep current intention

### 5.2 `isIntentionValid`

| Type | Valid when |
|---|---|
| `go_delivery` | `carrying.length > 0` |
| `go_pickup` | parcel still exists at target position and is not carried by anyone |
| `explore` | always valid (target may become stale but is harmless to pursue) |

---

## 6. Execution (`main.ts — bdiStep`)

### 6.1 Absolute Priority Check

At the very start of each `bdiStep`, **before** desire generation:

```
if (carrying > 0 AND standing on delivery tile) → emitPutdown immediately
```

This handles the case where the agent reaches a delivery tile mid-path during a `go_pickup` trip (opportunistic delivery).

### 6.2 Path Execution

- The path (list of directions) is computed once and cached in `currentPath`
- Cache is invalidated whenever the intention target changes
- If a crate is detected on the next step, the path is invalidated for immediate replanning
- After each successful move, if the new position is a delivery tile and the agent is carrying, `emitPutdown` is called opportunistically

### 6.3 `resilientMove`

Wraps `emitMove` with two safety checks before sending:

1. **`recentlyFailedCells`**: cells where `emitMove` failed since the last sensing update — skipped to avoid hammering a server-locked tile
2. **`get_predicted_occupied_cells`**: cells predicted to be occupied by moving opponents — skipped this tick (path is preserved, not cleared)

On `emitMove` failure: cell is added to `recentlyFailedCells`, `currentPath` is cleared.

Both sets are cleared on every `onSensing` event (fresh world state).

### 6.4 Bounce Loop Detection

After each sensing update, the agent's new position is appended to `positionHistory` (max 8 entries, only distinct positions). If an ABAB pattern is detected:

$$p_{n-4} = p_{n-2} \quad \text{and} \quad p_{n-3} = p_{n-1}$$

Both oscillating cells are added to `tempBlockedCells` with a 4-second TTL. The current intention and path are reset, and `positionHistory` is cleared. `planPath` passes active `tempBlockedCells` entries to BFS as additional obstacles.

### 6.5 Carrying Sync

On each `onSensing`, `carrying` is filtered against the raw sensing payload:

- Parcel **not in sensing**: still off-map → keep (we're carrying it)
- Parcel in sensing with `reward <= 0`: expired → remove
- Parcel in sensing with `carriedBy` ≠ our id: stolen → remove

This prevents the agent from targeting a delivery when it has already lost all its parcels.

---

## 7. Configuration

All parameters are read from the server config at connect time and from `.env`:

| Parameter | Source | Effect |
|---|---|---|
| `HOST` / `TOKEN` | `.env` | Server URL and authentication |
| `USE_PDDL=true` | `.env` | Use PDDL online solver instead of BFS |
| `movement_duration` | server config | ms per movement step (default 200) |
| `decaying_event` | server config | e.g. `"1s"`, `"500ms"`, `"infinite"` |
| `agents_observation_distance` | server config | Explore early-stop radius |
