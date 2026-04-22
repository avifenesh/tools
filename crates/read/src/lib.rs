//! Read tool — Rust port of `@agent-sh/harness-read`.
//!
//! Conforms to `agent-knowledge/design/read.md`. Same contract as the TS
//! package: discriminated-union result (`text | directory | attachment |
//! error`), 1-indexed offset/limit pagination, binary sniff, NOT_FOUND
//! with fuzzy sibling suggestions.

mod binary;
mod constants;
mod fence;
mod format;
mod lines;
mod run;
mod schema;
mod suggest;
mod types;

pub use binary::{is_binary, is_binary_by_content, is_binary_by_extension, is_image_mime, is_pdf_mime, mime_for};
pub use constants::*;
pub use format::{format_attachment, format_directory, format_text, FormatDirArgs, FormatTextArgs};
pub use lines::{stream_lines, StreamLinesOptions, StreamLinesResult};
pub use schema::{
    safe_parse_read_params, ReadParams, ReadParseError, READ_TOOL_DESCRIPTION, READ_TOOL_NAME,
};
pub use suggest::suggest_siblings;
pub use types::{
    Attachment, AttachmentMeta, AttachmentReadResult, DirMeta, DirReadResult, ErrorReadResult,
    ReadResult, ReadSessionConfig, TextMeta, TextReadResult,
};

pub async fn read(
    params: serde_json::Value,
    session: &ReadSessionConfig,
) -> ReadResult {
    run::read_run(params, session).await
}
