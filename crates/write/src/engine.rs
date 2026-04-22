use harness_core::{ToolError, ToolErrorCode};

use crate::format::{format_fuzzy_candidates, format_match_locations};
use crate::matching::{
    build_match_locations, find_all_occurrences, find_fuzzy_candidates,
    substring_boundary_collisions, FuzzyOpts,
};
use crate::normalize::normalize_line_endings;
use crate::schema::EditSpec;

pub struct ApplyResult {
    pub content: String,
    pub replacements: usize,
    pub warnings: Vec<String>,
}

pub enum PipelineResult {
    Ok {
        content: String,
        total_replacements: usize,
        warnings: Vec<String>,
    },
    Err {
        error: ToolError,
        index: usize,
    },
}

/// Apply a single edit spec to `content`. Returns either the new content +
/// counts, or a structured ToolError.
pub fn apply_edit(content: &str, edit: &EditSpec) -> Result<ApplyResult, ToolError> {
    let old_raw = &edit.old_string;
    let new_raw = &edit.new_string;

    if old_raw == new_raw {
        return Err(ToolError::new(
            ToolErrorCode::NoOpEdit,
            "old_string equals new_string (no-op edit). If you intended to verify file state, use Read instead.",
        ));
    }

    let norm_content = normalize_line_endings(content);
    let norm_old = normalize_line_endings(old_raw);
    let norm_new = normalize_line_endings(new_raw);

    if norm_content.is_empty() {
        return Err(ToolError::new(
            ToolErrorCode::EmptyFile,
            "Edit cannot anchor to an empty file. Use Write to create initial content; Edit requires existing text as an anchor.",
        ));
    }

    let offsets = find_all_occurrences(&norm_content, &norm_old);

    if offsets.is_empty() {
        let candidates = find_fuzzy_candidates(&norm_content, &norm_old, FuzzyOpts::default());
        let block = format_fuzzy_candidates(&candidates);
        let msg = if !block.is_empty() {
            format!(
                "old_string was not found in the file.\n\nClosest candidates:\n\n{}\n\nIf one of these is the intended location, re-emit Edit with old_string taken verbatim from the candidate block above. Otherwise, re-Read the file to confirm the expected text is present.",
                block
            )
        } else {
            "old_string was not found in the file, and no fuzzy candidates crossed the similarity threshold. Re-Read the file to confirm the expected text is present.".to_string()
        };
        return Err(ToolError::new(ToolErrorCode::OldStringNotFound, msg).with_meta(
            serde_json::json!({
                "candidates": candidates,
            }),
        ));
    }

    let replace_all = edit.replace_all.unwrap_or(false);
    if offsets.len() > 1 && !replace_all {
        let locations = build_match_locations(&norm_content, &norm_old, &offsets);
        let block = format_match_locations(&locations);
        let msg = format!(
            "old_string matches {} locations; edit requires exactly one match.\n\n{}\n\nWiden old_string with surrounding context so it matches exactly one location, or pass replace_all: true if you intend to replace every occurrence.",
            offsets.len(),
            block
        );
        return Err(ToolError::new(ToolErrorCode::OldStringNotUnique, msg).with_meta(
            serde_json::json!({
                "match_count": offsets.len(),
                "locations": locations,
            }),
        ));
    }

    let target_offsets: Vec<usize> = if replace_all {
        offsets.clone()
    } else {
        vec![offsets[0]]
    };

    let mut warnings: Vec<String> = Vec::new();
    if replace_all && offsets.len() > 1 {
        let flagged = substring_boundary_collisions(&norm_content, &norm_old, &offsets);
        if !flagged.is_empty() {
            let lines_str = flagged
                .iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            let needle_preview = truncate_for_warning(&norm_old);
            warnings.push(format!(
                "replace_all pattern \"{}\" is adjacent to identifier characters at line(s) {}; verify these replacements did not land inside a larger identifier.",
                needle_preview, lines_str
            ));
        }
    }

    let new_content = replace_at_offsets(&norm_content, &norm_old, &norm_new, &target_offsets);

    Ok(ApplyResult {
        content: new_content,
        replacements: target_offsets.len(),
        warnings,
    })
}

pub fn apply_pipeline(initial: &str, edits: &[EditSpec]) -> PipelineResult {
    let mut content = initial.to_string();
    let mut total = 0usize;
    let mut warnings: Vec<String> = Vec::new();

    for (i, edit) in edits.iter().enumerate() {
        match apply_edit(&content, edit) {
            Ok(r) => {
                content = r.content;
                total += r.replacements;
                for w in r.warnings {
                    warnings.push(format!("edit[{}]: {}", i, w));
                }
            }
            Err(e) => {
                let msg = format!("edit[{}]: {}", i, e.message);
                let mut meta = e.meta.clone().unwrap_or_else(|| serde_json::json!({}));
                meta["edit_index"] = serde_json::json!(i);
                let new_err = ToolError::new(e.code, msg).with_meta(meta);
                return PipelineResult::Err {
                    error: new_err,
                    index: i,
                };
            }
        }
    }

    PipelineResult::Ok {
        content,
        total_replacements: total,
        warnings,
    }
}

fn replace_at_offsets(
    haystack: &str,
    needle: &str,
    replacement: &str,
    offsets: &[usize],
) -> String {
    if offsets.is_empty() {
        return haystack.to_string();
    }
    let needle_len = needle.as_bytes().len();
    let mut out = String::with_capacity(haystack.len());
    let mut cursor = 0usize;
    for &off in offsets {
        out.push_str(&haystack[cursor..off]);
        out.push_str(replacement);
        cursor = off + needle_len;
    }
    out.push_str(&haystack[cursor..]);
    out
}

fn truncate_for_warning(s: &str) -> String {
    let one_line: String = s.chars().map(|c| if c == '\n' { ' ' } else { c }).collect();
    if one_line.chars().count() <= 40 {
        one_line
    } else {
        let mut out: String = one_line.chars().take(37).collect();
        out.push_str("...");
        out
    }
}
