import OpenAI from "openai";
import type { CodingAgent, CodingRun } from "../types.js";
import { renderCodebookForPrompt } from "../coding/codebook.js";
import { tools, parseCodingCall } from "./tools.js";

export type Provider = "openai" | "openrouter";

function systemPrompt(): string {
  return [
    "You are a careful medical-coding assistant. You assign ICD-10 diagnosis",
    "codes for a short clinical narrative. Follow these rules strictly:",
    "",
    "- Assign ONLY ICD-10 codes from the codebook below. Do not invent codes.",
    "- Code the principal diagnosis AND every documented comorbidity.",
    "- Do NOT assign a more severe variant than the narrative supports (no",
    "  upcoding). When in doubt, choose the less severe / unspecified code.",
    "- NEVER repeat the patient's name, MRN, or date of birth in your rationale;",
    '  always refer to "the patient".',
    "- If the case is under-specified, say so explicitly in the rationale rather",
    "  than guessing.",
    "- You MUST call the assign_codes tool with your answer.",
    "",
    "Codebook (the ONLY codes you may assign):",
    renderCodebookForPrompt(),
  ].join("\n");
}

/**
 * Build a CodingAgent backed by an OpenAI-compatible chat-completions API.
 * Provider "openai" uses the default OpenAI base URL and OPENAI_API_KEY;
 * "openrouter" uses the OpenRouter base URL and OPENROUTER_API_KEY. Explicit
 * opts.apiKey / opts.baseURL override the defaults.
 */
export function createLLMAgent(opts: {
  model: string;
  provider?: Provider;
  apiKey?: string;
  baseURL?: string;
}): CodingAgent {
  const provider: Provider = opts.provider ?? "openai";

  const apiKey =
    opts.apiKey ??
    (provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY
      : process.env.OPENAI_API_KEY);

  const baseURL =
    opts.baseURL ??
    (provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined);

  const client = new OpenAI({ apiKey, baseURL });

  async function run({ narrative }: { narrative: string }): Promise<CodingRun> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: narrative },
    ];

    const completion = await client.chat.completions.create({
      model: opts.model,
      messages,
      tools,
      tool_choice: "required",
    });

    const choice = completion.choices[0];
    const message = choice?.message;
    const toolCalls = message?.tool_calls ?? [];

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      const parsed = parseCodingCall(call.function.name, call.function.arguments);
      if (parsed) return parsed;
    }

    return { codes: [], rationale: message?.content ?? "" };
  }

  return { name: `llm:${opts.model}`, run };
}
