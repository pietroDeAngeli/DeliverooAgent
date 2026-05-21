import { OpenAI } from "openai";
import dotenv from "dotenv";
import * as prompts from "./prompts.ts";
import * as tools from "./llm_tools.ts";

dotenv.config();

const baseURL = process.env.LITELLM_BASE_URL;
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL;

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

    private messages = [
        {
            role: "system",
            content: "You are a concise assistant.",
        },
    ];

    // ---- Calls ----

    private async callModel(messages: any, { temperature = 0 } = {}) {
        if (!MODEL) {
            throw new Error("LOCAL_MODEL not set in .env");
        }
        
        const response = await this.client.chat.completions.create({
            model: MODEL,
            messages,
            temperature,
        });

        return response.choices?.[0]?.message?.content ?? "";
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
    private async answerGeneralQuestion(question: string): Promise<string> {
        try {
            const messages = [
                {
                    role: "system",
                    content: prompts.GENERAL_QUESTION_PROMPT,
                },
                {
                    role: "user",
                    content: question,
                },
            ];
            return await this.callModel(messages, { temperature: 0.1 });
        } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    // ---- Memory management ----

    private clearMemory() {
        this.messages.length = 1;
    }

    // ---- Orchestrator ----
    private async decideNextAction(userInput: string) {
        this.messages = this.messages.concat({
            role: "system",
            content: prompts.ORCHESTRATOR_PROMPT,
        });
        this.messages = this.messages.concat({
            role: "user",
            content: userInput,
        });
        const response = await this.callModel(this.messages);

        return response ? this.extractAction(response) : "Error: no valid response from model.";
    }

    // ---- Main listener ----

    async processMessage(msg: any, agent_position: any) {
        // clear memory at the beginning of each message processing
        this.clearMemory();
        const FALLBACK = "DO NOT REPLY";

        // Empty message, return fallback
        if (msg.trim() === "") {
            return FALLBACK;
        }

        let action = await this.decideNextAction(msg);
        if (action.startsWith("Error")) {
            return action;
        }

        if (action != "generate_belief") {

            let actionResult: any;

            if (action === "calculate" || action === "get_my_position") {
                switch (action) {
                    case "calculate":
                        actionResult = await tools.calculate(msg);
                        break;
                    case "get_my_position":
                        actionResult = await tools.getMyPosition(agent_position);
                        break;
                }
            } else if (action === "get_current_time") {
                // extract city name from user input
                const cityMessages = [
                    {
                        role: "system",
                        content: prompts.GET_CITY_PROMPT,
                    },
                    {
                        role: "user",
                        content: msg,
                    },
                ];
                const city = await this.callModel(cityMessages);
                if (city.startsWith("Error: City not found")) {
                    return city;
                }
            }else if (action === "common_knowledge") {
                return await this.answerGeneralQuestion(msg);
            }else if (action === "generate_belief") {
                // create new belief
            }
        }   

        // answer was a belif, return fallback
        return FALLBACK;
    }   

}
