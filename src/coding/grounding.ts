// ============================================================================
// MedCodeEval — documentary grounding.
//
// THE core anti-upcoding / anti-hallucination guard. Every assigned code must
// cite a verbatim SPAN of the clinical note that supports it. This module
// verifies OBJECTIVELY that the cited span actually occurs in the note — the
// model cannot talk its way past it, exactly as the coding verdict never trusts
// the model's prose (DECISIONS.md #1). A code whose span is absent (invented,
// paraphrased away, or lifted from another case) is UNSUPPORTED and is rejected
// before it can ever be scored: an upcode with no documentary basis never
// reaches the codebook comparison, because the note does not contain its
// justification.
//
// Matching is deliberately lenient on FORM (whitespace, case, surrounding
// punctuation) and strict on SUBSTANCE (the quoted words must really be there),
// so an honest quote is accepted and a fabricated one is not.
// ============================================================================

import type { ICDCode } from "../types.js";

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
  /** True iff the (normalized) span really occurs in the (normalized) note. */
  supported: boolean;
  /** Why it was rejected, when unsupported (for the report / rationale). */
  reason?: "empty_span" | "too_short" | "not_in_note";
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

/**
 * Verify one (code, span) against the note. A span is supported only if, after
 * whitespace/case normalization, it is a non-trivial substring of the note.
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
  const supported = normalizeForMatch(note).includes(span);
  return {
    code: item.code,
    span: rawSpan,
    supported,
    ...(supported ? {} : { reason: "not_in_note" as const }),
  };
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
