/// Levenshtein distance O(n*m) time, O(min(n,m)) space.
pub fn levenshtein(a: &str, b: &str) -> usize {
    if a == b {
        return 0;
    }
    if a.is_empty() {
        return b.chars().count();
    }
    if b.is_empty() {
        return a.chars().count();
    }
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let (s1, s2) = if a_chars.len() < b_chars.len() {
        (b_chars, a_chars)
    } else {
        (a_chars, b_chars)
    };
    let m = s1.len();
    let n = s2.len();
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr: Vec<usize> = vec![0; n + 1];
    for i in 1..=m {
        curr[0] = i;
        let si = s1[i - 1];
        for j in 1..=n {
            let cost = if si == s2[j - 1] { 0 } else { 1 };
            let del = prev[j] + 1;
            let ins = curr[j - 1] + 1;
            let sub = prev[j - 1] + cost;
            curr[j] = del.min(ins).min(sub);
        }
        prev.copy_from_slice(&curr);
    }
    prev[n]
}

pub fn similarity(a: &str, b: &str) -> f64 {
    let max_len = a.chars().count().max(b.chars().count());
    if max_len == 0 {
        return 1.0;
    }
    1.0 - (levenshtein(a, b) as f64 / max_len as f64)
}
