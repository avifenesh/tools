//! Shared HTTP GET used by the keyless + keyed default engines. Centralizes
//! the SSRF check, the reqwest call with the input's headers/timeout, reading
//! the body as text, and non-2xx → SearchError mapping — mirroring the TS
//! `engines/http.ts` helper so both languages behave identically.

use std::time::Instant;
use url::Url;

use crate::engine::{
    classify_reqwest_error, SearchError, SearchErrorCode, WebSearchEngineInput,
};

pub(crate) struct HttpGetResult {
    #[allow(dead_code)]
    pub status: u16,
    #[allow(dead_code)]
    pub content_type: String,
    pub text: String,
    pub host: String,
    pub elapsed_ms: u64,
}

/// GET `url` with the engine's headers + an extra header list, after running
/// the SSRF host check. `accept` overrides the Accept header; `extra_headers`
/// carries engine-specific auth (e.g. Brave's token).
pub(crate) async fn http_get(
    client: &reqwest::Client,
    url: &Url,
    input: &WebSearchEngineInput,
    accept: &str,
    engine: &str,
    extra_headers: &[(&str, String)],
) -> Result<HttpGetResult, SearchError> {
    let host = url.host_str().unwrap_or("").to_string();
    (input.check_host)(host.clone())
        .await
        .map_err(|msg| SearchError::new(SearchErrorCode::SsrfBlocked, msg))?;

    let started = Instant::now();
    let mut req = client
        .request(reqwest::Method::GET, url.clone())
        .timeout(std::time::Duration::from_millis(input.timeout_ms));
    for (k, v) in &input.headers {
        // Engine-specific Accept wins, so skip a session accept here.
        if k.eq_ignore_ascii_case("accept") {
            continue;
        }
        req = req.header(k, v);
    }
    req = req.header("accept", accept);
    for (k, v) in extra_headers {
        req = req.header(*k, v);
    }

    let res = req.send().await.map_err(classify_reqwest_error)?;
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if status >= 400 {
        if status >= 500 || status == 429 {
            return Err(SearchError::new(
                SearchErrorCode::ServerNotAvailable,
                format!("{} returned HTTP {}", engine, status),
            ));
        }
        return Err(SearchError::new(
            SearchErrorCode::InvalidParam,
            format!("{} rejected the query with HTTP {}", engine, status),
        ));
    }

    let bytes = res.bytes().await.map_err(classify_reqwest_error)?;
    let text = String::from_utf8_lossy(&bytes).into_owned();

    Ok(HttpGetResult {
        status,
        content_type,
        text,
        host,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}
