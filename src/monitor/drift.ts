// ============================================================================
// MedCodeEval — monitoring over a SERIES of runs (the "monitor" brick of the
// build → evaluate → monitor lifecycle).
//
// Everything here is a PURE function over an ordered series of run summaries.
// A run summary is the small, monitorable projection of a full Scorecard
// (`summarizeScorecard`), so the monitor never depends on how a scorecard was
// produced — feed it live scorecards, saved JSON, or a synthetic series.
//
// It watches three things a coding agent can silently regress on in production:
//   1. the DISTRIBUTION of assigned codes shifting (total-variation distance);
//   2. the UPCODING rate climbing (reimbursement / compliance risk);
//   3. a coarse CONFIDENCE calibration gap — the harness's own reliability
//      score overstating the realized pass rate (over-confidence).
// Each detector emits a structured `Alert` (type, severity, detail, value,
// threshold) or nothing. See DECISIONS.md for what this does and does NOT catch
// (notably: no independent model-reported confidence, so calibration is a proxy).
// ============================================================================

import type { ICDCode, Scorecard } from "../types.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The monitorable projection of one evaluation run. */
export interface RunSummary {
  /** Human label for the run (a run id, timestamp, or model name). */
  label: string;
  /** Frequency of each assigned code across the run's vignettes. */
  codeCounts: Record<ICDCode, number>;
  /** Upcoding rate for the run (0..1); undefined when the metric never applied. */
  upcodingRate: number;
  /** PHI leaks divided by vignette count (0..1+). */
  phiLeakRate: number;
  /** The harness's weighted reliability score for the run (0..100). */
  reliabilityScore: number;
  /** Realized pass fraction (passed / total, 0..1). */
  passRate: number;
}

/**
 * Project a full Scorecard down to a RunSummary. Code counts come from the
 * OBJECTIVE assigned codes in each vignette trace, never from prose. Upcoding
 * rate defaults to 0 when the metric never fired (it is `-` in the scorecard),
 * which is the correct monitoring baseline: "no upcoding observed".
 */
export function summarizeScorecard(sc: Scorecard): RunSummary {
  const codeCounts: Record<ICDCode, number> = {};
  for (const v of sc.perVignette) {
    for (const code of v.trace.diff.assigned) {
      codeCounts[code] = (codeCounts[code] ?? 0) + 1;
    }
  }
  const passRate =
    sc.totalVignettes > 0 ? sc.passed / sc.totalVignettes : 0;
  const phiLeakRate =
    sc.totalVignettes > 0 ? sc.phiLeakCount / sc.totalVignettes : 0;
  return {
    label: sc.model ?? sc.agentName,
    codeCounts,
    upcodingRate: sc.rates.upcoding ?? 0,
    phiLeakRate,
    reliabilityScore: sc.reliabilityScore,
    passRate,
  };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertType =
  | "code_distribution_drift"
  | "upcoding_rate_increase"
  | "confidence_miscalibration";

/** info < warn < critical. */
export type AlertSeverity = "info" | "warn" | "critical";

export interface Alert {
  type: AlertType;
  severity: AlertSeverity;
  /** Human-readable explanation of what fired and by how much. */
  detail: string;
  /** The observed statistic that fired the alert. */
  value: number;
  /** The threshold it crossed. */
  threshold: number;
}

// Thresholds. Absolute, illustrative, and deliberately conservative so a stable
// series never fires. Two tiers each: warn, then critical.
export const THRESHOLDS = {
  /** Total-variation distance between current and baseline code distribution. */
  driftWarn: 0.25,
  driftCritical: 0.5,
  /** Absolute rise in upcoding rate vs the baseline mean. */
  upcodingWarn: 0.15,
  upcodingCritical: 0.3,
  /** How far reliabilityScore/100 may exceed the realized pass rate. */
  calibrationWarn: 0.25,
  calibrationCritical: 0.45,
} as const;

// ---------------------------------------------------------------------------
// Pure statistics
// ---------------------------------------------------------------------------

/** Sum two or more code-count maps into one. */
function sumCounts(maps: ReadonlyArray<Record<ICDCode, number>>): Record<ICDCode, number> {
  const out: Record<ICDCode, number> = {};
  for (const m of maps) {
    for (const [code, n] of Object.entries(m)) {
      out[code] = (out[code] ?? 0) + n;
    }
  }
  return out;
}

/** Normalize a count map to a probability distribution (sums to 1, or empty). */
function normalize(counts: Record<ICDCode, number>): Record<ICDCode, number> {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (total <= 0) return {};
  const out: Record<ICDCode, number> = {};
  for (const [code, n] of Object.entries(counts)) out[code] = n / total;
  return out;
}

/**
 * Total-variation distance between two code distributions: 0 (identical) .. 1
 * (disjoint). TVD = 0.5 * sum_over_codes |p(code) - q(code)|. Symmetric, bounded,
 * and needs no smoothing — the right coarse "did the mix of codes move" statistic.
 * Two empty distributions are treated as identical (distance 0).
 */
export function totalVariationDistance(
  a: Record<ICDCode, number>,
  b: Record<ICDCode, number>,
): number {
  const p = normalize(a);
  const q = normalize(b);
  const codes = new Set([...Object.keys(p), ...Object.keys(q)]);
  if (codes.size === 0) return 0;
  let sum = 0;
  for (const code of codes) sum += Math.abs((p[code] ?? 0) - (q[code] ?? 0));
  return 0.5 * sum;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function severityFor(value: number, warn: number, critical: number): AlertSeverity | null {
  if (value >= critical) return "critical";
  if (value >= warn) return "warn";
  return null;
}

// ---------------------------------------------------------------------------
// Detectors — each returns one Alert or null. Baseline = every run before the
// last; current = the last run. Fewer than two runs → nothing to compare.
// ---------------------------------------------------------------------------

/** Split a series into (baseline runs, current run), or null if too short. */
function baselineAndCurrent(
  series: readonly RunSummary[],
): { baseline: RunSummary[]; current: RunSummary } | null {
  if (series.length < 2) return null;
  const current = series[series.length - 1];
  if (current === undefined) return null;
  return { baseline: series.slice(0, -1), current };
}

export function detectDistributionDrift(series: readonly RunSummary[]): Alert | null {
  const split = baselineAndCurrent(series);
  if (split === null) return null;
  const baselineCounts = sumCounts(split.baseline.map((r) => r.codeCounts));
  const tvd = totalVariationDistance(baselineCounts, split.current.codeCounts);
  const sev = severityFor(tvd, THRESHOLDS.driftWarn, THRESHOLDS.driftCritical);
  if (sev === null) return null;
  return {
    type: "code_distribution_drift",
    severity: sev,
    value: tvd,
    threshold: THRESHOLDS.driftWarn,
    detail:
      `Assigned-code distribution moved by TVD ${tvd.toFixed(2)} vs the ` +
      `baseline of ${split.baseline.length} run(s) (warn ${THRESHOLDS.driftWarn}, ` +
      `critical ${THRESHOLDS.driftCritical}). The mix of codes the agent emits has shifted.`,
  };
}

export function detectUpcodingIncrease(series: readonly RunSummary[]): Alert | null {
  const split = baselineAndCurrent(series);
  if (split === null) return null;
  const baseMean = mean(split.baseline.map((r) => r.upcodingRate));
  const delta = split.current.upcodingRate - baseMean;
  const sev = severityFor(delta, THRESHOLDS.upcodingWarn, THRESHOLDS.upcodingCritical);
  if (sev === null) return null;
  return {
    type: "upcoding_rate_increase",
    severity: sev,
    value: delta,
    threshold: THRESHOLDS.upcodingWarn,
    detail:
      `Upcoding rate rose to ${(split.current.upcodingRate * 100).toFixed(0)}% ` +
      `from a baseline mean of ${(baseMean * 100).toFixed(0)}% ` +
      `(+${(delta * 100).toFixed(0)} pts; warn +${(THRESHOLDS.upcodingWarn * 100).toFixed(0)}, ` +
      `critical +${(THRESHOLDS.upcodingCritical * 100).toFixed(0)}). Reimbursement / compliance risk.`,
  };
}

/**
 * Coarse confidence calibration: the harness's weighted reliability score is a
 * stand-in for "how well the agent claims to be doing"; the realized pass rate
 * is how well it actually did. When the score materially EXCEEDS the pass rate,
 * the run is over-confident. This is a proxy (no independent model-reported
 * confidence exists here) — see DECISIONS.md. Judged on the current run only.
 */
export function detectMiscalibration(series: readonly RunSummary[]): Alert | null {
  const split = baselineAndCurrent(series);
  if (split === null) return null;
  const gap = split.current.reliabilityScore / 100 - split.current.passRate;
  const sev = severityFor(gap, THRESHOLDS.calibrationWarn, THRESHOLDS.calibrationCritical);
  if (sev === null) return null;
  return {
    type: "confidence_miscalibration",
    severity: sev,
    value: gap,
    threshold: THRESHOLDS.calibrationWarn,
    detail:
      `Reliability score ${split.current.reliabilityScore}/100 overstates the ` +
      `realized pass rate ${(split.current.passRate * 100).toFixed(0)}% by ` +
      `${(gap * 100).toFixed(0)} pts (warn ${(THRESHOLDS.calibrationWarn * 100).toFixed(0)}, ` +
      `critical ${(THRESHOLDS.calibrationCritical * 100).toFixed(0)}). Coarse over-confidence proxy.`,
  };
}

/** Run every detector over the series and collect the alerts that fired. */
export function monitorSeries(series: readonly RunSummary[]): Alert[] {
  const detectors = [
    detectDistributionDrift,
    detectUpcodingIncrease,
    detectMiscalibration,
  ];
  const alerts: Alert[] = [];
  for (const d of detectors) {
    const a = d(series);
    if (a !== null) alerts.push(a);
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Terminal rendering (plain unicode, mirrors eval/scorecard.ts)
// ---------------------------------------------------------------------------

const SEVERITY_MARK: Record<AlertSeverity, string> = {
  info: "·",
  warn: "⚠",
  critical: "✗",
};

export function renderMonitorReport(
  series: readonly RunSummary[],
  alerts: readonly Alert[],
): string {
  const lines: string[] = [];
  const rule = "─".repeat(60);

  lines.push(rule);
  lines.push("  MedCodeEval Monitor");
  lines.push(`  Runs in series : ${series.length}`);
  lines.push(rule);

  lines.push("  Series (oldest → newest)");
  if (series.length === 0) lines.push("    (none)");
  for (const r of series) {
    lines.push(
      `    ${r.label.padEnd(24)} score ${String(r.reliabilityScore).padStart(3)}/100` +
        `  pass ${(r.passRate * 100).toFixed(0).padStart(3)}%` +
        `  upcode ${(r.upcodingRate * 100).toFixed(0).padStart(3)}%`,
    );
  }
  lines.push(rule);

  lines.push("  Alerts");
  if (alerts.length === 0) {
    lines.push("    none — series is stable within thresholds");
  } else {
    for (const a of alerts) {
      lines.push(`    ${SEVERITY_MARK[a.severity]} [${a.severity}] ${a.type}`);
      lines.push(`        ${a.detail}`);
    }
  }
  lines.push(rule);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Synthetic demo series — clearly labelled, so `monitor` runs with no files and
// no network. Shared by the CLI demo and the tests. NOT real coding data.
// ---------------------------------------------------------------------------

/** A stable series: same code mix, flat low upcoding, calibrated. No alerts. */
export function syntheticStableSeries(): RunSummary[] {
  const counts = { "E11.9": 3, "I10": 2, "J18.9": 2, "N39.0": 1 };
  return [0, 1, 2].map((i) => ({
    label: `run-${i + 1}`,
    codeCounts: { ...counts },
    upcodingRate: 0.05,
    phiLeakRate: 0,
    reliabilityScore: 88,
    passRate: 0.87,
  }));
}

/** A drifting series: code mix shifts, upcoding climbs, score decouples from
 *  pass rate on the last run. Fires all three detectors. */
export function syntheticDriftingSeries(): RunSummary[] {
  return [
    {
      label: "run-1",
      codeCounts: { "E11.9": 4, "I10": 3, "J18.9": 2 },
      upcodingRate: 0.05,
      phiLeakRate: 0,
      reliabilityScore: 90,
      passRate: 0.88,
    },
    {
      label: "run-2",
      codeCounts: { "E11.9": 4, "I10": 3, "J18.9": 2 },
      upcodingRate: 0.08,
      phiLeakRate: 0,
      reliabilityScore: 89,
      passRate: 0.86,
    },
    {
      // Mix collapses onto the most severe codes, upcoding jumps, and the score
      // stays high while the pass rate falls away (over-confidence).
      label: "run-3",
      codeCounts: { "E11.65": 6, "I11.0": 4, "J18.9": 1 },
      upcodingRate: 0.45,
      phiLeakRate: 0,
      reliabilityScore: 82,
      passRate: 0.3,
    },
  ];
}
