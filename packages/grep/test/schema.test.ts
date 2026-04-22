import { describe, expect, it } from "vitest";
import { safeParseGrepParams } from "../src/schema.js";

describe("grep schema", () => {
  it("accepts a minimal pattern", () => {
    const r = safeParseGrepParams({ pattern: "foo" });
    expect(r.ok).toBe(true);
  });

  it("rejects an empty pattern", () => {
    const r = safeParseGrepParams({ pattern: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing pattern", () => {
    const r = safeParseGrepParams({});
    expect(r.ok).toBe(false);
  });

  it("accepts all optional fields", () => {
    const r = safeParseGrepParams({
      pattern: "foo",
      path: "/tmp",
      glob: "*.ts",
      type: "ts",
      output_mode: "content",
      case_insensitive: true,
      multiline: true,
      context_before: 2,
      context_after: 3,
      context: 0,
      head_limit: 500,
      offset: 100,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown output_mode", () => {
    const r = safeParseGrepParams({ pattern: "foo", output_mode: "bogus" });
    expect(r.ok).toBe(false);
  });

  it("rejects negative context", () => {
    const r = safeParseGrepParams({ pattern: "foo", context: -1 });
    expect(r.ok).toBe(false);
  });

  it("rejects head_limit < 1", () => {
    const r = safeParseGrepParams({ pattern: "foo", head_limit: 0 });
    expect(r.ok).toBe(false);
  });

  it("rejects offset < 0", () => {
    const r = safeParseGrepParams({ pattern: "foo", offset: -1 });
    expect(r.ok).toBe(false);
  });

  it("rejects comma-list type and points at glob", () => {
    const r = safeParseGrepParams({ pattern: "foo", type: "js,py,rust,go" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/single ripgrep file-type name/);
      expect(msg).toMatch(/glob/);
    }
  });

  it("rejects whitespace in type (e.g. 'js py')", () => {
    const r = safeParseGrepParams({ pattern: "foo", type: "js py" });
    expect(r.ok).toBe(false);
  });

  it("still accepts a single valid type name", () => {
    const r = safeParseGrepParams({ pattern: "foo", type: "rust" });
    expect(r.ok).toBe(true);
  });

  it("redirects 'content' typo to 'context' with output_mode note", () => {
    const r = safeParseGrepParams({ pattern: "foo", content: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/Did you mean 'context'/);
      expect(msg).toMatch(/output_mode: 'content'/);
    }
  });

  it("redirects common alias typos", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["regex", "foo", /Use 'pattern'/],
      ["query", "foo", /Use 'pattern'/],
      ["mode", "content", /Use 'output_mode'/],
      ["glob_pattern", "*.ts", /Use 'glob'/],
      ["file_type", "ts", /Use 'type'/],
      ["ignore_case", true, /Use 'case_insensitive'/],
      ["max_results", 10, /Use 'head_limit'/],
      ["limit", 10, /Use 'head_limit'/],
      ["skip", 10, /Use 'offset'/],
      ["before", 3, /Use 'context_before'/],
      ["after", 3, /Use 'context_after'/],
      ["cwd", "/tmp", /Use 'path'/],
    ];
    for (const [key, val, expected] of cases) {
      const r = safeParseGrepParams({ pattern: "foo", [key]: val });
      expect(r.ok, `expected ${key} to be rejected`).toBe(false);
      if (!r.ok) {
        const msg = r.issues.map((i) => i.message).join(" ");
        expect(msg, `hint for ${key} missing redirect`).toMatch(expected);
      }
    }
  });
});
