import { describe, expect, it } from "vitest";
import {
  safeParseWriteParams,
  safeParseEditParams,
  safeParseMultiEditParams,
} from "@agent-sh/harness-write";

/**
 * Schema drift test — pins the *tolerance* behavior of the public
 * tool-param schemas. Models sometimes emit extra fields (they
 * hallucinate parameters based on similar tools in training data);
 * if our schema suddenly starts rejecting those, tool calls that
 * used to succeed will start returning INVALID_PARAM errors across
 * whole model families. This test locks the behavior so the drift
 * is caught at review time, not in production.
 *
 * Current contract:
 *   - Unknown top-level fields are silently dropped (valibot default).
 *   - Missing `required` fields are rejected with INVALID_PARAM.
 *   - Wrong types are rejected.
 *   - Unknown nested fields (inside edits[]) are also dropped.
 *
 * If this test fails after a valibot upgrade or schema refactor, the
 * contract has drifted. Either update the test intentionally, or
 * revert the schema change.
 */

describe("schema drift: WriteParams", () => {
  it("tolerates unknown top-level fields", () => {
    const r = safeParseWriteParams({
      path: "/tmp/x.txt",
      content: "hi",
      // Extra field a confused model might emit:
      encoding: "utf-8",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ path: "/tmp/x.txt", content: "hi" });
    }
  });

  it("rejects missing required field", () => {
    const r = safeParseWriteParams({ path: "/tmp/x.txt" });
    expect(r.ok).toBe(false);
  });

  it("rejects wrong type for required field", () => {
    const r = safeParseWriteParams({ path: "/tmp/x.txt", content: 42 });
    expect(r.ok).toBe(false);
  });

  it("rejects empty path", () => {
    const r = safeParseWriteParams({ path: "", content: "x" });
    expect(r.ok).toBe(false);
  });
});

describe("schema drift: EditParams", () => {
  it("tolerates unknown top-level fields", () => {
    const r = safeParseEditParams({
      path: "/tmp/x.txt",
      old_string: "a",
      new_string: "b",
      // Hallucinated field ("count", "context", ...):
      count: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        path: "/tmp/x.txt",
        old_string: "a",
        new_string: "b",
      });
    }
  });

  it("rejects empty old_string (prevents empty-match explosions)", () => {
    const r = safeParseEditParams({
      path: "/tmp/x.txt",
      old_string: "",
      new_string: "b",
    });
    expect(r.ok).toBe(false);
  });

  it("preserves optional flags when present", () => {
    const r = safeParseEditParams({
      path: "/tmp/x.txt",
      old_string: "a",
      new_string: "b",
      replace_all: true,
      dry_run: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.replace_all).toBe(true);
      expect(r.value.dry_run).toBe(true);
    }
  });
});

describe("schema drift: MultiEditParams", () => {
  it("tolerates unknown fields at both levels", () => {
    const r = safeParseMultiEditParams({
      path: "/tmp/x.txt",
      edits: [
        {
          old_string: "a",
          new_string: "b",
          // Hallucinated nested field:
          regex: false,
        },
      ],
      // Hallucinated top-level field:
      atomic: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.edits[0]).toEqual({ old_string: "a", new_string: "b" });
    }
  });

  it("rejects empty edits array", () => {
    const r = safeParseMultiEditParams({ path: "/tmp/x.txt", edits: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects when an individual edit is missing required fields", () => {
    const r = safeParseMultiEditParams({
      path: "/tmp/x.txt",
      edits: [{ old_string: "a" }],
    });
    expect(r.ok).toBe(false);
  });
});
