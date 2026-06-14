//! URL normalization for cross-engine result de-duplication. Mirrors the TS
//! `engines/dedupe.ts`: when the fallback chain merges results from several
//! backends the same page often appears in more than one, so we key dedup on
//! a normalized form. The ORIGINAL url is always kept in output — normalization
//! is for the dedup key only.

use url::Url;

const TRACKING_PARAMS: &[&str] = &[
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "gclid",
    "fbclid",
    "mc_cid",
    "mc_eid",
    "ref",
    "ref_src",
    "ref_url",
    "spm",
    "igshid",
];

/// Normalize a URL for dedup keying: lowercase scheme+host, drop a leading
/// "www.", drop default ports, strip the fragment, strip tracking query params,
/// sort the rest, trim a trailing slash. Conservative — meaningful params
/// (?id=, ?curid=, ?q=) are kept. Falls back to a trimmed lowercase string for
/// unparseable input.
pub(crate) fn normalize_url_for_dedup(raw: &str) -> String {
    let parsed = Url::parse(raw);
    let u = match parsed {
        Ok(u) => u,
        Err(_) => return raw.trim().to_lowercase(),
    };

    let scheme = u.scheme().to_lowercase();
    let mut host = u.host_str().unwrap_or("").to_lowercase();
    if let Some(stripped) = host.strip_prefix("www.") {
        host = stripped.to_string();
    }

    // Drop default ports.
    let port = match (u.port(), scheme.as_str()) {
        (Some(80), "http") => None,
        (Some(443), "https") => None,
        (p, _) => p,
    };

    // Strip tracking params, keep the rest, sort for stable comparison.
    let mut params: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| !TRACKING_PARAMS.contains(&k.to_lowercase().as_str()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    params.sort();
    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&");

    // Trim a trailing slash on the path (keep root as empty).
    let mut path = u.path().to_string();
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    if path == "/" {
        path = String::new();
    }

    let port_part = port.map(|p| format!(":{}", p)).unwrap_or_default();
    let query_part = if query.is_empty() {
        String::new()
    } else {
        format!("?{}", query)
    };
    format!("{}://{}{}{}{}", scheme, host, port_part, path, query_part)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_www_slash_port_fragment() {
        let a = normalize_url_for_dedup("https://www.tokio.rs/");
        let b = normalize_url_for_dedup("https://tokio.rs");
        let c = normalize_url_for_dedup("https://tokio.rs:443/#section");
        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    #[test]
    fn strips_tracking_keeps_meaningful() {
        assert_eq!(
            normalize_url_for_dedup("https://x.com/p?utm_source=nl&gclid=1&id=42"),
            normalize_url_for_dedup("https://x.com/p?id=42")
        );
    }

    #[test]
    fn sorts_query_params() {
        assert_eq!(
            normalize_url_for_dedup("https://x.com/p?b=2&a=1"),
            normalize_url_for_dedup("https://x.com/p?a=1&b=2")
        );
    }

    #[test]
    fn does_not_collapse_distinct_pages() {
        assert_ne!(
            normalize_url_for_dedup("https://w.org/?curid=1"),
            normalize_url_for_dedup("https://w.org/?curid=2")
        );
    }
}
