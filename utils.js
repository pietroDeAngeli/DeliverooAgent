import { bfs } from './path_finding.js';

export function get_distance(position1, position2) {
    return Math.abs(position1.x - position2.x) + Math.abs(position1.y - position2.y);
}


export function get_not_carried_parcels(parcels) {
    return Array.from(parcels.values()).filter(p => !p.carriedBy);
}

export function get_best_parcel(agent_position, parcels) { 
    const notCarriedParcels = get_not_carried_parcels(parcels);
    if (notCarriedParcels.length === 0) return null;

    return notCarriedParcels.reduce((best, current) => {
        const bestUt = best.get_utility(agent_position);
        const currentUt = current.get_utility(agent_position);
        return currentUt > bestUt ? current : best;
    });
}

export function get_shortest_path(start, target, worldMap) {
    return bfs(
        start,
        target,
        worldMap.tiles,
        worldMap.width,
        worldMap.height,
        worldMap.crates,
        worldMap.other_agents
    );
}

export function get_closest_spawn_location(agent_position, tiles) {//TODO im not using it
    const spawnLocations = Array.from(tiles.entries())
        .filter(([_, type]) => type === '1')
        .map(([key, _]) => {
            const [x, y] = key.split(',').map(Number);
            return { x, y };
        });
    if (spawnLocations.length === 0) return null;
    const closest = spawnLocations.reduce((acc, curr) => {
        const accDistance = get_distance(agent_position, acc);
        const currDistance = get_distance(agent_position, curr);
        return currDistance < accDistance ? curr : acc;
    }, spawnLocations[0]);
    return closest;
}   

export function get_closest(type, agent_position, tiles) {
    const tileType = map_tile_type(type);
    const locations = Array.from(tiles.entries())
        .filter(([_, t]) => t === tileType)
        .map(([key, _]) => {
            const [x, y] = key.split(',').map(Number);
            return { x, y };
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

export function get_predicted_occupied_cells(other_agents) { // Im not using it
    const occupied = new Set();

    for (const agent of other_agents.values()) {
        occupied.add(`${agent.x},${agent.y}`);

        let next = null;
        if (agent.direction === 'up') next = { x: agent.x, y: agent.y + 1 };
        if (agent.direction === 'down') next = { x: agent.x, y: agent.y - 1 };
        if (agent.direction === 'left') next = { x: agent.x - 1, y: agent.y };
        if (agent.direction === 'right') next = { x: agent.x + 1, y: agent.y };

        if (next) occupied.add(`${next.x},${next.y}`);
    }

    return occupied;
}

export function compute_direction(oldAgent, newAgent) {
    if (oldAgent.x < newAgent.x) return 'right';
    if (oldAgent.x > newAgent.x) return 'left';
    if (oldAgent.y < newAgent.y) return 'up';
    if (oldAgent.y > newAgent.y) return 'down';
    return 'none';
}

export function tile_is(type, position, tiles) {
    const tileType = map_tile_type(type);
    return tiles.get(`${position.x},${position.y}`) === tileType;
}

export function map_tile_type(type) {
    switch (type) {
        case "delivery":
            return '2';
        case "spawn":
            return '1';
        default:
            return '0';
    }
}

export function is_cell_occupied(position, myId = null, other_agents, crates) {
    for (const agent of other_agents.values()) {
        if (agent.id !== myId && agent.x === position.x && agent.y === position.y) {
            return true;
        }
    }

    for (const crate of crates.values()) {
        if (crate.x === position.x && crate.y === position.y) {
            return true;
        }
    }

    return false;
}