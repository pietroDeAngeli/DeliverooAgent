import * as utils from "./utils.ts";
import type { Agent, World, Parcel } from "./Belief.ts";

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

export function generateDesires(myAgent: Agent | undefined, worldMap: World | undefined, carrying: Parcel[]): Desire[] {
    const desires: Desire[] = [];

    if (!myAgent || !worldMap) return desires;

    if (carrying && carrying.length > 0) {
        // Pass myAgent.pos instead of myAgent
        const delivery = utils.get_closest("delivery", myAgent.pos, worldMap.tiles);
        if (delivery) {
            const utility = carrying.reduce((sum, parcel) => sum + parcel.get_utility(myAgent.pos, worldMap.tiles), 0);
            desires.push(new Desire("go_delivery", delivery.x, delivery.y, utility));
        }
        return desires;
    }

    const parcels = utils.get_not_carried_parcels(worldMap.parcels);

    for (const parcel of parcels) {
        // Use parcel.pos.x and parcel.pos.y based on our new structure
        desires.push(new Desire("go_pickup", parcel.pos.x, parcel.pos.y, parcel.get_utility(myAgent.pos, worldMap.tiles)));
    }

    // Pass myAgent.pos instead of myAgent
    const spawn = utils.get_closest("spawn", myAgent.pos, worldMap.tiles);
    if (spawn) {
        desires.push(new Desire("explore", spawn.x, spawn.y, 
            1 / (utils.get_distance(myAgent.pos, spawn) + 1))
        );
    }

    desires.sort((a, b) => b.utility - a.utility);

    return desires;
}