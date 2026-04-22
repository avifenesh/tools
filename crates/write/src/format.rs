use crate::types::{FuzzyCandidate, MatchLocation};

pub struct FormatWriteArgs<'a> {
    pub path: &'a str,
    pub created: bool,
    pub bytes_before: u64,
    pub bytes_after: u64,
}

pub fn format_write_success(args: FormatWriteArgs<'_>) -> String {
    let header = format!("<path>{}</path>", args.path);
    let summary = if args.created {
        format!("Wrote {} bytes to {}", args.bytes_after, args.path)
    } else {
        format!(
            "Overwrote {} (was {} bytes, now {} bytes, {})",
            args.path,
            args.bytes_before,
            args.bytes_after,
            delta_str(args.bytes_before, args.bytes_after)
        )
    };
    format!("{}\n<result>\n{}\n</result>", header, summary)
}

pub struct FormatEditArgs<'a> {
    pub path: &'a str,
    pub replacements: usize,
    pub replace_all: bool,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub warnings: &'a [String],
}

pub fn format_edit_success(args: FormatEditArgs<'_>) -> String {
    let header = format!("<path>{}</path>", args.path);
    let mode = if args.replace_all { " (replace_all)" } else { "" };
    let noun = if args.replacements == 1 {
        "replacement"
    } else {
        "replacements"
    };
    let mut lines = vec![format!(
        "Edited {}: {} {}{} ({})",
        args.path,
        args.replacements,
        noun,
        mode,
        delta_str(args.bytes_before, args.bytes_after)
    )];
    for w in args.warnings {
        lines.push(format!("Warning: {}", w));
    }
    format!("{}\n<result>\n{}\n</result>", header, lines.join("\n"))
}

pub struct FormatMultiEditArgs<'a> {
    pub path: &'a str,
    pub edits_applied: usize,
    pub total_replacements: usize,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub warnings: &'a [String],
}

pub fn format_multi_edit_success(args: FormatMultiEditArgs<'_>) -> String {
    let header = format!("<path>{}</path>", args.path);
    let mut lines = vec![format!(
        "MultiEdit {}: {} edits applied, {} total replacements ({})",
        args.path,
        args.edits_applied,
        args.total_replacements,
        delta_str(args.bytes_before, args.bytes_after)
    )];
    for w in args.warnings {
        lines.push(format!("Warning: {}", w));
    }
    format!("{}\n<result>\n{}\n</result>", header, lines.join("\n"))
}

pub struct FormatPreviewArgs<'a> {
    pub path: &'a str,
    pub diff: &'a str,
    pub would_write_bytes: u64,
    pub bytes_before: u64,
}

pub fn format_preview(args: FormatPreviewArgs<'_>) -> String {
    let header = format!("<path>{}</path>", args.path);
    format!(
        "{}\n<preview>\n{}</preview>\n(would write {} bytes, {}; no changes applied)",
        header,
        args.diff,
        args.would_write_bytes,
        delta_str(args.bytes_before, args.would_write_bytes)
    )
}

pub fn format_match_locations(matches: &[MatchLocation]) -> String {
    if matches.is_empty() {
        return String::new();
    }
    matches
        .iter()
        .map(|m| {
            let mut parts = vec![format!("Line {}:", m.line)];
            if !m.context_before.is_empty() {
                parts.push(
                    m.context_before
                        .iter()
                        .map(|l| format!("  {}", l))
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
            }
            parts.push(
                m.preview
                    .split('\n')
                    .map(|l| format!("> {}", l))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            if !m.context_after.is_empty() {
                parts.push(
                    m.context_after
                        .iter()
                        .map(|l| format!("  {}", l))
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
            }
            parts.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn format_fuzzy_candidates(candidates: &[FuzzyCandidate]) -> String {
    if candidates.is_empty() {
        return String::new();
    }
    candidates
        .iter()
        .map(|c| {
            let mut parts = vec![format!(
                "Candidate at line {} (similarity {:.2}):",
                c.line, c.score
            )];
            if !c.context_before.is_empty() {
                parts.push(
                    c.context_before
                        .iter()
                        .map(|l| format!("  {}", l))
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
            }
            parts.push(
                c.preview
                    .split('\n')
                    .map(|l| format!("> {}", l))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            if !c.context_after.is_empty() {
                parts.push(
                    c.context_after
                        .iter()
                        .map(|l| format!("  {}", l))
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
            }
            parts.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn delta_str(before: u64, after: u64) -> String {
    let b = before as i64;
    let a = after as i64;
    let delta = a - b;
    if delta == 0 {
        return "no byte change".to_string();
    }
    if delta > 0 {
        format!("+{} bytes", delta)
    } else {
        format!("{} bytes", delta)
    }
}
