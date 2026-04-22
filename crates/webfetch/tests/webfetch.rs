//! Integration tests for the Rust webfetch port. Mirrors the critical
//! cases from `packages/webfetch/test/webfetch.test.ts`.

use bytes::Bytes;
use harness_core::{PermissionPolicy, ToolErrorCode};
use harness_webfetch::{
    classify_ip, default_engine, webfetch, BlockClass, WebFetchPermissionPolicy, WebFetchResult,
    WebFetchSessionConfig,
};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use tokio::net::TcpListener;

// ---- Session helpers ----

fn mk_session() -> WebFetchSessionConfig {
    let perms = PermissionPolicy::new(Vec::<String>::new());
    let wf_perms = WebFetchPermissionPolicy::new(perms).with_unsafe_bypass(true);
    WebFetchSessionConfig::new(wf_perms, default_engine())
}

fn mk_session_allow_loopback() -> WebFetchSessionConfig {
    let mut s = mk_session();
    s.allow_loopback = true;
    s
}

fn expect_error(r: &WebFetchResult) -> &harness_webfetch::WebFetchError {
    match r {
        WebFetchResult::Error(e) => e,
        other => panic!("expected error, got: {:?}", other),
    }
}

fn expect_ok(r: &WebFetchResult) -> &harness_webfetch::WebFetchOk {
    match r {
        WebFetchResult::Ok(o) => o,
        other => panic!("expected ok, got: {:?}", other),
    }
}

fn expect_http_error(r: &WebFetchResult) -> &harness_webfetch::WebFetchHttpError {
    match r {
        WebFetchResult::HttpError(e) => e,
        other => panic!("expected http_error, got: {:?}", other),
    }
}

// ---- Schema / alias pushback ----

#[tokio::test]
async fn rejects_unknown_param_uri_with_alias_hint() {
    let s = mk_session();
    let r = webfetch(json!({"uri": "http://example.com"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("url"));
}

#[tokio::test]
async fn rejects_timeout_seconds_alias() {
    let s = mk_session();
    let r = webfetch(
        json!({"url": "http://example.com", "timeout": 30}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("timeout_ms"));
}

#[tokio::test]
async fn rejects_cookies_v1_not_supported() {
    let s = mk_session();
    let r = webfetch(
        json!({"url": "http://example.com", "cookies": "x=y"}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.error.message.to_lowercase().contains("cookie"));
}

#[tokio::test]
async fn rejects_empty_url() {
    let s = mk_session();
    let r = webfetch(json!({"url": ""}), &s).await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("url is required"));
}

#[tokio::test]
async fn rejects_file_scheme() {
    let s = mk_session();
    let r = webfetch(json!({"url": "file:///etc/passwd"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidUrl);
}

#[tokio::test]
async fn rejects_unparseable_url() {
    let s = mk_session();
    let r = webfetch(json!({"url": "not a url"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidUrl);
}

#[tokio::test]
async fn rejects_post_without_body() {
    let s = mk_session();
    let r = webfetch(
        json!({"url": "http://example.com", "method": "POST"}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("POST requires"));
}

#[tokio::test]
async fn rejects_get_with_body() {
    let s = mk_session();
    let r = webfetch(
        json!({"url": "http://example.com", "body": "x"}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("GET does not accept"));
}

#[tokio::test]
async fn rejects_timeout_below_1s() {
    let s = mk_session();
    let r = webfetch(
        json!({"url": "http://example.com", "timeout_ms": 500}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.error.message.contains(">= 1000"));
}

#[tokio::test]
async fn rejects_max_redirects_above_10() {
    let s = mk_session();
    let r = webfetch(
        json!({"url": "http://example.com", "max_redirects": 99}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("<= 10"));
}

// ---- SSRF (no network) ----

#[test]
fn classifies_loopback_v4() {
    assert_eq!(
        classify_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
        Some(BlockClass::Loopback)
    );
}

#[test]
fn classifies_metadata_v4() {
    assert_eq!(
        classify_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))),
        Some(BlockClass::Metadata)
    );
}

#[test]
fn classifies_private_v4() {
    assert_eq!(
        classify_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
        Some(BlockClass::Private)
    );
    assert_eq!(
        classify_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))),
        Some(BlockClass::Private)
    );
    assert_eq!(
        classify_ip(IpAddr::V4(Ipv4Addr::new(172, 20, 0, 1))),
        Some(BlockClass::Private)
    );
}

#[test]
fn classifies_public_v4_as_allowed() {
    assert_eq!(classify_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))), None);
}

#[test]
fn classifies_v6_loopback_and_linklocal() {
    assert_eq!(classify_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)), Some(BlockClass::Loopback));
    assert_eq!(
        classify_ip(IpAddr::V6("fe80::1".parse().unwrap())),
        Some(BlockClass::LinkLocal)
    );
    assert_eq!(
        classify_ip(IpAddr::V6("fd00::1".parse().unwrap())),
        Some(BlockClass::Private)
    );
}

#[tokio::test]
async fn ssrf_blocks_loopback_without_opt_in() {
    let s = mk_session();
    let r = webfetch(json!({"url": "http://127.0.0.1:1/"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::SsrfBlocked);
}

#[tokio::test]
async fn ssrf_blocks_metadata_without_opt_in() {
    let s = mk_session();
    let r = webfetch(
        json!({"url": "http://169.254.169.254/latest/"}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::SsrfBlocked);
}

// ---- Permission fail-closed ----

#[tokio::test]
async fn rejects_when_no_hook_and_no_bypass() {
    let perms = PermissionPolicy::new(Vec::<String>::new());
    let wf_perms = WebFetchPermissionPolicy::new(perms); // no bypass, no hook
    let mut s = WebFetchSessionConfig::new(wf_perms, default_engine());
    s.allow_loopback = true;
    let r = webfetch(json!({"url": "http://127.0.0.1:1/"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::PermissionDenied);
}

// ---- HTTP integration: spin up a hyper server on localhost ----

type Handler = Arc<dyn Fn(Request<Incoming>) -> ServerResponse + Send + Sync>;

struct ServerResponse {
    status: StatusCode,
    content_type: &'static str,
    body: Bytes,
    location: Option<String>,
}

impl ServerResponse {
    fn ok(content_type: &'static str, body: impl Into<Bytes>) -> Self {
        Self {
            status: StatusCode::OK,
            content_type,
            body: body.into(),
            location: None,
        }
    }
    fn not_found(body: impl Into<Bytes>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            content_type: "text/plain",
            body: body.into(),
            location: None,
        }
    }
    fn redirect(to: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FOUND,
            content_type: "text/plain",
            body: Bytes::new(),
            location: Some(to.into()),
        }
    }
}

async fn start_server(handler: Handler) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind((IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .expect("bind");
    let addr = listener.local_addr().unwrap();

    let handler_for_task = handler.clone();
    let jh = tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(_) => return,
            };
            let io = TokioIo::new(stream);
            let h = handler_for_task.clone();
            tokio::spawn(async move {
                let svc = service_fn(move |req: Request<Incoming>| {
                    let h = h.clone();
                    async move {
                        let resp: ServerResponse = (h)(req);
                        let mut builder = Response::builder()
                            .status(resp.status)
                            .header("content-type", resp.content_type);
                        if let Some(loc) = resp.location {
                            builder = builder.header("location", loc);
                        }
                        Ok::<_, Infallible>(
                            builder.body(Full::new(resp.body)).unwrap(),
                        )
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });
    (addr, jh)
}

#[tokio::test]
async fn happy_path_html_extracts_markdown() {
    let handler: Handler = Arc::new(|_req| {
        ServerResponse::ok(
            "text/html",
            "<html><body><h1>Hello</h1><p>World</p></body></html>",
        )
    });
    let (addr, _jh) = start_server(handler).await;
    let url = format!("http://{}/page", addr);
    let s = mk_session_allow_loopback();
    let r = webfetch(json!({"url": url, "extract": "markdown"}), &s).await;
    let ok = expect_ok(&r);
    let md = ok.body_markdown.as_deref().unwrap_or("");
    assert!(
        md.to_lowercase().contains("hello") || md.to_lowercase().contains("world"),
        "md={}",
        md
    );
}

#[tokio::test]
async fn passthrough_json() {
    let handler: Handler = Arc::new(|_req| {
        ServerResponse::ok("application/json", r#"{"answer":42}"#)
    });
    let (addr, _jh) = start_server(handler).await;
    let url = format!("http://{}/data", addr);
    let s = mk_session_allow_loopback();
    let r = webfetch(json!({"url": url, "extract": "raw"}), &s).await;
    let ok = expect_ok(&r);
    let raw = ok.body_raw.as_deref().unwrap_or("");
    assert!(raw.contains("\"answer\":42"), "raw={}", raw);
}

#[tokio::test]
async fn rejects_unsupported_content_type() {
    let handler: Handler = Arc::new(|_req| {
        ServerResponse::ok("application/octet-stream", "binarydata")
    });
    let (addr, _jh) = start_server(handler).await;
    let url = format!("http://{}/bin", addr);
    let s = mk_session_allow_loopback();
    let r = webfetch(json!({"url": url}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::UnsupportedContentType);
}

#[tokio::test]
async fn surfaces_http_404_with_body() {
    let handler: Handler = Arc::new(|_req| {
        ServerResponse::not_found("Resource missing — try /other")
    });
    let (addr, _jh) = start_server(handler).await;
    let url = format!("http://{}/missing", addr);
    let s = mk_session_allow_loopback();
    let r = webfetch(json!({"url": url}), &s).await;
    let he = expect_http_error(&r);
    assert_eq!(he.meta.status, 404);
    assert!(he.body_raw.contains("Resource missing"));
}

#[tokio::test]
async fn redirect_chain_reported() {
    // /a -> /b -> /c (terminal). Build two server routes by reading req path.
    let handler: Handler = Arc::new(move |req: Request<Incoming>| {
        let path = req.uri().path().to_string();
        match path.as_str() {
            "/a" => ServerResponse::redirect("/b"),
            "/b" => ServerResponse::redirect("/c"),
            "/c" => ServerResponse::ok("text/html", "<p>final</p>"),
            _ => ServerResponse::not_found("no"),
        }
    });
    let (addr, _jh) = start_server(handler).await;
    let url = format!("http://{}/a", addr);
    let s = mk_session_allow_loopback();
    let r = webfetch(json!({"url": url, "extract": "raw"}), &s).await;
    let ok = expect_ok(&r);
    assert_eq!(ok.meta.redirect_chain.len(), 3, "chain={:?}", ok.meta.redirect_chain);
    assert!(ok.meta.final_url.ends_with("/c"));
}

#[tokio::test]
async fn redirect_loop_exceeds_limit() {
    let handler: Handler = Arc::new(|_req| ServerResponse::redirect("/r"));
    let (addr, _jh) = start_server(handler).await;
    let url = format!("http://{}/r", addr);
    let s = mk_session_allow_loopback();
    let r = webfetch(
        json!({"url": url, "max_redirects": 2}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::RedirectLoop);
}

#[tokio::test]
async fn cache_hit_tag() {
    use std::sync::atomic::{AtomicU32, Ordering};
    let counter = Arc::new(AtomicU32::new(0));
    let counter_clone = Arc::clone(&counter);
    let handler: Handler = Arc::new(move |_req| {
        counter_clone.fetch_add(1, Ordering::SeqCst);
        ServerResponse::ok("application/json", r#"{"v":1}"#)
    });
    let (addr, _jh) = start_server(handler).await;
    let url = format!("http://{}/x", addr);
    let mut s = mk_session_allow_loopback();
    s = s.with_cache();
    let _ = webfetch(json!({"url": url.clone(), "extract": "raw"}), &s).await;
    let r2 = webfetch(json!({"url": url, "extract": "raw"}), &s).await;
    let ok = expect_ok(&r2);
    assert!(ok.meta.from_cache);
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

// ---- Serialization shape ----

#[tokio::test]
async fn error_result_serializes_with_kind_tag() {
    let s = mk_session();
    let r = webfetch(json!({"url": ""}), &s).await;
    let v: Value = serde_json::to_value(&r).unwrap();
    assert_eq!(v.get("kind").and_then(|v| v.as_str()), Some("error"));
}
