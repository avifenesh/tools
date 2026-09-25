//! New default engines (keyless + keyed) and the fallback-chain resolver.
//! Mirrors the TS `src/engines/` directory. All engines implement the
//! existing `WebSearchEngine` trait so they slot into the session unchanged.

mod brave;
mod dedupe;
mod exa;
mod fallback;
mod html;
mod http;
mod marginalia;
mod mcp;
mod mojeek;
mod parallel;
mod passage;
mod rank;
mod tavily;
mod wikipedia;

pub use brave::BraveEngine;
pub use exa::ExaEngine;
pub use fallback::FallbackEngine;
pub use marginalia::MarginaliaEngine;
pub use mojeek::MojeekEngine;
pub use parallel::ParallelEngine;
pub use tavily::TavilyEngine;
pub use wikipedia::WikipediaEngine;

use std::sync::Arc;

use crate::engine::WebSearchEngine;
use crate::types::WebSearchSessionConfig;

/// Per-engine base-URL overrides (tests point these at local fixture servers).
#[derive(Clone, Default)]
pub struct EngineBaseUrls {
    pub exa: Option<String>,
    pub parallel: Option<String>,
    pub mojeek: Option<String>,
    pub marginalia: Option<String>,
    pub wikipedia: Option<String>,
    pub brave: Option<String>,
    pub tavily: Option<String>,
}

/// The resolved engine plus its chain (for diagnostics) and whether it's the
/// bare keyless default.
pub struct ResolvedEngine {
    pub engine: Arc<dyn WebSearchEngine>,
    pub chain: Vec<String>,
    pub keyless_default: bool,
    /// When exactly one engine was resolved (no fallback wrapper), its class —
    /// so the orchestrator can label results. None for a fallback chain (the
    /// FallbackEngine sets engine_class on the result it returns).
    pub sole_engine_class: Option<crate::engine::EngineClass>,
}

/// Every name `engine_order` accepts, in the default best-first order.
pub const ENGINE_NAMES: &[&str] = &[
    "brave",
    "tavily",
    "searxng",
    "exa",
    "parallel",
    "mojeek",
    "marginalia",
    "wikipedia",
];

fn non_empty(v: &Option<String>) -> bool {
    v.as_deref().is_some_and(|s| !s.is_empty())
}

/// Validate `session.engine_order`. Returns a model- and operator-readable
/// message for the first problem: an empty list, an unknown or repeated name,
/// or an engine whose key / URL the session does not carry.
pub fn validate_engine_order(session: &WebSearchSessionConfig) -> Result<(), String> {
    let order = match &session.engine_order {
        Some(o) => o,
        None => return Ok(()),
    };
    if order.is_empty() {
        return Err(
            "session.engine_order is empty; list at least one engine or leave it unset".to_string(),
        );
    }
    let mut seen: Vec<&str> = Vec::new();
    for name in order {
        let n = name.as_str();
        if !ENGINE_NAMES.contains(&n) {
            return Err(format!(
                "session.engine_order has unknown engine '{}'; valid names: {}",
                n,
                ENGINE_NAMES.join(", ")
            ));
        }
        if seen.contains(&n) {
            return Err(format!("session.engine_order lists '{}' twice", n));
        }
        seen.push(n);
        let missing = match n {
            "brave" if !non_empty(&session.brave_api_key) => Some("session.brave_api_key"),
            "tavily" if !non_empty(&session.tavily_api_key) => Some("session.tavily_api_key"),
            "searxng" if !non_empty(&session.searxng_url) => Some("session.searxng_url"),
            _ => None,
        };
        if let Some(field) = missing {
            return Err(format!(
                "session.engine_order lists '{}' but {} is not set",
                n, field
            ));
        }
    }
    Ok(())
}

/// Build one engine by name. None for a name that is unknown or lacks its
/// key / URL (validate_engine_order reports those before the resolver runs).
fn build_named(
    name: &str,
    session: &WebSearchSessionConfig,
    base: &EngineBaseUrls,
) -> Option<Arc<dyn WebSearchEngine>> {
    let engine: Arc<dyn WebSearchEngine> = match name {
        "brave" => {
            let mut e = BraveEngine::new(session.brave_api_key.clone().filter(|k| !k.is_empty())?);
            if let Some(u) = &base.brave {
                e = e.with_base_url(u.clone());
            }
            Arc::new(e)
        }
        "tavily" => {
            let mut e =
                TavilyEngine::new(session.tavily_api_key.clone().filter(|k| !k.is_empty())?);
            if let Some(u) = &base.tavily {
                e = e.with_base_url(u.clone());
            }
            Arc::new(e)
        }
        "searxng" => {
            if !non_empty(&session.searxng_url) {
                return None;
            }
            // The legacy ReqwestEngine reads backend_url from the engine input,
            // which the orchestrator sets to searxng_url.
            crate::engine::default_engine()
        }
        "exa" => {
            let mut e = ExaEngine::new();
            if let Some(k) = &session.exa_api_key {
                e = e.with_api_key(k.clone());
            }
            if let Some(u) = &base.exa {
                e = e.with_base_url(u.clone());
            }
            Arc::new(e)
        }
        "parallel" => {
            let mut e = ParallelEngine::new();
            if let Some(k) = &session.parallel_api_key {
                e = e.with_api_key(k.clone());
            }
            if let Some(u) = &base.parallel {
                e = e.with_base_url(u.clone());
            }
            Arc::new(e)
        }
        "mojeek" => {
            let mut e = MojeekEngine::new();
            if let Some(u) = &base.mojeek {
                e = e.with_base_url(u.clone());
            }
            Arc::new(e)
        }
        "marginalia" => {
            let mut e = MarginaliaEngine::new();
            if let Some(u) = &base.marginalia {
                e = e.with_base_url(u.clone());
            }
            Arc::new(e)
        }
        "wikipedia" => {
            let mut e = WikipediaEngine::new();
            if let Some(u) = &base.wikipedia {
                e = e.with_base_url(u.clone());
            }
            Arc::new(e)
        }
        _ => return None,
    };
    Some(engine)
}

/// Build the engine to run for this session — the Rust twin of TS
/// `resolveEngine`. Priority: explicit override → harness `engine_order` →
/// Brave/Tavily (keyed) → SearXNG (searxng_url) → keyless chain
/// (Exa → Parallel → Mojeek → Marginalia → Wikipedia).
///
/// An explicit backend (key or SearXNG) is EXCLUSIVE unless
/// `fallback_to_keyless` is set; with nothing configured the keyless chain is
/// used so search works with zero config.
pub fn resolve_engine(session: &WebSearchSessionConfig) -> ResolvedEngine {
    // An explicit engine override (e.g. a test double, or the legacy
    // ReqwestEngine wired directly) bypasses the resolver entirely.
    if let Some(engine) = &session.engine_override {
        return ResolvedEngine {
            engine: engine.clone(),
            chain: vec![engine.name().to_string()],
            keyless_default: false,
            sole_engine_class: Some(engine.engine_class()),
        };
    }

    let base = session.engine_base_urls.clone().unwrap_or_default();

    if let Some(order) = &session.engine_order {
        let engines: Vec<Arc<dyn WebSearchEngine>> = order
            .iter()
            .filter_map(|n| build_named(n, session, &base))
            .collect();
        let keyless_default = !order
            .iter()
            .any(|n| matches!(n.as_str(), "brave" | "tavily" | "searxng"));
        return finish(engines, keyless_default);
    }

    let has_brave = session
        .brave_api_key
        .as_deref()
        .is_some_and(|k| !k.is_empty());
    let has_tavily = session
        .tavily_api_key
        .as_deref()
        .is_some_and(|k| !k.is_empty());
    let has_searxng = session
        .searxng_url
        .as_deref()
        .is_some_and(|u| !u.is_empty());
    let has_explicit = has_brave || has_tavily || has_searxng;

    let explicit: Vec<Arc<dyn WebSearchEngine>> = ["brave", "tavily", "searxng"]
        .iter()
        .filter_map(|n| build_named(n, session, &base))
        .collect();

    let keyless = build_keyless_chain(session, &base);

    let engines: Vec<Arc<dyn WebSearchEngine>> = if has_explicit {
        if session.fallback_to_keyless {
            explicit.into_iter().chain(keyless).collect()
        } else {
            explicit
        }
    } else {
        keyless
    };

    finish(engines, !has_explicit)
}

fn finish(engines: Vec<Arc<dyn WebSearchEngine>>, keyless_default: bool) -> ResolvedEngine {
    let chain: Vec<String> = engines.iter().map(|e| e.name().to_string()).collect();
    let (engine, sole_engine_class): (
        Arc<dyn WebSearchEngine>,
        Option<crate::engine::EngineClass>,
    ) = if engines.len() == 1 {
        let only = engines.into_iter().next().unwrap();
        let class = only.engine_class();
        (only, Some(class))
    } else {
        (Arc::new(FallbackEngine::new(engines)), None)
    };

    ResolvedEngine {
        engine,
        chain,
        keyless_default,
        sole_engine_class,
    }
}

fn build_keyless_chain(
    session: &WebSearchSessionConfig,
    base: &EngineBaseUrls,
) -> Vec<Arc<dyn WebSearchEngine>> {
    let mut names: Vec<&str> = Vec::new();
    if !session.disable_exa {
        names.push("exa");
    }
    if !session.disable_parallel {
        names.push("parallel");
    }
    if !session.disable_mojeek {
        names.push("mojeek");
    }
    names.push("marginalia");
    names.push("wikipedia");
    names
        .into_iter()
        .filter_map(|n| build_named(n, session, base))
        .collect()
}
