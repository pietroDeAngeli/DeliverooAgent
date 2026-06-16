import * as dotenv from 'dotenv';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

import { World, Agent, Parcel } from "./BDI/Belief.ts";
import type { Position } from "./BDI/Belief.ts";
import { Desire, generateDesires, effectiveDeliveryMultiplier } from "./BDI/Desire.ts";
import type { StackConstraint } from "./BDI/Desire.ts";
import { reviseIntention } from "./BDI/Intentions.ts";
import * as utils from "./utils.ts";
import { getPddlPath } from "./pddl_planner.ts";
import type { LLMClient, LLMUpdate } from "./LLM/llm.ts";

dotenv.config();

const USE_PDDL           = process.env.USE_PDDL === 'true';
const USE_LLM_ARG        = process.argv.includes('--use-llm');
const USE_LLM_EFFECTIVE  = USE_LLM_ARG || process.env.USE_LLM === 'true';
const DEBUG              = process.env.DEBUG === 'true' || process.argv.includes('--debug');
const IS_MASTER          = process.env.IS_MASTER === 'true';

const tokenArg = process.argv.find(arg => arg.startsWith('--token='));
const TOKEN              = tokenArg
  ? tokenArg.split('=')[1]
  : (USE_LLM_EFFECTIVE ? process.env.AGENT_TOKEN_LLM : process.env.AGENT_TOKEN_BDI);

const debug = (msg: string) => DEBUG && console.log(msg);

console.log(`[Planner] ${USE_PDDL ? 'PDDL local (Fast Downward)' : 'BFS (default)'}`);
console.log(`[LLM]     ${USE_LLM_EFFECTIVE ? 'enabled' : 'disabled'}`);
console.log(`[Role]    ${IS_MASTER ? 'master (processes LLM, forwards to slave)' : 'slave (receives from master)'}`);

const socket = DjsConnect(process.env.HOST as string, TOKEN as string);

// ── BDI state ─────────────────────────────────────────────────────────────────
let myAgent: Agent | undefined;
let worldMap: World | undefined;
let carrying: Parcel[]            = [];
let currentIntention: Desire | null = null;
let lastIntention: Desire | null    = null;
let currentPath: string[] | null    = null;
let isRunning = false;
let agentObsDistance    = 0;
let movementDuration    = 0;
let parcelDecayInterval = 0;

const spawnVisitLog       = new Map<string, number>();   // "x,y" -> last-visited ms
const recentlyFailedCells = new Set<string>();           // cells that failed emitMove this tick
const positionHistory: Position[] = [];                  // last N positions for bounce detection
const tempBlockedCells    = new Map<string, number>();   // "x,y" -> unblock ms (bounce)
const intentionStuckTicks = new Map<string, number>();   // intention key -> consecutive stuck ticks
const blockedIntentions   = new Map<string, number>();   // intention key -> unblock ms

let stepsSinceSwitch = 999;
let bdiTick          = 0;

const STUCK_THRESHOLD    = 3;
const INTENTION_BLOCK_MS = 8_000;
// ── LLM state ─────────────────────────────────────────────────────────────────
// This is basically the belief state for the LLM

const godName = "admin";
let useLLM = USE_LLM_EFFECTIVE;
let llm: LLMClient | null = null;
let llmBlockedTiles: Set<string> = new Set();
const llmPendingMissions: Desire[] = [];
let llmActiveMission: Desire | null = null;
const llmDeliveryBonusTiles = new Map<string, number>(); // "x,y" → multiplier
const llmBlockedDeliveryTiles = new Set<string>();       // delivery target blocked, traversal allowed
const llmStackConstraints: StackConstraint[] = [];       // stack-size → reward multiplier rules

// ── Multi-agent state ──────────────────────────────────────────────────────────
let partnerAgentId: string | null = process.env.PARTNER_ID ?? null;
let rendezvousMaxDist = 3;
let rendezvousInRange = false;      // self is within range of rendezvous target
let rendezvousPartnerArrived = false; // partner signalled its arrival

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearIntention(): void {
    currentIntention = null;
    lastIntention    = null;
    currentPath      = null;
}

function sameMission(a: Desire | null, b: Desire | null): boolean {
    return !!a && !!b &&
        a.type === b.type &&
        a.x_target === b.x_target &&
        a.y_target === b.y_target;
}

function missionKey(mission: Desire): string {
    return `${mission.type}:${mission.x_target},${mission.y_target}`;
}

function completeActiveMission(reason: string): void {
    if (!llmActiveMission) return;
    console.log(`[LLM] Atomic mission completed (${reason}): ${missionKey(llmActiveMission)}`);
    llmActiveMission = null;
}

// Eagerly initialize the LLM client in the background so libraries are
// already loaded by the time the first chat message arrives.
if (USE_LLM_EFFECTIVE) {
    (async () => {
        try {
            const { LLMClient: LC } = await import("./LLM/llm.ts");
            llm = await LC.create();
            console.log("[LLM] Client ready");
        } catch (err) {
            console.error("[LLM] init failed:", err instanceof Error ? err.message : err);
        }
    })();
}

function findNearestOddRowTile(): Position | null {
    if (!myAgent || !worldMap) return null;
    let best: Position | null = null;
    let bestDist = Infinity;
    for (const key of worldMap.tiles.keys()) {
        const [x, y] = key.split(',').map(Number);
        if (y % 2 === 1) {
            const dist = Math.abs(x - myAgent.pos.x) + Math.abs(y - myAgent.pos.y);
            if (dist < bestDist) { bestDist = dist; best = { x, y }; }
        }
    }
    return best;
}

function findDirectionalDeliveryTile(direction: string): { x: number; y: number } | null {
    if (!worldMap) return null;
    const tiles = [...worldMap.tiles.entries()]
        .filter(([, t]) => t === '2')
        .map(([key]) => { const [x, y] = key.split(',').map(Number); return { x, y }; });
    if (tiles.length === 0) return null;
    switch (direction) {
        case 'leftmost':  return tiles.reduce((a, b) => a.x < b.x ? a : b);
        case 'rightmost': return tiles.reduce((a, b) => a.x > b.x ? a : b);
        case 'topmost':   return tiles.reduce((a, b) => a.y < b.y ? a : b);
        case 'bottommost':return tiles.reduce((a, b) => a.y > b.y ? a : b);
        default: return null;
    }
}

function applyLLMUpdates(updates: LLMUpdate): void {
    for (const tile of updates.goToTiles) {
        console.log(`[LLM] new go_to mission: (${tile.x},${tile.y}) u=${tile.utility}`);
        llmPendingMissions.push(new Desire("go_to", tile.x, tile.y, tile.utility));
    }
    for (const tileKey of updates.blockedTiles) {
        console.log(`[LLM] blocking tile: ${tileKey}`);
        llmBlockedTiles.add(tileKey);
    }
    for (const bonus of updates.deliveryBonusTiles) {
        const key = `${bonus.x},${bonus.y}`;
        llmDeliveryBonusTiles.set(key, bonus.multiplier);
        console.log(`[LLM] delivery bonus: (${bonus.x},${bonus.y}) x${bonus.multiplier}`);
    }
    for (const key of updates.blockedDeliveryTiles) {
        llmBlockedDeliveryTiles.add(key);
        console.log(`[LLM] blocked delivery tile: ${key}`);
    }
    for (const constraint of updates.deliveryConstraints) {
        const tile = findDirectionalDeliveryTile(constraint.direction);
        if (!tile) { console.log(`[LLM] delivery constraint: tile ${constraint.direction} not found`); continue; }
        if (constraint.points < 0) {
            console.log(`[LLM] blocking delivery tile (${tile.x},${tile.y}) dir=${constraint.direction}`);
            llmBlockedTiles.add(`${tile.x},${tile.y}`);
        } else {
            console.log(`[LLM] new go_delivery mission: (${tile.x},${tile.y}) dir=${constraint.direction} pts=${constraint.points}`);
            llmPendingMissions.push(new Desire("go_delivery", tile.x, tile.y, constraint.points));
        }
    }
    for (const constraint of updates.stackConstraints) {
        const op = constraint.operator as StackConstraint['operator'];
        const existing = llmStackConstraints.findIndex(c => c.count === constraint.count && c.operator === op);
        if (existing >= 0) llmStackConstraints[existing] = { count: constraint.count, operator: op, multiplier: constraint.multiplier };
        else llmStackConstraints.push({ count: constraint.count, operator: op, multiplier: constraint.multiplier });
        console.log(`[LLM] stack constraint: ${op} ${constraint.count} parcels → x${constraint.multiplier}`);
    }
    if (updates.multiAgentCommand) {
        const cmd = updates.multiAgentCommand;
        if (cmd.type === 'rendezvous') {
            rendezvousMaxDist = cmd.maxDist;
            rendezvousInRange = false;
            rendezvousPartnerArrived = false;
            const utility = cmd.points > 0 ? cmd.points : 9999;
            llmPendingMissions.push(new Desire('rendezvous', cmd.x, cmd.y, utility));
            console.log(`[Multi-agent] rendezvous at (${cmd.x},${cmd.y}) maxDist=${rendezvousMaxDist} pts=${utility}`);
        } else if (cmd.type === 'wait_odd_row') {
            if (llmActiveMission?.type !== 'wait_odd_row' && !llmPendingMissions.some(m => m.type === 'wait_odd_row')) {
                llmPendingMissions.push(new Desire('wait_odd_row', 0, 0, 9999));
                console.log('[Multi-agent] wait_odd_row queued');
            }
        } else if (cmd.type === 'resume') {
            if (llmActiveMission?.type === 'wait_odd_row') {
                llmActiveMission = null;
                clearIntention();
                console.log('[Multi-agent] resume: cleared wait_odd_row mission');
            }
            const idx = llmPendingMissions.findIndex(m => m.type === 'wait_odd_row');
            if (idx >= 0) llmPendingMissions.splice(idx, 1);
        }
    }
}

function handleNoPath(key: string, label: string): void {
    const ticks = (intentionStuckTicks.get(key) ?? 0) + 1;
    intentionStuckTicks.set(key, ticks);
    if (ticks >= STUCK_THRESHOLD) {
        blockedIntentions.set(key, Date.now() + INTENTION_BLOCK_MS);
        intentionStuckTicks.delete(key);
        debug(`[Stuck] No path: blocking "${key}" for ${INTENTION_BLOCK_MS / 1000}s`);
    } else {
        debug(`No path to ${label} (${ticks}/${STUCK_THRESHOLD}).`);
    }
    currentIntention = null;
    lastIntention    = null;
}

async function planPath(start: Position, target: Position): Promise<string[] | null> {
    if (!worldMap) return null;
    const now     = Date.now();
    const blocked = new Set([...tempBlockedCells.entries()].filter(([, u]) => u > now).map(([k]) => k));

    // Return BFS path immediately so the agent is never frozen while the PDDL
    // subprocess starts up. PDDL runs in the background; when it resolves it
    // replaces currentPath only if the agent hasn't moved yet (same start tile)
    // and is still pursuing the same intention target.
    const bfsPath = utils.get_shortest_path(start, target, worldMap, blocked);

    if (USE_PDDL) {
        const capturedType = currentIntention?.type;
        const capturedTx   = target.x;
        const capturedTy   = target.y;
        const wm = worldMap;
        const bl = new Set(blocked);
        debug(`[PDDL] ${start.x},${start.y} -> ${target.x},${target.y}`);
        getPddlPath(start, target, wm, bl).then(pddlPath => {
            if (!pddlPath || isRunning) return;
            const sameTarget =
                currentIntention?.type     === capturedType &&
                currentIntention?.x_target === capturedTx   &&
                currentIntention?.y_target === capturedTy;
            if (sameTarget && myAgent?.pos.x === start.x && myAgent?.pos.y === start.y) {
                debug(`[PDDL] path applied (${pddlPath.length} steps)`);
                currentPath = pddlPath;
            }
        }).catch(() => {});
    }

    return bfsPath;
}

async function resilientMove(direction: string, nextPos: Position): Promise<Position | null> {
    const key = `${nextPos.x},${nextPos.y}`;
    if (recentlyFailedCells.has(key)) return null;
    if (worldMap && utils.is_collision_predicted(nextPos.x, nextPos.y, worldMap.other_agents)) {
        debug(`Predicted collision at (${nextPos.x},${nextPos.y}), replanning.`);
        currentPath = null;
        return null;
    }
    let result: { x: number; y: number } | null | false = null;
    try {
        result = await socket.emitMove(direction);
    } catch {
        // emitMove timed out (server didn't ack within 1s) — treat as failed move
    }
    if (result) {
        // console.log(`Moved ${direction} to (${result.x},${result.y})`);
        return { x: result.x, y: result.y };
    }
    // console.log(`Move ${direction} failed at (${nextPos.x},${nextPos.y}).`);
    recentlyFailedCells.add(key);
    currentPath = null;
    return null;
}

async function stepTowards(dir: string, nextPos: Position): Promise<boolean> {
    if ([...worldMap!.crates.values()].some(c => c.pos.x === nextPos.x && c.pos.y === nextPos.y)) {
        currentPath = null;
        return false;
    }
    const result = await resilientMove(dir, nextPos);
    if (result) {
        myAgent!.pos.x = result.x;
        myAgent!.pos.y = result.y;
        currentPath!.shift();
        return true;
    }
    return false;
}

// ── Socket events ─────────────────────────────────────────────────────────────

socket.onConnect(() => console.log("Connected"));

socket.onDisconnect(() => {
    console.log("Disconnected");
    if (mainLoop) clearInterval(mainLoop);
});

socket.onConfig((config: any) => {
    if (!config?.GAME?.player) { console.error("Invalid config:", config); return; }
    movementDuration    = config.GAME.player.movement_duration;
    agentObsDistance    = config.GAME.player.observation_distance;
    const m             = (config.GAME.parcels?.decaying_event ?? '').match(/(\d+(?:\.\d+)?)s$/);
    parcelDecayInterval = m ? parseFloat(m[1]) * 1000 : Infinity;
    console.log(`Config: move=${movementDuration}ms obs=${agentObsDistance} decay=${parcelDecayInterval}ms`);
});

socket.onYou((agent: any) => {
    if (!myAgent) myAgent = new Agent({ id: agent.id, x: agent.x, y: agent.y });
    else { myAgent.pos.x = agent.x; myAgent.pos.y = agent.y; }
});

socket.onMap((width: number, height: number, tiles: any[]) => {
    worldMap = new World(width, height, tiles, movementDuration, parcelDecayInterval);
    console.log(`Map: ${width + 1}x${height + 1}, ${tiles.length} tiles`);
});

socket.onSensing((sensing: any) => {
    if (!myAgent || !worldMap) return;

    worldMap.update_parcels(sensing.parcels);
    worldMap.update_crates(sensing.crates);
    worldMap.update_agents(sensing.agents);

    // Drop carried parcels that expired or were stolen or are visibly on the ground
    const sensingMap = new Map<string, any>(sensing.parcels.map((p: any) => [p.id, p]));
    carrying = carrying.filter(c => {
        const sp = sensingMap.get(c.id);
        if (!sp) return true;                                            // off-map: still carrying
        if (sp.reward <= 0) return false;                               // expired
        if (sp.carriedBy !== myAgent!.id) return false;                 // on ground or stolen
        return true;
    });

    recentlyFailedCells.clear();

    // Bounce detection: detect ABAB oscillation and block the two alternating positions
    const last = positionHistory.at(-1);
    if (!last || last.x !== myAgent.pos.x || last.y !== myAgent.pos.y) {
        positionHistory.push({ x: myAgent.pos.x, y: myAgent.pos.y });
        if (positionHistory.length > 8) positionHistory.shift();
    }
    if (positionHistory.length >= 4) {
        const n = positionHistory.length;
        const [pa, pb, pc, pd] = [positionHistory[n-4], positionHistory[n-3], positionHistory[n-2], positionHistory[n-1]];
        if (pa.x === pc.x && pa.y === pc.y && pb.x === pd.x && pb.y === pd.y) {
            const until = Date.now() + 4_000;
            tempBlockedCells.set(`${pa.x},${pa.y}`, until);
            tempBlockedCells.set(`${pb.x},${pb.y}`, until);
            clearIntention();
            positionHistory.length = 0;
            debug(`[Bounce] ABAB (${pa.x},${pa.y})<->(${pb.x},${pb.y}), blocking 4s`);
        }
    }

    bdiStep();
});

socket.onMsg( async (id: string, name: string, msg: any, reply: ((response: any) => void) | undefined) => {
    // Peer message from partner agent (JSON with kind: 'LLM_UPDATE')
    if (name !== godName) {
        debug(`[Multi-agent] Raw peer message from ${id} (${name}): ${typeof msg} length=${String(msg).length}`);
        
        // Auto-discover partner on first non-admin message
        if (!partnerAgentId) {
            partnerAgentId = id;
            console.log(`[Multi-agent] Partner discovered: ${partnerAgentId} (${name})`);
        }
        
        if (id === partnerAgentId) {
            try {
                const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);
                const peerMsg = JSON.parse(msgStr);
                debug(`[Multi-agent] Parsed peer message: ${JSON.stringify(peerMsg).substring(0, 100)}`);
                
                if (peerMsg.kind === 'LLM_UPDATE') {
                    console.log('[Multi-agent] Received LLM update from master, applying to BDI');
                    applyLLMUpdates(peerMsg.updates);
                } else if (peerMsg.kind === 'RENDEZVOUS_ARRIVED') {
                    console.log('[Multi-agent] Partner arrived at rendezvous point');
                    rendezvousPartnerArrived = true;
                    // If we're already in range waiting, complete now
                    if (rendezvousInRange && llmActiveMission?.type === 'rendezvous') {
                        console.log('[Rendezvous] Both agents in range, completing mission');
                        completeActiveMission('rendezvous-both-arrived');
                        clearIntention();
                        rendezvousInRange = false;
                        rendezvousPartnerArrived = false;
                    }
                } else {
                    debug(`[Multi-agent] Peer message has unexpected kind: ${peerMsg.kind}`);
                }
            } catch (err) {
                console.warn('[Multi-agent] Failed to parse peer message:', err instanceof Error ? err.message : err);
                debug(`[Multi-agent] Message was: ${String(msg).substring(0, 200)}`);
            }
        } else {
            debug(`[Multi-agent] Ignoring message from ${id}; expected partner ${partnerAgentId}`);
        }
        return;
    }

    // Admin message — only the master processes via LLM
    if (!useLLM || !IS_MASTER) return;
    if (!llm) { console.log("[LLM] client not ready yet, skipping message"); return; }

    console.log(`[LLM] msg from ${name}(${id}): "${msg}"`);

    try {
        const result = await llm.processMessage(msg, myAgent ? { x: myAgent.pos.x, y: myAgent.pos.y } : null);
        console.log(`[LLM] reply: "${result.reply || "(none)"}"`);

        applyLLMUpdates(result.updates);

        // Forward processed updates to slave BEFORE calling reply() to avoid socket state issues
        if (partnerAgentId) {
            try {
                await socket.emitSay(partnerAgentId, JSON.stringify({ kind: 'LLM_UPDATE', updates: result.updates }));
                console.log(`[Multi-agent] Forwarded LLM update to slave ${partnerAgentId}`);
            } catch (err) {
                console.warn('[Multi-agent] Failed to forward update to slave:', err instanceof Error ? err.message : err);
            }
        } else {
            console.log('[Multi-agent] No partner known yet — update not forwarded');
        }

        // Send reply to admin AFTER forwarding to slave
        if (result.reply) {
            if (reply) {
                reply(result.reply);
            } else {
                socket.emitShout(result.reply);
            }
        }
    } catch (err) {
        console.error("[LLM] processMessage error (agent continues):", err instanceof Error ? err.message : err);
    }
});

// ── BDI loop ──────────────────────────────────────────────────────────────────

async function bdiStep(): Promise<void> {
    if (!socket.connected || !myAgent || !worldMap || isRunning) return;
    isRunning = true;

    const prevPos = { x: myAgent.pos.x, y: myAgent.pos.y };
    const prevKey = currentIntention
        ? `${currentIntention.type}:${currentIntention.x_target},${currentIntention.y_target}`
        : null;

    try {
        // Priority: deliver immediately if standing on a delivery tile (skip LLM-blocked tiles or
        // when a higher-multiplier bonus tile exists elsewhere — consistent with line 400 utility*m)
        const currentTileKey = `${myAgent.pos.x},${myAgent.pos.y}`;
        const currentMultiplier = llmDeliveryBonusTiles.get(currentTileKey) ?? 1;
        const bestMultiplier = llmDeliveryBonusTiles.size > 0
            ? Math.max(...llmDeliveryBonusTiles.values()) : 1;
        const betterBonusTileExists = bestMultiplier > currentMultiplier;
        const stackMult = effectiveDeliveryMultiplier(carrying.length, llmStackConstraints, worldMap.parcels.size);
        if (carrying.length > 0 && utils.tile_is('delivery', myAgent.pos, worldMap.tiles) &&
            !llmBlockedDeliveryTiles.has(currentTileKey) &&
            !betterBonusTileExists &&
            stackMult >= 0.5) {
            const res = await socket.emitPutdown();
            if (res) {
                console.log(`[Priority] Delivered ${carrying.length} parcel(s) at (${myAgent.pos.x},${myAgent.pos.y})`);
                carrying.length = 0;
                if (llmActiveMission && llmActiveMission.type === 'go_delivery' &&
                    llmActiveMission.x_target === myAgent.pos.x && llmActiveMission.y_target === myAgent.pos.y) {
                    completeActiveMission('priority-delivery');
                }
                clearIntention();
            }
            return;
        }

        // Activate exactly one LLM mission at a time; each mission is consumed once.
        if (!llmActiveMission && llmPendingMissions.length > 0) {
            llmActiveMission = llmPendingMissions.shift() ?? null;
            if (llmActiveMission) {
                console.log(`[LLM] Atomic mission activated: ${missionKey(llmActiveMission)}`);
            }
        }
        if (llmActiveMission && !sameMission(currentIntention, llmActiveMission)) {
            currentIntention = llmActiveMission;
            currentPath      = null;
            lastIntention    = null;
        }

        // ── Desire generation ─────────────────────────────────────────────────
        const now = Date.now();
        let activeBlocked = new Set([
            ...[...tempBlockedCells.entries()].filter(([, u]) => u > now).map(([k]) => k),
            ...[...worldMap.other_agents.values()].filter(a => a.stationaryTicks >= 3).map(a => `${a.pos.x},${a.pos.y}`),
        ]);
        
        if (llmBlockedTiles.size > 0) { // Add the LLM blocked tiles
            for (const tile of llmBlockedTiles) {
                activeBlocked.add(tile);
            }
        }
        
        let desires = generateDesires(myAgent, worldMap, carrying, spawnVisitLog, activeBlocked, [], new Set(llmDeliveryBonusTiles.keys()), llmStackConstraints);

        // Apply LLM delivery tile preferences: boost bonus tiles, drop blocked delivery targets
        if (llmDeliveryBonusTiles.size > 0 || llmBlockedDeliveryTiles.size > 0) {
            desires = desires.flatMap(d => {
                if (d.type !== 'go_delivery') return [d];
                const key = `${d.x_target},${d.y_target}`;
                if (llmBlockedDeliveryTiles.has(key)) return [];
                const m = llmDeliveryBonusTiles.get(key);
                if (m) return [{ ...d, utility: d.utility * m }];
                return [d];
            }).sort((a, b) => b.utility - a.utility);
        }


        // ── Intention revision ────────────────────────────────────────────────
        const prevIntention  = currentIntention;
        let switched = false;
        if (llmActiveMission) {
            currentIntention = llmActiveMission;
            switched =
                !prevIntention ||
                currentIntention.type      !== prevIntention.type ||
                currentIntention.x_target  !== prevIntention.x_target ||
                currentIntention.y_target  !== prevIntention.y_target;
        } else {
            currentIntention = reviseIntention(currentIntention, desires, worldMap, carrying, stepsSinceSwitch);
            switched =
                !currentIntention || !prevIntention ||
                currentIntention.type      !== prevIntention.type ||
                currentIntention.x_target  !== prevIntention.x_target ||
                currentIntention.y_target  !== prevIntention.y_target;
        }
        stepsSinceSwitch = switched ? 0 : stepsSinceSwitch + 1;

        // Refresh stored utility with current tick value
        if (currentIntention && !sameMission(currentIntention, llmActiveMission)) {
            const match = desires.find(d =>
                d.type     === currentIntention!.type &&
                d.x_target === currentIntention!.x_target &&
                d.y_target === currentIntention!.y_target,
            );
            if (match) currentIntention.utility = match.utility;
        }

        // If go_pickup/go_delivery target vanished from desires (parcel expired/stolen),
        // clear immediately rather than walking toward a ghost.
        if (currentIntention && currentIntention.type !== 'explore' && !sameMission(currentIntention, llmActiveMission)) {
            const stillValid = desires.some(d =>
                d.type     === currentIntention!.type &&
                d.x_target === currentIntention!.x_target &&
                d.y_target === currentIntention!.y_target,
            );
            if (!stillValid) {
                debug(`[BDI] target gone: ${currentIntention.type}@(${currentIntention.x_target},${currentIntention.y_target})`);
                clearIntention();
            }
        }

        if (!currentIntention) return;

        // Expire stale blocks; skip if current intention is blocked, try fallback
        for (const [k, u] of blockedIntentions) if (u <= now) blockedIntentions.delete(k);
        const intentionKey = `${currentIntention.type}:${currentIntention.x_target},${currentIntention.y_target}`;
        if (blockedIntentions.has(intentionKey)) {
            if (sameMission(currentIntention, llmActiveMission)) {
                console.log(`[LLM] Atomic mission blocked: ${intentionKey}`);
                completeActiveMission('blocked');
                clearIntention();
            } else {
                const fallback = desires.find(d => !blockedIntentions.has(`${d.type}:${d.x_target},${d.y_target}`));
                currentIntention = fallback ?? null;
                if (!currentIntention) lastIntention = null;
            }
        }

        if (!currentIntention) {
            // Release soonest-expiring block so the agent doesn't freeze for the full INTENTION_BLOCK_MS.
            // Prefer explore blocks; pickup blocks on physically-blocked tiles are more expensive to retry.
            const sorted  = [...blockedIntentions.entries()].sort(([, a], [, b]) => a - b);
            const release = sorted.find(([k]) => k.startsWith('explore:')) ?? sorted[0];
            if (release) { blockedIntentions.delete(release[0]); debug(`[BDI] all blocked, releasing ${release[0]}`); }
            else          { debug('[BDI] no active intention'); }
            return;
        }

        // ── BDI status log ────────────────────────────────────────────────────
        bdiTick++;
        if (switched || bdiTick % 5 === 0) {
            const top     = desires.slice(0, 4).map(d => `${d.type}@(${d.x_target},${d.y_target})=${d.utility.toFixed(2)}`).join(' | ');
            const blocked = [...blockedIntentions.keys()].join(', ');
            debug(
                `[BDI] #${bdiTick} ${currentIntention.type}@(${currentIntention.x_target},${currentIntention.y_target})` +
                ` u=${currentIntention.utility.toFixed(2)} carry=${carrying.length}` +
                `\n  desires: ${top || 'none'}` +
                (blocked ? `\n  blocked: ${blocked}` : ''),
            );
        }

        // Invalidate cached path when the intention target changes
        if (currentIntention.type     !== lastIntention?.type ||
            currentIntention.x_target !== lastIntention?.x_target ||
            currentIntention.y_target !== lastIntention?.y_target) {
            currentPath   = null;
            lastIntention = currentIntention;
        }

        // ── Intention execution ───────────────────────────────────────────────

        if (currentIntention.type === 'go_pickup') {
            if (myAgent.pos.x === currentIntention.x_target && myAgent.pos.y === currentIntention.y_target) {
                // Snapshot worldMap parcels BEFORE pickup: emitPickup returns raw server-side
                // Parcel class instances whose `id` is a private field (not in JSON serialization),
                // so we must use our own belief-state parcels which have proper plain-object fields.
                const toPickup = [...worldMap.parcels.values()].filter(
                    p => p.pos.x === currentIntention!.x_target &&
                         p.pos.y === currentIntention!.y_target &&
                         !p.carriedBy,
                );
                const res = await socket.emitPickup();
                if (res) {
                    for (const p of toPickup)
                        if (!carrying.some(c => c.id === p.id)) carrying.push(p);
                    debug(toPickup.length > 0
                        ? `Picked up ${toPickup.length} parcel(s) at (${myAgent.pos.x},${myAgent.pos.y})`
                        : `No parcel at (${myAgent.pos.x},${myAgent.pos.y})`);
                }
                worldMap.removeParcelAt({ x: currentIntention.x_target, y: currentIntention.y_target });
                clearIntention();
                return;
            }
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, { x: currentIntention.x_target, y: currentIntention.y_target });
            if (!currentPath?.length) {
                handleNoPath(`go_pickup:${currentIntention.x_target},${currentIntention.y_target}`, 'parcel');
                return;
            }
            await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));

        } else if (currentIntention.type === 'go_delivery') {
            if (myAgent.pos.x === currentIntention.x_target && myAgent.pos.y === currentIntention.y_target) {
                const res = await socket.emitPutdown();
                if (res) {
                    console.log(`Delivered at (${myAgent.pos.x},${myAgent.pos.y})`);
                    carrying.length = 0;
                    if (sameMission(currentIntention, llmActiveMission)) completeActiveMission('reached-target');
                }
                clearIntention();
                return;
            }
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, { x: currentIntention.x_target, y: currentIntention.y_target });
            if (!currentPath?.length) {
                const failed = currentIntention;
                handleNoPath(`go_delivery:${currentIntention.x_target},${currentIntention.y_target}`, 'delivery');
                if (sameMission(failed, llmActiveMission)) completeActiveMission('no-path');
                return;
            }
            await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));

        } else if (currentIntention.type === 'explore') {
            const target = { x: currentIntention.x_target, y: currentIntention.y_target };
            if (utils.get_distance(myAgent.pos, target) <= agentObsDistance) {
                spawnVisitLog.set(`${target.x},${target.y}`, Date.now());
                debug(`[Explore] Visited (${target.x},${target.y})`);
                currentIntention = null;
                lastIntention    = null;
                return;
            }
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, target);
            if (!currentPath?.length) {
                spawnVisitLog.set(`${target.x},${target.y}`, Date.now());
                clearIntention();
                return;
            }
            await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));

        } else if (currentIntention.type === 'go_to') {
            if (myAgent.pos.x === currentIntention.x_target && myAgent.pos.y === currentIntention.y_target) {
                console.log(`[go_to] Reached (${currentIntention.x_target},${currentIntention.y_target}), removing desire`);
                if (sameMission(currentIntention, llmActiveMission)) completeActiveMission('reached-target');
                clearIntention();
                return;
            }
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, { x: currentIntention.x_target, y: currentIntention.y_target });
            if (!currentPath?.length) {
                const failed = currentIntention;
                handleNoPath(`go_to:${currentIntention.x_target},${currentIntention.y_target}`, `(${currentIntention.x_target},${currentIntention.y_target})`);
                if (sameMission(failed, llmActiveMission)) completeActiveMission('no-path');
                return;
            }
            await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));

        } else if (currentIntention.type === 'rendezvous') {
            const dist = utils.get_distance(myAgent.pos, { x: currentIntention.x_target, y: currentIntention.y_target });
            if (dist <= rendezvousMaxDist) {
                if (!rendezvousInRange) {
                    rendezvousInRange = true;
                    console.log(`[Rendezvous] In range at (${myAgent.pos.x},${myAgent.pos.y}), dist=${dist}, signaling partner`);
                    if (partnerAgentId) {
                        socket.emitSay(partnerAgentId, JSON.stringify({ kind: 'RENDEZVOUS_ARRIVED' }))
                            .catch((err: unknown) => console.warn('[Rendezvous] Failed to signal partner:', err));
                    } else {
                        // No partner - complete immediately
                        rendezvousPartnerArrived = true;
                    }
                }
                if (rendezvousPartnerArrived) {
                    console.log(`[Rendezvous] Both agents in range, completing mission`);
                    if (sameMission(currentIntention, llmActiveMission)) completeActiveMission('rendezvous-both-arrived');
                    clearIntention();
                    rendezvousInRange = false;
                    rendezvousPartnerArrived = false;
                    return;
                }
                // Waiting for partner — hold position
                debug(`[Rendezvous] Holding at (${myAgent.pos.x},${myAgent.pos.y}), waiting for partner`);
                return;
            }
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, { x: currentIntention.x_target, y: currentIntention.y_target });
            if (!currentPath?.length) {
                const failed = currentIntention;
                handleNoPath(`rendezvous:${currentIntention.x_target},${currentIntention.y_target}`, 'rendezvous target');
                if (sameMission(failed, llmActiveMission)) completeActiveMission('no-path');
                rendezvousInRange = false;
                return;
            }
            await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));

        } else if (currentIntention.type === 'wait_odd_row') {
            if (myAgent.pos.y % 2 === 1) {
                // On an odd row — hold position until resume command
                debug(`[Wait] Holding at odd row y=${myAgent.pos.y}`);
                return;
            }
            // Navigate to nearest odd-row tile
            const oddTarget = findNearestOddRowTile();
            if (!oddTarget) { clearIntention(); return; }
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, oddTarget);
            if (!currentPath?.length) { clearIntention(); return; }
            await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));
        }

    } catch (err) {
        console.error(err);
    } finally {
        // Physical stuck detection: block intention if agent held same intention but didn't move
        // Skip for wait_odd_row and rendezvous-in-range — the agent intentionally holds position
        if (prevKey && myAgent && currentIntention?.type !== 'wait_odd_row' && !(currentIntention?.type === 'rendezvous' && rendezvousInRange)) {
            const didMove    = myAgent.pos.x !== prevPos.x || myAgent.pos.y !== prevPos.y;
            const currentKey = currentIntention
                ? `${currentIntention.type}:${currentIntention.x_target},${currentIntention.y_target}`
                : null;
            const sameIntention = currentKey === prevKey;
            const atTarget = sameIntention && currentIntention != null &&
                myAgent.pos.x === currentIntention.x_target && myAgent.pos.y === currentIntention.y_target;

            if (didMove || atTarget) {
                intentionStuckTicks.delete(prevKey);
            } else if (sameIntention) {
                const ticks = (intentionStuckTicks.get(prevKey) ?? 0) + 1;
                intentionStuckTicks.set(prevKey, ticks);
                if (ticks >= STUCK_THRESHOLD) {
                    blockedIntentions.set(prevKey, Date.now() + INTENTION_BLOCK_MS);
                    intentionStuckTicks.delete(prevKey);
                    debug(`[Stuck] No progress: blocking "${prevKey}" for ${INTENTION_BLOCK_MS / 1000}s`);
                    if (llmActiveMission && prevKey === missionKey(llmActiveMission)) {
                        completeActiveMission('stuck');
                    }
                    clearIntention();
                }
            }
        }
        isRunning = false;
    }
}

const mainLoop = setInterval(() => bdiStep(), 500);
