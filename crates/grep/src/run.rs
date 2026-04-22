use harness_core::{ToolError, ToolErrorCode};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;

use crate::constants::{
    DEFAULT_HEAD_LIMIT, DEFAULT_OFFSET, GREP_MAX_BYTES, GREP_MAX_FILE_SIZE,
    GREP_MAX_LINE_LENGTH,
};
use crate::engine::{
    compile_probe, default_engine, sort_paths_by_mtime, GrepEngineInput,
};
use crate::fence::{fence_search, resolve_search_path};
use crate::format::{
    format_content, format_count, format_files_with_matches, ContentBlock,
    ContentLine, CountBlock, FilesBlock, ZeroMatchContext,
};
use crate::schema::{safe_parse_grep_params, GrepParams};
use crate::suggest::suggest_siblings;
use crate::types::{
    ContentMeta, ContentResult, CountMeta, CountResult, ErrorResult,
    FilesMatchMeta, FilesMatchResult, GrepOutputMode, GrepResult,
    GrepSessionConfig,
};

struct Normalized {
    pattern: String,
    raw_path: Option<String>,
    glob: Option<String>,
    r#type: Option<String>,
    output_mode: GrepOutputMode,
    case_insensitive: bool,
    multiline: bool,
    context_before: usize,
    context_after: usize,
    head_limit: usize,
    offset: usize,
}

fn err(e: ToolError) -> GrepResult {
    GrepResult::Error(ErrorResult { error: e })
}

fn normalize(p: GrepParams) -> Result<Normalized, ToolError> {
    let output_mode = p.output_mode.unwrap_or_default();
    let context_before = p.context_before.or(p.context).unwrap_or(0);
    let context_after = p.context_after.or(p.context).unwrap_or(0);

    if output_mode != GrepOutputMode::Content && (context_before > 0 || context_after > 0) {
        return Err(ToolError::new(
            ToolErrorCode::InvalidParam,
            "context_before / context_after / context are only valid with output_mode: content",
        ));
    }

    Ok(Normalized {
        pattern: p.pattern,
        raw_path: p.path,
        glob: p.glob,
        r#type: p.r#type,
        output_mode,
        case_insensitive: p.case_insensitive.unwrap_or(false),
        multiline: p.multiline.unwrap_or(false),
        context_before,
        context_after,
        head_limit: p.head_limit.unwrap_or(DEFAULT_HEAD_LIMIT),
        offset: p.offset.unwrap_or(DEFAULT_OFFSET),
    })
}

fn engine_input(n: &Normalized, session: &GrepSessionConfig, root: PathBuf) -> GrepEngineInput {
    GrepEngineInput {
        pattern: n.pattern.clone(),
        root,
        glob: n.glob.clone(),
        r#type: n.r#type.clone(),
        case_insensitive: n.case_insensitive,
        multiline: n.multiline,
        context_before: n.context_before,
        context_after: n.context_after,
        max_columns: session
            .max_line_length
            .unwrap_or(GREP_MAX_LINE_LENGTH),
        max_filesize: session.max_filesize.unwrap_or(GREP_MAX_FILE_SIZE),
    }
}

pub async fn run(input: Value, session: &GrepSessionConfig) -> GrepResult {
    let parsed = match safe_parse_grep_params(&input) {
        Ok(v) => v,
        Err(e) => {
            return err(ToolError::new(ToolErrorCode::InvalidParam, e.to_string()));
        }
    };
    let n = match normalize(parsed) {
        Ok(v) => v,
        Err(e) => return err(e),
    };

    let root = resolve_search_path(&session.cwd, n.raw_path.as_deref());
    if let Some(fe) = fence_search(&session.permissions, &root) {
        return err(fe);
    }

    // NOT_FOUND with fuzzy siblings.
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

    // INVALID_REGEX probe (matches the TS D8 hint pattern).
    if let Err(msg) = compile_probe(&n.pattern) {
        return err(ToolError::new(
            ToolErrorCode::InvalidRegex,
            format!(
                "{}\n\nHint: escape literal regex metacharacters (e.g. 'interface\\{{\\}}' for 'interface{{}}'), or use a character class. '.' does not match newlines unless multiline: true.",
                msg.trim()
            ),
        ).with_meta(serde_json::json!({ "pattern": n.pattern })));
    }

    let ei = engine_input(&n, session, root.clone());
    let engine = default_engine();

    match n.output_mode {
        GrepOutputMode::FilesWithMatches => run_files_mode(&n, &*engine, ei),
        GrepOutputMode::Content => run_content_mode(&n, &*engine, ei, session),
        GrepOutputMode::Count => run_count_mode(&n, &*engine, ei),
    }
}

fn run_files_mode(
    n: &Normalized,
    engine: &dyn crate::engine::GrepEngine,
    ei: GrepEngineInput,
) -> GrepResult {
    let matches = match engine.search(&ei) {
        Ok(v) => v,
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("engine failed: {}", e),
            ));
        }
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut paths: Vec<String> = Vec::new();
    for m in matches {
        if m.is_context {
            continue;
        }
        if seen.insert(m.path.clone()) {
            paths.push(m.path);
        }
    }
    sort_paths_by_mtime(&mut paths);

    let total = paths.len();
    let start = n.offset.min(total);
    let end = (start + n.head_limit).min(total);
    let window: Vec<String> = paths[start..end].to_vec();
    let more = end < total;

    let output = format_files_with_matches(FilesBlock {
        pattern: &n.pattern,
        paths: &window,
        total,
        offset: start,
        more,
        zero_match_context: ZeroMatchContext {
            case_insensitive: n.case_insensitive,
            glob: n.glob.as_deref(),
            r#type: n.r#type.as_deref(),
        },
    });

    GrepResult::FilesWithMatches(FilesMatchResult {
        output,
        paths: window.clone(),
        meta: FilesMatchMeta {
            pattern: n.pattern.clone(),
            total,
            returned: window.len(),
            offset: start,
            head_limit: n.head_limit,
            more,
        },
    })
}

fn run_count_mode(
    n: &Normalized,
    engine: &dyn crate::engine::GrepEngine,
    ei: GrepEngineInput,
) -> GrepResult {
    let counts = match engine.count(&ei) {
        Ok(v) => v,
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("engine failed: {}", e),
            ));
        }
    };
    let total = counts.len();
    let start = n.offset.min(total);
    let end = (start + n.head_limit).min(total);
    let window = counts[start..end].to_vec();
    let more = end < total;

    let output = format_count(crate::format::CountBlock {
        pattern: &n.pattern,
        counts: &window,
        total,
        offset: start,
        more,
        zero_match_context: ZeroMatchContext {
            case_insensitive: n.case_insensitive,
            glob: n.glob.as_deref(),
            r#type: n.r#type.as_deref(),
        },
    });

    GrepResult::Count(CountResult {
        output,
        counts: window.clone(),
        meta: CountMeta {
            pattern: n.pattern.clone(),
            total_files: total,
            returned_files: window.len(),
            offset: start,
            head_limit: n.head_limit,
            more,
        },
    })
}

fn run_content_mode(
    n: &Normalized,
    engine: &dyn crate::engine::GrepEngine,
    ei: GrepEngineInput,
    session: &GrepSessionConfig,
) -> GrepResult {
    let mut matches = match engine.search(&ei) {
        Ok(v) => v,
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("engine failed: {}", e),
            ));
        }
    };
    // Group by file for mtime-sorted files, lines ascending.
    let mut paths: Vec<String> =
        matches.iter().map(|m| m.path.clone()).collect::<HashSet<_>>().into_iter().collect();
    sort_paths_by_mtime(&mut paths);
    let order: std::collections::HashMap<String, usize> =
        paths.iter().enumerate().map(|(i, p)| (p.clone(), i)).collect();
    matches.sort_by(|a, b| {
        let ia = order.get(&a.path).copied().unwrap_or(usize::MAX);
        let ib = order.get(&b.path).copied().unwrap_or(usize::MAX);
        ia.cmp(&ib).then(a.line_number.cmp(&b.line_number))
    });

    let total_matches = matches.len();
    let total_files = paths.len();
    let start = n.offset.min(total_matches);

    let max_bytes = session.max_bytes.unwrap_or(GREP_MAX_BYTES);
    let max_line_length = session.max_line_length.unwrap_or(GREP_MAX_LINE_LENGTH);

    let mut bytes: usize = 0;
    let mut current_file: &str = "";
    let mut window: Vec<(String, u64, String)> = Vec::new();
    let mut byte_cap = false;

    for i in start..total_matches {
        if window.len() >= n.head_limit {
            break;
        }
        let m = &matches[i];
        let truncated = if m.text.len() > max_line_length {
            format!(
                "{}... (line truncated to {} chars)",
                &m.text[..max_line_length],
                max_line_length
            )
        } else {
            m.text.clone()
        };
        let file_block_bytes = if m.path.as_str() != current_file {
            m.path.len() + if current_file.is_empty() { 1 } else { 2 }
        } else {
            0
        };
        let line_bytes = format!("  {}: {}", m.line_number, truncated).len() + 1;
        if bytes + file_block_bytes + line_bytes > max_bytes && !window.is_empty() {
            byte_cap = true;
            break;
        }
        bytes += file_block_bytes + line_bytes;
        current_file = m.path.as_str();
        window.push((m.path.clone(), m.line_number, truncated));
    }

    let more = start + window.len() < total_matches;
    let content_lines: Vec<ContentLine> = window
        .iter()
        .map(|(p, l, t)| ContentLine {
            path: p.as_str(),
            line: *l,
            text: t.as_str(),
        })
        .collect();
    let output = format_content(ContentBlock {
        pattern: &n.pattern,
        matches: &content_lines,
        total_matches,
        offset: start,
        more,
        byte_cap,
        max_bytes,
        zero_match_context: ZeroMatchContext {
            case_insensitive: n.case_insensitive,
            glob: n.glob.as_deref(),
            r#type: n.r#type.as_deref(),
        },
    });

    GrepResult::Content(ContentResult {
        output,
        meta: ContentMeta {
            pattern: n.pattern.clone(),
            total_matches,
            total_files,
            returned_matches: window.len(),
            offset: start,
            head_limit: n.head_limit,
            more,
            byte_cap,
        },
    })
}
