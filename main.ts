import * as dotenv from 'dotenv';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

import { World, Agent, Parcel } from "./Belief.ts";
import type { Position } from "./Belief.ts";
import { generateDesires } from "./Desire.ts";
import { reviseIntention } from "./Intentions.ts";
import * as utils from "./utils.ts";
import { getPddlPath } from "./pddl_planner.ts";
import { computeReachableTiles } from "./path_finding.ts";

dotenv.config();

const url = process.env.HOST;
const token = process.env.TOKEN;

// Typecasting as string to satisfy TypeScript, assuming they are defined in .env
const socket = DjsConnect(url as string, token as string);

socket.onConnect(() => {
    console.log("Connected to the server");
});

socket.onDisconnect(() => {
    console.log("Disconnected from the server");
    if (mainLoop) clearInterval(mainLoop);
});

socket.onConfig((config: any) => {
    console.log('Config:', config);
    console.log('Agents observation distance:', config.GAME.player.agents_observation_distance);

    // Read parcel decay parameters from server config (see benchmarkAgent reference)
    const movementDuration: number = config.GAME.player.movement_duration ?? 200;
    const decayingEvent: string = config.GAME.parcels?.decaying_event ?? 'infinite';

    // Parse decaying_event string: '1s' -> 1000ms, '500ms' -> 500ms, 'infinite' -> 1e6
    let parcelDecayInterval: number = 1e6;
    if (decayingEvent !== 'infinite') {
        const msMatch = decayingEvent.match(/(\d+(?:\.\d+)?)ms/);
        const sMatch  = decayingEvent.match(/(\d+(?:\.\d+)?)s$/);
        if (msMatch) parcelDecayInterval = parseFloat(msMatch[1]);
        else if (sMatch) parcelDecayInterval = parseFloat(sMatch[1]) * 1000;
    }

    if (worldMap) {
        worldMap.movementDuration = movementDuration;
        worldMap.parcelDecayIntervalMs = parcelDecayInterval;
    } else {
        // worldMap not yet created: store temporarily and apply in onMap
        pendingMovementDuration = movementDuration;
        pendingParcelDecayInterval = parcelDecayInterval;
    }

    agentObsDistance = config.GAME.player.agents_observation_distance;
    console.log(`Movement duration: ${movementDuration}ms, Parcel decay interval: ${parcelDecayInterval}ms`);
});

let pendingMovementDuration: number = 200;
let pendingParcelDecayInterval: number = 1e6;

let myAgent: Agent | undefined = undefined;
let worldMap: World | undefined = undefined;
let carrying: any[] = [];
let desires: any[] = [];
let currentIntention: any | null = null;
let isRunning: boolean = false;
let currentPath: string[] | null = null;
let lastIntentionKey: string | null = null;
// Tracks when each spawn tile was last visited (key = "x,y", value = timestamp ms).
// Used by generateDesires to score explore targets: prefers tiles not visited recently.
const spawnVisitLog: Map<string, number> = new Map();
// Cells where emitMove failed: blocked until the next sensing update clears them
// This prevents hammering a locked tile when sensing is momentarily behind the server state
const recentlyFailedCells: Set<string> = new Set();
// Bounce detection: last N distinct positions visited
const positionHistory: Position[] = [];
// Cells temporarily blocked after ABAB bounce detection (key → unblock timestamp ms)
const tempBlockedCells: Map<string, number> = new Map();
// Agent observation distance in tiles, read from server config
let agentObsDistance: number = 5;
// Whether the one-time reachability pruning has been applied to worldMap.tiles
let reachabilityInitialized: boolean = false;

/**
 * Runs once when both the map and the agent's initial position are known.
 * Computes which tiles are structurally reachable from spawn (directed BFS,
 * respects one-way tiles) and removes unreachable tiles from worldMap.tiles
 * in-place — pathfinding, explore scoring and delivery lookup all benefit.
 */
function tryInitReachability(): void {
    if (reachabilityInitialized || !worldMap || !myAgent) return;
    reachabilityInitialized = true;

    const before = worldMap.tiles.size;
    const reachable = computeReachableTiles(myAgent.pos, worldMap.tiles);

    // Prune in-place: drop every tile the agent can never reach from spawn
    for (const key of [...worldMap.tiles.keys()]) {
        if (!reachable.has(key)) worldMap.tiles.delete(key);
    }

    const pruned = before - worldMap.tiles.size;
    console.log(`[Reachability] ${reachable.size} reachable tiles, ${pruned} pruned from map.`);
}

// Set USE_PDDL=true in .env to use the PDDL online solver instead of BFS.
// BFS is the default: it is faster and works offline.
// PDDL is useful to verify optimality or to experiment with the planning API.
const USE_PDDL: boolean = process.env.USE_PDDL === 'true';
if (USE_PDDL) console.log('[Planner] Using PDDL online solver for pathfinding.');
else         console.log('[Planner] Using BFS for pathfinding (default).');

/**
 * Unified path helper: delegates to BFS or PDDL based on USE_PDDL flag.
 * Always async so the call sites are uniform.
 */
async function planPath(start: Position, target: Position): Promise<string[] | null> {
    if (!worldMap) return null;
    const now = Date.now();
    const tempBlocked = new Set(
        [...tempBlockedCells.entries()]
            .filter(([_, until]) => until > now)
            .map(([key]) => key)
    );
    if (USE_PDDL) {
        console.log(`[PDDL] Planning (${start.x},${start.y}) → (${target.x},${target.y})`);
        return getPddlPath(start, target, worldMap);
    }
    return utils.get_shortest_path(start, target, worldMap, tempBlocked);
}

function intentionKey(intention: any): string {
    return `${intention.type}:${intention.x_target},${intention.y_target}`;
}

socket.onYou((agent: any) => {
    if (!myAgent) {
        myAgent = new Agent({ id: agent.id, x: agent.x, y: agent.y });
        tryInitReachability();
    } else {
        myAgent.pos.x = agent.x;
        myAgent.pos.y = agent.y;
    }
});

socket.onMap((width: number, height: number, tiles: any[]) => {
    worldMap = new World(width, height, tiles);
    worldMap.movementDuration = pendingMovementDuration;
    worldMap.parcelDecayIntervalMs = pendingParcelDecayInterval;
    reachabilityInitialized = false; // new map: recompute on next onYou
    tryInitReachability();
    console.log("Map initialized with dimensions:", width + 1, "x", height + 1);
    console.log("Initial tiles received:", tiles.length);
});

function nextPosition(pos: Position, dir: string): Position {
    switch (dir) {
        case 'up': return { x: pos.x, y: pos.y + 1 };
        case 'down': return { x: pos.x, y: pos.y - 1 };
        case 'left': return { x: pos.x - 1, y: pos.y };
        case 'right': return { x: pos.x + 1, y: pos.y };
        default: return pos;
    }
}

async function resilientMove(socket: any, direction: string, nextPos: Position): Promise<Position | null> {
    const cellKey = `${nextPos.x},${nextPos.y}`;

    // Check cells that failed since the last sensing update (server tile was locked but sensing hadn't fired yet)
    if (recentlyFailedCells.has(cellKey)) {
        console.log(`Skipping recently-failed cell (${nextPos.x}, ${nextPos.y}), waiting for sensing update.`);
        return null;
    }

    // Check predicted positions of opponent agents to avoid collision penalties
    if (worldMap) {
        const predicted = utils.get_predicted_occupied_cells(worldMap.other_agents);
        if (predicted.has(cellKey)) {
            console.log(`Predicted agent collision at (${nextPos.x}, ${nextPos.y}), waiting this tick.`);
            return null; // Don't clear path: agent may move away next tick
        }
    }

    const result = await socket.emitMove(direction);
    if (result) {
        console.log(`Moved ${direction} to (${result.x}, ${result.y})`);
        return { x: result.x, y: result.y };
    }
    // Move failed: server-side tile was locked but our sensing was stale (up to 1 clock frame = ~40ms blind window).
    // Block this cell until the next sensing update brings the tile state in sync.
    console.log(`Move ${direction} failed — tile (${nextPos.x}, ${nextPos.y}) was locked. Blocking until next sensing.`);
    recentlyFailedCells.add(cellKey);
    currentPath = null; // Invalidate cached path on unexpected failure
    return null;
}

socket.onSensing((sensing: any) => {
    if (!myAgent || !worldMap) return;

    worldMap.update_parcels(sensing.parcels);
    worldMap.update_crates(sensing.crates);
    worldMap.update_agents(sensing.agents);

    // Sync carrying: remove only parcels that have explicitly expired (reward=0) or been
    // picked up by another agent. Carried parcels are NOT in sensing.parcels (they're off-map),
    // so worldMap.parcels will NOT contain them — never use worldMap.parcels.has() here.
    const sensingParcelMap = new Map<string, any>(sensing.parcels.map((p: any) => [p.id, p]));
    carrying = carrying.filter(c => {
        const sp = sensingParcelMap.get(c.id);
        if (!sp) return true; // not visible on map → we're carrying it, keep
        if (sp.reward <= 0) return false; // reward decayed to 0, discard
        if (sp.carriedBy && sp.carriedBy !== myAgent!.id) return false; // stolen by opponent
        return true;
    });

    // Each sensing update brings a fresh picture of the world: clear any transiently-blocked cells
    // (they were blocked because the tile was locked between server lock and sensing emission ~40ms)
    recentlyFailedCells.clear();

    // Bounce detection: track distinct positions; detect ABAB oscillation and block those cells
    const lastPos = positionHistory.length > 0 ? positionHistory[positionHistory.length - 1] : null;
    if (!lastPos || lastPos.x !== myAgent.pos.x || lastPos.y !== myAgent.pos.y) {
        positionHistory.push({ x: myAgent.pos.x, y: myAgent.pos.y });
        if (positionHistory.length > 8) positionHistory.shift();
    }
    if (positionHistory.length >= 4) {
        const n = positionHistory.length;
        const pa = positionHistory[n - 4], pb = positionHistory[n - 3];
        const pc = positionHistory[n - 2], pd = positionHistory[n - 1];
        if (pa.x === pc.x && pa.y === pc.y && pb.x === pd.x && pb.y === pd.y) {
            const blockUntil = Date.now() + 4000;
            tempBlockedCells.set(`${pa.x},${pa.y}`, blockUntil);
            tempBlockedCells.set(`${pb.x},${pb.y}`, blockUntil);
            currentIntention = null;
            lastIntentionKey = null;
            currentPath = null;
            positionHistory.length = 0;
            console.log(`[Bounce] ABAB at (${pa.x},${pa.y})<->(${pb.x},${pb.y}), blocking 4s`);
        }
    }

    // Trigger one BDI step reactively after each sensing update
    bdiStep();
});

async function bdiStep(): Promise<void> {
    if (!socket.connected) return;
    if (!myAgent || !worldMap) return;
    if (isRunning) return;
    isRunning = true;

    try {
        // Absolute priority: if standing on a delivery tile with parcels, deliver immediately
        // (handles opportunistic delivery regardless of current intention type)
        if (carrying.length > 0 && utils.tile_is('delivery', myAgent.pos, worldMap.tiles)) {
            const res = await socket.emitPutdown();
            if (res) {
                console.log(`[Priority] Delivered ${carrying.length} parcel(s) at (${myAgent.pos.x},${myAgent.pos.y})`);
                carrying = [];
                currentIntention = null;
                lastIntentionKey = null;
                currentPath = null;
            }
            return;
        }

        // --- Desire generation ---
        desires = generateDesires(myAgent, worldMap, carrying, spawnVisitLog);

        // --- Intention revision ---
        currentIntention = reviseIntention(currentIntention, desires, worldMap, carrying);

        // Keep stored utility fresh so future revisions compare current values
        if (currentIntention) {
            const match = desires.find(
                d => d.type === currentIntention.type &&
                     d.x_target === currentIntention.x_target &&
                     d.y_target === currentIntention.y_target
            );
            if (match) currentIntention.utility = match.utility;
        }

        if (!currentIntention) return;

        // Invalidate cached path when the intention target changes
        const iKey = intentionKey(currentIntention);
        if (iKey !== lastIntentionKey) {
            currentPath = null;
            lastIntentionKey = iKey;
        }

        // --- Intention execution ---
        if (currentIntention.type === "go_pickup") {
            if (myAgent.pos.x === currentIntention.x_target && myAgent.pos.y === currentIntention.y_target) {
                const res = await socket.emitPickup();
                if (res) {
                    const newParcels: any[] = Array.isArray(res) ? res : [res];
                    for (const p of newParcels) {
                        if (!carrying.some((c: any) => c.id === p.id)) {
                            carrying.push(new Parcel(p, Date.now()));
                        }
                    }
                    console.log(`Picked up ${newParcels.length} parcel(s) at (${myAgent.pos.x}, ${myAgent.pos.y})`);
                } else {
                    // Parcel no longer at expected location: remove from belief set and drop intention
                    console.log(`No parcel found at (${myAgent.pos.x}, ${myAgent.pos.y}), removing from beliefs.`);
                    worldMap.removeParcelAt({ x: currentIntention.x_target, y: currentIntention.y_target });
                    currentIntention = null;
                    lastIntentionKey = null;
                }
                currentPath = null;
                return;
            }

            if (!currentPath || currentPath.length === 0) {
                currentPath = await planPath(
                    myAgent.pos,
                    { x: currentIntention.x_target, y: currentIntention.y_target }
                );
            }
            if (!currentPath || currentPath.length === 0) {
                console.log("No path to parcel, dropping intention.");
                currentIntention = null;
                lastIntentionKey = null;
                return;
            }
            const dir = currentPath[0];
            const nextPos = nextPosition(myAgent.pos, dir);
            // Crate on next step: path is permanently blocked, replan
            if ([...worldMap.crates.values()].some(c => c.pos.x === nextPos.x && c.pos.y === nextPos.y)) {
                console.log(`Crate blocking (${nextPos.x}, ${nextPos.y}), replanning...`);
                currentPath = null;
                return;
            }
            const result = await resilientMove(socket, dir, nextPos);
            if (result) {
                myAgent.pos.x = result.x;
                myAgent.pos.y = result.y;
                currentPath.shift();

                // Opportunistic delivery: if we stepped onto a delivery tile while carrying, deliver now
                if (carrying.length > 0 && utils.tile_is('delivery', myAgent.pos, worldMap.tiles)) {
                    const res = await socket.emitPutdown();
                    if (res) {
                        console.log(`Opportunistic delivery at (${myAgent.pos.x}, ${myAgent.pos.y})`);
                        carrying = [];
                        currentIntention = null;
                        lastIntentionKey = null;
                        currentPath = null;
                    }
                }
            }

        } else if (currentIntention.type === "go_delivery") {
            if (myAgent.pos.x === currentIntention.x_target && myAgent.pos.y === currentIntention.y_target) {
                const res = await socket.emitPutdown();
                if (res) {
                    console.log(`Delivered parcels at (${myAgent.pos.x}, ${myAgent.pos.y})`);
                    carrying = [];
                }
                currentPath = null;
                return;
            }

            if (!currentPath || currentPath.length === 0) {
                currentPath = await planPath(
                    myAgent.pos,
                    { x: currentIntention.x_target, y: currentIntention.y_target }
                );
            }
            if (!currentPath || currentPath.length === 0) {
                console.log("No path to delivery, dropping intention.");
                currentIntention = null;
                lastIntentionKey = null;
                return;
            }
            const dir = currentPath[0];
            const nextPos = nextPosition(myAgent.pos, dir);
            if ([...worldMap.crates.values()].some(c => c.pos.x === nextPos.x && c.pos.y === nextPos.y)) {
                console.log(`Crate blocking (${nextPos.x}, ${nextPos.y}), replanning...`);
                currentPath = null;
                return;
            }
            const result = await resilientMove(socket, dir, nextPos);
            if (result) {
                myAgent.pos.x = result.x;
                myAgent.pos.y = result.y;
                currentPath.shift();
            }

        } else if (currentIntention.type === "explore") {
            // No need to walk all the way to the spawn tile:
            // stop as soon as the target is within observation range (we can already see it)
            if (utils.get_distance(myAgent.pos, { x: currentIntention.x_target, y: currentIntention.y_target }) <= agentObsDistance) {
                spawnVisitLog.set(`${currentIntention.x_target},${currentIntention.y_target}`, Date.now());
                console.log(`[Explore] Target (${currentIntention.x_target},${currentIntention.y_target}) in view, marked visited.`);
                currentIntention = null;
                lastIntentionKey = null;
                return;
            }

            if (!currentPath || currentPath.length === 0) {
                currentPath = await planPath(
                    myAgent.pos,
                    { x: currentIntention.x_target, y: currentIntention.y_target }
                );
            }
            if (!currentPath || currentPath.length === 0) {
                // Arrived at the explore target: record the visit and clear the intention
                // so generateDesires picks the next best unvisited spawn tile next tick.
                const visitKey = `${currentIntention.x_target},${currentIntention.y_target}`;
                spawnVisitLog.set(visitKey, Date.now());
                console.log(`Explore target reached at (${currentIntention.x_target}, ${currentIntention.y_target}), marking visited.`);
                currentIntention = null;
                lastIntentionKey = null;
                return;
            }
            const dir = currentPath[0];
            const nextPos = nextPosition(myAgent.pos, dir);
            if ([...worldMap.crates.values()].some(c => c.pos.x === nextPos.x && c.pos.y === nextPos.y)) {
                console.log(`Crate blocking (${nextPos.x}, ${nextPos.y}), replanning...`);
                currentPath = null;
                return;
            }
            const result = await resilientMove(socket, dir, nextPos);
            if (result) {
                myAgent.pos.x = result.x;
                myAgent.pos.y = result.y;
                currentPath.shift();
            }
        }

    } catch (error) {
        console.error(error);
    } finally {
        isRunning = false;
    }
}

// Heartbeat: ensures the agent keeps moving even if sensing is slow/absent
const mainLoop = setInterval(() => bdiStep(), 500);