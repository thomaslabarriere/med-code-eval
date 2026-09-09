import type { CodingDiff, CodingRun, ExpectedCoding } from "../types.js";
import { codebook, normalizeCode } from "./codebook.js";

function uniqueNormalized(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of codes) {
    const c = normalizeCode(raw);
    if (c.length > 0 && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/**
 * Compare the agent's assigned codes against ground truth + the codebook.
 * The verdict is built here from the codes themselves (objective), never from
 * the agent's rationale.
 */
export function compareCoding(
  expected: ExpectedCoding,
  run: CodingRun,
): CodingDiff {
  const assigned = uniqueNormalized(run.codes);

  const required = uniqueNormalized([expected.primary, ...expected.comorbidities]);
  const allowed = new Set([
    ...required,
    ...uniqueNormalized(expected.allowedExtra ?? []),
  ]);

  const missing = required.filter((c) => !assigned.includes(c));
  const extra = assigned.filter((c) => !allowed.has(c));
  const hallucinated = assigned.filter((c) => !(c in codebook));

  return { assigned, missing, extra, hallucinated };
}
