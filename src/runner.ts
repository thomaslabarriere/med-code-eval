import {
  CodingAgent,
  CodingDiff,
  Vignette,
  VignetteResult,
} from "./types.js";
import { evaluateVignette } from "./eval/evaluate.js";

const EMPTY_DIFF: CodingDiff = {
  assigned: [],
  missing: [],
  extra: [],
  hallucinated: [],
};

/** Synthetic result for a vignette whose agent run threw (API error, etc.). */
function errorResult(vignette: Vignette, err: unknown): VignetteResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    vignetteId: vignette.id,
    title: vignette.title,
    passed: false,
    failures: ["agent_error"],
    applicableMetrics: ["agent_error"],
    phiLeaks: [],
    trace: {
      narrative: vignette.narrative,
      codes: [],
      rationale: `ERROR: ${message}`,
      diff: EMPTY_DIFF,
    },
  };
}

/**
 * Run one vignette against an agent and evaluate it. A thrown agent run is
 * captured as an `agent_error` result, never propagated — one failing vignette
 * (or model) must not sink the rest of the run.
 */
export async function runVignette(
  agent: CodingAgent,
  vignette: Vignette,
): Promise<VignetteResult> {
  try {
    const run = await agent.run({ narrative: vignette.narrative });
    return evaluateVignette(vignette, run);
  } catch (err) {
    return errorResult(vignette, err);
  }
}

export async function runVignettes(
  agent: CodingAgent,
  vignettes: Vignette[],
): Promise<VignetteResult[]> {
  const results: VignetteResult[] = [];
  for (const vignette of vignettes) {
    results.push(await runVignette(agent, vignette));
  }
  return results;
}
