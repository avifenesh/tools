import { describe, expect, it } from "vitest";
import { safeParseGlobParams } from "../src/schema.js";

describe("glob schema", () => {
  it("accepts a minimal pattern", () => {
    const r = safeParseGlobParams({ pattern: "**/*.ts" });
    expect(r.ok).toBe(true);
  });

  it("rejects an empty pattern", () => {
    const r = safeParseGlobParams({ pattern: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing pattern", () => {
    const r = safeParseGlobParams({});
    expect(r.ok).toBe(false);
  });

  it("accepts all optional fields", () => {
    const r = safeParseGlobParams({
      pattern: "**/*.ts",
      path: "/tmp",
      head_limit: 500,
      offset: 100,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects head_limit < 1", () => {
    const r = safeParseGlobParams({ pattern: "foo", head_limit: 0 });
    expect(r.ok).toBe(false);
  });

  it("rejects offset < 0", () => {
    const r = safeParseGlobParams({ pattern: "foo", offset: -1 });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown key via strictObject", () => {
    const r = safeParseGlobParams({ pattern: "foo", bogus: true } as unknown);
    expect(r.ok).toBe(false);
  });

  it("redirects 'regex' alias to 'pattern' with grep hint", () => {
    const r = safeParseGlobParams({ regex: "foo" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/Glob uses glob syntax, not regex/);
      expect(msg).toMatch(/use the grep tool/);
    }
  });

  it("redirects 'glob' alias to 'pattern'", () => {
    const r = safeParseGlobParams({ glob: "**/*.ts" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/this tool IS glob/);
    }
  });

  it("redirects 'recursive' alias with pattern guidance", () => {
    const r = safeParseGlobParams({ pattern: "*.ts", recursive: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/prefix with '\*\*\/'/);
    }
  });

  it("redirects common alias typos", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["query", "foo", /Use 'pattern'/],
      ["filter", "foo", /Use 'pattern'/],
      ["file_pattern", "foo", /Use 'pattern'/],
      ["name", "foo", /Use 'pattern'/],
      ["dir", "/tmp", /Use 'path'/],
      ["directory", "/tmp", /Use 'path'/],
      ["dir_path", "/tmp", /Use 'path'/],
      ["cwd", "/tmp", /Use 'path'/],
      ["root", "/tmp", /Use 'path'/],
      ["limit", 10, /Use 'head_limit'/],
      ["max_results", 10, /Use 'head_limit'/],
      ["skip", 10, /Use 'offset'/],
      ["max_depth", 3, /controlled by the pattern/],
      ["case_sensitive", true, /case-insensitive by default/],
      ["include_hidden", true, /session-config decision/],
      ["no_ignore", true, /on by default/],
      ["follow_symlinks", true, /not followed/],
      ["exclude", "node_modules", /negated glob pattern/],
    ];
    for (const [key, val, expected] of cases) {
      const r = safeParseGlobParams({ pattern: "foo", [key]: val });
      expect(r.ok, `expected ${key} to be rejected`).toBe(false);
      if (!r.ok) {
        const msg = r.issues.map((i) => i.message).join(" ");
        expect(msg, `hint for ${key} missing redirect`).toMatch(expected);
      }
    }
  });
});
