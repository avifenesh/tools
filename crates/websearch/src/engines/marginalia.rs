//! Marginalia public search API — keyless JSON. See TS `engines/marginalia.ts`.

use async_trait::async_trait;
use url::Url;

use super::html::strip_tags;
use super::http::http_get;
use crate::engine::{
    shared_client, SearchError, SearchErrorCode, WebSearchEngine, WebSearchEngineInput,
    WebSearchEngineResult,
};
use crate::types::{WebSearchResultItem, WebSearchTimeRange};

const DEFAULT_BASE: &str = "https://api.marginalia.nu";
const ENGINE_NAME: &str = "marginalia";

pub struct MarginaliaEngine {
    client: reqwest::Client,
    base_url: String,
}

impl MarginaliaEngine {
    pub fn new() -> Self {
        Self {
            client: shared_client(),
            base_url: DEFAULT_BASE.to_string(),
        }
    }
    pub fn with_base_url(mut self, base: impl Into<String>) -> Self {
        self.base_url = base.into();
        self
    }
}

impl Default for MarginaliaEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl WebSearchEngine for MarginaliaEngine {
    fn name(&self) -> &str {
        ENGINE_NAME
    }

    fn engine_class(&self) -> crate::engine::EngineClass {
        crate::engine::EngineClass::Niche
    }

    async fn search(
        &self,
        input: WebSearchEngineInput,
    ) -> Result<WebSearchEngineResult, SearchError> {
        let mut url = Url::parse(&self.base_url).map_err(|_| {
            SearchError::new(
                SearchErrorCode::IoError,
                format!("invalid marginalia base url: {}", self.base_url),
            )
        })?;
        {
            let base_path = url.path().trim_end_matches('/').to_string();
            url.set_path(&format!("{}/public/search/{}", base_path, input.query));
            url.query_pairs_mut()
                .append_pair("count", &input.count.to_string());
        }

        let res = http_get(
            &self.client,
            &url,
            &input,
            "application/json",
            ENGINE_NAME,
            &[],
        )
        .await?;

        let parsed: serde_json::Value = serde_json::from_str(&res.text).map_err(|e| {
            SearchError::new(
                SearchErrorCode::IoError,
                format!("marginalia: could not parse response as JSON: {}", e),
            )
        })?;

        Ok(WebSearchEngineResult {
            results: map_results(&parsed),
            backend_host: res.host,
            elapsed_ms: res.elapsed_ms,
            engine: Some(ENGINE_NAME.to_string()),
            engine_class: None,
            engines: None,
            // Marginalia's public API has no recency filter.
            time_range_applied: if input.time_range == WebSearchTimeRange::All {
                None
            } else {
                Some(false)
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
            .get("description")
            .and_then(|v| v.as_str())
            .map(strip_tags)
            .unwrap_or_default();
        // `quality` is Marginalia's relevance/quality score; surface it.
        let score = entry.get("quality").and_then(|v| v.as_f64());
        out.push(WebSearchResultItem {
            title: title.to_string(),
            url: url.to_string(),
            snippet,
            age: None,
            score,
            source: None,
        });
    }
    out
}
