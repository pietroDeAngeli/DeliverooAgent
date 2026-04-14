import * as dotenv from 'dotenv';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

import { World, Agent } from "./Belief.ts";
import type { Position } from "./Belief.ts";
import { generateDesires } from "./Desire.ts";
import { reviseIntention } from "./Intentions.ts";
import * as utils from "./utils.ts";

dotenv.config();

const url = process.env.HOST;
const token = process.env.TOKEN;

// Typecasting as string to satisfy TypeScript, assuming they are defined in .env
const socket = DjsConnect(url as string, token as string);

socket.onConnect(() => {
    console.log("Connected to the server");
});

socket.onDisconnect(() => {
    console.log("Disconnected from the server");
    if (mainLoop) clearInterval(mainLoop);
});

socket.onConfig((config: any) => {
    console.log('Config:', config);
    console.log('Agents observation distance:', config.GAME.player.agents_observation_distance);
});

let myAgent: Agent | undefined = undefined;
let worldMap: World | undefined = undefined;
let carrying: any[] = [];
let desires: any[] = [];
let currentIntention: any | null = null;

socket.onYou((agent: any) => {
    if (!myAgent) {
        myAgent = new Agent({ id: agent.id, x: agent.x, y: agent.y });
    } else {
        myAgent.pos.x = agent.x;
        myAgent.pos.y = agent.y;
    }
});

socket.onMap((width: number, height: number, tiles: any[]) => {
    worldMap = new World(width, height, tiles);
    console.log("Map initialized with dimensions:", width + 1, "x", height + 1);
    console.log("Initial tiles received:", tiles.length);
});

function nextPosition(pos: Position, dir: string): Position {
    switch (dir) {
        case 'up': return { x: pos.x, y: pos.y + 1 };
        case 'down': return { x: pos.x, y: pos.y - 1 };
        case 'left': return { x: pos.x - 1, y: pos.y };
        case 'right': return { x: pos.x + 1, y: pos.y };
        default: return pos;
    }
}

async function resilientMove(socket: any, direction: string, maxRetries: number = 2): Promise<Position | null> {
    for (let i = 0; i < maxRetries; i++) {
        const result = await socket.emitMove(direction);
        if (result) {
            console.log(`Moved ${direction} to (${result.x}, ${result.y})`);
            return { x: result.x, y: result.y };
        }
        console.log(`Move ${direction} failed, attempt ${i + 1}. Retrying...`);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return null;
}

socket.onSensing((sensing: any) => {
    if (!myAgent || !worldMap) return;

    // Sensing update
    // Assuming sensing payloads map to the expected interfaces inside World
    worldMap.update_parcels(sensing.parcels);
    worldMap.update_crates(sensing.crates);
    worldMap.update_agents(sensing.agents);
});

const mainLoop = setInterval(async () => {
    if (!socket.connected) return;
    if (!myAgent || !worldMap) return;

    try {
        desires = generateDesires(myAgent, worldMap, carrying);
        currentIntention = reviseIntention(currentIntention, desires, worldMap, carrying);

        //plan and execute currentIntention

        const availableParcels = utils.get_not_carried_parcels(worldMap.parcels);

        /*
        if (availableParcels.length > 0) {
            // --- Start mission ---
            console.log("Pack available. Starting mission...");
            
            const bestParcel = utils.get_best_parcel(myAgent.pos, worldMap.parcels, worldMap.tiles);
            if (!bestParcel) return;

            const pathToParcel = utils.get_shortest_path(myAgent.pos, bestParcel, worldMap);
            if (!pathToParcel) {
                console.log("No path to the parcel!");
                return;
            }

            // go to parcel
            for (const dir of pathToParcel) {
                const nextPos = nextPosition(myAgent.pos, dir);

                if (utils.is_cell_occupied(nextPos, myAgent.id, worldMap.other_agents, worldMap.crates)) {
                    console.log(`Cell (${nextPos.x}, ${nextPos.y}) occupied, replanning...`);
                    break;
                }

                const result = await resilientMove(socket, dir);
                if (result) {
                    myAgent.pos.x = result.x;
                    myAgent.pos.y = result.y;
                } else {
                    break;
                }
            }
            
            // Pick up
            const pickedParcels = await socket.emitPickup();
            worldMap.update_parcels(pickedParcels);
            carrying = pickedParcels.filter((p: any) => p.carriedBy === myAgent?.id);
            
            if (carrying && carrying.length > 0) {
                const deliveryLocation = utils.get_closest("delivery", myAgent.pos, worldMap.tiles);
                if (!deliveryLocation) return;
                
                const pathToDelivery = utils.get_shortest_path(myAgent.pos, deliveryLocation, worldMap);
                if (!pathToDelivery) return;

                // go to delivery
                for (const dir of pathToDelivery) {
                    const nextPos = nextPosition(myAgent.pos, dir);
                    
                    if (utils.is_cell_occupied(nextPos, myAgent.id, worldMap.other_agents, worldMap.crates)) {
                        console.log(`Cell (${nextPos.x}, ${nextPos.y}) occupied, replanning...`);
                        break;
                    }
                    
                    const result = await resilientMove(socket, dir);
                    if (result) {
                        myAgent.pos.x = result.x;
                        myAgent.pos.y = result.y;
                    } else {
                        break;
                }
            }
            
            // deliver (only if agent actually reached a delivery tile)
            if (utils.tile_is('delivery', myAgent.pos, worldMap.tiles)) {
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
            const closest_spawn = utils.get_closest("spawn", myAgent.pos, worldMap.tiles);
            const pathToSpawn = utils.get_shortest_path(myAgent.pos, closest_spawn, worldMap);
            
            if (!pathToSpawn) {
                console.log("No path to spawn!");
                return;
            }

            for (const dir of pathToSpawn) {
                const nextPos = nextPosition(myAgent.pos, dir);
                
                if (utils.is_cell_occupied(nextPos, myAgent.id, worldMap.other_agents, worldMap.crates)) {
                    console.log(`Cell (${nextPos.x}, ${nextPos.y}) occupied, replanning...`);
                    break;
                }
                
                const result = await resilientMove(socket, dir);
                if (result) {
                    myAgent.pos.x = result.x;
                    myAgent.pos.y = result.y;
                } else {
                    break;
            }
        }
    }
    */
    } catch (error) {
        console.error(error);
    }
}, 500);