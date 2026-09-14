import { describe, it, expect } from "vitest";
import {
  deidentify,
  hasResidualPhi,
  scanPhi,
  type PhiCategory,
} from "../src/pipeline/deid.js";

function categories(text: string): PhiCategory[] {
  return scanPhi(text).map((f) => f.category);
}

describe("deid — each HIPAA identifier family is detected", () => {
  const cases: Array<{ label: PhiCategory; text: string; frag: string }> = [
    { label: "email", text: "Contact jane.doe@example.com for records.", frag: "jane.doe@example.com" },
    { label: "url", text: "Portal at https://portal.hospital.org/p/9 today.", frag: "https://portal.hospital.org/p/9" },
    { label: "ip", text: "Uploaded from 192.168.10.42 overnight.", frag: "192.168.10.42" },
    { label: "ssn", text: "SSN on file is 123-45-6789 per intake.", frag: "123-45-6789" },
    { label: "phone", text: "Call back at (415) 555-0132 tomorrow.", frag: "(415) 555-0132" },
    { label: "mrn", text: "Chart pulled under MRN 88231 today.", frag: "MRN 88231" },
    { label: "account", text: "Billed to account number A45-9920 last week.", frag: "account number A45-9920" },
    { label: "address", text: "Lives at 42 Maple Street near the clinic.", frag: "42 Maple Street" },
    { label: "date", text: "Born 1962-04-18 per record.", frag: "1962-04-18" },
    { label: "date", text: "Seen on March 3, 2021 for follow-up.", frag: "March 3, 2021" },
    { label: "date", text: "Admitted 04/18/1962 overnight.", frag: "04/18/1962" },
    { label: "age_over_89", text: "A 92-year-old presents with cough.", frag: "92-year-old" },
    { label: "name", text: "Patient Jean Martin returns for review.", frag: "Jean Martin" },
    { label: "name", text: "Discussed with Dr. Okafor at length.", frag: "Dr. Okafor" },
  ];

  for (const { label, text, frag } of cases) {
    it(`detects ${label}: "${frag}"`, () => {
      const findings = scanPhi(text);
      const hit = findings.find((f) => f.category === label);
      expect(hit, `expected a ${label} finding in: ${text}`).toBeDefined();
      expect(hit?.value).toContain(frag);
    });
  }
});

describe("deid — false positives avoided (ordinary clinical prose)", () => {
  it("does not flag clinical bigrams as names", () => {
    expect(categories("Blood Glucose was well controlled.")).not.toContain("name");
    expect(categories("Chronic Kidney Disease documented.")).not.toContain("name");
  });

  it("does not flag an age <= 89 as an identifier", () => {
    expect(categories("A 62-year-old with stable disease.")).not.toContain("age_over_89");
    expect(categories("An 89-year-old, uncomplicated.")).not.toContain("age_over_89");
  });

  it("flags the boundary age 90 and above", () => {
    expect(categories("A 90-year-old with cough.")).toContain("age_over_89");
  });
});

describe("deid — redaction and residual re-scan", () => {
  it("redacts every finding with a category placeholder", () => {
    const src =
      "Jean Martin (MRN 88231), DOB 1962-04-18, reached at (415) 555-0132.";
    const { clean, findings } = deidentify(src);
    expect(findings.length).toBeGreaterThanOrEqual(4);
    expect(clean).toContain("[NAME]");
    expect(clean).toContain("[MRN]");
    expect(clean).toContain("[DATE]");
    expect(clean).toContain("[PHONE]");
    // The original identifiers are gone.
    expect(clean).not.toContain("Jean Martin");
    expect(clean).not.toContain("88231");
    expect(clean).not.toContain("1962-04-18");
    // And the cleaned text has no residual PHI on a second pass.
    expect(hasResidualPhi(clean)).toBe(false);
  });

  it("preserves the clinical content between identifiers", () => {
    const { clean } = deidentify("Jean Martin has type 2 diabetes mellitus.");
    expect(clean).toContain("has type 2 diabetes mellitus.");
  });
});
