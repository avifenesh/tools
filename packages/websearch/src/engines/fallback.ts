import type {
  NamedWebSearchEngine,
  WebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
  WebSearchResultItem,
} from "../types.js";
import { normalizeUrlForDedup } from "./dedupe.js";
import { SearchError } from "./searchError.js";

export interface FallbackAttempt {
  readonly engine: string;
  readonly outcome: "results" | "empty" | "error";
  readonly added?: number;
  readonly code?: string;
  readonly message?: string;
}

export interface FallbackEngineResult extends WebSearchEngineResult {
  /** Per-engine trace, in attempt order — for error hints / observability. */
  readonly attempts: readonly FallbackAttempt[];
}

/**
 * Ordered fallback engine — mirrors `ddgs backend="auto"` / SearXNG's
 * cross-engine merge. Engines are tried in chain order (general-first); their
 * results are ACCUMULATED, de-duplicated by normalized URL, until the
 * requested `count` is met (sufficiency) or engines/budget run out.
 *
 * Why gather-and-merge, not first-non-empty-wins: a leading engine that
 * returns 1 hit when 5 were asked for is not "good enough" — earlier the
 * chain stopped there. Now later engines top up the quota, and the encyclopedic
 * backstop only contributes the slots the broad-web engines couldn't fill.
 *
 * Fast path preserved: if the FIRST engine already returns ≥ count results, we
 * return immediately — no extra latency, no mixing (single-engine provenance).
 * Mixing only happens when the leading engine(s) come up short.
 *
 * Dedup: results are keyed on a normalized URL (see dedupe.ts); the first
 * engine to surface a URL owns the entry and its rank position. The original
 * URL is always preserved in output.
 *
 * Timeout fairness: `input.timeoutMs` is the OVERALL budget; each engine gets a
 * slice (≈ overall / engineCount, clamped, bounded by remaining). A slow
 * engine is cut at its slice; the next still gets a window. The parent signal
 * (caller cancel / hard backstop) aborts the whole chain.
 *
 * Outcome semantics (engine-class aware — see EngineClass):
 * - Any results gathered → ok (merged, deduped, best-first by chain order).
 * - Zero results: a "general" engine's empty is authoritative → empty. A
 *   niche/vertical-only empty while a general engine ERRORED is degraded →
 *   throw (don't let a Wikipedia-empty masquerade as "no web results").
 * - Every engine errored → throw a chain-summary SearchError.
 */
const PER_ENGINE_FLOOR_MS = 3_000;
const PER_ENGINE_CAP_MS = 8_000;

export function createFallbackEngine(
  engines: readonly NamedWebSearchEngine[],
): WebSearchEngine & { readonly name: string } {
  return {
    name: "fallback",
    async search(
      input: WebSearchEngineInput,
    ): Promise<FallbackEngineResult> {
      const attempts: FallbackAttempt[] = [];
      const merged: WebSearchResultItem[] = [];
      const seen = new Set<string>();
      const contributors: string[] = [];
      let backendHost = "";
      let firstEngineName: string | undefined;
      let firstEngineClass: NamedWebSearchEngine["engineClass"] | undefined;
      let totalElapsed = 0;
      // timeRangeApplied across contributors: true only if EVERY contributor
      // that was asked for a time filter actually applied it; false if any
      // ignored it; undefined if no filter was requested.
      let anyTimeIgnored = false;
      let anyTimeApplied = false;

      let generalEmpty = false;
      let fallbackEmpty = false;
      let generalErrored = false;
      const errors: SearchError[] = [];

      const overallMs = input.timeoutMs;
      const deadline = Date.now() + overallMs;
      const perEngineMs = Math.min(
        PER_ENGINE_CAP_MS,
        Math.max(
          PER_ENGINE_FLOOR_MS,
          Math.floor(overallMs / Math.max(engines.length, 1)),
        ),
      );

      let engineIndex = -1;
      for (const engine of engines) {
        engineIndex += 1;
        if (input.signal.aborted) break;
        if (merged.length >= input.count) break; // sufficiency reached
        const remaining = deadline - Date.now();
        if (remaining <= 0) break; // overall budget exhausted
        const budget = Math.min(perEngineMs, remaining);

        const child = new AbortController();
        const onParentAbort = () => child.abort();
        if (input.signal.aborted) child.abort();
        else
          input.signal.addEventListener("abort", onParentAbort, {
            once: true,
          });
        const timer = setTimeout(() => child.abort(), budget);

        try {
          const r = await engine.search({
            ...input,
            signal: child.signal,
            timeoutMs: budget,
          });
          totalElapsed += r.elapsedMs;

          if (r.results.length === 0) {
            attempts.push({ engine: engine.name, outcome: "empty", added: 0 });
            if (engine.engineClass === "general") generalEmpty = true;
            else fallbackEmpty = true;
          } else {
            // Fast path: the FIRST engine alone satisfies the request → return
            // it directly with single-engine provenance (no mixing).
            if (engineIndex === 0 && r.results.length >= input.count) {
              attempts.push({
                engine: engine.name,
                outcome: "results",
                added: r.results.length,
              });
              clearTimeout(timer);
              input.signal.removeEventListener("abort", onParentAbort);
              return {
                ...r,
                engine: r.engine ?? engine.name,
                engineClass: engine.engineClass,
                attempts,
              };
            }
            // Merge with dedup. Tag each kept item with its source engine so
            // per-result provenance survives the merge (only surfaced in
            // output when the final result set is mixed).
            let added = 0;
            for (const item of r.results) {
              const key = normalizeUrlForDedup(item.url);
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push({ ...item, source: engine.name });
              added += 1;
              if (merged.length >= input.count) break;
            }
            if (added > 0) {
              contributors.push(engine.name);
              if (firstEngineName === undefined) {
                firstEngineName = engine.name;
                firstEngineClass = engine.engineClass;
                backendHost = r.backendHost;
              }
              if (r.timeRangeApplied === true) anyTimeApplied = true;
              else if (r.timeRangeApplied === false) anyTimeIgnored = true;
            }
            attempts.push({
              engine: engine.name,
              outcome: "results",
              added,
            });
          }
        } catch (e) {
          const se =
            e instanceof SearchError
              ? e
              : new SearchError("IO_ERROR", String((e as Error).message), {
                  engine: engine.name,
                });
          if (engine.engineClass === "general") generalErrored = true;
          errors.push(se);
          attempts.push({
            engine: engine.name,
            outcome: "error",
            code: se.code,
            message: se.message,
          });
        } finally {
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onParentAbort);
        }

        if (input.signal.aborted) break;
      }

      if (merged.length > 0) {
        const mixed = contributors.length > 1;
        // Per-result `source` was tagged during merge; keep it only when the
        // final set actually mixed engines, else strip it (the header already
        // names the single engine).
        const results = mixed
          ? merged
          : merged.map(({ source: _source, ...rest }) => rest);
        const timeRangeApplied =
          anyTimeApplied || anyTimeIgnored
            ? anyTimeIgnored
              ? false
              : true
            : undefined;
        return {
          results,
          backendHost,
          elapsedMs: totalElapsed,
          engine: firstEngineName ?? contributors[0] ?? "unknown",
          ...(firstEngineClass !== undefined
            ? { engineClass: firstEngineClass }
            : {}),
          ...(mixed ? { engines: contributors } : {}),
          ...(timeRangeApplied !== undefined ? { timeRangeApplied } : {}),
          attempts,
        };
      }

      // No results gathered. A general engine's empty is authoritative.
      if (generalEmpty) {
        return {
          results: [],
          backendHost,
          elapsedMs: totalElapsed,
          attempts,
        };
      }
      // Niche/vertical-only empty: trustworthy only if no general engine broke.
      if (fallbackEmpty && !generalErrored) {
        return {
          results: [],
          backendHost,
          elapsedMs: totalElapsed,
          attempts,
        };
      }
      // Everything errored (or degraded). Synthesize a chain-summary error.
      throw synthesizeChainError(errors, attempts, input.signal.aborted);
    },
  };
}

function synthesizeChainError(
  errors: readonly SearchError[],
  attempts: readonly FallbackAttempt[],
  aborted: boolean,
): SearchError {
  if (aborted && errors.length === 0) {
    return new SearchError("TIMEOUT", "search aborted before any engine ran");
  }
  if (errors.length === 0) {
    return new SearchError(
      "SERVER_NOT_AVAILABLE",
      "no search engines were available to try",
    );
  }
  const codes = new Set(errors.map((e) => e.code));
  const summary = attempts
    .map((a) =>
      a.outcome === "error"
        ? `${a.engine}: ${a.code}`
        : `${a.engine}: ${a.outcome}`,
    )
    .join(", ");
  const repCode =
    codes.size === 1 ? (errors[0]?.code ?? "SERVER_NOT_AVAILABLE") : "SERVER_NOT_AVAILABLE";
  return new SearchError(repCode, `all search engines failed (${summary})`, {
    attempts,
  });
}
