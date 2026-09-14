// ============================================================================
// MedCodeEval — the ICD-10 domain model: a specificity HIERARCHY, not a flat
// list with a scalar weight.
//
// Real medical coding is hierarchical (a family category → progressively more
// specific / more severe variants), sequenced (a principal diagnosis vs.
// secondaries), and reimbursement-sensitive through CC/MCC capture (a
// Comorbidity/Complication or Major CC that lifts the DRG weight). Upcoding is
// therefore not "a bigger number" — it is claiming a MORE SPECIFIC or MORE
// SEVERE code than the documentation supports, within the same family.
//
// SCOPE (read this): this is an ILLUSTRATIVE, PUBLIC subset of ICD-10 (~45
// codes, 6 families). The parent/child edges and the CC/MCC / severity tiers
// are structurally faithful to how ICD-10 + DRG grouping BEHAVE, but they are a
// teaching model, NOT the official ICD-10 ontology or a CMS grouper. No real
// patient data, no proprietary code sets (no CPT), no clinical authority. Plug
// a real hierarchy and grouper in behind this same interface for real numbers.
// ============================================================================

import type { ICDCode } from "../types.js";

/** DRG-style complication capture. `mcc` (Major CC) lifts weight most. */
export type Complication = "none" | "cc" | "mcc";

/** One node of the specificity hierarchy. */
export interface HierarchyNode {
  code: ICDCode;
  label: string;
  /**
   * Immediate parent in the SPECIFICITY tree (a less specific / less severe
   * code of the same condition), or null for a family root. A code whose
   * ancestor chain contains a documented code, but which is itself more
   * specific/severe, is an upcode.
   */
  parent: ICDCode | null;
  /** Severity tier, 1 (mild / unspecified) → 4 (life-threatening). */
  severityWeight: number;
  /** Illustrative CC/MCC capture — the reimbursement-relevant axis. */
  complication: Complication;
  /**
   * The clinical term(s) that distinguish this node from its PARENT — the
   * documented feature a coder must find in the note to justify the extra
   * specificity/severity (e.g. E11.621 "foot ulcer" vs its parent E11.65, or
   * E11.65 "hyperglycemia" vs the root E11.9). Present ONLY on nodes that are
   * more specific than their parent (i.e. `parent !== null`); a family root has
   * nothing to distinguish and omits it.
   *
   * Grounding uses this: a code carrying distinguishing terms is only supported
   * if the CITED SPAN itself mentions one of them (a generic parent-level quote
   * cannot justify a specific child — that is upcoding-by-generic-span). Each
   * term may be a single word or a short phrase; matching is word-boundary and
   * case/whitespace-insensitive (see grounding.ts).
   */
  distinguishingTerms?: string[];
}

/** Escape + normalize helper shared with the codebook. */
export function normalizeCode(code: string): ICDCode {
  return code.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// The hierarchy. Each family root has parent:null; children point at the
// less-specific code they refine. Severity/complication climb with specificity.
// ---------------------------------------------------------------------------
const NODES: ReadonlyArray<HierarchyNode> = [
  // ---- Family: Type 2 diabetes mellitus (root E11.9) --------------------
  { code: "E11.9", label: "Type 2 diabetes mellitus without complications", parent: null, severityWeight: 1, complication: "none" },
  { code: "E11.65", label: "Type 2 diabetes mellitus with hyperglycemia", parent: "E11.9", severityWeight: 2, complication: "cc", distinguishingTerms: ["hyperglycemia", "hyperglycaemia"] },
  { code: "E11.40", label: "Type 2 diabetes mellitus with diabetic neuropathy, unspecified", parent: "E11.9", severityWeight: 2, complication: "cc", distinguishingTerms: ["neuropathy", "neuropathic"] },
  { code: "E11.21", label: "Type 2 diabetes mellitus with diabetic nephropathy", parent: "E11.9", severityWeight: 3, complication: "mcc", distinguishingTerms: ["nephropathy"] },
  { code: "E11.22", label: "Type 2 diabetes mellitus with diabetic chronic kidney disease", parent: "E11.21", severityWeight: 3, complication: "mcc", distinguishingTerms: ["chronic kidney disease", "ckd"] },
  { code: "E11.621", label: "Type 2 diabetes mellitus with foot ulcer", parent: "E11.65", severityWeight: 3, complication: "mcc", distinguishingTerms: ["foot ulcer", "ulcer"] },
  { code: "E11.10", label: "Type 2 diabetes mellitus with ketoacidosis without coma", parent: "E11.9", severityWeight: 4, complication: "mcc", distinguishingTerms: ["ketoacidosis", "dka"] },
  { code: "Z79.4", label: "Long term (current) use of insulin", parent: null, severityWeight: 1, complication: "none" },

  // ---- Family: Pneumonia (root J18.9) -----------------------------------
  { code: "J18.9", label: "Pneumonia, unspecified organism", parent: null, severityWeight: 1, complication: "none" },
  { code: "J15.9", label: "Unspecified bacterial pneumonia", parent: "J18.9", severityWeight: 2, complication: "cc", distinguishingTerms: ["bacterial"] },
  { code: "J13", label: "Pneumonia due to Streptococcus pneumoniae", parent: "J18.9", severityWeight: 2, complication: "cc", distinguishingTerms: ["streptococcus", "streptococcal", "pneumococcal"] },
  { code: "J15.212", label: "Pneumonia due to methicillin resistant Staphylococcus aureus", parent: "J15.9", severityWeight: 3, complication: "mcc", distinguishingTerms: ["methicillin resistant", "mrsa", "staphylococcus aureus"] },

  // ---- Family: COPD (root J44.9) ----------------------------------------
  { code: "J44.9", label: "Chronic obstructive pulmonary disease, unspecified", parent: null, severityWeight: 2, complication: "none" },
  { code: "J44.0", label: "COPD with (acute) lower respiratory infection", parent: "J44.9", severityWeight: 3, complication: "cc", distinguishingTerms: ["respiratory infection", "lower respiratory infection"] },
  { code: "J44.1", label: "COPD with (acute) exacerbation", parent: "J44.9", severityWeight: 3, complication: "cc", distinguishingTerms: ["exacerbation"] },

  // ---- Family: Asthma / respiratory failure -----------------------------
  { code: "J45.909", label: "Unspecified asthma, uncomplicated", parent: null, severityWeight: 1, complication: "none" },
  { code: "J96.01", label: "Acute respiratory failure with hypoxia", parent: null, severityWeight: 4, complication: "mcc" },

  // ---- Family: Hypertension / cardiac -----------------------------------
  { code: "I10", label: "Essential (primary) hypertension", parent: null, severityWeight: 1, complication: "none" },
  { code: "I50.9", label: "Heart failure, unspecified", parent: null, severityWeight: 2, complication: "none" },
  { code: "I50.32", label: "Chronic diastolic (congestive) heart failure", parent: "I50.9", severityWeight: 3, complication: "cc", distinguishingTerms: ["diastolic"] },
  { code: "I50.22", label: "Chronic systolic (congestive) heart failure", parent: "I50.9", severityWeight: 3, complication: "cc", distinguishingTerms: ["systolic"] },
  { code: "I50.21", label: "Acute systolic (congestive) heart failure", parent: "I50.9", severityWeight: 4, complication: "mcc", distinguishingTerms: ["acute systolic", "systolic"] },
  { code: "I25.10", label: "Atherosclerotic heart disease of native coronary artery without angina", parent: null, severityWeight: 2, complication: "none" },
  { code: "I48.91", label: "Unspecified atrial fibrillation", parent: null, severityWeight: 2, complication: "cc" },
  { code: "I21.4", label: "Non-ST elevation (NSTEMI) myocardial infarction", parent: null, severityWeight: 4, complication: "mcc" },
  { code: "E78.5", label: "Hyperlipidemia, unspecified", parent: null, severityWeight: 1, complication: "none" },

  // ---- Family: Renal (CKD root N18.9) -----------------------------------
  { code: "N18.9", label: "Chronic kidney disease, unspecified", parent: null, severityWeight: 1, complication: "none" },
  { code: "N18.30", label: "Chronic kidney disease, stage 3 unspecified", parent: "N18.9", severityWeight: 2, complication: "cc", distinguishingTerms: ["stage 3", "stage iii"] },
  { code: "N18.4", label: "Chronic kidney disease, stage 4 (severe)", parent: "N18.9", severityWeight: 3, complication: "cc", distinguishingTerms: ["stage 4", "stage iv"] },
  { code: "N18.5", label: "Chronic kidney disease, stage 5", parent: "N18.9", severityWeight: 3, complication: "mcc", distinguishingTerms: ["stage 5", "stage v"] },
  { code: "N18.6", label: "End stage renal disease", parent: "N18.5", severityWeight: 4, complication: "mcc", distinguishingTerms: ["end stage renal disease", "end-stage renal disease", "esrd", "dialysis"] },
  { code: "N17.9", label: "Acute kidney failure, unspecified", parent: null, severityWeight: 4, complication: "mcc" },
  { code: "N39.0", label: "Urinary tract infection, site not specified", parent: null, severityWeight: 1, complication: "none" },

  // ---- Family: Infection / sepsis ---------------------------------------
  { code: "A41.9", label: "Sepsis, unspecified organism", parent: null, severityWeight: 4, complication: "mcc" },
  { code: "A41.01", label: "Sepsis due to methicillin resistant Staphylococcus aureus", parent: "A41.9", severityWeight: 4, complication: "mcc", distinguishingTerms: ["methicillin resistant", "mrsa", "staphylococcus aureus"] },
  { code: "R65.20", label: "Severe sepsis without septic shock", parent: "A41.9", severityWeight: 4, complication: "mcc", distinguishingTerms: ["severe sepsis"] },
  { code: "R65.21", label: "Severe sepsis with septic shock", parent: "R65.20", severityWeight: 4, complication: "mcc", distinguishingTerms: ["septic shock", "shock"] },
  { code: "A04.7", label: "Enterocolitis due to Clostridioides difficile", parent: null, severityWeight: 3, complication: "cc" },

  // ---- Symptom / common others (used for ambiguity & unnecessary codes) --
  { code: "R07.9", label: "Chest pain, unspecified", parent: null, severityWeight: 1, complication: "none" },
  { code: "R51.9", label: "Headache, unspecified", parent: null, severityWeight: 1, complication: "none" },
  { code: "R10.9", label: "Unspecified abdominal pain", parent: null, severityWeight: 1, complication: "none" },
  { code: "E66.9", label: "Obesity, unspecified", parent: null, severityWeight: 1, complication: "none" },
  { code: "K21.9", label: "Gastro-esophageal reflux disease without esophagitis", parent: null, severityWeight: 1, complication: "none" },
  { code: "M54.50", label: "Low back pain, unspecified", parent: null, severityWeight: 1, complication: "none" },
];

/** The hierarchy keyed by normalized code. Frozen — no module may mutate it. */
export const hierarchy: Readonly<Record<ICDCode, HierarchyNode>> = Object.freeze(
  Object.fromEntries(
    NODES.map((n) => [
      normalizeCode(n.code),
      Object.freeze({
        ...n,
        code: normalizeCode(n.code),
        parent: n.parent === null ? null : normalizeCode(n.parent),
      }),
    ]),
  ),
);

/** Every code in the hierarchy, in declaration order. */
export const ALL_CODES: ReadonlyArray<ICDCode> = NODES.map((n) => normalizeCode(n.code));

/** Look up a node (or undefined if the code is unknown). */
export function nodeOf(code: string): HierarchyNode | undefined {
  return hierarchy[normalizeCode(code)];
}

/** True if the code exists in the hierarchy. */
export function isKnownCode(code: string): boolean {
  return normalizeCode(code) in hierarchy;
}

/** Severity tier of a code, or 0 if unknown (a hallucinated code has no tier). */
export function severityOf(code: string): number {
  return nodeOf(code)?.severityWeight ?? 0;
}

/** CC/MCC capture of a code, or "none" if unknown. */
export function complicationOf(code: string): Complication {
  return nodeOf(code)?.complication ?? "none";
}

/**
 * The chain of strict ancestors of `code`, nearest first (its parent, then the
 * parent's parent, …). Empty for a family root or an unknown code. Guards
 * against a cyclic edge (defensive; the static data has none).
 */
export function ancestorsOf(code: string): ICDCode[] {
  const out: ICDCode[] = [];
  const seen = new Set<ICDCode>();
  let current = nodeOf(code)?.parent ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = nodeOf(current)?.parent ?? null;
  }
  return out;
}

/** The family root of `code` (walk to the top of the specificity tree). */
export function rootCategoryOf(code: string): ICDCode | undefined {
  if (!isKnownCode(code)) return undefined;
  const chain = ancestorsOf(code);
  return chain.length > 0 ? chain[chain.length - 1] : normalizeCode(code);
}

/** True if `descendant` is a strict descendant of `ancestor` in the tree. */
export function isDescendantOf(descendant: string, ancestor: string): boolean {
  return ancestorsOf(descendant).includes(normalizeCode(ancestor));
}

/**
 * True if `candidate` is an UPCODE of the documented code `base`: a more
 * specific / more severe code of the SAME family. Two structural signals, both
 * derived from the tree (never from prose):
 *   (a) `candidate` is a strict descendant of `base` (agent claimed more
 *       specificity than documented), or
 *   (b) they share a family root and `candidate` carries a higher severity tier
 *       (agent claimed a more severe sibling variant).
 * A code from a different family is NOT an upcode of `base` (it is a different
 * finding — caught, if unsupported, by unnecessary_code).
 */
export function isUpcodeOf(candidate: string, base: string): boolean {
  if (!isKnownCode(candidate) || !isKnownCode(base)) return false;
  const c = normalizeCode(candidate);
  const b = normalizeCode(base);
  if (c === b) return false;
  if (isDescendantOf(c, b)) return true;
  const sameFamily = rootCategoryOf(c) === rootCategoryOf(b);
  return sameFamily && severityOf(c) > severityOf(b);
}

/** A compact, LLM-friendly listing of the hierarchy for the agent prompt. */
export function renderHierarchyForPrompt(): string {
  return ALL_CODES.map((code) => {
    const n = hierarchy[code];
    if (!n) return "";
    const depth = ancestorsOf(code).length;
    const indent = "  ".repeat(depth);
    const cc = n.complication === "none" ? "" : ` [${n.complication.toUpperCase()}]`;
    return `${indent}- ${n.code}: ${n.label} (sev ${n.severityWeight}${cc})`;
  })
    .filter((line) => line.length > 0)
    .join("\n");
}
