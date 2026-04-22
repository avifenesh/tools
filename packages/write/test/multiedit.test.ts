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
