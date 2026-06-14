use crate::constants::SNIPPET_CAP;
use crate::types::{SearchMetadata, WebSearchResultItem, WebSearchTimeRange};

// Output format (v0.5) — compact ranked plain text, the shape LLM-facing
// search APIs (Tavily/Brave/Anthropic/Exa) converge on. One short header
// line + 3-line entries; per-result `age` only when the backend provides it;
// honest time-range note when the serving engine ignored the filter; an
// engine-class label so the model can judge source breadth. Mirrors the TS
// `format.ts`.

/// The single compact header line, shared by ok/empty. Example:
///   WEB "rust async" · mojeek (general web) · 5 results
fn header_line(meta: &SearchMetadata, n: usize) -> String {
    let mut parts: Vec<String> = vec![format!("WEB \"{}\"", meta.query)];
    let via = match &meta.engine {
        Some(e) if !e.is_empty() => {
            let label = meta
                .engine_class
                .map(|c| c.label())
                .unwrap_or("web");
            format!("{} ({})", e, label)
        }
        _ => meta.backend_host.clone(),
    };
    parts.push(via);
    parts.push(format!("{} result{}", n, if n == 1 { "" } else { "s" }));
    // Honest recency: only mention time filtering when one was requested.
    if meta.time_range != WebSearchTimeRange::All {
        match meta.time_range_applied {
            Some(true) => parts.push(format!("time:{}", meta.time_range.as_str())),
            Some(false) => parts.push(format!(
                "time:{} NOT applied (this engine ignores it; results are all-time)",
                meta.time_range.as_str()
            )),
            None => {}
        }
    }
    parts.join(" · ")
}

pub struct FormatOkArgs<'a> {
    pub meta: &'a SearchMetadata,
    pub results: &'a [WebSearchResultItem],
    pub requested: usize,
    pub snippet_cap: usize,
}

pub fn format_ok_text(args: FormatOkArgs<'_>) -> String {
    let header = header_line(args.meta, args.results.len());
    let numbered = args
        .results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let age_part = match &r.age {
                Some(a) if !a.is_empty() => format!(" · {}", a),
                _ => String::new(),
            };
            let snippet = trim_snippet(&r.snippet, args.snippet_cap);
            let snippet_line = if snippet.is_empty() {
                String::new()
            } else {
                format!("\n   {}", snippet)
            };
            format!("{}. {}\n   {}{}{}", i + 1, r.title, r.url, age_part, snippet_line)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let n = args.results.len();
    let hint = if n < args.requested {
        format!(
            "(Only {} of {} requested. Broaden the query or widen time_range; or fetch a URL with webfetch to read it.)",
            n, args.requested
        )
    } else {
        "(Fetch a URL with webfetch to read the page.)".to_string()
    };
    format!("{}\n{}\n{}", header, numbered, hint)
}

pub fn format_empty_text(meta: &SearchMetadata) -> String {
    let header = header_line(meta, 0);
    let widen = if meta.time_range != WebSearchTimeRange::All {
        ", a wider time_range,"
    } else {
        ""
    };
    let hint = format!(
        "(No results. Try different/broader keywords{} or fetch a known URL with webfetch.)",
        widen
    );
    format!("{}\n{}", header, hint)
}

/// Back-compat: the old `<search>…</search>` block renderer now returns the
/// compact header line (kept as a public export).
pub fn render_search_block(meta: &SearchMetadata) -> String {
    header_line(meta, meta.count)
}

fn trim_snippet(snippet: &str, cap: usize) -> String {
    let collapsed = collapse_whitespace(snippet);
    if collapsed.chars().count() <= cap {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(cap).collect();
    format!("{}…", truncated)
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Clamp a session-provided snippet cap to the sane [MIN, MAX] window.
pub fn clamp_snippet_cap(n: Option<usize>) -> usize {
    use crate::constants::{MAX_SNIPPET_CAP, MIN_SNIPPET_CAP};
    match n {
        None => SNIPPET_CAP,
        Some(v) if v < MIN_SNIPPET_CAP => MIN_SNIPPET_CAP,
        Some(v) if v > MAX_SNIPPET_CAP => MAX_SNIPPET_CAP,
        Some(v) => v,
    }
}
