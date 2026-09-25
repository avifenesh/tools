//! Parallel: its own web index built for agents, reached through Parallel's
//! hosted Search MCP server (`web_search`). Keyless by default ("free for
//! exploration and light use"); a Parallel API key sent as a bearer token
//! raises the limit. See TS `engines/parallel.ts`.
//!
//! The tool takes an `objective` plus `search_queries` and returns
//! `structuredContent: { results: [{ url, title, publish_date, excerpts[] }] }`
//! (the same JSON is also in the text content). It has no result-count input
//! and returns ~10 results, so the engine truncates to `count`.

use async_trait::async_trait;
use url::Url;

use super::mcp::{content_text, iso_date, mcp_tool_call};
use super::passage::select_passage;
use crate::engine::{
    shared_client, SearchError, SearchErrorCode, WebSearchEngine, WebSearchEngineInput,
    WebSearchEngineResult,
};
use crate::types::{WebSearchResultItem, WebSearchTimeRange};

const DEFAULT_BASE: &str = "https://search.parallel.ai";
const ENGINE_NAME: &str = "parallel";
const TOOL: &str = "web_search";

pub struct ParallelEngine {
    client: reqwest::Client,
    api_key: Option<String>,
    base_url: String,
}

impl ParallelEngine {
    pub fn new() -> Self {
        Self {
            client: shared_client(),
            api_key: None,
            base_url: DEFAULT_BASE.to_string(),
        }
    }
    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        let k = key.into();
        self.api_key = if k.is_empty() { None } else { Some(k) };
        self
    }
    pub fn with_base_url(mut self, base: impl Into<String>) -> Self {
        self.base_url = base.into();
        self
    }
}

impl Default for ParallelEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl WebSearchEngine for ParallelEngine {
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
                format!("invalid parallel base url: {}", self.base_url),
            )
        })?;
        {
            let base_path = url.path().trim_end_matches('/').to_string();
            url.set_path(&format!("{}/mcp", base_path));
        }
        let mut headers: Vec<(&str, String)> = Vec::new();
        if let Some(k) = &self.api_key {
            headers.push(("authorization", format!("Bearer {}", k)));
        }
        let res = mcp_tool_call(
            &self.client,
            &url,
            &input,
            ENGINE_NAME,
            TOOL,
            serde_json::json!({
                "objective": input.query,
                "search_queries": [input.query],
            }),
            &headers,
        )
        .await?;

        // Prefer structuredContent; fall back to the JSON text content.
        let payload = match res.result.get("structuredContent") {
            Some(v) if v.is_object() => v.clone(),
            _ => serde_json::from_str(&content_text(&res.result)).map_err(|e| {
                SearchError::new(
                    SearchErrorCode::IoError,
                    format!("parallel: could not parse the search result JSON: {}", e),
                )
            })?,
        };
        let mut results = map_results(&payload, &input.query);
        results.truncate(input.count);

        Ok(WebSearchEngineResult {
            results,
            backend_host: res.host,
            elapsed_ms: res.elapsed_ms,
            engine: Some(ENGINE_NAME.to_string()),
            engine_class: None,
            engines: None,
            // The MCP tool takes no freshness filter.
            time_range_applied: if input.time_range == WebSearchTimeRange::All {
                None
            } else {
                Some(false)
            },
        })
    }
}

pub(crate) fn map_results(payload: &serde_json::Value, query: &str) -> Vec<WebSearchResultItem> {
    let raw = match payload.get("results").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in raw {
        let title = entry
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let url = entry
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let excerpts: Vec<&str> = entry
            .get("excerpts")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
            .unwrap_or_default();
        let snippet = select_passage(&excerpts.join("\n"), query, title);
        let age = entry
            .get("publish_date")
            .and_then(|v| v.as_str())
            .and_then(iso_date);
        out.push(WebSearchResultItem {
            title: title.to_string(),
            url: url.to_string(),
            snippet,
            age,
            score: None,
            source: None,
        });
    }
    out
}
