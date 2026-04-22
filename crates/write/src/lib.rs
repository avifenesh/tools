//! Write/Edit/MultiEdit tool — Rust port of `@agent-sh/harness-write`.
//!
//! Contract matches `agent-knowledge/design/write.md` and the TS
//! package: atomic write via temp file + rename, read-before-edit
//! ledger enforcement (NOT_READ_THIS_SESSION / STALE_READ), fuzzy
//! candidates on OLD_STRING_NOT_FOUND, match locations on
//! OLD_STRING_NOT_UNIQUE, CRLF→LF normalization, sequential
//! MultiEdit pipeline with rollback on failure.

mod constants;
mod diff;
mod engine;
mod fence;
mod format;
mod ledger;
mod levenshtein;
mod matching;
mod normalize;
mod run;
mod schema;
mod types;

pub use constants::*;
pub use diff::unified_diff;
pub use engine::{apply_edit, apply_pipeline, ApplyResult, PipelineResult};
pub use ledger::{InMemoryLedger, Ledger, LedgerEntry};
pub use levenshtein::{levenshtein, similarity};
pub use matching::{
    build_match_locations, find_all_occurrences, find_fuzzy_candidates,
    substring_boundary_collisions,
};
pub use normalize::normalize_line_endings;
pub use run::{edit, multi_edit, write};
pub use schema::{
    safe_parse_edit_params, safe_parse_multi_edit_params, safe_parse_write_params,
    EDIT_TOOL_DESCRIPTION, EDIT_TOOL_NAME, EditParams, EditSpec, MULTIEDIT_TOOL_DESCRIPTION,
    MULTIEDIT_TOOL_NAME, MultiEditParams, WRITE_TOOL_DESCRIPTION, WRITE_TOOL_NAME, WriteParams,
    WriteParseError,
};
pub use types::{
    EditMeta, EditResult, ErrorResult, FuzzyCandidate, MatchLocation, MultiEditMeta,
    MultiEditResult, PreviewMeta, PreviewResult, TextWriteResult, WriteMeta, WriteResult,
    WriteSessionConfig,
};
