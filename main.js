import * as dotenv from 'dotenv';

//import 'dotenv/config'
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

import { Agent } from "./agent.js";
import { World } from "./WorldMap.js";

dotenv.config();
const url = process.env.HOST;
const token = process.env.TOKEN;

const socket = DjsConnect( url, token );

socket.onConnect( () => {
    console.log( "Connected to the server" );
} );

socket.onDisconnect( () => {
    console.log( "Disconnected from the server" );
    if (mainLoop) clearInterval(mainLoop);
    isBusy = false;
} );

socket.onConfig( config => {
    console.log('Config:', config);
    console.log('Agents observation distance:', config.GAME.player.agents_observation_distance);
})

let myAgent = undefined; //Agent()
let worldMap = undefined //World()
let isBusy = false;

socket.onYou( (agent) => {
    if (typeof agent === 'object' && agent !== null) {
        myAgent = new Agent(agent);
    }
});

socket.onMap( (width, height, tiles) => {
    worldMap = new World(width, height, tiles);
    console.log("Map initialized with dimensions:", width + 1, "x", height + 1);
    console.log("Initial tiles received:", tiles.length);
});

function nextPosition(pos, dir) {
    switch (dir) {
        case 'up': return { x: pos.x, y: pos.y + 1 };
        case 'down': return { x: pos.x, y: pos.y - 1 };
        case 'left': return { x: pos.x - 1, y: pos.y };
        case 'right': return { x: pos.x + 1, y: pos.y };
        default: return pos;
    }
}

async function resilientMove(socket, direction, maxRetries = 2) {
    for (let i = 0; i < maxRetries; i++) {

        const result = await socket.emitMove(direction);
        if (result) {
            console.log(`Moved ${direction} to (${result.x}, ${result.y})`);
            return result;
        }
        console.log(`Move ${direction} failed, attempt ${i + 1}. Retrying...`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return null;
}

socket.onSensing( ( sensing ) => {
    if (!myAgent || !worldMap) return;

    // Sensing update
    worldMap.update_parcels(sensing.parcels);
    worldMap.update_crates(sensing.crates);
    worldMap.update_agents(sensing.agents);
} )


const mainLoop = setInterval(async () => {
    if (!socket.connected) return;
    if (isBusy || !myAgent || !worldMap) return;

    isBusy = true;

    try {
        const availableParcels = worldMap.get_not_carried_parcels();

        if (availableParcels.length > 0) {
            // --- Start mission ---
            console.log("Pack available. Starting mission...");
            
            const bestParcel = worldMap.get_best_parcel({ x: myAgent.x, y: myAgent.y });
            if (!bestParcel) return;

            const pathToParcel = worldMap.get_shortest_path({ x: myAgent.x, y: myAgent.y }, bestParcel);
            if (!pathToParcel) {
                console.log("No path to the parcel!");
                return;
            }

            // go to parcel
            for (const dir of pathToParcel) {
                const nextPos = nextPosition(myAgent, dir);

                if (worldMap.is_cell_occupied(nextPos, myAgent.id)) {
                    console.log(`Cell (${nextPos.x}, ${nextPos.y}) occupied, replanning...`);
                    break;
                }

                const result = await resilientMove(socket, dir);
                if (result) {
                    myAgent.x = result.x;
                    myAgent.y = result.y;
                } else {
                    break;
                }
            }

            // Pick up
            const pickedParcels = await socket.emitPickup();
            if (pickedParcels && pickedParcels.length > 0) {
                console.log("Parcels picked up:", pickedParcels);

                const deliveryLocation = worldMap.get_closest("delivery", { x: myAgent.x, y: myAgent.y });
                if (!deliveryLocation) return;

                const pathToDelivery = worldMap.get_shortest_path({ x: myAgent.x, y: myAgent.y }, deliveryLocation);
                if (!pathToDelivery) return;

                // go to delivery
                for (const dir of pathToDelivery) {
                    const nextPos = nextPosition(myAgent, dir);

                    if (worldMap.is_cell_occupied(nextPos, myAgent.id)) {
                        console.log(`Cell (${nextPos.x}, ${nextPos.y}) occupied, replanning...`);
                        break;
                    }

                    const result = await resilientMove(socket, dir);
                    if (result) {
                        myAgent.x = result.x;
                        myAgent.y = result.y;
                    } else {
                        break;
                    }
                }

                // deliver (only if agent actually reached a delivery tile)
                if (worldMap.tile_is('delivery', { x: myAgent.x, y: myAgent.y })) {
                    await socket.emitPutdown();
                    console.log("Mission completed successfully!");
                    worldMap.parcels.clear();
                } else {
                    console.log("Did not reach delivery location, skipping putdown.");
                }
            }

        } else {
            // --- NO PACKAGES: EXPLORE ---
            console.log("No parcels available. Going to the spawn");
            const closest_spawn = worldMap.get_closest("spawn", { x: myAgent.x, y: myAgent.y });
            const pathToSpawn = worldMap.get_shortest_path({ x: myAgent.x, y: myAgent.y }, closest_spawn);
            if (!pathToSpawn) {
                console.log("No path to spawn!");
                return;
            }

            for (const dir of pathToSpawn) {
                const nextPos = nextPosition(myAgent, dir);

                if (worldMap.is_cell_occupied(nextPos, myAgent.id)) {
                    console.log(`Cell (${nextPos.x}, ${nextPos.y}) occupied, replanning...`);
                    break;
                }

                const result = await resilientMove(socket, dir);
                if (result) {
                    myAgent.x = result.x;
                    myAgent.y = result.y;
                } else {
                    break;
                }
            }

        }
    } catch (error) {
        console.error(error);
    } finally {
        isBusy = false;
    }
}, 500); 
