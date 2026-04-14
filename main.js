import * as dotenv from 'dotenv';

import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

import { World, Agent } from "./Belief.js";
import { generateDesires } from "./Desire.js";
import { reviseIntention } from "./Intentions.js";
import * as utils from "./utils.js";

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
} );

socket.onConfig( config => {
    console.log('Config:', config);
    console.log('Agents observation distance:', config.GAME.player.agents_observation_distance);
})

let myAgent = undefined; //Agent()
let worldMap = undefined //World()
let carrying = Array();
let desires = Array();
let currentIntention = null;


socket.onYou( (agent) => {
    if (!myAgent) myAgent = new Agent(agent);
    else {
        myAgent.x = agent.x;
        myAgent.y = agent.y;
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
    if (!myAgent || !worldMap) return;

    try {
        desires = generateDesires(myAgent, worldMap, carrying);

        currentIntention = reviseIntention(currentIntention, desires, worldMap, carrying);

        //plan and execute currentIntention






        const availableParcels = utils.get_not_carried_parcels(worldMap.parcels);

        if (availableParcels.length > 0) {
            // --- Start mission ---
            console.log("Pack available. Starting mission...");
            
            const bestParcel = utils.get_best_parcel({ x: myAgent.x, y: myAgent.y }, worldMap.parcels, worldMap.tiles);
            if (!bestParcel) return;

            const pathToParcel = utils.get_shortest_path({ x: myAgent.x, y: myAgent.y }, bestParcel, worldMap);
            if (!pathToParcel) {
                console.log("No path to the parcel!");
                return;
            }

            // go to parcel
            for (const dir of pathToParcel) {
                const nextPos = nextPosition({ x: myAgent.x, y: myAgent.y }, dir);

                if (utils.is_cell_occupied(nextPos, myAgent.id, worldMap.other_agents, worldMap.crates)) {
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
            worldMap.update_parcels(pickedParcels);
            carrying = pickedParcels.filter(p => p.carriedBy === myAgent.id);
            if (carrying && carrying.length > 0) {

                const deliveryLocation = utils.get_closest("delivery", { x: myAgent.x, y: myAgent.y }, worldMap.tiles);
                if (!deliveryLocation) return;

                const pathToDelivery = utils.get_shortest_path({ x: myAgent.x, y: myAgent.y }, deliveryLocation, worldMap);
                if (!pathToDelivery) return;

                // go to delivery
                for (const dir of pathToDelivery) {
                    const nextPos = nextPosition({ x: myAgent.x, y: myAgent.y }, dir);

                    if (utils.is_cell_occupied(nextPos, myAgent.id, worldMap.other_agents, worldMap.crates)) {
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
                if (utils.tile_is('delivery', { x: myAgent.x, y: myAgent.y }, worldMap.tiles)) {
                    await socket.emitPutdown();
                    carrying.length = 0; // Clear carrying array
                    console.log("Mission completed successfully!");
                    worldMap.parcels.clear();
                } else {
                    console.log("Did not reach delivery location, skipping putdown.");
                }
            }

        } else {
            // --- NO PACKAGES: EXPLORE ---
            console.log("No parcels available. Going to the spawn");
            const closest_spawn = utils.get_closest("spawn", { x: myAgent.x, y: myAgent.y }, worldMap.tiles);
            const pathToSpawn = utils.get_shortest_path({ x: myAgent.x, y: myAgent.y }, closest_spawn, worldMap);
            if (!pathToSpawn) {
                console.log("No path to spawn!");
                return;
            }

            for (const dir of pathToSpawn) {
                const nextPos = nextPosition({ x: myAgent.x, y: myAgent.y }, dir);

                if (utils.is_cell_occupied(nextPos, myAgent.id, worldMap.other_agents, worldMap.crates)) {
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
    }
}, 500); 
