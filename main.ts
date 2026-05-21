import * as dotenv from 'dotenv';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

import { World, Agent, Parcel } from "./BDI/Belief.ts";
import type { Position } from "./BDI/Belief.ts";
import { Desire, generateDesires } from "./BDI/Desire.ts";
import { reviseIntention } from "./BDI/Intentions.ts";
import * as utils from "./utils.ts";
import { getPddlPath } from "./pddl_planner.ts";
import { LLMClient } from "./LLM/llm.ts";

dotenv.config();

const socket = DjsConnect(process.env.HOST as string, process.env.TOKEN as string);

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
const USE_PDDL           = process.env.USE_PDDL === 'true';
const USE_LLM_ARG        = process.argv.includes('--use-llm');

console.log(`[Planner] ${USE_PDDL ? 'PDDL local (Fast Downward)' : 'BFS (default)'}`);
console.log(`[LLM]     ${(USE_LLM_ARG || process.env.USE_LLM === 'true') ? 'enabled' : 'disabled'}`);
// ── LLM state ─────────────────────────────────────────────────────────────────
// This is basically the belief state for the LLM

const godID = "";
const godName = "";
let useLLM = USE_LLM_ARG || process.env.USE_LLM === 'true';
let llm = new LLMClient();
let llmDesires: Desire[] = [];
let llmBlockedTiles: Set<string> = new Set();
let llmDeliveryCarryMultiplier: Map<number, number> = new Map();
let llmGoToTile: Desire[] = []; // prevedo loop infinito
// TODO: drop in <dir>most tile to get X points not implemented

// ── Helpers ───────────────────────────────────────────────────────────────────

function clearIntention(): void {
    currentIntention = null;
    lastIntention    = null;
    currentPath      = null;
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

function handleNoPath(key: string, label: string): void {
    const ticks = (intentionStuckTicks.get(key) ?? 0) + 1;
    intentionStuckTicks.set(key, ticks);
    if (ticks >= STUCK_THRESHOLD) {
        blockedIntentions.set(key, Date.now() + INTENTION_BLOCK_MS);
        intentionStuckTicks.delete(key);
        console.log(`[Stuck] No path: blocking "${key}" for ${INTENTION_BLOCK_MS / 1000}s`);
    } else {
        console.log(`No path to ${label} (${ticks}/${STUCK_THRESHOLD}).`);
    }
    currentIntention = null;
    lastIntention    = null;
}

async function planPath(start: Position, target: Position): Promise<string[] | null> {
    if (!worldMap) return null;
    const now     = Date.now();
    const blocked = new Set([...tempBlockedCells.entries()].filter(([, u]) => u > now).map(([k]) => k));

    if (USE_PDDL) {
        // Return BFS path immediately so the agent is never frozen while the PDDL
        // subprocess starts up. PDDL runs in the background; when it resolves it
        // replaces currentPath only if the agent hasn't moved yet (same start tile)
        // and is still pursuing the same intention target.
        const bfsPath      = utils.get_shortest_path(start, target, worldMap, blocked);
        const capturedType = currentIntention?.type;
        const capturedTx   = target.x;
        const capturedTy   = target.y;
        const wm = worldMap;
        const bl = new Set(blocked);
        console.log(`[PDDL] ${start.x},${start.y} -> ${target.x},${target.y}`);
        getPddlPath(start, target, wm, bl).then(pddlPath => {
            if (!pddlPath || isRunning) return;
            const sameTarget =
                currentIntention?.type     === capturedType &&
                currentIntention?.x_target === capturedTx   &&
                currentIntention?.y_target === capturedTy;
            if (sameTarget && myAgent?.pos.x === start.x && myAgent?.pos.y === start.y) {
                console.log(`[PDDL] path applied (${pddlPath.length} steps)`);
                currentPath = pddlPath;
            }
        }).catch(() => {});
        return bfsPath;
    }

    return utils.get_shortest_path(start, target, worldMap, blocked);
}

async function resilientMove(direction: string, nextPos: Position): Promise<Position | null> {
    const key = `${nextPos.x},${nextPos.y}`;
    if (recentlyFailedCells.has(key)) return null;
    if (worldMap && utils.is_collision_predicted(nextPos.x, nextPos.y, worldMap.other_agents)) {
        console.log(`Predicted collision at (${nextPos.x},${nextPos.y}), replanning.`);
        currentPath = null;
        return null;
    }
    const result = await socket.emitMove(direction);
    if (result) {
        console.log(`Moved ${direction} to (${result.x},${result.y})`);
        return { x: result.x, y: result.y };
    }
    console.log(`Move ${direction} failed at (${nextPos.x},${nextPos.y}).`);
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
    parcelDecayInterval = m ? parseFloat(m[1]) * 1000 : 1;
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

    // Drop carried parcels that expired or were stolen
    const sensingMap = new Map<string, any>(sensing.parcels.map((p: any) => [p.id, p]));
    carrying = carrying.filter(c => {
        const sp = sensingMap.get(c.id);
        if (!sp) return true;                                            // off-map: still carrying
        if (sp.reward <= 0) return false;                               // expired
        if (sp.carriedBy && sp.carriedBy !== myAgent!.id) return false; // stolen
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
            console.log(`[Bounce] ABAB (${pa.x},${pa.y})<->(${pb.x},${pb.y}), blocking 4s`);
        }
    }

    bdiStep();
});

socket.onMsg( async (id: string, name: string, msg: any, reply: ((response: any) => void) | undefined) => {
    if (useLLM && name === godName && id === godID) {
        console.log("new msg received: ", msg);

        const result = await llm.processMessage(msg, myAgent ? { x: myAgent.pos.x, y: myAgent.pos.y } : null);

        // Apply desire updates from LLM
        for (const tile of result.updates.goToTiles) {
            llmGoToTile.push(new Desire("go_to", tile.x, tile.y, tile.utility));
        }
        for (const tileKey of result.updates.blockedTiles) {
            llmBlockedTiles.add(tileKey);
        }
        for (const constraint of result.updates.deliveryConstraints) {
            const tile = findDirectionalDeliveryTile(constraint.direction);
            if (!tile) continue;
            if (constraint.points < 0) {
                llmBlockedTiles.add(`${tile.x},${tile.y}`);
            } else {
                llmGoToTile.push(new Desire("go_delivery", tile.x, tile.y, constraint.points));
            }
        }

        if (result.reply && reply) {
            reply(result.reply);
        }
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
        // Priority: deliver immediately if standing on a delivery tile
        if (carrying.length > 0 && utils.tile_is('delivery', myAgent.pos, worldMap.tiles)) {
            const res = await socket.emitPutdown();
            if (res) {
                console.log(`[Priority] Delivered ${carrying.length} parcel(s) at (${myAgent.pos.x},${myAgent.pos.y})`);
                carrying.length = 0;
                clearIntention();
            }
            return;
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
        
        let desires = generateDesires(myAgent, worldMap, carrying, spawnVisitLog, activeBlocked, llmGoToTile);


        // ── Intention revision ────────────────────────────────────────────────
        const prevIntention  = currentIntention;
        currentIntention     = reviseIntention(currentIntention, desires, worldMap, carrying, stepsSinceSwitch);
        const switched =
            !currentIntention || !prevIntention ||
            currentIntention.type      !== prevIntention.type ||
            currentIntention.x_target  !== prevIntention.x_target ||
            currentIntention.y_target  !== prevIntention.y_target;
        stepsSinceSwitch = switched ? 0 : stepsSinceSwitch + 1;

        // Refresh stored utility with current tick value
        if (currentIntention) {
            const match = desires.find(d =>
                d.type     === currentIntention!.type &&
                d.x_target === currentIntention!.x_target &&
                d.y_target === currentIntention!.y_target,
            );
            if (match) currentIntention.utility = match.utility;
        }

        // If go_pickup/go_delivery target vanished from desires (parcel expired/stolen),
        // clear immediately rather than walking toward a ghost.
        if (currentIntention && currentIntention.type !== 'explore') {
            const stillValid = desires.some(d =>
                d.type     === currentIntention!.type &&
                d.x_target === currentIntention!.x_target &&
                d.y_target === currentIntention!.y_target,
            );
            if (!stillValid) {
                console.log(`[BDI] target gone: ${currentIntention.type}@(${currentIntention.x_target},${currentIntention.y_target})`);
                clearIntention();
            }
        }

        if (!currentIntention) return;

        // Expire stale blocks; skip if current intention is blocked, try fallback
        for (const [k, u] of blockedIntentions) if (u <= now) blockedIntentions.delete(k);
        const intentionKey = `${currentIntention.type}:${currentIntention.x_target},${currentIntention.y_target}`;
        if (blockedIntentions.has(intentionKey)) {
            const fallback = desires.find(d => !blockedIntentions.has(`${d.type}:${d.x_target},${d.y_target}`));
            currentIntention = fallback ?? null;
            if (!currentIntention) lastIntention = null;
        }

        if (!currentIntention) {
            // Release soonest-expiring block so the agent doesn't freeze for the full INTENTION_BLOCK_MS.
            // Prefer explore blocks; pickup blocks on physically-blocked tiles are more expensive to retry.
            const sorted  = [...blockedIntentions.entries()].sort(([, a], [, b]) => a - b);
            const release = sorted.find(([k]) => k.startsWith('explore:')) ?? sorted[0];
            if (release) { blockedIntentions.delete(release[0]); console.log(`[BDI] all blocked, releasing ${release[0]}`); }
            else          { console.log('[BDI] no active intention'); }
            return;
        }

        // ── BDI status log ────────────────────────────────────────────────────
        bdiTick++;
        if (switched || bdiTick % 5 === 0) {
            const top     = desires.slice(0, 4).map(d => `${d.type}@(${d.x_target},${d.y_target})=${d.utility.toFixed(2)}`).join(' | ');
            const blocked = [...blockedIntentions.keys()].join(', ');
            console.log(
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
                if (res !== false) {
                    for (const p of toPickup)
                        if (!carrying.some(c => c.id === p.id)) carrying.push(p);
                    console.log(toPickup.length > 0
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
            const moved = await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));
            // Opportunistic delivery while en-route to pickup
            if (moved && carrying.length > 0 && utils.tile_is('delivery', myAgent.pos, worldMap.tiles)) {
                const res = await socket.emitPutdown();
                if (res) {
                    console.log(`Opportunistic delivery at (${myAgent.pos.x},${myAgent.pos.y})`);
                    carrying.length = 0;
                    clearIntention();
                }
            }

        } else if (currentIntention.type === 'go_delivery') {
            if (myAgent.pos.x === currentIntention.x_target && myAgent.pos.y === currentIntention.y_target) {
                const res = await socket.emitPutdown();
                if (res) {
                    console.log(`Delivered at (${myAgent.pos.x},${myAgent.pos.y})`); 
                    carrying.length = 0;
                    // Remove any LLM-injected go_delivery desire for this tile
                    llmGoToTile = llmGoToTile.filter(d =>
                        !(d.type === 'go_delivery' && d.x_target === currentIntention!.x_target && d.y_target === currentIntention!.y_target)
                    );
                }
                clearIntention();
                return;
            }
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, { x: currentIntention.x_target, y: currentIntention.y_target });
            if (!currentPath?.length) {
                handleNoPath(`go_delivery:${currentIntention.x_target},${currentIntention.y_target}`, 'delivery');
                return;
            }
            await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));

        } else if (currentIntention.type === 'explore') {
            const target = { x: currentIntention.x_target, y: currentIntention.y_target };
            if (utils.get_distance(myAgent.pos, target) <= agentObsDistance) {
                spawnVisitLog.set(`${target.x},${target.y}`, Date.now());
                console.log(`[Explore] Visited (${target.x},${target.y})`);
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
                llmGoToTile = llmGoToTile.filter(d =>
                    d.x_target !== currentIntention!.x_target || d.y_target !== currentIntention!.y_target
                );
                clearIntention();
                return;
            }
            if (!currentPath?.length)
                currentPath = await planPath(myAgent.pos, { x: currentIntention.x_target, y: currentIntention.y_target });
            if (!currentPath?.length) {
                handleNoPath(`go_to:${currentIntention.x_target},${currentIntention.y_target}`, `(${currentIntention.x_target},${currentIntention.y_target})`);
                return;
            }
            await stepTowards(currentPath[0], utils.nextPosition(myAgent.pos, currentPath[0]));
        }

    } catch (err) {
        console.error(err);
    } finally {
        // Physical stuck detection: block intention if agent held same intention but didn't move
        if (prevKey && myAgent) {
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
                    console.log(`[Stuck] No progress: blocking "${prevKey}" for ${INTENTION_BLOCK_MS / 1000}s`);
                    clearIntention();
                }
            }
        }
        isRunning = false;
    }
}

const mainLoop = setInterval(() => bdiStep(), 500);
