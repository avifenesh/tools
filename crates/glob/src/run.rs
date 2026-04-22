use harness_core::{ToolError, ToolErrorCode};
use serde_json::Value;

use crate::constants::{
    DEFAULT_HEAD_LIMIT, DEFAULT_OFFSET, GLOB_MAX_BYTES, GLOB_MAX_FILE_SIZE,
    GLOB_MAX_PATHS_SCANNED,
};
use crate::engine::{default_engine, GlobEngineInput};
use crate::fence::{fence_glob, resolve_search_path};
use crate::format::{format_paths, has_recursive_marker, FormatPathsArgs, ZeroMatchContext};
use crate::schema::safe_parse_glob_params;
use crate::suggest::suggest_siblings;
use crate::types::{
    ErrorResult, GlobPathsMeta, GlobPathsResult, GlobResult, GlobSessionConfig,
};

fn err(e: ToolError) -> GlobResult {
    GlobResult::Error(ErrorResult { error: e })
}

/// Auto-split an absolute-path pattern: when a model passes
/// `pattern: "/tmp/.../foo/**/*.ts"` without a `path`, extract the
/// absolute prefix up to the first wildcard segment into `path` and
/// keep the wildcard-y suffix as the pattern. Mirrors the TS D-D8b
/// decision exactly.
fn split_absolute_pattern(
    pattern: &str,
    existing_path: Option<&str>,
) -> (String, Option<String>) {
    if existing_path.is_some() {
        return (pattern.to_string(), None);
    }
    let is_absolute = pattern.starts_with('/')
        || (pattern.len() >= 3
            && pattern.as_bytes().get(1) == Some(&b':')
            && matches!(pattern.as_bytes().get(2), Some(b'/') | Some(b'\\'))
            && pattern.as_bytes()[0].is_ascii_alphabetic());
    if !is_absolute {
        return (pattern.to_string(), None);
    }
    let segments: Vec<&str> = pattern.split('/').collect();
    let wildcard_idx = segments
        .iter()
        .position(|seg| seg.contains(['*', '?', '{', '[', ']']));
    match wildcard_idx {
        None => (pattern.to_string(), None),
        Some(0) => (pattern.to_string(), None),
        Some(idx) => {
            let prefix = segments[..idx].join("/");
            let prefix = if prefix.is_empty() {
                "/".to_string()
            } else {
                prefix
            };
            let rest = segments[idx..].join("/");
            (rest, Some(prefix))
        }
    }
}

pub async fn run(input: Value, session: &GlobSessionConfig) -> GlobResult {
    let parsed = match safe_parse_glob_params(&input) {
        Ok(v) => v,
        Err(e) => {
            return err(ToolError::new(ToolErrorCode::InvalidParam, e.to_string()));
        }
    };

    let (pattern, redirected_path) =
        split_absolute_pattern(&parsed.pattern, parsed.path.as_deref());
    let raw_path = redirected_path.or(parsed.path);
    let explicit_path = raw_path.is_some();
    let head_limit = parsed.head_limit.unwrap_or(DEFAULT_HEAD_LIMIT);
    let offset = parsed.offset.unwrap_or(DEFAULT_OFFSET);

    let root = resolve_search_path(&session.cwd, raw_path.as_deref());
    if let Some(fe) = fence_glob(&session.permissions, &root) {
        return err(fe);
    }

    if !root.exists() {
        let root_str = root.to_string_lossy().into_owned();
        let siblings = suggest_siblings(&root_str);
        let message = if !siblings.is_empty() {
            format!(
                "Path does not exist: {}\n\nDid you mean one of these?\n{}",
                root_str,
                siblings.join("\n")
            )
        } else {
            format!("Path does not exist: {}", root_str)
        };
        return err(ToolError::new(ToolErrorCode::NotFound, message).with_meta(
            serde_json::json!({ "path": root_str, "suggestions": siblings }),
        ));
    }

    // Compile the matcher. We use globset's builder to mimic picomatch's
    // bash-glob semantics: `*` matches within one path segment, `**`
    // matches any number of segments, `{a,b}` expands, no dotfile match
    // unless the pattern has a leading dot in the basename.
    let matcher = match build_matcher(&pattern) {
        Ok(m) => m,
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::InvalidParam,
                format!("invalid glob pattern: {}", e),
            ));
        }
    };

    let engine = default_engine();
    let ei = GlobEngineInput {
        root: root.clone(),
        max_filesize: session.max_filesize.unwrap_or(GLOB_MAX_FILE_SIZE),
    };
    let scan_cap = session.max_paths_scanned.unwrap_or(GLOB_MAX_PATHS_SCANNED);

    let mut matched: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    let all = match engine.list(&ei) {
        Ok(v) => v,
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("engine failed: {}", e),
            ));
        }
    };
    for abs in all {
        scanned += 1;
        if scanned > scan_cap {
            return err(
                ToolError::new(
                    ToolErrorCode::IoError,
                    format!(
                        "Pattern matched too many files (>{}). Narrow the pattern.",
                        scan_cap
                    ),
                )
                .with_meta(serde_json::json!({ "pattern": pattern, "scanCap": scan_cap })),
            );
        }
        if let Ok(rel) = std::path::Path::new(&abs).strip_prefix(&root) {
            if matcher.is_match(rel) {
                matched.push(abs);
            }
        }
    }

    // mtime DESC, path ASC tie-break.
    sort_by_mtime(&mut matched);

    let total = matched.len();
    let start = offset.min(total);

    let max_bytes = session.max_bytes.unwrap_or(GLOB_MAX_BYTES);
    let mut window: Vec<String> = Vec::new();
    let mut bytes: usize = 0;
    let mut i = start;
    while i < total && window.len() < head_limit {
        let line = matched[i].len() + 1; // +1 for \n
        if bytes + line > max_bytes && !window.is_empty() {
            break;
        }
        bytes += line;
        window.push(matched[i].clone());
        i += 1;
    }
    let end = start + window.len();
    let more = end < total;

    let output = format_paths(FormatPathsArgs {
        pattern: &pattern,
        paths: &window,
        total,
        offset: start,
        head_limit,
        more,
        zero_match_context: ZeroMatchContext {
            has_recursive_marker: has_recursive_marker(&pattern),
            explicit_path,
        },
    });

    GlobResult::Paths(GlobPathsResult {
        output,
        paths: window.clone(),
        meta: GlobPathsMeta {
            pattern,
            total,
            returned: window.len(),
            offset: start,
            head_limit,
            more,
        },
    })
}

fn build_matcher(pattern: &str) -> Result<globset::GlobMatcher, globset::Error> {
    globset::GlobBuilder::new(pattern)
        .case_insensitive(true)
        .literal_separator(true)
        .backslash_escape(true)
        .build()
        .map(|g| g.compile_matcher())
}

fn sort_by_mtime(paths: &mut Vec<String>) {
    let mut with_mtime: Vec<(Option<std::time::SystemTime>, String)> = paths
        .drain(..)
        .map(|p| {
            let mtime = std::fs::metadata(&p).ok().and_then(|m| m.modified().ok());
            (mtime, p)
        })
        .collect();
    with_mtime.sort_by(|a, b| match (a.0, b.0) {
        (Some(ta), Some(tb)) => tb.cmp(&ta).then(a.1.cmp(&b.1)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.1.cmp(&b.1),
    });
    paths.extend(with_mtime.into_iter().map(|(_, p)| p));
}
