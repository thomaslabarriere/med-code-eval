import type { CodingDiff, CodingRun, ExpectedCoding, ICDCode } from "../types.js";
import { hierarchy, isUpcodeOf, normalizeCode } from "./hierarchy.js";

/** De-duplicate while PRESERVING assigned order (sequencing is meaningful). */
function uniqueNormalized(codes: string[]): ICDCode[] {
  const seen = new Set<ICDCode>();
  const out: ICDCode[] = [];
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
 * Compare the agent's assigned codes against ground truth + the hierarchy.
 * The verdict is built here from the codes themselves (objective), never from
 * the agent's rationale. Assigned ORDER is preserved so sequencing (which code
 * is principal) can be judged downstream.
 */
export function compareCoding(
  expected: ExpectedCoding,
  run: CodingRun,
): CodingDiff {
  const assigned = uniqueNormalized(run.codes);
  const principalAssigned = assigned.length > 0 ? assigned[0] ?? null : null;

  const required = uniqueNormalized([expected.primary, ...expected.comorbidities]);
  const allowed = new Set<ICDCode>([
    ...required,
    ...uniqueNormalized(expected.allowedExtra ?? []),
  ]);

  const missing = required.filter((c) => !assigned.includes(c));
  const extra = assigned.filter((c) => !allowed.has(c));
  const hallucinated = assigned.filter((c) => !(c in hierarchy));

  // Hierarchical upcodes: an assigned known code that is a more specific/severe
  // variant (same family) than a documented (required) code. Compared against
  // every required code so upcoding a comorbidity is caught too.
  const upcodes = assigned.filter(
    (c) => c in hierarchy && required.some((r) => isUpcodeOf(c, r)),
  );

  return { assigned, principalAssigned, missing, extra, hallucinated, upcodes };
}
