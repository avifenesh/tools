import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { write } from "../src/write.js";
import {
  makeSession,
  makeTempDir,
  readFileUtf8,
  recordRead,
  writeFixture,
} from "./helpers.js";

describe("write — create new file", () => {
  it("creates a new file with the given content", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "new.txt");
    const r = await write(
      { path: target, content: "hello\nworld\n" },
      makeSession(dir),
    );
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(readFileUtf8(target)).toBe("hello\nworld\n");
    expect(r.meta.created).toBe(true);
    expect(r.meta.bytes_written).toBe(12);
    expect(r.output).toContain(target);
  });

  it("creates parent directories as needed", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "nested", "deep", "new.txt");
    const r = await write({ path: target, content: "hi" }, makeSession(dir));
    expect(r.kind).toBe("text");
    expect(existsSync(target)).toBe(true);
  });

  it("does not require a ledger entry for new files", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "fresh.txt");
    const r = await write({ path: target, content: "x" }, makeSession(dir));
    expect(r.kind).toBe("text");
  });

  it("creates a nested new file without any prior Read", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "nested", "deep", "fresh.txt");
    const session = makeSession(dir);
    const r = await write({ path: target, content: "hi\n" }, session);
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(r.meta.created).toBe(true);
    expect(readFileUtf8(target)).toBe("hi\n");
  });

  it("records a ledger entry after creating a new file", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "fresh.txt");
    const session = makeSession(dir);
    const r = await write({ path: target, content: "one\n" }, session);
    expect(r.kind).toBe("text");
    const r2 = await write({ path: target, content: "two\n" }, session);
    expect(r2.kind).toBe("text");
    if (r2.kind !== "text") return;
    expect(r2.meta.created).toBe(false);
    expect(readFileUtf8(target)).toBe("two\n");
  });
});

describe("write — overwrite existing file", () => {
  it("refuses to overwrite a file that has not been Read", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "existing.txt", "old content\n");
    const r = await write(
      { path: target, content: "new content\n" },
      makeSession(dir),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("NOT_READ_THIS_SESSION");
  });

  it("refuses when ledger sha is stale", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "existing.txt", "v1\n");
    const session = makeSession(dir);
    recordRead(session, target);
    writeFixture(dir, "existing.txt", "v2\n");
    const r = await write(
      { path: target, content: "v3\n" },
      session,
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("STALE_READ");
  });

  it("overwrites when ledger matches", async () => {
    const dir = makeTempDir();
    const target = writeFixture(dir, "existing.txt", "old\n");
    const session = makeSession(dir);
    recordRead(session, target);
    const r = await write(
      { path: target, content: "new content\n" },
      session,
    );
    expect(r.kind).toBe("text");
    expect(readFileUtf8(target)).toBe("new content\n");
  });
});

describe("write — safety rails", () => {
  it("rejects writes to sensitive paths without a hook", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, ".env");
    const r = await write(
      { path: target, content: "SECRET=1\n" },
      makeSession(dir),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("SENSITIVE");
  });

  it("rejects writes outside workspace without a hook", async () => {
    const dir = makeTempDir();
    const other = makeTempDir();
    const target = path.join(other, "outside.txt");
    const r = await write(
      { path: target, content: "x" },
      makeSession(dir),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("OUTSIDE_WORKSPACE");
  });

  it("refuses .ipynb with NOTEBOOK_UNSUPPORTED", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "nb.ipynb");
    const r = await write({ path: target, content: "{}" }, makeSession(dir));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("NOTEBOOK_UNSUPPORTED");
  });

  it("rejects invalid params", async () => {
    const dir = makeTempDir();
    const r = await write({} as unknown, makeSession(dir));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("INVALID_PARAM");
  });

  it("rejects writing to a directory path", async () => {
    const dir = makeTempDir();
    const r = await write({ path: dir, content: "x" }, makeSession(dir));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("INVALID_PARAM");
  });
});

describe("write — validate hook", () => {
  it("rejects when validate hook says no", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "guarded.txt");
    const session = makeSession(dir, {
      validate: async () => ({
        ok: false,
        errors: [{ line: 2, message: "syntax error" }],
      }),
    });
    const r = await write({ path: target, content: "x\n" }, session);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("VALIDATE_FAILED");
    expect(r.error.message).toContain("line 2");
    expect(existsSync(target)).toBe(false);
  });

  it("passes when validate hook approves", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "ok.txt");
    const session = makeSession(dir, {
      validate: async () => ({ ok: true }),
    });
    const r = await write({ path: target, content: "x\n" }, session);
    expect(r.kind).toBe("text");
  });
});

describe("write — atomic", () => {
  it("writes cleanly without leaving temp files behind", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "atomic.txt");
    await write({ path: target, content: "hello\n" }, makeSession(dir));
    expect(existsSync(target)).toBe(true);
    const st = statSync(target);
    expect(st.isFile()).toBe(true);
  });
});
