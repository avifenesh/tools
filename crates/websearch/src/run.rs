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
use crate::engines::resolve_engine;
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

    // Resolve the engine chain. With no key and no searxng_url this yields the
    // bundled keyless default (Mojeek → Marginalia → Wikipedia), so search
    // works with zero config — there is no longer a hard "no backend" error.
    let resolved = resolve_engine(session);

    // When an explicit SearXNG backend is configured, validate its URL/scheme
    // and SSRF up front so the model gets the SearXNG-specific hint. The
    // keyless/keyed engines self-check their (public) hosts per call.
    if let Some(searxng_url) = session.searxng_url.as_deref() {
        if !searxng_url.is_empty() {
            if let Some(e) = validate_searxng_backend(searxng_url, session).await {
                return err(e);
            }
        }
    }

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

    let permission_host = permission_backend_host(session);
    let backend_label = session
        .searxng_url
        .clone()
        .unwrap_or_else(|| format!("keyless ({})", resolved.chain.join(" → ")));

    // Permission hook (autonomous — allow or deny).
    let backend_url_for_hook = session
        .searxng_url
        .clone()
        .unwrap_or_else(|| format!("keyless:{}", resolved.chain.join("+")));
    let ask_args = AskArgs {
        query: &params.query,
        backend_url: &backend_url_for_hook,
        backend_host: &permission_host,
        chain: &resolved.chain,
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

    // Per-request host-check closure (re-classifies the resolved host).
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
        backend_url: session.searxng_url.clone().unwrap_or_default(),
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

    let ctx = TranslateCtx {
        keyless_default: resolved.keyless_default,
        backend_label: &backend_label,
    };

    let search_fut = resolved.engine.search(engine_input);
    let engine_result =
        match tokio::time::timeout(Duration::from_millis(session_backstop), search_fut).await {
            Ok(r) => r,
            Err(_) => {
                return err(translate_search_error(
                    SearchError::new(SearchErrorCode::Timeout, "session backstop elapsed"),
                    &params.query,
                    &ctx,
                ));
            }
        };
    let engine_result = match engine_result {
        Ok(r) => r,
        Err(e) => return err(translate_search_error(e, &params.query, &ctx)),
    };

    let served_by = engine_result
        .engine
        .clone()
        .or_else(|| resolved.chain.first().cloned());

    let mut results = engine_result.results;
    results.truncate(count);

    let meta = SearchMetadata {
        query: params.query.clone(),
        backend_host: engine_result.backend_host,
        count: results.len(),
        time_range,
        elapsed_ms: engine_result.elapsed_ms,
        engine: served_by,
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

/// Host label used for the permission pattern + audit metadata.
fn permission_backend_host(session: &WebSearchSessionConfig) -> String {
    if let Some(u) = session.searxng_url.as_deref() {
        if !u.is_empty() {
            return Url::parse(u)
                .ok()
                .and_then(|x| x.host_str().map(|s| s.to_string()))
                .unwrap_or_else(|| u.to_string());
        }
    }
    if session.brave_api_key.as_deref().is_some_and(|k| !k.is_empty()) {
        return "brave".to_string();
    }
    if session
        .tavily_api_key
        .as_deref()
        .is_some_and(|k| !k.is_empty())
    {
        return "tavily".to_string();
    }
    "keyless".to_string()
}

/// Up-front validation + SSRF for an explicitly configured SearXNG backend.
async fn validate_searxng_backend(
    searxng_url: &str,
    session: &WebSearchSessionConfig,
) -> Option<ToolError> {
    let backend_url = match Url::parse(searxng_url) {
        Ok(u) => u,
        Err(_) => {
            return Some(ToolError::new(
                ToolErrorCode::InvalidParam,
                format!("invalid session.searxng_url: {}", searxng_url),
            ));
        }
    };
    let scheme = backend_url.scheme();
    if scheme != "http" && scheme != "https" {
        return Some(
            ToolError::new(
                ToolErrorCode::InvalidParam,
                format!("session.searxng_url must be http(s); received '{}:'", scheme),
            )
            .with_meta(serde_json::json!({ "backend": searxng_url })),
        );
    }
    let backend_host = backend_url.host_str().unwrap_or("").to_string();
    match classify_host(&backend_host, session).await {
        SsrfDecision::Allowed => None,
        SsrfDecision::Blocked { reason, hint } => Some(
            ToolError::new(
                ToolErrorCode::SsrfBlocked,
                format!("{}\nBackend: {}\nHint: {}", reason, searxng_url, hint),
            )
            .with_meta(serde_json::json!({ "backend": searxng_url, "host": backend_host })),
        ),
    }
}

struct TranslateCtx<'a> {
    keyless_default: bool,
    backend_label: &'a str,
}

const KEYLESS_HINT: &str = "All search backends are rate-limited or returned nothing. For reliable results, set a free Brave Search API key (api-dashboard.search.brave.com) via session.brave_api_key, add a Tavily key, or run a local SearXNG and set session.searxng_url.";

fn translate_search_error(e: SearchError, query: &str, ctx: &TranslateCtx<'_>) -> ToolError {
    let echo = format!("\nQuery: \"{}\"\nBackend: {}", query, ctx.backend_label);
    let meta = serde_json::json!({ "query": query, "backend": ctx.backend_label });
    match e.code {
        SearchErrorCode::SsrfBlocked => {
            ToolError::new(ToolErrorCode::SsrfBlocked, format!("{}{}", e.message, echo))
                .with_meta(meta)
        }
        SearchErrorCode::ServerNotAvailable => {
            let lower = e.message.to_lowercase();
            let hint = if ctx.keyless_default {
                KEYLESS_HINT.to_string()
            } else if lower.contains("refused") || lower.contains("connect") {
                "The SearXNG instance does not appear to be running. Start it (docker run searxng/searxng) and ensure session.searxng_url points at its address with JSON format enabled.".to_string()
            } else {
                "The backend is reachable but returned an error status. Check its logs, that JSON format is enabled (SearXNG), or that the API key is valid.".to_string()
            };
            ToolError::new(
                ToolErrorCode::ServerNotAvailable,
                format!(
                    "The search backend returned an error.{}\nReason: {}\nHint: {}",
                    echo, e.message, hint
                ),
            )
            .with_meta(meta)
        }
        SearchErrorCode::Timeout => {
            let hint = if ctx.keyless_default {
                "Keyless backends can be slow; raise session.search_timeout_ms (max 30000), simplify the query, or add a Brave/Tavily key."
            } else {
                "Raise session.search_timeout_ms (max 30000) or simplify the query."
            };
            ToolError::new(
                ToolErrorCode::Timeout,
                format!("The search timed out.{}\nReason: {}\nHint: {}", echo, e.message, hint),
            )
            .with_meta(meta)
        }
        SearchErrorCode::DnsError => ToolError::new(
            ToolErrorCode::DnsError,
            format!(
                "Could not resolve the search backend hostname.{}\nReason: {}\nHint: Check network connectivity{}.",
                echo,
                e.message,
                if ctx.keyless_default { "" } else { " and session.searxng_url" }
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
        SearchErrorCode::ConnectionReset => {
            let hint = if ctx.keyless_default {
                "All keyless backends were unreachable. Check network connectivity, or set a Brave/Tavily key or local SearXNG for reliability."
            } else {
                "The SearXNG instance does not appear to be running. Start it (docker run searxng/searxng) and ensure session.searxng_url points at its address with JSON format enabled."
            };
            ToolError::new(
                ToolErrorCode::ConnectionReset,
                format!("Could not reach the search backend.{}\nReason: connection reset\nHint: {}", echo, hint),
            )
            .with_meta(meta)
        }
        SearchErrorCode::InvalidParam => {
            ToolError::new(ToolErrorCode::InvalidParam, format!("{}{}", e.message, echo))
                .with_meta(meta)
        }
        SearchErrorCode::IoError => ToolError::new(
            ToolErrorCode::IoError,
            format!("Search failed.{}\nReason: {}", echo, e.message),
        )
        .with_meta(meta),
    }
}
