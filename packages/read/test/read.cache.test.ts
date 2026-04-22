import { utimesSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { read } from "../src/read.js";
import {
  makeSessionWithCache,
  makeTempDir,
  writeFixture,
} from "./helpers.js";

describe("read — cache and ledger", () => {
  it("caches on first read and returns cached on second", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "c.txt", "one\ntwo\n");
    const session = makeSessionWithCache(dir);

    const r1 = await read({ path: p }, session);
    expect(r1.kind).toBe("text");

    const r2 = await read({ path: p }, session);
    expect(r2.kind).toBe("text");
    if (r1.kind !== "text" || r2.kind !== "text") return;
    expect(r2.output).toBe(r1.output);
    expect(r2.meta.sha256).toBe(r1.meta.sha256);
  });

  it("invalidates cache on mtime change", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "c.txt", "one\n");
    const session = makeSessionWithCache(dir);

    const r1 = await read({ path: p }, session);
    expect(r1.kind).toBe("text");

    writeFixture(dir, "c.txt", "one\ntwo\n");
    const future = new Date(Date.now() + 5000);
    utimesSync(p, future, future);

    const r2 = await read({ path: p }, session);
    expect(r2.kind).toBe("text");
    if (r1.kind !== "text" || r2.kind !== "text") return;
    expect(r2.meta.sha256).not.toBe(r1.meta.sha256);
    expect(r2.meta.totalLines).toBe(2);
  });

  it("records ledger entry on each read (including cache hits)", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "c.txt", "one\n");
    const session = makeSessionWithCache(dir);

    await read({ path: p }, session);
    await read({ path: p }, session);

    const entries = session.ledger.getAll(p);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const e of entries) {
      expect(e.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(e.size_bytes).toBe(4);
    }
  });
});

describe("read — concurrent reads serialize", () => {
  it("returns consistent output for many concurrent reads", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "race.txt", "alpha\nbeta\ngamma\n");
    const session = makeSessionWithCache(dir);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => read({ path: p }, session)),
    );
    for (const r of results) {
      expect(r.kind).toBe("text");
      if (r.kind !== "text") return;
      expect(r.meta.totalLines).toBe(3);
    }
  });
});
