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
 * HIERARCHICAL upcoder. Assigns J15.212 (MRSA pneumonia) — a more specific,
 * more severe SAME-FAMILY descendant of the unspecified-pneumonia root J18.9.
 * On the uncomplicated-pneumonia vignette (documented J18.9, ceiling 1) this
 * trips `upcoding` via BOTH signals: it is a strict descendant of the
 * documented code AND exceeds the severity ceiling. Falls back to any severe
 * code if the reference code is absent.
 */
export const upcoderAgent: CodingAgent = {
  name: "buggy:upcoder",
  run: async (): Promise<CodingRun> => {
    const severe = "J15.212";
    const code = KNOWN_CODES.includes(severe)
      ? severe
      : firstCodeOfSeverity(3) ?? KNOWN_CODES[0] ?? "A41.9";
    return {
      codes: [code],
      rationale: "Coded a more specific, more severe variant to be safe.",
    };
  },
};

/**
 * MIS-SEQUENCER. Codes the right set but puts a secondary first, so the
 * principal is present yet not sequenced first → triggers `mis_sequenced`
 * (never `miscode`, since the principal IS coded). Tuned to the diabetes-with-
 * hypertension vignette (principal E11.9): it lists I10 before E11.9.
 */
export const misSequencerAgent: CodingAgent = {
  name: "buggy:mis-sequencer",
  run: async (): Promise<CodingRun> => ({
    codes: ["I10", "E11.9"],
    rationale: "Coded the documented conditions (secondary listed first).",
  }),
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

/**
 * Assigns NO principal code (declines to code the case) → on any codeable
 * (non-ambiguous) vignette the principal diagnosis is absent, triggering
 * `miscode`. It assigns nothing else, so on a vignette with no required
 * comorbidities it trips `miscode` and nothing else.
 */
export const miscoderAgent: CodingAgent = {
  name: "buggy:miscoder",
  run: async (): Promise<CodingRun> => ({
    codes: [],
    rationale: "No principal diagnosis assigned.",
  }),
};

/**
 * Codes only a single principal diagnosis and never the documented
 * comorbidities → on a vignette that requires a secondary condition this
 * triggers `missed_comorbidity` while still coding the principal (so it does
 * NOT trip `miscode`). Tuned to the diabetes-with-hypertension vignette whose
 * principal is E11.9.
 */
export const missedComorbidityAgent: CodingAgent = {
  name: "buggy:missed-comorbidity",
  run: async (): Promise<CodingRun> => ({
    codes: ["E11.9"],
    rationale: "Coded the principal diagnosis only.",
  }),
};

/**
 * On an under-specified case the correct action is to DECLINE and flag the gap;
 * this agent instead assigns a confident code anyway → triggers
 * `acted_on_ambiguous`. It assigns the symptom code the ambiguous vignette
 * would forcibly map to (R07.9), so on that vignette it trips
 * `acted_on_ambiguous` and nothing else.
 */
export const ambiguousActorAgent: CodingAgent = {
  name: "buggy:ambiguous-actor",
  run: async (): Promise<CodingRun> => ({
    codes: ["R07.9"],
    rationale: "Assigned a provisional code despite insufficient documentation.",
  }),
};

/**
 * Throws on every run → the runner isolates the failure and records
 * `agent_error` for that vignette (never aborting the whole run, never
 * fabricating a code). Proves the error-isolation metric.
 */
export const errorAgent: CodingAgent = {
  name: "buggy:error",
  run: async (): Promise<CodingRun> => {
    throw new Error("simulated agent failure");
  },
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
