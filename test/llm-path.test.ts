import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { parseCodingCall } from "../src/agent/tools.js";
import { createLLMAgent } from "../src/agent/runAgent.js";
import type { ChatCompletionsClient } from "../src/agent/runAgent.js";
import { runVignette } from "../src/runner.js";
import { vignettes } from "../src/scenarios/vignettes.js";

// ---------------------------------------------------------------------------
// Pure parser: exercised on VALID and MALFORMED tool-call payloads. No network,
// no API key. parseCodingCall must never coerce garbage into a valid coding.
// ---------------------------------------------------------------------------
describe("parseCodingCall — pure tool-call parser", () => {
  it("parses a valid assign_codes payload", () => {
    const out = parseCodingCall(
      "assign_codes",
      JSON.stringify({ codes: ["E11.9", "I10"], rationale: "coded the case" }),
    );
    expect(out).toEqual({ codes: ["E11.9", "I10"], rationale: "coded the case" });
  });

  it("returns null on malformed JSON", () => {
    expect(parseCodingCall("assign_codes", "{ not: valid json ")).toBeNull();
  });

  it("returns null on the wrong tool name", () => {
    expect(
      parseCodingCall("something_else", JSON.stringify({ codes: [], rationale: "x" })),
    ).toBeNull();
  });

  it("returns null when codes is not a string array", () => {
    expect(
      parseCodingCall("assign_codes", JSON.stringify({ codes: [1, 2], rationale: "x" })),
    ).toBeNull();
    expect(
      parseCodingCall("assign_codes", JSON.stringify({ codes: "E11.9", rationale: "x" })),
    ).toBeNull();
  });

  it("returns null when rationale is missing or non-string", () => {
    expect(parseCodingCall("assign_codes", JSON.stringify({ codes: [] }))).toBeNull();
    expect(
      parseCodingCall("assign_codes", JSON.stringify({ codes: [], rationale: 5 })),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Client seam: an injected fake stands in for OpenAI so the LLM path runs with
// zero credits. Proves (a) a well-formed tool call is wired through the parser,
// and (b) a throwing client degrades safely — agent_error, never a fabricated
// valid code.
// ---------------------------------------------------------------------------
function fakeClientReturning(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
  content: string | null = null,
): ChatCompletionsClient {
  const completion = {
    choices: [{ message: { role: "assistant", content, tool_calls: toolCalls } }],
  } as unknown as OpenAI.Chat.Completions.ChatCompletion;
  return { chat: { completions: { create: async () => completion } } };
}

const throwingClient: ChatCompletionsClient = {
  chat: {
    completions: {
      create: async () => {
        throw new Error("network down / no credits");
      },
    },
  },
};

describe("createLLMAgent — injected client seam (offline)", () => {
  it("wires a valid tool call through the parser", async () => {
    const agent = createLLMAgent({
      model: "test-model",
      client: fakeClientReturning([
        {
          id: "call_1",
          type: "function",
          function: {
            name: "assign_codes",
            arguments: JSON.stringify({ codes: ["E11.9"], rationale: "ok" }),
          },
        },
      ]),
    });
    const out = await agent.run({ narrative: "..." });
    expect(out).toEqual({ codes: ["E11.9"], rationale: "ok" });
  });

  it("returns an empty coding (no fabrication) when no tool call is made", async () => {
    const agent = createLLMAgent({
      model: "test-model",
      client: fakeClientReturning(undefined, "I refuse to code."),
    });
    const out = await agent.run({ narrative: "..." });
    expect(out.codes).toEqual([]);
  });

  it("fails open: a throwing client yields agent_error, never a fake code", async () => {
    const agent = createLLMAgent({ model: "test-model", client: throwingClient });
    const first = vignettes[0];
    if (!first) throw new Error("no vignettes");
    const r = await runVignette(agent, first);
    expect(r.failures).toEqual(["agent_error"]);
    expect(r.trace.codes).toEqual([]);
    expect(r.passed).toBe(false);
  });
});
