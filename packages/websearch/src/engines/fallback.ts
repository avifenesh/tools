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
 * Outcome semantics (engine-class aware — see EngineClass):
 * - At least one engine returned results → ok (first non-empty wins).
 * - A "general" engine (broad web index) returned empty → authoritative empty
 *   (the web really had nothing); return empty.
 * - Only "niche"/"vertical" engines returned empty AND a general engine
 *   ERRORED → degraded: search broke, so throw a chain error (don't let a
 *   Wikipedia-empty masquerade as "no web results" when Mojeek+Marginalia
 *   actually failed). If no general engine errored (e.g. Mojeek disabled),
 *   a niche/vertical empty is the best signal we have → return empty.
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
      let generalEmpty: WebSearchEngineResult | null = null;
      let fallbackEmpty: WebSearchEngineResult | null = null;
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
            return {
              ...r,
              engine: r.engine ?? engine.name,
              engineClass: engine.engineClass,
              attempts,
            };
          }
          attempts.push({ engine: engine.name, outcome: "empty" });
          const tagged = {
            ...r,
            engine: r.engine ?? engine.name,
            engineClass: engine.engineClass,
          };
          if (engine.engineClass === "general") {
            generalEmpty ??= tagged;
          } else {
            fallbackEmpty ??= tagged;
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

        // Only a genuine PARENT abort (caller cancel / hard backstop) stops
        // the chain; a per-engine timeout just moves on to the next engine.
        if (input.signal.aborted) break;
      }

      // A general (broad-web) engine's empty is authoritative: the web had
      // nothing. Return it regardless of later niche/vertical noise.
      if (generalEmpty) {
        return { ...generalEmpty, attempts };
      }

      // Only niche/vertical engines returned empty. If a general engine
      // ERRORED, search is degraded — throw so the model retries rather than
      // trusting a Wikipedia-empty as "no web results". Otherwise (no general
      // engine failed, e.g. Mojeek disabled) the niche/vertical empty is the
      // best signal we have.
      if (fallbackEmpty && !generalErrored) {
        return { ...fallbackEmpty, attempts };
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
