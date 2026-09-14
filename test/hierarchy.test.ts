import { describe, it, expect } from "vitest";
import {
  ALL_CODES,
  ancestorsOf,
  complicationOf,
  hierarchy,
  isDescendantOf,
  isUpcodeOf,
  rootCategoryOf,
  severityOf,
} from "../src/coding/hierarchy.js";

describe("ICD-10 hierarchy — structural integrity", () => {
  it("has a broad public subset (>= 40 codes across families)", () => {
    expect(ALL_CODES.length).toBeGreaterThanOrEqual(40);
  });

  it("every parent edge points at a real node (no dangling parents)", () => {
    for (const code of ALL_CODES) {
      const node = hierarchy[code];
      expect(node).toBeDefined();
      if (node && node.parent !== null) {
        expect(hierarchy[node.parent]).toBeDefined();
      }
    }
  });

  it("no ancestor chain cycles, and severity climbs with specificity", () => {
    for (const code of ALL_CODES) {
      const chain = ancestorsOf(code);
      // A finite, unique chain proves acyclicity.
      expect(new Set(chain).size).toBe(chain.length);
      const parent = hierarchy[code]?.parent;
      if (parent) {
        // A child is never LESS severe than its parent.
        expect(severityOf(code)).toBeGreaterThanOrEqual(severityOf(parent));
      }
    }
  });
});

describe("ICD-10 hierarchy — upcoding is hierarchical, not scalar", () => {
  it("flags a more specific same-family descendant as an upcode", () => {
    // J15.212 (MRSA pneumonia) refines the unspecified pneumonia root J18.9.
    expect(isDescendantOf("J15.212", "J18.9")).toBe(true);
    expect(isUpcodeOf("J15.212", "J18.9")).toBe(true);
  });

  it("flags a more severe same-family sibling as an upcode", () => {
    // Same CKD family root, higher severity tier.
    expect(rootCategoryOf("N18.5")).toBe(rootCategoryOf("N18.30"));
    expect(severityOf("N18.5")).toBeGreaterThan(severityOf("N18.30"));
    expect(isUpcodeOf("N18.5", "N18.30")).toBe(true);
  });

  it("does NOT treat a different family as an upcode", () => {
    // Hypertension is not an upcode of diabetes — a different finding.
    expect(isUpcodeOf("I10", "E11.9")).toBe(false);
  });

  it("does NOT treat a less specific / equal code as an upcode", () => {
    expect(isUpcodeOf("J18.9", "J15.212")).toBe(false);
    expect(isUpcodeOf("E11.9", "E11.9")).toBe(false);
  });

  it("carries CC/MCC capture on the reimbursement-relevant codes", () => {
    expect(complicationOf("A41.9")).toBe("mcc");
    expect(complicationOf("J44.1")).toBe("cc");
    expect(complicationOf("E11.9")).toBe("none");
  });
});
