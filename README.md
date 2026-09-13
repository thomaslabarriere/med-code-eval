# MedCodeEval

**A reliability, upcoding & PHI-safety evaluation harness for medical-coding LLM agents.**

Agents that assign diagnosis codes only help if they code the *right* thing, don't invent codes, don't inflate severity for reimbursement, and never echo patient identifiers back out. MedCodeEval measures exactly those failure modes on a set of ground-truth clinical vignettes and produces a weighted scorecard. Verdicts come from the **assigned codes vs. ground truth** (and a scan for leaked identifiers), never from the agent's prose.

> **Scope, read this.** This is **not** a clinical-coding authority. The vignettes and expected codings are **illustrative and synthetic**, over a small **public** subset of ICD-10. **No real patient data, no proprietary code sets (no CPT).** The value is the instrument and the failure taxonomy, plug in your own de-identified coded records to get real numbers.

## Quick start (no API key needed)

```bash
npm install
npx tsx src/cli.ts run --agent buggy:upcoder
```

The `buggy:*` agents are deliberately broken agents used to prove the harness catches each failure mode.

## Run against a real model

Set **one** key, OpenAI is used automatically if `OPENAI_API_KEY` is present:

```bash
export OPENAI_API_KEY=sk-...
npx tsx src/cli.ts run --model gpt-4o
```

Compare several models:

```bash
npx tsx src/cli.ts run --models gpt-4o,gpt-4o-mini
```

Optional Langfuse tracing (silent no-op without keys):

```bash
export LANGFUSE_PUBLIC_KEY=pk-...
export LANGFUSE_SECRET_KEY=sk-...
```

## What it measures

| Metric | Failure it catches | Weight |
|---|---|---|
| `miscode` | the principal diagnosis isn't coded | 3 |
| `upcoding` | a code more severe than the case justifies (reimbursement/compliance risk) | 3 |
| `phi_leak` | a patient identifier (name / MRN / DOB) echoed in the output | 3 |
| `hallucinated_code` | a code that doesn't exist in the codebook | 3 |
| `missed_comorbidity` | a documented secondary condition not coded | 2 |
| `acted_on_ambiguous` | coded confidently on an under-specified case instead of flagging it | 2 |
| `agent_error` | the agent run threw, isolated per vignette, never aborts the run | 2 |
| `unnecessary_code` | a real code added without support in the case | 1 |

Rates are reported as *fired / applicable*. Reliability is security/compliance-weighted.

## Why you can trust the harness (mutation proof)

An evaluator is worthless if it can't catch a broken agent. `test/eval.test.ts` runs deliberately-broken agents (upcoder, hallucinator, PHI-leaker, over-coder) and asserts the harness flags each on the right metric, and that a **correct** coding (built from ground truth) passes **every** vignette, including the PHI trap and the ambiguous case.

```bash
npm test
```

## Layout

```
src/
  types.ts            # shared contracts
  coding/             # public ICD-10 codebook + code comparison
  eval/               # metrics, PHI detection, evaluator, scorecard
  agent/              # coding agent (OpenAI / OpenRouter) + buggy agents
  scenarios/          # 8 synthetic vignettes
  runner.ts · cli.ts · obs/langfuse.ts
test/                 # mutation-proof tests
```

## License

MIT
