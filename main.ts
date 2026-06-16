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

// Parcel handoff state
let handoffRole: 'picker' | 'deliverer' | null = null;
let handoffPhase: 'pickup' | 'approach' | 'idle' = 'idle';
let handoffSlavePos: Position | null = null;   // slave's self-reported position for meeting point
let handoffWaitStart: number | null = null;    // when picker started waiting for slave pos
let handoffWaitAtMeetStart: number | null = null; // when slave arrived at meeting tile

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


function computeMeetingPoint(posA: Position, posB: Position, blocked: Set<string>): Position | null {
    if (!worldMap) return null;
    const finderA = utils.bfsFlood(posA, worldMap.tiles, worldMap.crates, blocked);
    const finderB = utils.bfsFlood(posB, worldMap.tiles, worldMap.crates, blocked);
    let best: Position | null = null;
    let bestSum = Infinity;
    
    // Prefer intermediate tiles (dA>0 && dB>0) so neither agent is already there
    for (const key of worldMap.tiles.keys()) {
        const tileType = worldMap.tiles.get(key);
        // FIX: Allow both regular (0) and spawning (1) tiles. Strictly forbid delivery (2).
        if (tileType !== '0' && tileType !== '1') continue; 
        
        const [x, y] = key.split(',').map(Number);
        const dA = finderA.getDistance({ x, y });
        const dB = finderB.getDistance({ x, y });
        if (dA === Infinity || dB === Infinity || dA === 0 || dB === 0) continue;
        if (dA + dB < bestSum) { bestSum = dA + dB; best = { x, y }; }
    }
    if (best) return best;
    
    // Fallback: agents are adjacent
    for (const key of worldMap.tiles.keys()) {
        const tileType = worldMap.tiles.get(key);
        // FIX: Apply the same broad rule here
        if (tileType !== '0' && tileType !== '1') continue; 
        
        const [x, y] = key.split(',').map(Number);
        const dA = finderA.getDistance({ x, y });
        const dB = finderB.getDistance({ x, y });
        if (dA === Infinity || dB === Infinity) continue;
        if (dA + dB < bestSum) { bestSum = dA + dB; best = { x, y }; }
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
        const mode = (constraint.mode ?? 'count') as StackConstraint['mode'];
        const existing = llmStackConstraints.findIndex(c => c.count === constraint.count && c.operator === op && (c.mode ?? 'count') === mode);
        const entry: StackConstraint = { count: constraint.count, operator: op, multiplier: constraint.multiplier, mode };
        if (existing >= 0) llmStackConstraints[existing] = entry;
        else llmStackConstraints.push(entry);
        const label = mode === 'score' ? 'score' : 'parcels';
        console.log(`[LLM] stack constraint: ${op} ${constraint.count} ${label} → x${constraint.multiplier}`);
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
        } else if (cmd.type === 'wait_row') {
            if (llmActiveMission?.type !== 'wait_row' && !llmPendingMissions.some(m => m.type === 'wait_row')) {
                llmPendingMissions.push(new Desire('wait_row', 0, 0, 9999, cmd.parity));
                console.log(`[Multi-agent] wait_row (${cmd.parity}) queued`);
            }
        } else if (cmd.type === 'resume') {
            if (llmActiveMission?.type === 'wait_row') {
                llmActiveMission = null;
                clearIntention();
                console.log('[Multi-agent] resume: cleared wait_row mission');
            }
            const idx = llmPendingMissions.findIndex(m => m.type === 'wait_row');
            if (idx >= 0) llmPendingMissions.splice(idx, 1);
        } else if (cmd.type === 'parcel_handoff') {
            const utility = cmd.points > 0 ? cmd.points : 9999;
            if (IS_MASTER) {
                handoffRole = 'picker';
                handoffPhase = 'pickup';
                handoffSlavePos = null;
                handoffWaitStart = null;
                console.log(`[Handoff] Role: picker — normal BDI will acquire parcel, then meet slave (pts=${utility})`);
            } else {
                handoffRole = 'deliverer';
                handoffPhase = 'idle';
                console.log('[Handoff] Role: deliverer — waiting for picker signal');
                // Report our position to the picker so it can compute the meeting point
                if (partnerAgentId && myAgent) {
                    socket.emitSay(partnerAgentId, JSON.stringify({
                        kind: 'HANDOFF_SLAVE_POS', x: myAgent.pos.x, y: myAgent.pos.y,
                    })).catch((err: unknown) => console.warn('[Handoff] Failed to report position:', err));
                }
            }
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
        currentPath?.shift();
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

    // If a parcel is in our memory, AND it is within our physical field of vision, 
    // BUT the server didn't just send it in `sensingMap`, it means it was stolen or destroyed.
    for (const [id, memParcel] of worldMap.parcels.entries()) {
        const distToMem = Math.abs(myAgent.pos.x - memParcel.pos.x) + Math.abs(myAgent.pos.y - memParcel.pos.y);
        if (distToMem <= agentObsDistance && !sensingMap.has(id)) {
            worldMap.parcels.delete(id);
            // debug(`[Belief] Purged phantom parcel at (${memParcel.pos.x},${memParcel.pos.y})`);
        }
    }

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
                } else if (peerMsg.kind === 'HANDOFF_SLAVE_POS') {
                    handoffSlavePos = { x: Math.round(Number(peerMsg.x)), y: Math.round(Number(peerMsg.y)) };
                    console.log(`[Handoff] Master: slave is at (${handoffSlavePos.x},${handoffSlavePos.y})`);
                } else if (peerMsg.kind === 'HANDOFF_APPROACH') {
                    // Picker has picked up a parcel and is moving toward us
                    const px = Number(peerMsg.x);
                    const py = Number(peerMsg.y);
                    console.log(`[Handoff] Deliverer: picker at (${px},${py}), heading toward them`);
                    handoffPhase = 'approach';
                    if (llmActiveMission?.type === 'handoff_deliverer_approach') {
                        llmActiveMission.x_target = px;
                        llmActiveMission.y_target = py;
                        currentPath = null;
                    } else {
                        if (llmActiveMission) llmPendingMissions.unshift(llmActiveMission);
                        llmActiveMission = null;
                        clearIntention();
                        llmPendingMissions.unshift(new Desire('handoff_deliverer_approach', px, py, 9999));
                    }
                } else if (peerMsg.kind === 'HANDOFF_DROPPED') {
                    // Picker dropped the parcel — go pick it up and deliver
                    const dx = Number(peerMsg.x);
                    const dy = Number(peerMsg.y);
                    console.log(`[Handoff] Deliverer: parcel dropped at (${dx},${dy}), picking up`);
                    handoffRole = null;
                    handoffPhase = 'idle';
                    handoffWaitAtMeetStart = null;
                    if (llmActiveMission?.type === 'handoff_deliverer_approach') {
                        llmActiveMission = null;
                        clearIntention();
                    }
                    const hdIdx = llmPendingMissions.findIndex(m => m.type === 'handoff_deliverer_approach');
                    if (hdIdx >= 0) llmPendingMissions.splice(hdIdx, 1);
                    // Pre-populate worldMap so toPickup is non-empty when slave arrives
                    if (worldMap && Array.isArray(peerMsg.parcels)) {
                        for (const pd of peerMsg.parcels) {
                            worldMap.parcels.set(pd.id, new Parcel(
                                { id: pd.id, x: dx, y: dy, reward: pd.reward, carriedBy: null }, Date.now(),
                            ));
                        }
                    }
                    llmPendingMissions.unshift(new Desire('go_pickup', dx, dy, 9999));
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
        // Handoff transition: when picker has acquired a parcel, compute meeting point and switch to approach
        if (handoffRole === 'picker' && handoffPhase === 'pickup' && carrying.length > 0) {
            const partnerEntry = partnerAgentId ? worldMap.other_agents.get(partnerAgentId) : null;
            const partnerPos = partnerEntry
                ? { x: Math.round(partnerEntry.pos.x), y: Math.round(partnerEntry.pos.y) }
                : handoffSlavePos;

            if (!partnerPos) {
                if (!handoffWaitStart) handoffWaitStart = Date.now();
                if (Date.now() - handoffWaitStart >= 3_000) {
                    console.log('[Handoff] Picker: slave position timeout — aborting handoff, delivering normally');
                    handoffRole = null;
                    handoffPhase = 'idle';
                    handoffWaitStart = null;
                } else {
                    debug('[Handoff] Picker: parcel in hand, waiting for slave position...');
                }
            } else {
                handoffWaitStart = null;
                handoffPhase = 'approach';

                // Build the blocked set dynamically before calculating the meeting point
                const now = Date.now();
                const blocked = new Set([
                    ...[...tempBlockedCells.entries()].filter(([, u]) => u > now).map(([k]) => k),
                    ...llmBlockedTiles
                ]);

                let meet = computeMeetingPoint(myAgent.pos, partnerPos, blocked);
                if (!meet) {
                    // If not valid meeting point, ensure fallback isn't a delivery tile
                    const partnerTileType = worldMap.tiles.get(`${partnerPos.x},${partnerPos.y}`);
                    meet = partnerTileType === '1' ? partnerPos : myAgent.pos;
                }

                // Interrupt any in-progress mission and go straight to approach
                if (llmActiveMission) completeActiveMission('handoff-transition');
                clearIntention();
                llmPendingMissions.unshift(new Desire('handoff_approach', meet.x, meet.y, 9999));
                if (partnerAgentId) {
                    socket.emitSay(partnerAgentId, JSON.stringify({ kind: 'HANDOFF_APPROACH', x: meet.x, y: meet.y }))
                        .catch((err: unknown) => console.warn('[Handoff] Failed to signal partner:', err));
                }
                console.log(`[Handoff] Picker: parcel in hand, meeting at (${meet.x},${meet.y})`);
                return; // next tick will execute handoff_approach
            }
        }

        // Priority: deliver immediately if standing on a delivery tile (skip LLM-blocked tiles or
        // when a higher-multiplier bonus tile exists elsewhere — consistent with line 400 utility*m)
        const currentTileKey = `${myAgent.pos.x},${myAgent.pos.y}`;
        const currentMultiplier = llmDeliveryBonusTiles.get(currentTileKey) ?? 1;
        const bestMultiplier = llmDeliveryBonusTiles.size > 0
            ? Math.max(...llmDeliveryBonusTiles.values()) : 1;
        const betterBonusTileExists = bestMultiplier > currentMultiplier;
        const carriedScore = carrying.reduce((s, p) => s + p.reward, 0);
        const stackMult = effectiveDeliveryMultiplier(carrying.length, llmStackConstraints, worldMap.parcels.size, carriedScore);
        if (carrying.length > 0 && utils.tile_is('delivery', myAgent.pos, worldMap.tiles) &&
            !(handoffRole === 'picker') &&   // don't deliver during any handoff picker phase
            !llmBlockedDeliveryTiles.has(currentTileKey) &&
            !betterBonusTileExists &&
            stackMult >= 0.5) {
            const res = await socket.emitPutdown();
            if (Array.isArray(res) && res.length > 0) {
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
        
        let desires = generateDesires(
            myAgent, 
            worldMap, 
            carrying, 
            spawnVisitLog, 
            activeBlocked, 
            llmDeliveryBonusTiles,
            llmBlockedDeliveryTiles,
            llmStackConstraints
        );

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
                if (Array.isArray(res) && res.length > 0) {
                    for (const p of toPickup)
                        if (!carrying.some(c => c.id === p.id)) carrying.push(p);
                    debug(toPickup.length > 0
                        ? `Picked up ${toPickup.length} parcel(s) at (${myAgent.pos.x},${myAgent.pos.y})`
                        : `No parcel at (${myAgent.pos.x},${myAgent.pos.y})`);
                }
                worldMap.removeParcelAt({ x: currentIntention.x_target, y: currentIntention.y_target });
                if (sameMission(currentIntention, llmActiveMission)) completeActiveMission('pickup-complete');
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
                if (Array.isArray(res) && res.length > 0) {
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

        } else if (currentIntention.type === 'wait_row') {
            const parity = currentIntention.parity ?? 'odd';
            const onTargetRow = parity === 'odd' ? myAgent.pos.y % 2 === 1 : myAgent.pos.y % 2 === 0;
            if (onTargetRow) {
                debug(`[Wait] Already on position - holding at (${myAgent.pos.x},${myAgent.pos.y}) [${parity} row]`);
                return;
            }
            // One step up or down is enough — adjacent rows always alternate parity
            const candidates: Array<{ dir: string; pos: Position }> = [
                { dir: 'up',   pos: { x: myAgent.pos.x, y: myAgent.pos.y + 1 } },
                { dir: 'down', pos: { x: myAgent.pos.x, y: myAgent.pos.y - 1 } },
            ];
            for (const { dir, pos } of candidates) {
                if (worldMap.tiles.has(`${pos.x},${pos.y}`)) {
                    await stepTowards(dir, pos);
                    return;
                }
            }

        } else if (currentIntention.type === 'handoff_approach') {
            const meetPos = { x: currentIntention.x_target, y: currentIntention.y_target };
            const myPos = myAgent.pos;
            const distToMeet = Math.abs(myPos.x - meetPos.x) + Math.abs(myPos.y - meetPos.y);
            const currentTileType = worldMap?.tiles.get(`${myPos.x},${myPos.y}`);

            // 1. ARRIVAL & DROP CHECK
            const dropKey = `${myPos.x},${myPos.y}`;
            
            // FIX: Allow drop if we are on type '0' OR '1'
            const isValidDropTile = currentTileType === '0' || currentTileType === '1';
            const canTryDrop = distToMeet <= 1 && isValidDropTile && !tempBlockedCells.has(`cursed_${dropKey}`);

            if (canTryDrop) {
                const res = await socket.emitPutdown();
                
                if (Array.isArray(res) && res.length > 0) {
                    console.log(`[Handoff] Picker: successfully dropped at (${myPos.x},${myPos.y})`);
                    carrying = carrying.filter(c => !res.some((dropped: any) => dropped.id === c.id));
                    
                    if (partnerAgentId) {
                        socket.emitSay(partnerAgentId, JSON.stringify({
                            kind: 'HANDOFF_DROPPED', x: myPos.x, y: myPos.y, parcels: res
                        })).catch(() => {});
                    }

                    handoffRole = null;
                    handoffPhase = 'idle';
                    completeActiveMission('handoff-dropped');
                    clearIntention();

                    tempBlockedCells.set(dropKey, Date.now() + 10000); 
                    return;
                } else {
                    console.log(`[Handoff] Picker: Server REJECTED drop at (${myPos.x},${myPos.y}). Searching for alternate.`);
                    tempBlockedCells.set(`cursed_${dropKey}`, Date.now() + 60000);
                    currentPath = null; 
                }
            }

            // 2. FALLBACK NAVIGATION
            if (!currentPath?.length) {
                const adjacents = [
                    { x: meetPos.x, y: meetPos.y }, 
                    { x: meetPos.x + 1, y: meetPos.y }, { x: meetPos.x - 1, y: meetPos.y },
                    { x: meetPos.x, y: meetPos.y + 1 }, { x: meetPos.x, y: meetPos.y - 1 }
                ];
                
                adjacents.sort((a, b) => 
                    (Math.abs(myPos.x - a.x) + Math.abs(myPos.y - a.y)) - 
                    (Math.abs(myPos.x - b.x) + Math.abs(myPos.y - b.y))
                );

                for (const adj of adjacents) {
                    const adjKey = `${adj.x},${adj.y}`;
                    const adjTileType = worldMap?.tiles.get(adjKey);
                    
                    // FIX: Allow fallback routing to types '0' OR '1'
                    if ((adjTileType === '0' || adjTileType === '1') && !tempBlockedCells.has(`cursed_${adjKey}`)) {
                        currentPath = await planPath(myPos, adj);
                        if (currentPath?.length) break; 
                    }
                }

                if (!currentPath?.length) {
                    console.log(`[Handoff] Picker: Meeting area completely blocked or cursed. Aborting.`);
                    handoffRole = null;
                    handoffPhase = 'idle';
                    completeActiveMission('handoff-aborted-unreachable');
                    clearIntention();
                    return;
                }
            }
            
            // 3. EXECUTE MOVEMENT
            await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));
        } else if (currentIntention.type === 'handoff_deliverer_approach') {
            // Deliverer: navigate to fixed meeting tile; holds when arrived, waits for HANDOFF_DROPPED
            const meetPos = { x: currentIntention.x_target, y: currentIntention.y_target };
            if (myAgent.pos.x === meetPos.x && myAgent.pos.y === meetPos.y) {
                if (!handoffWaitAtMeetStart) handoffWaitAtMeetStart = Date.now();
                if (Date.now() - handoffWaitAtMeetStart > 15_000) {
                    console.log('[Handoff] Deliverer: timeout waiting for drop, aborting');
                    handoffRole = null;
                    handoffPhase = 'idle';
                    handoffWaitAtMeetStart = null;
                    completeActiveMission('handoff-timeout');
                    clearIntention();
                    return;
                }
                debug(`[Handoff] Deliverer: at meeting tile (${myAgent.pos.x},${myAgent.pos.y}), waiting for parcel`);
                return;
            }
            handoffWaitAtMeetStart = null;
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, meetPos);
            if (!currentPath?.length) {
                debug('[Handoff] Deliverer: no path to meeting tile, holding');
                return;
            }
            await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));
        }

    } catch (err) {
        console.error(err);
    } finally {
        // Physical stuck detection: block intention if agent held same intention but didn't move
        // Skip for wait_row and rendezvous-in-range (agent intentionally stays put)
        if (prevKey && myAgent && currentIntention?.type !== 'wait_row' && !(currentIntention?.type === 'rendezvous' && rendezvousInRange)) {
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
                        // Emergency drop: if picker is stuck en route to meeting tile, drop here and signal slave
                        if (llmActiveMission.type === 'handoff_approach' && myAgent && carrying.length > 0) {
                            const dropX = myAgent.pos.x;
                            const dropY = myAgent.pos.y;
                            // Only attempt emergency drop on valid dropoff tiles (type '1')
                            const dropTileType = worldMap?.tiles.get(`${dropX},${dropY}`);
                            if (dropTileType === '1') {
                                const parcelSnap = carrying.map(p => ({ id: p.id, reward: Math.round(p.reward) }));
                                socket.emitPutdown().then((res: unknown) => {
                                    if (Array.isArray(res) && res.length > 0 && partnerAgentId) {
                                        console.log(`[Handoff] Picker: stuck, emergency drop at (${dropX},${dropY})`);
                                        socket.emitSay(partnerAgentId, JSON.stringify({
                                            kind: 'HANDOFF_DROPPED', x: dropX, y: dropY, parcels: parcelSnap,
                                        })).catch(() => {});
                                    }
                                }).catch(() => {});
                            } else {
                                console.log(`[Handoff] Picker: stuck but current tile (${dropX},${dropY}) is not valid for emergency drop (type=${dropTileType})`);
                            }
                            carrying.length = 0;
                            handoffRole = null;
                            handoffPhase = 'idle';
                        }
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
