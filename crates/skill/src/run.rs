use harness_core::{ToolError, ToolErrorCode};
use serde_json::Value;

use crate::fence::{
    ask_permission, fence_skill, resolve_trust_mode, PermissionOutcome, PermissionReason,
};
use crate::format::{format_already_loaded, format_not_found, format_skill, FormatSkillArgs};
use crate::schema::safe_parse_skill_params;
use crate::substitute::substitute_arguments;
use crate::suggest::suggest_skill_siblings;
use crate::types::{
    SkillAlreadyLoaded, SkillArguments, SkillError, SkillNotFound, SkillOk, SkillResult,
    SkillSessionConfig, SkillTrustMode,
};

fn err(error: ToolError) -> SkillResult {
    SkillResult::Error(SkillError { error })
}

pub async fn skill(input: Value, session: &SkillSessionConfig) -> SkillResult {
    let params = match safe_parse_skill_params(&input) {
        Ok(p) => p,
        Err(e) => return err(ToolError::new(ToolErrorCode::InvalidParam, e.to_string())),
    };

    // Dedupe.
    if let Some(activated) = &session.activated {
        let guard = activated.0.lock().await;
        if guard.contains(&params.name) {
            return SkillResult::AlreadyLoaded(SkillAlreadyLoaded {
                output: format_already_loaded(&params.name),
                name: params.name,
            });
        }
    }

    // Catalog lookup.
    let entries = match session.registry.discover().await {
        Ok(e) => e,
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("registry discover failed: {}", e),
            ));
        }
    };
    let entry = entries.iter().find(|e| e.name == params.name);
    let entry = match entry {
        Some(e) => e,
        None => {
            let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
            let siblings = suggest_skill_siblings(&params.name, &names);
            return SkillResult::NotFound(SkillNotFound {
                output: format_not_found(&params.name, &siblings),
                name: params.name,
                siblings,
            });
        }
    };

    // Surface discovery-time INVALID_FRONTMATTER / NAME_MISMATCH via the
    // synthetic `__skill_error` sentinel.
    if let Some(error_msg) = entry
        .frontmatter
        .get("__skill_error")
        .and_then(|v| v.as_str())
    {
        let code = match entry
            .frontmatter
            .get("__skill_error_code")
            .and_then(|v| v.as_str())
        {
            Some("NAME_MISMATCH") => ToolErrorCode::NameMismatch,
            _ => ToolErrorCode::InvalidFrontmatter,
        };
        let mut meta = serde_json::json!({ "name": entry.name, "dir": entry.dir });
        if let Some(line) = entry.frontmatter.get("__skill_error_line") {
            meta["line"] = line.clone();
        }
        return err(ToolError::new(code, format!("skill \"{}\": {}", entry.name, error_msg))
            .with_meta(meta));
    }

    // disable-model-invocation.
    if entry
        .frontmatter
        .get("disable-model-invocation")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        && !session.user_initiated
    {
        return err(ToolError::new(
            ToolErrorCode::Disabled,
            format!(
                "skill \"{}\" has disable-model-invocation: true; only user-initiated activation is allowed",
                entry.name
            ),
        )
        .with_meta(serde_json::json!({ "name": entry.name, "dir": entry.dir })));
    }

    // Arguments shape contract.
    let args_decl_present = entry
        .frontmatter
        .get("arguments")
        .map(|v| !v.is_null())
        .unwrap_or(false);
    match (&params.arguments, args_decl_present) {
        (Some(SkillArguments::String(_)), true) => {
            return err(ToolError::new(
                ToolErrorCode::InvalidParam,
                format!(
                    "skill \"{}\" declares named arguments; pass them as an object, not a string",
                    entry.name
                ),
            )
            .with_meta(serde_json::json!({ "name": entry.name })));
        }
        (Some(SkillArguments::Object(_)), false) => {
            return err(ToolError::new(
                ToolErrorCode::InvalidParam,
                format!(
                    "skill \"{}\" does not declare named arguments; pass 'arguments' as a string or omit it",
                    entry.name
                ),
            )
            .with_meta(serde_json::json!({ "name": entry.name })));
        }
        _ => {}
    }

    // Load body + resources.
    let loaded = match session.registry.load(&params.name).await {
        Ok(Some(l)) => l,
        Ok(None) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("failed to load skill \"{}\" from {}", entry.name, entry.dir),
            )
            .with_meta(serde_json::json!({ "name": entry.name, "dir": entry.dir })));
        }
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("registry load error: {}", e),
            ));
        }
    };

    // Fence.
    if let Some(fe) = fence_skill(session, &loaded) {
        return err(fe);
    }

    // Trust gate.
    let (trusted, mode) = resolve_trust_mode(session, &loaded.dir);
    let outcome = if !trusted && matches!(mode, SkillTrustMode::HookRequired) {
        match ask_permission(session, &loaded, PermissionReason::UntrustedProjectSkill).await {
            PermissionOutcome::Allow => PermissionOutcome::Allow,
            PermissionOutcome::Deny { why } => {
                return err(ToolError::new(ToolErrorCode::NotTrusted, why)
                    .with_meta(serde_json::json!({ "name": loaded.name, "dir": loaded.dir })));
            }
        }
    } else {
        if !trusted && matches!(mode, SkillTrustMode::Warn) {
            eprintln!(
                "[skill] activating untrusted skill \"{}\" at {} (trust.untrusted_project_skills=warn)",
                loaded.name, loaded.dir
            );
        }
        match ask_permission(session, &loaded, PermissionReason::Normal).await {
            PermissionOutcome::Allow => PermissionOutcome::Allow,
            PermissionOutcome::Deny { why } => {
                return err(ToolError::new(ToolErrorCode::PermissionDenied, why)
                    .with_meta(serde_json::json!({ "name": loaded.name, "dir": loaded.dir })));
            }
        }
    };
    let _ = outcome;

    // Substitute arguments.
    let substituted = substitute_arguments(&loaded.body, params.arguments.as_ref());
    let bytes = substituted.as_bytes().len() as u64;

    let output = format_skill(FormatSkillArgs {
        name: &loaded.name,
        dir: &loaded.dir,
        frontmatter: &loaded.frontmatter,
        body: &substituted,
        resources: &loaded.resources,
        bytes,
    });

    // Record activation (dedupe set).
    if let Some(activated) = &session.activated {
        let mut guard = activated.0.lock().await;
        guard.insert(loaded.name.clone());
    }

    SkillResult::Ok(SkillOk {
        output,
        name: loaded.name,
        dir: loaded.dir,
        body: substituted,
        frontmatter: loaded.frontmatter,
        resources: loaded.resources,
        bytes,
    })
}
