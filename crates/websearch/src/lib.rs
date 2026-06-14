//! WebSearch tool — Rust port of `@agent-sh/harness-websearch`.
//!
//! Conforms to `agent-knowledge/design/websearch.md`. Same contract as the
//! TS package: declarative web search via a session-configured SearXNG
//! backend, with tool-layer SSRF defense on the backend URL, a permission
//! hook, a result-count cap, and a discriminated `ok`/`empty`/`error`
//! result surface. WebSearch finds; WebFetch reads — there is no HTML
//! extraction and no spill-to-file (a result list is bounded by `count`).

mod constants;
mod engine;
mod engines;
mod fence;
mod format;
mod run;
mod schema;
mod ssrf;
mod types;

pub use constants::*;
pub use engine::{
    default_engine, ReqwestEngine, SearchError, SearchErrorCode, WebSearchEngine,
    WebSearchEngineInput, WebSearchEngineResult,
};
pub use engines::{
    resolve_engine, BraveEngine, EngineBaseUrls, FallbackEngine, MarginaliaEngine, MojeekEngine,
    ResolvedEngine, TavilyEngine, WikipediaEngine,
};
pub use format::{format_empty_text, format_ok_text, render_search_block};
pub use schema::{
    safe_parse_websearch_params, WebSearchParams, WebSearchParseError,
    WEBSEARCH_TOOL_DESCRIPTION, WEBSEARCH_TOOL_NAME,
};
pub use ssrf::{classify_host, classify_ip, BlockClass, SsrfDecision};
pub use types::{
    SafeSearch, SearchMetadata, WebSearchEmpty, WebSearchError, WebSearchOk,
    WebSearchPermissionPolicy, WebSearchResult, WebSearchResultItem, WebSearchSessionConfig,
    WebSearchTimeRange,
};

pub async fn websearch(
    params: serde_json::Value,
    session: &WebSearchSessionConfig,
) -> WebSearchResult {
    run::websearch_run(params, session).await
}
