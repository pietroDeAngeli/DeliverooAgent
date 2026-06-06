/**
 * pddl_planner.ts
 *
 * Drop-in async replacement for BFS path finding using Fast Downward (local solver).
 * Writes domain + problem PDDL to disk, runs fast-downward.py, and parses the plan.
 *
 * Requires Fast Downward to be built under pddl/downward/.
 * Override the Python executable via the PYTHON_CMD env var (default: 'python').
 */

import { exec } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import type { Position, World, Crate } from './BDI/Belief.ts';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const PDDL_DIR    = join(__dirname, 'pddl');

// Absolute paths used only for Node.js fs operations
const DOMAIN_FILE  = join(PDDL_DIR, 'deliveroo-domain.pddl');
const PROBLEM_FILE = join(PDDL_DIR, 'deliveroo-problem.pddl');
const PLAN_FILE    = join(PDDL_DIR, 'deliveroo-plan');

// Relative paths used in the shell command (cwd = PDDL_DIR).
const DOWNWARD_REL  = join('downward', 'fast-downward.py');
const DOMAIN_REL    = 'deliveroo-domain.pddl';
const PROBLEM_REL   = 'deliveroo-problem.pddl';
const PLAN_REL      = 'deliveroo-plan';
const PYTHON_CMD    = process.env.PYTHON_CMD ?? 'python3';

// Fast Downward writes to fixed paths (output.sas, deliveroo-plan).
// Only one invocation may run at a time to avoid file conflicts.
let pddlLock = false;

const ONE_WAY_EXIT: Record<string, string> = {
    '↑': 'up', '↓': 'down', '←': 'left', '→': 'right',
};

const DIRS = [
    { dx:  0, dy:  1, rel: 'up'    },
    { dx:  0, dy: -1, rel: 'down'  },
    { dx:  1, dy:  0, rel: 'right' },
    { dx: -1, dy:  0, rel: 'left'  },
] as const;

function tileId(x: number, y: number): string {
    return `t${x}_${y}`;
}

/**
 * Build and solve a PDDL navigation problem.
 * Returns an ordered list of move directions (e.g. ['right', 'up', 'up'])
 * or null if no path exists / the solver fails.
 */
export async function getPddlPath(
    start: Position,
    target: Position,
    worldMap: World,
    extraBlocked: Set<string> = new Set(),
): Promise<string[] | null> {

    if (!start || !target) return null;
    if (start.x === target.x && start.y === target.y) return [];
    if (pddlLock) return null;   // another run in progress – caller falls back to BFS
    pddlLock = true;

    try {

    const { tiles, crates } = worldMap;

    // Crate positions are NOT treated as hard-blocked: the agent can push them.
    // Only externally-supplied blocked cells (e.g. stationary opponents) are hard-blocked.
    const blocked    = new Set<string>(extraBlocked);
    const crateSet   = new Map<string, Crate>([...crates.values()].map((c: Crate) => [`${c.pos.x},${c.pos.y}`, c]));

    // Sanitise a crate id into a valid PDDL identifier
    const crateObjId = (c: Crate) => `crate_${c.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // ── Build problem PDDL ────────────────────────────────────────────────────
    const tileKeys      = Array.from(tiles.keys());
    const tileObjects: string[]  = [];
    const crateObjects: string[] = [];
    const initFacts: string[]    = [`(at me ${tileId(start.x, start.y)})`];

    // Tile objects (exclude walls and hard-blocked cells; crate tiles ARE included)
    for (const key of tileKeys) {
        if (tiles.get(key) === '0' || blocked.has(key)) continue;
        const [x, y] = key.split(',').map(Number);
        tileObjects.push(tileId(x, y));
    }

    // Adjacency, clear, type5 facts
    for (const key of tileKeys) {
        const type = tiles.get(key)!;
        if (type === '0' || blocked.has(key)) continue;
        const [x, y]     = key.split(',').map(Number);
        const id          = tileId(x, y);
        const allowedExit = ONE_WAY_EXIT[type];

        // (clear t) — true when no crate occupies the tile
        if (!crateSet.has(key)) initFacts.push(`(clear ${id})`);

        // (type5 t) — tile accepts pushed crates
        if (type === '5') initFacts.push(`(type5 ${id})`);

        for (const { dx, dy, rel } of DIRS) {
            if (allowedExit && allowedExit !== rel) continue;
            const nKey = `${x + dx},${y + dy}`;
            if (!tiles.has(nKey) || tiles.get(nKey) === '0' || blocked.has(nKey)) continue;
            initFacts.push(`(${rel} ${id} ${tileId(x + dx, y + dy)})`);
        }
    }

    // Crate objects and at-crate facts
    for (const c of crates.values()) {
        const key = `${c.pos.x},${c.pos.y}`;
        if (blocked.has(key)) continue;           // crate on a hard-blocked tile — ignore
        const obj = crateObjId(c);
        crateObjects.push(obj);
        initFacts.push(`(at-crate ${obj} ${tileId(c.pos.x, c.pos.y)})`);
    }

    const objectsSection = [
        `    me - agent`,
        ...(crateObjects.length ? [`    ${crateObjects.join(' ')} - crate`] : []),
        `    ${tileObjects.join(' ')} - tile`,
    ].join('\n');

    const problemPddl = [
        `(define (problem deliveroo-nav)`,
        `  (:domain deliveroo)`,
        `  (:objects`,
        objectsSection,
        `  )`,
        `  (:init`,
        `    ${initFacts.join('\n    ')}`,
        `  )`,
        `  (:goal (and (at me ${tileId(target.x, target.y)})))`,
        `)`,
    ].join('\n');

    writeFileSync(PROBLEM_FILE, problemPddl, 'utf8');
    if (existsSync(PLAN_FILE)) { try { unlinkSync(PLAN_FILE); } catch {} }

    // ── Run Fast Downward ─────────────────────────────────────────────────────
    // --plan-file is a driver option and MUST come before the domain/problem files.
    // Use relative paths only: python3 on Windows may be WSL Python, which
    // cannot parse absolute Windows paths (D:\...).
    //const cmd = `${PYTHON_CMD} "${DOWNWARD_REL}" --plan-file "${PLAN_REL}" --alias lama-first "${DOMAIN_REL}" "${PROBLEM_REL}"`;
    const cmd = `${PYTHON_CMD} "${DOWNWARD_REL}" --plan-file "${PLAN_REL}" "${DOMAIN_REL}" "${PROBLEM_REL}" --search "astar(lmcut())"`;

    await new Promise<void>(resolve => {
        exec(cmd, { timeout: 15_000, cwd: PDDL_DIR }, (err, _stdout, stderr) => {
            // Fast Downward exits 0 = plan found, 11 = unsolvable, 12 = OOM, others = crash.
            // We check the plan file instead of the exit code to handle all cases uniformly.
            if (err && !existsSync(PLAN_FILE)) {
                const detail = stderr?.trim().split('\n').slice(-5).join(' | ') ?? err.message;
                console.warn('[PDDL] Solver error:', detail);
            }
            resolve();
        });
    });

    if (!existsSync(PLAN_FILE)) return null;

    // ── Parse plan ────────────────────────────────────────────────────────────
    // Each line: "(move_right me t2_3 t3_3)", "(push_right me crate_x t1 t2 t3)", or "; cost = N"
    const path: string[] = [];
    for (const line of readFileSync(PLAN_FILE, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t.startsWith('(')) continue;
        const actionName = t.slice(1).split(/\s+/)[0].toLowerCase();
        // Both move_<dir> and push_<dir> encode the direction after the last '_'
        const dir = actionName.replace(/^(move|push)_/, '');
        path.push(dir);
    }

    return path.length > 0 ? path : null;

    } finally {
        pddlLock = false;
    }
}
