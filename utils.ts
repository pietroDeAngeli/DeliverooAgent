import { bfsFlood, PathFinder } from './path_finding.ts';
export { bfsFlood, PathFinder };
import type { Position, Parcel, World, OpponentAgent, Crate } from './BDI/Belief.ts';
import type { Desire } from './BDI/Desire.ts';

// ── Mission/intention helpers ──────────────────────────────────────────────────

// Two missions are "the same" when they share type and target tile.
export function sameMission(a: Desire | null, b: Desire | null): boolean {
    return !!a && !!b &&
        a.type === b.type &&
        a.x_target === b.x_target &&
        a.y_target === b.y_target;
}

// Canonical string key for a mission ("type:x,y"), used for stuck/blocked tracking.
export function missionKey(mission: Desire): string {
    return `${mission.type}:${mission.x_target},${mission.y_target}`;
}

export function get_distance(position1: Position, position2: Position): number {
    return Math.abs(position1.x - position2.x) + Math.abs(position1.y - position2.y);
}

// Agents stationary for at least this many consecutive sensing updates are treated as BFS obstacles
const STATIONARY_OBSTACLE_THRESHOLD = 3;

//TODO: check if it makes sense or if it should be treated in another way

export function get_shortest_path(start: Position, target: Position, worldMap: World, extraBlocked: Set<string> = new Set()): string[] | null {
    const stationaryBlocked = new Set<string>();
    for (const agent of worldMap.other_agents.values()) {
        if (agent.stationaryTicks >= STATIONARY_OBSTACLE_THRESHOLD) {
            stationaryBlocked.add(`${agent.pos.x},${agent.pos.y}`);
        }
    }
    const allBlocked = new Set([...stationaryBlocked, ...extraBlocked]);
    return bfsFlood(start, worldMap.tiles, worldMap.crates, allBlocked).getPath(target);
}

export function get_closest(type: string, agent_position: Position, tiles: Map<string, string>): Position | null {
    const tileType = map_tile_type(type);
    const locations = Array.from(tiles.entries())
        .filter(([_, t]) => t === tileType)
        .map(([key, _]) => {
            const [x, y] = key.split(',').map(Number);
            return { x, y } as Position;
        });

    if (locations.length === 0) return null;

    const closest = locations.reduce((acc, curr) => {
        const accDistance = get_distance(agent_position, acc);
        const currDistance = get_distance(agent_position, curr);
        return currDistance < accDistance ? curr : acc;
    }, locations[0]);
    
    return closest;
}


export function is_collision_predicted(cx: number, cy: number, other_agents: Map<string, OpponentAgent>): boolean {
    for (const agent of other_agents.values()) {
        const { x, y } = agent.pos;

        // Current position is always blocked
        if (x === cx && y === cy) return true;

        if (agent.direction === null) {
            // Direction unknown: conservatively block all 4 neighbours
            if ((x === cx && Math.abs(y - cy) === 1) || (y === cy && Math.abs(x - cx) === 1)) return true;
        } else if (agent.direction !== 'none') {
            let nx = x, ny = y;   // predicted next position
            let px = x, py = y;   // source tile still locked during transit
            if (agent.direction === 'up')    { ny = y + 1; py = y - 1; }
            if (agent.direction === 'down')  { ny = y - 1; py = y + 1; }
            if (agent.direction === 'left')  { nx = x - 1; px = x + 1; }
            if (agent.direction === 'right') { nx = x + 1; px = x - 1; }
            if ((nx === cx && ny === cy) || (px === cx && py === cy)) return true;
        }
        // direction === 'none': current pos already checked above
    }
    return false;
}

export function compute_direction(oldPos: Position, newPos: Position): string {
    if (oldPos.x < newPos.x) return 'right';
    if (oldPos.x > newPos.x) return 'left';
    if (oldPos.y < newPos.y) return 'up';
    if (oldPos.y > newPos.y) return 'down';
    return 'none';
}

export function tile_is(type: string, position: Position, tiles: Map<string, string>): boolean {
    const tileType = map_tile_type(type);
    return tiles.get(`${position.x},${position.y}`) === tileType;
}

export function map_tile_type(type: string): string {
    switch (type) {
        case "delivery":
            return '2';
        case "spawn":
            return '1';
        default:
            return '0';
    }
}

export function is_cell_occupied(position: Position, myId: string | null = null, other_agents: Map<string, OpponentAgent>, crates: Map<string, Crate>): boolean {
    for (const agent of other_agents.values()) {
        if (agent.id !== myId && agent.pos.x === position.x && agent.pos.y === position.y) {
            return true;
        }
    }

    for (const crate of crates.values()) {
        if (crate.pos.x === position.x && crate.pos.y === position.y) {
            return true;
        }
    }

    return false;
}

export function nextPosition(pos: Position, dir: string): Position {
    switch (dir) {
        case 'up': return { x: pos.x, y: pos.y + 1 };
        case 'down': return { x: pos.x, y: pos.y - 1 };
        case 'left': return { x: pos.x - 1, y: pos.y };
        case 'right': return { x: pos.x + 1, y: pos.y };
        default: return pos;
    }
}