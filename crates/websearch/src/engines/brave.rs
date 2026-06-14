//! Brave Search API — keyed. See TS `engines/brave.ts`.

use async_trait::async_trait;
use url::Url;

use super::html::strip_tags;
use super::http::http_get;
use crate::engine::{
    shared_client, SearchError, SearchErrorCode, WebSearchEngine, WebSearchEngineInput,
    WebSearchEngineResult,
};
use crate::types::{WebSearchResultItem, WebSearchTimeRange};

const DEFAULT_BASE: &str = "https://api.search.brave.com";
const ENGINE_NAME: &str = "brave";

pub struct BraveEngine {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl BraveEngine {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            client: shared_client(),
            api_key: api_key.into(),
            base_url: DEFAULT_BASE.to_string(),
        }
    }
    pub fn with_base_url(mut self, base: impl Into<String>) -> Self {
        self.base_url = base.into();
        self
    }
}

#[async_trait]
impl WebSearchEngine for BraveEngine {
    fn name(&self) -> &str {
        ENGINE_NAME
    }

    async fn search(
        &self,
        input: WebSearchEngineInput,
    ) -> Result<WebSearchEngineResult, SearchError> {
        let mut url = Url::parse(&self.base_url).map_err(|_| {
            SearchError::new(
                SearchErrorCode::IoError,
                format!("invalid brave base url: {}", self.base_url),
            )
        })?;
        {
            let base_path = url.path().trim_end_matches('/').to_string();
            url.set_path(&format!("{}/res/v1/web/search", base_path));
            let mut p = url.query_pairs_mut();
            p.append_pair("q", &input.query);
            p.append_pair("count", &input.count.to_string());
            if let Some(fresh) = to_brave_freshness(input.time_range) {
                p.append_pair("freshness", fresh);
            }
        }

        let res = http_get(
            &self.client,
            &url,
            &input,
            "application/json",
            ENGINE_NAME,
            &[("x-subscription-token", self.api_key.clone())],
        )
        .await?;

        let parsed: serde_json::Value = serde_json::from_str(&res.text).map_err(|e| {
            SearchError::new(
                SearchErrorCode::IoError,
                format!("brave: could not parse response as JSON: {}", e),
            )
        })?;

        Ok(WebSearchEngineResult {
            results: map_results(&parsed),
            backend_host: res.host,
            elapsed_ms: res.elapsed_ms,
            engine: Some(ENGINE_NAME.to_string()),
            engine_class: None,
            // Brave honors freshness when a time_range was requested.
            time_range_applied: if input.time_range == WebSearchTimeRange::All {
                None
            } else {
                Some(true)
            },
        })
    }
}

fn to_brave_freshness(range: WebSearchTimeRange) -> Option<&'static str> {
    match range {
        WebSearchTimeRange::Day => Some("pd"),
        WebSearchTimeRange::Week => Some("pw"),
        WebSearchTimeRange::Month => Some("pm"),
        WebSearchTimeRange::Year => Some("py"),
        WebSearchTimeRange::All => None,
    }
}

fn map_results(parsed: &serde_json::Value) -> Vec<WebSearchResultItem> {
    let raw = match parsed
        .get("web")
        .and_then(|w| w.get("results"))
        .and_then(|v| v.as_array())
    {
        Some(arr) => arr,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in raw {
        let title = entry
            .get("title")
            .and_then(|v| v.as_str())
            .map(strip_tags)
            .unwrap_or_default();
        let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet = entry
            .get("description")
            .and_then(|v| v.as_str())
            .map(strip_tags)
            .unwrap_or_default();
        // Brave exposes page freshness as `age` (or `page_age`); pass through
        // the date portion / short relative string when present.
        let age = entry
            .get("age")
            .and_then(|v| v.as_str())
            .or_else(|| entry.get("page_age").and_then(|v| v.as_str()))
            .and_then(normalize_age);
        out.push(WebSearchResultItem {
            title,
            url: url.to_string(),
            snippet,
            age,
            score: None,
        });
    }
    out
}

/// Brave's `age` is sometimes an ISO date ("2025-06-10") and sometimes a short
/// relative string ("3 days ago"). Keep an ISO date's date portion; otherwise
/// pass a short relative string through verbatim.
fn normalize_age(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    let bytes = t.as_bytes();
    if bytes.len() >= 10
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return Some(t[0..10].to_string());
    }
    if t.len() <= 24 {
        Some(t.to_string())
    } else {
        None
    }
}
