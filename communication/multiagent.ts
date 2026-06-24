/**
 * communication/multiagent.ts
 *
 * Multi-agent communication layer: the peer-to-peer message protocol between the
 * master (LLM-enabled) and slave agents, plus the application of LLM-derived
 * world updates (blocked tiles, bonuses, missions, multi-agent commands) onto the
 * BDI state.
 *
 * These routines deliberately operate on a shared `CommsContext` rather than on
 * module-level globals, so the BDI loop in main.ts remains the single owner of the
 * agent's mutable state. The context exposes getters/setters bound to that state.
 */

import { Desire } from "../BDI/Desire.ts";
import type { StackConstraint } from "../BDI/Desire.ts";
import { Parcel } from "../BDI/Belief.ts";
import type { Position, World, Agent } from "../BDI/Belief.ts";
import * as utils from "../utils.ts";
import type { LLMClient, LLMUpdate } from "../LLM/llm.ts";

/**
 * Shared, mutable view of the agent state needed by the communication layer.
 * main.ts builds this with accessors bound to its own BDI/LLM/multi-agent state.
 */
export interface CommsContext {
    // ── Connection / role (read-only) ──────────────────────────────────────────
    readonly socket: any;
    readonly IS_MASTER: boolean;
    readonly godName: string;
    readonly useLLM: boolean;
    readonly llm: LLMClient | null;

    // ── Belief snapshot (read-only) ────────────────────────────────────────────
    readonly worldMap: World | undefined;
    readonly myAgent: Agent | undefined;

    // ── Reassignable scalar state ──────────────────────────────────────────────
    partnerAgentId: string | null;
    llmActiveMission: Desire | null;
    currentIntention: Desire | null;
    currentPath: string[] | null;
    rendezvousMaxDist: number;
    rendezvousInRange: boolean;
    rendezvousPartnerArrived: boolean;
    handoffRole: 'picker' | 'deliverer' | null;
    handoffPhase: 'pickup' | 'approach' | 'idle';
    handoffSlavePos: Position | null;
    handoffWaitStart: number | null;
    handoffWaitAtMeetStart: number | null;
    handoffExpectedParcelIds: Set<string> | null;

    // ── Live collections (mutated in place) ────────────────────────────────────
    readonly tempBlockedCells: Map<string, number>;
    readonly llmBlockedTiles: Set<string>;
    readonly llmPendingMissions: Desire[];
    readonly llmDeliveryBonusTiles: Map<string, number>;
    readonly llmBlockedDeliveryTiles: Set<string>;
    readonly llmStackConstraints: StackConstraint[];

    // ── Behaviours owned by main.ts ────────────────────────────────────────────
    debug(msg: string): void;
    clearIntention(): void;
}

// ── Meeting-point geometry ──────────────────────────────────────────────────────

/**
 * Bidirectional meeting point between two agents through the shared worldMap:
 * minimises max(distA, distB) so both travel roughly the same distance.
 * Returns null only when there are no reachable walkable tiles at all.
 */
export function computeMeetingPoint(
    worldMap: World | undefined,
    posA: Position,
    posB: Position,
    blocked: Set<string>,
): Position | null {
    if (!worldMap) return null;

    // BFS from A through the master's known worldMap.
    const finderA = utils.bfsFlood(posA, worldMap.tiles, worldMap.crates, blocked);

    // B may be standing on a non-walkable tile (delivery zone, obstacle).
    // Anchor B's BFS to the nearest walkable tile so the bidirectional search
    // always produces a real result.
    let startB: Position = posB;
    const pBtype = worldMap.tiles.get(`${posB.x},${posB.y}`);
    if (pBtype !== '0' && pBtype !== '1') {
        let bestDist = Infinity;
        for (const key of worldMap.tiles.keys()) {
            const t = worldMap.tiles.get(key);
            if (t !== '0' && t !== '1') continue;
            const [x, y] = key.split(',').map(Number);
            const d = Math.abs(x - posB.x) + Math.abs(y - posB.y);
            if (d < bestDist) { bestDist = d; startB = { x, y }; }
        }
    }
    const finderB = utils.bfsFlood(startB, worldMap.tiles, worldMap.crates, blocked);

    // Bidirectional meeting point: minimise max(dA, dB) so both agents travel
    // roughly the same distance. Tiebreak with dA+dB. Neither agent's own tile.
    let best: Position | null = null;
    let bestMax = Infinity;
    let bestSum = Infinity;

    for (const key of worldMap.tiles.keys()) {
        const tileType = worldMap.tiles.get(key);
        if (tileType !== '0' && tileType !== '1') continue;
        const [x, y] = key.split(',').map(Number);
        const dA = finderA.getDistance({ x, y });
        const dB = finderB.getDistance({ x, y });
        if (dA === Infinity || dB === Infinity || dA === 0 || dB === 0) continue;
        const mx = Math.max(dA, dB);
        const sm = dA + dB;
        if (mx < bestMax || (mx === bestMax && sm < bestSum)) {
            bestMax = mx; bestSum = sm; best = { x, y };
        }
    }
    return best;
}

function findDirectionalDeliveryTile(worldMap: World | undefined, direction: string): { x: number; y: number } | null {
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

// ── LLM world updates ───────────────────────────────────────────────────────────

/**
 * Apply a batch of LLM-derived updates (blocked tiles, bonuses, missions and
 * multi-agent commands) onto the shared BDI/LLM state.
 */
export function applyLLMUpdates(ctx: CommsContext, updates: LLMUpdate): void {
    for (const tile of updates.goToTiles) {
        console.log(`[LLM] new go_to mission: (${tile.x},${tile.y}) u=${tile.utility}`);
        ctx.llmPendingMissions.push(new Desire("go_to", tile.x, tile.y, tile.utility));
    }
    for (const tileKey of updates.blockedTiles) {
        console.log(`[LLM] blocking tile: ${tileKey}`);
        ctx.llmBlockedTiles.add(tileKey);
    }
    for (const bonus of updates.deliveryBonusTiles) {
        const key = `${bonus.x},${bonus.y}`;
        ctx.llmDeliveryBonusTiles.set(key, bonus.multiplier);
        console.log(`[LLM] delivery bonus: (${bonus.x},${bonus.y}) x${bonus.multiplier}`);
    }
    for (const key of updates.blockedDeliveryTiles) {
        ctx.llmBlockedDeliveryTiles.add(key);
        console.log(`[LLM] blocked delivery tile: ${key}`);
    }
    for (const constraint of updates.deliveryConstraints) {
        const tile = findDirectionalDeliveryTile(ctx.worldMap, constraint.direction);
        if (!tile) { console.log(`[LLM] delivery constraint: tile ${constraint.direction} not found`); continue; }
        if (constraint.points < 0) {
            console.log(`[LLM] blocking delivery tile (${tile.x},${tile.y}) dir=${constraint.direction}`);
            ctx.llmBlockedTiles.add(`${tile.x},${tile.y}`);
        } else {
            console.log(`[LLM] new go_delivery mission: (${tile.x},${tile.y}) dir=${constraint.direction} pts=${constraint.points}`);
            ctx.llmPendingMissions.push(new Desire("go_delivery", tile.x, tile.y, constraint.points));
        }
    }
    for (const constraint of updates.stackConstraints) {
        const op = constraint.operator as StackConstraint['operator'];
        const mode = (constraint.mode ?? 'count') as StackConstraint['mode'];
        const existing = ctx.llmStackConstraints.findIndex(c => c.count === constraint.count && c.operator === op && (c.mode ?? 'count') === mode);
        const entry: StackConstraint = { count: constraint.count, operator: op, multiplier: constraint.multiplier, mode };
        if (existing >= 0) ctx.llmStackConstraints[existing] = entry;
        else ctx.llmStackConstraints.push(entry);
        const label = mode === 'score' ? 'score' : 'parcels';
        console.log(`[LLM] stack constraint: ${op} ${constraint.count} ${label} → x${constraint.multiplier}`);
    }
    if (updates.multiAgentCommand) {
        const cmd = updates.multiAgentCommand;
        if (cmd.type === 'rendezvous') {
            ctx.rendezvousMaxDist = cmd.maxDist;
            ctx.rendezvousInRange = false;
            ctx.rendezvousPartnerArrived = false;
            const utility = cmd.points > 0 ? cmd.points : 9999;

            // Master computes the optimal midpoint between the two agents and tells the slave.
            // Both then navigate to the same computed meeting tile rather than the LLM-supplied
            // coordinates (which might be suboptimal or only reachable by one agent quickly).
            let meetX = cmd.x, meetY = cmd.y;
            if (ctx.IS_MASTER && ctx.myAgent && ctx.worldMap && ctx.partnerAgentId) {
                const partnerEntry = ctx.worldMap.other_agents.get(ctx.partnerAgentId);
                if (partnerEntry) {
                    const partnerPos = { x: Math.round(partnerEntry.pos.x), y: Math.round(partnerEntry.pos.y) };
                    const now = Date.now();
                    const blocked = new Set([
                        ...[...ctx.tempBlockedCells.entries()].filter(([, u]) => u > now).map(([k]) => k),
                        ...ctx.llmBlockedTiles,
                    ]);
                    const meet = computeMeetingPoint(ctx.worldMap, ctx.myAgent.pos, partnerPos, blocked);
                    if (meet) { meetX = meet.x; meetY = meet.y; }
                }
                ctx.socket.emitSay(ctx.partnerAgentId, JSON.stringify({ kind: 'RENDEZVOUS_TARGET', x: meetX, y: meetY }))
                    .catch((err: unknown) => console.warn('[Rendezvous] Failed to send target to slave:', err));
            }

            ctx.llmPendingMissions.push(new Desire('rendezvous', meetX, meetY, utility));
            console.log(`[Rendezvous] target=(${meetX},${meetY}) maxDist=${ctx.rendezvousMaxDist} pts=${utility}`);
        } else if (cmd.type === 'wait_row') {
            if (ctx.llmActiveMission?.type !== 'wait_row' && !ctx.llmPendingMissions.some(m => m.type === 'wait_row')) {
                ctx.llmPendingMissions.push(new Desire('wait_row', 0, 0, 9999, cmd.parity));
                console.log(`[Multi-agent] wait_row (${cmd.parity}) queued`);
            }
        } else if (cmd.type === 'resume') {
            if (ctx.llmActiveMission?.type === 'wait_row') {
                ctx.llmActiveMission = null;
                ctx.clearIntention();
                console.log('[Multi-agent] resume: cleared wait_row mission');
            }
            const idx = ctx.llmPendingMissions.findIndex(m => m.type === 'wait_row');
            if (idx >= 0) ctx.llmPendingMissions.splice(idx, 1);
        } else if (cmd.type === 'parcel_handoff') {
            const utility = cmd.points > 0 ? cmd.points : 9999;
            if (ctx.IS_MASTER) {
                ctx.handoffRole = 'picker';
                ctx.handoffPhase = 'pickup';
                ctx.handoffSlavePos = null;
                ctx.handoffWaitStart = null;
                console.log(`[Handoff] Role: picker — normal BDI will acquire parcel, then meet slave (pts=${utility})`);
            } else {
                ctx.handoffRole = 'deliverer';
                ctx.handoffPhase = 'idle';
                console.log('[Handoff] Role: deliverer — waiting for picker signal');
                // Report our position to the picker so it can compute the meeting point
                if (ctx.partnerAgentId && ctx.myAgent) {
                    ctx.socket.emitSay(ctx.partnerAgentId, JSON.stringify({
                        kind: 'HANDOFF_SLAVE_POS', x: ctx.myAgent.pos.x, y: ctx.myAgent.pos.y,
                    })).catch((err: unknown) => console.warn('[Handoff] Failed to report position:', err));
                }
            }
        }
    }
}

// ── Inbound message handling ────────────────────────────────────────────────────

/**
 * Handle an inbound chat message. Peer messages from the partner agent carry the
 * JSON multi-agent protocol; admin ("god") messages are processed through the LLM
 * by the master and forwarded to the slave.
 */
export async function handleMessage(
    ctx: CommsContext,
    id: string,
    name: string,
    msg: any,
    reply: ((response: any) => void) | undefined,
): Promise<void> {
    // Peer message from partner agent (JSON with kind: 'LLM_UPDATE')
    if (name !== ctx.godName) {
        ctx.debug(`[Multi-agent] Raw peer message from ${id} (${name}): ${typeof msg} length=${String(msg).length}`);

        // Auto-discover partner on first non-admin message
        if (!ctx.partnerAgentId) {
            ctx.partnerAgentId = id;
            console.log(`[Multi-agent] Partner discovered: ${ctx.partnerAgentId} (${name})`);
        }

        if (id === ctx.partnerAgentId) {
            try {
                const msgStr = typeof msg === 'string' ? msg : JSON.stringify(msg);
                if (!msgStr.startsWith('{')) {
                    ctx.debug(`[Multi-agent] Non-JSON peer message from ${name}, ignoring`);
                    return;
                }
                const peerMsg = JSON.parse(msgStr);
                ctx.debug(`[Multi-agent] Parsed peer message: ${JSON.stringify(peerMsg).substring(0, 100)}`);

                if (peerMsg.kind === 'LLM_UPDATE') {
                    console.log('[Multi-agent] Received LLM update from master, applying to BDI');
                    applyLLMUpdates(ctx, peerMsg.updates);
                } else if (peerMsg.kind === 'RENDEZVOUS_ARRIVED') {
                    console.log('[Rendezvous] Partner arrived at rendezvous tile');
                    ctx.rendezvousPartnerArrived = true;
                    // Completion is handled in the BDI loop (checks mutual distance on next tick)
                } else if (peerMsg.kind === 'RENDEZVOUS_TARGET') {
                    // Master computed the optimal meeting point — update our navigation target.
                    const rx = Math.round(Number(peerMsg.x));
                    const ry = Math.round(Number(peerMsg.y));
                    const idx = ctx.llmPendingMissions.findIndex(m => m.type === 'rendezvous');
                    if (idx >= 0) {
                        const u = ctx.llmPendingMissions[idx].utility;
                        ctx.llmPendingMissions[idx] = new Desire('rendezvous', rx, ry, u);
                    } else if (ctx.llmActiveMission?.type === 'rendezvous') {
                        ctx.llmActiveMission = new Desire('rendezvous', rx, ry, ctx.llmActiveMission.utility);
                        ctx.currentIntention = ctx.llmActiveMission;
                        ctx.currentPath = null;
                    }
                    console.log(`[Rendezvous] Updated meeting point to (${rx},${ry})`);
                } else if (peerMsg.kind === 'HANDOFF_SLAVE_POS') {
                    ctx.handoffSlavePos = { x: Math.round(Number(peerMsg.x)), y: Math.round(Number(peerMsg.y)) };
                    console.log(`[Handoff] Master: slave is at (${ctx.handoffSlavePos.x},${ctx.handoffSlavePos.y})`);
                } else if (peerMsg.kind === 'HANDOFF_APPROACH') {
                    // Picker has picked up a parcel and is moving toward us
                    const px = Number(peerMsg.x);
                    const py = Number(peerMsg.y);
                    console.log(`[Handoff] Deliverer: picker at (${px},${py}), heading toward them`);
                    ctx.handoffPhase = 'approach';
                    if (ctx.llmActiveMission?.type === 'handoff_deliverer_approach') {
                        ctx.llmActiveMission.x_target = px;
                        ctx.llmActiveMission.y_target = py;
                        ctx.currentPath = null;
                    } else {
                        if (ctx.llmActiveMission) ctx.llmPendingMissions.unshift(ctx.llmActiveMission);
                        ctx.llmActiveMission = null;
                        ctx.clearIntention();
                        ctx.llmPendingMissions.unshift(new Desire('handoff_deliverer_approach', px, py, 9999));
                    }
                } else if (peerMsg.kind === 'HANDOFF_DROPPED') {
                    // Picker dropped the parcel — go pick it up and deliver
                    const dx = Number(peerMsg.x);
                    const dy = Number(peerMsg.y);
                    console.log(`[Handoff] Deliverer: parcel dropped at (${dx},${dy}), picking up`);
                    ctx.handoffRole = null;
                    ctx.handoffPhase = 'idle';
                    ctx.handoffWaitAtMeetStart = null;
                    if (ctx.llmActiveMission?.type === 'handoff_deliverer_approach') {
                        ctx.llmActiveMission = null;
                        ctx.clearIntention();
                    }
                    const hdIdx = ctx.llmPendingMissions.findIndex(m => m.type === 'handoff_deliverer_approach');
                    if (hdIdx >= 0) ctx.llmPendingMissions.splice(hdIdx, 1);
                    // Pre-populate worldMap so toPickup is non-empty when slave arrives
                    if (ctx.worldMap && Array.isArray(peerMsg.parcels)) {
                        ctx.handoffExpectedParcelIds = new Set(peerMsg.parcels.map((pd: any) => pd.id));
                        console.log(`[Handoff] Deliverer: expecting parcel IDs: ${[...ctx.handoffExpectedParcelIds].join(', ')}`);
                        for (const pd of peerMsg.parcels) {
                            ctx.worldMap.parcels.set(pd.id, new Parcel(
                                { id: pd.id, x: dx, y: dy, reward: pd.reward, carriedBy: null }, Date.now(),
                            ));
                        }
                    }
                    ctx.llmPendingMissions.unshift(new Desire('go_pickup', dx, dy, 9999));
                } else {
                    ctx.debug(`[Multi-agent] Peer message has unexpected kind: ${peerMsg.kind}`);
                }
            } catch (err) {
                console.warn('[Multi-agent] Failed to parse peer message:', err instanceof Error ? err.message : err);
                ctx.debug(`[Multi-agent] Message was: ${String(msg).substring(0, 200)}`);
            }
        } else {
            ctx.debug(`[Multi-agent] Ignoring message from ${id}; expected partner ${ctx.partnerAgentId}`);
        }
        return;
    }

    // Admin message — only the master processes via LLM
    if (!ctx.useLLM || !ctx.IS_MASTER) return;
    if (!ctx.llm) { console.log("[LLM] client not ready yet, skipping message"); return; }

    console.log(`[LLM] msg from ${name}(${id}): "${msg}"`);

    try {
        const result = await ctx.llm.processMessage(msg, ctx.myAgent ? { x: ctx.myAgent.pos.x, y: ctx.myAgent.pos.y } : null);
        console.log(`[LLM] reply: "${result.reply || "(none)"}"`);

        applyLLMUpdates(ctx, result.updates);

        // Forward processed updates (and any conversational reply) to slave BEFORE calling reply()
        if (ctx.partnerAgentId) {
            try {
                await ctx.socket.emitSay(ctx.partnerAgentId, JSON.stringify({ kind: 'LLM_UPDATE', updates: result.updates, reply: result.reply }));
                console.log(`[Multi-agent] Forwarded LLM update to slave ${ctx.partnerAgentId}`);
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
                ctx.socket.emitShout(result.reply);
            }
        }
    } catch (err) {
        console.error("[LLM] processMessage error (agent continues):", err instanceof Error ? err.message : err);
    }
}
