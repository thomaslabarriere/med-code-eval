#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodingAgent, Scorecard } from "./types.js";
import { vignettes } from "./scenarios/vignettes.js";
import { runVignettes } from "./runner.js";
import { buildScorecard, renderScorecard } from "./eval/scorecard.js";
import { createLLMAgent } from "./agent/runAgent.js";
import { createGroundedCoder } from "./agent/coder.js";
import type { Provider } from "./agent/runAgent.js";
import { sendTraces } from "./obs/langfuse.js";
import { deidentify, scanPhi } from "./pipeline/deid.js";
import type { Vignette } from "./types.js";
import {
  upcoderAgent,
  misSequencerAgent,
  hallucinatorAgent,
  phiLeakerAgent,
  overCoderAgent,
  miscoderAgent,
  missedComorbidityAgent,
  ambiguousActorAgent,
  errorAgent,
} from "./agent/buggy.js";

type Strategy = "grounded" | "oneshot";

const BUGGY: Record<string, CodingAgent> = {
  upcoder: upcoderAgent,
  "mis-sequencer": misSequencerAgent,
  hallucinator: hallucinatorAgent,
  "phi-leaker": phiLeakerAgent,
  "over-coder": overCoderAgent,
  miscoder: miscoderAgent,
  "missed-comorbidity": missedComorbidityAgent,
  "ambiguous-actor": ambiguousActorAgent,
  error: errorAgent,
};

const DEFAULT_MODEL: Record<Provider, string> = {
  openai: "gpt-4o",
  openrouter: "anthropic/claude-3.7-sonnet",
};

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/**
 * De-identification pipeline stage. Replaces each vignette's narrative with a
 * cleaned copy (identifiers redacted) BEFORE it reaches the agent, and reports
 * what was scrubbed. The eval-time PHI probe still runs on the record's own
 * values as defense-in-depth (the output is also re-scanned after the run).
 */
function deidentifyVignettes(vs: Vignette[]): { cleaned: Vignette[]; redacted: number } {
  let redacted = 0;
  const cleaned = vs.map((v) => {
    const { clean, findings } = deidentify(v.narrative);
    redacted += findings.length;
    return { ...v, narrative: clean };
  });
  return { cleaned, redacted };
}

async function writeOut(out: string, data: unknown): Promise<void> {
  const dir = dirname(out);
  if (dir && dir !== ".") await mkdir(dir, { recursive: true });
  await writeFile(out, JSON.stringify(data, null, 2), "utf8");
  console.log(`\nScorecard written to ${out}`);
}

function usage(): void {
  console.log(
    [
      "med-code-eval — reliability, upcoding & PHI-safety evaluation for medical-coding agents",
      "",
      "Usage:",
      "  med-code-eval run [--provider openai|openrouter] [--model <model>]",
      "  med-code-eval run [--strategy grounded|oneshot]  # default: grounded (multi-step)",
      "  med-code-eval run --models <m1,m2,...>      # compare several models",
      "  med-code-eval run --agent buggy:<name>      # no API key needed",
      "  med-code-eval run --deid                    # de-identify notes before the agent",
      "",
      "Keys (set one): OPENAI_API_KEY  or  OPENROUTER_API_KEY",
      "Optional tracing: LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY",
      "",
      `Buggy agents: ${Object.keys(BUGGY).map((n) => `buggy:${n}`).join(", ")}`,
    ].join("\n"),
  );
}

function resolveStrategy(args: string[]): Strategy {
  const flag = getFlag(args, "strategy");
  if (flag === "oneshot") return "oneshot";
  // Default is the real multi-step grounded coder built in agent/coder.ts.
  return "grounded";
}

/** Build the model-backed agent for the chosen strategy. */
function createModelAgent(
  strategy: Strategy,
  opts: { model: string; provider: Provider },
): CodingAgent {
  return strategy === "oneshot" ? createLLMAgent(opts) : createGroundedCoder(opts);
}

function resolveProvider(args: string[]): Provider {
  const flag = getFlag(args, "provider");
  if (flag === "openai" || flag === "openrouter") return flag;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  throw new Error(
    "No API key found. Set OPENAI_API_KEY or OPENROUTER_API_KEY, or use --agent buggy:<name>.",
  );
}

async function evalAgent(
  agent: CodingAgent,
  model: string | undefined,
  suite: Vignette[],
): Promise<Scorecard> {
  console.log(`\nRunning ${suite.length} vignettes against ${agent.name}...`);
  const results = await runVignettes(agent, suite);
  const scorecard = buildScorecard(agent.name, model, results);
  console.log(renderScorecard(scorecard));
  // Defense-in-depth: re-scan every agent rationale for residual identifier
  // shapes (structural, independent of the record values).
  const residual = results.reduce((n, r) => n + scanPhi(r.trace.rationale).length, 0);
  if (residual > 0) {
    console.log(`  ⚠ residual PHI shapes in agent output (post-scan): ${residual}`);
  }
  await sendTraces(agent.name, model, results);
  return scorecard;
}

function renderComparison(cards: Scorecard[]): string {
  const rows = cards
    .map(
      (c) =>
        `  ${(c.model ?? c.agentName).padEnd(32)} ${String(c.reliabilityScore).padStart(3)}/100   ${c.passed}/${c.totalVignettes} passed   PHI leaks: ${c.phiLeakCount}`,
    )
    .join("\n");
  return ["", "=".repeat(64), "Model comparison", "-".repeat(64), rows, "=".repeat(64)].join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "run") {
    usage();
    process.exit(args[0] ? 1 : 0);
  }

  const out = getFlag(args, "out") ?? "scorecard.json";

  // Optional de-identification pipeline stage (opt-in via --deid).
  let suite = vignettes;
  if (hasFlag(args, "deid")) {
    const { cleaned, redacted } = deidentifyVignettes(vignettes);
    suite = cleaned;
    console.log(`[deid] redacted ${redacted} identifier(s) across ${cleaned.length} notes before the agent.`);
  }

  const agentFlag = getFlag(args, "agent");
  if (agentFlag) {
    const name = agentFlag.replace(/^buggy:/, "");
    const agent = BUGGY[name];
    if (!agent) {
      throw new Error(
        `Unknown agent "${agentFlag}". Available: ${Object.keys(BUGGY).map((n) => `buggy:${n}`).join(", ")}`,
      );
    }
    await writeOut(out, await evalAgent(agent, undefined, suite));
    return;
  }

  const provider = resolveProvider(args);
  const strategy = resolveStrategy(args);

  const modelsFlag = getFlag(args, "models");
  if (modelsFlag !== undefined) {
    const models = modelsFlag.split(",").map((m) => m.trim()).filter(Boolean);
    if (models.length === 0) {
      throw new Error('--models is empty; pass e.g. --models "gpt-4o,gpt-4o-mini"');
    }
    const cards: Scorecard[] = [];
    for (const model of models) {
      cards.push(await evalAgent(createModelAgent(strategy, { model, provider }), model, suite));
    }
    console.log(renderComparison(cards));
    await writeOut(out, cards);
    return;
  }

  const model = getFlag(args, "model") ?? DEFAULT_MODEL[provider];
  await writeOut(out, await evalAgent(createModelAgent(strategy, { model, provider }), model, suite));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
