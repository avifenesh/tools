//! WebFetch tool — Rust port of `@agent-sh/harness-webfetch`.
//!
//! Conforms to `agent-knowledge/design/webfetch.md`. Same contract as the
//! TS package: HTTP GET/POST with tool-layer SSRF defense, manual
//! redirect loop with per-hop re-check, readability+markdown extraction,
//! 3-tier size caps with spill-to-file, and an in-memory 5-min session
//! cache.

mod constants;
mod engine;
mod extractor;
mod fence;
mod format;
mod run;
mod schema;
mod ssrf;
mod types;

pub use constants::*;
pub use engine::{default_engine, FetchError, ReqwestEngine, WebFetchEngine, WebFetchEngineInput, WebFetchEngineResult};
pub use format::{
    format_http_error_text, format_ok_text, format_redirect_loop_text,
    head_and_tail, render_request_block, spill_to_file,
};
pub use schema::{
    safe_parse_webfetch_params, WebFetchParams, WebFetchParseError,
    WEBFETCH_TOOL_DESCRIPTION, WEBFETCH_TOOL_NAME,
};
pub use ssrf::{classify_host, classify_ip, BlockClass, SsrfDecision};
pub use types::{
    CachedResponse, FetchMetadata, WebFetchCache, WebFetchError, WebFetchExtract,
    WebFetchHttpError, WebFetchMethod, WebFetchOk, WebFetchPermissionPolicy,
    WebFetchRedirectLoop, WebFetchResult, WebFetchSessionConfig,
};

pub async fn webfetch(
    params: serde_json::Value,
    session: &WebFetchSessionConfig,
) -> WebFetchResult {
    run::webfetch_run(params, session).await
}
