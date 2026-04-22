import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DEFAULT_SENSITIVE_PATTERNS,
  InMemoryLedger,
} from "@agent-sh/harness-core";
import type { WriteSessionConfig } from "../src/types.js";

export function makeTempDir(prefix = "write-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return realpathSync(dir);
}

export function writeFixture(dir: string, name: string, content: string | Uint8Array): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

export function readFileUtf8(p: string): string {
  return readFileSync(p, "utf8");
}

export function readFileBytes(p: string): Buffer {
  return readFileSync(p);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function makeSession(
  root: string,
  overrides: Partial<WriteSessionConfig> = {},
): WriteSessionConfig & { ledger: InMemoryLedger } {
  const ledger = overrides.ledger ?? new InMemoryLedger();
  return {
    cwd: root,
    permissions: {
      roots: [root],
      sensitivePatterns: DEFAULT_SENSITIVE_PATTERNS,
    },
    ledger,
    ...overrides,
  } as WriteSessionConfig & { ledger: InMemoryLedger };
}

/**
 * Record a ledger entry for a path so Edit/MultiEdit/Write-overwrite pass
 * the read-before-mutate gate. Reads the file bytes from disk and computes
 * sha. Mirrors what the Read tool would do.
 */
export function recordRead(
  session: { ledger?: InMemoryLedger },
  filePath: string,
): void {
  if (!session.ledger) throw new Error("session has no ledger");
  const bytes = readFileSync(filePath);
  session.ledger.record({
    path: realpathSync(filePath),
    sha256: sha256(bytes),
    mtime_ms: Date.now(),
    size_bytes: bytes.length,
    lines_returned: 0,
    offset: 0,
    limit: 0,
    timestamp_ms: Date.now(),
  });
}
