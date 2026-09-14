// ============================================================================
// MedCodeEval — de-identification pipeline stage.
//
// "Secure data pipelines / health-data security": the note that feeds the agent
// is CLEANED first, and the agent's output is RE-SCANNED, so an identifier can
// neither reach the model nor slip out in a rationale. This widens coverage
// well beyond the eval-time PHI probe (eval/phi.ts, which knows the record's
// own values): here we detect identifier SHAPES structurally — the 18-HIPAA
// families that are detectable in free text — plus a light, dependency-free
// name heuristic. No ML model, no network, no heavy NER library.
//
// SCOPE / limits (see DECISIONS.md): a regex + heuristic pass is a strong
// FIRST line, not a certified Safe-Harbor de-identifier. Recall on names in
// arbitrary prose is inherently imperfect; this is a pipeline guard, not a
// compliance guarantee. It is tuned to fire on identifier shapes and to avoid
// the obvious false positives (ordinary clinical bigrams, ages <= 89).
// ============================================================================

/** The HIPAA identifier families this stage detects in free text. */
export type PhiCategory =
  | "name"
  | "mrn"
  | "ssn"
  | "date"
  | "phone"
  | "email"
  | "url"
  | "ip"
  | "address"
  | "account"
  | "age_over_89";

export interface PhiFinding {
  category: PhiCategory;
  /** The matched text. */
  value: string;
  /** Half-open range [start, end) in the ORIGINAL text. */
  start: number;
  end: number;
}

interface Detector {
  category: PhiCategory;
  re: RegExp;
  /** Optional post-filter; keep the match only when it returns true. */
  keep?: (m: RegExpExecArray) => boolean;
}

// Capitalized clinical / structural words that form ALL-CAPS or Capitalized
// bigrams but are NOT names. Kept small and specific; the name heuristic also
// requires two title-cased tokens, which already excludes most prose.
const NAME_STOPWORDS = new Set<string>([
  "Blood", "Glucose", "Type", "Chronic", "Acute", "Chest", "Heart", "Failure",
  "Kidney", "Disease", "Pneumonia", "Diabetes", "Mellitus", "Hypertension",
  "Obstructive", "Pulmonary", "Urinary", "Tract", "Infection", "Sepsis",
  "Patient", "Vitals", "Urinalysis", "Both", "Long", "Essential", "Stage",
  "Community", "The", "His", "Her", "There", "No", "Severe", "Acute",
]);

// Title tokens that introduce a surname (redact the title + following name).
const NAME_TITLE = String.raw`(?:Mr|Mrs|Ms|Mx|Dr|Prof)\.?`;

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December|" +
  "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

// Order matters: longer / more structured shapes are detected first so a date
// inside an address, or an SSN, is not half-eaten by a looser detector.
const DETECTORS: Detector[] = [
  { category: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { category: "url", re: /\b(?:https?:\/\/|www\.)[^\s]+/gi },
  { category: "ip", re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g },
  { category: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    category: "phone",
    re: /(?<![\w-])(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}(?![\w-])/g,
  },
  { category: "mrn", re: /\bMRN[:#]?\s*[A-Za-z0-9-]+/gi },
  {
    category: "account",
    re: /\b(?:account|acct|policy|member(?:\s*id)?|beneficiary)\s*(?:no\.?|number|#|id|:)?\s*[A-Za-z0-9-]{3,}/gi,
  },
  {
    category: "address",
    re: /\b\d{1,5}\s+(?:[A-Z][a-zA-Z]+\.?\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter)\b\.?/g,
  },
  // Dates: ISO, numeric M/D/Y, and month-name forms (all smaller-than-year
  // elements are identifiers under HIPAA).
  { category: "date", re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { category: "date", re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
  {
    category: "date",
    re: new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b`, "gi"),
  },
  {
    category: "date",
    re: new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTHS})\.?,?\s+\d{4}\b`, "gi"),
  },
  // Age > 89 only (ages <= 89 are not identifiers). Capture the number, keep
  // the finding only when it exceeds 89.
  {
    category: "age_over_89",
    re: /\b(\d{2,3})[-\s]?(?:year[-\s]?old|years?\s+old|y\/?o)\b/gi,
    keep: (m) => Number(m[1]) > 89,
  },
  {
    category: "age_over_89",
    re: /\baged?\s+(\d{2,3})\b/gi,
    keep: (m) => Number(m[1]) > 89,
  },
  // Name: an optional title + title-cased token, or a title-cased bigram/
  // trigram. Post-filtered against the clinical stopword list.
  {
    category: "name",
    re: new RegExp(String.raw`\b${NAME_TITLE}\s+[A-Z][a-zA-Z'-]+`, "g"),
  },
  {
    category: "name",
    re: /\b[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2}\b/g,
    keep: (m) => {
      const tokens = m[0].split(/\s+/).filter((t) => !/^(?:Mr|Mrs|Ms|Mx|Dr|Prof)\.?$/.test(t));
      // Reject when EVERY token is a known clinical/common word (a prose bigram
      // like "Blood Glucose"); accept when at least one token looks like a name.
      return tokens.some((t) => !NAME_STOPWORDS.has(t));
    },
  },
];

/** Scan text for PHI identifier shapes. Returns non-overlapping findings, in
 *  order of appearance (earlier and longer matches win a conflict). */
export function scanPhi(text: string): PhiFinding[] {
  const raw: PhiFinding[] = [];
  for (const det of DETECTORS) {
    const re = new RegExp(det.re.source, det.re.flags.includes("g") ? det.re.flags : det.re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (det.keep && !det.keep(m)) continue;
      raw.push({ category: det.category, value: m[0], start: m.index, end: m.index + m[0].length });
    }
  }

  // Resolve overlaps: sort by start, then by longer span; drop any finding that
  // overlaps one already kept.
  raw.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: PhiFinding[] = [];
  for (const f of raw) {
    if (kept.some((k) => f.start < k.end && k.start < f.end)) continue;
    kept.push(f);
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

export interface DeidResult {
  /** The text with every finding replaced by a `[CATEGORY]` placeholder. */
  clean: string;
  findings: PhiFinding[];
}

/** Redact every detected identifier, replacing it with a category placeholder. */
export function deidentify(text: string): DeidResult {
  const findings = scanPhi(text);
  let clean = "";
  let cursor = 0;
  for (const f of findings) {
    clean += text.slice(cursor, f.start);
    clean += `[${f.category.toUpperCase()}]`;
    cursor = f.end;
  }
  clean += text.slice(cursor);
  return { clean, findings };
}

/** True when the text still contains a detectable identifier (post-check). */
export function hasResidualPhi(text: string): boolean {
  return scanPhi(text).length > 0;
}
