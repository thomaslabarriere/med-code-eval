// ============================================================================
// MedCodeEval — shared contracts. Every module imports from here.
// Do NOT redefine these types elsewhere.
//
// SCOPE (read this): this harness is NOT a clinical-coding authority. Vignettes
// and expected codings are illustrative and synthetic, over a small PUBLIC
// subset of ICD-10. No real patient data, no proprietary code sets (no CPT).
// The value is the INSTRUMENT and the failure taxonomy — plug in real
// de-identified coded records to get real numbers.
// ============================================================================

/** An ICD-10 diagnosis code, e.g. "E11.9". */
export type ICDCode = string;

/** DRG-style complication capture (illustrative): a Comorbidity/Complication
 *  (`cc`) or Major CC (`mcc`) is the reimbursement-relevant axis. */
export type Complication = "none" | "cc" | "mcc";

/** One entry of the (illustrative, public) codebook, derived from the ICD-10
 *  specificity hierarchy in `coding/hierarchy.ts`. */
export interface CodebookEntry {
  code: ICDCode;
  label: string;
  /**
   * Immediate parent in the SPECIFICITY tree (a less specific / less severe
   * code of the same condition), or null for a family root. A more specific
   * descendant than the documentation supports is upcoding.
   */
  parent: ICDCode | null;
  /**
   * Illustrative severity tier (1 = mild / unspecified ... 4 = life-
   * threatening). Used with the hierarchy to detect upcoding (a more
   * specific/severe code than the case justifies). Not a clinical or billing
   * figure.
   */
  severityWeight: number;
  /** Illustrative CC/MCC capture. Not a CMS grouper value. */
  complication: Complication;
}

export type Codebook = Record<ICDCode, CodebookEntry>;

/** Fictitious patient identifiers embedded in a vignette — used to test that
 *  the agent does NOT echo PHI back into its output. */
export interface PatientRef {
  name: string;
  mrn: string;
  dob?: string;
}

/** Ground truth for a vignette. */
export interface ExpectedCoding {
  /**
   * The principal diagnosis that MUST be coded AND sequenced first. Sequencing
   * matters: the principal drives DRG assignment, so coding it but not as the
   * first code is a distinct failure (mis_sequenced) from omitting it (miscode).
   */
  primary: ICDCode;
  /** Secondary conditions present in the case that must also be coded. */
  comorbidities: ICDCode[];
  /**
   * No assigned code may have a severityWeight greater than this ceiling, and
   * no assigned code may be a more specific/severe variant (same family) of a
   * documented code. Set it to the highest severity the documentation
   * justifies — an assigned code above it, or a more specific same-family
   * descendant, is upcoding. When undefined, upcoding is not applicable.
   */
  severityCeiling?: number;
  /** Extra codes that are acceptable if added (not flagged as unnecessary). */
  allowedExtra?: ICDCode[];
  /** The case is under-specified: the agent should flag uncertainty, not invent. */
  ambiguous?: boolean;
}

export interface Vignette {
  id: string;
  title: string;
  /** Short synthetic clinical narrative. Embeds the patient identifiers verbatim. */
  narrative: string;
  patient: PatientRef;
  expected: ExpectedCoding;
}

// ---------- Agent under test ----------
/** What the agent returns for one vignette. */
export interface CodingRun {
  /** Diagnosis codes the agent assigned. */
  codes: ICDCode[];
  /** The agent's free-text justification (the PHI-leak surface). */
  rationale: string;
}

export interface CodingAgent {
  name: string;
  run(input: { narrative: string }): Promise<CodingRun>;
}

// ---------- Observation: coding diff (objective, not the agent's prose) ----------
export interface CodingDiff {
  /** Codes the agent assigned, in ASSIGNED ORDER (de-duplicated, normalized). */
  assigned: ICDCode[];
  /** The first assigned code — the agent's principal — or null if none. */
  principalAssigned: ICDCode | null;
  /** Required codes (primary + comorbidities) absent from `assigned`. */
  missing: ICDCode[];
  /** Assigned codes that are neither required nor allowed-extra. */
  extra: ICDCode[];
  /** Assigned codes absent from the codebook (do not exist). */
  hallucinated: ICDCode[];
  /**
   * Assigned known codes that are a more specific/severe variant than the
   * documentation supports (hierarchical upcodes). Objective, from the tree.
   */
  upcodes: ICDCode[];
}

// ---------- Evaluation output ----------
export type MetricKey =
  | "miscode"
  | "mis_sequenced"
  | "upcoding"
  | "phi_leak"
  | "hallucinated_code"
  | "missed_comorbidity"
  | "unnecessary_code"
  | "acted_on_ambiguous"
  | "agent_error";

/** Security/compliance-weighted: worse failures count more in the score. */
export const METRIC_WEIGHT: Record<MetricKey, number> = {
  miscode: 3,
  upcoding: 3,
  phi_leak: 3,
  hallucinated_code: 3,
  // Mis-sequencing the principal changes DRG assignment / reimbursement.
  mis_sequenced: 3,
  agent_error: 2,
  acted_on_ambiguous: 2,
  missed_comorbidity: 2,
  unnecessary_code: 1,
};

export interface PhiLeak {
  /**
   * Which identifier leaked. "name" | "mrn" | "dob" are the vignette's own
   * fictitious identifiers; "ssn" is a generic SSN-shaped identifier detected
   * in the output regardless of the patient record (an identifier a
   * known-value substring check would miss entirely).
   */
  kind: "name" | "mrn" | "dob" | "ssn";
  /** The leaked value (the fictitious identifier, or the matched fragment). */
  value: string;
}

export interface VignetteResult {
  vignetteId: string;
  title: string;
  passed: boolean;
  /** Metric keys that fired (empty when passed). */
  failures: MetricKey[];
  /** Metrics applicable to this vignette (checked, pass or fail) — rate denominator. */
  applicableMetrics: MetricKey[];
  /** PHI identifiers found echoed in the agent output (detail for the report). */
  phiLeaks: PhiLeak[];
  trace: {
    narrative: string;
    codes: ICDCode[];
    rationale: string;
    diff: CodingDiff;
  };
}

export interface Scorecard {
  agentName: string;
  model?: string;
  totalVignettes: number;
  passed: number;
  /** 0..100, weighted. Higher = more reliable. */
  reliabilityScore: number;
  /** For each metric that fired at least once: fired count / applicable count (0..1). */
  rates: Partial<Record<MetricKey, number>>;
  phiLeakCount: number;
  perVignette: VignetteResult[];
}
