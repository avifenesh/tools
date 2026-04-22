import { describe, expect, it } from "vitest";
import {
  findAllOccurrences,
  findFuzzyCandidates,
  substringBoundaryCollisions,
} from "../src/matching.js";

describe("matching — findAllOccurrences", () => {
  it("finds a single match", () => {
    const offsets = findAllOccurrences("hello world\n", "world");
    expect(offsets).toEqual([6]);
  });

  it("finds multiple non-overlapping matches", () => {
    const offsets = findAllOccurrences("foo foo foo", "foo");
    expect(offsets).toEqual([0, 4, 8]);
  });

  it("returns empty for no match", () => {
    expect(findAllOccurrences("abc", "z")).toEqual([]);
  });
});

describe("matching — findFuzzyCandidates", () => {
  it("returns ranked candidates for a close miss", () => {
    const content = [
      "function calculateTotal(items) {",
      "  return items.reduce(0);",
      "}",
    ].join("\n");
    const candidates = findFuzzyCandidates(
      content,
      "function calculateTotals(items)",
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.line).toBe(1);
    expect(candidates[0]?.score).toBeGreaterThan(0.7);
  });

  it("returns empty when nothing is close", () => {
    const candidates = findFuzzyCandidates(
      "completely unrelated content here",
      "zzzxxxqqqwwweeerrrttt",
    );
    expect(candidates).toEqual([]);
  });
});

describe("matching — substringBoundaryCollisions", () => {
  it("flags matches bordering identifier characters", () => {
    const content = "user\nusername\n";
    const lines = substringBoundaryCollisions(content, "user", [0, 5]);
    expect(lines).toEqual([2]);
  });

  it("returns empty when all matches are on word boundaries", () => {
    const content = "user\nuser\n";
    const lines = substringBoundaryCollisions(content, "user", [0, 5]);
    expect(lines).toEqual([]);
  });
});
