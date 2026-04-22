/**
 * Sanity smoke for the Rust grep bridge: one direct call through the
 * Rust CLI binary to prove the wire contract works end-to-end. Not a
 * full e2e (that runs against the model matrix) — just verifies the
 * orchestrator + spawn + JSON-RPC + session-shape handshake.
 */

import { existsSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SENSITIVE_PATTERNS } from "@agent-sh/harness-core";
import type { GrepSessionConfig } from "@agent-sh/harness-grep";
import { makeGrepExecutorRust } from "../src/index.js";

const binPath =
  process.env.HARNESS_GREP_RUST_BIN ??
  path.join(
    process.env.CARGO_TARGET_DIR ?? path.join(process.env.HOME ?? ".", "rust-target-harness"),
    "debug",
    "harness-grep-cli",
  );

const binExists = existsSync(binPath);

describe("grep rust bridge smoke", () => {
  it.runIf(binExists)(
    "round-trips a files_with_matches query via the spawned binary",
    async () => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rust-grep-smoke-")));
      writeFileSync(path.join(root, "a.ts"), "hello world\n");
      writeFileSync(path.join(root, "b.ts"), "nothing here\n");
      writeFileSync(path.join(root, "c.ts"), "hello again\n");
      const session: GrepSessionConfig = {
        cwd: root,
        permissions: {
          roots: [root],
          sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
        },
      };
      const runner = makeGrepExecutorRust(session);
      try {
        const out = await runner.execute({ pattern: "hello" });
        expect(out).toContain("<pattern>hello</pattern>");
        expect(out).toContain("a.ts");
        expect(out).toContain("c.ts");
        expect(out).not.toContain("b.ts");
        expect(out).toMatch(/Found 2 file\(s\)/);
      } finally {
        await runner.close();
      }
    },
    30_000,
  );

  it.runIf(binExists)(
    "surfaces tool-layer errors via formatToolError",
    async () => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rust-grep-smoke-")));
      writeFileSync(path.join(root, "a.ts"), "x\n");
      const session: GrepSessionConfig = {
        cwd: root,
        permissions: {
          roots: [root],
          sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
        },
      };
      const runner = makeGrepExecutorRust(session);
      try {
        const out = await runner.execute({ pattern: "" });
        expect(out).toMatch(/Error \[INVALID_PARAM\]/);
        expect(out).toMatch(/pattern is required/);
      } finally {
        await runner.close();
      }
    },
    30_000,
  );

  it.runIf(!binExists)(
    "skips when the Rust binary hasn't been built",
    () => {
      console.warn(
        `[skip] rust grep bridge smoke — ${binPath} not found. Build with: CARGO_TARGET_DIR=$HOME/rust-target-harness env -u LD_LIBRARY_PATH cargo build --manifest-path /mnt/c/Users/avife/tools/Cargo.toml --workspace`,
      );
    },
  );
});
