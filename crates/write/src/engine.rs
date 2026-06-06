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

/// Strip leading and trailing whitespace from each line, preserving line
/// count and internal spacing. Uses split('\n') to keep the trailing empty
/// line when the string ends with \n, so "foo\n" stays as two lines rather
/// than collapsing to one (which would match "foo_extra" incorrectly).
fn strip_line_whitespace(s: &str) -> String {
    s.split('\n').map(|l| l.trim()).collect::<Vec<_>>().join("\n")
}

/// Apply a single edit spec to `content`. Returns either the new content +
/// counts, or a structured ToolError.
pub fn apply_edit(content: &str, edit: &EditSpec) -> Result<ApplyResult, ToolError> {
    let old_raw = &edit.old_string;
    let new_raw = &edit.new_string;
    let ignore_ws = edit.ignore_whitespace.unwrap_or(false);

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

    // When ignore_whitespace is true, match against whitespace-stripped
    // versions but replace in the original text.
    let (search_content, search_needle) = if ignore_ws {
        (strip_line_whitespace(&norm_content), strip_line_whitespace(&norm_old))
    } else {
        (norm_content.clone(), norm_old.clone())
    };

    let offsets = find_all_occurrences(&search_content, &search_needle);

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
        let locations = build_match_locations(&search_content, &search_needle, &offsets);
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
    if replace_all && offsets.len() > 1 && !ignore_ws {
        let flagged = substring_boundary_collisions(&norm_content, &norm_old, &target_offsets);
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

    // When ignore_whitespace is true, the offsets are from the stripped
    // content. Map them back to line ranges in the original content and
    // replace those lines.
    let new_content = if ignore_ws {
        replace_by_line_range(&norm_content, &search_content, &search_needle, &norm_new, &target_offsets)
    } else {
        replace_at_offsets(&norm_content, &norm_old, &norm_new, &target_offsets)
    };

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

/// Replace text by mapping byte offsets from a whitespace-stripped version
/// back to the original content. For single-line matches, replaces the
/// matched substring within the line (preserving surrounding text). For
/// multi-line matches, replaces the entire line range.
fn replace_by_line_range(
    original: &str,
    stripped: &str,
    old_stripped: &str,
    replacement: &str,
    stripped_offsets: &[usize],
) -> String {
    let orig_lines: Vec<&str> = original.split('\n').collect();
    let strip_lines: Vec<&str> = stripped.split('\n').collect();

    // Number of lines the old_string spans.
    let old_line_count = old_stripped.split('\n').count();
    let replace_lines: Vec<&str> = replacement.split('\n').collect();

    // Check if this is a single-line match — if so, do substring replacement
    // to preserve surrounding text on the line.
    let single_line = old_line_count == 1 && replace_lines.len() == 1;

    // Build (line_idx, byte_offset_in_stripped_line) for each match.
    let mut positions: Vec<(usize, usize)> = Vec::new();
    for &off in stripped_offsets {
        let mut line_idx = 0usize;
        let mut byte_pos = 0usize;
        let mut found = false;
        for (i, line) in strip_lines.iter().enumerate() {
            if byte_pos <= off && off < byte_pos + line.len() {
                line_idx = i;
                found = true;
                break;
            }
            byte_pos += line.len() + 1; // +1 for the '\n'
        }
        // If offset lands on a newline boundary (empty stripped line),
        // advance to the next line so we don't silently fall back to line 0.
        if !found && byte_pos <= off && off < byte_pos + strip_lines.get(line_idx).map(|l| l.len()).unwrap_or(0) {
            found = true;
        }
        if !found {
            // Offset past all lines — clamp to last line to avoid underflow.
            line_idx = (line_idx).min(strip_lines.len().saturating_sub(1));
            byte_pos = if line_idx == 0 { 0 } else {
                strip_lines[..line_idx].iter().map(|l| l.len() + 1).sum()
            };
        }
        let byte_pos = byte_pos.min(off);
        let offset_in_line = off - byte_pos;
        positions.push((line_idx, offset_in_line));
    }

    let mut result_lines: Vec<String> = orig_lines.iter().map(|l| l.to_string()).collect();

    if single_line {
        // Single-line: replace the matched span within each original line,
        // preserving surrounding text. Map the byte offset from the stripped
        // line back to the original line to find the correct position.
        for (line_idx, stripped_off) in positions.iter().rev() {
            if let Some(line) = result_lines.get_mut(*line_idx) {
                let orig_line = line.as_str();
                // Find leading whitespace length in the original line.
                let lead_ws = orig_line.len() - orig_line.trim_start().len();

                // The match starts at `stripped_off` bytes into the stripped
                // line (which is the original line with leading/trailing
                // whitespace removed). Map to the original line:
                let orig_start = lead_ws + stripped_off;
                let orig_end = orig_start + old_stripped.len();

                if orig_start <= orig_line.len() && orig_end <= orig_line.len() {
                    let new_line = format!(
                        "{}{}{}",
                        &orig_line[..orig_start],
                        replacement,
                        &orig_line[orig_end..]
                    );
                    *line = new_line;
                } else {
                    // Offset mapping failed — fall back to full line replace.
                    *line = replacement.to_string();
                }
            }
        }
    } else {
        // Multi-line: replace matched range while preserving surrounding text
        // on the first and last lines. For "prefix old1\nold2 suffix" matching
        // "old1\nold2", this preserves "prefix " and " suffix".
        let needle_lines: Vec<&str> = old_stripped.split('\n').collect();
        let first_trimmed = needle_lines.first().map(|l| l.trim()).unwrap_or("");
        let last_trimmed = needle_lines.last().map(|l| l.trim()).unwrap_or("");
        let mut ranges: Vec<(usize, usize)> = Vec::new();
        for (line_idx, _offset) in &positions {
            ranges.push((*line_idx, *line_idx + old_line_count));
        }
        for (start, end) in ranges.into_iter().rev() {
            let clamped_start = start.min(result_lines.len());
            let clamped_end = end.min(result_lines.len());

            // Preserve prefix on the first line.
            let prefix = if let Some(first_line) = result_lines.get(clamped_start) {
                let match_pos = first_line.find(first_trimmed);
                if let Some(pos) = match_pos {
                    first_line[..pos].to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            // Preserve suffix on the last line.
            let suffix = if let Some(last_line) = result_lines.get(clamped_end - 1) {
                let match_pos = last_line.find(last_trimmed);
                if let Some(pos) = match_pos {
                    let end_pos = pos + last_trimmed.len();
                    if end_pos <= last_line.len() {
                        last_line[end_pos..].to_string()
                    } else {
                        String::new()
                    }
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            let mut new_lines: Vec<String> = replace_lines.iter().map(|l| l.to_string()).collect();

            // Prepend prefix to the first replacement line.
            if !prefix.is_empty() {
                if let Some(first) = new_lines.first_mut() {
                    *first = format!("{}{}", prefix, first);
                }
            }

            // Append suffix to the last replacement line.
            if !suffix.is_empty() {
                if let Some(last) = new_lines.last_mut() {
                    *last = format!("{}{}", last, suffix);
                }
            }

            result_lines.splice(clamped_start..clamped_end, new_lines);
        }
    }

    result_lines.join("\n")
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
