//! Ordered fallback engine — mirrors `ddgs backend="auto"` / SearXNG's
//! cross-engine merge and the TS `engines/fallback.ts`. Engines are tried in
//! chain order (general-first); their results are ACCUMULATED, de-duplicated
//! by normalized URL, until the requested `count` is met (sufficiency) or
//! engines/budget run out.
//!
//! Fast path: if the FIRST engine alone meets count, return it directly (no
//! mixing). Mixing only happens when the leading engine(s) come up short, and
//! then the merged result carries per-row source + a contributors list.
//!
//! Timeout fairness: `input.timeout_ms` is the OVERALL budget; each engine
//! gets a slice (≈ overall / engine_count, clamped) via a per-engine timeout.
//!
//! Empty/degraded (engine-class aware): a general engine's empty is
//! authoritative; a niche/vertical-only empty while a general engine errored
//! is degraded → error; all-error → chain-summary error.

use async_trait::async_trait;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::dedupe::normalize_url_for_dedup;
use crate::engine::{
    EngineClass, SearchError, SearchErrorCode, WebSearchEngine, WebSearchEngineInput,
    WebSearchEngineResult,
};
use crate::types::WebSearchResultItem;

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
        let n_engines = self.engines.len().max(1) as u64;
        let per_engine_ms =
            (overall_ms / n_engines).clamp(PER_ENGINE_FLOOR_MS.min(overall_ms), PER_ENGINE_CAP_MS);

        let mut errors: Vec<SearchError> = Vec::new();
        let mut summary: Vec<String> = Vec::new();

        let mut merged: Vec<WebSearchResultItem> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut contributors: Vec<String> = Vec::new();
        let mut backend_host = String::new();
        let mut first_engine: Option<String> = None;
        let mut first_class: Option<EngineClass> = None;
        let mut total_elapsed: u64 = 0;
        let mut any_time_applied = false;
        let mut any_time_ignored = false;

        let mut general_empty = false;
        let mut fallback_empty = false;
        let mut general_errored = false;

        for (idx, engine) in self.engines.iter().enumerate() {
            if merged.len() >= input.count {
                break; // sufficiency reached
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if remaining == 0 {
                break;
            }
            let budget = per_engine_ms.min(remaining).max(1);

            let mut per_input = input.clone();
            per_input.timeout_ms = budget;

            let name = engine.name().to_string();
            let class = engine.engine_class();
            let fut = engine.search(per_input);
            match tokio::time::timeout(Duration::from_millis(budget), fut).await {
                Ok(Ok(r)) => {
                    total_elapsed += r.elapsed_ms;
                    if r.results.is_empty() {
                        summary.push(format!("{}: empty", name));
                        if class == EngineClass::General {
                            general_empty = true;
                        } else {
                            fallback_empty = true;
                        }
                        continue;
                    }
                    // Fast path: first engine alone meets count → return it.
                    if idx == 0 && r.results.len() >= input.count {
                        summary.push(format!("{}: results", name));
                        let mut out = r;
                        if out.engine.is_none() {
                            out.engine = Some(name);
                        }
                        out.engine_class = Some(class);
                        return Ok(out);
                    }
                    // Merge with dedup; tag each kept item with its source.
                    let mut added = 0usize;
                    let r_time = r.time_range_applied;
                    let r_host = r.backend_host.clone();
                    for mut item in r.results.into_iter() {
                        let key = normalize_url_for_dedup(&item.url);
                        if seen.contains(&key) {
                            continue;
                        }
                        seen.insert(key);
                        item.source = Some(name.clone());
                        merged.push(item);
                        added += 1;
                        if merged.len() >= input.count {
                            break;
                        }
                    }
                    summary.push(format!("{}: results", name));
                    if added > 0 {
                        contributors.push(name.clone());
                        if first_engine.is_none() {
                            first_engine = Some(name);
                            first_class = Some(class);
                            backend_host = r_host;
                        }
                        match r_time {
                            Some(true) => any_time_applied = true,
                            Some(false) => any_time_ignored = true,
                            None => {}
                        }
                    }
                }
                Ok(Err(e)) => {
                    summary.push(format!("{}: {:?}", name, e.code));
                    if class == EngineClass::General {
                        general_errored = true;
                    }
                    errors.push(e);
                }
                Err(_) => {
                    summary.push(format!("{}: Timeout", name));
                    if class == EngineClass::General {
                        general_errored = true;
                    }
                    errors.push(SearchError::new(
                        SearchErrorCode::Timeout,
                        format!("{} exceeded its per-engine time slice", name),
                    ));
                }
            }
        }

        if !merged.is_empty() {
            let mixed = contributors.len() > 1;
            if !mixed {
                // Single contributor — strip the per-result source tags.
                for item in merged.iter_mut() {
                    item.source = None;
                }
            }
            let time_range_applied = if any_time_applied || any_time_ignored {
                Some(!any_time_ignored)
            } else {
                None
            };
            return Ok(WebSearchEngineResult {
                results: merged,
                backend_host,
                elapsed_ms: total_elapsed,
                engine: first_engine.or_else(|| contributors.first().cloned()),
                engine_class: first_class,
                engines: if mixed { Some(contributors) } else { None },
                time_range_applied,
            });
        }

        // No results gathered. A general engine's empty is authoritative.
        if general_empty {
            return Ok(empty_result(backend_host, total_elapsed));
        }
        // Niche/vertical-only empty: trustworthy only if no general engine broke.
        if fallback_empty && !general_errored {
            return Ok(empty_result(backend_host, total_elapsed));
        }
        Err(synthesize_chain_error(&errors, &summary))
    }
}

fn empty_result(backend_host: String, elapsed_ms: u64) -> WebSearchEngineResult {
    WebSearchEngineResult {
        results: Vec::new(),
        backend_host,
        elapsed_ms,
        engine: None,
        engine_class: None,
        engines: None,
        time_range_applied: None,
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
