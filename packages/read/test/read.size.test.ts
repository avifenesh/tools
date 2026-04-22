import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { read } from "../src/read.js";
import { makeSession, makeTempDir, writeFixture } from "./helpers.js";

describe("read — size and context guards", () => {
  it("TOO_LARGE when file exceeds maxFileSize", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "big.txt", "x".repeat(10_000));
    const r = await read(
      { path: p },
      makeSession(dir, { maxFileSize: 100 }),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("TOO_LARGE");
  });

  it("TOO_LARGE when file would consume > half of context", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "ctx.txt", "x".repeat(10_000));
    const r = await read(
      { path: p },
      makeSession(dir, { modelContextTokens: 1000, tokensPerByte: 1 }),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("TOO_LARGE");
  });
});

describe("read — sha256 in meta", () => {
  it("matches actual file sha256", async () => {
    const dir = makeTempDir();
    const content = "alpha\nbeta\ngamma\n";
    const p = writeFixture(dir, "hash.txt", content);
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;
    const expected = createHash("sha256")
      .update(readFileSync(p))
      .digest("hex");
    expect(r.meta.sha256).toBe(expected);
  });
});
