use crate::constants::{
    CONTEXT_LINES, DEFAULT_FUZZY_LENGTH_TOLERANCE, DEFAULT_FUZZY_THRESHOLD, DEFAULT_FUZZY_TOP_K,
};
use crate::levenshtein::similarity;
use crate::types::{FuzzyCandidate, MatchLocation};

/// 1-based line of a byte offset in LF-normalized text.
pub fn line_of_offset(text: &str, offset: usize) -> usize {
    if offset == 0 {
        return 1;
    }
    let mut line = 1usize;
    let limit = offset.min(text.len());
    for b in text.as_bytes()[..limit].iter() {
        if *b == b'\n' {
            line += 1;
        }
    }
    line
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    text.split('\n').collect()
}

fn context_around(
    file_lines: &[&str],
    first_line_1based: usize,
    window_line_count: usize,
) -> (Vec<String>, Vec<String>) {
    let first_idx = first_line_1based.saturating_sub(1);
    let last_idx = first_idx + window_line_count.saturating_sub(1);
    let before_start = first_idx.saturating_sub(CONTEXT_LINES);
    let before_end = first_idx;
    let after_start = last_idx + 1;
    let after_end = (last_idx + 1 + CONTEXT_LINES).min(file_lines.len());
    let before = file_lines
        .get(before_start..before_end)
        .unwrap_or(&[])
        .iter()
        .map(|s| s.to_string())
        .collect();
    let after = file_lines
        .get(after_start..after_end)
        .unwrap_or(&[])
        .iter()
        .map(|s| s.to_string())
        .collect();
    (before, after)
}

/// Find all exact occurrences of `needle` in `haystack`. Returns byte offsets.
pub fn find_all_occurrences(haystack: &str, needle: &str) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut from = 0usize;
    let hb = haystack.as_bytes();
    let nb = needle.as_bytes();
    while from + nb.len() <= hb.len() {
        let slice = &hb[from..];
        match find_subslice(slice, nb) {
            Some(rel) => {
                let abs = from + rel;
                out.push(abs);
                from = abs + nb.len();
            }
            None => break,
        }
    }
    out
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

pub fn build_match_locations(
    file: &str,
    needle: &str,
    offsets: &[usize],
) -> Vec<MatchLocation> {
    let file_lines = split_lines(file);
    let needle_line_count = split_lines(needle).len().max(1);
    offsets
        .iter()
        .map(|&off| {
            let first_line = line_of_offset(file, off);
            let (before, after) = context_around(&file_lines, first_line, needle_line_count);
            MatchLocation {
                line: first_line,
                preview: needle.to_string(),
                context_before: before,
                context_after: after,
            }
        })
        .collect()
}

pub struct FuzzyOpts {
    pub top_k: usize,
    pub threshold: f64,
    pub length_tolerance: f64,
}

impl Default for FuzzyOpts {
    fn default() -> Self {
        Self {
            top_k: DEFAULT_FUZZY_TOP_K,
            threshold: DEFAULT_FUZZY_THRESHOLD,
            length_tolerance: DEFAULT_FUZZY_LENGTH_TOLERANCE,
        }
    }
}

pub fn find_fuzzy_candidates(file: &str, needle: &str, opts: FuzzyOpts) -> Vec<FuzzyCandidate> {
    if file.is_empty() || needle.is_empty() {
        return Vec::new();
    }
    let file_lines = split_lines(file);
    let needle_lines = split_lines(needle);
    let window_line_count = needle_lines.len().max(1);
    if file_lines.len() < window_line_count {
        return Vec::new();
    }

    let mut cands: Vec<(usize, f64, String)> = Vec::new();
    for i in 0..=file_lines.len().saturating_sub(window_line_count) {
        let window = file_lines[i..i + window_line_count].join("\n");
        let max_len = window.len().max(needle.len());
        if max_len > 0 {
            let delta =
                (window.len() as f64 - needle.len() as f64).abs() / max_len as f64;
            if delta > opts.length_tolerance {
                continue;
            }
        }
        let score = similarity(&window, needle);
        if score < opts.threshold {
            continue;
        }
        if (score - 1.0).abs() < f64::EPSILON {
            continue;
        }
        cands.push((i + 1, score, window));
    }

    cands.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });

    cands
        .into_iter()
        .take(opts.top_k)
        .map(|(line, score, window_text)| {
            let (before, after) = context_around(&file_lines, line, window_line_count);
            FuzzyCandidate {
                line,
                score: (score * 100.0).round() / 100.0,
                preview: window_text,
                context_before: before,
                context_after: after,
            }
        })
        .collect()
}

/// Boundary-collision check: flag lines where `needle` sits adjacent to
/// identifier characters — caller may be stomping on a longer identifier.
pub fn substring_boundary_collisions(file: &str, needle: &str, offsets: &[usize]) -> Vec<usize> {
    let mut flagged: Vec<usize> = Vec::new();
    let fb = file.as_bytes();
    let nb_len = needle.as_bytes().len();
    for &off in offsets {
        let before = if off > 0 { Some(fb[off - 1]) } else { None };
        let after = fb.get(off + nb_len).copied();
        if is_ident(before) || is_ident(after) {
            flagged.push(line_of_offset(file, off));
        }
    }
    flagged
}

fn is_ident(b: Option<u8>) -> bool {
    match b {
        Some(c) => matches!(c, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_'),
        None => false,
    }
}
