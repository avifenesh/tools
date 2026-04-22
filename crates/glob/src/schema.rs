use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

/// Ported from `@agent-sh/harness-glob/src/schema.ts`. Serde's
/// `deny_unknown_fields` plus a pre-check for the known-alias table
/// lets us return the same targeted hints the TS version ships.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GlobParams {
    pub pattern: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_limit: Option<usize>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum GlobParseError {
    #[error("{0}")]
    Message(String),
}

fn known_alias_hint(key: &str) -> Option<&'static str> {
    match key {
        "glob" => Some(
            "unknown parameter 'glob'. Use 'pattern' instead (this tool IS glob; the pattern goes in the 'pattern' field).",
        ),
        "glob_pattern" => Some("unknown parameter 'glob_pattern'. Use 'pattern' instead."),
        "pattern_glob" => Some("unknown parameter 'pattern_glob'. Use 'pattern' instead."),
        "regex" => Some(
            "unknown parameter 'regex'. Glob uses glob syntax, not regex — use 'pattern' with syntax like '**/*.ts'. If you want to search file CONTENTS by regex, use the grep tool instead.",
        ),
        "query" => Some("unknown parameter 'query'. Use 'pattern' instead."),
        "filter" => Some("unknown parameter 'filter'. Use 'pattern' instead."),
        "file_pattern" => Some("unknown parameter 'file_pattern'. Use 'pattern' instead."),
        "name" => Some(
            "unknown parameter 'name'. Use 'pattern' instead (e.g. '**/User*.ts').",
        ),
        "cwd" => Some("unknown parameter 'cwd'. Use 'path' instead."),
        "dir" => Some("unknown parameter 'dir'. Use 'path' instead."),
        "directory" => Some("unknown parameter 'directory'. Use 'path' instead."),
        "dir_path" => Some("unknown parameter 'dir_path'. Use 'path' instead."),
        "root" => Some("unknown parameter 'root'. Use 'path' instead."),
        "limit" => Some(
            "unknown parameter 'limit'. Use 'head_limit' instead (default 250).",
        ),
        "max_results" => Some(
            "unknown parameter 'max_results'. Use 'head_limit' instead (default 250).",
        ),
        "max_count" => Some(
            "unknown parameter 'max_count'. Use 'head_limit' instead (default 250).",
        ),
        "max_depth" => Some(
            "unknown parameter 'max_depth'. Depth is controlled by the pattern itself — use '*' for one level, '**/*' for any depth.",
        ),
        "skip" => Some("unknown parameter 'skip'. Use 'offset' instead."),
        "recursive" => Some(
            "unknown parameter 'recursive'. Recursion is controlled by the pattern — prefix with '**/' for recursive (e.g. '**/*.ts'), or omit for top-level only.",
        ),
        "case_sensitive" => Some(
            "unknown parameter 'case_sensitive'. Not supported per-call — glob is case-insensitive by default; use a case-specific pattern if you need exact casing.",
        ),
        "ignore_case" => Some(
            "unknown parameter 'ignore_case'. Glob is case-insensitive by default; no flag needed.",
        ),
        "insensitive" => Some(
            "unknown parameter 'insensitive'. Glob is case-insensitive by default; no flag needed.",
        ),
        "include_hidden" => Some(
            "unknown parameter 'include_hidden'. Hidden files are excluded by default and cannot be included per-call; this is a session-config decision.",
        ),
        "hidden" => Some(
            "unknown parameter 'hidden'. Hidden files are excluded by default and cannot be included per-call.",
        ),
        "no_ignore" => Some(
            "unknown parameter 'no_ignore'. Gitignore respect is on by default and cannot be disabled per-call.",
        ),
        "follow_symlinks" => Some(
            "unknown parameter 'follow_symlinks'. Symlinks are not followed; this is not configurable per-call.",
        ),
        "exclude" => Some(
            "unknown parameter 'exclude'. Use a negated glob pattern like '!node_modules/**' within 'pattern', or rely on .gitignore.",
        ),
        "exclude_patterns" => Some(
            "unknown parameter 'exclude_patterns'. Use a negated segment in 'pattern' or rely on .gitignore.",
        ),
        _ => None,
    }
}

fn canonical_fields() -> HashSet<&'static str> {
    ["pattern", "path", "head_limit", "offset"]
        .into_iter()
        .collect()
}

pub fn safe_parse_glob_params(input: &Value) -> Result<GlobParams, GlobParseError> {
    if let Some(obj) = input.as_object() {
        let canonical = canonical_fields();
        let mut alias_hints: Vec<String> = Vec::new();
        let mut unknown_unhinted: Vec<String> = Vec::new();
        for key in obj.keys() {
            if canonical.contains(key.as_str()) {
                continue;
            }
            if let Some(hint) = known_alias_hint(key.as_str()) {
                alias_hints.push(hint.to_string());
            } else {
                unknown_unhinted.push(format!("unknown parameter '{}'.", key));
            }
        }
        if !alias_hints.is_empty() || !unknown_unhinted.is_empty() {
            let mut msgs = alias_hints;
            msgs.extend(unknown_unhinted);
            return Err(GlobParseError::Message(msgs.join("; ")));
        }
    }

    let parsed: GlobParams = serde_json::from_value(input.clone())
        .map_err(|e| GlobParseError::Message(e.to_string()))?;

    if parsed.pattern.is_empty() {
        return Err(GlobParseError::Message("pattern is required".to_string()));
    }
    if let Some(hl) = parsed.head_limit {
        if hl == 0 {
            return Err(GlobParseError::Message(
                "head_limit must be >= 1".to_string(),
            ));
        }
    }
    Ok(parsed)
}

pub const GLOB_TOOL_NAME: &str = "glob";

pub const GLOB_TOOL_DESCRIPTION: &str =
    "Find files by name pattern. Returns absolute paths sorted by modification time, newest first.\n\n\
    Usage:\n\
    - pattern is required. Bash-style glob syntax: '*' matches within one path segment (does not cross '/'), '**' matches any number of segments, '?' matches one character, '{a,b,c}' is brace expansion. Case-insensitive by default.\n\
    - To search recursively across subdirectories, include '**/'. Example: '**/*.ts' finds every TypeScript file; 'src/**/*.{ts,tsx}' restricts to src/. A bare '*.ts' matches only top-level files — it is NOT recursive. A bare name like 'UserService.ts' matches only that exact top-level file; use '**/UserService.ts' to find it at any depth.\n\
    - path defaults to the session cwd. Absolute paths preferred; relative paths resolve against cwd.\n\
    - Results are sorted by modification time (newest first), capped at head_limit (default 250). Use offset to page: next_offset = previous_offset + returned_count.\n\
    - .gitignore, .ignore, and .rgignore are respected. Hidden files (dotfiles) are skipped. node_modules, .git, and other ignored paths will not appear.\n\
    - Prefer this tool over 'find' or 'ls -R' for filename search. If you need to search file CONTENTS, use the grep tool instead.\n\
    - Call in parallel for independent searches. When the task requires many rounds of pattern exploration, consider delegating to a sub-agent.";
