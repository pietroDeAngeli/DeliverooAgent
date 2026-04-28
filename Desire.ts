import * as utils from "./utils.ts";
import type { Agent, World, Parcel, Position } from "./Belief.ts";

export class Desire {
    public type: string;
    public x_target: number;
    public y_target: number;
    public utility: number;

    constructor(type: string, x_target: number, y_target: number, utility: number) {
        this.type = type;
        this.x_target = x_target;
        this.y_target = y_target;
        this.utility = utility;
    }
}

export function generateDesires(myAgent: Agent | undefined, worldMap: World | undefined, carrying: Parcel[], spawnVisitLog: Map<string, number> = new Map()): Desire[] {
    const desires: Desire[] = [];

    if (!myAgent || !worldMap) return desires;

    const decayPerStep = worldMap.decayPerStep;
    const carriedQty = carrying.length;
    const carriedReward = carrying.reduce((sum, p) => sum + p.reward, 0);

    // Tiles occupied by stationary enemies (stationaryTicks >= 3): penalize targets on these tiles
    const stationaryEnemyTiles = new Set<string>();
    for (const a of worldMap.other_agents.values()) {
        if (a.stationaryTicks >= 3) {
            stationaryEnemyTiles.add(`${a.pos.x},${a.pos.y}`);
        }
    }

    // --- go_delivery: prefer tiles free of stationary enemies; fall back to blocked ones ---
    // Stationary-enemy check comes FIRST: we sort free tiles before blocked tiles so the agent
    // always targets an accessible delivery. If every tile is enemy-blocked we still emit a
    // desire (with heavy penalty) so delivery is never silently abandoned.
    if (carriedQty > 0) {
        const allDelivery = Array.from(worldMap.tiles.entries())
            .filter(([_, t]) => t === '2')
            .map(([key]) => { const [x, y] = key.split(',').map(Number); return { x, y }; });

        const freeDelivery = allDelivery
            .filter(d => !stationaryEnemyTiles.has(`${d.x},${d.y}`))
            .sort((a, b) => utils.get_distance(myAgent!.pos, a) - utils.get_distance(myAgent!.pos, b))
            .slice(0, 3);

        // Use free tiles; if none exist fall back to all delivery tiles sorted by distance
        const candidates = freeDelivery.length > 0
            ? freeDelivery
            : allDelivery
                .sort((a, b) => utils.get_distance(myAgent!.pos, a) - utils.get_distance(myAgent!.pos, b))
                .slice(0, 3);

        for (const delivery of candidates) {
            const dist = utils.get_distance(myAgent.pos, delivery);
            let utility = carriedReward - carriedQty * decayPerStep * dist;
            utility = Math.max(utility, 0.01);
            // Fallback tile: heavy penalty so a free alternative is always preferred
            if (stationaryEnemyTiles.has(`${delivery.x},${delivery.y}`)) utility *= 0.1;
            desires.push(new Desire("go_delivery", delivery.x, delivery.y, utility));
        }
    }

    // --- go_pickup: absolute net reward (carried + new parcel) at delivery ---
    const parcels = utils.get_not_carried_parcels(worldMap.parcels);
    for (const parcel of parcels) {
        // Always use the delivery closest to the parcel (minimizes final leg distance)
        const delivery = utils.get_closest("delivery", parcel.pos, worldMap.tiles) ?? parcel.pos;
        const distToParcel = utils.get_distance(myAgent.pos, parcel.pos);
        const distParcelToDelivery = utils.get_distance(parcel.pos, delivery);

        // Absolute net reward:
        //   carried rewards minus decay over the full trip (distToParcel + distParcelToDelivery)
        //   plus new parcel reward minus decay over its delivery leg
        const utilityRaw =
            (carriedReward - carriedQty * decayPerStep * (distToParcel + distParcelToDelivery))
            + (parcel.reward - decayPerStep * distParcelToDelivery);

        if (utilityRaw <= 0) continue;

        let utility = utilityRaw;

        // Competition: opponent closer to parcel → likely to pick it up first
        for (const agent of worldMap.other_agents.values()) {
            if (utils.get_distance(agent.pos, parcel.pos) < distToParcel) {
                utility *= 0.4;
                break;
            }
        }
        // Stationary enemy sitting on the parcel tile → nearly unreachable
        if (stationaryEnemyTiles.has(`${parcel.pos.x},${parcel.pos.y}`)) utility *= 0.05;

        desires.push(new Desire("go_pickup", parcel.pos.x, parcel.pos.y, utility));
    }

    // --- explore: cluster-aware, decay-penalised patrol of spawn tiles ---
    if (desires.length === 0) {
        const now = Date.now();
        // Cluster radius: spawns within this Manhattan distance contribute to each other's score
        const CLUSTER_RADIUS = 5;

        type SpawnInfo = { x: number; y: number; key: string; baseScore: number };
        const spawnInfos: SpawnInfo[] = [];

        for (const [key, type] of worldMap.tiles.entries()) {
            if (type !== '1') continue;
            const [sx, sy] = key.split(',').map(Number);
            const dist = utils.get_distance(myAgent.pos, { x: sx, y: sy });
            const lastVisited = spawnVisitLog.get(key) ?? 0;
            const recencyMs = now - lastVisited;
            // Penalise far tiles: walking there has a decay opportunity cost
            const baseScore = recencyMs / (dist + 1) - decayPerStep * dist * 1000;
            spawnInfos.push({ x: sx, y: sy, key, baseScore: Math.max(0, baseScore) });
        }

        // Density bonus: prefer tiles that are centres of clusters of unvisited spawns
        let bestScore = -Infinity;
        let bestSpawn: Position | null = null;

        for (const s of spawnInfos) {
            let totalScore = s.baseScore;
            for (const other of spawnInfos) {
                if (other.key === s.key) continue;
                const d = Math.abs(other.x - s.x) + Math.abs(other.y - s.y);
                if (d <= CLUSTER_RADIUS) {
                    totalScore += other.baseScore * 0.3 / (d + 1);
                }
            }
            if (totalScore > bestScore) {
                bestScore = totalScore;
                bestSpawn = { x: s.x, y: s.y };
            }
        }

        if (bestSpawn) {
            // Utility is intentionally tiny (< 1) so any visible pickup/delivery always dominates
            const utility = Math.max(Math.min(bestScore / 100000, 0.5), 0.001);
            desires.push(new Desire("explore", bestSpawn.x, bestSpawn.y, utility));
        }
    }

    desires.sort((a, b) => b.utility - a.utility);

    return desires;
}