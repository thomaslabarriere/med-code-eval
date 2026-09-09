import { describe, it, expect } from "vitest";
import { CodingRun, Vignette } from "../src/types.js";
import { vignettes } from "../src/scenarios/vignettes.js";
import { runVignette } from "../src/runner.js";
import {
  upcoderAgent,
  hallucinatorAgent,
  phiLeakerAgent,
  overCoderAgent,
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
