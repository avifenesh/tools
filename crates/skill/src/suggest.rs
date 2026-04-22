use std::collections::HashSet;

use crate::constants::{FUZZY_SIBLING_LIMIT, FUZZY_SIBLING_THRESHOLD};

/// Return the top-N installed skill names most similar to a missing name.
/// Matches the TS `suggestSkillSiblings` heuristic: char-bigram overlap
/// with a prefix-overlap bonus.
pub fn suggest_skill_siblings(missing: &str, installed: &[String]) -> Vec<String> {
    let mut scored: Vec<(&String, f64)> = installed
        .iter()
        .filter(|n| n.as_str() != missing)
        .map(|n| (n, similarity(missing, n)))
        .filter(|(_, s)| *s >= FUZZY_SIBLING_THRESHOLD)
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored
        .into_iter()
        .take(FUZZY_SIBLING_LIMIT)
        .map(|(n, _)| n.clone())
        .collect()
}

fn similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a.contains(b) || b.contains(a) {
        return 0.9;
    }
    // Prefix overlap.
    let mut prefix = 0usize;
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let min = a_chars.len().min(b_chars.len());
    while prefix < min && a_chars[prefix] == b_chars[prefix] {
        prefix += 1;
    }
    if prefix >= 3 {
        return 0.7 + (prefix as f64) / 100.0;
    }
    // Bigram overlap.
    let a_bi = bigrams(a);
    let b_bi = bigrams(b);
    if a_bi.is_empty() || b_bi.is_empty() {
        return 0.0;
    }
    let hits = a_bi.iter().filter(|bg| b_bi.contains(*bg)).count();
    (2.0 * hits as f64) / ((a_bi.len() + b_bi.len()) as f64)
}

fn bigrams(s: &str) -> HashSet<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out = HashSet::new();
    for w in chars.windows(2) {
        out.insert(w.iter().collect::<String>());
    }
    out
}
