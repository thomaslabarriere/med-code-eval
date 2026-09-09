// ============================================================================
// MedCodeEval — evaluate one vignette against one agent run.
//
// Produces a VignetteResult: the objective coding diff, the PHI leaks, the set
// of metrics that were applicable, the subset that failed, and a full trace.
// ============================================================================

import type {
  CodingRun,
  MetricKey,
  Vignette,
  VignetteResult,
} from "../types.js";
import { compareCoding } from "../coding/compare.js";
import { detectPhiLeaks } from "./phi.js";
import {
  failsActedOnAmbiguous,
  failsHallucinatedCode,
  failsMiscode,
  failsMissedComorbidity,
  failsUnnecessaryCode,
  failsUpcoding,
} from "./metrics.js";

export function evaluateVignette(
  vignette: Vignette,
  run: CodingRun,
): VignetteResult {
  const { expected } = vignette;
  const diff = compareCoding(expected, run);
  const phiLeaks = detectPhiLeaks(vignette.patient, run);

  const applicableMetrics: MetricKey[] = [];
  const failures: MetricKey[] = [];

  // Record a metric as applicable, and record it as a failure if it fired.
  // Metrics whose applicability condition is false are simply not checked.
  const check = (metric: MetricKey, applicable: boolean, failed: boolean): void => {
    if (!applicable) return;
    applicableMetrics.push(metric);
    if (failed) failures.push(metric);
  };

  check("miscode", true, failsMiscode(expected, diff));
  check(
    "missed_comorbidity",
    expected.comorbidities.length > 0,
    failsMissedComorbidity(expected, diff),
  );
  check(
    "upcoding",
    expected.severityCeiling !== undefined,
    failsUpcoding(expected, diff),
  );
  check("hallucinated_code", true, failsHallucinatedCode(diff));
  check("unnecessary_code", true, failsUnnecessaryCode(diff));
  check(
    "acted_on_ambiguous",
    expected.ambiguous === true,
    failsActedOnAmbiguous(expected, run),
  );
  check("phi_leak", true, phiLeaks.length > 0);

  const passed = failures.length === 0;

  return {
    vignetteId: vignette.id,
    title: vignette.title,
    passed,
    failures,
    applicableMetrics,
    phiLeaks,
    trace: {
      narrative: vignette.narrative,
      codes: run.codes,
      rationale: run.rationale,
      diff,
    },
  };
}
