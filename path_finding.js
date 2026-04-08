function bfs(start, target, tiles, width, height, crates, otherAgents) {
    if (!start || !target || !tiles) return null;

    const queue = [{ x: start.x, y: start.y, path: [] }];
    const visited = new Set([`${start.x},${start.y}`]);
    const cratePositions = new Set([...crates.values()].map(c => `${c.x},${c.y}`));
    const agentPositions = new Set([...otherAgents.values()].map(a => `${a.x},${a.y}`));
    
    const oneWayMap = {
        '↑': 'up',
        '↓': 'down',
        '←': 'left',
        '→': 'right'
    };

    // Kept your direction logic exactly as provided
    const directions = [
        { x: 0, y: -1, name: 'down' },
        { x: 0, y: 1, name: 'up' },
        { x: -1, y: 0, name: 'left' },
        { x: 1, y: 0, name: 'right' }
    ];

    while (queue.length > 0) {
        const { x, y, path } = queue.shift();

        if (x === target.x && y === target.y) return path;

        const currentTileType = tiles.get(`${x},${y}`);

        for (const dir of directions) {
            // One way check
            if (oneWayMap[currentTileType] && oneWayMap[currentTileType] !== dir.name) {
                continue; 
            }

            const nextX = x + dir.x;
            const nextY = y + dir.y;
            const key = `${nextX},${nextY}`;
            const nextTileType = tiles.get(key);

            // Validation: tile exists, not visited, not a wall, no agents and no crates
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