import * as utils from "../utils.ts";

/**
 * Shared Interfaces
 */
export interface Position {
    x: number;
    y: number;
}

// The server sends flat objects, so we extend Position to inherit x and y
export interface RawEntity extends Position {
    id: string;
}

export interface RawParcel extends RawEntity {
    reward: number;
    carriedBy: string | null;
}

export interface RawTile extends Position {
    type: string;
}

/**
 * Class Definitions
 */
class Agent {
    public id: string;
    public pos: Position;

    // Convert server's flat x/y into our internal nested pos object
    constructor(agent: RawEntity) {
        this.id = agent.id;
        this.pos = { x: agent.x, y: agent.y };
    }
}

class OpponentAgent extends Agent {
    public timestamp: number;
    public direction: string | null;
    public stationaryTicks: number;

    constructor(agent: RawEntity, timestamp: number) {
        super(agent);
        this.timestamp = timestamp;
        this.direction = null;
        this.stationaryTicks = 0;
    }
}

class Crate {
    public id: string;
    public pos: Position;
    public timestamp: number;

    constructor(crate: RawEntity, timestamp: number) {
        this.id = crate.id;
        this.pos = { x: crate.x, y: crate.y };
        this.timestamp = timestamp;
    }
}

class Parcel {
    public id: string;
    public pos: Position;
    public reward: number;
    public carriedBy: string | null;
    public timestamp: number;

    constructor(parcel: RawParcel, timestamp: number) {
        this.id = parcel.id;
        this.pos = { x: parcel.x, y: parcel.y };
        this.reward = parcel.reward;
        this.carriedBy = parcel.carriedBy;
        this.timestamp = timestamp;
    }
}

class World {
    public width: number;
    public height: number;
    public tiles: Map<string, string>;
    public other_agents: Map<string, OpponentAgent>;
    public parcels: Map<string, Parcel>;
    public crates: Map<string, Crate>;
    public lifespan: number;
    public movementDuration: number;   // ms per step (from config.GAME.player.movement_duration)
    public parcelDecayIntervalMs: number; // ms per 1 reward point lost (from config.GAME.parcels.decaying_event, e.g. "1s" → 1000)

    /** Reward points lost per movement step: movementDuration / parcelDecayIntervalMs */
    get decayPerStep(): number {
        return this.movementDuration / this.parcelDecayIntervalMs;
    }

    constructor(width: number, height: number, tiles: RawTile[], movementDuration: number, parcelDecayIntervalMs: number) {
        this.width = width + 1;
        this.height = height + 1;
        this.tiles = new Map();
        
        tiles.forEach(tile => {
            this.tiles.set(`${tile.x},${tile.y}`, tile.type);
        });

        this.parcels = new Map();
        this.other_agents = new Map();
        this.crates = new Map();
        this.lifespan = 15000; // ms to keep unseen parcels/agents/crates in memory before forgetting them
        this.movementDuration = movementDuration;
        this.parcelDecayIntervalMs = parcelDecayIntervalMs;
    }

    public update_parcels(parcels: RawParcel[]): void {
        const now = Date.now();
        const seenIds = new Set<string>();

        parcels.forEach(p => {
            if (p.carriedBy) {
                this.parcels.delete(p.id);
                return;
            }

            seenIds.add(p.id);

            const existingParcel = this.parcels.get(p.id);
            if (!existingParcel) {
                this.parcels.set(p.id, new Parcel(p, now));
            } else {
                existingParcel.pos = { x: p.x, y: p.y };
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

    public update_crates(crates: RawEntity[]): void {
        const now = Date.now();
        crates.forEach(c => {
            const existingCrate = this.crates.get(c.id);
            if (!existingCrate) {
                this.crates.set(c.id, new Crate(c, now));
            } else {
                existingCrate.pos = { x: c.x, y: c.y };
                existingCrate.timestamp = now;
            }
        });
    }

    public removeParcelAt(pos: Position): void {
        for (const [id, parcel] of this.parcels.entries()) {
            if (parcel.pos.x === pos.x && parcel.pos.y === pos.y) {
                this.parcels.delete(id);
            }
        }
    }

    public update_agents(agents: RawEntity[]): void {
        const now = Date.now();
        const seenIds = new Set<string>();

        agents.forEach(a => {
            seenIds.add(a.id);
            const newPos = { x: a.x, y: a.y };

            const existingAgent = this.other_agents.get(a.id);
            if (existingAgent) {
                existingAgent.direction = utils.compute_direction(existingAgent.pos, newPos);
                existingAgent.stationaryTicks = existingAgent.direction === 'none'
                    ? existingAgent.stationaryTicks + 1
                    : 0;
                existingAgent.pos = newPos;
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

export { World, Agent, Parcel, Crate, OpponentAgent };