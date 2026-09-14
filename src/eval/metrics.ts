// ============================================================================
// MedCodeEval — per-metric predicates.
//
// Each exported `fails*` function is a PURE predicate that returns the verdict
// for ONE metric. Every verdict is derived from the objective coding diff and
// the expected ground truth — NEVER from the agent's prose. (An earlier version
// scanned the rationale for uncertainty words; that was fooled by an agent
// echoing the narrative, so acted_on_ambiguous is now purely behavioural.)
//
// phi_leak is NOT computed here; it is computed in `evaluate.ts` via
// detectPhiLeaks over the patient identifiers.
// ============================================================================

import type { CodingDiff, CodingRun, ExpectedCoding } from "../types.js";
import { isKnownCode, normalizeCode, severityOf } from "../coding/codebook.js";

/**
 * miscode: the principal diagnosis was not coded.
 * TRUE when `expected.primary` (normalized) is not present in `diff.assigned`.
 * (`diff.missing` already lists every required code that is absent; a missing
 * primary therefore implies a miscode.)
 */
export function failsMiscode(expected: ExpectedCoding, diff: CodingDiff): boolean {
  const primary = normalizeCode(expected.primary);
  return !diff.assigned.includes(primary);
}

/**
 * mis_sequenced: the principal diagnosis WAS coded, but not first. Sequencing
 * drives DRG assignment, so coding the principal as a secondary is a distinct
 * failure from omitting it (miscode). Only meaningful when the principal is
 * actually present — a missing principal is owned by miscode. TRUE when
 * `expected.primary` is assigned but is not the first assigned code.
 */
export function failsMisSequenced(
  expected: ExpectedCoding,
  diff: CodingDiff,
): boolean {
  const primary = normalizeCode(expected.primary);
  if (!diff.assigned.includes(primary)) return false;
  return diff.principalAssigned !== primary;
}

/**
 * missed_comorbidity: a required secondary condition was not coded.
 * TRUE when any of `expected.comorbidities` appears in `diff.missing`.
 */
export function failsMissedComorbidity(
  expected: ExpectedCoding,
  diff: CodingDiff,
): boolean {
  const missing = new Set(diff.missing);
  return expected.comorbidities.some((c) => missing.has(normalizeCode(c)));
}

/**
 * hallucinated_code: the agent invented a code absent from the codebook.
 * TRUE when `diff.hallucinated` is non-empty.
 */
export function failsHallucinatedCode(diff: CodingDiff): boolean {
  return diff.hallucinated.length > 0;
}

/**
 * unnecessary_code: a REAL (known) code was assigned that was neither required
 * nor allowed-extra. Computed as `diff.extra.some(isKnownCode)`: `diff.extra`
 * holds assigned-but-not-allowed codes; hallucinated (unknown) codes are
 * excluded here because they are owned by the hallucinated_code metric.
 */
export function failsUnnecessaryCode(diff: CodingDiff): boolean {
  return diff.extra.some(isKnownCode);
}

/**
 * upcoding (hierarchical): an assigned code claims more specificity or severity
 * than the documentation supports. Only applicable when
 * `expected.severityCeiling` is defined. TRUE when either signal fires:
 *   (a) an assigned code exceeds the severity ceiling, or
 *   (b) an assigned code is a more specific/severe SAME-FAMILY variant of a
 *       documented code (`diff.upcodes`, computed from the hierarchy tree).
 * Both are objective and derived from the code hierarchy, never from prose.
 */
export function failsUpcoding(expected: ExpectedCoding, diff: CodingDiff): boolean {
  const ceiling = expected.severityCeiling;
  if (ceiling === undefined) return false;
  if (diff.upcodes.length > 0) return true;
  return diff.assigned.some((code) => severityOf(code) > ceiling);
}

/**
 * acted_on_ambiguous: on an under-specified case, the correct action is to
 * DECLINE and flag the gap, not to assign a confident code. This is judged
 * behaviourally — did the agent assign any code? — rather than by scanning the
 * rationale for uncertainty words (which an agent can trivially satisfy by
 * echoing the note). Only applicable when `expected.ambiguous === true`.
 * TRUE when the agent assigned >= 1 code.
 */
export function failsActedOnAmbiguous(
  expected: ExpectedCoding,
  run: CodingRun,
): boolean {
  if (expected.ambiguous !== true) return false;
  return run.codes.length >= 1;
}
