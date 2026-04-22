use harness_core::permissions::PermissionQuery;
use harness_core::{PermissionDecision, ToolError, ToolErrorCode};

use crate::types::{WebFetchMethod, WebFetchSessionConfig};

#[derive(Debug, Clone)]
pub enum PermissionOutcome {
    Allow,
    Deny { reason: String },
}

pub struct AskArgs<'a> {
    pub method: WebFetchMethod,
    pub url: &'a str,
    pub host: &'a str,
    pub body_bytes: usize,
    pub header_keys: Vec<String>,
    pub extract: &'a str,
    pub timeout_ms: u64,
    pub max_redirects: u32,
}

pub async fn ask_permission(
    session: &WebFetchSessionConfig,
    args: AskArgs<'_>,
) -> PermissionOutcome {
    let permissions = &session.permissions.inner;
    let pattern = format!("WebFetch(domain:{})", args.host);

    if permissions.hook.is_none() {
        if session.permissions.unsafe_allow_fetch_without_hook {
            return PermissionOutcome::Allow;
        }
        return PermissionOutcome::Deny {
            reason: "webfetch tool has no permission hook configured; refusing to fetch untrusted URLs. Wire a hook or set permissions.unsafe_allow_fetch_without_hook for test fixtures."
                .to_string(),
        };
    }

    let metadata = serde_json::json!({
        "method": args.method.as_str(),
        "url": args.url,
        "host": args.host,
        "body_bytes": args.body_bytes,
        "headers_sent": args.header_keys,
        "extract": args.extract,
        "timeout_ms": args.timeout_ms,
        "redirect_limit": args.max_redirects,
    });
    let query = PermissionQuery {
        tool: "webfetch".to_string(),
        path: args.url.to_string(),
        action: "read".to_string(),
        always_patterns: vec![pattern.clone()],
        metadata,
    };
    let hook = permissions.hook.as_ref().unwrap();
    let decision = (hook)(query).await;
    match decision {
        PermissionDecision::Allow | PermissionDecision::AllowOnce => PermissionOutcome::Allow,
        PermissionDecision::Deny => PermissionOutcome::Deny {
            reason: format!("URL blocked by permission policy. Pattern hint: {}", pattern),
        },
        PermissionDecision::Ask => PermissionOutcome::Deny {
            reason: "Permission hook returned 'ask' but webfetch runs in autonomous mode. Configure the hook to return allow or deny.".to_string(),
        },
    }
}

pub fn permission_denied_error(url: &str, reason: &str) -> ToolError {
    let echo_url = if url.len() > 300 {
        format!("{}...", &url[..300])
    } else {
        url.to_string()
    };
    ToolError::new(
        ToolErrorCode::PermissionDenied,
        format!("{}\nURL: {}", reason, echo_url),
    )
    .with_meta(serde_json::json!({ "url": url }))
}
