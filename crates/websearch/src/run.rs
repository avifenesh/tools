use harness_core::{ToolError, ToolErrorCode};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use url::Url;

use crate::constants::{
    DEFAULT_CATEGORIES, DEFAULT_COUNT, DEFAULT_LANGUAGE, DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT,
    MAX_COUNT, MIN_COUNT, MIN_TIMEOUT_MS, SESSION_BACKSTOP_MS,
};
use crate::engine::{SearchError, SearchErrorCode, WebSearchEngineInput};
use crate::fence::{ask_permission, permission_denied_error, AskArgs, PermissionOutcome};
use crate::format::{format_empty_text, format_ok_text, FormatOkArgs};
use crate::schema::safe_parse_websearch_params;
use crate::ssrf::{classify_host, SsrfDecision};
use crate::types::{
    SafeSearch, SearchMetadata, WebSearchEmpty, WebSearchError, WebSearchOk, WebSearchResult,
    WebSearchSessionConfig, WebSearchTimeRange,
};

fn err(error: ToolError) -> WebSearchResult {
    WebSearchResult::Error(WebSearchError { error })
}

fn clamp_count(n: Option<i64>) -> usize {
    match n {
        None => DEFAULT_COUNT,
        Some(v) if v < MIN_COUNT as i64 => MIN_COUNT,
        Some(v) if v > MAX_COUNT as i64 => MAX_COUNT,
        Some(v) => v as usize,
    }
}

fn normalize_headers(session: &WebSearchSessionConfig) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    if let Some(defaults) = &session.default_headers {
        for (k, v) in defaults {
            out.insert(k.to_ascii_lowercase(), v.clone());
        }
    }
    if !out.contains_key("user-agent") {
        out.insert("user-agent".to_string(), DEFAULT_USER_AGENT.to_string());
    }
    if !out.contains_key("accept") {
        out.insert("accept".to_string(), "application/json".to_string());
    }
    out
}

pub async fn websearch_run(input: Value, session: &WebSearchSessionConfig) -> WebSearchResult {
    let params = match safe_parse_websearch_params(&input) {
        Ok(p) => p,
        Err(e) => return err(ToolError::new(ToolErrorCode::InvalidParam, e.to_string())),
    };

    // Backend must be configured on the session — never a model param.
    let searxng_url = match &session.searxng_url {
        Some(u) if !u.is_empty() => u.clone(),
        _ => {
            return err(ToolError::new(
                ToolErrorCode::InvalidParam,
                "no search backend configured; set session.searxng_url",
            ));
        }
    };

    let backend_url = match Url::parse(&searxng_url) {
        Ok(u) => u,
        Err(_) => {
            return err(ToolError::new(
                ToolErrorCode::InvalidParam,
                format!("invalid session.searxng_url: {}", searxng_url),
            ));
        }
    };
    let scheme = backend_url.scheme();
    if scheme != "http" && scheme != "https" {
        return err(ToolError::new(
            ToolErrorCode::InvalidParam,
            format!(
                "session.searxng_url must be http(s); received '{}:'",
                scheme
            ),
        )
        .with_meta(serde_json::json!({ "backend": searxng_url })));
    }
    let backend_host = backend_url.host_str().unwrap_or("").to_string();

    let count = clamp_count(params.count);
    let time_range: WebSearchTimeRange = params.time_range.unwrap_or(WebSearchTimeRange::All);
    let language = params
        .language
        .clone()
        .unwrap_or_else(|| DEFAULT_LANGUAGE.to_string());
    let safe_search: SafeSearch = params.safe_search.unwrap_or(SafeSearch::Moderate);
    let categories: Vec<String> = match &params.categories {
        Some(c) if !c.is_empty() => c.clone(),
        _ => DEFAULT_CATEGORIES.iter().map(|s| s.to_string()).collect(),
    };

    let timeout_ms = session
        .search_timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .max(MIN_TIMEOUT_MS);
    let session_backstop = session.session_backstop_ms.unwrap_or(SESSION_BACKSTOP_MS);
    let effective_timeout = timeout_ms.min(session_backstop);
    let headers = normalize_headers(session);

    // SSRF check on the backend host before anything fires.
    match classify_host(&backend_host, session).await {
        SsrfDecision::Allowed => {}
        SsrfDecision::Blocked { reason, hint } => {
            return err(ToolError::new(
                ToolErrorCode::SsrfBlocked,
                format!("{}\nBackend: {}\nHint: {}", reason, searxng_url, hint),
            )
            .with_meta(
                serde_json::json!({ "backend": searxng_url, "host": backend_host }),
            ));
        }
    }

    // Permission hook (autonomous — allow or deny).
    let ask_args = AskArgs {
        query: &params.query,
        backend_url: &searxng_url,
        backend_host: &backend_host,
        count,
        time_range,
        safe_search,
        categories: &categories,
    };
    match ask_permission(session, ask_args).await {
        PermissionOutcome::Allow => {}
        PermissionOutcome::Deny { reason } => {
            return err(permission_denied_error(&params.query, &reason));
        }
    }

    // Per-request host-check closure (re-classifies the resolved backend host).
    let session_for_check = session.clone();
    let check_host: crate::engine::HostCheckFn = Arc::new(move |h: String| {
        let s = session_for_check.clone();
        Box::pin(async move {
            match classify_host(&h, &s).await {
                SsrfDecision::Allowed => Ok(()),
                SsrfDecision::Blocked { reason, hint } => {
                    Err(format!("{}. Hint: {}", reason, hint))
                }
            }
        })
    });

    let engine_input = WebSearchEngineInput {
        backend_url: searxng_url.clone(),
        query: params.query.clone(),
        count,
        time_range,
        language,
        safe_search,
        categories,
        timeout_ms: effective_timeout,
        headers,
        check_host,
    };

    let search_fut = session.engine.search(engine_input);
    let engine_result = match tokio::time::timeout(
        Duration::from_millis(session_backstop),
        search_fut,
    )
    .await
    {
        Ok(r) => r,
        Err(_) => {
            return err(translate_search_error(
                SearchError::new(
                    SearchErrorCode::Timeout,
                    "session backstop elapsed".to_string(),
                ),
                &params.query,
                &searxng_url,
            ));
        }
    };
    let engine_result = match engine_result {
        Ok(r) => r,
        Err(e) => return err(translate_search_error(e, &params.query, &searxng_url)),
    };

    let mut results = engine_result.results;
    results.truncate(count);

    let meta = SearchMetadata {
        query: params.query.clone(),
        backend_host: engine_result.backend_host,
        count: results.len(),
        time_range,
        elapsed_ms: engine_result.elapsed_ms,
    };

    if results.is_empty() {
        return WebSearchResult::Empty(WebSearchEmpty {
            output: format_empty_text(&meta),
            meta,
        });
    }

    let output = format_ok_text(FormatOkArgs {
        meta: &meta,
        results: &results,
        requested: count,
    });
    WebSearchResult::Ok(WebSearchOk {
        output,
        meta,
        results,
        requested: count,
    })
}

fn translate_search_error(e: SearchError, query: &str, backend: &str) -> ToolError {
    let echo = format!("\nQuery: \"{}\"\nBackend: {}", query, backend);
    let meta = serde_json::json!({ "query": query, "backend": backend });
    match e.code {
        SearchErrorCode::ServerNotAvailable => {
            // Distinguish a refused connection (down) from a 5xx (reachable
            // but failing) by the message shape.
            let lower = e.message.to_lowercase();
            if lower.contains("refused") || lower.contains("connect") {
                ToolError::new(
                    ToolErrorCode::ServerNotAvailable,
                    format!(
                        "Could not reach the search backend.{}\nReason: connection refused\nHint: The SearXNG instance does not appear to be running. Start it (docker run searxng/searxng) and ensure session.searxng_url points at its address with JSON format enabled.",
                        echo
                    ),
                )
                .with_meta(meta)
            } else {
                ToolError::new(
                    ToolErrorCode::ServerNotAvailable,
                    format!(
                        "The search backend returned an error.{}\nReason: {}\nHint: The SearXNG instance is reachable but failing. Check its logs and that JSON format is enabled.",
                        echo, e.message
                    ),
                )
                .with_meta(meta)
            }
        }
        SearchErrorCode::Timeout => ToolError::new(
            ToolErrorCode::Timeout,
            format!(
                "The search timed out.{}\nReason: {}\nHint: The metasearch may be slow; raise session.search_timeout_ms (max 30000) or simplify the query.",
                echo, e.message
            ),
        )
        .with_meta(meta),
        SearchErrorCode::DnsError => ToolError::new(
            ToolErrorCode::DnsError,
            format!(
                "Could not resolve the search backend hostname.{}\nReason: {}\nHint: Check session.searxng_url points at a reachable host.",
                echo, e.message
            ),
        )
        .with_meta(meta),
        SearchErrorCode::TlsError => ToolError::new(
            ToolErrorCode::TlsError,
            format!(
                "TLS / certificate error talking to the search backend.{}\nReason: {}\nHint: Check the backend's certificate or use http:// for a local instance.",
                echo, e.message
            ),
        )
        .with_meta(meta),
        SearchErrorCode::ConnectionReset => ToolError::new(
            ToolErrorCode::ConnectionReset,
            format!(
                "Could not reach the search backend.{}\nReason: connection reset\nHint: The SearXNG instance does not appear to be running. Start it (docker run searxng/searxng) and ensure session.searxng_url points at its address with JSON format enabled.",
                echo
            ),
        )
        .with_meta(meta),
        SearchErrorCode::SsrfBlocked => ToolError::new(
            ToolErrorCode::SsrfBlocked,
            format!("{}{}", e.message, echo),
        )
        .with_meta(meta),
        SearchErrorCode::InvalidParam => ToolError::new(
            ToolErrorCode::InvalidParam,
            format!("{}{}", e.message, echo),
        )
        .with_meta(meta),
        SearchErrorCode::IoError => ToolError::new(
            ToolErrorCode::IoError,
            format!("Search failed.{}\nReason: {}", echo, e.message),
        )
        .with_meta(meta),
    }
}
