//! Query-aware snippet selection for engines that return long page excerpts
//! (Exa highlights, Parallel excerpts). Mirrors the TS `engines/passage.ts`;
//! both languages must pick the same passage for the same input.
//!
//! The formatter trims every snippet from its start, so a raw excerpt that
//! opens with page chrome ("Keyboard shortcuts", "Toggle navigation") would
//! reach the model as junk. Instead: split the excerpt into lines, drop chrome
//! (very short lines, `...` separators, the page title repeated), pick the
//! line that contains the most distinct query terms (a substantial line beats
//! a short one on a tie, then the earliest wins), and extend it with the
//! following lines up to MAX_SNIPPET_CAP characters. With no query-term hit
//! anywhere, the first substantial line is used.
//!
//! This selects a passage inside ONE result; it does not rescore or reorder
//! results (WS-D19 still rejects home-grown lexical reranking).

use crate::constants::MAX_SNIPPET_CAP;

/// Lines shorter than this (in chars) are treated as navigation chrome.
const MIN_LINE_CHARS: usize = 20;
/// Lines at least this long count as substantial content (tie-breaker).
const SUBSTANTIAL_LINE_CHARS: usize = 40;

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "from", "how",
    "in", "is", "it", "of", "on", "or", "the", "to", "vs", "what", "when", "where", "which", "who",
    "why", "with",
];

pub(crate) fn query_terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in query.split(|c: char| !c.is_alphanumeric()) {
        let t = raw.to_lowercase();
        if t.chars().count() < 2 || STOPWORDS.contains(&t.as_str()) || out.contains(&t) {
            continue;
        }
        out.push(t);
    }
    out
}

fn clean_line(line: &str) -> &str {
    line.trim()
        .trim_start_matches('#')
        .trim_start_matches(['*', '-', '•'])
        .trim()
}

/// Pick the most query-relevant passage from `text`, at most MAX_SNIPPET_CAP
/// characters, whitespace-collapsed. `title` lines are skipped as chrome.
pub(crate) fn select_passage(text: &str, query: &str, title: &str) -> String {
    let title_lc = title.trim().to_lowercase();
    let lines: Vec<&str> = text
        .lines()
        .map(clean_line)
        .filter(|l| {
            l.chars().count() >= MIN_LINE_CHARS && *l != "..." && l.to_lowercase() != title_lc
        })
        .collect();
    if lines.is_empty() {
        return truncate_chars(&collapse_ws(text), MAX_SNIPPET_CAP);
    }

    // Rank lines by (distinct query terms, is-substantial); the earliest line
    // wins a full tie. A short chrome line that happens to contain a term
    // ("Skip to main content ## async") loses to a content line with the same
    // count, and with no term hit anywhere the first substantial line wins.
    let terms = query_terms(query);
    let mut best = 0usize;
    let mut best_key = 0usize;
    for (i, line) in lines.iter().enumerate() {
        let lc = line.to_lowercase();
        let hits = terms.iter().filter(|t| lc.contains(t.as_str())).count();
        let key = hits * 2 + usize::from(line.chars().count() >= SUBSTANTIAL_LINE_CHARS);
        if key > best_key {
            best = i;
            best_key = key;
        }
    }

    let mut out = String::new();
    for line in &lines[best..] {
        if out.chars().count() >= MAX_SNIPPET_CAP {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(line);
    }
    truncate_chars(&collapse_ws(&out), MAX_SNIPPET_CAP)
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((idx, _)) => s[..idx].to_string(),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_drop_stopwords_short_tokens_and_duplicates() {
        assert_eq!(
            query_terms("What is the Rust async runtime? rust"),
            vec!["rust", "async", "runtime"]
        );
    }

    #[test]
    fn skips_chrome_and_picks_the_matching_line() {
        let text = "Keyboard shortcuts\nPress ← or → to navigate between chapters\nToggle sidebar\nSome unrelated intro paragraph about the book itself.\nTokio is an async runtime for Rust with a work-stealing scheduler.";
        let s = select_passage(text, "rust async runtime", "The Book");
        assert!(s.starts_with("Tokio is an async runtime"), "{s}");
    }

    #[test]
    fn extends_with_following_lines_and_caps_length() {
        let long = "x".repeat(700);
        let text = format!("rust async runtime basics here\n{long}");
        let s = select_passage(&text, "rust async", "");
        assert!(s.starts_with("rust async runtime basics here x"));
        assert_eq!(s.chars().count(), MAX_SNIPPET_CAP);
    }

    #[test]
    fn repeated_title_is_not_the_snippet() {
        let text = "Tokio - An asynchronous Rust runtime\n...\nTokio is an asynchronous runtime for the Rust programming language.";
        let s = select_passage(text, "rust runtime", "Tokio - An asynchronous Rust runtime");
        assert!(s.starts_with("Tokio is an asynchronous runtime"), "{s}");
    }

    #[test]
    fn short_chrome_line_loses_a_tie_to_content() {
        let text = "Skip to main content ## async\nReturns a Future instead of blocking the current thread when used with async.";
        let s = select_passage(text, "rust async runtime", "async - Rust");
        assert!(s.starts_with("Returns a Future"), "{s}");
    }

    #[test]
    fn no_term_hit_falls_back_to_first_substantial_line() {
        let text = "Short nav line here\nThis is the first line that is long enough to be content.";
        let s = select_passage(text, "zzzz", "");
        assert!(s.starts_with("This is the first line"), "{s}");
    }
}
