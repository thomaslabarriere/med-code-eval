import type { CodingAgent, CodingRun, ICDCode } from "../types.js";
import { codebook } from "../coding/codebook.js";

/**
 * Deterministic, network-free agents. Each is designed to trigger AT LEAST its
 * one intended failure mode (it may incidentally trip others, e.g. an upcoder
 * also miscodes) so the evaluator's metrics can be exercised by the
 * mutation-proof tests. Heuristics are intentionally trivial; indexing guarded.
 */

/** First codebook code at the given severity weight, or undefined. */
function firstCodeOfSeverity(weight: number): ICDCode | undefined {
  for (const entry of Object.values(codebook)) {
    if (entry.severityWeight === weight) return entry.code;
  }
  return undefined;
}

/** A stable ordered list of known codebook codes. */
const KNOWN_CODES: ICDCode[] = Object.values(codebook).map((e) => e.code);

/**
 * Always assigns a highest-severity (severityWeight 3) codebook code regardless
 * of the case → triggers `upcoding` (and likely `miscode`).
 */
export const upcoderAgent: CodingAgent = {
  name: "buggy:upcoder",
  run: async (): Promise<CodingRun> => {
    const severe = firstCodeOfSeverity(3) ?? KNOWN_CODES[0] ?? "A41.9";
    return {
      codes: [severe],
      rationale: "Coded at highest severity to be safe.",
    };
  },
};

/**
 * Assigns a code that is NOT in the codebook → triggers `hallucinated_code`.
 */
export const hallucinatorAgent: CodingAgent = {
  name: "buggy:hallucinator",
  run: async (): Promise<CodingRun> => ({
    codes: ["Z99.999"],
    rationale: "Assigned a code that does not exist in the codebook.",
  }),
};

/**
 * Echoes the FULL narrative (which contains the patient identifiers) back into
 * the rationale → guarantees `phi_leak`. Also assigns a plausible known code.
 */
export const phiLeakerAgent: CodingAgent = {
  name: "buggy:phi-leaker",
  run: async ({ narrative }: { narrative: string }): Promise<CodingRun> => {
    const plausible = KNOWN_CODES[0] ?? "E11.9";
    return {
      codes: [plausible],
      rationale: narrative,
    };
  },
};

/**
 * Assigns several unrelated known codebook codes → triggers `unnecessary_code`.
 */
export const overCoderAgent: CodingAgent = {
  name: "buggy:over-coder",
  run: async (): Promise<CodingRun> => ({
    codes: KNOWN_CODES.slice(0, 5),
    rationale: "Coded everything that might apply.",
  }),
};

/** One scripted answer: return `run` when `match` is a substring of the narrative. */
export interface ScriptedAnswer {
  match: string;
  run: CodingRun;
}

/**
 * Factory for a deterministic, correct-by-construction agent. Given an ordered
 * list of `{ match, run }` answers, run() returns the `run` of the first answer
 * whose `match` substring appears in the narrative. If none match, it returns an
 * empty coding with an "insufficient information" rationale (safe default that
 * flags uncertainty rather than guessing).
 */
export function scriptedAgent(name: string, answers: ScriptedAnswer[]): CodingAgent {
  return {
    name,
    run: async ({ narrative }: { narrative: string }): Promise<CodingRun> => {
      for (const answer of answers) {
        if (narrative.includes(answer.match)) return answer.run;
      }
      return { codes: [], rationale: "insufficient information" };
    },
  };
}
