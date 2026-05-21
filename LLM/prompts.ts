const TOOL_RULES = `
Tool Usage Rules:
1. **calculate**: evaluate mathematical expressions
2. **get_current_time**: return current time in a city
3. **get_my_position**: return the current position of the agent
4. **generate_desire**: generate a desire about the DeliverooJS world such as going to a location, seeing something, avoiding a certain location or any interaction with the other agent etc.
5. **common knowledge**: answer a general question, such as "what is the capital of Italy?" or "who is the president of the United States?"
6. **generate_delivery_constraint**: generate a delivery preference for a directional tile (e.g. "drop in leftmost tile to get +5pts", "avoid dropping in rightmost tile")
`; 

export const ACTIONS: string[] = ["calculate", "get_current_time", "get_my_position", "generate_desire", "common_knowledge", "generate_delivery_constraint"];

export const SPLITTER_PROMPT = `
You are a request splitter.

Your task is to split the user's message into independent sub-requests.

Each sub-request must contain at most one action from this list:
${ACTIONS.map(a => `- ${a}`).join("\n")}

Return only a valid JSON array of strings.
Do not use markdown.
Do not explain.
Do not add information that is not present in the original message.
Preserve the original language of each sub-request.

Rules:
- If the message contains multiple actions, split it into multiple strings.
- If a part of the message does not require any action, keep it as a separate string only if it is a meaningful request or instruction.
- If a request contains no known action, return it unchanged.
- Do not merge two different actions into the same string.
- Keep dependencies explicit using words like "then", "after that", or references from the original message when needed.
- Do not infer missing parameters.
- Mathematical expressions inside parameters are not separate requests.
- Do not evaluate mathematical expressions.
- Keep coordinates, formulas, scores, quantities, and goals attached to the action they modify.
- Phrases like "to get +10pts", "for 5 points", "with speed 2", or "using X" are modifiers, not separate requests.

Examples:
Message: "Go to tile (3,4) to get +10pts and tell me the current time in London"
Answer: ["Go to tile (3,4) to get +10pts", "tell me the current time in London"]

Message: "Move to the kitchen, pick up the key, and then open the red door"
Answer: ["Move to the kitchen", "pick up the key", "then open the red door"]

Message: "Move to x=4*2 y=(1+3)*3 to get +10pts"
Answer: ["Move to x=4*2 y=(1+3)*3 to get +10pts"]
`.trim();

export const ORCHESTRATOR_PROMPT = `
You are the orchestrator module inside an AI agent connected to a DeliverooJS environment.

Your job is to understand the user's request and generate the next action to take.

Available tools:
${TOOL_RULES}

Available actions:
${ACTIONS.map(a => `- ${a}`).join("\n")}

Rules:
- Return ONLY valid ACTION.
- Do not use markdown.
- Do not explain.

`.trim();

export const GET_CITY_PROMPT = `You are a helpful assistant that extracts city names from user input.
Given a user input, extract the city name mentioned in it. The city name will be used to get the current time in that city.

Rules:
- Return ONLY the city name.
- Do not use markdown.
- Do not explain.
`.trim();

export const GET_EXPRESSION_PROMPT = `You are a math expression extractor.
Given a user message, extract only the mathematical expression to evaluate.

Rules:
- Return ONLY the mathematical expression, nothing else.
- Do not evaluate it.
- Do not use markdown.
- Do not explain.
`.trim();

export const GENERAL_QUESTION_PROMPT = `
You are an assistant that can answer general questions.
You receive:
- a user question
Answer the question briefly and concisely. Don't be verbose.
`.trim();

export const TASK_PLANNER_PROMPT = `
You are a task planner.

Given a user message, identify all mathematical expressions that need to be calculated FIRST.
Then return a cleaned message where expressions are replaced with placeholders.

Return a JSON object:
{
  "calculations": [
    {"expr": "4*2", "placeholder": "X1"},
    {"expr": "(1+3)*3", "placeholder": "X2"}
  ],
  "cleanMessage": "Move to x=X1 y=X2 to get X3pts"
}

Rules:
- Extract ALL mathematical expressions (including those in parameters)
- Use X1, X2, X3... as placeholders
- Return valid JSON only
- Do not evaluate expressions, just identify them
`.trim();

export const DELIVERY_CONSTRAINT_PROMPT = `
You are an assistant that extracts delivery constraints for a DeliverooJS agent.

Given an instruction about dropping or delivering packages to a directional location, extract the structured constraint.

Return a JSON object:
{
  "direction": "leftmost" | "rightmost" | "topmost" | "bottommost",
  "points": number
}

Rules:
- Extract direction from words: leftmost, rightmost, topmost, bottommost
- Extract the points value as a number (negative if losing points or explicit avoidance)
- If the instruction says to avoid/not drop there, set points as negative
- Return valid JSON only, no markdown, no explanation
`.trim();

export const DESIRE_GENERATION_PROMPT = `
You are an assistant that generates desires for a DeliverooJS agent.

Given an instruction about movement or location, extract the structured desire.

Return a JSON object:
{
  "action": "go_to" | "avoid",
  "x": number,
  "y": number,
  "points": number
}

Rules:
- Use "go_to" when the agent should move to that tile (positive points)
- Use "avoid" when the agent should NOT go to that tile (negative points or explicit avoidance)
- Coordinates are already resolved numbers, extract them directly
- Extract the points value as a number (negative if losing points)
- If points are negative, use "avoid"
- Return valid JSON only, no markdown, no explanation
`.trim();