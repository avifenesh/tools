import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SENSITIVE_PATTERNS } from "@agent-sh/harness-core";
import type { BashSessionConfig } from "../src/types.js";

export function makeTempDir(prefix = "bash-test-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function makeSession(
  root: string,
  overrides: Partial<BashSessionConfig> = {},
): BashSessionConfig {
  const base: BashSessionConfig = {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
      // Tests use the unsafe bypass because we're not exercising the
      // hook itself in most unit tests — just the tool's contract with
      // a hook-less executor.
      unsafeAllowBashWithoutHook: true,
    },
    ...overrides,
  };
  return base;
}
