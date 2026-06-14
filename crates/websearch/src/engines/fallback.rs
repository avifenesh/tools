//! Ordered fallback engine — mirrors `ddgs backend="auto"` and the TS
//! `engines/fallback.ts`. Tries each engine in order; first non-empty wins;
//! per-engine failures are recorded and the chain continues; a clean empty
//! beats a pile of errors; all-error throws a chain-summary SearchError.
//!
//! Timeout fairness: `input.timeout_ms` is the OVERALL budget; each engine
//! gets a slice (≈ overall / engine_count, clamped) via a per-engine timeout
//! so a slow engine can't starve the next. The per-engine timeout is applied
//! by `tokio::time::timeout` here AND passed as the engine's own timeout_ms.

use async_trait::async_trait;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::engine::{
    SearchError, SearchErrorCode, WebSearchEngine, WebSearchEngineInput, WebSearchEngineResult,
};

const PER_ENGINE_FLOOR_MS: u64 = 3_000;
const PER_ENGINE_CAP_MS: u64 = 8_000;

pub struct FallbackEngine {
    engines: Vec<Arc<dyn WebSearchEngine>>,
    names: Vec<String>,
}

impl FallbackEngine {
    pub fn new(engines: Vec<Arc<dyn WebSearchEngine>>) -> Self {
        let names = engines.iter().map(|e| e.name().to_string()).collect();
        Self { engines, names }
    }

    pub fn chain(&self) -> &[String] {
        &self.names
    }
}

#[async_trait]
impl WebSearchEngine for FallbackEngine {
    fn name(&self) -> &str {
        "fallback"
    }

    async fn search(
        &self,
        input: WebSearchEngineInput,
    ) -> Result<WebSearchEngineResult, SearchError> {
        let overall_ms = input.timeout_ms;
        let deadline = Instant::now() + Duration::from_millis(overall_ms);
        let count = self.engines.len().max(1) as u64;
        let per_engine_ms =
            (overall_ms / count).clamp(PER_ENGINE_FLOOR_MS.min(overall_ms), PER_ENGINE_CAP_MS);

        let mut errors: Vec<SearchError> = Vec::new();
        let mut summary: Vec<String> = Vec::new();
        let mut last_empty: Option<WebSearchEngineResult> = None;

        for engine in &self.engines {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if remaining == 0 {
                break;
            }
            let budget = per_engine_ms.min(remaining).max(1);

            // Per-engine input carries the slice as its own timeout, and the
            // tokio timeout is the hard cut-off if the engine ignores it.
            let mut per_input = input.clone();
            per_input.timeout_ms = budget;

            let name = engine.name().to_string();
            let fut = engine.search(per_input);
            match tokio::time::timeout(Duration::from_millis(budget), fut).await {
                Ok(Ok(r)) => {
                    if !r.results.is_empty() {
                        summary.push(format!("{}: results", name));
                        let mut out = r;
                        if out.engine.is_none() {
                            out.engine = Some(name);
                        }
                        return Ok(out);
                    }
                    summary.push(format!("{}: empty", name));
                    let mut e = r;
                    if e.engine.is_none() {
                        e.engine = Some(name);
                    }
                    last_empty = Some(e);
                }
                Ok(Err(e)) => {
                    summary.push(format!("{}: {:?}", name, e.code));
                    errors.push(e);
                }
                Err(_) => {
                    summary.push(format!("{}: Timeout", name));
                    errors.push(SearchError::new(
                        SearchErrorCode::Timeout,
                        format!("{} exceeded its per-engine time slice", name),
                    ));
                }
            }
        }

        // A clean "no hits" from any reachable engine beats a pile of errors.
        if let Some(empty) = last_empty {
            return Ok(empty);
        }

        Err(synthesize_chain_error(&errors, &summary))
    }
}

fn synthesize_chain_error(errors: &[SearchError], summary: &[String]) -> SearchError {
    if errors.is_empty() {
        return SearchError::new(
            SearchErrorCode::ServerNotAvailable,
            "no search engines were available to try",
        );
    }
    let first_code = errors[0].code;
    let all_same = errors.iter().all(|e| e.code == first_code);
    let rep = if all_same {
        first_code
    } else {
        SearchErrorCode::ServerNotAvailable
    };
    SearchError::new(
        rep,
        format!("all search engines failed ({})", summary.join(", ")),
    )
}
