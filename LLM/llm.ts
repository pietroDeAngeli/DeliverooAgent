import { OpenAI } from "openai";
import dotenv from "dotenv";
import * as prompts from "./prompts.ts";
import * as tools from "./llm_tools.ts";

dotenv.config();

const baseURL = process.env.LITELLM_BASE_URL;
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL;

export type LLMUpdate = {
    goToTiles: Array<{ x: number; y: number; utility: number }>;
    blockedTiles: string[]; // "x,y" format
    deliveryConstraints: Array<{ direction: string; points: number }>;
};

export class LLMClient {
    private client: OpenAI;

    constructor() {
        if (!apiKey) {
            console.error("Error: missing LITELLM_API_KEY in .env file");
            process.exit(1);
        }

        this.client = new OpenAI({
            apiKey,
            baseURL,
        });
    }

    /** Async factory: returns a ready-to-use client. */
    static async create(): Promise<LLMClient> {
        return new LLMClient();
    }

    private messages = [
        {
            role: "system",
            content: "You are a concise assistant.",
        },
    ];

    // ---- Calls ----

    private stripMarkdown(text: string): string {
        return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    }

    private async callModel(messages: any, { temperature = 0, timeoutMs = 20_000 } = {}) {
        if (!MODEL) {
            throw new Error("LOCAL_MODEL not set in .env");
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await this.client.chat.completions.create(
                { model: MODEL, messages, temperature },
                { signal: controller.signal },
            );
            return response.choices?.[0]?.message?.content ?? "";
        } finally {
            clearTimeout(timer);
        }
    }

    // ---- Output parsing ----

    private async extractAction(text: string) {
        text = text.trim();
        text = text.toLowerCase();

        if (prompts.ACTIONS.includes(text)) {
            return text;
        }else {
            return "Error, no valid action found.";
        }
    }

    // ---- Tools ----
    private async splitMessage(user_input: string): Promise<Array<string>> {
        const messages = [
            { role: "system", content: prompts.SPLITTER_PROMPT },
            { role: "user", content: user_input },
        ];
        const response = await this.callModel(messages);
        try {
            return JSON.parse(this.stripMarkdown(response));
        } catch (error) {
            return [user_input]; // fallback: treat as single message
        }
    }

    private async answerGeneralQuestion(question: string, context = ""): Promise<string> {
        try {
            const userContent = context
                ? `Previous answers for context:\n${context}\n\nNew question: ${question}`
                : question;
            const messages = [
                { role: "system", content: prompts.GENERAL_QUESTION_PROMPT },
                { role: "user", content: userContent },
            ];
            return await this.callModel(messages, { temperature: 0.1 });
        } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private async extractCityName(text: string): Promise<string> {
        const messages = [
            { role: "system", content: prompts.GET_CITY_PROMPT },
            { role: "user", content: text },
        ];
        return await this.callModel(messages);
    }

    private async extractMathExpression(text: string): Promise<string> {
        const messages = [
            { role: "system", content: prompts.GET_EXPRESSION_PROMPT },
            { role: "user", content: text },
        ];
        return await this.callModel(messages);
    }

    private async planTasks(msg: string): Promise<{calculations: any[], cleanMessage: string}> {
        const messages = [
            { role: "system", content: prompts.TASK_PLANNER_PROMPT },
            { role: "user", content: msg },
        ];
        const response = await this.callModel(messages);
        const stripped = this.stripMarkdown(response);
        if (!stripped.startsWith("{") && !stripped.startsWith("[")) {
            return { calculations: [], cleanMessage: msg };
        }
        try {
            return JSON.parse(stripped);
        } catch {
            console.warn("[LLM] planTasks: non-JSON response, using fallback");
            return { calculations: [], cleanMessage: msg };
        }
    }

    private async extractDeliveryConstraint(text: string): Promise<{ direction: string; points: number } | null> {
        const messages = [
            { role: "system", content: prompts.DELIVERY_CONSTRAINT_PROMPT },
            { role: "user", content: text },
        ];
        const response = await this.callModel(messages);
        try {
            return JSON.parse(this.stripMarkdown(response));
        } catch (error) {
            console.warn("[LLM] extractDeliveryConstraint: non-JSON response, skipping");
            return null;
        }
    }

    private async generateDesire(text: string): Promise<{ action: string; x: number; y: number; points: number } | null> {
        const messages = [
            { role: "system", content: prompts.DESIRE_GENERATION_PROMPT },
            { role: "user", content: text },
        ];
        const response = await this.callModel(messages);
        try {
            return JSON.parse(this.stripMarkdown(response));
        } catch (error) {
            console.warn("[LLM] generateDesire: non-JSON response, skipping");
            return null;
        }
    }

    // ---- Memory management ----

    private clearMemory() {
        this.messages.length = 1;
    }

    // ---- Orchestrator ----

    private async decideNextAction(userInput: string) {
        const messages = [
            { role: "system", content: prompts.ORCHESTRATOR_PROMPT },
            { role: "user", content: userInput },
        ];
        const response = await this.callModel(messages);
        return response ? this.extractAction(response) : "Error: no valid response from model.";
    }

    // ---- Main listener ----

    async processMessage(msg: string, agent_position: any): Promise<{ reply: string; updates: LLMUpdate }> {
        const EMPTY: { reply: string; updates: LLMUpdate } = { reply: "", updates: { goToTiles: [], blockedTiles: [], deliveryConstraints: [] } };

        if (msg.trim() === "") {
            return EMPTY;
        }

        // Step 1: Plan and resolve nested math expressions
        const plan = await this.planTasks(msg);
        const calcResults: Record<string, string> = {};
        for (const calc of plan.calculations) {
            calcResults[calc.placeholder] = await tools.calculate(calc.expr);
        }
        let cleanMsg = plan.cleanMessage;
        for (const [placeholder, result] of Object.entries(calcResults)) {
            cleanMsg = cleanMsg.replace(placeholder, result);
        }

        // Step 2: Split into sub-requests and dispatch each one
        const msgs: Array<string> = await this.splitMessage(cleanMsg);
        let replyText = "";
        const updates: LLMUpdate = { goToTiles: [], blockedTiles: [], deliveryConstraints: [] };

        for (const subMsg of msgs) {
            const action = await this.decideNextAction(subMsg);
            if (action.startsWith("Error")) {
                return { reply: action, updates };
            }

            if (action === "calculate") {
                const expr = await this.extractMathExpression(subMsg);
                replyText += await tools.calculate(expr) + " ";
            } else if (action === "get_my_position") {
                replyText += await tools.getMyPosition(agent_position) + " ";
            } else if (action === "get_current_time") {
                const city = await this.extractCityName(subMsg);
                replyText += await tools.getCurrentTime(city) + " ";
            } else if (action === "common_knowledge") {
                replyText += await this.answerGeneralQuestion(subMsg, replyText.trim()) + " ";
            } else if (action === "generate_desire") {
                const desire = await this.generateDesire(subMsg);
                if (desire) {
                    if (desire.action === "avoid" || desire.points < 0) {
                        updates.blockedTiles.push(`${desire.x},${desire.y}`);
                    } else {
                        updates.goToTiles.push({ x: desire.x, y: desire.y, utility: desire.points });
                    }
                }
            } else if (action === "generate_delivery_constraint") {
                const constraint = await this.extractDeliveryConstraint(subMsg);
                if (constraint) {
                    updates.deliveryConstraints.push(constraint);
                }
            }
        }
        return { reply: replyText.trim(), updates };
    }

}
