//! Minimal YAML parser scoped to SKILL.md frontmatter. Matches the TS
//! parser at `packages/skill/src/frontmatter.ts` verbatim in behavior.
//!
//! Supports:
//! - `key: value` (scalar)
//! - `key: "value"` / `key: 'value'` (quoted scalar)
//! - `key: true|false` / `key: 42` / `key: null|~`
//! - `key: |` followed by indented block lines (literal block scalar)
//! - `key:` followed by a nested one-level map (indented `key: value`)
//! - `key: [a, b, c]` (flow-style array of strings)
//! - `key:` followed by `- a`, `- b` block array lines
//!
//! Anything else is rejected with a structured error. We keep it small
//! on purpose — skills converge on the same ~10 fields.

use serde_json::{Map, Value};

use crate::constants::{
    MAX_ARGUMENT_HINT_LENGTH, MAX_COMPATIBILITY_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH,
};
use crate::schema::is_valid_skill_name;

#[derive(Debug, Clone)]
pub struct FrontmatterError {
    pub reason: String,
    pub line: Option<usize>,
}

/// Splits SKILL.md into `(fm_text, body)`. Returns `Ok(None)` if the
/// file has no frontmatter (no leading `---`). Returns `Err` only when
/// there's a malformed opening without a closing `---`.
pub fn split_frontmatter(
    text: &str,
) -> Result<Option<(String, String)>, FrontmatterError> {
    // Normalize CRLF → LF for parsing. Tolerate BOM.
    let normalized = text.replace("\r\n", "\n");
    let stripped = normalized.strip_prefix('\u{FEFF}').unwrap_or(&normalized);

    if !stripped.starts_with("---\n") && stripped != "---" {
        return Ok(None);
    }

    let lines: Vec<&str> = stripped.split('\n').collect();
    let mut close: Option<usize> = None;
    for (i, &line) in lines.iter().enumerate().skip(1) {
        if line == "---" {
            close = Some(i);
            break;
        }
    }
    let close = close.ok_or_else(|| FrontmatterError {
        reason:
            "frontmatter has an opening `---` but no closing `---`; the file must have YAML between two `---` lines at the top"
                .into(),
        line: None,
    })?;

    let fm_text = lines[1..close].join("\n");
    let body = if close + 1 < lines.len() {
        lines[close + 1..].join("\n")
    } else {
        String::new()
    };
    Ok(Some((fm_text, body)))
}

pub fn parse_yaml_frontmatter(
    fm_text: &str,
) -> Result<Map<String, Value>, FrontmatterError> {
    let mut out = Map::new();
    let lines: Vec<&str> = fm_text.split('\n').collect();
    let mut i = 0usize;
    while i < lines.len() {
        let raw = lines[i];
        if is_blank_or_comment(raw) {
            i += 1;
            continue;
        }
        if starts_with_whitespace(raw) {
            return Err(FrontmatterError {
                reason: format!("unexpected indentation at top-level line {}", i + 1),
                line: Some(i + 1),
            });
        }
        let colon_idx = match raw.find(':') {
            Some(c) => c,
            None => {
                return Err(FrontmatterError {
                    reason: format!("expected 'key: value' on line {}", i + 1),
                    line: Some(i + 1),
                });
            }
        };
        let key = raw[..colon_idx].trim();
        if key.is_empty() {
            return Err(FrontmatterError {
                reason: format!("empty key on line {}", i + 1),
                line: Some(i + 1),
            });
        }
        let rest = &raw[colon_idx + 1..];
        let inline = rest.trim();

        // Literal block scalar `key: |`, `key: |-`, `key: |+`.
        if inline == "|" || inline == "|-" || inline == "|+" {
            let (value, consumed) = read_literal_block(&lines, i + 1);
            out.insert(key.to_string(), Value::String(value));
            i = consumed;
            continue;
        }

        // Inline value.
        if !inline.is_empty() {
            if inline.starts_with('[') && inline.ends_with(']') {
                out.insert(key.to_string(), parse_flow_array(inline));
                i += 1;
                continue;
            }
            out.insert(key.to_string(), parse_scalar(inline));
            i += 1;
            continue;
        }

        // Nested block: map or block-array.
        let next_non_blank = find_next_non_blank(&lines, i + 1);
        let Some(nnb) = next_non_blank else {
            out.insert(key.to_string(), Value::String(String::new()));
            i += 1;
            continue;
        };
        let next_line = lines[nnb];
        if !starts_with_whitespace(next_line) {
            out.insert(key.to_string(), Value::String(String::new()));
            i += 1;
            continue;
        }
        if next_line.trim_start().starts_with("- ") || next_line.trim_start() == "-" {
            let (arr, consumed) = read_block_array(&lines, i + 1);
            out.insert(key.to_string(), Value::Array(arr));
            i = consumed;
            continue;
        }
        let (map, consumed) = read_nested_map(&lines, i + 1)?;
        out.insert(key.to_string(), Value::Object(map));
        i = consumed;
    }
    Ok(out)
}

fn is_blank_or_comment(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || t.starts_with('#')
}

fn starts_with_whitespace(line: &str) -> bool {
    line.starts_with(' ') || line.starts_with('\t')
}

fn find_next_non_blank(lines: &[&str], from: usize) -> Option<usize> {
    (from..lines.len()).find(|&i| !is_blank_or_comment(lines[i]))
}

fn parse_scalar(s: &str) -> Value {
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        return Value::String(s[1..s.len() - 1].to_string());
    }
    match s {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        "null" | "~" => return Value::Null,
        _ => {}
    }
    if let Ok(i) = s.parse::<i64>() {
        return Value::Number(i.into());
    }
    if let Ok(f) = s.parse::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(f) {
            return Value::Number(n);
        }
    }
    Value::String(s.to_string())
}

fn parse_flow_array(s: &str) -> Value {
    let inner = s[1..s.len() - 1].trim();
    if inner.is_empty() {
        return Value::Array(Vec::new());
    }
    let items: Vec<Value> = inner
        .split(',')
        .map(|item| {
            let t = item.trim();
            if (t.starts_with('"') && t.ends_with('"') && t.len() >= 2)
                || (t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2)
            {
                Value::String(t[1..t.len() - 1].to_string())
            } else {
                Value::String(t.to_string())
            }
        })
        .collect();
    Value::Array(items)
}

fn read_literal_block(lines: &[&str], from: usize) -> (String, usize) {
    // Find indentation of first non-blank block line.
    let mut first = from;
    while first < lines.len() {
        if lines[first].trim().is_empty() {
            first += 1;
            continue;
        }
        break;
    }
    if first >= lines.len() {
        return (String::new(), from);
    }
    let first_line = lines[first];
    // Measure leading whitespace.
    let indent: String = first_line
        .chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .collect();
    if indent.is_empty() {
        return (String::new(), from);
    }
    let mut collected: Vec<String> = Vec::new();
    let mut i = from;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            collected.push(String::new());
            i += 1;
            continue;
        }
        if !line.starts_with(&indent) {
            break;
        }
        collected.push(line[indent.len()..].to_string());
        i += 1;
    }
    // Trim trailing blanks conservatively (spec equivalent of `|-`).
    while collected.last().map(|s| s.is_empty()).unwrap_or(false) {
        collected.pop();
    }
    (collected.join("\n"), i)
}

fn read_block_array(lines: &[&str], from: usize) -> (Vec<Value>, usize) {
    let mut arr: Vec<Value> = Vec::new();
    let mut i = from;
    let mut indent: Option<String> = None;
    while i < lines.len() {
        let line = lines[i];
        if is_blank_or_comment(line) {
            i += 1;
            continue;
        }
        let leading: String = line
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect();
        if leading.is_empty() {
            break;
        }
        if indent.is_none() {
            indent = Some(leading.clone());
        }
        if leading != *indent.as_ref().unwrap() {
            break;
        }
        let after = &line[leading.len()..];
        if !after.starts_with("- ") && after != "-" {
            break;
        }
        let value_str = if after == "-" { "" } else { after[2..].trim() };
        arr.push(parse_scalar(value_str));
        i += 1;
    }
    (arr, i)
}

fn read_nested_map(
    lines: &[&str],
    from: usize,
) -> Result<(Map<String, Value>, usize), FrontmatterError> {
    let mut map = Map::new();
    let mut i = from;
    let mut indent: Option<String> = None;
    while i < lines.len() {
        let line = lines[i];
        if is_blank_or_comment(line) {
            i += 1;
            continue;
        }
        let leading: String = line
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect();
        if leading.is_empty() {
            break;
        }
        if indent.is_none() {
            indent = Some(leading.clone());
        }
        let ind = indent.as_ref().unwrap();
        if !line.starts_with(ind) {
            break;
        }
        if leading.len() < ind.len() {
            break;
        }
        let content = &line[ind.len()..];
        let colon_idx = match content.find(':') {
            Some(c) => c,
            None => {
                return Err(FrontmatterError {
                    reason: format!("expected 'key: value' in nested map on line {}", i + 1),
                    line: Some(i + 1),
                });
            }
        };
        let key = content[..colon_idx].trim().to_string();
        let rest = content[colon_idx + 1..].trim();
        if rest.starts_with('[') && rest.ends_with(']') {
            map.insert(key, parse_flow_array(rest));
        } else if rest.starts_with('{') && rest.ends_with('}') {
            // Flow-style inline map like `{type: string}` — parse into an
            // object of string→scalar. Lightweight since only `arguments`
            // uses this shape.
            let inner = rest[1..rest.len() - 1].trim();
            let mut flow_map = Map::new();
            if !inner.is_empty() {
                for pair in inner.split(',') {
                    let pair = pair.trim();
                    if let Some(ci) = pair.find(':') {
                        let k = pair[..ci].trim().to_string();
                        let v = pair[ci + 1..].trim();
                        flow_map.insert(k, parse_scalar(v));
                    }
                }
            }
            map.insert(key, Value::Object(flow_map));
        } else {
            map.insert(key, parse_scalar(rest));
        }
        i += 1;
    }
    Ok((map, i))
}

// ---- validate ----

#[derive(Debug, Clone)]
pub enum ValidationError {
    InvalidFrontmatter { reason: String, line: Option<usize> },
    NameMismatch { reason: String },
}

pub struct ValidatedSkill {
    pub frontmatter: Map<String, Value>,
    pub body: String,
}

pub fn validate_frontmatter(
    fm_text: &str,
    body: &str,
    expected_name: &str,
) -> Result<ValidatedSkill, ValidationError> {
    let mut fm = parse_yaml_frontmatter(fm_text).map_err(|e| {
        ValidationError::InvalidFrontmatter {
            reason: e.reason,
            line: e.line,
        }
    })?;

    // name
    let name = match fm.get("name") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => {
            return Err(ValidationError::InvalidFrontmatter {
                reason: "frontmatter missing required field 'name'".into(),
                line: None,
            });
        }
    };
    if name.len() > MAX_NAME_LENGTH {
        return Err(ValidationError::InvalidFrontmatter {
            reason: format!("frontmatter 'name' exceeds {} chars", MAX_NAME_LENGTH),
            line: None,
        });
    }
    if !is_valid_skill_name(&name) {
        return Err(ValidationError::InvalidFrontmatter {
            reason: format!(
                "frontmatter 'name' must match lowercase-kebab-case regex; got \"{}\"",
                name
            ),
            line: None,
        });
    }

    // description
    let description = match fm.get("description") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => {
            return Err(ValidationError::InvalidFrontmatter {
                reason: "frontmatter missing required field 'description'".into(),
                line: None,
            });
        }
    };
    if description.len() > MAX_DESCRIPTION_LENGTH {
        return Err(ValidationError::InvalidFrontmatter {
            reason: format!(
                "frontmatter 'description' exceeds {} chars",
                MAX_DESCRIPTION_LENGTH
            ),
            line: None,
        });
    }

    // compatibility
    if let Some(v) = fm.get("compatibility") {
        match v {
            Value::String(s) => {
                if s.len() > MAX_COMPATIBILITY_LENGTH {
                    return Err(ValidationError::InvalidFrontmatter {
                        reason: format!(
                            "'compatibility' exceeds {} chars",
                            MAX_COMPATIBILITY_LENGTH
                        ),
                        line: None,
                    });
                }
            }
            _ => {
                return Err(ValidationError::InvalidFrontmatter {
                    reason: "'compatibility' must be a string".into(),
                    line: None,
                });
            }
        }
    }

    // argument-hint
    if let Some(v) = fm.get("argument-hint") {
        match v {
            Value::String(s) => {
                if s.len() > MAX_ARGUMENT_HINT_LENGTH {
                    return Err(ValidationError::InvalidFrontmatter {
                        reason: format!(
                            "'argument-hint' exceeds {} chars",
                            MAX_ARGUMENT_HINT_LENGTH
                        ),
                        line: None,
                    });
                }
            }
            _ => {
                return Err(ValidationError::InvalidFrontmatter {
                    reason: "'argument-hint' must be a string".into(),
                    line: None,
                });
            }
        }
    }

    // allowed-tools: normalize string → array
    if let Some(v) = fm.get("allowed-tools").cloned() {
        match v {
            Value::String(s) => {
                let items: Vec<Value> = s
                    .split(|c: char| c == ',' || c.is_ascii_whitespace())
                    .filter(|t| !t.is_empty())
                    .map(|t| Value::String(t.to_string()))
                    .collect();
                fm.insert("allowed-tools".to_string(), Value::Array(items));
            }
            Value::Array(_) => { /* ok */ }
            _ => {
                return Err(ValidationError::InvalidFrontmatter {
                    reason: "'allowed-tools' must be a string or string[]".into(),
                    line: None,
                });
            }
        }
    }

    // name match against containing dir
    if name != expected_name {
        return Err(ValidationError::NameMismatch {
            reason: format!(
                "frontmatter 'name' (\"{}\") does not match the skill directory (\"{}\")",
                name, expected_name
            ),
        });
    }

    Ok(ValidatedSkill {
        frontmatter: fm,
        body: body.to_string(),
    })
}
