//! Exa: its own neural web index, reached through Exa's hosted MCP server
//! (`web_search_exa`). Keyless by default (rate-limited free tier); an Exa API
//! key sent as `x-api-key` raises the limit. See TS `engines/exa.ts`.
//!
//! The tool answers with one text block of records:
//!
//! ```text
//! Title: ...
//! URL: ...
//! Published: 2026-07-22T16:46:14.000Z | N/A
//! Author: ...
//! Highlights:
//! <query-relevant passages separated by "...">
//! ```
//!
//! with records separated by a `---` line.

use async_trait::async_trait;
use url::Url;

use super::mcp::{content_text, iso_date, mcp_tool_call};
use super::passage::select_passage;
use crate::engine::{
    shared_client, SearchError, SearchErrorCode, WebSearchEngine, WebSearchEngineInput,
    WebSearchEngineResult,
};
use crate::types::{WebSearchResultItem, WebSearchTimeRange};

const DEFAULT_BASE: &str = "https://mcp.exa.ai";
const ENGINE_NAME: &str = "exa";
const TOOL: &str = "web_search_exa";

pub struct ExaEngine {
    client: reqwest::Client,
    api_key: Option<String>,
    base_url: String,
}

impl ExaEngine {
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

impl Default for ExaEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl WebSearchEngine for ExaEngine {
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
                format!("invalid exa base url: {}", self.base_url),
            )
        })?;
        {
            let base_path = url.path().trim_end_matches('/').to_string();
            url.set_path(&format!("{}/mcp", base_path));
        }
        let mut headers: Vec<(&str, String)> = Vec::new();
        if let Some(k) = &self.api_key {
            headers.push(("x-api-key", k.clone()));
        }
        let res = mcp_tool_call(
            &self.client,
            &url,
            &input,
            ENGINE_NAME,
            TOOL,
            serde_json::json!({ "query": input.query, "numResults": input.count }),
            &headers,
        )
        .await?;

        let text = content_text(&res.result);
        let mut results = parse_exa_text(&text, &input.query);
        if results.is_empty() && text.contains("Title:") {
            return Err(SearchError::new(
                SearchErrorCode::IoError,
                "exa: the response had records but none could be parsed (format changed?)",
            ));
        }
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

/// Parse Exa's text records. A record starts at a `Title: ` line; header
/// fields run until `Highlights:` (or `Text:` / `Summary:`), and everything
/// after that is the excerpt the snippet is selected from.
pub(crate) fn parse_exa_text(text: &str, query: &str) -> Vec<WebSearchResultItem> {
    let mut out = Vec::new();
    let mut records: Vec<Vec<&str>> = Vec::new();
    for line in text.lines() {
        if line.starts_with("Title: ") {
            records.push(Vec::new());
        }
        if let Some(r) = records.last_mut() {
            r.push(line);
        }
    }
    for rec in records {
        let mut title = "";
        let mut url = "";
        let mut published = "";
        let mut body: Vec<&str> = Vec::new();
        let mut in_body = false;
        for line in rec {
            if in_body {
                if line.trim() == "---" {
                    break;
                }
                body.push(line);
                continue;
            }
            if let Some(v) = line.strip_prefix("Title: ") {
                title = v.trim();
            } else if let Some(v) = line.strip_prefix("URL: ") {
                url = v.trim();
            } else if let Some(v) = line.strip_prefix("Published: ") {
                published = v.trim();
            } else if matches!(line.trim(), "Highlights:" | "Text:" | "Summary:") {
                in_body = true;
            }
        }
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet = select_passage(&body.join("\n"), query, title);
        out.push(WebSearchResultItem {
            title: title.to_string(),
            url: url.to_string(),
            snippet,
            age: iso_date(published),
            score: None,
            source: None,
        });
    }
    out
}
