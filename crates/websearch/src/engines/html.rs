//! Minimal, dependency-free HTML text utilities for the scrape-based engine
//! (Mojeek) and tagged-snippet APIs (Wikipedia). Mirrors TS `engines/html.ts`:
//! decode the entities that occur in SERP markup, strip tags, collapse
//! whitespace. No scraper/html5ever dependency — the parse target is a small,
//! known result-list structure, not arbitrary article bodies.

/// Decode the HTML entities that actually occur in SERP markup.
pub(crate) fn decode_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(semi) = input[i + 1..].find(';') {
                let body = &input[i + 1..i + 1 + semi];
                if let Some(decoded) = decode_one(body) {
                    out.push_str(&decoded);
                    i += semi + 2; // skip '&' .. ';'
                    continue;
                }
            }
        }
        // Push this UTF-8 char whole.
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn decode_one(body: &str) -> Option<String> {
    if let Some(rest) = body.strip_prefix('#') {
        let code = if let Some(hex) = rest.strip_prefix('x').or_else(|| rest.strip_prefix('X')) {
            u32::from_str_radix(hex, 16).ok()?
        } else {
            rest.parse::<u32>().ok()?
        };
        return char::from_u32(code).map(|c| c.to_string());
    }
    let s = match body.to_ascii_lowercase().as_str() {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "rsaquo" => "\u{203a}",
        "lsaquo" => "\u{2039}",
        "raquo" => "\u{00bb}",
        "laquo" => "\u{00ab}",
        "hellip" => "\u{2026}",
        "mdash" => "\u{2014}",
        "ndash" => "\u{2013}",
        "rsquo" => "\u{2019}",
        "lsquo" => "\u{2018}",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        "middot" => "\u{00b7}",
        "deg" => "\u{00b0}",
        "copy" => "\u{00a9}",
        "reg" => "\u{00ae}",
        "trade" => "\u{2122}",
        "eacute" => "\u{00e9}",
        "egrave" => "\u{00e8}",
        "agrave" => "\u{00e0}",
        "ccedil" => "\u{00e7}",
        "uuml" => "\u{00fc}",
        "ouml" => "\u{00f6}",
        "auml" => "\u{00e4}",
        _ => return None,
    };
    Some(s.to_string())
}

/// Strip HTML tags, decode entities, and collapse whitespace.
pub(crate) fn strip_tags(html: &str) -> String {
    let mut no_tags = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                no_tags.push(' ');
            }
            _ if !in_tag => no_tags.push(ch),
            _ => {}
        }
    }
    let decoded = decode_entities(&no_tags);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}
