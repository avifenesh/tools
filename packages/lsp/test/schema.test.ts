import { describe, expect, it } from "vitest";
import { safeParseLspParams } from "../src/schema.js";

describe("lsp schema", () => {
  it("accepts minimal hover", () => {
    const r = safeParseLspParams({
      operation: "hover",
      path: "/x.ts",
      line: 1,
      character: 1,
    });
    expect(r.ok).toBe(true);
  });

  it("accepts documentSymbol without position", () => {
    const r = safeParseLspParams({
      operation: "documentSymbol",
      path: "/x.ts",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts workspaceSymbol with just a query", () => {
    const r = safeParseLspParams({
      operation: "workspaceSymbol",
      query: "UserService",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown operation", () => {
    const r = safeParseLspParams({ operation: "rename", path: "/x.ts" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing required path for hover", () => {
    const r = safeParseLspParams({ operation: "hover", line: 1, character: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/requires 'path'/);
    }
  });

  it("rejects missing line/character for references", () => {
    const r = safeParseLspParams({ operation: "references", path: "/x.ts" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/requires 'line' and 'character'/);
    }
  });

  it("rejects line 0 (1-indexed)", () => {
    const r = safeParseLspParams({
      operation: "hover",
      path: "/x.ts",
      line: 0,
      character: 1,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects character 0 (1-indexed)", () => {
    const r = safeParseLspParams({
      operation: "hover",
      path: "/x.ts",
      line: 1,
      character: 0,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects empty query for workspaceSymbol", () => {
    const r = safeParseLspParams({ operation: "workspaceSymbol", query: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown fields via strictObject", () => {
    const r = safeParseLspParams({
      operation: "hover",
      path: "/x.ts",
      line: 1,
      character: 1,
      bogus: true,
    } as unknown);
    expect(r.ok).toBe(false);
  });

  it("redirects 'op' alias to 'operation'", () => {
    const r = safeParseLspParams({ op: "hover", path: "/x.ts" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/Use 'operation' instead/);
    }
  });

  it("redirects common alias typos", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["action", "hover", /Use 'operation'/],
      ["file", "/x.ts", /Use 'path'/],
      ["file_path", "/x.ts", /Use 'path'/],
      ["uri", "/x.ts", /Use 'path'/],
      ["row", 1, /Use 'line'/],
      ["line_number", 1, /Use 'line'/],
      ["col", 1, /Use 'character'/],
      ["column", 1, /Use 'character'/],
      ["offset", 1, /Use 'character'/],
      ["symbol", "x", /Use 'query'/],
      ["term", "x", /Use 'query'/],
      ["pattern", "x", /Use 'query'/],
      ["limit", 10, /Use 'head_limit'/],
      ["language", "ts", /detected automatically from the 'path'/],
      ["include_declaration", true, /always include the declaration/],
      ["didOpen", true, /handled internally/],
      ["range", "x", /single position/],
    ];
    for (const [key, val, expected] of cases) {
      const r = safeParseLspParams({
        operation: "hover",
        path: "/x.ts",
        line: 1,
        character: 1,
        [key]: val,
      });
      expect(r.ok, `expected ${key} to be rejected`).toBe(false);
      if (!r.ok) {
        const msg = r.issues.map((i) => i.message).join(" ");
        expect(msg, `hint for ${key}`).toMatch(expected);
      }
    }
  });
});
