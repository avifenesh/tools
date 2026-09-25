//! Shared stateless MCP `tools/call` over Streamable HTTP, used by the Exa and
//! Parallel engines. Mirrors the TS `engines/mcp.ts` helper.
//!
//! Both hosted search MCP servers accept a bare `tools/call` without the
//! `initialize` handshake (verified live 2026-09-26), which saves two round
//! trips per search. The reply is either `application/json` or a
//! `text/event-stream` carrying the JSON-RPC response in a `data:` line.
//!
//! Every failure is a per-engine SERVER_NOT_AVAILABLE (or a transport code),
//! never INVALID_PARAM: an MCP-level rejection says nothing about whether the
//! model's query was malformed (WS-D14), so the chain should just move on.

use std::time::Instant;
use url::Url;

use crate::engine::{classify_reqwest_error, SearchError, SearchErrorCode, WebSearchEngineInput};

pub(crate) struct McpCallResult {
    /// The JSON-RPC `result` object (`content`, optional `structuredContent`).
    pub result: serde_json::Value,
    pub host: String,
    pub elapsed_ms: u64,
}

pub(crate) async fn mcp_tool_call(
    client: &reqwest::Client,
    url: &Url,
    input: &WebSearchEngineInput,
    engine: &str,
    tool: &str,
    arguments: serde_json::Value,
    extra_headers: &[(&str, String)],
) -> Result<McpCallResult, SearchError> {
    let host = url.host_str().unwrap_or("").to_string();
    (input.check_host)(host.clone())
        .await
        .map_err(|msg| SearchError::new(SearchErrorCode::SsrfBlocked, msg))?;

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": tool, "arguments": arguments },
    });

    let started = Instant::now();
    let mut req = client
        .request(reqwest::Method::POST, url.clone())
        .timeout(std::time::Duration::from_millis(input.timeout_ms));
    for (k, v) in &input.headers {
        if k.eq_ignore_ascii_case("accept") || k.eq_ignore_ascii_case("content-type") {
            continue;
        }
        req = req.header(k, v);
    }
    req = req
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream");
    for (k, v) in extra_headers {
        req = req.header(*k, v);
    }

    let res = req
        .body(body.to_string())
        .send()
        .await
        .map_err(classify_reqwest_error)?;
    let status = res.status().as_u16();
    if status >= 400 {
        drop(res);
        let suffix = if status == 429 || status == 403 {
            "; rate-limited or bot-blocked"
        } else {
            ""
        };
        return Err(SearchError::new(
            SearchErrorCode::ServerNotAvailable,
            format!("{} is unavailable (HTTP {}{})", engine, status, suffix),
        ));
    }
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = res.bytes().await.map_err(classify_reqwest_error)?;
    let text = String::from_utf8_lossy(&bytes);

    let message =
        parse_rpc_message(&text, content_type.contains("text/event-stream")).ok_or_else(|| {
            SearchError::new(
                SearchErrorCode::IoError,
                format!("{}: could not parse the MCP response as JSON-RPC", engine),
            )
        })?;

    if let Some(err) = message.get("error") {
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(SearchError::new(
            SearchErrorCode::ServerNotAvailable,
            format!("{} MCP error: {}", engine, msg),
        ));
    }
    let result = message
        .get("result")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or_else(|| {
            SearchError::new(
                SearchErrorCode::IoError,
                format!("{}: MCP response carried neither result nor error", engine),
            )
        })?;
    if result.get("isError").and_then(|v| v.as_bool()) == Some(true) {
        let msg = content_text(&result);
        return Err(SearchError::new(
            SearchErrorCode::ServerNotAvailable,
            format!("{} tool error: {}", engine, first_line(&msg)),
        ));
    }

    Ok(McpCallResult {
        result,
        host,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Pull the JSON-RPC message out of a plain JSON body or an SSE stream. For
/// SSE, each event's `data:` lines are joined; the first event that parses to
/// an object with `result` or `error` wins (servers may interleave
/// notifications before the response).
fn parse_rpc_message(text: &str, sse_hint: bool) -> Option<serde_json::Value> {
    let trimmed = text.trim_start();
    if !sse_hint && (trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return serde_json::from_str::<serde_json::Value>(trimmed)
            .ok()
            .and_then(pick_response);
    }
    let mut data = String::new();
    let flush = |data: &mut String| -> Option<serde_json::Value> {
        if data.is_empty() {
            return None;
        }
        let parsed = serde_json::from_str::<serde_json::Value>(data)
            .ok()
            .and_then(pick_response);
        data.clear();
        parsed
    };
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        } else if line.trim().is_empty() {
            if let Some(v) = flush(&mut data) {
                return Some(v);
            }
        }
    }
    if let Some(v) = flush(&mut data) {
        return Some(v);
    }
    // Some servers answer SSE-negotiated requests with plain JSON anyway.
    serde_json::from_str::<serde_json::Value>(trimmed)
        .ok()
        .and_then(pick_response)
}

fn pick_response(v: serde_json::Value) -> Option<serde_json::Value> {
    match v {
        serde_json::Value::Array(items) => items.into_iter().find_map(pick_response),
        serde_json::Value::Object(ref o) if o.contains_key("result") || o.contains_key("error") => {
            Some(v)
        }
        _ => None,
    }
}

/// Concatenate the `text` parts of an MCP tool result's `content` array.
pub(crate) fn content_text(result: &serde_json::Value) -> String {
    let mut out = String::new();
    if let Some(parts) = result.get("content").and_then(|v| v.as_array()) {
        for p in parts {
            if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
            }
        }
    }
    out
}

fn first_line(s: &str) -> String {
    let line = s
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    line.chars().take(200).collect()
}

/// Keep the date portion of an ISO timestamp ("2026-07-22T16:46:14.000Z" →
/// "2026-07-22"); anything else (null, "N/A") yields None. Never fabricated.
pub(crate) fn iso_date(raw: &str) -> Option<String> {
    let t = raw.trim();
    let b = t.as_bytes();
    if b.len() >= 10
        && b[0..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
    {
        Some(t[0..10].to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sse_data_line() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[]}}\n\n";
        let v = parse_rpc_message(body, true).unwrap();
        assert!(v.get("result").is_some());
    }

    #[test]
    fn skips_notifications_before_the_response() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"rate limit\"}}\n\n";
        let v = parse_rpc_message(body, true).unwrap();
        assert_eq!(v["error"]["message"], "rate limit");
    }

    #[test]
    fn parses_plain_json() {
        let v = parse_rpc_message("{\"id\":1,\"result\":{}}", false).unwrap();
        assert!(v.get("result").is_some());
    }

    #[test]
    fn iso_date_only_for_real_dates() {
        assert_eq!(
            iso_date("2026-07-22T16:46:14.000Z").as_deref(),
            Some("2026-07-22")
        );
        assert_eq!(iso_date("N/A"), None);
        assert_eq!(iso_date(""), None);
    }
}
