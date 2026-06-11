import { describe, expect, it } from "vitest";
import { multiEdit } from "../src/multiedit.js";
import {
  makeSession,
  makeTempDir,
  readFileUtf8,
  recordRead,
  writeFixture,
} from "./helpers.js";

describe("multiEdit — sequential composition", () => {
  it("applies edits in order, later sees earlier output", async () => {
    const dir = makeTempDir();
    const target = writeFixture(
      dir,
      "a.js",
      "function foo() {\n  return 1;\n}\n",
    );
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await multiEdit(
      {
        path: target,
        edits: [
          { old_string: "foo", new_string: "bar" },
          { old_string: "return 1", new_string: "return 2" },
        ],
      },
      session,
    );
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(readFileUtf8(target)).toBe("function bar() {\n  return 2;\n}\n");
    expect(r.meta).toMatchObject({
      edits_applied: 2,
      total_replacements: 2,
    });
  });
});

describe("multiEdit — atomic fail-fast", () => {
  it("applies nothing if any edit fails", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "alpha beta gamma\n");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await multiEdit(
      {
        path: target,
        edits: [
          { old_string: "alpha", new_string: "A" },
          { old_string: "delta", new_string: "D" },
        ],
      },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("OLD_STRING_NOT_FOUND");
    expect(r.error.message).toContain("edit[1]");
    expect(readFileUtf8(target)).toBe("alpha beta gamma\n");
  });

  it("tags error meta with edit_index", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "x\n");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await multiEdit(
      {
        path: target,
        edits: [
          { old_string: "x", new_string: "y" },
          { old_string: "z", new_string: "w" },
        ],
      },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.meta?.edit_index).toBe(1);
  });
});

describe("multiEdit — dry_run", () => {
  it("returns preview and doesn't mutate disk", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "foo\nbar\n");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await multiEdit(
      {
        path: target,
        dry_run: true,
        edits: [
          { old_string: "foo", new_string: "FOO" },
          { old_string: "bar", new_string: "BAR" },
        ],
      },
      session,
    );
    expect(r.kind).toBe("preview");
    if (r.kind !== "preview") return;
    expect(r.diff).toContain("-foo");
    expect(r.diff).toContain("+FOO");
    expect(r.diff).toContain("-bar");
    expect(r.diff).toContain("+BAR");
    expect(readFileUtf8(target)).toBe("foo\nbar\n");
  });
});

describe("multiEdit — read-before-mutate gate (fail-open)", () => {
  it("edits an un-Read file (no hook): succeeds with a gate warning", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "x\ny\n");
    const r = await multiEdit(
      {
        path: target,
        edits: [
          { old_string: "x", new_string: "X" },
          { old_string: "y", new_string: "Y" },
        ],
      },
      makeSession(dir),
    );
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(readFileUtf8(target)).toBe("X\nY\n");
    expect(r.output).toContain("Warning:");
    expect(r.output).toContain("not Read in this session");
    expect(r.meta).toHaveProperty("warnings");
    if (!("warnings" in r.meta)) return;
    expect(r.meta.warnings?.[0]).toContain("not Read in this session");
  });

  it("refuses an un-Read file when the permission hook denies", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "x\n");
    const session = makeSession(dir, {
      permissions: {
        roots: [dir],
        sensitivePatterns: [],
        hook: async () => "deny",
      },
    });
    const r = await multiEdit(
      { path: target, edits: [{ old_string: "x", new_string: "X" }] },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("DENIED_BY_HOOK");
    expect(readFileUtf8(target)).toBe("x\n");
  });
});

describe("multiEdit — rejects empty edits array", () => {
  it("fails schema validation", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "x\n");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await multiEdit(
      { path: target, edits: [] },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("INVALID_PARAM");
  });
});

describe("multiEdit — tool name: canonical + deprecated legacy alias", () => {
  it("exports multi_edit as canonical and multiedit as the legacy alias", async () => {
    const schema = await import("../src/schema.js");
    expect(schema.MULTIEDIT_TOOL_NAME).toBe("multi_edit");
    expect(schema.MULTIEDIT_TOOL_NAME_LEGACY).toBe("multiedit");
    expect(schema.multieditToolDefinition.name).toBe("multi_edit");
  });

  it("isMultiEditToolName is a pure matcher; normalize warns once for the legacy spelling only", async () => {
    const { isMultiEditToolName, normalizeMultiEditToolName } = await import(
      "../src/schema.js"
    );
    const { vi } = await import("vitest");
    const warnSpy = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => undefined);
    try {
      // Pure predicate: matches both spellings, never emits the warning.
      expect(isMultiEditToolName("multi_edit")).toBe(true);
      expect(isMultiEditToolName("multiedit")).toBe(true);
      expect(isMultiEditToolName("multi-edit")).toBe(false);
      expect(isMultiEditToolName("MultiEdit")).toBe(false);
      expect(isMultiEditToolName("edit")).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();

      // Canonical name normalizes silently.
      expect(normalizeMultiEditToolName("multi_edit")).toBe("multi_edit");
      expect(warnSpy).not.toHaveBeenCalled();

      // Legacy alias normalizes to canonical and warns exactly once per process.
      expect(normalizeMultiEditToolName("multiedit")).toBe("multi_edit");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message, type] = warnSpy.mock.calls[0] ?? [];
      expect(String(message)).toContain('"multiedit" is deprecated');
      expect(String(message)).toContain('"multi_edit"');
      expect(String(message)).toContain("removed in a future major");
      expect(type).toBe("DeprecationWarning");

      // Repeat legacy use: still normalizes, no log spam.
      expect(normalizeMultiEditToolName("multiedit")).toBe("multi_edit");
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Non-names never normalize.
      expect(normalizeMultiEditToolName("multi-edit")).toBeUndefined();
      expect(normalizeMultiEditToolName("MultiEdit")).toBeUndefined();
      expect(normalizeMultiEditToolName("edit")).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("reports multi_edit as the tool label to permission hooks", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "hooked.txt", "x\n");
    const base = makeSession(dir);
    recordRead(base, target);
    const seen: string[] = [];
    const session = {
      ...base,
      permissions: {
        ...base.permissions,
        sensitivePatterns: ["**/hooked.txt"],
        hook: async (req: { tool: string }) => {
          seen.push(req.tool);
          return "allow" as const;
        },
      },
    };
    const r = await multiEdit(
      { path: target, edits: [{ old_string: "x", new_string: "X" }] },
      session,
    );
    expect(r.kind).toBe("text");
    expect(seen).toEqual(["multi_edit"]);
  });

  it("reports multi_edit on the read-before-mutate hook query too (un-Read file)", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "unread.txt", "x\n");
    const base = makeSession(dir);
    // No recordRead: the file has no ledger entry, so the fail-open gate in
    // preflightMutation issues a second hook query (action "write_unread").
    const seen: { tool: string; action: string }[] = [];
    const session = {
      ...base,
      permissions: {
        ...base.permissions,
        hook: async (req: { tool: string; action: string }) => {
          seen.push({ tool: req.tool, action: req.action });
          return "allow" as const;
        },
      },
    };
    const r = await multiEdit(
      { path: target, edits: [{ old_string: "x", new_string: "X" }] },
      session,
    );
    expect(r.kind).toBe("text");
    // Every hook query a MultiEdit call makes carries the same tool label.
    expect(seen).toEqual([
      { tool: "multi_edit", action: "edit" },
      { tool: "multi_edit", action: "write_unread" },
    ]);
  });
});
