use std::path::Path;
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::constants::{max_line_suffix, MAX_BYTES, MAX_LINE_LENGTH};

#[derive(Debug, Clone)]
pub struct StreamLinesOptions {
    pub offset: usize,
    pub limit: usize,
    pub max_bytes: Option<usize>,
    pub max_line_length: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct StreamLinesResult {
    pub lines: Vec<String>,
    pub total_lines: usize,
    pub offset: usize,
    pub more: bool,
    pub byte_cap: bool,
}

pub async fn stream_lines(path: &Path, opts: StreamLinesOptions) -> std::io::Result<StreamLinesResult> {
    let max_bytes = opts.max_bytes.unwrap_or(MAX_BYTES);
    let max_line_len = opts.max_line_length.unwrap_or(MAX_LINE_LENGTH);
    let start = opts.offset.saturating_sub(1);

    let f = File::open(path).await?;
    let mut reader = BufReader::new(f);
    let mut buf = String::new();
    let mut out: Vec<String> = Vec::new();
    let mut bytes = 0usize;
    let mut total_lines = 0usize;
    let mut more = false;
    let mut byte_cap = false;
    let suffix = max_line_suffix();

    loop {
        buf.clear();
        let n = reader.read_line(&mut buf).await?;
        if n == 0 {
            break;
        }
        total_lines += 1;
        // Strip the trailing newline (but preserve content on missing newline).
        if buf.ends_with('\n') {
            buf.pop();
            if buf.ends_with('\r') {
                buf.pop();
            }
        }
        if total_lines <= start {
            continue;
        }
        if out.len() >= opts.limit {
            more = true;
            continue;
        }

        let truncated = if buf.len() > max_line_len {
            let mut t = String::with_capacity(max_line_len + suffix.len());
            t.push_str(safe_slice(&buf, max_line_len));
            t.push_str(&suffix);
            t
        } else {
            buf.clone()
        };

        let this_bytes = truncated.as_bytes().len() + if !out.is_empty() { 1 } else { 0 };
        if bytes + this_bytes > max_bytes {
            byte_cap = true;
            more = true;
            break;
        }
        out.push(truncated);
        bytes += this_bytes;
    }

    Ok(StreamLinesResult {
        lines: out,
        total_lines,
        offset: opts.offset,
        more,
        byte_cap,
    })
}

/// Take the first `max` chars (UTF-8 code points) without breaking a
/// multi-byte sequence. Falls back to byte slice when all ASCII.
fn safe_slice(s: &str, max: usize) -> &str {
    if s.is_ascii() {
        return &s[..max.min(s.len())];
    }
    let mut end = 0usize;
    for (i, _) in s.char_indices().take(max) {
        end = i;
    }
    // Include the last character fully.
    let last = s[end..].chars().next().map(|c| c.len_utf8()).unwrap_or(0);
    &s[..end + last]
}
