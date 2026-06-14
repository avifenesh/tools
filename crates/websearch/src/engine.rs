use async_trait::async_trait;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};
use url::Url;

use crate::types::{SafeSearch, WebSearchResultItem, WebSearchTimeRange};

#[derive(Clone)]
pub struct WebSearchEngineInput {
    pub backend_url: String,
    pub query: String,
    pub count: usize,
    pub time_range: WebSearchTimeRange,
    pub language: String,
    pub safe_search: SafeSearch,
    pub categories: Vec<String>,
    pub timeout_ms: u64,
    pub headers: HashMap<String, String>,
    /// Called BEFORE the request fires with the resolved backend host.
    /// Returning Err aborts the search with an SSRF-shaped SearchError.
    pub check_host: HostCheckFn,
}

pub type HostCheckFn = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync,
>;

pub struct WebSearchEngineResult {
    pub results: Vec<WebSearchResultItem>,
    pub backend_host: String,
    pub elapsed_ms: u64,
    /// Which engine served this result (provenance). None until set by an
    /// engine or the fallback layer.
    pub engine: Option<String>,
    /// Coverage class of the serving engine (set by the fallback layer).
    pub engine_class: Option<EngineClass>,
    /// Whether the serving engine applied the requested time_range. None when
    /// time_range=all (nothing to apply).
    pub time_range_applied: Option<bool>,
}

#[async_trait]
pub trait WebSearchEngine: Send + Sync {
    async fn search(
        &self,
        input: WebSearchEngineInput,
    ) -> Result<WebSearchEngineResult, SearchError>;

    /// Engine name for provenance / fallback diagnostics. Defaults to
    /// "searxng" for the legacy ReqwestEngine; new engines override it.
    fn name(&self) -> &str {
        "searxng"
    }

    /// Coverage class, used by the fallback chain to decide whether an `empty`
    /// result is authoritative. Defaults to General (SearXNG is broad web).
    fn engine_class(&self) -> EngineClass {
        EngineClass::General
    }
}

/// Engine coverage class. A "general" engine's empty is a trustworthy "the web
/// had nothing" signal; a niche/vertical empty says far less, so the fallback
/// chain treats a niche/vertical-only empty while a general engine ERRORED as
/// a degraded failure rather than a clean empty. Mirrors TS `EngineClass`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineClass {
    General,
    Niche,
    Vertical,
}

impl EngineClass {
    /// Human/model-readable coverage label used in the output header.
    pub fn label(self) -> &'static str {
        match self {
            Self::General => "general web",
            Self::Niche => "indie/small-web index",
            Self::Vertical => "encyclopedic",
        }
    }
}

/// Engine-local error code, distinct from `harness_core::ToolErrorCode`. The
/// orchestrator translates these into a `ToolError` reusing the existing
/// core code set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchErrorCode {
    InvalidParam,
    ServerNotAvailable,
    DnsError,
    TlsError,
    Timeout,
    ConnectionReset,
    SsrfBlocked,
    IoError,
}

#[derive(Debug, Clone)]
pub struct SearchError {
    pub code: SearchErrorCode,
    pub message: String,
}

impl SearchError {
    pub fn new(code: SearchErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub struct ReqwestEngine {
    client: reqwest::Client,
}

impl ReqwestEngine {
    pub fn new() -> Self {
        Self {
            client: shared_client(),
        }
    }
}

/// A reqwest client configured the way every engine wants it (no auto-redirect
/// so we control SSRF; gzip; rustls). Cheap to clone (Arc inside).
pub(crate) fn shared_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("reqwest client build")
}

impl Default for ReqwestEngine {
    fn default() -> Self {
        Self::new()
    }
}

pub fn default_engine() -> Arc<dyn WebSearchEngine> {
    Arc::new(ReqwestEngine::new())
}

#[async_trait]
impl WebSearchEngine for ReqwestEngine {
    async fn search(
        &self,
        input: WebSearchEngineInput,
    ) -> Result<WebSearchEngineResult, SearchError> {
        let base = Url::parse(&input.backend_url).map_err(|_| {
            SearchError::new(
                SearchErrorCode::IoError,
                format!("Invalid backend URL: {}", input.backend_url),
            )
        })?;
        let host = base.host_str().unwrap_or("").to_string();

        // Re-run the SSRF check on the resolved backend host before dialing.
        (input.check_host)(host.clone())
            .await
            .map_err(|msg| SearchError::new(SearchErrorCode::SsrfBlocked, msg))?;

        let url = build_search_url(&base, &input);
        let started = Instant::now();

        let mut req = self
            .client
            .request(reqwest::Method::GET, url)
            .timeout(Duration::from_millis(input.timeout_ms));
        for (k, v) in &input.headers {
            req = req.header(k, v);
        }

        let res = req.send().await.map_err(classify_reqwest_error)?;
        let status = res.status().as_u16();

        if status >= 400 {
            if status >= 500 {
                return Err(SearchError::new(
                    SearchErrorCode::ServerNotAvailable,
                    format!("Search backend returned HTTP {}", status),
                ));
            }
            return Err(SearchError::new(
                SearchErrorCode::InvalidParam,
                format!("Search backend rejected the query with HTTP {}", status),
            ));
        }

        let bytes = res.bytes().await.map_err(classify_reqwest_error)?;
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
            SearchError::new(
                SearchErrorCode::IoError,
                format!(
                    "Could not parse the search backend response as JSON: {}",
                    e
                ),
            )
        })?;

        let results = map_results(&parsed);
        Ok(WebSearchEngineResult {
            results,
            backend_host: host,
            elapsed_ms: started.elapsed().as_millis() as u64,
            engine: Some("searxng".to_string()),
            engine_class: None,
            // SearXNG applies the time_range param when one is requested.
            time_range_applied: if input.time_range == WebSearchTimeRange::All {
                None
            } else {
                Some(true)
            },
        })
    }
}

fn build_search_url(base: &Url, input: &WebSearchEngineInput) -> Url {
    // Append /search to the configured base, preserving any base path.
    let mut url = base.clone();
    let trimmed = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{}/search", trimmed));
    {
        let mut p = url.query_pairs_mut();
        p.append_pair("q", &input.query);
        p.append_pair("format", "json");
        p.append_pair(
            "safesearch",
            &input.safe_search.to_numeric().to_string(),
        );
        // "all" omits the time_range param (SearXNG treats absent as all-time).
        if input.time_range != WebSearchTimeRange::All {
            p.append_pair("time_range", input.time_range.as_str());
        }
        p.append_pair("language", &input.language);
        p.append_pair("categories", &input.categories.join(","));
        p.append_pair("pageno", "1");
    }
    url
}

fn map_results(parsed: &serde_json::Value) -> Vec<WebSearchResultItem> {
    let raw = match parsed.get("results").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return Vec::new(),
    };
    let mut out: Vec<WebSearchResultItem> = Vec::new();
    for entry in raw {
        if !entry.is_object() {
            continue;
        }
        let title = entry.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
        // Missing title/url → skip.
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet = entry.get("content").and_then(|v| v.as_str()).unwrap_or("");
        out.push(WebSearchResultItem {
            title: title.to_string(),
            url: url.to_string(),
            snippet: snippet.to_string(),
            age: None,
            score: None,
        });
    }
    out
}

pub(crate) fn classify_reqwest_error(e: reqwest::Error) -> SearchError {
    let msg = e.to_string();
    // reqwest's top-level Display rarely carries the OS-level reason
    // ("Connection refused"); walk the source chain so the orchestrator can
    // tell a down backend (refused) from a mid-flight drop (reset).
    let chain = error_chain(&e);
    if e.is_timeout() {
        return SearchError::new(SearchErrorCode::Timeout, msg);
    }
    if e.is_connect() {
        let lower = chain.to_lowercase();
        if lower.contains("dns")
            || lower.contains("resolve")
            || lower.contains("lookup")
            || lower.contains("not known")
            || lower.contains("no such host")
        {
            return SearchError::new(SearchErrorCode::DnsError, msg);
        }
        // A refused connection to a configured-but-down SearXNG surfaces
        // here; tag it "refused" so the orchestrator emits the "start it"
        // hint under SERVER_NOT_AVAILABLE.
        return SearchError::new(
            SearchErrorCode::ServerNotAvailable,
            format!("connection refused: {}", chain),
        );
    }
    let lower = chain.to_lowercase();
    if lower.contains("tls") || lower.contains("certificate") || lower.contains("ssl") {
        return SearchError::new(SearchErrorCode::TlsError, msg);
    }
    if lower.contains("reset") {
        return SearchError::new(SearchErrorCode::ConnectionReset, msg);
    }
    SearchError::new(SearchErrorCode::IoError, msg)
}

/// Flatten an error and its source chain into one string for keyword sniffing.
pub(crate) fn error_chain(e: &reqwest::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        parts.push(s.to_string());
        src = s.source();
    }
    parts.join("; ")
}
