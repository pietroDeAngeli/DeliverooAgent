import type { Desire } from "./Desire.ts";
import type { World, Parcel } from "./Belief.ts";

export function reviseIntention(currentIntention: Desire | null, desires: Desire[], worldMap: World, carrying: Parcel[], stepsSinceSwitch: number = 999): Desire | null {
    if (!desires.length) return null;

    const bestDesire = desires[0];

    if (!currentIntention) return bestDesire;

    if (!isIntentionValid(currentIntention, worldMap, carrying)) {
        return bestDesire;
    }

    // Explore is a low-priority fallback: immediately yield to any pickup or delivery
    if (currentIntention.type === 'explore' &&
        (bestDesire.type === 'go_pickup' || bestDesire.type === 'go_delivery')) {
        return bestDesire;
    }

    // Require a higher utility gain shortly after a switch to prevent oscillation between
    // two similarly-valued desires (thrashing). After 5 stable steps, normal threshold applies.
    const switchThreshold = stepsSinceSwitch < 5 ? 2.0 : 1.2;
    if (bestDesire.utility > currentIntention.utility * switchThreshold) {
        return bestDesire;
    }

    return currentIntention;
}

function isIntentionValid(intention: Desire | null, worldMap: World, carrying: Parcel[]): boolean {
    if (!intention) return false;

    if (intention.type === "go_delivery") {
        return carrying.length > 0;
    }

    if (intention.type === "go_pickup") {
        const parcels = worldMap.parcels;
        
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