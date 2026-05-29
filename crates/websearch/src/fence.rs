use harness_core::permissions::PermissionQuery;
use harness_core::{PermissionDecision, ToolError, ToolErrorCode};

use crate::types::{SafeSearch, WebSearchSessionConfig, WebSearchTimeRange};

#[derive(Debug, Clone)]
pub enum PermissionOutcome {
    Allow,
    Deny { reason: String },
}

pub struct AskArgs<'a> {
    pub query: &'a str,
    pub backend_url: &'a str,
    pub backend_host: &'a str,
    pub count: usize,
    pub time_range: WebSearchTimeRange,
    pub safe_search: SafeSearch,
    pub categories: &'a [String],
}

pub async fn ask_permission(
    session: &WebSearchSessionConfig,
    args: AskArgs<'_>,
) -> PermissionOutcome {
    let permissions = &session.permissions.inner;
    let pattern = format!("WebSearch(backend:{})", args.backend_host);

    if permissions.hook.is_none() {
        if session.permissions.unsafe_allow_search_without_hook {
            return PermissionOutcome::Allow;
        }
        return PermissionOutcome::Deny {
            reason: "websearch tool has no permission hook configured; refusing to query the search backend. Wire a hook or set permissions.unsafe_allow_search_without_hook for test fixtures."
                .to_string(),
        };
    }

    // A search query is low-sensitivity and audit-useful, so it's logged —
    // unless the session opts to log only its length.
    let mut metadata = serde_json::json!({
        "count": args.count,
        "time_range": args.time_range.as_str(),
        "safe_search": args.safe_search.as_str(),
        "categories": args.categories,
        "backend_host": args.backend_host,
    });
    if session.redact_query_in_hook {
        metadata["query_length"] = serde_json::json!(args.query.chars().count());
    } else {
        metadata["query"] = serde_json::json!(args.query);
    }

    let query = PermissionQuery {
        tool: "websearch".to_string(),
        path: args.backend_url.to_string(),
        action: "read".to_string(),
        always_patterns: vec![pattern.clone()],
        metadata,
    };
    let hook = permissions.hook.as_ref().unwrap();
    let decision = (hook)(query).await;
    match decision {
        PermissionDecision::Allow | PermissionDecision::AllowOnce => PermissionOutcome::Allow,
        PermissionDecision::Deny => PermissionOutcome::Deny {
            reason: format!(
                "Search blocked by permission policy. Pattern hint: {}",
                pattern
            ),
        },
        PermissionDecision::Ask => PermissionOutcome::Deny {
            reason: "Permission hook returned 'ask' but websearch runs in autonomous mode. Configure the hook to return allow or deny.".to_string(),
        },
    }
}

pub fn permission_denied_error(query: &str, reason: &str) -> ToolError {
    let echo_query = if query.chars().count() > 300 {
        let truncated: String = query.chars().take(300).collect();
        format!("{}...", truncated)
    } else {
        query.to_string()
    };
    ToolError::new(
        ToolErrorCode::PermissionDenied,
        format!("{}\nQuery: \"{}\"", reason, echo_query),
    )
    .with_meta(serde_json::json!({ "query": query }))
}
