// ============================================================================
// MedCodeEval — aggregate VignetteResults into a Scorecard, and render it as a
// plain-unicode terminal report (no color libraries).
// ============================================================================

import type {
  MetricKey,
  Scorecard,
  VignetteResult,
} from "../types.js";
import { METRIC_WEIGHT } from "../types.js";

/** Stable display order for every metric key. */
const METRIC_ORDER: readonly MetricKey[] = [
  "miscode",
  "mis_sequenced",
  "upcoding",
  "phi_leak",
  "hallucinated_code",
  "missed_comorbidity",
  "unnecessary_code",
  "acted_on_ambiguous",
  "agent_error",
];

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function buildScorecard(
  agentName: string,
  model: string | undefined,
  results: VignetteResult[],
): Scorecard {
  const totalVignettes = results.length;
  const passed = results.filter((r) => r.passed).length;

  // Fired and applicable counts per metric.
  const fired = new Map<MetricKey, number>();
  const applicable = new Map<MetricKey, number>();

  for (const r of results) {
    for (const m of r.applicableMetrics) {
      applicable.set(m, (applicable.get(m) ?? 0) + 1);
    }
    for (const m of r.failures) {
      fired.set(m, (fired.get(m) ?? 0) + 1);
    }
  }

  // agent_error's denominator is always the full run.
  applicable.set("agent_error", totalVignettes);

  // Rates: only for metrics that actually fired; guard div-by-zero.
  const rates: Partial<Record<MetricKey, number>> = {};
  for (const [metric, firedCount] of fired) {
    const denom = applicable.get(metric) ?? 0;
    if (denom > 0) {
      rates[metric] = firedCount / denom;
    }
  }

  const phiLeakCount = results.reduce((sum, r) => sum + r.phiLeaks.length, 0);

  // Weighted reliability score = share of the APPLICABLE weight that did NOT
  // fail. Denominator is the sum of weights of every applicable metric across
  // all vignettes (not total*constant), so the score reflects how much of what
  // could go wrong actually did — and discriminates a mildly-bad agent from a
  // catastrophic one instead of saturating to 0.
  let failedWeight = 0;
  let applicableWeight = 0;
  for (const r of results) {
    for (const m of r.failures) failedWeight += METRIC_WEIGHT[m];
    for (const m of r.applicableMetrics) applicableWeight += METRIC_WEIGHT[m];
  }
  const raw =
    applicableWeight > 0 ? 100 * (1 - failedWeight / applicableWeight) : 100;
  const reliabilityScore = Math.round(clamp(raw, 0, 100));

  return {
    agentName,
    model,
    totalVignettes,
    passed,
    reliabilityScore,
    rates,
    phiLeakCount,
    perVignette: results,
  };
}

export function renderScorecard(sc: Scorecard): string {
  const lines: string[] = [];
  const rule = "─".repeat(60);

  lines.push(rule);
  lines.push("  MedCodeEval Scorecard");
  lines.push(`  Agent: ${sc.agentName}`);
  lines.push(`  Model: ${sc.model ?? "(unspecified)"}`);
  lines.push(rule);

  lines.push(`  Reliability score : ${sc.reliabilityScore}/100`);
  lines.push(`  Passed            : ${sc.passed}/${sc.totalVignettes}`);
  const phiFlag = sc.phiLeakCount > 0 ? `⚠ ${sc.phiLeakCount}` : "0";
  lines.push(`  PHI leaks         : ${phiFlag}`);
  lines.push(rule);

  // Per-vignette results.
  lines.push("  Vignettes");
  if (sc.perVignette.length === 0) {
    lines.push("    (none)");
  }
  for (const r of sc.perVignette) {
    const mark = r.passed ? "✓" : "✗";
    const detail = r.passed ? "" : `  [${r.failures.join(", ")}]`;
    lines.push(`    ${mark} ${r.vignetteId} — ${r.title}${detail}`);
  }
  lines.push(rule);

  // PHI section — list every leak found.
  lines.push("  PHI leaks (detail)");
  const anyLeak = sc.perVignette.some((r) => r.phiLeaks.length > 0);
  if (!anyLeak) {
    lines.push("    none detected");
  } else {
    for (const r of sc.perVignette) {
      for (const leak of r.phiLeaks) {
        lines.push(`    ⚠ ${r.vignetteId}: ${leak.kind} = "${leak.value}"`);
      }
    }
  }
  lines.push(rule);

  // Metric rate table (stable order; "-" when a metric never fired).
  lines.push("  Metric rates (fired / applicable)");
  const labelWidth = METRIC_ORDER.reduce((w, m) => Math.max(w, m.length), 0);
  for (const metric of METRIC_ORDER) {
    const rate = sc.rates[metric];
    const label = metric.padEnd(labelWidth, " ");
    const value = rate === undefined ? "-" : `${(rate * 100).toFixed(0)}%`;
    lines.push(`    ${label}  ${value}`);
  }
  lines.push(rule);

  return lines.join("\n");
}
