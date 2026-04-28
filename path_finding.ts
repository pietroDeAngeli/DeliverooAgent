import type { Position, Crate } from './Belief.ts';

interface QueueNode {
    x: number;
    y: number;
}

interface ParentEntry {
    parentKey: string;
    dir: string;
}

//TODO: It could make sense to separate the extraBlocked logic (for dynamic obstacles) from the static crate blocking, to avoid recomputing the blocked set every time we want to find a path with different dynamic obstacles. We could have a getBlockedSet(worldMap) function that returns the set of blocked positions based on crates and stationary agents, and then pass that to bfs

function bfs(
    start: Position,
    target: Position,
    tiles: Map<string, string>,
    width: number,
    height: number,
    crates: Map<string, Crate>,
    extraBlocked: Set<string> = new Set()
): string[] | null {
    if (!start || !target || !tiles) return null;

    const startKey = `${start.x},${start.y}`;
    const targetKey = `${target.x},${target.y}`;

    if (startKey === targetKey) return [];

    const queue: QueueNode[] = [{ x: start.x, y: start.y }];
    // parentMap stores how we reached each cell: avoids copying the path at every node (O(1) per node vs O(K))
    const parentMap = new Map<string, ParentEntry>();
    parentMap.set(startKey, { parentKey: '', dir: '' });

    const cratePositions = new Set([...crates.values()].map(c => `${c.pos.x},${c.pos.y}`));
    const blocked = new Set([...cratePositions, ...extraBlocked]);

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
        const current = queue.shift()!;
        const { x, y } = current;
        const currentKey = `${x},${y}`;

        if (currentKey === targetKey) {
            // Reconstruct path by walking parentMap backwards
            const path: string[] = [];
            let key = targetKey;
            while (key !== startKey) {
                const entry = parentMap.get(key)!;
                path.unshift(entry.dir);
                key = entry.parentKey;
            }
            return path;
        }

        const currentTileType = tiles.get(currentKey);

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
                !parentMap.has(key) &&
                !blocked.has(key)
            ) {
                parentMap.set(key, { parentKey: currentKey, dir: dir.name });
                queue.push({ x: nextX, y: nextY });
            }
        }
    }
    return null;
}

export { bfs };

/**
 * Forward-reachability flood-fill from `start` on the directed tile graph.
 * Follows the same one-way-tile rules as bfs(): a tile with direction symbol '↑/↓/←/→'
 * can only be *exited* in that direction.
 * Crates are intentionally excluded so the result reflects static map structure only
 * (crates may change during the game).
 *
 * Returns the set of tile keys "x,y" reachable from `start`.
 */
export function computeReachableTiles(
    start: Position,
    tiles: Map<string, string>
): Set<string> {
    const reachable = new Set<string>();
    const startKey = `${start.x},${start.y}`;
    const startType = tiles.get(startKey);
    if (!startType || startType === '0') return reachable;

    const oneWayMap: Record<string, string> = {
        '↑': 'up', '↓': 'down', '←': 'left', '→': 'right'
    };
    const directions = [
        { dx: 0,  dy: -1, name: 'down'  },
        { dx: 0,  dy:  1, name: 'up'    },
        { dx: -1, dy:  0, name: 'left'  },
        { dx:  1, dy:  0, name: 'right' }
    ];

    reachable.add(startKey);
    const queue: Position[] = [{ x: start.x, y: start.y }];

    while (queue.length > 0) {
        const { x, y } = queue.shift()!;
        const currentKey = `${x},${y}`;
        const currentType = tiles.get(currentKey)!;

        for (const { dx, dy, name } of directions) {
            // One-way tile: can only leave in the designated direction
            if (oneWayMap[currentType] && oneWayMap[currentType] !== name) continue;

            const nx = x + dx;
            const ny = y + dy;
            const key = `${nx},${ny}`;
            if (reachable.has(key)) continue;

            const nType = tiles.get(key);
            if (!nType || nType === '0') continue;

            reachable.add(key);
            queue.push({ x: nx, y: ny });
        }
    }

    return reachable;
}