use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Stable set of machine-readable error codes emitted by any harness tool.
///
/// Mirrors `ToolErrorCode` in `@agent-sh/harness-core`. The string form on
/// the wire uses the snake_case-ish shape the TS side has been shipping
/// (`NOT_FOUND`, `INVALID_PARAM`, ...) so a TS consumer parsing the
/// JSON-RPC result of a Rust tool sees the same codes it's already
/// pattern-matching on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ToolErrorCode {
    NotFound,
    Binary,
    TooLarge,
    OutsideWorkspace,
    Sensitive,
    PermissionDenied,
    InvalidParam,
    IoError,
    NotReadThisSession,
    StaleRead,
    OldStringNotFound,
    OldStringNotUnique,
    EmptyFile,
    NoOpEdit,
    BinaryNotEditable,
    NotebookUnsupported,
    DeniedByHook,
    ValidateFailed,
    InvalidRegex,
    Timeout,
    Killed,
    InvalidUrl,
    SsrfBlocked,
    DnsError,
    TlsError,
    ConnectionReset,
    Oversize,
    UnsupportedContentType,
    RedirectLoop,
    InteractiveDetected,
    ServerNotAvailable,
    ServerCrashed,
    PositionInvalid,
    InvalidFrontmatter,
    NameMismatch,
    Disabled,
    NotTrusted,
}

impl ToolErrorCode {
    /// Canonical wire form: `"INVALID_PARAM"`, `"NOT_FOUND"`, etc.
    pub fn as_str(&self) -> &'static str {
        // serde's SCREAMING_SNAKE_CASE produces the right strings, but
        // we hand-roll this for `Display` so error formatting doesn't
        // need to go through a serializer.
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::Binary => "BINARY",
            Self::TooLarge => "TOO_LARGE",
            Self::OutsideWorkspace => "OUTSIDE_WORKSPACE",
            Self::Sensitive => "SENSITIVE",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::InvalidParam => "INVALID_PARAM",
            Self::IoError => "IO_ERROR",
            Self::NotReadThisSession => "NOT_READ_THIS_SESSION",
            Self::StaleRead => "STALE_READ",
            Self::OldStringNotFound => "OLD_STRING_NOT_FOUND",
            Self::OldStringNotUnique => "OLD_STRING_NOT_UNIQUE",
            Self::EmptyFile => "EMPTY_FILE",
            Self::NoOpEdit => "NO_OP_EDIT",
            Self::BinaryNotEditable => "BINARY_NOT_EDITABLE",
            Self::NotebookUnsupported => "NOTEBOOK_UNSUPPORTED",
            Self::DeniedByHook => "DENIED_BY_HOOK",
            Self::ValidateFailed => "VALIDATE_FAILED",
            Self::InvalidRegex => "INVALID_REGEX",
            Self::Timeout => "TIMEOUT",
            Self::Killed => "KILLED",
            Self::InvalidUrl => "INVALID_URL",
            Self::SsrfBlocked => "SSRF_BLOCKED",
            Self::DnsError => "DNS_ERROR",
            Self::TlsError => "TLS_ERROR",
            Self::ConnectionReset => "CONNECTION_RESET",
            Self::Oversize => "OVERSIZE",
            Self::UnsupportedContentType => "UNSUPPORTED_CONTENT_TYPE",
            Self::RedirectLoop => "REDIRECT_LOOP",
            Self::InteractiveDetected => "INTERACTIVE_DETECTED",
            Self::ServerNotAvailable => "SERVER_NOT_AVAILABLE",
            Self::ServerCrashed => "SERVER_CRASHED",
            Self::PositionInvalid => "POSITION_INVALID",
            Self::InvalidFrontmatter => "INVALID_FRONTMATTER",
            Self::NameMismatch => "NAME_MISMATCH",
            Self::Disabled => "DISABLED",
            Self::NotTrusted => "NOT_TRUSTED",
        }
    }
}

/// Structured tool error, shape-compatible with the TS `ToolError`.
///
/// `meta` stores arbitrary JSON payload fields (e.g. `{"path": "...",
/// "siblings": [...]}`) that callers can inspect without parsing the
/// message text. `cause` is an opaque JSON blob preserving the
/// underlying error chain when available.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolError {
    pub code: ToolErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

impl ToolError {
    pub fn new(code: ToolErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cause: None,
            meta: None,
        }
    }

    pub fn with_meta(mut self, meta: Value) -> Self {
        self.meta = Some(meta);
        self
    }

    pub fn with_cause(mut self, cause: Value) -> Self {
        self.cause = Some(cause);
        self
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", format_tool_error(self))
    }
}

impl std::error::Error for ToolError {}

/// Canonical model-facing rendering: `"Error [CODE]: message"`. This is
/// the string the Node e2e harness reads from the tool_result block.
pub fn format_tool_error(err: &ToolError) -> String {
    format!("Error [{}]: {}", err.code.as_str(), err.message)
}
