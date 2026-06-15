import * as utils from "../utils.ts";
import type { Agent, World, Parcel } from "./Belief.ts";

export class Desire {
    type: string;
    x_target: number;
    y_target: number;
    utility: number;

    constructor(type: string, x_target: number, y_target: number, utility: number) {
        this.type     = type;
        this.x_target = x_target;
        this.y_target = y_target;
        this.utility  = utility;
    }
}

const CLUSTER_RADIUS      = 5;
const BOT_PRESSURE_WEIGHT = 2.0;
const PICKUP_THREAT_RADIUS = 4;

function buildExploreDesires(
    agentFinder: utils.PathFinder,
    worldMap: World,
    spawnVisitLog: Map<string, number>,
    decayPerStep: number,
): Desire[] {
    const now = Date.now();

    type SpawnInfo = { x: number; y: number; key: string; baseScore: number };
    const spawnInfos: SpawnInfo[] = [];
    for (const [key, type] of worldMap.tiles.entries()) {
        if (type !== '1') continue;
        const [sx, sy] = key.split(',').map(Number);
        const dist      = agentFinder.getDistance({ x: sx, y: sy });
        const recencyMs = now - (spawnVisitLog.get(key) ?? 0);
        const baseScore = recencyMs / (dist + 1) - decayPerStep * dist * 1000;
        spawnInfos.push({ x: sx, y: sy, key, baseScore: Math.max(0, baseScore) });
    }

    // Pre-compute cluster size and opponent pressure per spawn tile
    const clusterSize = new Map<string, number>();
    const botPressure = new Map<string, number>();
    for (const s of spawnInfos) {
        let c = 0, b = 0;
        for (const o of spawnInfos)
            if (Math.abs(o.x - s.x) + Math.abs(o.y - s.y) <= CLUSTER_RADIUS) c++;
        for (const a of worldMap.other_agents.values())
            if (Math.abs(a.pos.x - s.x) + Math.abs(a.pos.y - s.y) <= CLUSTER_RADIUS) b++;
        clusterSize.set(s.key, c);
        botPressure.set(s.key, b);
    }

    // Score each spawn: density bonus + bot-pressure malus
    const scored = spawnInfos
        .map(s => {
            let score = s.baseScore;
            for (const o of spawnInfos) {
                if (o.key === s.key) continue;
                const d = Math.abs(o.x - s.x) + Math.abs(o.y - s.y);
                if (d <= CLUSTER_RADIUS) score += o.baseScore * 0.3 / (d + 1);
            }
            const bots  = botPressure.get(s.key) ?? 0;
            const cSize = Math.max(clusterSize.get(s.key) ?? 1, 1);
            if (bots > 0) score *= 1 / (1 + BOT_PRESSURE_WEIGHT * bots / cSize);
            return { x: s.x, y: s.y, score };
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

    // Top 3 with slightly decreasing utility to form a fallback chain if one is blocked
    return scored.slice(0, 3).map((sp, i) => {
        const utility = Math.max(Math.min(sp.score / 100_000, 0.5), 0.001) * 0.95 ** i;
        return new Desire("explore", sp.x, sp.y, utility);
    });
}

export function generateDesires(
    myAgent: Agent | undefined,
    worldMap: World | undefined,
    carrying: Parcel[],
    spawnVisitLog: Map<string, number> = new Map(),
    extraBlocked: Set<string> = new Set(),
    llmGoToTile: Desire[] = [],
    forcedDeliveryKeys: Set<string> = new Set(),
): Desire[] {
    if (!myAgent || !worldMap) return [];

    const agentFinder   = utils.bfsFlood(myAgent.pos, worldMap.tiles, worldMap.crates, extraBlocked);
    const decayPerStep  = worldMap.decayPerStep;
    const carriedQty    = carrying.length;
    const carriedReward = carrying.reduce((sum, p) => sum + p.reward, 0);

    const stationaryEnemies = new Set(
        [...worldMap.other_agents.values()]
            .filter(a => a.stationaryTicks >= 3)
            .map(a => `${a.pos.x},${a.pos.y}`),
    );

    const desires: Desire[] = [];

    // ── go_delivery ───────────────────────────────────────────────────────────
    if (carriedQty > 0) {
        const allDelivery = [...worldMap.tiles.entries()]
            .filter(([, t]) => t === '2')
            .map(([key]) => { const [x, y] = key.split(',').map(Number); return { x, y }; });

        const freeDelivery = allDelivery
            .filter(d => !stationaryEnemies.has(`${d.x},${d.y}`))
            .sort((a, b) => agentFinder.getDistance(a) - agentFinder.getDistance(b))
            .slice(0, 3);

        const candidates = freeDelivery.length > 0
            ? freeDelivery
            : allDelivery.sort((a, b) => agentFinder.getDistance(a) - agentFinder.getDistance(b)).slice(0, 3);

        // Always include LLM-bonus delivery tiles even if outside the top-3 by distance
        for (const key of forcedDeliveryKeys) {
            if (!candidates.some(c => `${c.x},${c.y}` === key)) {
                const found = allDelivery.find(d => `${d.x},${d.y}` === key);
                if (found) candidates.push(found);
            }
        }

        for (const d of candidates) {
            const dist = agentFinder.getDistance(d);
            if (dist === Infinity) continue;
            let utility = Math.max(carriedReward - carriedQty * decayPerStep * dist, 0.01);
            if (stationaryEnemies.has(`${d.x},${d.y}`)) utility *= 0.1;
            desires.push(new Desire("go_delivery", d.x, d.y, utility));
        }
    }

    // ── go_pickup ─────────────────────────────────────────────────────────────
    for (const parcel of worldMap.parcels.values()) {
        const distToParcel = agentFinder.getDistance(parcel.pos);
        if (distToParcel === Infinity) continue;

        const delivery           = utils.get_closest("delivery", parcel.pos, worldMap.tiles) ?? parcel.pos;
        const distParcelToDelivery = utils.get_distance(parcel.pos, delivery);

        const utilityRaw =
            (carriedReward - carriedQty * decayPerStep * (distToParcel + distParcelToDelivery))
            + (parcel.reward - decayPerStep * distParcelToDelivery);
        if (utilityRaw <= 0) continue;

        let utility = utilityRaw;
        let nearbyBots = 0;
        for (const a of worldMap.other_agents.values())
            if (utils.get_distance(a.pos, parcel.pos) <= PICKUP_THREAT_RADIUS) nearbyBots++;
        if (nearbyBots > 0)                                              utility *= 0.6 ** nearbyBots;
        if (stationaryEnemies.has(`${parcel.pos.x},${parcel.pos.y}`))   utility *= 0.05;

        desires.push(new Desire("go_pickup", parcel.pos.x, parcel.pos.y, utility));
    }

    // ── explore (always generated; utility < 1 so pickup/delivery always dominate) ──
    desires.push(...buildExploreDesires(agentFinder, worldMap, spawnVisitLog, decayPerStep));

    // ── go_to (LLM) ─────────────────────────────────────────────────────────────────
    desires.push(...llmGoToTile);

    return desires.sort((a, b) => b.utility - a.utility);
}
