//! Tavily Search API — keyed, POST. See TS `engines/tavily.ts`.

use async_trait::async_trait;
use std::time::Instant;
use url::Url;

use super::html::strip_tags;
use crate::engine::{
    classify_reqwest_error, shared_client, SearchError, SearchErrorCode, WebSearchEngine,
    WebSearchEngineInput, WebSearchEngineResult,
};
use crate::types::{WebSearchResultItem, WebSearchTimeRange};

const DEFAULT_BASE: &str = "https://api.tavily.com";
const ENGINE_NAME: &str = "tavily";

pub struct TavilyEngine {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl TavilyEngine {
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
impl WebSearchEngine for TavilyEngine {
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
                format!("invalid tavily base url: {}", self.base_url),
            )
        })?;
        {
            let base_path = url.path().trim_end_matches('/').to_string();
            url.set_path(&format!("{}/search", base_path));
        }
        let host = url.host_str().unwrap_or("").to_string();
        (input.check_host)(host.clone())
            .await
            .map_err(|msg| SearchError::new(SearchErrorCode::SsrfBlocked, msg))?;

        let mut body = serde_json::json!({
            "api_key": self.api_key,
            "query": input.query,
            "max_results": input.count,
            "search_depth": "basic",
        });
        if input.time_range != WebSearchTimeRange::All {
            body["time_range"] = serde_json::json!(input.time_range.as_str());
        }

        let started = Instant::now();
        let res = self
            .client
            .request(reqwest::Method::POST, url)
            .timeout(std::time::Duration::from_millis(input.timeout_ms))
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .header("authorization", format!("Bearer {}", self.api_key))
            .body(body.to_string())
            .send()
            .await
            .map_err(classify_reqwest_error)?;

        let status = res.status().as_u16();
        if status >= 400 {
            drop(res);
            if status >= 500 || status == 429 || status == 401 || status == 403 {
                return Err(SearchError::new(
                    SearchErrorCode::ServerNotAvailable,
                    format!("tavily is unavailable (HTTP {})", status),
                ));
            }
            return Err(SearchError::new(
                SearchErrorCode::InvalidParam,
                format!("tavily rejected the request with HTTP {}", status),
            ));
        }

        let bytes = res.bytes().await.map_err(classify_reqwest_error)?;
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
            SearchError::new(
                SearchErrorCode::IoError,
                format!("tavily: could not parse response as JSON: {}", e),
            )
        })?;

        Ok(WebSearchEngineResult {
            results: map_results(&parsed),
            backend_host: host,
            elapsed_ms: started.elapsed().as_millis() as u64,
            engine: Some(ENGINE_NAME.to_string()),
            engine_class: None,
            // Tavily honors time_range when one was requested.
            time_range_applied: if input.time_range == WebSearchTimeRange::All {
                None
            } else {
                Some(true)
            },
        })
    }
}

fn map_results(parsed: &serde_json::Value) -> Vec<WebSearchResultItem> {
    let raw = match parsed.get("results").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in raw {
        let title = entry.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let url = entry.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet = entry
            .get("content")
            .and_then(|v| v.as_str())
            .map(strip_tags)
            .unwrap_or_default();
        let score = entry.get("score").and_then(|v| v.as_f64());
        let age = entry
            .get("published_date")
            .and_then(|v| v.as_str())
            .and_then(|d| {
                let t = d.trim();
                if t.len() >= 10 {
                    Some(t[0..10].to_string())
                } else {
                    None
                }
            });
        out.push(WebSearchResultItem {
            title: title.to_string(),
            url: url.to_string(),
            snippet,
            age,
            score,
        });
    }
    out
}
