// ============================================================================
// MedCodeEval — codebook facade.
//
// The domain model now lives in `hierarchy.ts` (a real ICD-10 specificity tree
// with severity tiers and CC/MCC capture). This module keeps the flat-codebook
// surface the rest of the harness was built against, deriving every entry from
// the hierarchy so there is a SINGLE source of truth for the code set.
// ============================================================================

import type { Codebook, CodebookEntry, ICDCode } from "../types.js";
import {
  ALL_CODES,
  hierarchy,
  isKnownCode as isKnownInHierarchy,
  normalizeCode,
  renderHierarchyForPrompt,
  severityOf as severityInHierarchy,
} from "./hierarchy.js";

export { normalizeCode };

/** The flat codebook, derived from the hierarchy (same code set, enriched). */
export const codebook: Codebook = Object.fromEntries(
  ALL_CODES.map((code): [ICDCode, CodebookEntry] => {
    const n = hierarchy[code];
    if (!n) throw new Error(`hierarchy is missing declared code ${code}`);
    return [
      code,
      {
        code: n.code,
        label: n.label,
        parent: n.parent,
        severityWeight: n.severityWeight,
        complication: n.complication,
      },
    ];
  }),
);

/** True if the code exists in the codebook (after normalization). */
export function isKnownCode(code: string): boolean {
  return isKnownInHierarchy(code);
}

/** severityWeight of a code, or 0 if unknown (hallucinated codes carry no weight). */
export function severityOf(code: string): number {
  return severityInHierarchy(code);
}

/** A compact, LLM-friendly listing of the allowed codebook for the agent prompt. */
export function renderCodebookForPrompt(): string {
  return renderHierarchyForPrompt();
}
