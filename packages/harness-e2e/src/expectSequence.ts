/**
 * Trajectory matcher: asserts that an ordered subsequence of tool names
 * appears in a recorded tool sequence.
 *
 * The model's trace is chaotic — it may call extra tools, retry, or emit
 * unrelated calls between the ones we care about. What we usually want to
 * assert is "read happened, then (after some noise) edit happened", not
 * "read then edit with nothing in between". `expectSequence` encodes that.
 *
 * Contrast with the ad-hoc pattern in W1:
 *   const r = seq.indexOf("read"); const e = seq.indexOf("edit");
 *   expect(e).toBeGreaterThan(r);
 * which only finds the *first* of each and silently passes when a tool
 * appears twice in the wrong order.
 */

export interface SequenceMatch {
  readonly matched: true;
  readonly indices: readonly number[];
}

export interface SequenceMiss {
  readonly matched: false;
  readonly failedAt: number;
  readonly expected: string;
  readonly indices: readonly number[];
  readonly reason: string;
}

export type SequenceResult = SequenceMatch | SequenceMiss;

export interface SequenceOptions {
  /** If set, the subsequence must not contain any names in this list
   *  *between* matched steps. Use to forbid bypass tools (e.g. "shell"). */
  readonly forbidBetween?: readonly string[];
  /** If set, the entire trace must not contain any names in this list
   *  at all. Stricter than forbidBetween. */
  readonly forbidAnywhere?: readonly string[];
}

export function matchSequence(
  trace: readonly string[],
  expected: readonly string[],
  opts: SequenceOptions = {},
): SequenceResult {
  if (opts.forbidAnywhere && opts.forbidAnywhere.length > 0) {
    const forbidSet = new Set(opts.forbidAnywhere);
    for (let i = 0; i < trace.length; i++) {
      const name = trace[i];
      if (name !== undefined && forbidSet.has(name)) {
        return {
          matched: false,
          failedAt: 0,
          expected: expected[0] ?? "",
          indices: [],
          reason: `forbidden tool "${name}" appeared at trace[${i}]`,
        };
      }
    }
  }

  const forbidBetweenSet = new Set(opts.forbidBetween ?? []);
  const indices: number[] = [];
  let cursor = 0;

  for (let step = 0; step < expected.length; step++) {
    const target = expected[step];
    if (target === undefined) continue;
    let found = -1;
    // forbidBetween only applies *between* already-matched steps, i.e.
    // after the first match. Before step 0 there's nothing to be "between".
    const applyForbidBetween = step > 0 && forbidBetweenSet.size > 0;
    for (let i = cursor; i < trace.length; i++) {
      const name = trace[i];
      if (name === undefined) continue;
      if (applyForbidBetween && forbidBetweenSet.has(name)) {
        return {
          matched: false,
          failedAt: step,
          expected: target,
          indices,
          reason: `forbidden-between tool "${name}" appeared at trace[${i}] while scanning for "${target}"`,
        };
      }
      if (name === target) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      return {
        matched: false,
        failedAt: step,
        expected: target,
        indices,
        reason: `expected "${target}" at step ${step}, trace ran out (cursor=${cursor}, len=${trace.length})`,
      };
    }
    indices.push(found);
    cursor = found + 1;
  }

  return { matched: true, indices };
}

/**
 * Throws an Error with a legible trace diff if the sequence doesn't match.
 * Intended for use inside vitest `it` blocks.
 */
export function expectSequence(
  trace: readonly string[],
  expected: readonly string[],
  opts: SequenceOptions = {},
): void {
  const r = matchSequence(trace, expected, opts);
  if (r.matched) return;
  const matched = r.indices
    .map((i, step) => `  ${step}. ${expected[step]} @ trace[${i}]`)
    .join("\n");
  const remaining = expected
    .slice(r.failedAt)
    .map((s, idx) => `  ${r.failedAt + idx}. ${s}`)
    .join("\n");
  throw new Error(
    [
      `expectSequence failed: ${r.reason}`,
      "matched:",
      matched || "  (none)",
      "remaining:",
      remaining,
      `full trace: [${trace.join(", ")}]`,
    ].join("\n"),
  );
}
