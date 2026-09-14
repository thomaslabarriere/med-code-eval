import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import type { ChatCompletionsClient } from "../src/agent/runAgent.js";
import {
  createGroundedCoder,
  parseAssignments,
  parseCandidates,
} from "../src/agent/coder.js";
import {
  normalizeForMatch,
  retainSupported,
  verifyGrounding,
} from "../src/coding/grounding.js";
import { runVignette } from "../src/runner.js";
import { vignettes } from "../src/scenarios/vignettes.js";
import type { Vignette } from "../src/types.js";

function vignette(id: string): Vignette {
  const v = vignettes.find((x) => x.id === id);
  if (!v) throw new Error(`vignette ${id} not found`);
  return v;
}

// ---------------------------------------------------------------------------
// Grounding verifier — the objective anti-upcoding / anti-hallucination guard.
// ---------------------------------------------------------------------------
describe("grounding — objective span verification", () => {
  const note = "Seen for type 2 diabetes mellitus, well controlled.";

  it("supports a verbatim quote, tolerant of case and whitespace", () => {
    const [r] = verifyGrounding(note, [
      { code: "E11.9", span: "Type 2   Diabetes\nMellitus" },
    ]);
    expect(r?.supported).toBe(true);
  });

  it("rejects a span that is not in the note (fabricated citation)", () => {
    const [r] = verifyGrounding(note, [
      { code: "J15.212", span: "methicillin resistant staphylococcus aureus" },
    ]);
    expect(r?.supported).toBe(false);
    expect(r?.reason).toBe("not_in_note");
  });

  it("rejects an empty or trivially short span", () => {
    expect(verifyGrounding(note, [{ code: "E11.9", span: "" }])[0]?.reason).toBe("empty_span");
    expect(verifyGrounding(note, [{ code: "E11.9", span: "a" }])[0]?.reason).toBe("too_short");
  });

  it("retains only supported codes, preserving order", () => {
    const results = verifyGrounding(note, [
      { code: "E11.9", span: "type 2 diabetes mellitus" },
      { code: "J15.212", span: "sepsis with septic shock" },
    ]);
    expect(retainSupported(results)).toEqual(["E11.9"]);
  });

  it("normalizeForMatch collapses whitespace and lowercases", () => {
    expect(normalizeForMatch("  Foo\t Bar\n")).toBe("foo bar");
  });
});

// ---------------------------------------------------------------------------
// Pure parsers — never coerce garbage into a valid structure.
// ---------------------------------------------------------------------------
describe("coder parsers", () => {
  it("parses candidates and rejects non-string arrays", () => {
    expect(parseCandidates("propose_candidates", JSON.stringify({ candidates: ["E11.9"] }))).toEqual(["E11.9"]);
    expect(parseCandidates("propose_candidates", JSON.stringify({ candidates: [1] }))).toBeNull();
    expect(parseCandidates("wrong_name", "{}")).toBeNull();
  });

  it("parses assignments and rejects malformed entries", () => {
    expect(
      parseAssignments(
        "assign_grounded",
        JSON.stringify({ assignments: [{ code: "E11.9", span: "diabetes" }] }),
      ),
    ).toEqual([{ code: "E11.9", span: "diabetes" }]);
    expect(parseAssignments("assign_grounded", JSON.stringify({ assignments: [{ code: "E11.9" }] }))).toBeNull();
    expect(parseAssignments("assign_grounded", "{ bad json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The multi-step agent, driven OFFLINE via a scripted fake client. Each call to
// create() dequeues the next scripted completion, so the two-step flow (propose
// → ground+sequence) can be exercised with zero API credits.
// ---------------------------------------------------------------------------
function toolCall(name: string, args: unknown): OpenAI.Chat.Completions.ChatCompletionMessageToolCall {
  return {
    id: `call_${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  } as OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
}

function queueClient(
  scripted: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[][],
): ChatCompletionsClient {
  const queue = [...scripted];
  return {
    chat: {
      completions: {
        create: async () => {
          const toolCalls = queue.shift() ?? [];
          return {
            choices: [{ message: { role: "assistant", content: null, tool_calls: toolCalls } }],
          } as unknown as OpenAI.Chat.Completions.ChatCompletion;
        },
      },
    },
  };
}

describe("grounded coder — offline via injected client", () => {
  it("a well-grounded coder codes the principal and passes the vignette", async () => {
    const agent = createGroundedCoder({
      model: "fake",
      client: queueClient([
        [toolCall("propose_candidates", { candidates: ["E11.9"] })],
        [
          toolCall("assign_grounded", {
            assignments: [{ code: "E11.9", span: "type 2 diabetes mellitus" }],
          }),
        ],
      ]),
    });
    const r = await runVignette(agent, vignette("simple-diabetes"));
    expect(r.trace.codes).toEqual(["E11.9"]);
    expect(r.passed).toBe(true);
  });

  it("an upcoder that cites an absent span has the upcode REJECTED by grounding", async () => {
    // The note (uncomplicated pneumonia) documents J18.9 only. The agent tries
    // to upcode to J15.212 (MRSA) but its citation is not in the note, so
    // grounding drops it before scoring — the upcode never reaches the codebook.
    const agent = createGroundedCoder({
      model: "fake",
      client: queueClient([
        [toolCall("propose_candidates", { candidates: ["J18.9", "J15.212"] })],
        [
          toolCall("assign_grounded", {
            assignments: [
              { code: "J18.9", span: "community-acquired pneumonia" },
              { code: "J15.212", span: "methicillin resistant staphylococcus aureus" },
            ],
          }),
        ],
      ]),
    });
    const r = await runVignette(agent, vignette("no-upcode-pneumonia"));
    // The fabricated upcode is gone; only the grounded principal survives.
    expect(r.trace.codes).toEqual(["J18.9"]);
    expect(r.failures).not.toContain("upcoding");
    expect(r.passed).toBe(true);
  });

  it("declines (no codes) when nothing can be grounded", async () => {
    const agent = createGroundedCoder({
      model: "fake",
      client: queueClient([
        [toolCall("propose_candidates", { candidates: ["R07.9"] })],
        [
          toolCall("assign_grounded", {
            assignments: [{ code: "R07.9", span: "acute myocardial infarction with ST elevation" }],
          }),
        ],
      ]),
    });
    const r = await runVignette(agent, vignette("ambiguous-case"));
    expect(r.trace.codes).toEqual([]);
    // Declining on an under-specified case is the correct behaviour.
    expect(r.failures).not.toContain("acted_on_ambiguous");
    expect(r.passed).toBe(true);
  });
});
