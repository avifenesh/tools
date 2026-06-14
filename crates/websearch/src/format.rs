use crate::constants::SNIPPET_CAP;
use crate::types::{SearchMetadata, WebSearchResultItem};

/// Render the <search>...</search> block that opens the ok results. Uniform
/// shape so the model parses the same surface.
pub fn render_search_block(meta: &SearchMetadata) -> String {
    let engine_line = match &meta.engine {
        Some(e) if !e.is_empty() => format!("\n  <engine>{}</engine>", e),
        _ => String::new(),
    };
    format!(
        "<search>\n  <query>{}</query>\n  <backend>{}</backend>{}\n  <count>{}</count>\n  <time_range>{}</time_range>\n</search>",
        meta.query,
        meta.backend_host,
        engine_line,
        meta.count,
        meta.time_range.as_str(),
    )
}

pub struct FormatOkArgs<'a> {
    pub meta: &'a SearchMetadata,
    pub results: &'a [WebSearchResultItem],
    pub requested: usize,
}

pub fn format_ok_text(args: FormatOkArgs<'_>) -> String {
    let header = render_search_block(args.meta);
    let numbered = args
        .results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let snippet = trim_snippet(&r.snippet);
            let snippet_line = if snippet.is_empty() {
                String::new()
            } else {
                format!("\n   {}", snippet)
            };
            format!("{}. {}\n   {}{}", i + 1, r.title, r.url, snippet_line)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let results_block = format!("<results>\n{}\n</results>", numbered);
    let n = args.results.len();
    let via = match &args.meta.engine {
        Some(e) if !e.is_empty() => format!("{} ({})", e, args.meta.backend_host),
        _ => args.meta.backend_host.clone(),
    };
    let hint = if n < args.requested {
        format!(
            "(Only {} results — fewer than the {} requested. Try broader terms or a wider time_range.)",
            n, args.requested
        )
    } else {
        format!(
            "(Found {} results for \"{}\" via {} in {}ms. Fetch a URL with webfetch to read it.)",
            n, args.meta.query, via, args.meta.elapsed_ms
        )
    };
    format!("{}\n{}\n{}", header, results_block, hint)
}

pub fn format_empty_text(meta: &SearchMetadata) -> String {
    let header = format!(
        "<search><query>{}</query><backend>{}</backend><count>0</count></search>",
        meta.query, meta.backend_host
    );
    let hint = format!(
        "(No results for \"{}\". Try different/broader keywords, a wider time_range, or check that the search backend has engines enabled.)",
        meta.query
    );
    format!("{}\n{}", header, hint)
}

fn trim_snippet(snippet: &str) -> String {
    let collapsed = collapse_whitespace(snippet);
    if collapsed.chars().count() <= SNIPPET_CAP {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(SNIPPET_CAP).collect();
    format!("{}…", truncated)
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}
