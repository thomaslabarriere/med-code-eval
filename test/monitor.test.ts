import { describe, it, expect } from "vitest";
import type { Scorecard, VignetteResult, CodingDiff } from "../src/types.js";
import {
  detectDistributionDrift,
  detectMiscalibration,
  detectUpcodingIncrease,
  monitorSeries,
  summarizeScorecard,
  syntheticDriftingSeries,
  syntheticStableSeries,
  totalVariationDistance,
  type RunSummary,
} from "../src/monitor/drift.js";

// ---------------------------------------------------------------------------
// Builders — tiny, so a run summary is easy to shape for one detector at a time.
// ---------------------------------------------------------------------------
function run(over: Partial<RunSummary>): RunSummary {
  return {
    label: "run",
    codeCounts: { "E11.9": 2, "I10": 1 },
    upcodingRate: 0.05,
    phiLeakRate: 0,
    reliabilityScore: 88,
    passRate: 0.85,
    ...over,
  };
}

describe("totalVariationDistance", () => {
  it("is 0 for identical distributions", () => {
    expect(totalVariationDistance({ a: 3, b: 1 }, { a: 6, b: 2 })).toBe(0);
  });
  it("is 1 for disjoint distributions", () => {
    expect(totalVariationDistance({ a: 1 }, { b: 1 })).toBe(1);
  });
  it("treats two empty distributions as identical", () => {
    expect(totalVariationDistance({}, {})).toBe(0);
  });
});

describe("monitor — stable series fires no alert (no false positives)", () => {
  it("returns no alerts for the synthetic stable series", () => {
    expect(monitorSeries(syntheticStableSeries())).toEqual([]);
  });
  it("returns no alerts for a single run (nothing to compare)", () => {
    expect(monitorSeries([run({})])).toEqual([]);
  });
  it("returns no alerts for an empty series", () => {
    expect(monitorSeries([])).toEqual([]);
  });
});

describe("monitor — drifting series raises alerts", () => {
  it("fires all three detectors on the synthetic drifting series", () => {
    const alerts = monitorSeries(syntheticDriftingSeries());
    const types = alerts.map((a) => a.type).sort();
    expect(types).toEqual([
      "code_distribution_drift",
      "confidence_miscalibration",
      "upcoding_rate_increase",
    ]);
  });
});

describe("detectDistributionDrift", () => {
  it("fires when the code mix moves past the threshold", () => {
    const series = [
      run({ codeCounts: { "E11.9": 5 } }),
      run({ codeCounts: { "I10": 5 } }), // fully disjoint → TVD 1
    ];
    const alert = detectDistributionDrift(series);
    expect(alert?.type).toBe("code_distribution_drift");
    expect(alert?.severity).toBe("critical");
    expect(alert?.value).toBe(1);
  });
  it("stays silent when the mix barely moves", () => {
    const series = [
      run({ codeCounts: { "E11.9": 10, "I10": 10 } }),
      run({ codeCounts: { "E11.9": 11, "I10": 9 } }),
    ];
    expect(detectDistributionDrift(series)).toBeNull();
  });
});

describe("detectUpcodingIncrease", () => {
  it("fires when the upcoding rate climbs past the baseline mean", () => {
    const series = [
      run({ upcodingRate: 0.05 }),
      run({ upcodingRate: 0.5 }),
    ];
    const alert = detectUpcodingIncrease(series);
    expect(alert?.type).toBe("upcoding_rate_increase");
    expect(alert?.severity).toBe("critical");
  });
  it("stays silent when the rate is flat", () => {
    const series = [run({ upcodingRate: 0.05 }), run({ upcodingRate: 0.07 })];
    expect(detectUpcodingIncrease(series)).toBeNull();
  });
});

describe("detectMiscalibration", () => {
  it("fires when the reliability score overstates the pass rate", () => {
    const series = [
      run({ reliabilityScore: 85, passRate: 0.85 }),
      run({ reliabilityScore: 85, passRate: 0.3 }), // gap 0.55
    ];
    const alert = detectMiscalibration(series);
    expect(alert?.type).toBe("confidence_miscalibration");
    expect(alert?.severity).toBe("critical");
  });
  it("stays silent when score and pass rate agree", () => {
    const series = [
      run({ reliabilityScore: 88, passRate: 0.85 }),
      run({ reliabilityScore: 86, passRate: 0.82 }),
    ];
    expect(detectMiscalibration(series)).toBeNull();
  });
});

describe("summarizeScorecard", () => {
  function diff(assigned: string[]): CodingDiff {
    return {
      assigned,
      principalAssigned: assigned[0] ?? null,
      missing: [],
      extra: [],
      hallucinated: [],
      upcodes: [],
    };
  }
  function vres(assigned: string[]): VignetteResult {
    return {
      vignetteId: "v",
      title: "t",
      passed: true,
      failures: [],
      applicableMetrics: [],
      phiLeaks: [],
      trace: { narrative: "", codes: assigned, rationale: "", diff: diff(assigned) },
    };
  }
  const sc: Scorecard = {
    agentName: "grounded:gpt-4o",
    model: "gpt-4o",
    totalVignettes: 2,
    passed: 1,
    reliabilityScore: 75,
    rates: { upcoding: 0.5 },
    phiLeakCount: 1,
    perVignette: [vres(["E11.9", "I10"]), vres(["E11.9"])],
  };

  it("projects code counts from the objective assigned codes", () => {
    const s = summarizeScorecard(sc);
    expect(s.codeCounts).toEqual({ "E11.9": 2, "I10": 1 });
    expect(s.upcodingRate).toBe(0.5);
    expect(s.passRate).toBe(0.5);
    expect(s.phiLeakRate).toBe(0.5);
    expect(s.label).toBe("gpt-4o");
  });

  it("defaults upcoding rate to 0 when the metric never fired", () => {
    const s = summarizeScorecard({ ...sc, rates: {} });
    expect(s.upcodingRate).toBe(0);
  });
});
