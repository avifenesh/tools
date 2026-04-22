import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeVcrFetch } from "../src/index.js";

function mkCassetteDir(): string {
  return mkdtempSync(path.join(tmpdir(), "vcr-"));
}

describe("makeVcrFetch", () => {
  it("records real responses and replays them byte-for-byte", async () => {
    const cassetteDir = mkCassetteDir();

    // Stub the global fetch to simulate an LLM backend. We call the VCR
    // wrapper directly so this test doesn't touch the network.
    const real = globalThis.fetch;
    let realCalls = 0;
    globalThis.fetch = (async () => {
      realCalls++;
      return new Response(JSON.stringify({ hello: "from-network" }), {
        status: 200,
        statusText: "OK",
      });
    }) as typeof fetch;

    try {
      const recording = makeVcrFetch({
        mode: "record",
        cassetteDir,
        cassetteName: "sample",
      });
      const res1 = await recording("https://example.invalid/api/chat", {
        method: "POST",
        body: JSON.stringify({ q: "hi" }),
      });
      expect(res1.status).toBe(200);
      expect(await res1.json()).toEqual({ hello: "from-network" });
      expect(realCalls).toBe(1);

      const files = readdirSync(cassetteDir);
      expect(files).toHaveLength(1);
      const entry = JSON.parse(
        readFileSync(path.join(cassetteDir, files[0]!), "utf8"),
      );
      expect(entry.response.status).toBe(200);

      const replaying = makeVcrFetch({
        mode: "replay",
        cassetteDir,
        cassetteName: "sample",
      });
      const res2 = await replaying("https://example.invalid/api/chat", {
        method: "POST",
        body: JSON.stringify({ q: "hi" }),
      });
      expect(await res2.json()).toEqual({ hello: "from-network" });
      // Critical: replay must not call the real fetch.
      expect(realCalls).toBe(1);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("replay throws when cassette is missing", async () => {
    const cassetteDir = mkCassetteDir();
    const replaying = makeVcrFetch({
      mode: "replay",
      cassetteDir,
      cassetteName: "missing",
    });
    await expect(
      replaying("https://example.invalid/", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow(/no cassette at/);
  });

  it("different bodies → different cassette files", async () => {
    const cassetteDir = mkCassetteDir();
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const recording = makeVcrFetch({
        mode: "record",
        cassetteDir,
        cassetteName: "keyed",
      });
      await recording("https://x/", { method: "POST", body: '{"a":1}' });
      await recording("https://x/", { method: "POST", body: '{"a":2}' });
      expect(readdirSync(cassetteDir)).toHaveLength(2);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("mode: off returns the real fetch", () => {
    const f = makeVcrFetch({
      mode: "off",
      cassetteDir: "/tmp/never-used",
      cassetteName: "noop",
    });
    expect(f).toBe(fetch);
  });
});
