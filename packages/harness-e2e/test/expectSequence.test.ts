import { describe, expect, it } from "vitest";
import { expectSequence, matchSequence } from "../src/index.js";

describe("matchSequence", () => {
  it("matches a simple in-order subsequence", () => {
    const r = matchSequence(["read", "edit"], ["read", "edit"]);
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.indices).toEqual([0, 1]);
  });

  it("matches through noise between steps", () => {
    const r = matchSequence(
      ["read", "shell", "read", "edit"],
      ["read", "edit"],
    );
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.indices).toEqual([0, 3]);
  });

  it("fails when a required step is missing", () => {
    const r = matchSequence(["read"], ["read", "edit"]);
    expect(r.matched).toBe(false);
    if (!r.matched) {
      expect(r.failedAt).toBe(1);
      expect(r.expected).toBe("edit");
    }
  });

  it("fails when order is reversed", () => {
    const r = matchSequence(["edit", "read"], ["read", "edit"]);
    expect(r.matched).toBe(false);
    if (!r.matched) {
      expect(r.failedAt).toBe(1);
    }
  });

  it("requires repeats: read, edit, edit must see two edits after the read", () => {
    const r = matchSequence(
      ["read", "edit", "edit"],
      ["read", "edit", "edit"],
    );
    expect(r.matched).toBe(true);
  });

  it("forbidBetween blocks a tool appearing between matched steps", () => {
    const r = matchSequence(
      ["read", "shell", "edit"],
      ["read", "edit"],
      { forbidBetween: ["shell"] },
    );
    expect(r.matched).toBe(false);
    if (!r.matched) {
      expect(r.reason).toContain("forbidden-between");
    }
  });

  it("forbidAnywhere catches a bypass tool even after the match would complete", () => {
    const r = matchSequence(
      ["read", "edit", "shell"],
      ["read", "edit"],
      { forbidAnywhere: ["shell"] },
    );
    expect(r.matched).toBe(false);
  });

  it("forbidBetween allows the forbidden tool before the first match", () => {
    // The forbidBetween guard starts scanning from cursor, so a "shell"
    // before "read" isn't between matched steps and is ignored here.
    const r = matchSequence(
      ["shell", "read", "edit"],
      ["read", "edit"],
      { forbidBetween: ["shell"] },
    );
    expect(r.matched).toBe(true);
  });
});

describe("expectSequence", () => {
  it("throws a legible error on miss", () => {
    expect(() =>
      expectSequence(["read"], ["read", "edit"]),
    ).toThrow(/expectSequence failed[\s\S]*trace ran out/);
  });

  it("passes silently on match", () => {
    expect(() => expectSequence(["read", "edit"], ["read", "edit"])).not.toThrow();
  });
});
