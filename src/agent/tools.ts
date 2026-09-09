import type OpenAI from "openai";
import type { CodingRun } from "../types.js";

/**
 * The single function tool the coding agent may call. The description is the
 * contract: assign only codes from the provided codebook, code the principal
 * diagnosis plus documented comorbidities, do not invent codes, and never echo
 * a patient identifier in the rationale.
 */
export const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "assign_codes",
      description:
        "Assign ICD-10 diagnosis codes for this case. Assign ONLY codes that " +
        "appear in the provided codebook — do not invent or guess codes. Code " +
        "the principal (primary) diagnosis plus every documented comorbidity, " +
        "and nothing that the narrative does not support. In the rationale, do " +
        "NOT repeat any patient identifier (name, MRN, or date of birth); refer " +
        'to "the patient".',
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          codes: {
            type: "array",
            items: { type: "string" },
            description:
              "ICD-10 codes assigned for this case, each drawn verbatim from " +
              "the codebook.",
          },
          rationale: {
            type: "string",
            description:
              "Brief justification for the coding. Must not contain the " +
              "patient's name, MRN, or date of birth.",
          },
        },
        required: ["codes", "rationale"],
      },
    },
  },
];

/**
 * Parse a tool call into a CodingRun. Returns null unless `name` is
 * "assign_codes", `argsJson` is valid JSON, `codes` is a string array, and
 * `rationale` is a string.
 */
export function parseCodingCall(name: string, argsJson: string): CodingRun | null {
  if (name !== "assign_codes") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const { codes, rationale } = obj;

  if (!Array.isArray(codes)) return null;
  if (!codes.every((c): c is string => typeof c === "string")) return null;
  if (typeof rationale !== "string") return null;

  return { codes, rationale };
}
