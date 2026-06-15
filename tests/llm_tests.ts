/**
 * LLM Test Runner
 *
 * Runs structured test cases from JSON files against LLMClient private methods
 * and the tool functions. Outputs per-category and overall accuracy metrics.
 *
 * Usage:
 *   node --experimental-strip-types tests/llm_tests.ts
 *
 * Set LLM_SKIP_LIVE=true to skip tests that require a live LLM API call.
 */

import { LLMClient } from "../LLM/llm.ts";
import * as tools from "../LLM/llm_tools.ts";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TestDetail {
    id: number;
    description: string;
    passed: boolean;
    latencyMs: number;
    actual: string;
    error?: string;
}

interface CategoryResult {
    category: string;
    total: number;
    passed: number;
    failed: number;
    errors: number;
    accuracy: number;
    avgLatencyMs: number;
    details: TestDetail[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
const SKIP_LIVE = process.argv.includes("--skip-live");

function loadJson<T>(filename: string): T {
    return JSON.parse(readFileSync(join(dataDir, filename), "utf-8")) as T;
}

function elapsed(start: number): number {
    return Date.now() - start;
}

/** Check result against a match rule. Returns true if the test passes. */
function checkMatch(
    actual: string,
    test: Record<string, any>
): boolean {
    const match: string = test.match ?? "exact";
    switch (match) {
        case "exact":
            return actual === test.expected;
        case "starts_with":
            return actual.startsWith(test.expected_starts_with ?? "");
        case "contains":
            if (typeof test.expected_contains === "string") {
                return actual.includes(test.expected_contains);
            }
            if (Array.isArray(test.expected_contains)) {
                return (test.expected_contains as string[]).every((s) => actual.includes(s));
            }
            return false;
        case "not_error":
            return (
                !actual.startsWith("Error") &&
                (test.expected_contains ? actual.includes(test.expected_contains as string) : true)
            );
        case "regex":
            return new RegExp(test.expected_regex as string).test(actual);
        case "case_insensitive":
            return actual.toLowerCase() === (test.expected as string).toLowerCase();
        default:
            return actual === test.expected;
    }
}

function buildResult(
    category: string,
    details: TestDetail[],
    totalLatency: number
): CategoryResult {
    const passed = details.filter((d) => d.passed).length;
    const errors = details.filter((d) => d.error !== undefined).length;
    const total = details.length;
    return {
        category,
        total,
        passed,
        failed: total - passed,
        errors,
        accuracy: total === 0 ? 0 : (passed / total) * 100,
        avgLatencyMs: total === 0 ? 0 : Math.round(totalLatency / total),
        details,
    };
}

// ─── Client wrapper ───────────────────────────────────────────────────────────

/**
 * Thin wrapper around LLMClient that exposes private methods for testing.
 * TypeScript `private` is compile-time only; the cast to `any` bypasses it at runtime.
 */
function makeTestable(client: LLMClient) {
    const c = client as any;
    return {
        splitMessage: (msg: string): Promise<string[]> => c.splitMessage(msg),
        extractAction: (text: string): Promise<string> => c.extractAction(text),
        extractCityName: (text: string): Promise<string> => c.extractCityName(text),
        extractMathExpression: (text: string): Promise<string> => c.extractMathExpression(text),
        planTasks: (msg: string): Promise<{ calculations: any[]; cleanMessage: string }> => c.mathExtractor(msg),
        extractDeliveryConstraint: (text: string): Promise<{ direction: string; points: number } | null> =>
            c.extractDeliveryConstraint(text),
        generateDesire: (text: string): Promise<{ action: string; x: number; y: number; points: number; multiplier: number } | null> =>
            c.generateDesire(text),
        extractStackConstraint: (text: string): Promise<{ count: number; operator: string; multiplier: number } | null> =>
            c.extractStackConstraint(text),
        decideNextAction: (userInput: string): Promise<string> => c.decideNextAction(userInput),
    };
}

type TestableClient = ReturnType<typeof makeTestable>;

// ─── Test suites ──────────────────────────────────────────────────────────────

/** 1 – extractAction (deterministic, no LLM call) */
async function runActionExtractionTests(client: TestableClient): Promise<CategoryResult> {
    const tests: any[] = loadJson("action_extraction_tests.json");
    const details: TestDetail[] = [];
    let totalLatency = 0;

    for (const t of tests) {
        const start = Date.now();
        let actual = "";
        let error: string | undefined;
        try {
            actual = await client.extractAction(t.input as string);
        } catch (e) {
            error = String(e);
            actual = "";
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const passed = error === undefined && actual === t.expected;
        const detail: TestDetail = { id: t.id, description: t.description, passed, latencyMs, actual, error };
        details.push(detail);
        printTestLine(detail, String(t.input), String(t.expected));
    }
    return buildResult("extractAction", details, totalLatency);
}

/** 2 – splitMessage (LLM) */
async function runSplitterTests(client: TestableClient): Promise<CategoryResult> {
    const tests: any[] = loadJson("splitter_tests.json");
    const details: TestDetail[] = [];
    let totalLatency = 0;

    for (const t of tests) {
        const start = Date.now();
        let actual = "";
        let passed = false;
        let error: string | undefined;
        try {
            const result: string[] = await client.splitMessage(t.input as string);
            actual = JSON.stringify(result);
            const count = result.length;
            let countOk = true;
            if (t.expected_count !== undefined) countOk = count === t.expected_count;
            else if (t.min_count !== undefined) countOk = count >= t.min_count;

            const keywords: string[] = t.keywords_in_any ?? [];
            const allKeywordsFound = keywords.every((kw: string) =>
                result.some((item) => item.toLowerCase().includes(kw.toLowerCase()))
            );
            // keywords_in_each: every sub-message must contain every listed keyword
            const eachKeywords: string[] = t.keywords_in_each ?? [];
            const eachOk = eachKeywords.length === 0 || result.every((item) =>
                eachKeywords.every((kw: string) => item.toLowerCase().includes(kw.toLowerCase()))
            );
            passed = countOk && allKeywordsFound && eachOk;
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const expectedPreview = t.expected_count !== undefined ? `count=${t.expected_count}` : `min_count=${t.min_count ?? "?"}`;
        const detail: TestDetail = { id: t.id, description: t.description, passed, latencyMs, actual, error };
        details.push(detail);
        printTestLine(detail, String(t.input), expectedPreview);
    }
    return buildResult("splitMessage", details, totalLatency);
}

/** 3 – extractCityName (LLM) */
async function runCityNameTests(client: TestableClient): Promise<CategoryResult> {
    const tests: any[] = loadJson("city_name_tests.json");
    const details: TestDetail[] = [];
    let totalLatency = 0;

    for (const t of tests) {
        const start = Date.now();
        let actual = "";
        let passed = false;
        let error: string | undefined;
        try {
            actual = await client.extractCityName(t.input as string);
            const norm = actual.trim().toLowerCase();
            const expected: string = (t.expected_city as string).toLowerCase();
            passed = norm === expected || norm.includes(expected);
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const detail: TestDetail = { id: t.id, description: t.description, passed, latencyMs, actual, error };
        details.push(detail);
        printTestLine(detail, String(t.input), String(t.expected_city));
    }
    return buildResult("extractCityName", details, totalLatency);
}

/** 4 – extractMathExpression (LLM) */
async function runMathExpressionTests(client: TestableClient): Promise<CategoryResult> {
    const tests: any[] = loadJson("math_expression_tests.json");
    const details: TestDetail[] = [];
    let totalLatency = 0;

    for (const t of tests) {
        const start = Date.now();
        let actual = "";
        let passed = false;
        let error: string | undefined;
        try {
            actual = await client.extractMathExpression(t.input as string);
            // Normalize: strip spaces, lowercase for comparison
            const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
            passed = norm(actual) === norm(t.expected_expression as string);
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const detail: TestDetail = { id: t.id, description: t.description, passed, latencyMs, actual, error };
        details.push(detail);
        printTestLine(detail, String(t.input), String(t.expected_expression));
    }
    return buildResult("extractMathExpression", details, totalLatency);
}

/** 5 – planTasks (LLM) */
async function runPlanTasksTests(client: TestableClient): Promise<CategoryResult> {
    const tests: any[] = loadJson("plan_tasks_tests.json");
    const details: TestDetail[] = [];
    let totalLatency = 0;

    for (const t of tests) {
        const start = Date.now();
        let actual = "";
        let passed = false;
        let error: string | undefined;
        try {
            const result = await client.planTasks(t.input as string);
            actual = JSON.stringify(result);

            // Check calc count
            let countOk = true;
            if (t.expected_calc_count !== undefined) {
                countOk = result.calculations.length === t.expected_calc_count;
            }

            // Check that expected expressions appear in the calculations array
            let exprsOk = true;
            if (t.expected_expressions_contain) {
                exprsOk = (t.expected_expressions_contain as string[]).every((expr: string) =>
                    result.calculations.some((c: any) =>
                        (c.expr as string).replace(/\s+/g, "") === expr.replace(/\s+/g, "")
                    )
                );
            }

            // Check clean message has no original expression when expected_calc_count > 0
            let cleanOk = true;
            if (t.clean_message_no_original_expr) {
                cleanOk = !result.cleanMessage.includes(t.clean_message_no_original_expr as string);
            }

            // Check that placeholders X1, X2 etc appear in clean message when there are calculations
            let placeholderOk = true;
            if (t.clean_message_contains_placeholder && result.calculations.length > 0) {
                placeholderOk = /X\d+/.test(result.cleanMessage);
            }

            passed = countOk && exprsOk && cleanOk && placeholderOk;
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const expectedPreview = `calcs=${t.expected_calc_count ?? "?"}` + (t.expected_expressions_contain ? ` exprs=${JSON.stringify(t.expected_expressions_contain)}` : "");
        const detail: TestDetail = { id: t.id, description: t.description, passed, latencyMs, actual, error };
        details.push(detail);
        printTestLine(detail, String(t.input), expectedPreview);
    }
    return buildResult("planTasks", details, totalLatency);
}

/** 6 – extractDeliveryConstraint (LLM) */
async function runDeliveryConstraintTests(client: TestableClient): Promise<CategoryResult> {
    const tests: any[] = loadJson("delivery_constraint_tests.json");
    const details: TestDetail[] = [];
    let totalLatency = 0;

    for (const t of tests) {
        const start = Date.now();
        let actual = "";
        let passed = false;
        let error: string | undefined;
        try {
            const result = await client.extractDeliveryConstraint(t.input as string);
            actual = JSON.stringify(result);

            if (result === null) {
                passed = false;
            } else {
                const directionOk = result.direction === t.expected_direction;
                let pointsOk = true;
                if (t.expected_points !== undefined) {
                    pointsOk = result.points === t.expected_points;
                } else if (t.expected_points_negative === true) {
                    pointsOk = result.points < 0;
                }
                passed = directionOk && pointsOk;
            }
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const expectedPreview = `direction=${t.expected_direction} points=${t.expected_points ?? (t.expected_points_negative ? "<0" : "?")}`;
        const detail: TestDetail = { id: t.id, description: t.description, passed, latencyMs, actual, error };
        details.push(detail);
        printTestLine(detail, String(t.input), expectedPreview);
    }
    return buildResult("extractDeliveryConstraint", details, totalLatency);
}

/** 7 – decideNextAction (LLM) */
async function runDecideActionTests(client: TestableClient): Promise<CategoryResult> {
    const tests: any[] = loadJson("decide_action_tests.json");
    const details: TestDetail[] = [];
    let totalLatency = 0;

    for (const t of tests) {
        const start = Date.now();
        let actual = "";
        let error: string | undefined;
        try {
            actual = await client.decideNextAction(t.input as string);
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const passed = error === undefined && actual === t.expected_action;
        const detail: TestDetail = { id: t.id, description: t.description, passed, latencyMs, actual, error };
        details.push(detail);
        printTestLine(detail, String(t.input), String(t.expected_action));
    }
    return buildResult("decideNextAction", details, totalLatency);
}

/** 8 – generateDesire (LLM) */
async function runGenerateDesireTests(client: TestableClient): Promise<CategoryResult> {
    const tests: any[] = loadJson("generate_desire_tests.json");
    const details: TestDetail[] = [];
    let totalLatency = 0;

    for (const t of tests) {
        const start = Date.now();
        let actual = "";
        let passed = false;
        let error: string | undefined;
        try {
            const result = await client.generateDesire(t.input as string);
            actual = JSON.stringify(result);

            if (result === null) {
                passed = false;
            } else {
                const actionOk = result.action === t.expected_action;
                const xOk = t.expected_x !== undefined ? result.x === t.expected_x : true;
                const yOk = t.expected_y !== undefined ? result.y === t.expected_y : true;
                const pointsOk =
                    t.expected_points !== undefined ? result.points === t.expected_points
                    : t.expected_points_negative === true ? result.points < 0
                    : true;
                const multiplierOk = t.expected_multiplier !== undefined
                    ? result.multiplier === t.expected_multiplier
                    : true;
                passed = actionOk && xOk && yOk && pointsOk && multiplierOk;
            }
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const expectedPreview =
            `action=${t.expected_action} x=${t.expected_x ?? "?"} y=${t.expected_y ?? "?"}` +
            (t.expected_multiplier !== undefined ? ` mult=${t.expected_multiplier}` : "") +
            (t.expected_points_negative ? " pts<0" : "");
        const detail: TestDetail = { id: t.id, description: t.description, passed, latencyMs, actual, error };
        details.push(detail);
        printTestLine(detail, String(t.input), expectedPreview);
    }
    return buildResult("generateDesire", details, totalLatency);
}

/** 9 – extractStackConstraint (LLM) */
async function runStackConstraintTests(client: TestableClient): Promise<CategoryResult> {
    const tests: any[] = loadJson("stack_constraint_tests.json");
    const details: TestDetail[] = [];
    let totalLatency = 0;

    for (const t of tests) {
        const start = Date.now();
        let actual = "";
        let passed = false;
        let error: string | undefined;
        try {
            const result = await client.extractStackConstraint(t.input as string);
            actual = JSON.stringify(result);

            if (result === null) {
                passed = false;
            } else {
                const countOk = t.expected_count !== undefined ? result.count === t.expected_count : true;
                const operatorOk = t.expected_operator !== undefined ? result.operator === t.expected_operator : true;
                const multiplierOk = t.expected_multiplier !== undefined ? result.multiplier === t.expected_multiplier : true;
                passed = countOk && operatorOk && multiplierOk;
            }
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const expectedPreview = `count=${t.expected_count ?? "?"} op=${t.expected_operator ?? "?"} mult=${t.expected_multiplier ?? "?"}`;
        const detail: TestDetail = { id: t.id, description: t.description, passed, latencyMs, actual, error };
        details.push(detail);
        printTestLine(detail, String(t.input), expectedPreview);
    }
    return buildResult("extractStackConstraint", details, totalLatency);
}

/** 10 – tools (calculate, getCurrentTime, getMyPosition) */
async function runToolsTests(): Promise<CategoryResult> {
    const data: any = loadJson("tools_tests.json");
    const details: TestDetail[] = [];
    let totalLatency = 0;

    // --- calculate ---
    for (const t of data.calculate as any[]) {
        const start = Date.now();
        let actual = "";
        let error: string | undefined;
        try {
            actual = tools.calculate(t.input as string);
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const passed = error === undefined && checkMatch(actual, t);
        const detail: TestDetail = {
            id: t.id,
            description: `[calculate] ${t.description}`,
            passed,
            latencyMs,
            actual,
            error,
        };
        details.push(detail);
        printTestLine(detail, String(t.input), String(t.expected ?? t.expected_starts_with ?? t.expected_contains ?? ""));
    }

    // --- getCurrentTime ---
    for (const t of data.getCurrentTime as any[]) {
        const start = Date.now();
        let actual = "";
        let error: string | undefined;
        try {
            actual = await tools.getCurrentTime(t.input as string);
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const passed = error === undefined && checkMatch(actual, t);
        const detail2: TestDetail = {
            id: t.id + 100,
            description: `[getCurrentTime] ${t.description}`,
            passed,
            latencyMs,
            actual,
            error,
        };
        details.push(detail2);
        printTestLine(detail2, String(t.input), String(t.expected ?? t.expected_starts_with ?? t.expected_contains ?? ""));
    }

    // --- getMyPosition ---
    for (const t of data.getMyPosition as any[]) {
        const start = Date.now();
        let actual = "";
        let error: string | undefined;
        try {
            actual = await tools.getMyPosition(t.input);
        } catch (e) {
            error = String(e);
        }
        const latencyMs = elapsed(start);
        totalLatency += latencyMs;
        const passed = error === undefined && checkMatch(actual, t);
        const detail3: TestDetail = {
            id: t.id + 200,
            description: `[getMyPosition] ${t.description}`,
            passed,
            latencyMs,
            actual,
            error,
        };
        details.push(detail3);
        printTestLine(detail3, JSON.stringify(t.input), String(t.expected ?? ""));
    }

    return buildResult("tools", details, totalLatency);
}

// ─── Reporting ────────────────────────────────────────────────────────────────

const ANSI = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    dim: "\x1b[2m",
};

function color(text: string, c: string): string {
    return `${c}${text}${ANSI.reset}`;
}

function pad(s: string, n: number): string {
    return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

/** Print one test line immediately after it runs. */
function printTestLine(d: TestDetail, inputPreview: string, expectedPreview: string): void {
    const tick = d.passed ? color("✓", ANSI.green) : color("✗", ANSI.red);
    const idStr = color(`#${String(d.id).padStart(2, "0")}`, ANSI.dim);
    const latency = color(`${d.latencyMs}ms`, ANSI.dim);
    const preview = (s: string, max = 60) => s.length > max ? s.slice(0, max) + "…" : s;
    console.log(`  ${tick} ${idStr} ${d.description}`);
    console.log(`       in : ${color(preview(inputPreview), ANSI.dim)}`);
    if (d.error) {
        console.log(`       err: ${color(d.error, ANSI.red)}`);
    } else {
        const gotColor = d.passed ? ANSI.green : ANSI.red;
        console.log(`       got: ${color(preview(d.actual), gotColor)}`);
        if (!d.passed && expectedPreview) {
            console.log(`       exp: ${color(preview(expectedPreview), ANSI.yellow)}`);
        }
    }
    console.log(`       ${latency}`);
}

function printCategoryDetail(result: CategoryResult, verbose: boolean): void {
    if (!verbose) return;
    console.log(`\n${color(result.category, ANSI.bold + ANSI.cyan)} — failed tests:`);
    const failed = result.details.filter((d) => !d.passed);
    if (failed.length === 0) {
        console.log(color("  All tests passed!", ANSI.green));
        return;
    }
    for (const d of failed) {
        const prefix = `  #${String(d.id).padStart(2, "0")} ${d.description}`;
        console.log(color(prefix, ANSI.red));
        if (d.error) {
            console.log(`       threw: ${d.error}`);
        } else {
            const got = d.actual.length > 120 ? d.actual.slice(0, 120) + "…" : d.actual;
            console.log(`       got:   ${got}`);
        }
    }
}

function printSummaryTable(results: CategoryResult[]): void {
    const overallTotal = results.reduce((a, r) => a + r.total, 0);
    const overallPassed = results.reduce((a, r) => a + r.passed, 0);
    const overallFailed = results.reduce((a, r) => a + r.failed, 0);
    const overallAccuracy = overallTotal === 0 ? 0 : (overallPassed / overallTotal) * 100;

    const col1 = 30, col2 = 8, col3 = 8, col4 = 8, col5 = 12, col6 = 14;
    const header =
        pad("Category", col1) +
        pad("Total", col2) +
        pad("Passed", col3) +
        pad("Failed", col4) +
        pad("Accuracy", col5) +
        pad("Avg Latency", col6);
    const sep = "─".repeat(col1 + col2 + col3 + col4 + col5 + col6);

    console.log("\n" + color("═".repeat(sep.length), ANSI.bold));
    console.log(color(" TEST RESULTS SUMMARY", ANSI.bold + ANSI.cyan));
    console.log(color("═".repeat(sep.length), ANSI.bold));
    console.log(color(header, ANSI.bold));
    console.log(sep);

    for (const r of results) {
        const accuracyStr = r.accuracy.toFixed(1) + "%";
        const latencyStr = r.avgLatencyMs + " ms";
        const row =
            pad(r.category, col1) +
            pad(String(r.total), col2) +
            pad(String(r.passed), col3) +
            pad(String(r.failed), col4) +
            pad(accuracyStr, col5) +
            pad(latencyStr, col6);

        const rowColor = r.failed === 0 ? ANSI.green : r.accuracy >= 80 ? ANSI.yellow : ANSI.red;
        console.log(color(row, rowColor));
    }

    console.log(sep);
    const totalRow =
        pad("TOTAL", col1) +
        pad(String(overallTotal), col2) +
        pad(String(overallPassed), col3) +
        pad(String(overallFailed), col4) +
        pad(overallAccuracy.toFixed(1) + "%", col5) +
        pad("─", col6);
    const totalColor = overallFailed === 0 ? ANSI.green : overallAccuracy >= 80 ? ANSI.yellow : ANSI.red;
    console.log(color(totalRow, ANSI.bold + totalColor));
    console.log(color("═".repeat(sep.length), ANSI.bold) + "\n");
}

// ─── Results persistence ─────────────────────────────────────────────────────

const CATEGORY_FILE: Record<string, string> = {
    extractAction: "action_extraction_tests.json",
    splitMessage: "splitter_tests.json",
    extractCityName: "city_name_tests.json",
    extractMathExpression: "math_expression_tests.json",
    planTasks: "plan_tasks_tests.json",
    extractDeliveryConstraint: "delivery_constraint_tests.json",
    generateDesire: "generate_desire_tests.json",
    extractStackConstraint: "stack_constraint_tests.json",
    decideNextAction: "decide_action_tests.json",
};

function buildInputMap(category: string): Map<number, string> {
    const map = new Map<number, string>();
    try {
        if (category === "tools") {
            const data = loadJson<any>("tools_tests.json");
            for (const t of data.calculate ?? []) map.set(t.id, String(t.input));
            for (const t of data.getCurrentTime ?? []) map.set(t.id + 100, String(t.input));
            for (const t of data.getMyPosition ?? []) map.set(t.id + 200, JSON.stringify(t.input));
        } else {
            const filename = CATEGORY_FILE[category];
            if (filename) {
                const tests = loadJson<any[]>(filename);
                for (const t of tests) {
                    map.set(t.id, typeof t.input === "string" ? t.input : JSON.stringify(t.input));
                }
            }
        }
    } catch { /* ignore — input field will be empty */ }
    return map;
}

function saveResults(results: CategoryResult[]): void {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "../results");
    const ablationDir = join(resultsDir, "ablation_results");
    mkdirSync(ablationDir, { recursive: true });

    // ── Summary CSV ───────────────────────────────────────────────────────────
    const overallTotal   = results.reduce((a, r) => a + r.total,  0);
    const overallPassed  = results.reduce((a, r) => a + r.passed, 0);
    const overallFailed  = results.reduce((a, r) => a + r.failed, 0);
    const overallAcc     = overallTotal === 0 ? 0 : (overallPassed / overallTotal) * 100;

    const csvLines = [
        "category,total,passed,failed,accuracy_pct,avg_latency_ms,timestamp",
        ...results.map((r) =>
            [r.category, r.total, r.passed, r.failed,
             r.accuracy.toFixed(1), r.avgLatencyMs, ts].join(",")
        ),
        ["TOTAL", overallTotal, overallPassed, overallFailed,
         overallAcc.toFixed(1), "", ts].join(","),
    ];
    const summaryPath = join(resultsDir, "llm_summary.csv");
    writeFileSync(summaryPath, csvLines.join("\n") + "\n", "utf-8");
    console.log(color(`  Saved summary  → results/llm_summary.csv`, ANSI.dim));

    // ── Per-category ablation JSON ────────────────────────────────────────────
    for (const r of results) {
        const inputMap = buildInputMap(r.category);
        const ablation = {
            category:       r.category,
            timestamp:      ts,
            total:          r.total,
            passed:         r.passed,
            failed:         r.failed,
            accuracy_pct:   parseFloat(r.accuracy.toFixed(1)),
            avg_latency_ms: r.avgLatencyMs,
            tests: r.details.map((d) => ({
                id:          d.id,
                description: d.description,
                input:       inputMap.get(d.id) ?? "",
                passed:      d.passed,
                latency_ms:  d.latencyMs,
                actual:      d.actual,
                ...(d.error ? { error: d.error } : {}),
            })),
        };
        const safe = r.category.replace(/[^a-z0-9]/gi, "_");
        const ablationPath = join(ablationDir, `${safe}.json`);
        writeFileSync(ablationPath, JSON.stringify(ablation, null, 2), "utf-8");
        console.log(color(`  Saved ablation → results/ablation_results/${safe}.json`, ANSI.dim));
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

    console.log(color("\n  LLM Test Runner", ANSI.bold + ANSI.cyan));
    console.log(color(`  skip-live=${SKIP_LIVE}  verbose=${verbose}\n`, ANSI.dim));

    const results: CategoryResult[] = [];

    // Deterministic tests — always run
    console.log(color("[1/10]", ANSI.bold) + " extractAction (deterministic)");
    const clientForAction = makeTestable(new LLMClient());
    results.push(await runActionExtractionTests(clientForAction));

    console.log(color("[2/10]", ANSI.bold) + " tools (calculate / getCurrentTime / getMyPosition)");
    results.push(await runToolsTests());

    // LLM-backed tests — skip if SKIP_LIVE=true
    if (SKIP_LIVE) {
        console.log(color("\n  LLM_SKIP_LIVE=true — skipping live API tests.\n", ANSI.yellow));
    } else {
        const client = makeTestable(new LLMClient());

        console.log(color("[3/10]", ANSI.bold) + " splitMessage");
        results.push(await runSplitterTests(client));

        console.log(color("[4/10]", ANSI.bold) + " extractCityName");
        results.push(await runCityNameTests(client));

        console.log(color("[5/10]", ANSI.bold) + " extractMathExpression");
        results.push(await runMathExpressionTests(client));

        console.log(color("[6/10]", ANSI.bold) + " planTasks");
        results.push(await runPlanTasksTests(client));

        console.log(color("[7/10]", ANSI.bold) + " extractDeliveryConstraint");
        results.push(await runDeliveryConstraintTests(client));

        console.log(color("[8/10]", ANSI.bold) + " generateDesire");
        results.push(await runGenerateDesireTests(client));

        console.log(color("[9/10]", ANSI.bold) + " extractStackConstraint");
        results.push(await runStackConstraintTests(client));

        console.log(color("[10/10]", ANSI.bold) + " decideNextAction");
        results.push(await runDecideActionTests(client));
    }

    // Print verbose failure details
    if (verbose) {
        for (const r of results) {
            printCategoryDetail(r, true);
        }
    }

    // Print summary table
    printSummaryTable(results);

    // Save results to files
    saveResults(results);

    // Exit with non-zero if any test failed
    const anyFailed = results.some((r) => r.failed > 0);
    process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
    console.error(color("Fatal error: " + String(err), ANSI.red));
    process.exit(2);
});
