import { describe, expect, it } from "vitest";
import { DEFAULT_SENSITIVE_PATTERNS } from "@agent-sh/harness-core";
import { read } from "../src/read.js";
import { makeSession, makeTempDir, writeFixture } from "./helpers.js";

describe("read — permissions", () => {
  it("blocks .env as SENSITIVE when no hook is present", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, ".env", "SECRET=x\n");
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("SENSITIVE");
  });

  it("blocks *.pem as SENSITIVE when no hook is present", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, "cert.pem", "-----BEGIN-----\n");
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("SENSITIVE");
  });

  it("asks the hook for .env when a hook is provided; allow -> reads", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, ".env", "SECRET=x\n");
    const seen: { reason?: unknown }[] = [];
    const r = await read(
      { path: p },
      makeSession(dir, {
        permissions: {
          roots: [dir],
          sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
          hook: async (req) => {
            seen.push({ reason: req.metadata.reason });
            return "allow";
          },
        },
      }),
    );
    expect(r.kind).toBe("text");
    expect(seen[0]?.reason).toBe("sensitive");
  });

  it("asks the hook for .env when a hook is provided; deny -> PERMISSION_DENIED", async () => {
    const dir = makeTempDir();
    const p = writeFixture(dir, ".env", "SECRET=x\n");
    const r = await read(
      { path: p },
      makeSession(dir, {
        permissions: {
          roots: [dir],
          sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
          hook: async () => "deny",
        },
      }),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("PERMISSION_DENIED");
  });

  it("blocks path outside workspace when no hook", async () => {
    const inside = makeTempDir();
    const outside = makeTempDir();
    const p = writeFixture(outside, "x.txt", "hi\n");
    const r = await read({ path: p }, makeSession(inside));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("OUTSIDE_WORKSPACE");
  });

  it("allows outside workspace when hook grants allow", async () => {
    const inside = makeTempDir();
    const outside = makeTempDir();
    const p = writeFixture(outside, "x.txt", "hi\n");
    const r = await read(
      { path: p },
      makeSession(inside, {
        permissions: {
          roots: [inside],
          sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
          hook: async () => "allow",
        },
      }),
    );
    expect(r.kind).toBe("text");
  });

  it("denies when hook returns deny", async () => {
    const inside = makeTempDir();
    const outside = makeTempDir();
    const p = writeFixture(outside, "x.txt", "hi\n");
    const r = await read(
      { path: p },
      makeSession(inside, {
        permissions: {
          roots: [inside],
          sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
          hook: async () => "deny",
        },
      }),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("PERMISSION_DENIED");
  });

  it("bypassWorkspaceGuard lets outside paths through", async () => {
    const inside = makeTempDir();
    const outside = makeTempDir();
    const p = writeFixture(outside, "x.txt", "hi\n");
    const r = await read(
      { path: p },
      makeSession(inside, {
        permissions: {
          roots: [inside],
          sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
          bypassWorkspaceGuard: true,
        },
      }),
    );
    expect(r.kind).toBe("text");
  });
});
