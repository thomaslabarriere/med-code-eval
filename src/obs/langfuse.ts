import type { VignetteResult } from "../types.js";

/**
 * Optional Langfuse tracing for LLM observability.
 *
 * Fully opt-in: if LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set, this
 * is a no-op. The `langfuse` package is imported lazily and everything is
 * wrapped so that observability can NEVER break an eval run.
 */
export async function sendTraces(
  agentName: string,
  model: string | undefined,
  results: VignetteResult[],
): Promise<void> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return;

  try {
    const mod = (await import("langfuse")) as unknown as {
      Langfuse: new (opts: {
        publicKey: string;
        secretKey: string;
        baseUrl?: string;
      }) => LangfuseLike;
    };
    const client = new mod.Langfuse({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_BASEURL,
    });

    for (const r of results) {
      const trace = client.trace({
        name: `med-code-eval:${r.vignetteId}`,
        input: r.trace.narrative,
        output: { codes: r.trace.codes, rationale: r.trace.rationale },
        metadata: {
          agent: agentName,
          model: model ?? null,
          title: r.title,
          diff: r.trace.diff,
          failures: r.failures,
          phiLeaks: r.phiLeaks,
        },
        tags: ["med-code-eval", ...r.failures],
      });
      trace.score({ name: "passed", value: r.passed ? 1 : 0 });
    }

    await client.flushAsync();
    console.log(`[langfuse] sent ${results.length} traces`);
  } catch (err) {
    console.warn(
      `[langfuse] tracing skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface LangfuseLike {
  trace(opts: {
    name: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    tags?: string[];
  }): { score(opts: { name: string; value: number }): void };
  flushAsync(): Promise<unknown>;
}
