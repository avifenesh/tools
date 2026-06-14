//! Mojeek search — keyless HTML SERP parse. See TS `engines/mojeek.ts`.
//! ToS note: Mojeek's robots.txt disallows /search and they sell an official
//! API; this is a scrape (gray area), so it is opt-out via the resolver.

use async_trait::async_trait;
use url::Url;

use super::html::strip_tags;
use super::http::http_get;
use crate::engine::{
    shared_client, SearchError, SearchErrorCode, WebSearchEngine, WebSearchEngineInput,
    WebSearchEngineResult,
};
use crate::types::{WebSearchResultItem, WebSearchTimeRange};

const DEFAULT_BASE: &str = "https://www.mojeek.com";
const ENGINE_NAME: &str = "mojeek";

pub struct MojeekEngine {
    client: reqwest::Client,
    base_url: String,
}

impl MojeekEngine {
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

impl Default for MojeekEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl WebSearchEngine for MojeekEngine {
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
                format!("invalid mojeek base url: {}", self.base_url),
            )
        })?;
        {
            let base_path = url.path().trim_end_matches('/').to_string();
            url.set_path(&format!("{}/search", base_path));
            url.query_pairs_mut().append_pair("q", &input.query);
        }

        let res = http_get(
            &self.client,
            &url,
            &input,
            "text/html,application/xhtml+xml",
            ENGINE_NAME,
            &[],
        )
        .await?;

        let mut results = parse_mojeek(&res.text);
        results.truncate(input.count);

        // A real Mojeek SERP (even with zero hits) carries the result
        // scaffold; an anti-bot interstitial does not. Only the latter should
        // fail the engine so the fallback chain moves on.
        if results.is_empty() && looks_challenged(&res.text) {
            return Err(SearchError::new(
                SearchErrorCode::ServerNotAvailable,
                "mojeek returned no parseable results (likely an anti-bot challenge or interstitial from this IP)",
            ));
        }

        Ok(WebSearchEngineResult {
            results,
            backend_host: res.host,
            elapsed_ms: res.elapsed_ms,
            engine: Some(ENGINE_NAME.to_string()),
            engine_class: None,
            engines: None,
            // Mojeek's SERP scrape has no recency filter.
            time_range_applied: if input.time_range == WebSearchTimeRange::All {
                None
            } else {
                Some(false)
            },
        })
    }
}

/// Parse Mojeek's result blocks (delimited by `<!--rs-->` ... `<!--re-->`,
/// each with `<a class="title" href=...>` and `<p class="s">`). Public to the
/// crate for unit testing against a saved fixture.
pub(crate) fn parse_mojeek(html: &str) -> Vec<WebSearchResultItem> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find("<!--rs-->") {
        let after = &rest[start + "<!--rs-->".len()..];
        let end = match after.find("<!--re-->") {
            Some(e) => e,
            None => break,
        };
        let block = &after[..end];
        rest = &after[end + "<!--re-->".len()..];

        let (url, title) = match extract_title_anchor(block) {
            Some(t) => t,
            None => continue,
        };
        if url.is_empty() || title.is_empty() {
            continue;
        }
        let snippet = extract_snippet(block).unwrap_or_default();
        out.push(WebSearchResultItem {
            title,
            url,
            snippet,
            age: None,
            score: None,
            source: None,
        });
    }
    out
}

/// Find `<a ... class="title" ... href="URL" ...>TITLE</a>` and return
/// (decoded url, stripped title).
fn extract_title_anchor(block: &str) -> Option<(String, String)> {
    // Locate an <a ...> tag whose attributes include class="title".
    let mut search_from = 0;
    while let Some(rel) = block[search_from..].find("<a ") {
        let tag_start = search_from + rel;
        let tag_end = block[tag_start..].find('>')? + tag_start;
        let tag = &block[tag_start..=tag_end];
        if tag.contains("class=\"title\"") {
            let href = attr_value(tag, "href")?;
            // Title text is between this tag's '>' and the next "</a>".
            let after = &block[tag_end + 1..];
            let close = after.find("</a>")?;
            let title = strip_tags(&after[..close]);
            return Some((decode_href(&href), title));
        }
        search_from = tag_end + 1;
    }
    None
}

fn extract_snippet(block: &str) -> Option<String> {
    let marker = "<p class=\"s\">";
    let start = block.find(marker)? + marker.len();
    let after = &block[start..];
    let end = after.find("</p>")?;
    Some(strip_tags(&after[..end]))
}

/// Extract the value of `attr="..."` from a tag string.
fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{}=\"", attr);
    let start = tag.find(&needle)? + needle.len();
    let after = &tag[start..];
    let end = after.find('"')?;
    Some(after[..end].to_string())
}

fn decode_href(href: &str) -> String {
    href.replace("&amp;", "&")
}

fn looks_challenged(html: &str) -> bool {
    let has_scaffold = html.contains("results-standard")
        || html.contains("serp-results")
        || html.contains("results-count")
        || html.to_lowercase().contains("no pages found");
    !has_scaffold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_blocks_with_title_url_snippet() {
        let html = r#"<ul class="results-standard">
<!--rs--><li class="r1"><a title="x" href="https://ex.com/a" class="ob"></a><h2><a class="title" href="https://ex.com/a">A Title</a></h2><p class="s">snippet <strong>a</strong></p></li><!--re-->
<!--rs--><li class="r2"><a class="title" href="https://ex.com/b">B Title</a><p class="s">snippet b</p></li><!--re-->
</ul>"#;
        let r = parse_mojeek(html);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].url, "https://ex.com/a");
        assert_eq!(r[0].title, "A Title");
        assert_eq!(r[0].snippet, "snippet a");
        assert_eq!(r[1].url, "https://ex.com/b");
    }

    #[test]
    fn empty_html_yields_no_results() {
        assert!(parse_mojeek("<html><body>nope</body></html>").is_empty());
    }

    #[test]
    fn decodes_ampersand_in_href() {
        let html = r#"<!--rs--><a class="title" href="https://ex.com/?a=1&amp;b=2">T</a><p class="s">s</p><!--re-->"#;
        let r = parse_mojeek(html);
        assert_eq!(r[0].url, "https://ex.com/?a=1&b=2");
    }
}
