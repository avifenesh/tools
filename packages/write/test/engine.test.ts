import { describe, expect, it } from "vitest";
import { applyEdit, applyPipeline } from "../src/engine.js";

describe("engine — applyEdit", () => {
  it("replaces a unique occurrence", () => {
    const r = applyEdit("hello world\n", {
      old_string: "world",
      new_string: "there",
    });
    if ("code" in r) throw new Error(`unexpected error: ${r.code}`);
    expect(r.content).toBe("hello there\n");
    expect(r.replacements).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("returns OLD_STRING_NOT_FOUND with fuzzy candidates", () => {
    const r = applyEdit(
      "function calculateTotal(items) {\n  return items.reduce(...);\n}\n",
      {
        old_string: "function calculateTotals(items)",
        new_string: "function sum(items)",
      },
    );
    if (!("code" in r)) throw new Error("expected error");
    expect(r.code).toBe("OLD_STRING_NOT_FOUND");
    expect(r.message).toContain("Closest candidates");
    expect(r.meta?.candidates).toBeDefined();
  });

  it("returns OLD_STRING_NOT_UNIQUE when multiple matches without replace_all", () => {
    const content = "foo\nbar\nfoo\nbaz\n";
    const r = applyEdit(content, {
      old_string: "foo",
      new_string: "qux",
    });
    if (!("code" in r)) throw new Error("expected error");
    expect(r.code).toBe("OLD_STRING_NOT_UNIQUE");
    expect(r.meta?.match_count).toBe(2);
  });

  it("replaces all occurrences when replace_all is true", () => {
    const r = applyEdit("foo\nbar\nfoo\n", {
      old_string: "foo",
      new_string: "qux",
      replace_all: true,
    });
    if ("code" in r) throw new Error(`unexpected error: ${r.code}`);
    expect(r.content).toBe("qux\nbar\nqux\n");
    expect(r.replacements).toBe(2);
  });

  it("flags substring-boundary collisions with replace_all", () => {
    const r = applyEdit("user = 1\nusername = 'x'\nuser = 2\n", {
      old_string: "user",
      new_string: "member",
      replace_all: true,
    });
    if ("code" in r) throw new Error(`unexpected error: ${r.code}`);
    expect(r.replacements).toBe(3);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toContain("adjacent to identifier characters");
  });

  it("rejects no-op edits", () => {
    const r = applyEdit("hello\n", {
      old_string: "hello",
      new_string: "hello",
    });
    if (!("code" in r)) throw new Error("expected error");
    expect(r.code).toBe("NO_OP_EDIT");
  });

  it("rejects edits against empty files", () => {
    const r = applyEdit("", {
      old_string: "x",
      new_string: "y",
    });
    if (!("code" in r)) throw new Error("expected error");
    expect(r.code).toBe("EMPTY_FILE");
  });

  it("normalizes CRLF on both needle and haystack", () => {
    const r = applyEdit("a\r\nb\r\nc\r\n", {
      old_string: "b\nc",
      new_string: "B\nC",
    });
    if ("code" in r) throw new Error(`unexpected error: ${r.code}`);
    expect(r.content).toBe("a\nB\nC\n");
  });
});

describe("engine — applyPipeline", () => {
  it("applies edits sequentially, later sees earlier output", () => {
    const r = applyPipeline("foo\nbar\n", [
      { old_string: "foo", new_string: "FOO" },
      { old_string: "FOO", new_string: "baz" },
    ]);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.content).toBe("baz\nbar\n");
    expect(r.totalReplacements).toBe(2);
  });

  it("fails fast on first error without applying subsequent edits", () => {
    const r = applyPipeline("alpha\n", [
      { old_string: "alpha", new_string: "beta" },
      { old_string: "gamma", new_string: "delta" },
    ]);
    if (r.kind !== "err") throw new Error("expected err");
    expect(r.index).toBe(1);
    expect(r.error.code).toBe("OLD_STRING_NOT_FOUND");
    expect(r.error.message).toContain("edit[1]");
  });

  it("prefixes warnings with edit index", () => {
    const r = applyPipeline("user = 1\nusername = 'x'\n", [
      { old_string: "user", new_string: "member", replace_all: true },
    ]);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.warnings[0]).toMatch(/^edit\[0\]:/);
  });
});
