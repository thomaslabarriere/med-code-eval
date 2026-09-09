#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodingAgent, Scorecard } from "./types.js";
import { vignettes } from "./scenarios/vignettes.js";
import { runVignettes } from "./runner.js";
import { buildScorecard, renderScorecard } from "./eval/scorecard.js";
import { createLLMAgent } from "./agent/runAgent.js";
import type { Provider } from "./agent/runAgent.js";
import { sendTraces } from "./obs/langfuse.js";
import {
  upcoderAgent,
  hallucinatorAgent,
  phiLeakerAgent,
  overCoderAgent,
} from "./agent/buggy.js";

const BUGGY: Record<string, CodingAgent> = {
  upcoder: upcoderAgent,
  hallucinator: hallucinatorAgent,
  "phi-leaker": phiLeakerAgent,
  "over-coder": overCoderAgent,
};

const DEFAULT_MODEL: Record<Provider, string> = {
  openai: "gpt-4o",
  openrouter: "anthropic/claude-3.7-sonnet",
};

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
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
      "  med-code-eval run --models <m1,m2,...>      # compare several models",
      "  med-code-eval run --agent buggy:<name>      # no API key needed",
      "",
      "Keys (set one): OPENAI_API_KEY  or  OPENROUTER_API_KEY",
      "Optional tracing: LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY",
      "",
      `Buggy agents: ${Object.keys(BUGGY).map((n) => `buggy:${n}`).join(", ")}`,
    ].join("\n"),
  );
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
): Promise<Scorecard> {
  console.log(`\nRunning ${vignettes.length} vignettes against ${agent.name}...`);
  const results = await runVignettes(agent, vignettes);
  const scorecard = buildScorecard(agent.name, model, results);
  console.log(renderScorecard(scorecard));
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

  const agentFlag = getFlag(args, "agent");
  if (agentFlag) {
    const name = agentFlag.replace(/^buggy:/, "");
    const agent = BUGGY[name];
    if (!agent) {
      throw new Error(
        `Unknown agent "${agentFlag}". Available: ${Object.keys(BUGGY).map((n) => `buggy:${n}`).join(", ")}`,
      );
    }
    await writeOut(out, await evalAgent(agent, undefined));
    return;
  }

  const provider = resolveProvider(args);

  const modelsFlag = getFlag(args, "models");
  if (modelsFlag !== undefined) {
    const models = modelsFlag.split(",").map((m) => m.trim()).filter(Boolean);
    if (models.length === 0) {
      throw new Error('--models is empty; pass e.g. --models "gpt-4o,gpt-4o-mini"');
    }
    const cards: Scorecard[] = [];
    for (const model of models) {
      cards.push(await evalAgent(createLLMAgent({ model, provider }), model));
    }
    console.log(renderComparison(cards));
    await writeOut(out, cards);
    return;
  }

  const model = getFlag(args, "model") ?? DEFAULT_MODEL[provider];
  await writeOut(out, await evalAgent(createLLMAgent({ model, provider }), model));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
