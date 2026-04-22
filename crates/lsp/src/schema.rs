use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::LspOperation;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LspParams {
    pub operation: LspOperation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_limit: Option<usize>,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum LspParseError {
    #[error("{0}")]
    Message(String),
}

fn alias_hint(key: &str) -> Option<&'static str> {
    match key {
        "op" => Some("unknown parameter 'op'. Use 'operation' instead."),
        "action" => Some("unknown parameter 'action'. Use 'operation' instead."),
        "verb" => Some("unknown parameter 'verb'. Use 'operation' instead."),
        "method" => Some("unknown parameter 'method'. Use 'operation' instead."),

        "file" => Some("unknown parameter 'file'. Use 'path' instead."),
        "file_path" => Some("unknown parameter 'file_path'. Use 'path' instead."),
        "filename" => Some("unknown parameter 'filename'. Use 'path' instead."),
        "uri" => Some(
            "unknown parameter 'uri'. Use 'path' instead (absolute filesystem path, not a file:// URI).",
        ),

        "row" => Some("unknown parameter 'row'. Use 'line' instead (1-indexed)."),
        "line_number" => Some("unknown parameter 'line_number'. Use 'line' instead."),
        "ln" => Some("unknown parameter 'ln'. Use 'line' instead."),

        "col" => Some("unknown parameter 'col'. Use 'character' instead (1-indexed)."),
        "column" => Some("unknown parameter 'column'. Use 'character' instead."),
        "ch" => Some("unknown parameter 'ch'. Use 'character' instead."),
        "offset" => Some(
            "unknown parameter 'offset'. Use 'character' instead (1-indexed column, not byte offset).",
        ),

        "symbol" => Some("unknown parameter 'symbol'. Use 'query' instead (for workspaceSymbol)."),
        "term" => Some("unknown parameter 'term'. Use 'query' instead."),
        "name" => Some(
            "unknown parameter 'name'. Use 'query' instead (for workspaceSymbol) or call 'definition' with a path+position.",
        ),
        "pattern" => Some("unknown parameter 'pattern'. Use 'query' instead."),

        "limit" => Some("unknown parameter 'limit'. Use 'head_limit' instead (default 200)."),
        "max_results" => Some(
            "unknown parameter 'max_results'. Use 'head_limit' instead (default 200).",
        ),
        "max_count" => Some(
            "unknown parameter 'max_count'. Use 'head_limit' instead (default 200).",
        ),

        "language" => Some(
            "unknown parameter 'language'. Language is detected automatically from the 'path' extension via .lsp.json. For cross-language workspaceSymbol, the session's primary language is used.",
        ),
        "lang" => Some(
            "unknown parameter 'lang'. Language is detected automatically from 'path'.",
        ),
        "include_declaration" => Some(
            "unknown parameter 'include_declaration'. References always include the declaration in v1; no per-call toggle.",
        ),
        "open" => Some(
            "unknown parameter 'open'. File sync (didOpen/didChange) is handled internally; don't manage it manually.",
        ),
        "didOpen" => Some(
            "unknown parameter 'didOpen'. File sync is handled internally by the tool.",
        ),
        "start_position" => Some(
            "unknown parameter 'start_position'. Use 'line' + 'character' (1-indexed, single position).",
        ),
        "end_position" => Some(
            "unknown parameter 'end_position'. Use 'line' + 'character' (1-indexed, single position).",
        ),
        "range" => Some(
            "unknown parameter 'range'. LSP operations take a single position; use 'line' + 'character'.",
        ),
        _ => None,
    }
}

fn canonical_fields() -> &'static [&'static str] {
    &["operation", "path", "line", "character", "query", "head_limit"]
}

pub enum LspValidateResult {
    Ok,
    Err(String),
}

/// Cross-field validation — strictObject passes, now we verify the
/// per-operation required fields.
pub fn validate_per_op(params: &LspParams) -> LspValidateResult {
    let op = params.operation;
    let needs_pos = matches!(
        op,
        LspOperation::Hover
            | LspOperation::Definition
            | LspOperation::References
            | LspOperation::Implementation
    );
    let needs_path = needs_pos || matches!(op, LspOperation::DocumentSymbol);
    if needs_path && params.path.is_none() {
        return LspValidateResult::Err(format!(
            "operation '{}' requires 'path'",
            op.as_str()
        ));
    }
    if needs_pos && (params.line.is_none() || params.character.is_none()) {
        return LspValidateResult::Err(format!(
            "operation '{}' requires 'line' and 'character' (both 1-indexed)",
            op.as_str()
        ));
    }
    if matches!(op, LspOperation::WorkspaceSymbol) {
        match &params.query {
            None => {
                return LspValidateResult::Err(
                    "operation 'workspaceSymbol' requires a non-empty 'query'".to_string(),
                );
            }
            Some(q) if q.is_empty() => {
                return LspValidateResult::Err(
                    "operation 'workspaceSymbol' requires a non-empty 'query'".to_string(),
                );
            }
            _ => {}
        }
    }
    if let Some(line) = params.line {
        if line < 1 {
            return LspValidateResult::Err("line is 1-indexed; must be >= 1".to_string());
        }
    }
    if let Some(ch) = params.character {
        if ch < 1 {
            return LspValidateResult::Err(
                "character is 1-indexed; must be >= 1".to_string(),
            );
        }
    }
    if let Some(hl) = params.head_limit {
        if hl < 1 {
            return LspValidateResult::Err("head_limit must be >= 1".to_string());
        }
    }
    LspValidateResult::Ok
}

pub fn safe_parse_lsp_params(input: &Value) -> Result<LspParams, LspParseError> {
    if let Some(obj) = input.as_object() {
        let canonical = canonical_fields();
        let mut hints: Vec<String> = Vec::new();
        let mut unknown: Vec<String> = Vec::new();
        for key in obj.keys() {
            if canonical.contains(&key.as_str()) {
                continue;
            }
            if let Some(hint) = alias_hint(key.as_str()) {
                hints.push(hint.to_string());
            } else {
                unknown.push(format!("unknown parameter '{}'.", key));
            }
        }
        if !hints.is_empty() || !unknown.is_empty() {
            let mut msgs = hints;
            msgs.extend(unknown);
            return Err(LspParseError::Message(msgs.join("; ")));
        }
    }
    let parsed: LspParams = serde_json::from_value(input.clone())
        .map_err(|e| LspParseError::Message(e.to_string()))?;
    match validate_per_op(&parsed) {
        LspValidateResult::Ok => Ok(parsed),
        LspValidateResult::Err(m) => Err(LspParseError::Message(m)),
    }
}

pub const LSP_TOOL_NAME: &str = "lsp";
pub const LSP_TOOL_DESCRIPTION: &str = "Language-server operations for code navigation: hover, definition, references, document and workspace symbols, implementation. Positions are 1-INDEXED (matches grep/read output).\n\nOperations:\n- hover: type and documentation for the symbol at path:line:character.\n- definition: where the symbol at path:line:character is defined.\n- references: every place the symbol at path:line:character is used (capped at head_limit, default 200).\n- documentSymbol: outline of all symbols in 'path' (no position needed).\n- workspaceSymbol: find symbols matching 'query' across the workspace.\n- implementation: for an interface or abstract method, which concrete types implement it.\n\nUsage:\n- Positions are 1-INDEXED. Line 1 is the first line; character 1 is the first column. If you have positions from grep or Read output, use them directly.\n- First call for a language spawns its language server. If the server is still indexing, the tool returns 'server_starting' with a retry hint. Wait the suggested time and call again.\n- Diagnostics (compiler errors, lints) run AUTOMATICALLY after Write/Edit calls; you see them in the post-edit hook output. Do NOT ask for them via this tool.\n- Language is detected from the path extension via .lsp.json; no per-call language parameter.";
