import type { Codebook, ICDCode } from "../types.js";

/** Normalize a code for comparison (trim + uppercase). */
export function normalizeCode(code: string): ICDCode {
  return code.trim().toUpperCase();
}

/**
 * A small, illustrative subset of the PUBLIC ICD-10 diagnosis classification.
 * severityWeight (1 mild → 3 severe) is an illustrative proxy used only to
 * detect upcoding; it is NOT a clinical or billing value. Mild/severe variants
 * of the same condition are included on purpose so upcoding can be measured.
 */
const ENTRIES: ReadonlyArray<{ code: ICDCode; label: string; severityWeight: number }> = [
  // Diabetes (mild → severe)
  { code: "E11.9", label: "Type 2 diabetes mellitus without complications", severityWeight: 1 },
  { code: "E11.65", label: "Type 2 diabetes mellitus with hyperglycemia", severityWeight: 2 },
  { code: "E11.22", label: "Type 2 diabetes with diabetic chronic kidney disease", severityWeight: 3 },
  { code: "Z79.4", label: "Long term (current) use of insulin", severityWeight: 1 },
  // Hypertension / cardiac
  { code: "I10", label: "Essential (primary) hypertension", severityWeight: 1 },
  { code: "I50.9", label: "Heart failure, unspecified", severityWeight: 2 },
  { code: "I50.21", label: "Acute systolic (congestive) heart failure", severityWeight: 3 },
  // Respiratory (mild → severe)
  { code: "J18.9", label: "Pneumonia, unspecified organism", severityWeight: 1 },
  { code: "J15.212", label: "Pneumonia due to methicillin resistant Staphylococcus aureus", severityWeight: 2 },
  { code: "J44.9", label: "Chronic obstructive pulmonary disease, unspecified", severityWeight: 2 },
  { code: "J44.1", label: "COPD with (acute) exacerbation", severityWeight: 3 },
  // Infection / sepsis
  { code: "N39.0", label: "Urinary tract infection, site not specified", severityWeight: 1 },
  { code: "A41.9", label: "Sepsis, unspecified organism", severityWeight: 3 },
  // Common others
  { code: "E66.9", label: "Obesity, unspecified", severityWeight: 1 },
  { code: "K21.9", label: "Gastro-esophageal reflux disease without esophagitis", severityWeight: 1 },
  { code: "M54.50", label: "Low back pain, unspecified", severityWeight: 1 },
  { code: "R51.9", label: "Headache, unspecified", severityWeight: 1 },
  { code: "E78.5", label: "Hyperlipidemia, unspecified", severityWeight: 1 },
];

export const codebook: Codebook = Object.fromEntries(
  ENTRIES.map((e) => [normalizeCode(e.code), { ...e, code: normalizeCode(e.code) }]),
);

/** True if the code exists in the codebook (after normalization). */
export function isKnownCode(code: string): boolean {
  return normalizeCode(code) in codebook;
}

/** severityWeight of a code, or 0 if unknown (hallucinated codes carry no weight). */
export function severityOf(code: string): number {
  return codebook[normalizeCode(code)]?.severityWeight ?? 0;
}

/** A compact, LLM-friendly listing of the allowed codebook for the agent prompt. */
export function renderCodebookForPrompt(): string {
  return Object.values(codebook)
    .map((e) => `- ${e.code}: ${e.label}`)
    .join("\n");
}
