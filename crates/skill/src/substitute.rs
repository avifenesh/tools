use std::collections::HashMap;

use crate::types::SkillArguments;

/// Placeholder substitution for skill bodies. Mirrors the TS implementation
/// at `packages/skill/src/substitute.ts`:
/// - `$ARGUMENTS` → the full string (string-form) or sorted `key=value`
///   pairs (object-form).
/// - `$1`, `$2`, ... → positional tokens (whitespace-split, string-form only).
/// - `$ARGUMENTS[N]` → same as `$N` but 0-indexed.
/// - `${name}` → object-form map lookup.
///
/// Unsubstituted placeholders remain literal.
pub fn substitute_arguments(body: &str, args: Option<&SkillArguments>) -> String {
    match args {
        None => body.to_string(),
        Some(SkillArguments::String(s)) => substitute_string(body, s),
        Some(SkillArguments::Object(map)) => substitute_object(body, map),
    }
}

fn substitute_string(body: &str, s: &str) -> String {
    let tokens: Vec<&str> = if s.trim().is_empty() {
        Vec::new()
    } else {
        s.trim().split_whitespace().collect()
    };

    // Process left-to-right, regex-free, to keep the dep surface tiny.
    let mut out = String::with_capacity(body.len());
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'$' {
            // Preserve UTF-8 boundaries: copy the current char.
            let c = next_char(body, i);
            out.push_str(&body[i..i + c.len]);
            i += c.len;
            continue;
        }
        // Look for known patterns after `$`.
        let rest = &body[i..];
        if let Some(stripped) = rest.strip_prefix("$ARGUMENTS[") {
            if let Some(close) = stripped.find(']') {
                let idx_str = &stripped[..close];
                if let Ok(idx) = idx_str.parse::<usize>() {
                    if let Some(t) = tokens.get(idx) {
                        out.push_str(t);
                    } else {
                        out.push_str(&rest[..rest.find(']').unwrap() + 1]);
                    }
                    i += "$ARGUMENTS[".len() + close + 1;
                    continue;
                }
            }
        }
        if rest.starts_with("$ARGUMENTS") && !is_ident_char(rest.as_bytes().get(10).copied()) {
            out.push_str(s);
            i += "$ARGUMENTS".len();
            continue;
        }
        // $N (1-indexed, decimal)
        if let Some(n_end) = parse_decimal(&rest[1..]) {
            let n_str = &rest[1..1 + n_end];
            if let Ok(n) = n_str.parse::<usize>() {
                // $0 doesn't map to a token in the TS convention; leave literal.
                if n >= 1 {
                    if let Some(t) = tokens.get(n - 1) {
                        out.push_str(t);
                    } else {
                        out.push('$');
                        out.push_str(n_str);
                    }
                    i += 1 + n_end;
                    continue;
                }
            }
        }
        // Not a recognized placeholder.
        out.push('$');
        i += 1;
    }
    out
}

fn substitute_object(body: &str, obj: &HashMap<String, String>) -> String {
    // Render `$ARGUMENTS` as sorted key=value pairs for stable output.
    let mut entries: Vec<(&String, &String)> = obj.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    let rendered = entries
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(" ");

    let mut out = String::with_capacity(body.len());
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let rest = &body[i..];
        // `${name}` (identifier chars)
        if rest.starts_with("${") {
            if let Some(close) = rest[2..].find('}') {
                let key = &rest[2..2 + close];
                if is_ident(key) {
                    if let Some(v) = obj.get(key) {
                        out.push_str(v);
                    } else {
                        out.push_str(&rest[..2 + close + 1]);
                    }
                    i += 2 + close + 1;
                    continue;
                }
            }
        }
        // `$ARGUMENTS` (not followed by `[` or identifier char)
        if rest.starts_with("$ARGUMENTS")
            && !is_ident_char(rest.as_bytes().get(10).copied())
            && rest.as_bytes().get(10) != Some(&b'[')
        {
            out.push_str(&rendered);
            i += "$ARGUMENTS".len();
            continue;
        }
        let c = next_char(body, i);
        out.push_str(&body[i..i + c.len]);
        i += c.len;
    }
    out
}

struct NextChar {
    len: usize,
}

fn next_char(s: &str, i: usize) -> NextChar {
    let b = s.as_bytes()[i];
    let len = if b < 0x80 {
        1
    } else if b < 0xE0 {
        2
    } else if b < 0xF0 {
        3
    } else {
        4
    };
    NextChar {
        len: len.min(s.len() - i).max(1),
    }
}

fn is_ident(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let bytes = s.as_bytes();
    if !(bytes[0].is_ascii_alphabetic() || bytes[0] == b'_') {
        return false;
    }
    bytes
        .iter()
        .all(|&b| b.is_ascii_alphanumeric() || b == b'_')
}

fn is_ident_char(b: Option<u8>) -> bool {
    match b {
        Some(c) => c.is_ascii_alphanumeric() || c == b'_',
        None => false,
    }
}

fn parse_decimal(s: &str) -> Option<usize> {
    let mut end = 0;
    for (i, c) in s.chars().enumerate() {
        if c.is_ascii_digit() {
            end = i + 1;
        } else {
            break;
        }
    }
    if end == 0 {
        None
    } else {
        Some(end)
    }
}
