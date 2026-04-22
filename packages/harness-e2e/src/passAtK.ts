/**
 * Pass@k wrapper for stochastic e2e tests.
 *
 * Not every test deserves a hard pass/fail. Fuzzy recovery scenarios where
 * the model picks between widening and replace_all, or distractor-tool
 * scenarios where routing quality is probabilistic, are better expressed
 * as "succeeds K out of N times".
 *
 * Usage (inside a vitest `it`):
 *
 *   const r = await passAtK({
 *     n: 5, k: 4, label: "W4",
 *     run: async () => { ...; return { ok: boolean, detail?: unknown }; },
 *   });
 *   expect(r.successes).toBeGreaterThanOrEqual(4);
 */

export interface PassAtKRunResult {
  readonly ok: boolean;
  readonly detail?: unknown;
}

export interface PassAtKOptions {
  readonly n: number;
  readonly k: number;
  readonly label?: string;
  readonly run: (attempt: number) => Promise<PassAtKRunResult>;
  /** Stop early once `k` successes have been recorded. Default true. */
  readonly stopEarly?: boolean;
}

export interface PassAtKSummary {
  readonly label: string;
  readonly n: number;
  readonly k: number;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly passed: boolean;
  readonly details: readonly { attempt: number; ok: boolean; detail?: unknown }[];
}

export async function passAtK(opts: PassAtKOptions): Promise<PassAtKSummary> {
  const label = opts.label ?? "passAtK";
  const stopEarly = opts.stopEarly ?? true;
  const details: { attempt: number; ok: boolean; detail?: unknown }[] = [];
  let successes = 0;
  let failures = 0;

  for (let attempt = 1; attempt <= opts.n; attempt++) {
    const r = await opts.run(attempt);
    const entry: { attempt: number; ok: boolean; detail?: unknown } = {
      attempt,
      ok: r.ok,
    };
    if (r.detail !== undefined) entry.detail = r.detail;
    details.push(entry);
    if (r.ok) successes++;
    else failures++;
    // eslint-disable-next-line no-console
    console.log(
      `[${label}] attempt=${attempt}/${opts.n} ok=${r.ok} successes=${successes} failures=${failures}`,
    );
    if (stopEarly && successes >= opts.k) break;
    // If remaining attempts can't reach k, stop to save time.
    if (stopEarly && opts.n - attempt + successes < opts.k) break;
  }

  const passed = successes >= opts.k;
  return {
    label,
    n: opts.n,
    k: opts.k,
    attempts: details.length,
    successes,
    failures,
    passed,
    details,
  };
}
