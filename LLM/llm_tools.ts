import cityTimezones from "city-timezones";

import { create, all } from "mathjs";

const math = create(all, {});

// Disable high-risk mathjs functions that are not needed for a simple calculator.
// Note: evaluate/parse are intentionally kept enabled — security is enforced via
// the character whitelist, identifier whitelist, and blocked-syntax checks below.
math.import(
    {
        import: () => {
            throw new Error("Function import is disabled");
        },
        createUnit: () => {
            throw new Error("Function createUnit is disabled");
        },
        simplify: () => {
            throw new Error("Function simplify is disabled");
        },
        derivative: () => {
            throw new Error("Function derivative is disabled");
        },
        resolve: () => {
            throw new Error("Function resolve is disabled");
        },
    },
    { override: true }
);

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
        const allowedFunctions = new Set([
            "abs",
            "sqrt",
            "cbrt",
            "sin",
            "cos",
            "tan",
            "asin",
            "acos",
            "atan",
            "log",
            "log10",
            "exp",
            "round",
            "floor",
            "ceil",
            "min",
            "max",
            "pow",
        ]);

        const allowedConstants = new Set(["pi", "e"]);

        const identifiers = input.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];

        for (const identifier of identifiers) {
            const name = identifier.toLowerCase();

            if (!allowedFunctions.has(name) && !allowedConstants.has(name)) {
                return `Error: unsupported identifier "${identifier}".`;
            }
        }

        const result = math.evaluate(input);

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
        const bestMatch = matches.reduce((best, cur) =>
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