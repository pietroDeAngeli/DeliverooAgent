export function reviseIntention(currentIntention, desires, worldMap, carrying) {
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

function isIntentionValid(intention, worldMap, carrying) {
    if (!intention) return false;

    if (intention.type === "go_delivery") {
        return carrying && carrying.length > 0;
    }

    if (intention.type === "go_pickup") {
        const parcels = worldMap.parcels;
        return Array.from(parcels.values()).some(
            p => p.x === intention.x_target &&
                 p.y === intention.y_target &&
                 !p.carriedBy
        );
    }

    if (intention.type === "explore") {
        return true;
    }

    return false;
}