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

    const blocked = new Set<string>([...crates.values()].map((c: Crate) => `${c.pos.x},${c.pos.y}`));
    for (const k of extraBlocked) blocked.add(k);

    // ── Build problem PDDL ────────────────────────────────────────────────────
    const tileKeys     = Array.from(tiles.keys());
    const tileObjects: string[] = [];
    const initFacts: string[]   = [`(at me ${tileId(start.x, start.y)})`];

    for (const key of tileKeys) {
        if (tiles.get(key) === '0' || blocked.has(key)) continue;
        const [x, y] = key.split(',').map(Number);
        tileObjects.push(tileId(x, y));
    }

    for (const key of tileKeys) {
        const type = tiles.get(key)!;
        if (type === '0' || blocked.has(key)) continue;
        const [x, y]     = key.split(',').map(Number);
        const allowedExit = ONE_WAY_EXIT[type];
        for (const { dx, dy, rel } of DIRS) {
            if (allowedExit && allowedExit !== rel) continue;
            const nKey = `${x + dx},${y + dy}`;
            if (!tiles.has(nKey) || tiles.get(nKey) === '0' || blocked.has(nKey)) continue;
            initFacts.push(`(${rel} ${tileId(x, y)} ${tileId(x + dx, y + dy)})`);
        }
    }

    const problemPddl = [
        `(define (problem deliveroo-nav)`,
        `  (:domain deliveroo)`,
        `  (:objects`,
        `    me - agent`,
        `    ${tileObjects.join(' ')} - tile`,
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
    // Each line: "(move_right me t2_3 t3_3)" or "; cost = N"
    const path: string[] = [];
    for (const line of readFileSync(PLAN_FILE, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t.startsWith('(')) continue;
        const actionName = t.slice(1).split(/\s+/)[0].toLowerCase();
        path.push(actionName.replace('move_', ''));
    }

    return path.length > 0 ? path : null;

    } finally {
        pddlLock = false;
    }
}
