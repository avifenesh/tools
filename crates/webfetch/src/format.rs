use std::fs;
use std::path::{Path, PathBuf};
use url::Url;

use crate::types::FetchMetadata;

pub fn render_request_block(meta: &FetchMetadata) -> String {
    let chain = meta.redirect_chain.join(" -> ");
    format!(
        "<request>\n  <url>{}</url>\n  <final_url>{}</final_url>\n  <method>{}</method>\n  <status>{}</status>\n  <content_type>{}</content_type>\n  <redirect_chain>{}</redirect_chain>\n</request>",
        meta.url,
        meta.final_url,
        meta.method.as_str(),
        meta.status,
        meta.content_type,
        chain,
    )
}

pub struct FormatOkArgs<'a> {
    pub meta: &'a FetchMetadata,
    pub extract_hint: &'a str,
    pub markdown: Option<&'a str>,
    pub raw: Option<&'a str>,
    pub log_path: Option<&'a str>,
    pub byte_cap: bool,
    pub total_bytes: usize,
}

pub fn format_ok_text(args: FormatOkArgs<'_>) -> String {
    let header = render_request_block(args.meta);
    let body_inner = match args.extract_hint {
        "markdown" => args.markdown.unwrap_or("").to_string(),
        "raw" => args.raw.unwrap_or("").to_string(),
        "both" => format!(
            "<markdown>\n{}\n</markdown>\n<raw_body>\n{}\n</raw_body>",
            args.markdown.unwrap_or(""),
            args.raw.unwrap_or(""),
        ),
        _ => String::new(),
    };
    let body_block = format!("<body extract=\"{}\">\n{}\n</body>", args.extract_hint, body_inner);

    let hint = if args.byte_cap && args.log_path.is_some() {
        format!(
            "(Response exceeded inline cap; showing head+tail of {} bytes. Full response at {} — Read with offset/limit to paginate.)",
            args.total_bytes,
            args.log_path.unwrap(),
        )
    } else {
        let original_host = host_of(&args.meta.url);
        let final_host = host_of(&args.meta.final_url);
        let warn = if args.meta.url != args.meta.final_url && original_host != final_host {
            format!(
                " (Final URL host differs from original: {} -> {}. Verify this is expected.)",
                original_host, final_host
            )
        } else {
            String::new()
        };
        let cache_tag = if args.meta.from_cache {
            let age = args.meta.cache_age_sec.unwrap_or(0);
            format!(" (Served from session cache; age {}s.)", age)
        } else {
            String::new()
        };
        let ct = if args.meta.content_type.is_empty() {
            "unknown".to_string()
        } else {
            args.meta.content_type.clone()
        };
        format!(
            "(Response complete. {} bytes total. Content-type: {}. Fetched in {}ms.{}{})",
            args.total_bytes, ct, args.meta.fetched_ms, warn, cache_tag
        )
    };

    format!("{}\n{}\n{}", header, body_block, hint)
}

pub struct FormatRedirectLoopArgs<'a> {
    pub meta: &'a FetchMetadata,
    pub max_redirects: u32,
}

pub fn format_redirect_loop_text(args: FormatRedirectLoopArgs<'_>) -> String {
    let header = render_request_block(args.meta);
    let chain = args.meta.redirect_chain.join(" -> ");
    let hint = format!(
        "(Redirect limit ({}) exceeded. Chain: {}. Set max_redirects higher OR pass the final URL directly.)",
        args.max_redirects, chain
    );
    format!("{}\n{}", header, hint)
}

pub struct FormatHttpErrorArgs<'a> {
    pub meta: &'a FetchMetadata,
    pub body: &'a str,
}

pub fn format_http_error_text(args: FormatHttpErrorArgs<'_>) -> String {
    let header = render_request_block(args.meta);
    let body_block = format!("<body>\n{}\n</body>", args.body);
    let hint = format!(
        "(HTTP {}. {}. Retry or adjust the request per the body.)",
        args.meta.status,
        short_reason(args.meta.status),
    );
    format!("{}\n{}\n{}", header, body_block, hint)
}

fn short_reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized — check auth headers",
        403 => "Forbidden — check permissions or auth",
        404 => "Not Found",
        408 => "Request Timeout",
        410 => "Gone",
        418 => "I'm a teapot",
        429 => "Too Many Requests — back off",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        s if (400..500).contains(&s) => "Client error",
        s if s >= 500 => "Server error",
        _ => "Non-success status",
    }
}

pub fn host_of(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

// ---- spill-to-file ----

pub struct SpillArgs<'a> {
    pub bytes: &'a [u8],
    pub dir: &'a Path,
    pub session_id: &'a str,
    pub content_type: &'a str,
}

pub fn spill_to_file(args: SpillArgs<'_>) -> std::io::Result<PathBuf> {
    let dir = args.dir.join(args.session_id);
    fs::create_dir_all(&dir)?;
    let ext = extension_for(args.content_type);
    let filename = format!("{}.{}", uuid::Uuid::new_v4(), ext);
    let path = dir.join(filename);
    fs::write(&path, args.bytes)?;
    Ok(path)
}

fn extension_for(content_type: &str) -> &'static str {
    let lower = content_type.to_ascii_lowercase();
    if lower.contains("text/html") || lower.contains("xhtml") {
        "html"
    } else if lower.contains("json") {
        "json"
    } else if lower.contains("xml") {
        "xml"
    } else if lower.contains("csv") {
        "csv"
    } else if lower.contains("markdown") {
        "md"
    } else if lower.contains("text/") {
        "txt"
    } else {
        "bin"
    }
}

/// Return head (first N bytes) + tail (last N bytes) concatenated with
/// an elision marker. Mirrors the bash head+tail spill pattern.
pub fn head_and_tail(
    bytes: &[u8],
    head_bytes: usize,
    tail_bytes: usize,
    log_path: &str,
) -> String {
    if bytes.len() <= head_bytes + tail_bytes {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let head = String::from_utf8_lossy(&bytes[..head_bytes]).into_owned();
    let tail = String::from_utf8_lossy(&bytes[bytes.len() - tail_bytes..]).into_owned();
    let elided = bytes.len() - head_bytes - tail_bytes;
    format!(
        "{}\n\n... ({} bytes elided; full response at {}) ...\n\n{}",
        head, elided, log_path, tail
    )
}
