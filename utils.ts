import { bfs } from './path_finding.ts';
import type { Position, Parcel, World, OpponentAgent, Crate } from './Belief.ts';

export function get_distance(position1: Position, position2: Position): number {
    return Math.abs(position1.x - position2.x) + Math.abs(position1.y - position2.y);
}

export function get_not_carried_parcels(parcels: Map<string, Parcel>): Parcel[] {
    return Array.from(parcels.values()).filter(p => !p.carriedBy);
}

export function get_best_parcel(agent_position: Position, parcels: Map<string, Parcel>, tiles: Map<string, string>): Parcel | null { 
    const notCarriedParcels = get_not_carried_parcels(parcels);
    if (notCarriedParcels.length === 0) return null;

    return notCarriedParcels.reduce((best, current) => {
        const bestUt = best.get_utility(agent_position, tiles);
        const currentUt = current.get_utility(agent_position, tiles);
        return currentUt > bestUt ? current : best;
    });
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
    return bfs(
        start,
        target,
        worldMap.tiles,
        worldMap.width,
        worldMap.height,
        worldMap.crates,
        allBlocked
    );
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
    
    console.log(`Closest ${type} location: (${closest.x}, ${closest.y})`);
    return closest;
}

export function get_predicted_occupied_cells(other_agents: Map<string, OpponentAgent>): Set<string> { 
    const occupied = new Set<string>();

    for (const agent of other_agents.values()) {
        const { x, y } = agent.pos;
        occupied.add(`${x},${y}`);

        if (agent.direction === null) {
            // First observation: direction unknown — conservatively block all 4 neighbours
            // (we don't know where they came from or where they're going)
            occupied.add(`${x},${y + 1}`);
            occupied.add(`${x},${y - 1}`);
            occupied.add(`${x - 1},${y}`);
            occupied.add(`${x + 1},${y}`);
        } else if (agent.direction !== 'none') {
            // Block predicted next destination (where they'll go next)
            let nx = x, ny = y;   // next
            let px = x, py = y;   // previous (source tile, still locked during transit)
            if (agent.direction === 'up')    { ny = y + 1; py = y - 1; }
            if (agent.direction === 'down')  { ny = y - 1; py = y + 1; }
            if (agent.direction === 'left')  { nx = x - 1; px = x + 1; }
            if (agent.direction === 'right') { nx = x + 1; px = x - 1; }

            occupied.add(`${nx},${ny}`);  // destination of next move
            occupied.add(`${px},${py}`);  // source tile: still locked during the transit animation
        }
        // direction === 'none': agent stationary, current pos is enough
    }

    return occupied;
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