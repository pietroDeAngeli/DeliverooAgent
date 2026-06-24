import type { Position, Crate } from './BDI/Belief.ts';

interface QueueNode {
    x: number;
    y: number;
}

interface ParentEntry {
    parentKey: string;
    dir: string;
    depth: number;
}

const ONE_WAY: Record<string, string> = {
    '↑': 'up', '↓': 'down', '←': 'left', '→': 'right'
};

const DIRECTIONS = [
    { x: 0, y: -1, name: 'down' },
    { x: 0, y: 1, name: 'up' },
    { x: -1, y: 0, name: 'left' },
    { x: 1, y: 0, name: 'right' }
] as const;

export class PathFinder {
    private readonly parentMap: Map<string, ParentEntry>;
    private readonly startKey: string;

    constructor(parentMap: Map<string, ParentEntry>, startKey: string) {
        this.parentMap = parentMap;
        this.startKey = startKey;
    }

    getPath(target: Position): string[] | null {
        const targetKey = `${target.x},${target.y}`;
        if (!this.parentMap.has(targetKey)) return null;
        const path: string[] = [];
        let key = targetKey;
        while (key !== this.startKey) {
            const entry = this.parentMap.get(key)!;
            path.unshift(entry.dir);
            key = entry.parentKey;
        }
        return path;
    }

    getDistance(target: Position): number {
        return this.parentMap.get(`${target.x},${target.y}`)?.depth ?? Infinity;
    }
}

export function bfsFlood(
    start: Position,
    tiles: Map<string, string>,
    crates: Map<string, Crate>,
    extraBlocked: Set<string> = new Set()
): PathFinder {
    const startKey = `${start.x},${start.y}`;
    const parentMap = new Map<string, ParentEntry>();
    parentMap.set(startKey, { parentKey: '', dir: '', depth: 0 });

    const queue: QueueNode[] = [{ x: start.x, y: start.y }];
    const cratePositions = new Set([...crates.values()].map(c => `${c.pos.x},${c.pos.y}`));

    while (queue.length > 0) {
        const { x, y } = queue.shift()!;
        const currentKey = `${x},${y}`;
        const currentDepth = parentMap.get(currentKey)!.depth;
        const currentTileType = tiles.get(currentKey);

        for (const dir of DIRECTIONS) {
            if (currentTileType && ONE_WAY[currentTileType] && ONE_WAY[currentTileType] !== dir.name) {
                continue;
            }
            const nx = x + dir.x;
            const ny = y + dir.y;
            const key = `${nx},${ny}`;
            const nextTileType = tiles.get(key);

            // Basic passability: tile must exist, not be a wall, not already
            // reached, and not externally blocked.
            if (nextTileType === undefined || nextTileType === '0'
                || parentMap.has(key) || extraBlocked.has(key)) {
                continue;
            }

            // A crate on the next tile can be traversed only by pushing it one
            // tile further in the same direction; the landing tile must be a
            // free type-5 tile (server rule, see PushAgent.js). The resulting
            // step is an ordinary move in `dir` — the server performs the push.
            if (cratePositions.has(key)) {
                const bKey = `${nx + dir.x},${ny + dir.y}`;
                const beyondType = tiles.get(bKey);
                const pushable = beyondType !== undefined && beyondType.startsWith('5')
                    && !cratePositions.has(bKey) && !extraBlocked.has(bKey);
                if (!pushable) continue;
            }

            parentMap.set(key, { parentKey: currentKey, dir: dir.name, depth: currentDepth + 1 });
            queue.push({ x: nx, y: ny });
        }
    }

    return new PathFinder(parentMap, startKey);
}

