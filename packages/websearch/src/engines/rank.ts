import type { EngineClass, WebSearchResultItem } from "../types.js";

/**
 * Reciprocal Rank Fusion (RRF) with engine weights — the merge ranker used
 * when the fallback chain gathers results from more than one engine.
 *
 * Why RRF: the engines' native signals are NOT comparable (Marginalia's
 * `quality` float, Tavily's 0–1 `score`, Mojeek's bare rank). Fusing on RANK
 * sidesteps that, and is the established metasearch approach (SearXNG,
 * Elasticsearch hybrid search). For each result URL:
 *
 *     fused(d) = Σ over engines e that returned d:  weight(e) / (K + rank_e(d))
 *
 * - `rank_e(d)` is 0-based position in engine e's list.
 * - K is small (10) because our lists are short (≤20), unlike the TREC default
 *   of 60 tuned for thousand-item lists.
 * - Two engines returning the same URL SUM their contributions → a consensus
 *   boost ("two independent indexes agree" is the strongest cheap relevance
 *   signal). The A/B (scenario 3) showed this is the main reorder win.
 * - Engine weights (general > niche > vertical; keyed providers highest) keep
 *   the encyclopedic/indie backstop from outranking broad web purely because
 *   the leader was short (A/B scenario 4).
 *
 * Determinism: ties break by (1) higher single best per-engine weight/rank,
 * then (2) original insertion order, so the output is stable for a given set
 * of engine lists.
 */

export const RRF_K = 10;

/** Default per-class engine weights. Keyed providers rank above keyless. */
export const ENGINE_WEIGHTS: Readonly<Record<EngineClass, number>> = {
  general: 1.0,
  niche: 0.8,
  vertical: 0.6,
};

/** Brave/Tavily (keyed, official) get a small premium over keyless general. */
export const KEYED_ENGINE_WEIGHT = 1.2;
const KEYED_ENGINES = new Set(["brave", "tavily"]);

export function engineWeight(name: string, engineClass: EngineClass): number {
  if (KEYED_ENGINES.has(name)) return KEYED_ENGINE_WEIGHT;
  return ENGINE_WEIGHTS[engineClass];
}

/** One engine's contribution to a URL: which engine, at what 0-based rank. */
export interface RankOccurrence {
  readonly engine: string;
  readonly engineClass: EngineClass;
  readonly rank: number;
}

/** A candidate URL accumulated across engines, before fusion. */
export interface FusionCandidate {
  /** The result item to emit (first engine to surface the URL owns the fields). */
  item: WebSearchResultItem;
  /** Every (engine, rank) that returned this URL, in insertion order. */
  occurrences: RankOccurrence[];
  /** Insertion order index, for a stable final tiebreak. */
  readonly order: number;
}

export interface FusedResult {
  readonly item: WebSearchResultItem;
  readonly score: number;
  /** Contributing engine names in best-rank-first order (for `source`). */
  readonly sources: readonly string[];
}

/** Compute the fused RRF score for one candidate. */
export function fusedScore(occ: readonly RankOccurrence[]): number {
  let s = 0;
  for (const o of occ) s += engineWeight(o.engine, o.engineClass) / (RRF_K + o.rank);
  return s;
}

/**
 * Fuse accumulated candidates into a ranked list (best-first). Pure function:
 * given the same candidates it returns the same order.
 */
export function fuseRrf(
  candidates: readonly FusionCandidate[],
): FusedResult[] {
  const scored = candidates.map((c) => {
    // sources ordered by the engine's own rank (best rank first)
    const sources = [...c.occurrences]
      .sort((a, b) => a.rank - b.rank)
      .map((o) => o.engine);
    return { item: c.item, score: fusedScore(c.occurrences), sources, order: c.order };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie: more engines agreeing wins, then original insertion order.
    if (b.sources.length !== a.sources.length) {
      return b.sources.length - a.sources.length;
    }
    return a.order - b.order;
  });
  return scored.map(({ item, score, sources }) => ({ item, score, sources }));
}
