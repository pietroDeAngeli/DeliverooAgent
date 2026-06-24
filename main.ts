import * as dotenv from 'dotenv';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

import { World, Agent, Parcel } from "./BDI/Belief.ts";
import type { Position } from "./BDI/Belief.ts";
import { Desire, generateDesires, effectiveDeliveryMultiplier } from "./BDI/Desire.ts";
import type { StackConstraint } from "./BDI/Desire.ts";
import { reviseIntention } from "./BDI/Intentions.ts";
import * as utils from "./utils.ts";
import { sameMission, missionKey } from "./utils.ts";
import { getPddlPath } from "./pddl/pddl_planner.ts";
import type { LLMClient } from "./LLM/llm.ts";
import {
    computeMeetingPoint,
    handleMessage,
    type CommsContext,
} from "./communication/multiagent.ts";

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
let handoffWaitStart: number | null = null;       // when picker started waiting for slave pos
let handoffPickerAtMeetStart: number | null = null; // when picker arrived at meeting tile (waiting for deliverer)
let handoffWaitAtMeetStart: number | null = null;   // when deliverer arrived at meeting tile
let handoffDroppedIds = new Set<string>();        // parcel IDs dropped for handoff — blocked from picker re-pickup
let handoffDroppedAt: number | null = null;       // timestamp when last handoff drop occurred
let handoffExpectedParcelIds: Set<string> | null = null; // deliverer: IDs expected from HANDOFF_DROPPED

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearIntention(): void {
    currentIntention = null;
    lastIntention    = null;
    currentPath      = null;
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

// Shared view of the agent state handed to the communication layer. Getters/setters
// are bound to the module-level BDI/LLM/multi-agent state above so the comms module
// can read and update it without owning any of it.
const commsCtx: CommsContext = {
    socket,
    IS_MASTER,
    godName,
    get useLLM() { return useLLM; },
    get llm() { return llm; },
    get worldMap() { return worldMap; },
    get myAgent() { return myAgent; },
    get partnerAgentId() { return partnerAgentId; },
    set partnerAgentId(v) { partnerAgentId = v; },
    get llmActiveMission() { return llmActiveMission; },
    set llmActiveMission(v) { llmActiveMission = v; },
    get currentIntention() { return currentIntention; },
    set currentIntention(v) { currentIntention = v; },
    get currentPath() { return currentPath; },
    set currentPath(v) { currentPath = v; },
    get rendezvousMaxDist() { return rendezvousMaxDist; },
    set rendezvousMaxDist(v) { rendezvousMaxDist = v; },
    get rendezvousInRange() { return rendezvousInRange; },
    set rendezvousInRange(v) { rendezvousInRange = v; },
    get rendezvousPartnerArrived() { return rendezvousPartnerArrived; },
    set rendezvousPartnerArrived(v) { rendezvousPartnerArrived = v; },
    get handoffRole() { return handoffRole; },
    set handoffRole(v) { handoffRole = v; },
    get handoffPhase() { return handoffPhase; },
    set handoffPhase(v) { handoffPhase = v; },
    get handoffSlavePos() { return handoffSlavePos; },
    set handoffSlavePos(v) { handoffSlavePos = v; },
    get handoffWaitStart() { return handoffWaitStart; },
    set handoffWaitStart(v) { handoffWaitStart = v; },
    get handoffWaitAtMeetStart() { return handoffWaitAtMeetStart; },
    set handoffWaitAtMeetStart(v) { handoffWaitAtMeetStart = v; },
    get handoffExpectedParcelIds() { return handoffExpectedParcelIds; },
    set handoffExpectedParcelIds(v) { handoffExpectedParcelIds = v; },
    tempBlockedCells,
    llmBlockedTiles,
    llmPendingMissions,
    llmDeliveryBonusTiles,
    llmBlockedDeliveryTiles,
    llmStackConstraints,
    debug,
    clearIntention,
};

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

    const bfsPath = utils.get_shortest_path(start, target, worldMap, blocked);

    // Hybrid planning: the push-aware BFS handles ordinary navigation (and the
    // common single-crate push) instantly, with no subprocess overhead — vital
    // given the ~50 ms movement tick. The PDDL solver is reserved for the cases
    // where it actually earns its cost: when BFS finds no route at all, or when
    // the route touches a crate, where Fast Downward's multi-push reasoning is
    // both correct (it models the post-push state) and sometimes necessary.
    if (USE_PDDL && (bfsPath === null || pathTouchesCrate(start, bfsPath))) {
        debug(`[PDDL] ${start.x},${start.y} -> ${target.x},${target.y} (BFS ${bfsPath === null ? 'blocked' : 'crosses crate'})`);
        const pddlPath = await getPddlPath(start, target, worldMap, blocked);
        if (pddlPath) {
            debug(`[PDDL] path found (${pddlPath.length} steps)`);
            return pddlPath;
        }
        debug(`[PDDL] no plan — using BFS result`);
    }

    return bfsPath;
}

// True when walking `path` from `start` steps onto a tile currently occupied by
// a crate, i.e. the route involves at least one push.
function pathTouchesCrate(start: Position, path: string[]): boolean {
    if (!worldMap || worldMap.crates.size === 0) return false;
    const crateKeys = new Set([...worldMap.crates.values()].map(c => `${c.pos.x},${c.pos.y}`));
    let pos = { x: start.x, y: start.y };
    for (const dir of path) {
        pos = utils.nextPosition(pos, dir);
        if (crateKeys.has(`${pos.x},${pos.y}`)) return true;
    }
    return false;
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

// True when the crate sitting on `cratePos` can be pushed one tile further in
// `dir`: the landing tile must exist, be a type-5 tile, and be free of crates
// (matches the server-side push rule in PushAgent.js).
function isPushableCrate(cratePos: Position, dir: string): boolean {
    if (!worldMap) return false;
    const beyond     = utils.nextPosition(cratePos, dir);
    const beyondType = worldMap.tiles.get(`${beyond.x},${beyond.y}`);
    if (!beyondType || !beyondType.startsWith('5')) return false;
    return ![...worldMap.crates.values()].some(c => c.pos.x === beyond.x && c.pos.y === beyond.y);
}

async function stepTowards(dir: string, nextPos: Position): Promise<boolean> {
    // A crate on the next tile is only a hard obstacle if it cannot be pushed.
    // To push it the agent steps onto its tile and the server slides the crate
    // one tile further in the same direction (it must land on a free type-5
    // tile). The path step is an ordinary move; the server performs the push.
    const crateAhead = [...worldMap!.crates.values()].some(c => c.pos.x === nextPos.x && c.pos.y === nextPos.y);
    if (crateAhead && !isPushableCrate(nextPos, dir)) {
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

// Step one tile toward `target` without requiring a pre-planned path.
// Tries the dominant axis first, then the secondary axis — works even when
// the target tile is outside the agent's known worldMap.
async function stepToward(target: Position): Promise<boolean> {
    const pos = myAgent!.pos;
    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const moves: Array<[string, Position]> =
        Math.abs(dx) >= Math.abs(dy)
            ? [
                ...(dx !== 0 ? [[dx > 0 ? 'right' : 'left', { x: pos.x + Math.sign(dx), y: pos.y }] as [string, Position]] : []),
                ...(dy !== 0 ? [[dy > 0 ? 'up'    : 'down',  { x: pos.x, y: pos.y + Math.sign(dy) }] as [string, Position]] : []),
              ]
            : [
                ...(dy !== 0 ? [[dy > 0 ? 'up'    : 'down',  { x: pos.x, y: pos.y + Math.sign(dy) }] as [string, Position]] : []),
                ...(dx !== 0 ? [[dx > 0 ? 'right' : 'left', { x: pos.x + Math.sign(dx), y: pos.y }] as [string, Position]] : []),
              ];
    for (const [dir, nextPos] of moves) {
        if (await stepTowards(dir, nextPos)) return true;
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

socket.onMsg((id: string, name: string, msg: any, reply: ((response: any) => void) | undefined) =>
    handleMessage(commsCtx, id, name, msg, reply),
);

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
                    handoffPickerAtMeetStart = null;
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

                let meet = computeMeetingPoint(worldMap, myAgent.pos, partnerPos, blocked);
                if (!meet) {
                    // computeMeetingPoint only returns null when the master's worldMap has no
                    // reachable walkable tiles at all — use partner's position as last resort.
                    meet = partnerPos;
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
        
        // Clear handoff-dropped IDs only when someone ELSE picked the parcel up (not the picker),
        // or after a 45 s timeout. Do NOT clear on !p or carriedBy===self — those are timing races
        // right after emitPutdown() where worldMap hasn't caught up yet.
        if (handoffDroppedAt !== null && Date.now() - handoffDroppedAt > 45_000) {
            handoffDroppedIds.clear();
            handoffDroppedAt = null;
        } else {
            for (const id of handoffDroppedIds) {
                const p = worldMap.parcels.get(id);
                if (p?.carriedBy && p.carriedBy !== myAgent?.id) handoffDroppedIds.delete(id);
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

        // Prevent picker from re-acquiring parcels it just dropped for handoff
        if (handoffDroppedIds.size > 0) {
            desires = desires.filter(d => {
                if (d.type !== 'go_pickup') return true;
                const parcel = Array.from(worldMap!.parcels.values())
                    .find(p => p.pos.x === d.x_target && p.pos.y === d.y_target);
                return !parcel || !handoffDroppedIds.has(parcel.id);
            });
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
                if (Array.isArray(res) && res.length > 0) {
                    for (const p of toPickup)
                        if (!carrying.some(c => c.id === p.id)) carrying.push(p);
                    debug(toPickup.length > 0
                        ? `Picked up ${toPickup.length} parcel(s) at (${myAgent.pos.x},${myAgent.pos.y})`
                        : `No parcel at (${myAgent.pos.x},${myAgent.pos.y})`);
                }
                // Verify handoff parcel IDs if this is a deliverer picking up after a HANDOFF_DROPPED
                if (handoffExpectedParcelIds && handoffExpectedParcelIds.size > 0) {
                    const pickedIds = new Set(Array.isArray(res) ? res.map((p: any) => p.id) : []);
                    const missing = [...handoffExpectedParcelIds].filter(id => !pickedIds.has(id));
                    if (missing.length === 0) {
                        console.log(`[Handoff] Deliverer: VERIFIED — got expected parcel(s): ${[...pickedIds].join(', ')}`);
                    } else {
                        console.log(`[Handoff] Deliverer: MISMATCH — expected [${[...handoffExpectedParcelIds].join(', ')}], got [${[...pickedIds].join(', ')}] — missing: ${missing.join(', ')}`);
                    }
                    handoffExpectedParcelIds = null;
                }
                worldMap.removeParcelAt({ x: currentIntention.x_target, y: currentIntention.y_target });
                if (sameMission(currentIntention, llmActiveMission)) completeActiveMission('pickup-complete');
                clearIntention();
                return;
            }
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, { x: currentIntention.x_target, y: currentIntention.y_target });
            if (!currentPath?.length) {
                const failed = currentIntention;
                handleNoPath(`go_pickup:${currentIntention.x_target},${currentIntention.y_target}`, 'pickup');
                if (sameMission(failed, llmActiveMission)) completeActiveMission('no-path');
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
            const target = { x: currentIntention.x_target, y: currentIntention.y_target };
            const distToTarget = utils.get_distance(myAgent.pos, target);

            // Mutual distance to partner (agent-to-agent), which is the actual rendezvous condition.
            const partnerEntry = partnerAgentId ? worldMap.other_agents.get(partnerAgentId) : null;
            const distToPartner = partnerEntry
                ? Math.abs(myAgent.pos.x - Math.round(partnerEntry.pos.x)) + Math.abs(myAgent.pos.y - Math.round(partnerEntry.pos.y))
                : Infinity;

            // Arrive when on the tile or immediately adjacent (nav target reached).
            if (distToTarget <= 1) {
                if (!rendezvousInRange) {
                    rendezvousInRange = true;
                    console.log(`[Rendezvous] At tile (${myAgent.pos.x},${myAgent.pos.y}), signaling partner`);
                    if (partnerAgentId) {
                        socket.emitSay(partnerAgentId, JSON.stringify({ kind: 'RENDEZVOUS_ARRIVED' }))
                            .catch((err: unknown) => console.warn('[Rendezvous] Failed to signal partner:', err));
                    } else {
                        rendezvousPartnerArrived = true;
                    }
                }
                if (rendezvousPartnerArrived) {
                    // Both signaled they're at the tile. Complete when mutual distance ≤ maxDist,
                    // or when the partner is not visible (they're near the same tile — close enough).
                    const mutuallyClose = distToPartner <= rendezvousMaxDist || distToPartner === Infinity;
                    if (mutuallyClose) {
                        const actualDist = distToPartner === Infinity ? '?' : distToPartner;
                        console.log(`[Rendezvous] Both at tile, mutual dist=${actualDist} (max=${rendezvousMaxDist}), completing`);
                        if (sameMission(currentIntention, llmActiveMission)) completeActiveMission('rendezvous-both-arrived');
                        clearIntention();
                        rendezvousInRange = false;
                        rendezvousPartnerArrived = false;
                        return;
                    }
                    // Partner signaled but is still too far — keep holding, they're still approaching.
                    debug(`[Rendezvous] Partner signaled but mutual dist=${distToPartner} > max=${rendezvousMaxDist}, holding`);
                }
                // Holding at tile, waiting for partner signal or proximity
                debug(`[Rendezvous] Holding at (${myAgent.pos.x},${myAgent.pos.y}), partnerArrived=${rendezvousPartnerArrived}`);
                return;
            }
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, { x: currentIntention.x_target, y: currentIntention.y_target });
            if (!currentPath?.length) {
                // Target tile not yet discovered — walk blindly toward it rather than giving up.
                debug(`[Rendezvous] No BFS path to (${target.x},${target.y}), stepping toward unknown tile`);
                await stepToward(target);
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

            // Distance to the deliverer's actual current position
            const delivererEntry = partnerAgentId ? worldMap.other_agents.get(partnerAgentId) : null;
            const distToDeliverer = delivererEntry
                ? Math.abs(myPos.x - Math.round(delivererEntry.pos.x)) + Math.abs(myPos.y - Math.round(delivererEntry.pos.y))
                : Infinity;

            // 1. ARRIVAL & DROP CHECK
            const dropKey = `${myPos.x},${myPos.y}`;
            const isValidDropTile = currentTileType === '0' || currentTileType === '1';
            const delivererIsClose = distToDeliverer <= 2;

            // At meeting tile: wait for deliverer to arrive before dropping so the parcel
            // isn't left exposed on the ground. Allow a 20 s timeout after which we drop
            // anyway (deliverer may be stuck or taking a long route).
            if (distToMeet === 0 && !delivererIsClose && isValidDropTile) {
                if (!handoffPickerAtMeetStart) {
                    handoffPickerAtMeetStart = Date.now();
                    console.log(`[Handoff] Picker: at meeting point (${myPos.x},${myPos.y}), waiting for deliverer (dist=${distToDeliverer})…`);
                }
                if (Date.now() - handoffPickerAtMeetStart < 20_000) {
                    return; // stay put, next tick will re-check
                }
                console.log(`[Handoff] Picker: deliverer timeout — dropping at (${myPos.x},${myPos.y}) anyway`);
            }
            handoffPickerAtMeetStart = null;

            // Drop when AT the meeting point (after deliverer is close or timeout) OR
            // when standing adjacent to the deliverer (handles the case where the
            // deliverer is blocking the exact meeting tile).
            const canTryDrop = (distToMeet === 0 || distToDeliverer <= 1) && isValidDropTile && !tempBlockedCells.has(`cursed_${dropKey}`);

            if (canTryDrop) {
                const res = await socket.emitPutdown();

                if (Array.isArray(res) && res.length > 0) {
                    console.log(`[Handoff] Picker: successfully dropped at (${myPos.x},${myPos.y})`);
                    carrying = carrying.filter(c => !res.some((dropped: any) => dropped.id === c.id));
                    for (const dropped of res) handoffDroppedIds.add(dropped.id);
                    handoffDroppedAt = Date.now();
                    console.log(`[Handoff] Picker: blocking re-pickup of IDs: ${res.map((d: any) => d.id).join(', ')}`);

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
                console.log(`[Handoff] Deliverer: no path to meeting point (${meetPos.x},${meetPos.y}), aborting handoff`);
                handoffRole = null;
                handoffPhase = 'idle';
                handoffWaitAtMeetStart = null;
                completeActiveMission('no-path');
                clearIntention();
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
                            handoffPickerAtMeetStart = null;
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
