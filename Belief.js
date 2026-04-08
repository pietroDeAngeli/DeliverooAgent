
import * as utils from "./utils.js";

class Agent {
    id = undefined;
    //name = undefined;
    x = undefined;
    y = undefined;
    //score = undefined;
    //penalty = undefined;

    constructor(agent) {
        this.id = agent.id;
        //this.name = agent.name;
        this.x = agent.x;
        this.y = agent.y;
        //this.score = agent.score;
        //this.penalty = agent.penalty;
    }
}

class OpponentAgent extends Agent {
    timestamp = undefined;
    direction = undefined;

    constructor(agent, timestamp) {
        super(agent);
        this.timestamp = timestamp;
        this.direction = null;
    }

}

class Crate {
    id = undefined
    x = undefined
    y = undefined
    timestamp = undefined
    constructor(crate, timestamp) {
        this.id = crate.id;
        this.x = crate.x;
        this.y = crate.y;
        this.timestamp = timestamp;
    }
}


class Parcel {
    id = undefined
    x = undefined
    y = undefined
    reward = undefined
    carriedBy = undefined
    timestamp = undefined

    constructor(parcel, timestamp) {
        this.id = parcel.id;
        this.x = parcel.x;
        this.y = parcel.y;
        this.reward = parcel.reward;
        this.carriedBy = parcel.carriedBy;
        this.timestamp = timestamp;
    }

    get_utility(agentPosition) { 
        const distance = utils.get_distance(agentPosition, { x: this.x, y: this.y });
        return distance > 0 ? this.reward / distance : this.reward;
    }
}

class World {
    width = undefined
    height = undefined
    tiles = undefined
    other_agents = undefined
    parcels = undefined
    crates = undefined
    lifespan = undefined

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
        this.lifespan = 1500;
    }

    update_parcels(parcels) {
        const now = Date.now();
        const seenIds = new Set();

        parcels.forEach(p => {
            seenIds.add(p.id);

            if (!this.parcels.has(p.id)) {
                this.parcels.set(p.id, new Parcel(p, now));
            } else {
                const existingParcel = this.parcels.get(p.id);
                existingParcel.x = p.x;
                existingParcel.y = p.y;
                existingParcel.reward = p.reward;
                existingParcel.carriedBy = p.carriedBy;
                existingParcel.timestamp = now;
            }
        });

        for (const [id, parcel] of this.parcels.entries()) {
            if (!seenIds.has(id) && now - parcel.timestamp > this.lifespan) {
                this.parcels.delete(id);
            }
        }
    }

    update_crates(crates) {
        const now = Date.now();
        crates.forEach(c => {
            if (!this.crates.has(c.id)) {
                this.crates.set(c.id, new Crate(c, now));
            } else {
                const existingCrate = this.crates.get(c.id);
                existingCrate.x = c.x;
                existingCrate.y = c.y;
                existingCrate.timestamp = now;
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
                existingAgent.direction = utils.compute_direction(existingAgent, a);
                existingAgent.x = a.x;
                existingAgent.y = a.y;
                existingAgent.timestamp = now;
            } else {
                this.other_agents.set(a.id, new OpponentAgent(a, now));
            }
        });

        for (const [id, agent] of this.other_agents.entries()) {
            if (!seenIds.has(id) && now - agent.timestamp > this.lifespan) {
                this.other_agents.delete(id);
            }
        }
    }

}

export { World, Agent };