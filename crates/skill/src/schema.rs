use serde_json::Value;

use crate::constants::MAX_NAME_LENGTH;
use crate::types::{SkillArguments, SkillParams};

/// Regex source for validation: `^[a-z0-9]+(-[a-z0-9]+)*$`. We don't use
/// the `regex` crate to avoid the dep — a small hand-written state machine
/// is cheap and exactly matches the spec.
pub fn is_valid_skill_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_LENGTH {
        return false;
    }
    let bytes = name.as_bytes();
    // Must start with [a-z0-9]
    if !is_name_char(bytes[0]) {
        return false;
    }
    // Must end with [a-z0-9]
    if !is_name_char(bytes[bytes.len() - 1]) {
        return false;
    }
    let mut prev_hyphen = false;
    for &b in bytes {
        if b == b'-' {
            if prev_hyphen {
                return false;
            }
            prev_hyphen = true;
        } else if is_name_char(b) {
            prev_hyphen = false;
        } else {
            return false;
        }
    }
    true
}

fn is_name_char(b: u8) -> bool {
    matches!(b, b'a'..=b'z' | b'0'..=b'9')
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum SkillParseError {
    #[error("{0}")]
    Message(String),
}

/// Alias table — mirrors packages/skill/src/schema.ts verbatim.
pub fn alias_hint(key: &str) -> Option<&'static str> {
    match key {
        "skill" => Some("unknown parameter 'skill'. Use 'name' instead."),
        "skill_name" => Some("unknown parameter 'skill_name'. Use 'name' instead."),
        "name_of_skill" => Some("unknown parameter 'name_of_skill'. Use 'name' instead."),
        "slug" => Some("unknown parameter 'slug'. Use 'name' instead."),

        "invoke" => Some("unknown parameter 'invoke'. Just call skill({name}); activation is implicit."),
        "activate" => Some("unknown parameter 'activate'. Just call skill({name}); activation is implicit."),
        "run" => Some("unknown parameter 'run'. Just call skill({name}); activation is implicit."),

        "args" => Some("unknown parameter 'args'. Use 'arguments' instead."),
        "args_string" => Some("unknown parameter 'args_string'. Use 'arguments' instead."),
        "input" => Some("unknown parameter 'input'. Use 'arguments' instead."),
        "params" => Some("unknown parameter 'params'. Use 'arguments' instead."),
        "parameters" => Some("unknown parameter 'parameters'. Use 'arguments' instead."),

        "context" => Some("unknown parameter 'context'. Skill context is session-scoped; no per-call override."),
        "session" => Some("unknown parameter 'session'. Skill context is session-scoped; no per-call override."),

        "reload" => Some("unknown parameter 'reload'. Skills load once per session; edit the skill file and restart the session to refresh."),
        "fresh" => Some("unknown parameter 'fresh'. Skills load once per session; edit the skill file and restart the session to refresh."),
        "force_reload" => Some("unknown parameter 'force_reload'. Skills load once per session; edit the skill file and restart the session to refresh."),
        "refresh" => Some("unknown parameter 'refresh'. Skills load once per session; edit the skill file and restart the session to refresh."),

        "fork" => Some("unknown parameter 'fork'. Subagent-forked skills are deferred to v1.1."),
        "subagent" => Some("unknown parameter 'subagent'. Subagent-forked skills are deferred to v1.1."),
        "isolated" => Some("unknown parameter 'isolated'. Subagent-forked skills are deferred to v1.1."),

        "paths" => Some("unknown parameter 'paths'. Auto-activation gating on file paths is deferred to v1.1."),
        "scope_paths" => Some("unknown parameter 'scope_paths'. Auto-activation gating on file paths is deferred to v1.1."),

        "model" => Some("unknown parameter 'model'. Model override is a harness concern, not a tool parameter."),
        "effort" => Some("unknown parameter 'effort'. Effort override is a harness concern, not a tool parameter."),

        "file" => Some("unknown parameter 'file'. Skills dispatch by 'name', not path; the harness owns discovery."),
        "file_path" => Some("unknown parameter 'file_path'. Skills dispatch by 'name', not path; the harness owns discovery."),
        "skill_path" => Some("unknown parameter 'skill_path'. Skills dispatch by 'name', not path; the harness owns discovery."),
        "dir" => Some("unknown parameter 'dir'. Skills dispatch by 'name', not path; the harness owns discovery."),
        _ => None,
    }
}

fn canonical_fields() -> &'static [&'static str] {
    &["name", "arguments"]
}

pub fn safe_parse_skill_params(input: &Value) -> Result<SkillParams, SkillParseError> {
    // Alias pushback first — before structural parsing — so the model
    // gets a targeted hint rather than a generic "unknown field" error.
    if let Some(obj) = input.as_object() {
        let canonical = canonical_fields();
        let mut hints: Vec<String> = Vec::new();
        let mut unknown: Vec<String> = Vec::new();
        for key in obj.keys() {
            if canonical.contains(&key.as_str()) {
                continue;
            }
            if let Some(h) = alias_hint(key.as_str()) {
                hints.push(h.to_string());
            } else {
                unknown.push(format!("unknown parameter '{}'.", key));
            }
        }
        if !hints.is_empty() || !unknown.is_empty() {
            let mut msgs = hints;
            msgs.extend(unknown);
            return Err(SkillParseError::Message(msgs.join("; ")));
        }
    }

    // Structural parse.
    let name = match input.get("name") {
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err(SkillParseError::Message("name must be a string".into())),
        None => return Err(SkillParseError::Message("name is required".into())),
    };

    if name.is_empty() {
        return Err(SkillParseError::Message("name must not be empty".into()));
    }
    if name.len() > MAX_NAME_LENGTH {
        return Err(SkillParseError::Message(format!(
            "name exceeds {} chars",
            MAX_NAME_LENGTH
        )));
    }
    if !is_valid_skill_name(&name) {
        return Err(SkillParseError::Message(
            "name must be lowercase-kebab-case (/^[a-z0-9]+(-[a-z0-9]+)*$/)".into(),
        ));
    }

    let arguments = match input.get("arguments") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(SkillArguments::String(s.clone())),
        Some(Value::Object(map)) => {
            let mut out = std::collections::HashMap::new();
            for (k, v) in map {
                match v {
                    Value::String(s) => {
                        out.insert(k.clone(), s.clone());
                    }
                    _ => {
                        return Err(SkillParseError::Message(
                            "'arguments' object values must be strings".into(),
                        ));
                    }
                }
            }
            Some(SkillArguments::Object(out))
        }
        Some(_) => {
            return Err(SkillParseError::Message(
                "'arguments' must be a string or an object of string→string".into(),
            ));
        }
    };

    Ok(SkillParams { name, arguments })
}

pub const SKILL_TOOL_NAME: &str = "skill";

pub const SKILL_TOOL_DESCRIPTION: &str = "Activate an installed skill by name. A skill is a reusable package of instructions, optional scripts, and reference docs, authored as a folder at `skill-name/SKILL.md`. Activating loads the skill's body into the conversation for the rest of the session.\n\nWhen to use. Activate a skill when the user's request matches its description. The catalog of installed skills, each with name and short description, is always visible in your tool-call context. If two skills plausibly apply, pick the one whose description most precisely matches.\n\nIdempotence. Activating the same skill twice in one session is a no-op — the body is already loaded. The tool returns an `already_loaded` marker so you know the content is still in context.\n\nArguments. Pass `arguments` as a string for positional skills (those declaring `$ARGUMENTS` or `$1`/`$2`) or as a JSON object for skills that declare named arguments in frontmatter. Run without arguments if the skill doesn't need them.\n\nPermission. Activation runs through the session's permission hook. A skill's `allowed-tools` frontmatter is an advisory declaration of what tools it expects to need — it does not pre-approve anything; downstream tool calls still pass the session's permission hook.";
