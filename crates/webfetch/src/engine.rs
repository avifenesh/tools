use async_trait::async_trait;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use url::Url;

pub struct WebFetchEngineInput {
    pub url: String,
    pub method: String,
    pub body: Option<String>,
    pub headers: HashMap<String, String>,
    pub timeout_ms: u64,
    pub max_redirects: u32,
    pub max_body_bytes: usize,
    /// Called BEFORE each hop (including the first) with the target host.
    /// Returning Err aborts the fetch with INVALID_URL-shaped FetchError.
    pub check_host: HostCheckFn,
}

pub type HostCheckFn = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>
        + Send
        + Sync,
>;

pub struct WebFetchEngineResult {
    pub status: u16,
    pub final_url: String,
    pub redirect_chain: Vec<String>,
    pub content_type: String,
    pub body: Vec<u8>,
    pub body_truncated: bool,
}

#[async_trait]
pub trait WebFetchEngine: Send + Sync {
    async fn fetch(
        &self,
        input: WebFetchEngineInput,
    ) -> Result<WebFetchEngineResult, FetchError>;
}

#[derive(Debug, Clone)]
pub enum FetchErrorCode {
    InvalidUrl,
    TlsError,
    RedirectLoop,
    DnsError,
    Timeout,
    ConnectionReset,
    IoError,
}

#[derive(Debug, Clone)]
pub struct FetchError {
    pub code: FetchErrorCode,
    pub message: String,
    pub chain: Option<Vec<String>>,
}

impl FetchError {
    pub fn new(code: FetchErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            chain: None,
        }
    }
}

pub struct ReqwestEngine {
    client: reqwest::Client,
}

impl ReqwestEngine {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client build");
        Self { client }
    }
}

impl Default for ReqwestEngine {
    fn default() -> Self {
        Self::new()
    }
}

pub fn default_engine() -> Arc<dyn WebFetchEngine> {
    Arc::new(ReqwestEngine::new())
}

#[async_trait]
impl WebFetchEngine for ReqwestEngine {
    async fn fetch(
        &self,
        input: WebFetchEngineInput,
    ) -> Result<WebFetchEngineResult, FetchError> {
        let mut current_url = input.url.clone();
        let mut chain: Vec<String> = Vec::new();
        let mut hops: u32 = 0;

        loop {
            let parsed = Url::parse(&current_url).map_err(|_| {
                FetchError::new(
                    FetchErrorCode::InvalidUrl,
                    format!("Invalid URL: {}", current_url),
                )
            })?;
            let host = parsed.host_str().unwrap_or("").to_string();

            // SSRF check before every hop
            (input.check_host)(host.clone())
                .await
                .map_err(|msg| FetchError::new(FetchErrorCode::InvalidUrl, msg))?;

            let method = match input.method.as_str() {
                "GET" => reqwest::Method::GET,
                "POST" => reqwest::Method::POST,
                other => {
                    return Err(FetchError::new(
                        FetchErrorCode::InvalidUrl,
                        format!("unsupported method: {}", other),
                    ));
                }
            };

            let mut req = self
                .client
                .request(method, &current_url)
                .timeout(Duration::from_millis(input.timeout_ms));
            for (k, v) in &input.headers {
                req = req.header(k, v);
            }
            if let Some(body) = &input.body {
                // Only send body on the very first hop (don't replay on
                // redirects). reqwest drops bodies on 303 anyway, but we
                // simulate the stateless safe default: no body after first hop.
                if hops == 0 {
                    req = req.body(body.clone());
                }
            }

            let res = req.send().await.map_err(classify_reqwest_error)?;
            let status = res.status().as_u16();

            // Redirect handling
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                let loc = res
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());
                let next_url = match loc {
                    Some(loc) => match Url::parse(&loc) {
                        Ok(abs) => abs.to_string(),
                        Err(_) => {
                            // Try resolving relative to the current URL.
                            match parsed.join(&loc) {
                                Ok(resolved) => resolved.to_string(),
                                Err(_) => {
                                    // No Location — treat as terminal.
                                    return finalize(
                                        res,
                                        &input.url,
                                        &current_url,
                                        chain,
                                        input.max_body_bytes,
                                    )
                                    .await;
                                }
                            }
                        }
                    },
                    None => {
                        return finalize(
                            res,
                            &input.url,
                            &current_url,
                            chain,
                            input.max_body_bytes,
                        )
                        .await;
                    }
                };

                // Block https→http downgrade
                if current_url.starts_with("https://") && next_url.starts_with("http://") {
                    return Err(FetchError::new(
                        FetchErrorCode::TlsError,
                        format!(
                            "Refusing HTTPS→HTTP downgrade redirect: {} -> {}",
                            current_url, next_url
                        ),
                    ));
                }

                chain.push(current_url.clone());
                hops += 1;
                if hops > input.max_redirects {
                    let mut full_chain = chain.clone();
                    full_chain.push(next_url);
                    return Err(FetchError {
                        code: FetchErrorCode::RedirectLoop,
                        message: format!(
                            "Redirect limit ({}) exceeded",
                            input.max_redirects
                        ),
                        chain: Some(full_chain),
                    });
                }
                current_url = next_url;
                continue;
            }

            // Terminal response
            return finalize(res, &input.url, &current_url, chain, input.max_body_bytes)
                .await;
        }
    }
}

async fn finalize(
    res: reqwest::Response,
    _original: &str,
    final_url: &str,
    chain: Vec<String>,
    max_body_bytes: usize,
) -> Result<WebFetchEngineResult, FetchError> {
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Collect full body then cap. reqwest doesn't expose a streaming
    // reader without `futures-util`. For v1 parity we accept the
    // download-then-truncate trade-off — the 10 MB spill_hard_cap still
    // bounds the orchestrator's downstream work.
    let raw = res.bytes().await.map_err(classify_reqwest_error)?;
    let truncated = raw.len() > max_body_bytes;
    let body: Vec<u8> = if truncated {
        raw[..max_body_bytes].to_vec()
    } else {
        raw.to_vec()
    };
    let mut final_chain = chain;
    final_chain.push(final_url.to_string());
    Ok(WebFetchEngineResult {
        status,
        final_url: final_url.to_string(),
        redirect_chain: final_chain,
        content_type,
        body,
        body_truncated: truncated,
    })
}

fn classify_reqwest_error(e: reqwest::Error) -> FetchError {
    let msg = e.to_string();
    if e.is_timeout() {
        return FetchError::new(FetchErrorCode::Timeout, msg);
    }
    if e.is_connect() {
        // DNS errors surface as connect errors; try to tell them apart
        // via the message (reqwest doesn't give us a typed signal).
        let lower = msg.to_lowercase();
        if lower.contains("dns")
            || lower.contains("resolve")
            || lower.contains("lookup")
            || lower.contains("not known")
            || lower.contains("no such host")
        {
            return FetchError::new(FetchErrorCode::DnsError, msg);
        }
        return FetchError::new(FetchErrorCode::ConnectionReset, msg);
    }
    let lower = msg.to_lowercase();
    if lower.contains("tls") || lower.contains("certificate") || lower.contains("ssl") {
        return FetchError::new(FetchErrorCode::TlsError, msg);
    }
    FetchError::new(FetchErrorCode::IoError, msg)
}

