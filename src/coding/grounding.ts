// ============================================================================
// MedCodeEval — documentary grounding: SPECIFICITY-AWARE.
//
// THE core anti-upcoding / anti-hallucination guard. Every assigned code must
// cite a verbatim SPAN of the clinical note that supports it. This module
// verifies OBJECTIVELY, in two layers, that the cited span justifies the code —
// the model cannot talk its way past it, exactly as the coding verdict never
// trusts the model's prose (DECISIONS.md #1):
//
//   (1) EXISTENCE (anti-hallucination) — the quoted words must really occur in
//       the note. A code whose span is absent (invented, paraphrased away, or
//       lifted from another case) is UNSUPPORTED. Matching is word-boundary, so
//       a generic 4-letter span can no longer match by accident inside a larger
//       word ("pain" no longer matches inside "explains"/"painless").
//
//   (2) SPECIFICITY (anti-upcoding) — for a code that is MORE SPECIFIC than its
//       parent (it carries `distinguishingTerms` in the hierarchy), the cited
//       span must itself mention one of those distinguishing terms. Citing only
//       the generic parent phrase ("type 2 diabetes mellitus") to justify a
//       specific child (E11.621, "foot ulcer") is rejected: a generic span can
//       no longer buy specificity. This is what makes "grounding reduces
//       upcoding" TRUE, not just "grounding reduces hallucination".
//
// Matching is deliberately lenient on FORM (whitespace, case, surrounding
// punctuation) and strict on SUBSTANCE (the quoted words must really be there,
// AND they must include the distinguishing feature), so an honest specific
// quote is accepted and an upcode-by-generic-span is not.
//
// HONEST LIMIT (unchanged): this proves the distinguishing TERM is present in
// the cited span, not that the note CLINICALLY justifies that exact code — the
// semantic judgment still belongs to a real coder (DECISIONS.md #6).
// ============================================================================

import type { ICDCode } from "../types.js";
import { nodeOf } from "./hierarchy.js";

/** A code the agent proposed together with the note span it cites as support. */
export interface GroundedCode {
  code: ICDCode;
  /** Verbatim quote from the note the agent claims justifies `code`. */
  span: string;
}

/** The verified verdict for one proposed (code, span) pair. */
export interface GroundingResult {
  code: ICDCode;
  span: string;
  /**
   * True iff the cited span both OCCURS in the note (word-boundary) AND, for a
   * code more specific than its parent, carries one of the code's distinguishing
   * terms.
   */
  supported: boolean;
  /**
   * Why it was rejected, when unsupported (for the report / rationale).
   * `span_lacks_specificity` is the anti-upcoding reason: the span exists in the
   * note but names only the generic parent condition, not the feature that
   * justifies this more-specific/severe code.
   */
  reason?: "empty_span" | "too_short" | "not_in_note" | "span_lacks_specificity";
}

/** Shortest span we accept — a 1-2 char quote would match almost any note. */
const MIN_SPAN_LEN = 4;

/**
 * Normalize text for span matching: l-case, collapse all whitespace runs to a
 * single space, and trim. This tolerates reflowed line breaks and spacing
 * differences between the note and the quote without tolerating invented words.
 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Escape a string for safe literal use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary containment: is `needle` present in `haystack` as whole words,
 * not merely as characters inside a larger word? Both are assumed normalized.
 * The lookarounds require the character adjacent to the match to NOT be a word
 * character, so "pain" is found in "chest pain" but NOT inside "explains" or
 * "painless" (the old `includes` substring bug). Phrases and digit tokens
 * ("foot ulcer", "stage 3") are matched as-is.
 */
export function containsTerm(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(needle)}(?![A-Za-z0-9])`);
  return re.test(haystack);
}

/**
 * Verify one (code, span) against the note, in two layers:
 *   (1) existence — the normalized span occurs in the note at WORD BOUNDARIES;
 *   (2) specificity — if the code is more specific than its parent (it carries
 *       `distinguishingTerms`), the span must mention one of those terms.
 * A span that exists but names only the generic parent condition is rejected as
 * `span_lacks_specificity` — the anti-upcoding guard.
 */
export function verifyOne(note: string, item: GroundedCode): GroundingResult {
  const rawSpan = item.span ?? "";
  const span = normalizeForMatch(rawSpan);
  if (span.length === 0) {
    return { code: item.code, span: rawSpan, supported: false, reason: "empty_span" };
  }
  if (span.length < MIN_SPAN_LEN) {
    return { code: item.code, span: rawSpan, supported: false, reason: "too_short" };
  }
  if (!containsTerm(normalizeForMatch(note), span)) {
    return { code: item.code, span: rawSpan, supported: false, reason: "not_in_note" };
  }
  // Layer 2 — specificity. A code more specific than its parent must have its
  // distinguishing feature named IN THE CITED SPAN, not merely somewhere in the
  // note: the quote the model chose to justify THIS code cannot be the generic
  // parent phrase. Root / leaf-without-refinement codes carry no terms and skip
  // this layer (they have no extra specificity to prove).
  const terms = nodeOf(item.code)?.distinguishingTerms ?? [];
  if (terms.length > 0) {
    const grounded = terms.some((t) => containsTerm(span, normalizeForMatch(t)));
    if (!grounded) {
      return { code: item.code, span: rawSpan, supported: false, reason: "span_lacks_specificity" };
    }
  }
  return { code: item.code, span: rawSpan, supported: true };
}

/** Verify every proposed (code, span) pair against the note, preserving order. */
export function verifyGrounding(
  note: string,
  items: GroundedCode[],
): GroundingResult[] {
  return items.map((item) => verifyOne(note, item));
}

/**
 * Keep only the codes whose citation is supported by the note, PRESERVING the
 * proposed sequence (principal first). This is the rejection step: an
 * unsupported upcode is dropped here and never reaches scoring.
 */
export function retainSupported(results: GroundingResult[]): ICDCode[] {
  return results.filter((r) => r.supported).map((r) => r.code);
}
