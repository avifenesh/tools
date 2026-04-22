import { describe, expect, it } from "vitest";
import path from "node:path";
import { edit } from "../src/edit.js";
import {
  makeSession,
  makeTempDir,
  readFileUtf8,
  recordRead,
  writeFixture,
} from "./helpers.js";

describe("edit — golden path", () => {
  it("replaces a unique occurrence", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "hello world\n");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await edit(
      { path: target, old_string: "world", new_string: "there" },
      session,
    );
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(readFileUtf8(target)).toBe("hello there\n");
    expect(r.meta).toMatchObject({
      replacements: 1,
      bytes_delta: 0,
    });
  });
});

describe("edit — ledger gate", () => {
  it("refuses without a Read", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "hi\n");
    const r = await edit(
      { path: target, old_string: "hi", new_string: "bye" },
      makeSession(dir),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("NOT_READ_THIS_SESSION");
  });

  it("refuses stale reads", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "v1\n");
    const session = makeSession(dir);
    recordRead(session, target);
    writeFixture(dir, "a.txt", "v2\n");
    const r = await edit(
      { path: target, old_string: "v2", new_string: "v3" },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("STALE_READ");
    expect(r.error.message).toContain("Re-Read");
  });
});

describe("edit — NOT_FOUND with candidates", () => {
  it("returns top fuzzy candidates when old_string is a typo", async () => {
    const dir = makeTempDir();
    const target = writeFixture(
      dir,
      "code.js",
      "function calculateTotal(items) {\n  return 0;\n}\n",
    );
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await edit(
      {
        path: target,
        old_string: "function calculateTotals(items)",
        new_string: "function sum(items)",
      },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("OLD_STRING_NOT_FOUND");
    expect(r.error.message).toContain("Closest candidates");
  });
});

describe("edit — NOT_UNIQUE", () => {
  it("fails on multiple matches without replace_all", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "foo\nfoo\n");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await edit(
      { path: target, old_string: "foo", new_string: "bar" },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("OLD_STRING_NOT_UNIQUE");
    expect(r.error.meta?.match_count).toBe(2);
  });
});

describe("edit — replace_all", () => {
  it("replaces every occurrence", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "foo\nfoo\nfoo\n");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await edit(
      {
        path: target,
        old_string: "foo",
        new_string: "bar",
        replace_all: true,
      },
      session,
    );
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(readFileUtf8(target)).toBe("bar\nbar\nbar\n");
  });

  it("warns on substring-boundary collisions", async () => {
    const dir = makeTempDir();
    const target = writeFixture(
      dir,
      "a.txt",
      "user = 1\nusername = 'x'\nuser = 2\n",
    );
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await edit(
      {
        path: target,
        old_string: "user",
        new_string: "member",
        replace_all: true,
      },
      session,
    );
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(r.meta).toHaveProperty("warnings");
    expect(r.output).toContain("Warning:");
  });
});

describe("edit — dry_run", () => {
  it("returns a preview and does not touch disk", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "hello world\n");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await edit(
      {
        path: target,
        old_string: "world",
        new_string: "there",
        dry_run: true,
      },
      session,
    );
    expect(r.kind).toBe("preview");
    if (r.kind !== "preview") return;
    expect(r.diff).toContain("-hello world");
    expect(r.diff).toContain("+hello there");
    expect(readFileUtf8(target)).toBe("hello world\n");
  });
});

describe("edit — CRLF normalization", () => {
  it("matches LF old_string against CRLF content and preserves LF in output", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "win.txt", "a\r\nb\r\nc\r\n");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await edit(
      { path: target, old_string: "b", new_string: "B" },
      session,
    );
    expect(r.kind).toBe("text");
    expect(readFileUtf8(target)).toBe("a\nB\nc\n");
  });
});

describe("edit — refuses unsupported targets", () => {
  it("refuses Edit on binary files", async () => {
    const dir = makeTempDir();
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 0, 0, 0]);
    const target = writeFixture(dir, "blob.bin", bytes);
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await edit(
      { path: target, old_string: "\x01", new_string: "\x02" },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("BINARY_NOT_EDITABLE");
  });

  it("refuses Edit on notebooks (.ipynb)", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.ipynb", "{}");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await edit(
      { path: target, old_string: "{}", new_string: "{}" },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("NOTEBOOK_UNSUPPORTED");
  });

  it("refuses when file does not exist", async () => {
    const dir = makeTempDir();
    const session = makeSession(dir);
    const r = await edit(
      {
        path: path.join(dir, "nope.txt"),
        old_string: "a",
        new_string: "b",
      },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("NOT_FOUND");
  });
});

describe("edit — validate hook", () => {
  it("leaves the file unchanged when the hook rejects", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "a.txt", "hello\n");
    const session = makeSession(dir, {
      validate: async () => ({
        ok: false,
        errors: [{ message: "banned word" }],
      }),
    });
    recordRead(session, target);
    const r = await edit(
      { path: target, old_string: "hello", new_string: "BANNED" },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("VALIDATE_FAILED");
    expect(readFileUtf8(target)).toBe("hello\n");
  });
});
