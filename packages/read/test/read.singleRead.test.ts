import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReadOperations } from "@agent-sh/harness-core";
import { read } from "../src/read.js";
import type { ReadSessionConfig } from "../src/types.js";

/**
 * Perf + correctness regression guard for finding #4 (double-read).
 *
 * Before the fix, a single text `read` touched the file three times:
 *   1. readSample        -> ops.readFile        (binary sniff)
 *   2. streamLines       -> ops.openLineStream  (line content, a SECOND OS read)
 *   3. sha256            -> ops.readFile         (hash, a THIRD read)
 *
 * The fix collapses (2) and (3): readText reads the bytes ONCE and reuses
 * them for both the sha256 and the line content via streamLinesFromBytes,
 * so openLineStream is never opened. The binary-sniff read in readSample is
 * a separate concern and intentionally left untouched, so a full text read
 * now performs exactly two ops.readFile calls (sniff + content) and zero
 * openLineStream opens. This test wraps a counting ReadOperations and asserts:
 *   - readFile is called twice (sniff + content) — never the old three reads,
 *   - openLineStream is never opened (the double-read is gone),
 *   - the returned content is correct,
 *   - the returned sha256 matches a hash computed independently.
 */

const FIXTURE = "alpha\nbeta\ngamma\n";
const FIXTURE_BYTES = new Uint8Array(Buffer.from(FIXTURE, "utf8"));
const PATH = "/virtual/facts.txt";

interface Counts {
  readFile: number;
  openLineStream: number;
}

function countingOps(counts: Counts): ReadOperations {
  return {
    async stat() {
      return {
        type: "file",
        size: FIXTURE_BYTES.byteLength,
        mtime_ms: 1_000,
        readonly: false,
      };
    },
    async readFile() {
      counts.readFile += 1;
      return FIXTURE_BYTES;
    },
    async readDirectory() {
      return [];
    },
    async readDirectoryEntries() {
      return [];
    },
    async realpath(p) {
      return p;
    },
    mimeType() {
      return "text/plain";
    },
    openLineStream() {
      counts.openLineStream += 1;
      // If the fix is correct this must never be invoked for text reads.
      throw new Error("openLineStream must not be called after single-read fix");
    },
  };
}

function session(ops: ReadOperations): ReadSessionConfig {
  return {
    cwd: "/virtual",
    ops,
    permissions: {
      roots: ["/virtual"],
      sensitivePatterns: [],
      bypassWorkspaceGuard: true,
    },
  };
}

describe("read — single underlying read (finding #4 regression)", () => {
  it("never re-streams the file: sniff + content reads only, no openLineStream", async () => {
    const counts: Counts = { readFile: 0, openLineStream: 0 };
    const r = await read({ path: PATH }, session(countingOps(counts)));

    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;

    // The whole point of the fix: the sha256 + line content share ONE read
    // (no openLineStream, no third hash read). The binary-sniff read in
    // readSample is a separate concern, so the total is exactly two reads.
    expect(counts.readFile).toBe(2);
    expect(counts.openLineStream).toBe(0);
  });

  it("returns correct content and a sha256 matching the read bytes", async () => {
    const counts: Counts = { readFile: 0, openLineStream: 0 };
    const r = await read({ path: PATH }, session(countingOps(counts)));

    expect(r.kind).toBe("text");
    if (r.kind !== "text") return;

    expect(r.output).toContain("1: alpha");
    expect(r.output).toContain("2: beta");
    expect(r.output).toContain("3: gamma");
    expect(r.meta.totalLines).toBe(3);
    expect(r.meta.returnedLines).toBe(3);

    const expected = createHash("sha256").update(FIXTURE_BYTES).digest("hex");
    expect(r.meta.sha256).toBe(expected);
  });
});
