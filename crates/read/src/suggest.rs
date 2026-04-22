use std::path::Path;

use crate::constants::FUZZY_SUGGESTION_LIMIT;

pub async fn suggest_siblings(missing_path: &Path) -> Vec<String> {
    let dir = match missing_path.parent() {
        Some(d) => d,
        None => return Vec::new(),
    };
    let base_os = missing_path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let base = base_os.to_ascii_lowercase();

    let mut read_dir = match tokio::fs::read_dir(dir).await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let mut scored: Vec<(String, i32)> = Vec::new();
    loop {
        let entry = match read_dir.next_entry().await {
            Ok(Some(e)) => e,
            _ => break,
        };
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let lower = name.to_ascii_lowercase();
        let score = similarity(&base, &lower);
        if score > 0 {
            let full = dir.join(&name).to_string_lossy().into_owned();
            scored.push((full, score));
        }
    }
    scored.sort_by(|a, b| b.1.cmp(&a.1));
    scored
        .into_iter()
        .take(FUZZY_SUGGESTION_LIMIT)
        .map(|(p, _)| p)
        .collect()
}

fn similarity(a: &str, b: &str) -> i32 {
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
        return 200 + prefix as i32;
    }
    if prefix >= 2 && (a.len() as i64 - b.len() as i64).abs() <= 2 {
        return 100 + prefix as i32;
    }
    if ext_of(a) == ext_of(b) && !ext_of(a).is_empty() {
        return 10;
    }
    0
}

fn common_prefix(a: &str, b: &str) -> usize {
    let mut a_iter = a.chars();
    let mut b_iter = b.chars();
    let mut n = 0usize;
    loop {
        match (a_iter.next(), b_iter.next()) {
            (Some(x), Some(y)) if x == y => n += 1,
            _ => break,
        }
    }
    n
}

fn ext_of(name: &str) -> &str {
    match name.rfind('.') {
        Some(i) if i > 0 => &name[i..],
        _ => "",
    }
}
