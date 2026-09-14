import { describe, it, expect } from "vitest";
import { CodingRun, MetricKey, Vignette } from "../src/types.js";
import { vignettes } from "../src/scenarios/vignettes.js";
import { runVignette } from "../src/runner.js";
import {
  upcoderAgent,
  hallucinatorAgent,
  phiLeakerAgent,
  overCoderAgent,
  miscoderAgent,
  missedComorbidityAgent,
  ambiguousActorAgent,
  errorAgent,
  scriptedAgent,
} from "../src/agent/buggy.js";

function vignette(id: string): Vignette {
  const v = vignettes.find((x) => x.id === id);
  if (!v) throw new Error(`vignette ${id} not found`);
  return v;
}

// The correct coding for a vignette, derived from its own ground truth:
// principal + comorbidities, with a clean rationale that echoes no identifiers.
// For an under-specified case, the correct agent flags uncertainty.
function correctRun(v: Vignette): CodingRun {
  // On an under-specified case the correct action is to DECLINE (assign no
  // code) and flag the gap — so the "correct" run assigns nothing there.
  if (v.expected.ambiguous) {
    return {
      codes: [],
      rationale: "Documentation is insufficient to code; recommend clarification.",
    };
  }
  return {
    codes: [v.expected.primary, ...v.expected.comorbidities],
    rationale: "Coded from the documented diagnoses.",
  };
}

// ---------------------------------------------------------------------------
// Mutation proof: each deliberately-broken coding agent must be caught on the
// metric it violates.
// ---------------------------------------------------------------------------
describe("mutation proof — the harness catches broken coding agents", () => {
  it("catches upcoding (agent that always codes at highest severity)", async () => {
    const r = await runVignette(upcoderAgent, vignette("no-upcode-pneumonia"));
    expect(r.passed).toBe(false);
    expect(r.failures).toContain("upcoding");
  });

  it("catches a hallucinated (non-existent) code", async () => {
    const r = await runVignette(hallucinatorAgent, vignette("simple-diabetes"));
    expect(r.passed).toBe(false);
    expect(r.failures).toContain("hallucinated_code");
  });

  it("catches PHI leakage (agent that echoes the patient identifiers)", async () => {
    const r = await runVignette(phiLeakerAgent, vignette("phi-trap"));
    expect(r.passed).toBe(false);
    expect(r.failures).toContain("phi_leak");
    expect(r.phiLeaks.length).toBeGreaterThan(0);
  });

  it("catches unnecessary codes (agent that over-codes)", async () => {
    const r = await runVignette(overCoderAgent, vignette("already-complete"));
    expect(r.passed).toBe(false);
    expect(r.failures).toContain("unnecessary_code");
  });

  it("catches a miscode (agent that assigns no principal diagnosis)", async () => {
    const r = await runVignette(miscoderAgent, vignette("simple-diabetes"));
    expect(r.passed).toBe(false);
    // A vignette with no required comorbidities: this trips miscode ALONE.
    expect(r.failures).toEqual(["miscode"]);
  });

  it("catches a missed comorbidity (agent that codes the principal only)", async () => {
    const r = await runVignette(
      missedComorbidityAgent,
      vignette("comorbidity-diabetes-htn"),
    );
    expect(r.passed).toBe(false);
    // Principal IS coded, so miscode must NOT fire — only missed_comorbidity.
    expect(r.failures).toEqual(["missed_comorbidity"]);
  });

  it("catches acting on an ambiguous case (agent that codes anyway)", async () => {
    const r = await runVignette(ambiguousActorAgent, vignette("ambiguous-case"));
    expect(r.passed).toBe(false);
    expect(r.failures).toEqual(["acted_on_ambiguous"]);
  });

  it("catches (and isolates) an agent that throws", async () => {
    const r = await runVignette(errorAgent, vignette("simple-diabetes"));
    expect(r.passed).toBe(false);
    expect(r.failures).toEqual(["agent_error"]);
    // Degrades safely: no fabricated code slips through.
    expect(r.trace.codes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Full coverage: assert that EVERY metric key has a fixture proving the harness
// catches its failure. This test fails if a metric is added without a fixture,
// keeping the README's coverage claim honest.
// ---------------------------------------------------------------------------
describe("mutation proof — every metric is covered by a fixture", () => {
  const ALL_METRICS: MetricKey[] = [
    "miscode",
    "upcoding",
    "phi_leak",
    "hallucinated_code",
    "missed_comorbidity",
    "unnecessary_code",
    "acted_on_ambiguous",
    "agent_error",
  ];

  const cases: Array<{ metric: MetricKey; run: () => Promise<{ failures: MetricKey[] }> }> = [
    { metric: "miscode", run: () => runVignette(miscoderAgent, vignette("simple-diabetes")) },
    { metric: "upcoding", run: () => runVignette(upcoderAgent, vignette("no-upcode-pneumonia")) },
    { metric: "phi_leak", run: () => runVignette(phiLeakerAgent, vignette("phi-trap")) },
    { metric: "hallucinated_code", run: () => runVignette(hallucinatorAgent, vignette("simple-diabetes")) },
    { metric: "missed_comorbidity", run: () => runVignette(missedComorbidityAgent, vignette("comorbidity-diabetes-htn")) },
    { metric: "unnecessary_code", run: () => runVignette(overCoderAgent, vignette("already-complete")) },
    { metric: "acted_on_ambiguous", run: () => runVignette(ambiguousActorAgent, vignette("ambiguous-case")) },
    { metric: "agent_error", run: () => runVignette(errorAgent, vignette("simple-diabetes")) },
  ];

  it("has a fixture for each of the 8 metrics", () => {
    expect(cases.map((c) => c.metric).sort()).toEqual([...ALL_METRICS].sort());
  });

  for (const { metric, run } of cases) {
    it(`fixture trips ${metric}`, async () => {
      const r = await run();
      expect(r.failures).toContain(metric);
    });
  }
});

// ---------------------------------------------------------------------------
// Control: a correct coding (built from ground truth) must pass EVERY vignette,
// including the PHI trap and the ambiguous case — otherwise the harness would
// just fail everything.
// ---------------------------------------------------------------------------
describe("control — a correct agent is not falsely flagged", () => {
  const control = scriptedAgent(
    "control:correct",
    vignettes.map((v) => ({ match: v.narrative, run: correctRun(v) })),
  );

  for (const v of vignettes) {
    it(`passes: ${v.title}`, async () => {
      const r = await runVignette(control, v);
      expect(r.failures).toEqual([]);
      expect(r.passed).toBe(true);
    });
  }
});
