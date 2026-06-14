import type {
  NamedWebSearchEngine,
  WebSearchEngine,
  WebSearchEngineInput,
  WebSearchEngineResult,
} from "../types.js";
import { SearchError } from "./searchError.js";

export interface FallbackAttempt {
  readonly engine: string;
  readonly outcome: "results" | "empty" | "error";
  readonly code?: string;
  readonly message?: string;
}

export interface FallbackEngineResult extends WebSearchEngineResult {
  /** Per-engine trace, in attempt order — for error hints / observability. */
  readonly attempts: readonly FallbackAttempt[];
}

/**
 * Ordered fallback engine — mirrors `ddgs backend="auto"`. Tries each engine
 * in order; the **first engine that returns a non-empty result list wins**,
 * and its provenance (engine name + host) is carried out. Engine failures
 * (transport / SSRF / parse / per-engine timeout) are caught and recorded,
 * then the chain continues — a single dead or slow keyless host must not sink
 * the whole search.
 *
 * Timeout fairness: `input.timeoutMs` is the OVERALL budget. Each engine gets
 * its own slice (≈ overall / engineCount, clamped to a sane floor/cap and the
 * remaining budget) via a per-engine AbortController. So a slow first engine
 * is cut off at its slice and the next engine still gets a fresh window —
 * fixing the starvation where one hanging backend consumed the whole budget.
 * The parent signal (caller cancel or the orchestrator's hard backstop) still
 * aborts the entire chain immediately.
 *
 * Outcome semantics:
 * - At least one engine returned results → ok (first non-empty wins).
 * - Every engine reachable but all returned zero hits → empty (the web had
 *   nothing).
 * - Mixed (some empty, some errored, none with results) → if ANY engine
 *   cleanly returned empty, treat the whole thing as empty (a real "no hits"
 *   signal beats a pile of transport errors).
 * - Every engine errored → throw a synthesized SearchError summarizing the
 *   chain, so the orchestrator can render an actionable hint.
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
      let sawEmpty = false;
      let lastEmpty: WebSearchEngineResult | null = null;
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

      for (const engine of engines) {
        if (input.signal.aborted) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break; // overall budget exhausted
        const budget = Math.min(perEngineMs, remaining);

        const child = new AbortController();
        const onParentAbort = () => child.abort();
        if (input.signal.aborted) child.abort();
        else input.signal.addEventListener("abort", onParentAbort, { once: true });
        const timer = setTimeout(() => child.abort(), budget);

        try {
          const r = await engine.search({
            ...input,
            signal: child.signal,
            timeoutMs: budget,
          });
          if (r.results.length > 0) {
            attempts.push({ engine: engine.name, outcome: "results" });
            return { ...r, engine: r.engine ?? engine.name, attempts };
          }
          attempts.push({ engine: engine.name, outcome: "empty" });
          sawEmpty = true;
          lastEmpty = { ...r, engine: r.engine ?? engine.name };
        } catch (e) {
          const se =
            e instanceof SearchError
              ? e
              : new SearchError("IO_ERROR", String((e as Error).message), {
                  engine: engine.name,
                });
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

        // Only a genuine PARENT abort (caller cancel / hard backstop) stops
        // the chain; a per-engine timeout just moves on to the next engine.
        if (input.signal.aborted) break;
      }

      // A clean "no hits" from any reachable engine beats a pile of errors.
      if (sawEmpty && lastEmpty) {
        return { ...lastEmpty, attempts };
      }

      // Everything errored (or aborted). Synthesize a chain-summary error.
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
  // Prefer a representative non-IO code if present (e.g. all timed out).
  const codes = new Set(errors.map((e) => e.code));
  const summary = attempts
    .map((a) =>
      a.outcome === "error" ? `${a.engine}: ${a.code}` : `${a.engine}: ${a.outcome}`,
    )
    .join(", ");
  const repCode =
    codes.size === 1
      ? (errors[0]?.code ?? "SERVER_NOT_AVAILABLE")
      : "SERVER_NOT_AVAILABLE";
  return new SearchError(
    repCode,
    `all search engines failed (${summary})`,
    { attempts },
  );
}
