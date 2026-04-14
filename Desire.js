import * as utils from "./utils.js";

class Desire {
    type = undefined;
    x_target = undefined;
    y_target = undefined;
    utility = undefined;

    constructor(type, x_target, y_target, utility) {
        this.type = type;
        this.x_target = x_target;
        this.y_target = y_target;
        this.utility = utility;
    }
}

export function generateDesires(myAgent, worldMap, carrying) {
    const desires = [];

    if (!myAgent || !worldMap) return desires;

    if (carrying && carrying.length > 0) {
        const delivery = utils.get_closest("delivery", myAgent, worldMap.tiles);
        if (delivery) {
            const utility = carrying.reduce((sum, parcel) => sum + parcel.get_utility(myAgent, worldMap.tiles), 0);
            desires.push(new Desire("go_delivery", delivery.x, delivery.y, utility));
        }
        return desires;
    }

    const parcels = utils.get_not_carried_parcels(worldMap.parcels);

    for (const parcel of parcels) {
        desires.push(new Desire("go_pickup", parcel.x, parcel.y, parcel.get_utility(myAgent, worldMap.tiles)));
    }

    const spawn = utils.get_closest("spawn", myAgent, worldMap.tiles);
    if (spawn) {
        desires.push(new Desire("explore", spawn.x, spawn.y, 
            1 / (utils.get_distance(myAgent, spawn) + 1))
        );
    }

    desires.sort((a, b) => b.utility - a.utility);

    return desires;
}