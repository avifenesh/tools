import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SENSITIVE_PATTERNS } from "@agent-sh/harness-core";
import type { LspClient, LspManifest, LspSessionConfig } from "../src/types.js";

export function makeTempDir(prefix = "lsp-test-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function write(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  const parent = path.dirname(p);
  if (parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function makeManifest(): LspManifest {
  return {
    servers: {
      typescript: {
        language: "typescript",
        extensions: [".ts", ".tsx", ".js"],
        command: ["typescript-language-server", "--stdio"],
        rootPatterns: ["tsconfig.json", "package.json"],
      },
      python: {
        language: "python",
        extensions: [".py"],
        command: ["pyright-langserver", "--stdio"],
      },
    },
  };
}

export function makeSession(
  root: string,
  client: LspClient,
  overrides: Partial<LspSessionConfig> = {},
): LspSessionConfig {
  return {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
      unsafeAllowLspWithoutHook: true,
    },
    client,
    manifest: makeManifest(),
    ...overrides,
  };
}
