use harness_core::{ToolError, ToolErrorCode};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;

use crate::constants::{
    CACHE_TTL_MS, DEFAULT_MAX_REDIRECTS, DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT,
    INLINE_MARKDOWN_CAP, INLINE_RAW_CAP, MANAGED_HEADERS, SESSION_BACKSTOP_MS,
    SPILL_HARD_CAP, SPILL_HEAD_BYTES, SPILL_TAIL_BYTES, TEXT_PASSTHROUGH_TYPES,
};
use crate::engine::{
    FetchError, FetchErrorCode, WebFetchEngineInput,
};
use crate::extractor::{extract_markdown, is_html_like, parse_content_type_base};
use crate::fence::{ask_permission, permission_denied_error, AskArgs, PermissionOutcome};
use crate::format::{
    format_http_error_text, format_ok_text, head_and_tail, spill_to_file, FormatHttpErrorArgs,
    FormatOkArgs, SpillArgs,
};
use crate::schema::safe_parse_webfetch_params;
use crate::ssrf::{classify_host, SsrfDecision};
use crate::types::{
    CachedResponse, FetchMetadata, WebFetchError, WebFetchExtract, WebFetchHttpError,
    WebFetchMethod, WebFetchOk, WebFetchResult, WebFetchSessionConfig,
};

fn err(error: ToolError) -> WebFetchResult {
    WebFetchResult::Error(WebFetchError { error })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cache_key(
    method: WebFetchMethod,
    url: &str,
    body: Option<&str>,
    headers: &HashMap<String, String>,
    extract: WebFetchExtract,
) -> String {
    let mut h = Sha256::new();
    h.update(method.as_str().as_bytes());
    h.update(b"\0");
    h.update(url.as_bytes());
    h.update(b"\0");
    h.update(body.unwrap_or("").as_bytes());
    h.update(b"\0");
    let mut sorted: Vec<(String, String)> = headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
        .collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let json = serde_json::to_string(&sorted).unwrap_or_default();
    h.update(json.as_bytes());
    h.update(b"\0");
    h.update(extract.as_str().as_bytes());
    let digest = h.finalize();
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn normalize_headers(
    session: &WebFetchSessionConfig,
    user: &Option<HashMap<String, String>>,
) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    if let Some(defaults) = &session.default_headers {
        for (k, v) in defaults {
            out.insert(k.to_ascii_lowercase(), v.clone());
        }
    }
    if !out.contains_key("user-agent") {
        out.insert("user-agent".to_string(), DEFAULT_USER_AGENT.to_string());
    }
    if let Some(user) = user {
        for (k, v) in user {
            let lower = k.to_ascii_lowercase();
            if MANAGED_HEADERS.contains(&lower.as_str()) {
                continue;
            }
            out.insert(lower, v.clone());
        }
    }
    out
}

pub async fn webfetch_run(input: Value, session: &WebFetchSessionConfig) -> WebFetchResult {
    let params = match safe_parse_webfetch_params(&input) {
        Ok(p) => p,
        Err(e) => return err(ToolError::new(ToolErrorCode::InvalidParam, e.to_string())),
    };

    let method: WebFetchMethod = params.method.unwrap_or(WebFetchMethod::Get);
    if method == WebFetchMethod::Post && params.body.is_none() {
        return err(ToolError::new(
            ToolErrorCode::InvalidParam,
            "POST requires 'body'.",
        ));
    }
    if method == WebFetchMethod::Get && params.body.is_some() {
        return err(ToolError::new(
            ToolErrorCode::InvalidParam,
            "GET does not accept 'body'; use POST or move the payload into the query string.",
        ));
    }

    let parsed_url = match Url::parse(&params.url) {
        Ok(u) => u,
        Err(_) => {
            return err(ToolError::new(
                ToolErrorCode::InvalidUrl,
                format!("Invalid URL: {}", params.url),
            ));
        }
    };
    let scheme = parsed_url.scheme();
    if scheme != "http" && scheme != "https" {
        return err(ToolError::new(
            ToolErrorCode::InvalidUrl,
            format!("only http(s) schemes are supported; received '{}:'", scheme),
        )
        .with_meta(serde_json::json!({ "url": params.url })));
    }
    let host = parsed_url.host_str().unwrap_or("").to_string();

    let extract = params.extract.unwrap_or(WebFetchExtract::Markdown);
    let timeout_ms = params
        .timeout_ms
        .or(session.default_timeout_ms)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    let session_backstop = session.session_backstop_ms.unwrap_or(SESSION_BACKSTOP_MS);
    let effective_timeout = timeout_ms.min(session_backstop);
    let max_redirects = params
        .max_redirects
        .or(session.max_redirects)
        .unwrap_or(DEFAULT_MAX_REDIRECTS);

    let headers = normalize_headers(session, &params.headers);

    // Initial SSRF check
    match classify_host(&host, session).await {
        SsrfDecision::Allowed => {}
        SsrfDecision::Blocked { reason, hint } => {
            return err(ToolError::new(
                ToolErrorCode::SsrfBlocked,
                format!("{}\nURL: {}\nHint: {}", reason, params.url, hint),
            )
            .with_meta(serde_json::json!({ "url": params.url, "host": host })));
        }
    }

    // Permission hook
    let ask_args = AskArgs {
        method,
        url: &params.url,
        host: &host,
        body_bytes: params.body.as_ref().map(|b| b.len()).unwrap_or(0),
        header_keys: headers.keys().cloned().collect(),
        extract: extract.as_str(),
        timeout_ms: effective_timeout,
        max_redirects,
    };
    match ask_permission(session, ask_args).await {
        PermissionOutcome::Allow => {}
        PermissionOutcome::Deny { reason } => {
            return err(permission_denied_error(&params.url, &reason));
        }
    }

    // Session cache
    let key = cache_key(method, &params.url, params.body.as_deref(), &headers, extract);
    let cache_ttl = session.cache_ttl_ms.unwrap_or(CACHE_TTL_MS);
    if let Some(cache) = &session.cache {
        let hit = {
            let guard = cache.lock().unwrap();
            guard.get(&key).cloned()
        };
        if let Some(hit) = hit {
            if now_ms().saturating_sub(hit.at_ms) <= cache_ttl {
                return format_cached_hit(hit, extract, &params.url, method);
            }
        }
    }

    let spill_hard_cap = session.spill_hard_cap.unwrap_or(SPILL_HARD_CAP);
    let inline_markdown_cap = session.inline_markdown_cap.unwrap_or(INLINE_MARKDOWN_CAP);
    let inline_raw_cap = session.inline_raw_cap.unwrap_or(INLINE_RAW_CAP);
    let spill_dir_root = session
        .spill_dir
        .clone()
        .unwrap_or_else(|| {
            std::env::temp_dir()
                .join("agent-sh-webfetch-cache")
                .to_string_lossy()
                .into_owned()
        });
    let session_id = session
        .session_id
        .clone()
        .unwrap_or_else(|| "default".to_string());

    // Build the per-hop host check closure.
    let session_for_check = session.clone();
    let check_host: crate::engine::HostCheckFn = Arc::new(move |h: String| {
        let s = session_for_check.clone();
        Box::pin(async move {
            match classify_host(&h, &s).await {
                SsrfDecision::Allowed => Ok(()),
                SsrfDecision::Blocked { reason, hint } => {
                    Err(format!("{}. Hint: {}", reason, hint))
                }
            }
        })
    });

    let engine_input = WebFetchEngineInput {
        url: params.url.clone(),
        method: method.as_str().to_string(),
        body: params.body.clone(),
        headers: headers.clone(),
        timeout_ms: effective_timeout,
        max_redirects,
        max_body_bytes: spill_hard_cap,
        check_host,
    };

    let started = Instant::now();
    let fetch_fut = session.engine.fetch(engine_input);
    let result = match tokio::time::timeout(
        Duration::from_millis(session_backstop),
        fetch_fut,
    )
    .await
    {
        Ok(r) => r,
        Err(_) => {
            return err(ToolError::new(
                ToolErrorCode::Timeout,
                format!("Request timed out (session backstop): {}", params.url),
            )
            .with_meta(serde_json::json!({ "url": params.url })));
        }
    };
    let result = match result {
        Ok(r) => r,
        Err(e) => return err(translate_fetch_error(e, &params.url)),
    };

    let fetched_ms = started.elapsed().as_millis() as u64;

    // Hard size cap
    if result.body_truncated && result.body.len() >= spill_hard_cap {
        return err(ToolError::new(
            ToolErrorCode::Oversize,
            format!(
                "Response exceeded the {} MB hard cap. Use bash(curl -o file.bin <url>) for bulk downloads.",
                spill_hard_cap / 1024 / 1024
            ),
        )
        .with_meta(
            serde_json::json!({ "url": params.url, "bytes": result.body.len() }),
        ));
    }

    let content_type_base = parse_content_type_base(&result.content_type);

    // HTTP error — still include the body.
    if result.status >= 400 {
        let body_text = decode_body(&result.body, inline_raw_cap);
        let meta = FetchMetadata {
            url: params.url.clone(),
            final_url: result.final_url.clone(),
            method,
            status: result.status,
            content_type: result.content_type.clone(),
            redirect_chain: result.redirect_chain.clone(),
            fetched_ms,
            from_cache: false,
            cache_age_sec: None,
        };
        return WebFetchResult::HttpError(WebFetchHttpError {
            output: format_http_error_text(FormatHttpErrorArgs {
                meta: &meta,
                body: &body_text,
            }),
            meta,
            body_raw: body_text,
        });
    }

    // Content-type whitelist
    if !content_type_base.is_empty()
        && !TEXT_PASSTHROUGH_TYPES.contains(&content_type_base.as_str())
    {
        return err(ToolError::new(
            ToolErrorCode::UnsupportedContentType,
            format!(
                "Content-type '{}' is not supported. Use bash(curl -o file <url>) to download binary content.",
                content_type_base
            ),
        )
        .with_meta(serde_json::json!({
            "url": params.url,
            "contentType": result.content_type,
            "bytes": result.body.len(),
        })));
    }

    let raw_text = decode_body(&result.body, inline_raw_cap);
    let mut markdown: Option<String> = None;
    let mut markdown_bytes = 0usize;
    let do_extract_markdown = matches!(extract, WebFetchExtract::Markdown | WebFetchExtract::Both);
    if do_extract_markdown {
        if is_html_like(&content_type_base) {
            let (md, _) = extract_markdown(&raw_text, &result.final_url);
            markdown_bytes = md.as_bytes().len();
            markdown = Some(md);
        } else {
            markdown_bytes = raw_text.as_bytes().len();
            markdown = Some(raw_text.clone());
        }
    }

    let raw_bytes = result.body.len();
    let must_spill_markdown = markdown.is_some() && markdown_bytes > inline_markdown_cap;
    let must_spill_raw = raw_bytes > inline_raw_cap;
    let byte_cap = must_spill_markdown || must_spill_raw;

    let log_path: Option<String> = if byte_cap {
        let path = spill_to_file(SpillArgs {
            bytes: &result.body,
            dir: std::path::Path::new(&spill_dir_root),
            session_id: &session_id,
            content_type: &content_type_base,
        })
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
        if let (Some(md), Some(p)) = (markdown.as_ref(), path.as_ref()) {
            if must_spill_markdown {
                let new_md = head_and_tail(
                    md.as_bytes(),
                    SPILL_HEAD_BYTES,
                    SPILL_TAIL_BYTES,
                    p,
                );
                markdown = Some(new_md);
            }
        }
        path
    } else {
        None
    };

    let meta = FetchMetadata {
        url: params.url.clone(),
        final_url: result.final_url.clone(),
        method,
        status: result.status,
        content_type: result.content_type.clone(),
        redirect_chain: result.redirect_chain.clone(),
        fetched_ms,
        from_cache: false,
        cache_age_sec: None,
    };

    // Persist to cache
    if let Some(cache) = &session.cache {
        let entry = CachedResponse {
            at_ms: now_ms(),
            status: result.status,
            final_url: result.final_url.clone(),
            redirect_chain: result.redirect_chain.clone(),
            content_type: result.content_type.clone(),
            body: result.body.clone(),
            extract,
            extracted_markdown: markdown.clone(),
        };
        cache.lock().unwrap().insert(key, entry);
    }

    let raw_for_output = if matches!(extract, WebFetchExtract::Raw | WebFetchExtract::Both) {
        Some(raw_text.clone())
    } else {
        None
    };
    let out_text = format_ok_text(FormatOkArgs {
        meta: &meta,
        extract_hint: extract.as_str(),
        markdown: markdown.as_deref(),
        raw: raw_for_output.as_deref(),
        log_path: log_path.as_deref(),
        byte_cap,
        total_bytes: raw_bytes,
    });

    WebFetchResult::Ok(WebFetchOk {
        output: out_text,
        meta,
        body_markdown: markdown,
        body_raw: raw_for_output,
        log_path,
        byte_cap,
    })
}

fn decode_body(bytes: &[u8], cap: usize) -> String {
    let slice = if bytes.len() > cap { &bytes[..cap] } else { bytes };
    String::from_utf8_lossy(slice).into_owned()
}

fn format_cached_hit(
    hit: CachedResponse,
    extract: WebFetchExtract,
    url: &str,
    method: WebFetchMethod,
) -> WebFetchResult {
    let age_sec = (now_ms().saturating_sub(hit.at_ms) / 1000) as u64;
    let meta = FetchMetadata {
        url: url.to_string(),
        final_url: hit.final_url.clone(),
        method,
        status: hit.status,
        content_type: hit.content_type.clone(),
        redirect_chain: hit.redirect_chain.clone(),
        fetched_ms: 0,
        from_cache: true,
        cache_age_sec: Some(age_sec),
    };
    if hit.status >= 400 {
        let body = String::from_utf8_lossy(&hit.body).into_owned();
        return WebFetchResult::HttpError(WebFetchHttpError {
            output: format_http_error_text(FormatHttpErrorArgs {
                meta: &meta,
                body: &body,
            }),
            meta,
            body_raw: body,
        });
    }
    let raw_text = String::from_utf8_lossy(&hit.body).into_owned();
    let markdown = hit.extracted_markdown.clone().unwrap_or_else(|| raw_text.clone());
    let raw_for_output = if matches!(extract, WebFetchExtract::Raw | WebFetchExtract::Both) {
        Some(raw_text.clone())
    } else {
        None
    };
    let out_text = format_ok_text(FormatOkArgs {
        meta: &meta,
        extract_hint: extract.as_str(),
        markdown: Some(&markdown),
        raw: raw_for_output.as_deref(),
        log_path: None,
        byte_cap: false,
        total_bytes: hit.body.len(),
    });
    WebFetchResult::Ok(WebFetchOk {
        output: out_text,
        meta,
        body_markdown: Some(markdown),
        body_raw: raw_for_output,
        log_path: None,
        byte_cap: false,
    })
}

fn translate_fetch_error(e: FetchError, url: &str) -> ToolError {
    let code = match e.code {
        FetchErrorCode::InvalidUrl => ToolErrorCode::SsrfBlocked, // host-check rejections surface as SSRF
        FetchErrorCode::TlsError => ToolErrorCode::TlsError,
        FetchErrorCode::RedirectLoop => ToolErrorCode::RedirectLoop,
        FetchErrorCode::DnsError => ToolErrorCode::DnsError,
        FetchErrorCode::Timeout => ToolErrorCode::Timeout,
        FetchErrorCode::ConnectionReset => ToolErrorCode::ConnectionReset,
        FetchErrorCode::IoError => ToolErrorCode::IoError,
    };
    let mut meta = serde_json::json!({ "url": url });
    if let Some(chain) = &e.chain {
        meta["chain"] = serde_json::json!(chain);
    }
    ToolError::new(code, format!("{}", e.message)).with_meta(meta)
}
