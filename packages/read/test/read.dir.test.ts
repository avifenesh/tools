import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { read } from "../src/read.js";
import { makeSession, makeTempDir, writeFixture } from "./helpers.js";

describe("read — directories", () => {
  it("lists directory entries alphabetically with / suffix", async () => {
    const dir = makeTempDir();
    writeFixture(dir, "beta.txt", "x");
    writeFixture(dir, "alpha.txt", "x");
    mkdirSync(path.join(dir, "sub"));
    const r = await read({ path: dir }, makeSession(dir));
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    expect(r.output).toContain("alpha.txt");
    expect(r.output).toContain("beta.txt");
    expect(r.output).toContain("sub/");
    const alpha = r.output.indexOf("alpha.txt");
    const beta = r.output.indexOf("beta.txt");
    expect(alpha).toBeLessThan(beta);
    expect(r.meta.totalEntries).toBe(3);
  });

  it("paginates directory listings", async () => {
    const dir = makeTempDir();
    for (let i = 0; i < 10; i++) {
      writeFixture(dir, `f${i}.txt`, "x");
    }
    const r = await read({ path: dir, offset: 3, limit: 4 }, makeSession(dir));
    expect(r.kind).toBe("directory");
    if (r.kind !== "directory") return;
    expect(r.meta.returnedEntries).toBe(4);
    expect(r.meta.more).toBe(true);
  });
});

describe("read — not found + suggestions", () => {
  it("suggests similar siblings on NOT_FOUND", async () => {
    const dir = makeTempDir();
    writeFixture(dir, "readme.md", "x");
    writeFixture(dir, "README.md", "x");
    const r = await read(
      { path: path.join(dir, "readm.md") },
      makeSession(dir),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("NOT_FOUND");
    expect(r.error.message).toContain("Did you mean");
  });

  it("plain NOT_FOUND when no similar siblings", async () => {
    const dir = makeTempDir();
    const r = await read(
      { path: path.join(dir, "nothing-like-anything-else.xyz") },
      makeSession(dir),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("NOT_FOUND");
    expect(r.error.message).not.toContain("Did you mean");
  });
});
