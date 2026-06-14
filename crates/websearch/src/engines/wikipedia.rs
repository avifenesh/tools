//! Wikipedia / MediaWiki search API — keyless JSON. See TS `engines/wikipedia.ts`.

use async_trait::async_trait;
use url::Url;

use super::html::strip_tags;
use super::http::http_get;
use crate::engine::{
    shared_client, SearchError, SearchErrorCode, WebSearchEngine, WebSearchEngineInput,
    WebSearchEngineResult,
};
use crate::types::{WebSearchResultItem, WebSearchTimeRange};

const ENGINE_NAME: &str = "wikipedia";

pub struct WikipediaEngine {
    client: reqwest::Client,
    /// Override the API origin for tests; production derives it from language.
    base_url: Option<String>,
}

impl WikipediaEngine {
    pub fn new() -> Self {
        Self {
            client: shared_client(),
            base_url: None,
        }
    }
    pub fn with_base_url(mut self, base: impl Into<String>) -> Self {
        self.base_url = Some(base.into());
        self
    }
}

impl Default for WikipediaEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl WebSearchEngine for WikipediaEngine {
    fn name(&self) -> &str {
        ENGINE_NAME
    }

    fn engine_class(&self) -> crate::engine::EngineClass {
        crate::engine::EngineClass::Vertical
    }

    async fn search(
        &self,
        input: WebSearchEngineInput,
    ) -> Result<WebSearchEngineResult, SearchError> {
        let lang = normalize_lang(&input.language);
        let origin = self
            .base_url
            .clone()
            .unwrap_or_else(|| format!("https://{}.wikipedia.org", lang));
        let mut url = Url::parse(&origin).map_err(|_| {
            SearchError::new(
                SearchErrorCode::IoError,
                format!("invalid wikipedia origin: {}", origin),
            )
        })?;
        {
            let base_path = url.path().trim_end_matches('/').to_string();
            url.set_path(&format!("{}/w/api.php", base_path));
            url.query_pairs_mut()
                .append_pair("action", "query")
                .append_pair("list", "search")
                .append_pair("srsearch", &input.query)
                .append_pair("srlimit", &input.count.to_string())
                .append_pair("format", "json");
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
                format!("wikipedia: could not parse response as JSON: {}", e),
            )
        })?;

        Ok(WebSearchEngineResult {
            results: map_results(&parsed, &origin),
            backend_host: res.host,
            elapsed_ms: res.elapsed_ms,
            engine: Some(ENGINE_NAME.to_string()),
            engine_class: None,
            engines: None,
            // Wikipedia search ignores recency filtering.
            time_range_applied: if input.time_range == WebSearchTimeRange::All {
                None
            } else {
                Some(false)
            },
        })
    }
}

fn map_results(parsed: &serde_json::Value, origin: &str) -> Vec<WebSearchResultItem> {
    let raw = match parsed
        .get("query")
        .and_then(|q| q.get("search"))
        .and_then(|v| v.as_array())
    {
        Some(arr) => arr,
        None => return Vec::new(),
    };
    let origin_trimmed = origin.trim_end_matches('/');
    let mut out = Vec::new();
    for entry in raw {
        let title = entry.get("title").and_then(|v| v.as_str()).unwrap_or("");
        if title.is_empty() {
            continue;
        }
        let url = match entry.get("pageid").and_then(|v| v.as_u64()) {
            Some(pageid) => format!("{}/?curid={}", origin_trimmed, pageid),
            None => format!("{}/wiki/{}", origin_trimmed, title.replace(' ', "_")),
        };
        let snippet = entry
            .get("snippet")
            .and_then(|v| v.as_str())
            .map(strip_tags)
            .unwrap_or_default();
        // `timestamp` is the article's last-edit time; surface the date
        // portion as `age` (NB: last-edit, not first-publication).
        let age = entry
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(iso_date);
        out.push(WebSearchResultItem {
            title: title.to_string(),
            url,
            snippet,
            age,
            score: None,
            source: None,
        });
    }
    out
}

fn normalize_lang(language: &str) -> String {
    if language.is_empty() || language == "auto" {
        return "en".to_string();
    }
    let primary = language
        .split(['-', '_'])
        .next()
        .unwrap_or("en")
        .to_ascii_lowercase();
    let ok = (2..=3).contains(&primary.len()) && primary.chars().all(|c| c.is_ascii_lowercase());
    if ok {
        primary
    } else {
        "en".to_string()
    }
}

/// Extract the YYYY-MM-DD date portion from an ISO timestamp; None if it
/// doesn't start with a date.
fn iso_date(ts: &str) -> Option<String> {
    let t = ts.trim();
    let bytes = t.as_bytes();
    if bytes.len() >= 10
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        Some(t[0..10].to_string())
    } else {
        None
    }
}
