import path from "node:path";
import type { ReadOperations } from "@agent-sh/harness-core";
import { FUZZY_SUGGESTION_LIMIT } from "./constants.js";

/**
 * Return up to FUZZY_SUGGESTION_LIMIT entries in the parent directory that
 * look like the missing basename, sorted most-similar-first. Empty array on
 * any IO error — NOT_FOUND without siblings is still a valid shape.
 *
 * Mirrors the Read tool's implementation; duplicated rather than shared so
 * grep does not depend on the read package.
 */
export async function suggestSiblings(
  ops: ReadOperations,
  missingPath: string,
): Promise<readonly string[]> {
  const dir = path.dirname(missingPath);
  const base = path.basename(missingPath).toLowerCase();
  let entries: readonly string[];
  try {
    entries = await ops.readDirectory(dir);
  } catch {
    return [];
  }
  const scored: { p: string; score: number }[] = [];
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    const score = similarity(base, lower);
    if (score > 0) scored.push({ p: path.join(dir, entry), score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, FUZZY_SUGGESTION_LIMIT).map((s) => s.p);
}

function similarity(a: string, b: string): number {
  if (a === b) return 1000;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.includes(b) || b.includes(a)) return 500;
  const prefix = commonPrefix(a, b);
  if (prefix >= 3) return 200 + prefix;
  if (prefix >= 2 && Math.abs(a.length - b.length) <= 2) return 100 + prefix;
  const aExt = extOf(a);
  const bExt = extOf(b);
  if (aExt && aExt === bExt) return 10;
  return 0;
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}
