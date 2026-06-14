//! Engine-level + fallback + resolver tests for the Rust port. Mirrors the TS
//! `test/engines.test.ts` and `test/fallback.test.ts`. Network engines are
//! exercised against local hyper fixture servers; the fallback/resolver logic
//! uses in-process fake engines.

use async_trait::async_trait;
use bytes::Bytes;
use harness_core::PermissionPolicy;
use harness_websearch::{
    websearch, BraveEngine, EngineBaseUrls, EngineClass, MarginaliaEngine, MojeekEngine,
    SearchError, SearchErrorCode, TavilyEngine, WebSearchEngine, WebSearchEngineInput,
    WebSearchEngineResult, WebSearchPermissionPolicy, WebSearchResult, WebSearchResultItem,
    WebSearchSessionConfig, WebSearchTimeRange, WikipediaEngine,
};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::json;
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

// ---- fixture loading ----

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
    std::fs::read_to_string(path).expect("read fixture")
}

// ---- minimal hyper server returning a fixed response, capturing the URI ----

struct Resp {
    status: StatusCode,
    content_type: &'static str,
    body: Bytes,
}

type H = Arc<dyn Fn(Request<Incoming>) -> Resp + Send + Sync>;

async fn serve(handler: H) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind((IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let jh = tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(s) => s,
                Err(_) => return,
            };
            let io = TokioIo::new(stream);
            let h = handler.clone();
            tokio::spawn(async move {
                let svc = service_fn(move |req: Request<Incoming>| {
                    let h = h.clone();
                    async move {
                        let r = (h)(req);
                        Ok::<_, Infallible>(
                            Response::builder()
                                .status(r.status)
                                .header("content-type", r.content_type)
                                .body(Full::new(r.body))
                                .unwrap(),
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

fn json_resp(body: impl Into<Bytes>) -> Resp {
    Resp {
        status: StatusCode::OK,
        content_type: "application/json",
        body: body.into(),
    }
}

fn engine_input() -> WebSearchEngineInput {
    WebSearchEngineInput {
        backend_url: String::new(),
        query: "rust async runtime".to_string(),
        count: 5,
        time_range: WebSearchTimeRange::All,
        language: "auto".to_string(),
        safe_search: harness_websearch::SafeSearch::Moderate,
        categories: vec!["general".to_string()],
        timeout_ms: 5000,
        headers: std::collections::HashMap::new(),
        check_host: Arc::new(|_h| Box::pin(async { Ok(()) })),
    }
}

// ---- Mojeek ----

#[tokio::test]
async fn mojeek_parses_real_fixture() {
    let html = fixture("mojeek.html");
    let body = Bytes::from(html);
    let handler: H = Arc::new(move |_req| Resp {
        status: StatusCode::OK,
        content_type: "text/html",
        body: body.clone(),
    });
    let (addr, _jh) = serve(handler).await;
    let engine = MojeekEngine::new().with_base_url(format!("http://{}", addr));
    let mut input = engine_input();
    input.count = 3;
    let r = engine.search(input).await.unwrap();
    assert_eq!(r.results.len(), 3);
    assert!(r.results[0].url.contains("michaelhelvey.dev"));
    assert!(!r.results[0].title.is_empty());
}

#[tokio::test]
async fn mojeek_empty_serp_is_empty_not_error() {
    let handler: H = Arc::new(|_req| Resp {
        status: StatusCode::OK,
        content_type: "text/html",
        body: Bytes::from_static(
            br#"<div class="serp-results"><div class="results-count-container"><p>Results 0 to 0 from 0</p></div><div class="results"></div><p>No pages found matching: <strong>zzz</strong></p></div>"#,
        ),
    });
    let (addr, _jh) = serve(handler).await;
    let engine = MojeekEngine::new().with_base_url(format!("http://{}", addr));
    let r = engine.search(engine_input()).await.unwrap();
    assert!(r.results.is_empty());
}

fn expect_err(r: Result<WebSearchEngineResult, SearchError>) -> SearchError {
    match r {
        Ok(_) => panic!("expected an engine error, got results"),
        Err(e) => e,
    }
}

#[tokio::test]
async fn mojeek_interstitial_is_server_not_available() {
    let handler: H = Arc::new(|_req| Resp {
        status: StatusCode::OK,
        content_type: "text/html",
        body: Bytes::from_static(b"<html><body>Verify you are human</body></html>"),
    });
    let (addr, _jh) = serve(handler).await;
    let engine = MojeekEngine::new().with_base_url(format!("http://{}", addr));
    let e = expect_err(engine.search(engine_input()).await);
    assert_eq!(e.code, SearchErrorCode::ServerNotAvailable);
}

// ---- Marginalia ----

#[tokio::test]
async fn marginalia_maps_real_fixture() {
    let body = Bytes::from(fixture("marginalia.json"));
    let handler: H = Arc::new(move |_req| json_resp(body.clone()));
    let (addr, _jh) = serve(handler).await;
    let engine = MarginaliaEngine::new().with_base_url(format!("http://{}", addr));
    let r = engine.search(engine_input()).await.unwrap();
    assert!(!r.results.is_empty());
    assert!(r.results[0].url.starts_with("http"));
    assert!(!r.results[0].title.is_empty());
}

#[tokio::test]
async fn mojeek_403_is_server_not_available_not_invalid_param() {
    // Mojeek rate-limits/bot-blocks with 403; that must be a per-engine
    // unavailability the chain skips, NOT InvalidParam (which would wrongly
    // tell the model its query was malformed).
    let handler: H = Arc::new(|_req| Resp {
        status: StatusCode::FORBIDDEN,
        content_type: "text/plain",
        body: Bytes::from_static(b"forbidden"),
    });
    let (addr, _jh) = serve(handler).await;
    let engine = MojeekEngine::new().with_base_url(format!("http://{}", addr));
    let e = expect_err(engine.search(engine_input()).await);
    assert_eq!(e.code, SearchErrorCode::ServerNotAvailable);
}

#[tokio::test]
async fn marginalia_429_is_server_not_available() {
    let handler: H = Arc::new(|_req| Resp {
        status: StatusCode::TOO_MANY_REQUESTS,
        content_type: "application/json",
        body: Bytes::from_static(b"slow down"),
    });
    let (addr, _jh) = serve(handler).await;
    let engine = MarginaliaEngine::new().with_base_url(format!("http://{}", addr));
    let e = expect_err(engine.search(engine_input()).await);
    assert_eq!(e.code, SearchErrorCode::ServerNotAvailable);
}

#[tokio::test]
async fn marginalia_builds_public_search_path() {
    let seen: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let seen2 = seen.clone();
    let handler: H = Arc::new(move |req: Request<Incoming>| {
        *seen2.lock().unwrap() = req.uri().to_string();
        json_resp(Bytes::from_static(br#"{"results":[]}"#))
    });
    let (addr, _jh) = serve(handler).await;
    let engine = MarginaliaEngine::new().with_base_url(format!("http://{}", addr));
    let mut input = engine_input();
    input.query = "a b".to_string();
    input.count = 7;
    let _ = engine.search(input).await.unwrap();
    let uri = seen.lock().unwrap().clone();
    assert!(uri.contains("/public/search/"), "uri={}", uri);
    assert!(uri.contains("count=7"), "uri={}", uri);
}

// ---- Wikipedia ----

#[tokio::test]
async fn wikipedia_maps_real_fixture_with_curid_and_stripped_snippet() {
    let body = Bytes::from(fixture("wikipedia.json"));
    let handler: H = Arc::new(move |_req| json_resp(body.clone()));
    let (addr, _jh) = serve(handler).await;
    let engine = WikipediaEngine::new().with_base_url(format!("http://{}", addr));
    let r = engine.search(engine_input()).await.unwrap();
    assert!(!r.results.is_empty());
    assert!(r.results[0].url.contains("/?curid="));
    assert!(!r.results[0].snippet.contains("<span"));
}

// ---- Brave (keyed) ----

#[tokio::test]
async fn brave_sends_token_and_maps_web_results() {
    let seen_token: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let st = seen_token.clone();
    let handler: H = Arc::new(move |req: Request<Incoming>| {
        *st.lock().unwrap() = req
            .headers()
            .get("x-subscription-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        json_resp(Bytes::from_static(
            br#"{"web":{"results":[{"title":"T1","url":"https://a.com","description":"d1"}]}}"#,
        ))
    });
    let (addr, _jh) = serve(handler).await;
    let engine = BraveEngine::new("secret-key").with_base_url(format!("http://{}", addr));
    let r = engine.search(engine_input()).await.unwrap();
    assert_eq!(*seen_token.lock().unwrap(), "secret-key");
    assert_eq!(r.results[0].url, "https://a.com");
}

// ---- Tavily (keyed, POST) ----

#[tokio::test]
async fn tavily_posts_and_maps_results() {
    let seen_method: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let sm = seen_method.clone();
    let handler: H = Arc::new(move |req: Request<Incoming>| {
        *sm.lock().unwrap() = req.method().to_string();
        json_resp(Bytes::from_static(
            br#"{"results":[{"title":"T","url":"https://x.com","content":"snip"}]}"#,
        ))
    });
    let (addr, _jh) = serve(handler).await;
    let engine = TavilyEngine::new("tav-key").with_base_url(format!("http://{}", addr));
    let r = engine.search(engine_input()).await.unwrap();
    assert_eq!(*seen_method.lock().unwrap(), "POST");
    assert_eq!(r.results[0].url, "https://x.com");
}

// ---- FallbackEngine semantics (in-process fakes) ----

struct FakeEngine {
    name: String,
    behavior: FakeBehavior,
    calls: Arc<Mutex<Vec<String>>>,
    class: EngineClass,
}

#[derive(Clone)]
enum FakeBehavior {
    Results(Vec<WebSearchResultItem>),
    Empty,
    Error(SearchErrorCode),
}

#[async_trait]
impl WebSearchEngine for FakeEngine {
    fn name(&self) -> &str {
        &self.name
    }
    fn engine_class(&self) -> EngineClass {
        self.class
    }
    async fn search(
        &self,
        _input: WebSearchEngineInput,
    ) -> Result<WebSearchEngineResult, SearchError> {
        self.calls.lock().unwrap().push(self.name.clone());
        match &self.behavior {
            FakeBehavior::Results(items) => Ok(WebSearchEngineResult {
                results: items.clone(),
                backend_host: format!("{}.example", self.name),
                elapsed_ms: 1,
                engine: None,
                engine_class: None,
                time_range_applied: None,
            }),
            FakeBehavior::Empty => Ok(WebSearchEngineResult {
                results: vec![],
                backend_host: format!("{}.example", self.name),
                elapsed_ms: 1,
                engine: None,
                engine_class: None,
                time_range_applied: None,
            }),
            FakeBehavior::Error(code) => Err(SearchError::new(*code, "fake error")),
        }
    }
}

fn item(u: &str) -> WebSearchResultItem {
    WebSearchResultItem {
        title: format!("t-{}", u),
        url: format!("https://{}", u),
        snippet: "s".to_string(),
        age: None,
        score: None,
    }
}

fn fake(
    name: &str,
    behavior: FakeBehavior,
    calls: Arc<Mutex<Vec<String>>>,
) -> Arc<dyn WebSearchEngine> {
    fake_classed(name, behavior, calls, EngineClass::General)
}

fn fake_classed(
    name: &str,
    behavior: FakeBehavior,
    calls: Arc<Mutex<Vec<String>>>,
    class: EngineClass,
) -> Arc<dyn WebSearchEngine> {
    Arc::new(FakeEngine {
        name: name.to_string(),
        behavior,
        calls,
        class,
    })
}

use harness_websearch::FallbackEngine;

#[tokio::test]
async fn fallback_returns_first_non_empty_skipping_empties() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let engine = FallbackEngine::new(vec![
        fake("a", FakeBehavior::Empty, calls.clone()),
        fake("b", FakeBehavior::Results(vec![item("b1")]), calls.clone()),
        fake("c", FakeBehavior::Results(vec![item("c1")]), calls.clone()),
    ]);
    let r = engine.search(engine_input()).await.unwrap();
    assert_eq!(r.results[0].url, "https://b1");
    assert_eq!(r.engine.as_deref(), Some("b"));
    assert_eq!(*calls.lock().unwrap(), vec!["a", "b"]); // c not tried
}

#[tokio::test]
async fn fallback_skips_error_then_continues() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let engine = FallbackEngine::new(vec![
        fake("a", FakeBehavior::Error(SearchErrorCode::Timeout), calls.clone()),
        fake("b", FakeBehavior::Results(vec![item("b1")]), calls.clone()),
    ]);
    let r = engine.search(engine_input()).await.unwrap();
    assert_eq!(r.engine.as_deref(), Some("b"));
}

#[tokio::test]
async fn fallback_all_empty_is_empty() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let engine = FallbackEngine::new(vec![
        fake("a", FakeBehavior::Empty, calls.clone()),
        fake("b", FakeBehavior::Empty, calls.clone()),
    ]);
    let r = engine.search(engine_input()).await.unwrap();
    assert!(r.results.is_empty());
}

#[tokio::test]
async fn fallback_clean_empty_beats_later_error() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let engine = FallbackEngine::new(vec![
        fake("a", FakeBehavior::Empty, calls.clone()),
        fake("b", FakeBehavior::Error(SearchErrorCode::IoError), calls.clone()),
    ]);
    let r = engine.search(engine_input()).await.unwrap();
    assert!(r.results.is_empty()); // empty, not Err
}

#[tokio::test]
async fn fallback_degraded_empty_when_general_errored_and_only_vertical_empty() {
    // Mojeek (general) errors, Marginalia (niche) errors, Wikipedia (vertical)
    // returns empty. Returning empty would mislead ("no web results"); must err.
    let calls = Arc::new(Mutex::new(Vec::new()));
    let engine = FallbackEngine::new(vec![
        fake_classed(
            "mojeek",
            FakeBehavior::Error(SearchErrorCode::ServerNotAvailable),
            calls.clone(),
            EngineClass::General,
        ),
        fake_classed(
            "marginalia",
            FakeBehavior::Error(SearchErrorCode::ServerNotAvailable),
            calls.clone(),
            EngineClass::Niche,
        ),
        fake_classed("wikipedia", FakeBehavior::Empty, calls.clone(), EngineClass::Vertical),
    ]);
    let e = expect_err(engine.search(engine_input()).await);
    assert_eq!(e.code, SearchErrorCode::ServerNotAvailable);
}

#[tokio::test]
async fn fallback_general_empty_is_authoritative() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let engine = FallbackEngine::new(vec![
        fake_classed("mojeek", FakeBehavior::Empty, calls.clone(), EngineClass::General),
        fake_classed(
            "marginalia",
            FakeBehavior::Error(SearchErrorCode::ServerNotAvailable),
            calls.clone(),
            EngineClass::Niche,
        ),
    ]);
    let r = engine.search(engine_input()).await.unwrap();
    assert!(r.results.is_empty());
    assert_eq!(r.engine.as_deref(), Some("mojeek"));
}

#[tokio::test]
async fn fallback_niche_empty_ok_when_no_general_errored() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let engine = FallbackEngine::new(vec![
        fake_classed("marginalia", FakeBehavior::Empty, calls.clone(), EngineClass::Niche),
        fake_classed("wikipedia", FakeBehavior::Empty, calls.clone(), EngineClass::Vertical),
    ]);
    let r = engine.search(engine_input()).await.unwrap();
    assert!(r.results.is_empty());
}

#[tokio::test]
async fn fallback_all_error_throws_unified_code() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let engine = FallbackEngine::new(vec![
        fake("a", FakeBehavior::Error(SearchErrorCode::Timeout), calls.clone()),
        fake("b", FakeBehavior::Error(SearchErrorCode::Timeout), calls.clone()),
    ]);
    let e = expect_err(engine.search(engine_input()).await);
    assert_eq!(e.code, SearchErrorCode::Timeout);
}

#[tokio::test]
async fn fallback_mixed_errors_summarize_as_server_not_available() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let engine = FallbackEngine::new(vec![
        fake("a", FakeBehavior::Error(SearchErrorCode::Timeout), calls.clone()),
        fake("b", FakeBehavior::Error(SearchErrorCode::DnsError), calls.clone()),
    ]);
    let e = expect_err(engine.search(engine_input()).await);
    assert_eq!(e.code, SearchErrorCode::ServerNotAvailable);
}

// ---- resolver via the public websearch() (zero-config provenance) ----

#[tokio::test]
async fn zero_config_uses_keyless_and_reports_provenance() {
    // Mojeek fixture server first in the chain; provenance must say "mojeek".
    let handler: H = Arc::new(|_req| Resp {
        status: StatusCode::OK,
        content_type: "text/html",
        body: Bytes::from_static(
            br#"<ul class="results-standard"><!--rs--><li><a class="title" href="https://ex.com/a">A</a><p class="s">snip</p></li><!--re--></ul>"#,
        ),
    });
    let (addr, _jh) = serve(handler).await;
    let perms = PermissionPolicy::new(Vec::<String>::new());
    let ws_perms = WebSearchPermissionPolicy::new(perms).with_unsafe_bypass(true);
    let mut s = WebSearchSessionConfig::auto(ws_perms);
    s.allow_loopback = true;
    s.engine_base_urls = Some(EngineBaseUrls {
        mojeek: Some(format!("http://{}", addr)),
        ..Default::default()
    });
    let r = websearch(json!({"query": "x"}), &s).await;
    match r {
        WebSearchResult::Ok(ok) => {
            assert_eq!(ok.meta.engine.as_deref(), Some("mojeek"));
            assert_eq!(
                ok.meta.engine_class,
                Some(harness_websearch::EngineClass::General)
            );
            // New compact format labels the engine class in the header.
            assert!(ok.output.contains("mojeek (general web)"));
            assert!(ok.output.starts_with("WEB \"x\""));
        }
        other => panic!("expected ok, got {:?}", other),
    }
}

#[tokio::test]
async fn wikipedia_surfaces_age_and_marginalia_surfaces_score() {
    // Wikipedia: timestamp → age (YYYY-MM-DD).
    let wbody = Bytes::from(fixture("wikipedia.json"));
    let wh: H = Arc::new(move |_req| json_resp(wbody.clone()));
    let (waddr, _wj) = serve(wh).await;
    let wr = WikipediaEngine::new()
        .with_base_url(format!("http://{}", waddr))
        .search(engine_input())
        .await
        .unwrap();
    assert!(wr.results[0].age.as_deref().is_some_and(|a| a.len() == 10));
    assert_eq!(wr.time_range_applied, None); // no time_range requested

    // Marginalia: quality → score.
    let mbody = Bytes::from(fixture("marginalia.json"));
    let mh: H = Arc::new(move |_req| json_resp(mbody.clone()));
    let (maddr, _mj) = serve(mh).await;
    let mr = MarginaliaEngine::new()
        .with_base_url(format!("http://{}", maddr))
        .search(engine_input())
        .await
        .unwrap();
    assert!(mr.results[0].score.is_some());
}

#[tokio::test]
async fn honest_recency_note_when_engine_ignores_time_range() {
    // Mojeek ignores time_range; the header must say so, not mislabel.
    let handler: H = Arc::new(|_req| Resp {
        status: StatusCode::OK,
        content_type: "text/html",
        body: Bytes::from_static(
            br#"<ul class="results-standard"><!--rs--><li><a class="title" href="https://ex.com/a">A</a><p class="s">snip</p></li><!--re--></ul>"#,
        ),
    });
    let (addr, _jh) = serve(handler).await;
    let perms = PermissionPolicy::new(Vec::<String>::new());
    let ws_perms = WebSearchPermissionPolicy::new(perms).with_unsafe_bypass(true);
    let mut s = WebSearchSessionConfig::auto(ws_perms);
    s.allow_loopback = true;
    s.engine_base_urls = Some(EngineBaseUrls {
        mojeek: Some(format!("http://{}", addr)),
        ..Default::default()
    });
    let r = websearch(json!({"query": "x", "time_range": "week"}), &s).await;
    match r {
        WebSearchResult::Ok(ok) => {
            assert_eq!(ok.meta.time_range_applied, Some(false));
            assert!(ok.output.contains("time:week NOT applied"));
        }
        other => panic!("expected ok, got {:?}", other),
    }
}
