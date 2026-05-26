// Safe subset of Math functions exposed to the expression evaluator.
// All identifiers in the expression are validated against this map before eval.
const SAFE_MATH: Record<string, (...args: number[]) => number> = {
    abs:   Math.abs,   sqrt:  Math.sqrt,  cbrt:  Math.cbrt,
    sin:   Math.sin,   cos:   Math.cos,   tan:   Math.tan,
    asin:  Math.asin,  acos:  Math.acos,  atan:  Math.atan,
    log:   Math.log,   log10: Math.log10, exp:   Math.exp,
    round: Math.round, floor: Math.floor, ceil:  Math.ceil,
    min:   Math.min,   max:   Math.max,   pow:   Math.pow,
};

let cityTimezonesModule: any | null = null;

async function getCityTimezones() {
    if (!cityTimezonesModule) {
        const cityTz = await import("city-timezones");
        cityTimezonesModule = (cityTz as any).default ?? cityTz;
    }
    return cityTimezonesModule;
}

export function calculate(expression: string): string {
    try {
        const input = expression.trim();

        if (!input) {
            return "Error: expression is required.";
        }

        // Avoid very large expressions that could be used for resource exhaustion.
        if (input.length > 200) {
            return "Error: expression is too long.";
        }

        // Allow only characters needed for basic mathematical expressions.
        const allowedCharacters = /^[0-9+\-*/%^().,\sA-Za-z]+$/;

        if (!allowedCharacters.test(input)) {
            return "Error: expression contains unsupported characters.";
        }

        // Block syntax that is not needed in a calculator.
        const blockedSyntax =
            /(?:=|;|\[|\]|\{|\}|\\|`|'|"|:|function|constructor|prototype|globalThis|process|require|window|document|this)/i;

        if (blockedSyntax.test(input)) {
            return "Error: expression contains unsupported syntax.";
        }

        // Allow only a small set of mathematical functions and constants.
        const allowedFunctions = new Set(Object.keys(SAFE_MATH));
        const allowedConstants = new Set(["pi", "e"]);

        const identifiers = input.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];

        for (const identifier of identifiers) {
            const name = identifier.toLowerCase();

            if (!allowedFunctions.has(name) && !allowedConstants.has(name)) {
                return `Error: unsupported identifier "${identifier}".`;
            }
        }

        // Substitute identifiers and ^ before passing to Function().
        // All identifiers have already been validated — no user input reaches eval directly.
        const expr = input
            .replace(/\^/g, "**")
            .replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m) => {
                const name = m.toLowerCase();
                if (allowedFunctions.has(name)) return `__m.${name}`;
                if (name === "pi") return String(Math.PI);
                if (name === "e")  return String(Math.E);
                return m;
            });

        // eslint-disable-next-line no-new-func
        const result = new Function("__m", `"use strict"; return (${expr});`)(SAFE_MATH);

        if (typeof result !== "number") {
            return "Error: expression did not return a number.";
        }

        if (!Number.isFinite(result)) {
            return "Error: result is not finite.";
        }

        return String(result);
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

export async function getCurrentTime(location: string): Promise<string> {
    try {
        const cityTimezones = await getCityTimezones();
        const normalized = location.trim();

        if (!normalized) {
            return "Error: location is required.";
        }

        const matches = cityTimezones.lookupViaCity(normalized);

        if (!matches || matches.length === 0) {
            return `Error: location "${location}" was not found.`;
        }

        // Prefer the city with the largest population to handle ambiguous names
        // (e.g. "London" should resolve to London, UK, not London, Ontario).
        const bestMatch = matches.reduce((best: any, cur: any) =>
            (cur.pop ?? 0) > (best.pop ?? 0) ? cur : best
        );

        const timeZone = bestMatch.timezone;
        const city = bestMatch.city;

        const now = new Date();

        const formatter = new Intl.DateTimeFormat("en-GB", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });

        const parts = formatter.formatToParts(now);

        const dateParts: Record<string, string> = {};

        for (const part of parts) {
            if (part.type !== "literal") {
                dateParts[part.type] = part.value;
            }
        }

        const formattedDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
        const formattedTime = `${dateParts.hour}:${dateParts.minute}:${dateParts.second}`;

        return `The current local time in ${city} is ${formattedDate} ${formattedTime} (${timeZone}).`;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
}

export async function getMyPosition(me: any): Promise<string> {

    if (me.x === null || me.y === null) {
        return "Error: agent position is not available.";
    }

    return "My position is (" + me.x + ", " + me.y + ")";
}