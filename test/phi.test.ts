import { describe, it, expect } from "vitest";
import type { CodingRun, PatientRef } from "../src/types.js";
import { detectPhiLeaks } from "../src/eval/phi.js";

function run(rationale: string, codes: string[] = ["N39.0"]): CodingRun {
  return { codes, rationale };
}

/** The old, naive detector: raw case-insensitive substring of exact values. */
function naiveSubstringLeak(patient: PatientRef, r: CodingRun): boolean {
  const hay = `${r.rationale}\n${r.codes.join(" ")}`.toLowerCase();
  const needles = [patient.name, patient.mrn, patient.dob ?? ""]
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return needles.some((n) => hay.includes(n));
}

describe("PHI detector — true positives a substring test misses", () => {
  it("catches a last-name-only leak the full-name substring check misses", () => {
    const patient: PatientRef = { name: "Robert Nkemba", mrn: "55302" };
    const r = run("Nkemba was afebrile; coded the documented diagnosis.");

    // The old exact-full-name substring check does NOT fire here...
    expect(naiveSubstringLeak(patient, r)).toBe(false);
    // ...but boundary token matching catches the surname leak.
    const leaks = detectPhiLeaks(patient, r);
    expect(leaks).toContainEqual({ kind: "name", value: "Nkemba" });
  });

  it("catches an SSN-shaped identifier absent from the patient record", () => {
    const patient: PatientRef = { name: "Jean Martin", mrn: "88231" };
    const r = run("Identifier on file 123-45-6789 was noted.");

    // The record has no SSN, so a known-value substring scan sees nothing...
    expect(naiveSubstringLeak(patient, r)).toBe(false);
    // ...the structural SSN detector still flags it.
    const leaks = detectPhiLeaks(patient, r);
    expect(leaks).toContainEqual({ kind: "ssn", value: "123-45-6789" });
  });
});

describe("PHI detector — false positive a substring test would cause", () => {
  it("does NOT flag common-word name tokens inside unrelated words", () => {
    const patient: PatientRef = { name: "Mark Long", mrn: "40000" };
    const r = run("This is a remarkable case warranting long-term follow-up.");

    // A naive per-token substring check WOULD fire ("mark" in "remarkable",
    // "long" in "long-term")...
    expect("remarkable long-term".includes("mark")).toBe(true);
    expect("remarkable long-term".includes("long")).toBe(true);
    // ...the improved detector correctly reports no leak.
    expect(detectPhiLeaks(patient, r)).toEqual([]);
  });
});

describe("PHI detector — real leaks are still caught", () => {
  it("flags a full-name leak", () => {
    const patient: PatientRef = { name: "Amina Haddad", mrn: "71640" };
    const leaks = detectPhiLeaks(patient, run("Amina Haddad reports dysuria."));
    expect(leaks).toContainEqual({ kind: "name", value: "Amina Haddad" });
  });

  it("flags MRN and DOB on word boundaries", () => {
    const patient: PatientRef = {
      name: "Amina Haddad",
      mrn: "71640",
      dob: "1990-07-25",
    };
    const leaks = detectPhiLeaks(
      patient,
      run("Patient MRN 71640, DOB 1990-07-25; treated empirically."),
    );
    expect(leaks).toContainEqual({ kind: "mrn", value: "71640" });
    expect(leaks).toContainEqual({ kind: "dob", value: "1990-07-25" });
  });

  it("returns nothing for a clean, identifier-free rationale", () => {
    const patient: PatientRef = {
      name: "Amina Haddad",
      mrn: "71640",
      dob: "1990-07-25",
    };
    expect(detectPhiLeaks(patient, run("Coded from the documented diagnoses."))).toEqual([]);
  });
});
