import { describe, expect, it } from "vitest";
import { read } from "../src/read.js";
import { makeSession, makeTempDir, writeFixture } from "./helpers.js";

describe("read — text files", () => {
  it("reads a small file with line numbers", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "hello.txt", "one\ntwo\nthree\n");
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(r.output).toContain("1: one");
    expect(r.output).toContain("2: two");
    expect(r.output).toContain("3: three");
    expect(r.output).toContain("(End of file · 3 lines total)");
    expect(r.meta.totalLines).toBe(3);
    expect(r.meta.returnedLines).toBe(3);
  });

  it("resolves relative paths against cwd", async () => {
    const dir = makeTempDir();
    writeFixture(dir, "rel.txt", "hi\n");
    const r = await read({ path: "rel.txt" }, makeSession(dir));
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(r.output).toContain("1: hi");
  });

  it("returns empty-file sentinel", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "empty.txt", "");
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(r.output).toContain("(File exists but is empty)");
  });

  it("paginates with offset and limit", async () => {
    const dir = makeTempDir();
    const lines = Array.from({ length: 1000 }, (_, i) => `L${i + 1}`);
    const p = writeFixture(dir, "big.txt", lines.join("\n") + "\n");
    const r = await read({ path: p, offset: 500, limit: 10 }, makeSession(dir));
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(r.output).toContain("500: L500");
    expect(r.output).toContain("509: L509");
    expect(r.output).not.toContain("499:");
    expect(r.output).not.toContain("510:");
    expect(r.output).toContain("Showing lines 500-509 of 1000");
    expect(r.output).toContain("51% covered");
    expect(r.output).toContain("491 lines remaining");
    expect(r.output).toContain("Next offset: 510");
    expect(r.meta.more).toBe(true);
  });

  it("rejects offset past end of file", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "short.txt", "a\nb\nc\n");
    const r = await read({ path: p, offset: 100 }, makeSession(dir));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("INVALID_PARAM");
    expect(r.error.message).toContain("out of range");
  });

  it("normalizes CRLF to LF in output (readline strips both)", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "crlf.txt", "a\r\nb\r\nc\r\n");
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(r.output).toContain("1: a");
    expect(r.output).toContain("2: b");
    expect(r.output).toContain("3: c");
    expect(r.output).not.toContain("\r");
  });

  it("truncates over-long lines", async () => {
    const dir = makeTempDir();
    const longLine = "x".repeat(5000);
    const p = writeFixture(dir, "long.txt", longLine + "\n");
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(r.output).toContain("(line truncated to 2000 chars)");
    expect(r.output).not.toContain("x".repeat(5000));
  });

  it("applies byte cap and signals continuation", async () => {
    const dir = makeTempDir();
    const line = "y".repeat(500);
    const lines = Array.from({ length: 500 }, () => line);
    const p = writeFixture(dir, "bytes.txt", lines.join("\n") + "\n");
    const r = await read({ path: p, limit: 10000 }, makeSession(dir));
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    expect(r.meta.byteCap).toBe(true);
    expect(r.output).toContain("Output capped at");
  });
});
