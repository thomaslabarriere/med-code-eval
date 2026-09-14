// ============================================================================
// MedCodeEval — the grounded, hierarchical coding AGENT (not a one-shot).
//
// This is the "build", not just "evaluate": a multi-step coder that
//   1. PROPOSES candidate ICD-10 codes from the hierarchy given the note;
//   2. GROUNDS each proposed code in a verbatim span of the note and SEQUENCES
//      the survivors (principal first);
//   3. REJECTS any code whose citation is not found in the note (coding/
//      grounding.ts) — the structural guard against upcoding and hallucination.
//
// It drives a real LLM through the SAME ChatClient seam as the one-shot path
// (agent/runAgent.ts), so tests inject a fake client and run fully offline with
// zero credits; the parent plugs a real model in behind the identical seam.
// ============================================================================

import OpenAI from "openai";
import type { CodingAgent, CodingRun, ICDCode } from "../types.js";
import { renderCodebookForPrompt } from "../coding/codebook.js";
import {
  retainSupported,
  verifyGrounding,
  type GroundedCode,
  type GroundingResult,
} from "../coding/grounding.js";
import type { ChatCompletionsClient, Provider } from "./runAgent.js";

// ---------------------------------------------------------------------------
// Tools. Two steps → two distinct tool schemas.
// ---------------------------------------------------------------------------
const proposeTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "propose_candidates",
    description:
      "Propose the ICD-10 codes that MIGHT apply to this case, drawn ONLY from " +
      "the provided hierarchy. Over-propose slightly; grounding will prune the " +
      "unsupported ones. Do not invent codes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        candidates: {
          type: "array",
          items: { type: "string" },
          description: "Candidate ICD-10 codes, each verbatim from the hierarchy.",
        },
      },
      required: ["candidates"],
    },
  },
};

const assignTool: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "assign_grounded",
    description:
      "Assign the FINAL codes, ordered with the principal diagnosis FIRST, then " +
      "secondaries. For EACH code you MUST cite `span`: a short VERBATIM quote " +
      "copied from the note that documents the condition. Do NOT paraphrase the " +
      "span and do NOT include any patient identifier in it. If the note does " +
      "not document a candidate, leave it out — never invent a citation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        assignments: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string", description: "An ICD-10 code from the hierarchy." },
              span: {
                type: "string",
                description: "Verbatim quote from the note supporting this code.",
              },
            },
            required: ["code", "span"],
          },
          description: "Final grounded assignments, principal first.",
        },
      },
      required: ["assignments"],
    },
  },
};

function proposeSystemPrompt(): string {
  return [
    "You are a careful medical-coding assistant. Given a short clinical note,",
    "propose the ICD-10 diagnosis codes that might apply, using ONLY codes from",
    "the hierarchy below. Prefer the LEAST specific code the documentation",
    "supports; do not reach for a more specific or more severe variant than the",
    "note states. Call propose_candidates with your list.",
    "",
    "ICD-10 hierarchy (indentation = specificity; higher sev / CC / MCC = more",
    "severe; never code deeper than the note documents):",
    renderCodebookForPrompt(),
  ].join("\n");
}

function assignSystemPrompt(candidates: ICDCode[]): string {
  return [
    "Now finalize the coding. Rules (strict):",
    "- Order the codes with the PRINCIPAL diagnosis first, then secondaries.",
    "- For EACH code cite a verbatim span copied from the note that documents it.",
    "- A code with no documentary support in the note MUST be omitted.",
    "- For a MORE SPECIFIC or MORE SEVERE code, the span MUST quote the specific",
    "  finding itself (e.g. cite 'foot ulcer' for E11.621, not just 'type 2",
    "  diabetes'). A generic quote will NOT justify a specific code.",
    "- Never put a patient identifier (name, MRN, DOB) in a span or elsewhere.",
    "- Do not upcode: if only an unspecified condition is documented, code that.",
    "",
    `Candidate codes to consider: ${candidates.join(", ") || "(none)"}.`,
    "Call assign_grounded with the final ordered, grounded assignments.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsers — never coerce garbage into a valid structure (mirror tools.ts).
// ---------------------------------------------------------------------------
export function parseCandidates(name: string, argsJson: string): ICDCode[] | null {
  if (name !== "propose_candidates") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { candidates } = parsed as Record<string, unknown>;
  if (!Array.isArray(candidates)) return null;
  if (!candidates.every((c): c is string => typeof c === "string")) return null;
  return candidates;
}

export function parseAssignments(name: string, argsJson: string): GroundedCode[] | null {
  if (name !== "assign_grounded") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { assignments } = parsed as Record<string, unknown>;
  if (!Array.isArray(assignments)) return null;
  const out: GroundedCode[] = [];
  for (const a of assignments) {
    if (typeof a !== "object" || a === null) return null;
    const { code, span } = a as Record<string, unknown>;
    if (typeof code !== "string" || typeof span !== "string") return null;
    out.push({ code, span });
  }
  return out;
}

/** First matching tool call's raw arguments, or null. */
function firstToolCall(
  message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined,
  toolName: string,
): { arguments: string } | null {
  for (const call of message?.tool_calls ?? []) {
    if (call.type === "function" && call.function.name === toolName) {
      return { arguments: call.function.arguments };
    }
  }
  return null;
}

/** Rich result of a grounded coding run (surfaced for tests / observability). */
export interface GroundedCodingResult {
  run: CodingRun;
  proposed: ICDCode[];
  grounding: GroundingResult[];
  /** Codes dropped because their citation was not found in the note. */
  rejected: ICDCode[];
}

/**
 * A PHI-free rationale summarizing the grounded decision. It names codes and
 * whether each was supported, never quoting the note back (a span could carry
 * an identifier), so the rationale itself cannot become a PHI-leak surface.
 */
function buildRationale(grounding: GroundingResult[]): string {
  if (grounding.length === 0) {
    return "No documented diagnosis could be grounded in the note; declined to code.";
  }
  const kept = grounding.filter((g) => g.supported).map((g) => g.code);
  const dropped = grounding.filter((g) => !g.supported);
  const parts = [
    kept.length > 0
      ? `Coded ${kept.join(", ")}, each supported by a cited passage of the note.`
      : "No code survived grounding.",
  ];
  // Separate the two drop causes so the rationale is honest about WHY: an absent
  // citation (hallucination) vs. a citation that exists but names only the
  // generic parent condition (upcoding-by-generic-span).
  const notInNote = dropped.filter((g) => g.reason !== "span_lacks_specificity").map((g) => g.code);
  const notSpecific = dropped.filter((g) => g.reason === "span_lacks_specificity").map((g) => g.code);
  if (notInNote.length > 0) {
    parts.push(
      `Rejected ${notInNote.join(", ")} — the cited support was not found in the note.`,
    );
  }
  if (notSpecific.length > 0) {
    parts.push(
      `Rejected ${notSpecific.join(", ")} — the citation did not document the specific finding the code requires.`,
    );
  }
  return parts.join(" ");
}

/**
 * Build the grounded coder as a plain function so it can be unit-tested apart
 * from the CodingAgent wrapper. Runs the two LLM steps, verifies grounding,
 * drops unsupported codes, and returns the surviving codes in sequence.
 */
export function makeGroundedRunner(client: ChatCompletionsClient, model: string) {
  return async function run({ narrative }: { narrative: string }): Promise<GroundedCodingResult> {
    // Step 1 — propose candidates.
    const proposal = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: proposeSystemPrompt() },
        { role: "user", content: narrative },
      ],
      tools: [proposeTool],
      tool_choice: "required",
    });
    const proposeCall = firstToolCall(proposal.choices[0]?.message, "propose_candidates");
    const proposed = proposeCall
      ? parseCandidates("propose_candidates", proposeCall.arguments) ?? []
      : [];

    // Step 2 — ground + sequence.
    const assignment = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: proposeSystemPrompt() },
        { role: "user", content: narrative },
        { role: "system", content: assignSystemPrompt(proposed) },
      ],
      tools: [assignTool],
      tool_choice: "required",
    });
    const assignCall = firstToolCall(assignment.choices[0]?.message, "assign_grounded");
    const assignments = assignCall
      ? parseAssignments("assign_grounded", assignCall.arguments) ?? []
      : [];

    // Step 3 — verify grounding against the note; drop unsupported codes.
    const grounding = verifyGrounding(narrative, assignments);
    const codes = retainSupported(grounding);
    const rejected = grounding.filter((g) => !g.supported).map((g) => g.code);

    return {
      run: { codes, rationale: buildRationale(grounding) },
      proposed,
      grounding,
      rejected,
    };
  };
}

/**
 * Build a grounded CodingAgent backed by an OpenAI-compatible chat API. Mirrors
 * createLLMAgent's provider/key handling and client seam so a fake client needs
 * no API key and touches no network.
 */
export function createGroundedCoder(opts: {
  model: string;
  provider?: Provider;
  apiKey?: string;
  baseURL?: string;
  client?: ChatCompletionsClient;
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
  const client: ChatCompletionsClient = opts.client ?? new OpenAI({ apiKey, baseURL });

  const runner = makeGroundedRunner(client, opts.model);
  return {
    name: `grounded:${opts.model}`,
    run: async (input) => (await runner(input)).run,
  };
}
