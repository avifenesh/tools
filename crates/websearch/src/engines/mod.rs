//! New default engines (keyless + keyed) and the fallback-chain resolver.
//! Mirrors the TS `src/engines/` directory. All engines implement the
//! existing `WebSearchEngine` trait so they slot into the session unchanged.

mod brave;
mod fallback;
mod html;
mod http;
mod marginalia;
mod mojeek;
mod tavily;
mod wikipedia;

pub use brave::BraveEngine;
pub use fallback::FallbackEngine;
pub use marginalia::MarginaliaEngine;
pub use mojeek::MojeekEngine;
pub use tavily::TavilyEngine;
pub use wikipedia::WikipediaEngine;

use std::sync::Arc;

use crate::engine::WebSearchEngine;
use crate::types::WebSearchSessionConfig;

/// Per-engine base-URL overrides (tests point these at local fixture servers).
#[derive(Clone, Default)]
pub struct EngineBaseUrls {
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
}

/// Build the engine to run for this session — the Rust twin of TS
/// `resolveEngine`. Priority: explicit override → Brave/Tavily (keyed) →
/// SearXNG (searxng_url) → keyless chain (Mojeek → Marginalia → Wikipedia).
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
        };
    }

    let base = session.engine_base_urls.clone().unwrap_or_default();

    let has_brave = session.brave_api_key.as_deref().is_some_and(|k| !k.is_empty());
    let has_tavily = session
        .tavily_api_key
        .as_deref()
        .is_some_and(|k| !k.is_empty());
    let has_searxng = session.searxng_url.as_deref().is_some_and(|u| !u.is_empty());
    let has_explicit = has_brave || has_tavily || has_searxng;

    let mut explicit: Vec<Arc<dyn WebSearchEngine>> = Vec::new();
    if has_brave {
        let key = session.brave_api_key.clone().unwrap();
        let mut e = BraveEngine::new(key);
        if let Some(u) = &base.brave {
            e = e.with_base_url(u.clone());
        }
        explicit.push(Arc::new(e));
    }
    if has_tavily {
        let key = session.tavily_api_key.clone().unwrap();
        let mut e = TavilyEngine::new(key);
        if let Some(u) = &base.tavily {
            e = e.with_base_url(u.clone());
        }
        explicit.push(Arc::new(e));
    }
    if has_searxng {
        // The legacy ReqwestEngine reads backend_url from the engine input,
        // which the orchestrator sets to searxng_url.
        explicit.push(crate::engine::default_engine());
    }

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

    let chain: Vec<String> = engines.iter().map(|e| e.name().to_string()).collect();
    let engine: Arc<dyn WebSearchEngine> = if engines.len() == 1 {
        engines.into_iter().next().unwrap()
    } else {
        Arc::new(FallbackEngine::new(engines))
    };

    ResolvedEngine {
        engine,
        chain,
        keyless_default: !has_explicit,
    }
}

fn build_keyless_chain(
    session: &WebSearchSessionConfig,
    base: &EngineBaseUrls,
) -> Vec<Arc<dyn WebSearchEngine>> {
    let mut chain: Vec<Arc<dyn WebSearchEngine>> = Vec::new();
    if !session.disable_mojeek {
        let mut e = MojeekEngine::new();
        if let Some(u) = &base.mojeek {
            e = e.with_base_url(u.clone());
        }
        chain.push(Arc::new(e));
    }
    let mut marg = MarginaliaEngine::new();
    if let Some(u) = &base.marginalia {
        marg = marg.with_base_url(u.clone());
    }
    chain.push(Arc::new(marg));

    let mut wiki = WikipediaEngine::new();
    if let Some(u) = &base.wikipedia {
        wiki = wiki.with_base_url(u.clone());
    }
    chain.push(Arc::new(wiki));
    chain
}
