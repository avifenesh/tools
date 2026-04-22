use crate::constants::FUZZY_SUGGESTION_LIMIT;
use std::path::Path;

/// Return up to [`FUZZY_SUGGESTION_LIMIT`] entries in the parent
/// directory of `missing_path` that look like its basename, sorted
/// most-similar first. Same algorithm as the TS `suggestSiblings`.
pub fn suggest_siblings(missing_path: &str) -> Vec<String> {
    let p = Path::new(missing_path);
    let parent = match p.parent() {
        Some(pp) => pp,
        None => return Vec::new(),
    };
    let base = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();
    let entries = match std::fs::read_dir(parent) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut scored: Vec<(i64, String)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            e.file_name()
                .to_str()
                .map(|n| n.to_string())
        })
        .filter_map(|name| {
            let s = similarity(&base, &name.to_lowercase());
            if s > 0 {
                Some((s, parent.join(&name).to_string_lossy().into_owned()))
            } else {
                None
            }
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(FUZZY_SUGGESTION_LIMIT)
        .map(|(_, p)| p)
        .collect()
}

fn similarity(a: &str, b: &str) -> i64 {
    if a == b {
        return 1000;
    }
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    if a.contains(b) || b.contains(a) {
        return 500;
    }
    let prefix = common_prefix(a, b);
    if prefix >= 3 {
        return 200 + prefix as i64;
    }
    let a_len = a.len() as i64;
    let b_len = b.len() as i64;
    if prefix >= 2 && (a_len - b_len).abs() <= 2 {
        return 100 + prefix as i64;
    }
    let a_ext = ext_of(a);
    let b_ext = ext_of(b);
    if !a_ext.is_empty() && a_ext == b_ext {
        return 10;
    }
    0
}

fn common_prefix(a: &str, b: &str) -> usize {
    a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count()
}

fn ext_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 => &name[i..],
        _ => "",
    }
}
