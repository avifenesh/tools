import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_SENSITIVE_PATTERNS,
  InMemoryCache,
  InMemoryLedger,
} from "@agent-sh/harness-core";
import type { ReadSessionConfig, TextReadResult } from "../src/types.js";

export function makeTempDir(prefix = "read-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return realpathSync(dir);
}

export function writeFixture(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

export function writeBinaryFixture(
  dir: string,
  name: string,
  bytes: Uint8Array,
): string {
  const p = path.join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

export function makeSession(
  root: string,
  overrides: Partial<ReadSessionConfig> = {},
): ReadSessionConfig {
  return {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    },
    ...overrides,
  };
}

export function makeSessionWithCache(
  root: string,
  overrides: Partial<ReadSessionConfig> = {},
): ReadSessionConfig & { cache: InMemoryCache<TextReadResult>; ledger: InMemoryLedger } {
  const cache = new InMemoryCache<TextReadResult>();
  const ledger = new InMemoryLedger();
  return {
    ...makeSession(root, overrides),
    cache,
    ledger,
  } as ReadSessionConfig & {
    cache: InMemoryCache<TextReadResult>;
    ledger: InMemoryLedger;
  };
}
