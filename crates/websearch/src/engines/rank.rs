//! Reciprocal Rank Fusion (RRF) + engine weights — the merge ranker used when
//! the fallback chain gathers results from more than one engine. Mirrors the
//! TS `engines/rank.ts`.
//!
//! `fused(d) = sum over engines e returning d of weight(e) / (K + rank_e(d))`
//!
//! Fusing on RANK sidesteps that the engines' native scores aren't comparable
//! (Marginalia `quality` vs Tavily 0–1 `score` vs Mojeek bare rank). K is small
//! (10) for our short lists. Two engines on the same URL SUM contributions (a
//! consensus boost). Engine weights (general > niche > vertical; keyed highest)
//! keep a backstop from outranking broad web. Deterministic ties: score, then
//! number of agreeing engines, then insertion order.

use crate::engine::EngineClass;
use crate::types::WebSearchResultItem;

pub const RRF_K: f64 = 10.0;

/// Brave/Tavily (keyed, official) premium over keyless general.
pub const KEYED_ENGINE_WEIGHT: f64 = 1.2;

pub fn engine_class_weight(class: EngineClass) -> f64 {
    match class {
        EngineClass::General => 1.0,
        EngineClass::Niche => 0.8,
        EngineClass::Vertical => 0.6,
    }
}

pub fn engine_weight(name: &str, class: EngineClass) -> f64 {
    if name == "brave" || name == "tavily" {
        KEYED_ENGINE_WEIGHT
    } else {
        engine_class_weight(class)
    }
}

/// One engine's contribution to a URL: which engine, at what 0-based rank.
#[derive(Clone)]
pub struct RankOccurrence {
    pub engine: String,
    pub class: EngineClass,
    pub rank: usize,
}

/// A candidate URL accumulated across engines, before fusion.
pub struct FusionCandidate {
    /// The item to emit (first engine to surface the URL owns the fields).
    pub item: WebSearchResultItem,
    /// Every (engine, rank) that returned this URL, in insertion order.
    pub occurrences: Vec<RankOccurrence>,
    /// Insertion order index, for a stable final tiebreak.
    pub order: usize,
}

pub struct FusedResult {
    pub item: WebSearchResultItem,
    pub score: f64,
    /// Contributing engine names in best-rank-first order (for `source`).
    pub sources: Vec<String>,
}

pub fn fused_score(occ: &[RankOccurrence]) -> f64 {
    occ.iter()
        .map(|o| engine_weight(&o.engine, o.class) / (RRF_K + o.rank as f64))
        .sum()
}

/// Fuse accumulated candidates into a ranked list (best-first). Pure: same
/// candidates → same order.
pub fn fuse_rrf(candidates: Vec<FusionCandidate>) -> Vec<FusedResult> {
    let mut scored: Vec<(FusedResult, usize)> = candidates
        .into_iter()
        .map(|c| {
            let score = fused_score(&c.occurrences);
            let mut occ = c.occurrences;
            occ.sort_by_key(|o| o.rank);
            let sources = occ.into_iter().map(|o| o.engine).collect();
            (
                FusedResult {
                    item: c.item,
                    score,
                    sources,
                },
                c.order,
            )
        })
        .collect();

    scored.sort_by(|a, b| {
        // Higher score first.
        b.0.score
            .partial_cmp(&a.0.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            // Tie: more agreeing engines first.
            .then(b.0.sources.len().cmp(&a.0.sources.len()))
            // Then original insertion order.
            .then(a.1.cmp(&b.1))
    });

    scored.into_iter().map(|(r, _)| r).collect()
}
