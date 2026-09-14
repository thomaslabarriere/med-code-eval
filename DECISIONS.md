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

## 3. The eval-time PHI probe is layered on purpose, and its limits are explicit (war story)

**Chosen.** `eval/phi.ts` matches on **word boundaries**, matches **individual name tokens** (not just the full record string), **skips name tokens that are ordinary English words**, and adds a **structural SSN detector**. It knows the vignette's own fictitious identifiers and hunts them in the agent's output.

**Rejected:** a raw `haystack.includes(value)` substring scan (the first version).

**Why.** Raw `includes` was both too weak and too strong: too weak because it only knows the record's exact values, so it misses a surname echoed on its own and misses an identifier-shaped token the agent invents; too strong because a patient named "Mark" trips on "remarkable" and "Long" on "belongs". The layered detector fixes both, and `test/phi.test.ts` pins it.

**Relationship to the de-id pipeline (decision 9).** This probe is a value-aware *output* check at eval time; the de-id stage is a shape-aware *pipeline* scrubber. They are deliberately different and defensive-in-depth: the probe knows the record's values, the pipeline detects identifier shapes it has never seen.

## 4. Upcoding is HIERARCHICAL, not a scalar proxy (Phase 1 — this is the one a coder judges first)

**Chosen.** `coding/hierarchy.ts` encodes an illustrative, public subset of ICD-10 (~45 codes, 6 families) as a **specificity tree**: each node points at the less-specific / less-severe parent of the same condition, and carries a severity tier (1→4) and a DRG-style CC/MCC capture. Upcoding is now defined structurally: an assigned code that is a **more specific / more severe same-family descendant** of what the documentation supports (`diff.upcodes`, walked from the tree), *or* a code above the vignette's `severityCeiling`. `failsUpcoding` fires on either.

**Rejected:** the original single global `severityWeight` integer per code with no parent/child structure (the earlier version of this repo). It only exercised the *shape* "assigned a bigger number than allowed".

**Why.** Real upcoding is not a bigger number: it is claiming `E11.65` (with hyperglycemia, a CC) or `E11.621` (with foot ulcer, an MCC) when the note documents only `E11.9` (unspecified). That is a same-family climb in specificity that changes DRG weight. A scalar cannot represent "more specific *within the same condition*", so it could not tell an honest severe code from an unsupported climb. The tree can.

**Honest limit.** The tree and its CC/MCC tiers are **structurally faithful to how ICD-10 + DRG grouping behave, but they are a teaching model, not the official ICD-10 ontology or a CMS grouper.** Plug a real hierarchy and grouper in behind the same interface for real numbers.

## 5. Coding is a SEQUENCED list, and mis-sequencing is its own failure (Phase 1)

**Chosen.** A coding is an **ordered** list: the principal diagnosis first, then secondaries. The diff records `principalAssigned` (the first assigned code). `mis_sequenced` fires when the principal *is* coded but *not* first — a distinct failure from omitting it (`miscode`), because sequencing the principal drives DRG assignment and therefore reimbursement.

**Rejected:** the original unordered-set comparison, where a coding was just a bag of codes.

**Why.** Coding the right diagnoses but sequencing a secondary as principal is a real, money-moving error a set comparison is blind to. Splitting `miscode` (absent principal) from `mis_sequenced` (present but misplaced) keeps the two attributable, both weighted 3.

## 6. The graded agent is a GROUNDED, multi-step coder — and grounding is the anti-HALLUCINATION guard (Phase 2)

**Chosen.** The default model path (`agent/coder.ts`) is not one-shot. It (1) **proposes** candidate codes from the hierarchy, (2) **assigns** final codes each with a cited verbatim **span** of the note, sequenced principal-first, and (3) **verifies** every span against the note (`coding/grounding.ts`), **dropping any code whose citation is not actually in the note** before scoring. Every step runs through the same `ChatClient` seam as the one-shot path, so tests inject a fake client and run fully offline.

**Rejected:** trusting the model to self-report which codes are "supported"; and keeping only the one-shot classifier.

**Why.** This is the insight that transfers to a production coding product: a code with no documentary support in the note is the definition of both upcoding and hallucination, so **make support a structural precondition, not a hope.** The span check is objective (the quoted words are in the note, or they are not) — the same discipline as decision 1, applied to the build side. An unsupported upcode never reaches the codebook comparison because its justification does not exist in the note. The rationale the agent returns is built *without* quoting the note back, so grounding cannot itself become a PHI-leak surface.

**Honest limit.** Span verification proves the quote *exists in the note and names the distinguishing feature* (decision 6b), not that the note *clinically justifies* that specific code — a real coder still owns the semantic judgment. The one-shot path remains available (`--strategy oneshot`) as a disclosed baseline.

## 6b. Grounding is SPECIFICITY-AWARE, so it guards against upcoding too — not only hallucination (war story)

**Chosen.** Grounding now verifies a span in **two layers** (`coding/grounding.ts`): (1) **existence** — the quoted words really occur in the note, matched at **word boundaries** so a generic 4-letter span can no longer match by accident inside a longer word; and (2) **specificity** — a code that is more specific than its parent carries `distinguishingTerms` in the hierarchy (e.g. E11.621 → `foot ulcer`, E11.65 → `hyperglycemia`, N18.30 → `stage 3`), and the **cited span itself must mention one of them**, or the code is dropped with the reason `span_lacks_specificity`. Coding E11.621 while citing only "type 2 diabetes mellitus" now fails, even though that phrase is genuinely in the note.

**Rejected.** (a) The earlier **existence-only** grounding: it verified the span was *present*, which is purely anti-hallucination — a model could upcode E11.9 → E11.621 by citing the note's generic diabetes phrase and sail through, so I had to strip the "anti-upcoding" claim from grounding and lean entirely on the separate hierarchy metric. (b) The lenient normalized-**substring** match (`includes`, `MIN_SPAN_LEN=4`): it matched "pain" inside "explains"/"painless", so a short generic span could ground a code by coincidence. (c) **Downgrading** an over-specific code to its grounded parent instead of dropping it — rejected as too clever: silently rewriting the model's code set hides the error; dropping it surfaces as an honest miss (a *safe* failure) rather than a fabricated correction.

**Why.** "Grounding reduces upcoding" is only TRUE if a generic span cannot buy specificity. Existence alone could not tell an honest specific quote from an unsupported climb dressed in the parent's words — exactly the gap decision 4's hierarchy metric was left to cover alone. Making the distinguishing term a **structural precondition of the citation** closes it on the build side: the upcode is dropped before scoring, for the same reason a hallucinated code is (its justification is not in the quote the model chose).

**Honest limit.** This proves the distinguishing **term** appears in the cited span, not that the surrounding text *clinically* supports the code (a span could name "ulcer" in a negated or historical context). It is lexical specificity grounding, not clinical adjudication — a real coder still owns that judgment. The distinguishing-term lists are an illustrative teaching model over the public subset, not an exhaustive ICD-10 index.

## 7. Security/compliance-weighted score, rates as fired / applicable

`miscode` / `upcoding` / `phi_leak` / `hallucinated_code` / `mis_sequenced` weigh 3, softer failures less (`eval/scorecard.ts`). A metric that only applies to a subset of vignettes is reported over its applicable count, so a total failure never hides behind a big denominator. The single 0-100 number is a trend indicator, not a calibrated metric.

## 8. Mutation proof, with an honest note on the control

**Chosen.** One deliberately-broken fixture per metric (`agent/buggy.ts`) plus a guard test that fails if any metric lacks a fixture, plus a `perfectCoder` control built from the ground truth.

**Honest note.** The control is built **from** the ground truth, so "the correct coding passes every vignette" proves the harness does not false-positive a correct answer, it does **not** prove real-world recall on realistic near-misses. That would need a labelled gold set of real (de-identified) codings.

## 9. De-identification is a PIPELINE STAGE detecting identifier SHAPES (Phase 3)

**Chosen.** `pipeline/deid.ts` cleans the note *before* it reaches the agent and re-scans the agent's output *after*, so an identifier can neither reach the model nor slip out. It detects identifier **shapes** structurally — **11 families** (name, MRN, SSN, date, phone, email, URL, IP, address, account number, age > 89) — with a light, dependency-free name heuristic (two title-cased tokens, a stopword skiplist for clinical bigrams, and title-introduced surnames). No ML model, no network, no heavy NER.

**Rejected:** relying on the eval-time value-aware probe alone (decision 3); and pulling in a heavy NER dependency.

**Why.** The eval probe knows the record's own values; a pipeline that protects real data must catch identifiers it has *never seen*, which means matching shapes, not values. Widening from ~4 to 11 families covers the HIPAA identifiers that are actually detectable in free text.

**Honest limit (read before trusting it on real data).** A regex + heuristic pass is a strong **first line, not a certified Safe-Harbor de-identifier.** Recall on names in arbitrary (especially non-English) prose is inherently imperfect: the name heuristic keys on title-case and an *English* stopword list, so a lowercase name, or a non-English surname that is also a foreign common word, is an accepted false-negative risk. It is a pipeline guard, not a compliance guarantee. Plug a certified de-id service in behind the same stage interface for production.

## 10. Monitoring is pure functions over a SERIES of runs, and one signal is an admitted proxy (Phase 4)

**Chosen.** `monitor/drift.ts` projects each Scorecard to a small `RunSummary` (`summarizeScorecard`, using the objective assigned codes, never prose) and runs three pure detectors over an ordered series: **code-distribution drift** (total-variation distance of the current run's code mix vs the baseline mean), **upcoding-rate increase** (absolute rise vs the baseline mean), and a coarse **confidence-calibration gap**. Each emits a structured `Alert` (type, severity, detail, value, threshold) with warn/critical tiers, or nothing. A stable series, a single run, and an empty series all produce zero alerts.

**Rejected:** a stateful dashboard, or per-run pass/fail thresholds with no baseline (which fire on the first bad run without evidence of *change*).

**Why.** Monitoring is the third leg of build → evaluate → **monitor**. The failures that matter in production are *regressions* — the code mix collapsing onto severe codes, upcoding creeping up — so the detectors compare a run against its own history, not an absolute bar. TVD is the right coarse "did the mix move" statistic: symmetric, bounded 0..1, no smoothing needed.

**Honest limit — the calibration signal is a proxy.** There is no independent model-reported confidence in this harness, so "calibration" compares the harness's own weighted **reliability score** against the realized **pass rate** and flags when the score materially *overstates* the pass rate (over-confidence). That is a genuine decoupling signal, but it is not true probability calibration (no per-prediction confidence, no reliability diagram). It is labelled as coarse in the code and the alert text. What monitoring here does **not** catch: a *slow* drift that never crosses a single-step threshold, and any regression on an axis the scorecard does not already measure.

---

## What this harness does NOT prove

- **The numbers are on a synthetic gold set:** 10 vignettes over a ~45-code public ICD-10 subset. No statistical power; they exercise the failure taxonomy, they are not a benchmark.
- **The hierarchy is a faithful teaching model, not the official ICD-10 ontology or a CMS grouper** (decision 4). The parent/child edges and CC/MCC tiers behave correctly; they are not the real code set.
- **Span grounding proves a citation exists AND names the distinguishing term, not that it clinically justifies the code** (decisions 6, 6b). It guards hallucination and upcoding-by-generic-span; the clinical/semantic judgment (negation, history, laterality) still belongs to a real coder.
- **De-identification covers 11 identifier shapes with an English name heuristic** (decision 9). It is a strong pipeline first line, not a certified Safe-Harbor de-id layer.
- **The control test is semi-circular** (decision 8): it proves no false positive on a correct coding, not recall on realistic errors.
- **The calibration monitor is a proxy** (decision 10): reliability-score-vs-pass-rate, not true probability calibration; slow sub-threshold drift is missed.
- **No real patient data, no proprietary code sets (no CPT), no clinical authority.** Plug in your own de-identified coded records, a real code hierarchy + grouper, and a certified de-id service behind these same interfaces to get real numbers.

The value is the instrument, the failure taxonomy, the grounded agent, and the choices above, not the synthetic content. If you are evaluating this: pick any decision and ask me why, and where it would still lie to me. Those answers are the part that is mine.
