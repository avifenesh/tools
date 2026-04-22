import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SENSITIVE_PATTERNS } from "@agent-sh/harness-core";
import type { GrepSessionConfig } from "../src/types.js";

export function makeTempDir(prefix = "grep-test-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function write(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  const parent = path.dirname(p);
  if (parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function makeSession(
  root: string,
  overrides: Partial<GrepSessionConfig> = {},
): GrepSessionConfig {
  return {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    },
    ...overrides,
  };
}
