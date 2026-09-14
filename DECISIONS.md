# Design decisions

The code here was produced by orchestrating coding agents. This document is the part that was not: the choices, the alternatives I rejected, and the war stories where an early version was wrong and I hardened it after reading why. If you are evaluating this repo, this is where the judgment lives, not in the fact that the TypeScript compiles.

Each entry: what I chose, what I rejected, why. The last section is what this harness deliberately does **not** prove, stated so no reader assumes more than the evidence supports.

---

## 1. The verdict comes from the assigned codes, never the model's rationale

**Chosen.** A vignette's verdict is built in `coding/compare.ts` from the codes the model assigned versus the ground-truth codes, plus a scan of the output for patient identifiers (`eval/phi.ts`). The metric predicates in `eval/metrics.ts` read that comparison, not the prose.

**Rejected:** scoring the model's written justification.

**Why.** In medical coding the dangerous failure is a confident, well-written rationale attached to the wrong code. The rationale is the least trustworthy artifact. So the truth is the code set the model actually returned, which it cannot talk its way around.

## 2. `acted_on_ambiguous` is behavioural, not a text scan (war story)

**Chosen.** On an under-specified vignette, the correct action is to flag/refuse, not to code confidently. `failsActedOnAmbiguous` checks a behaviour: *did the model assign a code anyway?*

**Rejected:** an earlier version scanned the rationale for uncertainty words ("unclear", "insufficient", ...).

**Why.** That was trivially fooled: an agent echoes the note's hedging language and passes while still assigning a code. Reading the prose to judge whether the agent "was careful" rewards narration, not restraint. This is the same lesson as decision 1, learned the hard way on one metric.

## 3. The PHI detector is layered on purpose, and its limits are explicit (war story)

**Chosen.** `eval/phi.ts` matches on **word boundaries**, matches **individual name tokens** (not just the full record string), **skips name tokens that are ordinary English words**, and adds a **structural SSN detector**.

**Rejected:** a raw `haystack.includes(value)` substring scan (the first version).

**Why.** Raw `includes` was both too weak and too strong: too weak because it only knows the record's exact values, so it misses a surname echoed on its own and misses an identifier-shaped token the agent invents; too strong because a patient named "Mark" trips on "remarkable" and "Long" on "belongs". The layered detector fixes both, and `test/phi.test.ts` pins it (a lone surname and an SSN-shaped token are caught; "Mark"/"Long" inside ordinary words are not).

**Honest limits (read this before trusting it on real data).** This detector covers roughly **4 of the 18 HIPAA identifiers** (name, MRN, SSN-shaped, DOB as written in the record). SSN is only the `ddd-dd-dddd` shape; a 9-digit run is missed. DOB matches only the record's exact spelling. The common-word skiplist is **English**, while real patient names are often not, so a non-English surname that is also a foreign common word is an accepted false-negative risk. A production system needs a proper de-identification / NER layer; this is a failure-mode instrument, not a de-id tool.

## 4. Upcoding is a scalar `severityWeight` proxy, and I say so loudly

**Chosen.** Each codebook entry carries an illustrative `severityWeight` (1 mild → 3 severe, `coding/codebook.ts`); `failsUpcoding` flags an assigned code whose weight exceeds the vignette's `severityCeiling`.

**Rejected:** pretending this is real upcoding detection.

**Why + limit.** Real upcoding is **hierarchical**: CC/MCC capture, principal-vs-secondary sequencing, DRG impact, a more specific code than the documentation justifies. A single global integer per code is a coarse proxy that only exercises the *shape* of the failure ("assigned a more severe code than the case supports"). `severityCeiling` is currently set on **one** vignette, so the `upcoding` metric is applicable there and reported as `-` elsewhere (fired/applicable, never diluted). To measure real upcoding you need a code hierarchy and sequencing model plugged in behind the same interface. This is the single place a medical coder will see the proxy fastest, and I would rather name it than hide it.

## 5. Codes are compared as an unordered set

**Chosen.** `compareCoding` treats the assigned codes as a set (missed / extra / wrong / hallucinated).

**Limit.** Principal-vs-secondary **sequencing** changes reimbursement and is not modelled. Known gap; it is the natural next axis after a code hierarchy.

## 6. Security/compliance-weighted score, rates as fired / applicable

`miscode` / `upcoding` / `phi_leak` / `hallucinated_code` weigh 3, softer failures less (`eval/scorecard.ts`). A metric that only applies to a subset of vignettes is reported over its applicable count, so a total failure never hides behind a big denominator. The single 0-100 number is a trend indicator, not a calibrated metric.

## 7. Mutation proof, with an honest note on the control

**Chosen.** One deliberately-broken fixture per metric (`agent/buggy.ts`) plus a guard test that fails if any metric lacks a fixture, plus a `perfectCoder` control built from the ground truth.

**Honest note.** The control is built **from** the ground truth, so "the correct coding passes every vignette" proves the harness does not false-positive a correct answer, it does **not** prove real-world recall on realistic near-misses. That would need a labelled gold set of real (de-identified) codings.

## 8. The graded path is one call, and the README says so

The real-model path is a single `chat.completions.create` with one `assign_codes` tool (`agent/runAgent.ts`), no planning loop. It is a one-shot classifier, disclosed as such.

---

## What this harness does NOT prove

- **The numbers are on a synthetic gold set:** 8 vignettes over a ~19-code public ICD-10 subset. No statistical power; they exercise the failure taxonomy, they are not a benchmark.
- **Upcoding is a scalar proxy** (decision 4), not hierarchical; and **sequencing is not modelled** (decision 5). A real coder will spot both.
- **PHI detection covers ~4 of 18 HIPAA identifiers** with an English skiplist (decision 3). It is a failure-mode probe, not a de-identification layer.
- **The control test is semi-circular** (decision 7): it proves no false positive on a correct coding, not recall on realistic errors.
- **No real patient data, no proprietary code sets (no CPT), no clinical authority.** Plug in your own de-identified coded records, a real code hierarchy, and a sequencing model to get real numbers.

The value is the instrument, the failure taxonomy, and the choices above, not the synthetic content. If you are evaluating this: pick any decision and ask me why, and where it would still lie to me. Those answers are the part that is mine.
