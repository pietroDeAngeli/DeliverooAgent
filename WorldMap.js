import { bfs } from './path_finding.js';
import { OpponentAgent } from './agent.js';

function get_distance(position1, position2) {
    return Math.abs(position1.x - position2.x) + Math.abs(position1.y - position2.y);
}

class Crate {
    id = undefined
    x = undefined
    y = undefined
    //timestamp = undefined
    constructor(crate) {
        this.id = crate.id;
        this.x = crate.x;
        this.y = crate.y;
        //this.timestamp = Date.now();
    }
}


class Parcel {
        id = undefined
        x = undefined
        y = undefined
        reward = undefined
        carriedBy = undefined
        timestamp = undefined

        constructor(parcel) {
            this.id = parcel.id;
            this.x = parcel.x;
            this.y = parcel.y;
            this.reward = parcel.reward;
            this.carriedBy = parcel.carriedBy;
            this.timestamp = Date.now();
        }

        get_utility(agentPosition) { 
            const distance = get_distance(agentPosition, { x: this.x, y: this.y });
            return distance > 0 ? this.reward / distance : this.reward;
        }
    }

class World {
    width = undefined
    height = undefined
    tiles = undefined
    other_agents = undefined
    parcels = undefined

    constructor(width, height, tiles) {
        this.width = width + 1;
        this.height = height + 1;
        this.tiles = new Map();
        tiles.forEach(tile => {
            this.tiles.set(`${tile.x},${tile.y}`, tile.type);
        });
        this.parcels = new Map();
        this.other_agents = new Map();
        this.crates = new Map();
    }

    // Update methods for parcels, crates, and agents

    update_parcels(parcels) {
        parcels.forEach(p => {
            if (!this.parcels.has(p.id)) {
                this.parcels.set(p.id, new Parcel(p));
            } else {
                const existingParcel = this.parcels.get(p.id);
                existingParcel.x = p.x;
                existingParcel.y = p.y;
                existingParcel.reward = p.reward;
                existingParcel.carriedBy = p.carriedBy;
                existingParcel.timestamp = Date.now();
            }
        });
    }

    update_crates(crates) {
        crates.forEach(c => {
            if (!this.crates.has(c.id)) {
                this.crates.set(c.id, new Crate(c));
            } else {
                const existingCrate = this.crates.get(c.id);
                existingCrate.x = c.x;
                existingCrate.y = c.y;
            }
        });
    }

    update_agents(agents) {
        const now = Date.now();
        const seenIds = new Set();

        agents.forEach(a => {
            seenIds.add(a.id);

            if (this.other_agents.has(a.id)) {
                const existingAgent = this.other_agents.get(a.id);
                existingAgent.direction = this.compute_direction(existingAgent, a);
                existingAgent.x = a.x;
                existingAgent.y = a.y;
                existingAgent.timestamp = now;
            } else {
                this.other_agents.set(a.id, new OpponentAgent(a, now));
            }
        });

        for (const [id, agent] of this.other_agents.entries()) {
            if (!seenIds.has(id) && now - agent.timestamp > 1500) {
                this.other_agents.delete(id);
            }
        }
    }

    // Getters and utility methods

    get_not_carried_parcels() {
        return Array.from(this.parcels.values()).filter(p => !p.carriedBy);
    }

    get_best_parcel(agent_position) { //TODO check if it is actually the best method to get the best parcel
        const notCarriedParcels = this.get_not_carried_parcels();
        if (notCarriedParcels.length === 0) return null;

        return notCarriedParcels.reduce((best, current) => {
            const bestUt = best.get_utility(agent_position);
            const currentUt = current.get_utility(agent_position);
            return currentUt > bestUt ? current : best;
        });
    }

    get_shortest_path(start, target) {
        return bfs(
            start,
            target,
            this.tiles,
            this.width,
            this.height,
            this.crates,
            this.other_agents
        );
    }

    get_closest_spawn_location(agent_position) {
        const spawnLocations = Array.from(this.tiles.entries())
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

    get_closest(type, agent_position) {
        const tileType = this.map_tile_type(type);
        const locations = Array.from(this.tiles.entries())
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

    get_predicted_occupied_cells() {
        const occupied = new Set();

        for (const agent of this.other_agents.values()) {
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

    compute_direction(oldAgent, newAgent) {
        if (oldAgent.x < newAgent.x) return 'right';
        if (oldAgent.x > newAgent.x) return 'left';
        if (oldAgent.y < newAgent.y) return 'up';
        if (oldAgent.y > newAgent.y) return 'down';
        return 'none';
    }

    tile_is(type, position) {
        const tileType = this.map_tile_type(type);
        return this.tiles.get(`${position.x},${position.y}`) === tileType;
    }

    map_tile_type(type) {
        switch (type) {
            case "delivery":
                return '2';
            case "spawn":
                return '1';
            default:
                return '0';
        }
    }

    is_cell_occupied(position, myId = null) {
        for (const agent of this.other_agents.values()) {
            if (agent.id !== myId && agent.x === position.x && agent.y === position.y) {
                return true;
            }
        }

        for (const crate of this.crates.values()) {
            if (crate.x === position.x && crate.y === position.y) {
                return true;
            }
        }

        return false;
    }
}

export { World };