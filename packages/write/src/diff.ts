/**
 * Minimal unified-diff generator. Produces git-style `--- a/... +++ b/...`
 * plus `@@ -a,b +c,d @@` hunks with 3 lines of context.
 *
 * This is intentionally small and dependency-free. It's used for Edit/MultiEdit
 * dry-run previews and optional success-path diffs; it is *not* a full patch
 * parser — we don't parse diffs at all, we only emit them.
 */

const CONTEXT = 3;

interface Op {
  kind: "eq" | "add" | "del";
  line: string;
}

function splitLines(s: string): string[] {
  if (s.length === 0) return [];
  const lines = s.split("\n");
  // If the original string ended with a newline, split produces a trailing "".
  // Keep that behavior so our "lineCount" matches user expectations when both
  // halves are identical trailing-newline files.
  return lines;
}

function computeLcs(a: readonly string[], b: readonly string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i]![j] = (dp[i + 1]![j + 1] as number) + 1;
      } else {
        const down = dp[i + 1]![j] as number;
        const right = dp[i]![j + 1] as number;
        dp[i]![j] = Math.max(down, right);
      }
    }
  }
  return dp;
}

function diffOps(a: readonly string[], b: readonly string[]): Op[] {
  const dp = computeLcs(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", line: a[i]! });
      i++;
      j++;
    } else if ((dp[i + 1]![j] as number) >= (dp[i]![j + 1] as number)) {
      ops.push({ kind: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j]! });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ kind: "del", line: a[i]! });
    i++;
  }
  while (j < b.length) {
    ops.push({ kind: "add", line: b[j]! });
    j++;
  }
  return ops;
}

export interface UnifiedDiffOptions {
  readonly oldPath: string;
  readonly newPath: string;
  readonly oldContent: string;
  readonly newContent: string;
}

export function unifiedDiff(opts: UnifiedDiffOptions): string {
  const { oldPath, newPath, oldContent, newContent } = opts;
  if (oldContent === newContent) {
    return `--- a/${oldPath}\n+++ b/${newPath}\n`;
  }

  const a = splitLines(oldContent);
  const b = splitLines(newContent);
  const ops = diffOps(a, b);

  // Walk ops and emit hunks, grouping runs of non-eq with ±CONTEXT surrounding eq lines.
  interface Hunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
  }

  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let idx = 0;

  while (idx < ops.length) {
    // Fast-forward through equal lines.
    while (idx < ops.length && ops[idx]!.kind === "eq") {
      oldLine++;
      newLine++;
      idx++;
    }
    if (idx >= ops.length) break;

    // Start of a change block. Include up to CONTEXT equal lines before it.
    let ctxStart = idx;
    let backCount = 0;
    while (
      ctxStart > 0 &&
      ops[ctxStart - 1]!.kind === "eq" &&
      backCount < CONTEXT
    ) {
      ctxStart--;
      backCount++;
    }

    const hunkLines: string[] = [];
    let hunkOldStart = oldLine - backCount;
    let hunkNewStart = newLine - backCount;
    let hunkOldCount = 0;
    let hunkNewCount = 0;

    for (let k = ctxStart; k < idx; k++) {
      const op = ops[k]!;
      hunkLines.push(` ${op.line}`);
      hunkOldCount++;
      hunkNewCount++;
    }

    // Walk forward consuming changes, allowing small eq runs inside (≤ 2*CONTEXT).
    while (idx < ops.length) {
      const op = ops[idx]!;
      if (op.kind === "eq") {
        let eqRun = 0;
        let lookahead = idx;
        while (
          lookahead < ops.length &&
          ops[lookahead]!.kind === "eq" &&
          eqRun < 2 * CONTEXT + 1
        ) {
          eqRun++;
          lookahead++;
        }
        const hasMoreChanges =
          lookahead < ops.length && ops[lookahead]!.kind !== "eq";
        if (!hasMoreChanges || eqRun > 2 * CONTEXT) {
          // Absorb up to CONTEXT trailing eq lines, then end the hunk.
          const trailing = Math.min(CONTEXT, eqRun);
          for (let k = 0; k < trailing; k++) {
            hunkLines.push(` ${op.line}`);
            hunkOldCount++;
            hunkNewCount++;
            oldLine++;
            newLine++;
            idx++;
            if (idx < ops.length && ops[idx]!.kind !== "eq") break;
          }
          // Skip the rest of the equal run outside the hunk.
          while (idx < ops.length && ops[idx]!.kind === "eq") {
            oldLine++;
            newLine++;
            idx++;
          }
          break;
        }
        // Bridge the eq run inside the hunk.
        for (let k = 0; k < eqRun; k++) {
          const innerOp = ops[idx]!;
          hunkLines.push(` ${innerOp.line}`);
          hunkOldCount++;
          hunkNewCount++;
          oldLine++;
          newLine++;
          idx++;
        }
        continue;
      }
      if (op.kind === "del") {
        hunkLines.push(`-${op.line}`);
        hunkOldCount++;
        oldLine++;
      } else {
        hunkLines.push(`+${op.line}`);
        hunkNewCount++;
        newLine++;
      }
      idx++;
    }

    if (hunkOldStart < 1) hunkOldStart = 1;
    if (hunkNewStart < 1) hunkNewStart = 1;

    hunks.push({
      oldStart: hunkOldStart,
      oldCount: hunkOldCount,
      newStart: hunkNewStart,
      newCount: hunkNewCount,
      lines: hunkLines,
    });
  }

  const out: string[] = [`--- a/${oldPath}`, `+++ b/${newPath}`];
  for (const h of hunks) {
    out.push(
      `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`,
    );
    out.push(...h.lines);
  }
  return out.join("\n") + "\n";
}
