import type { Position, Crate, OpponentAgent } from './Belief.ts';

interface QueueNode {
    x: number;
    y: number;
    path: string[];
}

function bfs(
    start: Position, 
    target: Position, 
    tiles: Map<string, string>, 
    width: number, 
    height: number, 
    crates: Map<string, Crate>, 
    otherAgents: Map<string, OpponentAgent>
): string[] | null {
    if (!start || !target || !tiles) return null;

    const queue: QueueNode[] = [{ x: start.x, y: start.y, path: [] }];
    const visited = new Set<string>([`${start.x},${start.y}`]);
    
    const cratePositions = new Set([...crates.values()].map(c => `${c.pos.x},${c.pos.y}`));
    const agentPositions = new Set([...otherAgents.values()].map(a => `${a.pos.x},${a.pos.y}`));
    
    const oneWayMap: Record<string, string> = {
        '↑': 'up',
        '↓': 'down',
        '←': 'left',
        '→': 'right'
    };

    const directions = [
        { x: 0, y: -1, name: 'down' },
        { x: 0, y: 1, name: 'up' },
        { x: -1, y: 0, name: 'left' },
        { x: 1, y: 0, name: 'right' }
    ];

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break; 

        const { x, y, path } = current;

        if (x === target.x && y === target.y) return path;

        const currentTileType = tiles.get(`${x},${y}`);

        for (const dir of directions) {
            if (currentTileType && oneWayMap[currentTileType] && oneWayMap[currentTileType] !== dir.name) {
                continue; 
            }

            const nextX = x + dir.x;
            const nextY = y + dir.y;
            const key = `${nextX},${nextY}`;
            const nextTileType = tiles.get(key);

            if (
                nextTileType !== undefined &&
                nextTileType !== '0' &&
                !visited.has(key) &&
                !cratePositions.has(key) &&
                !agentPositions.has(key)
            ) {
                visited.add(key);
                queue.push({ x: nextX, y: nextY, path: [...path, dir.name] });
            }
        }
    }
    return null;
}

export { bfs };