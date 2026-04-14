import type { Desire } from "./Desire.ts";
import type { World, Parcel } from "./Belief.ts";

export function reviseIntention(currentIntention: Desire | null, desires: Desire[], worldMap: World, carrying: Parcel[]): Desire | null {
    if (!desires.length) return null;

    const bestDesire = desires[0];

    if (!currentIntention) return bestDesire;

    if (!isIntentionValid(currentIntention, worldMap, carrying)) {
        return bestDesire;
    }

    if (bestDesire.utility > currentIntention.utility * 1.2) {
        return bestDesire;
    }

    return currentIntention;
}

function isIntentionValid(intention: Desire | null, worldMap: World, carrying: Parcel[]): boolean {
    if (!intention) return false;

    if (intention.type === "go_delivery") {
        return carrying && carrying.length > 0;
    }

    if (intention.type === "go_pickup") {
        const parcels = worldMap.parcels;
        
        // Updated to use p.pos.x and p.pos.y to match our new class structure
        return Array.from(parcels.values()).some(
            p => p.pos.x === intention.x_target &&
                 p.pos.y === intention.y_target &&
                 !p.carriedBy
        );
    }

    if (intention.type === "explore") {
        return true;
    }

    return false;
}