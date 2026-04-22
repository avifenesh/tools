use harness_core::{ToolError, ToolErrorCode};
use harness_read::is_binary;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::constants::{BINARY_SAMPLE_BYTES, MAX_EDIT_FILE_SIZE};
use crate::diff::{unified_diff, UnifiedDiffArgs};
use crate::engine::{apply_edit, apply_pipeline, PipelineResult};
use crate::fence::{fence_write, sha256_hex};
use crate::format::{
    format_edit_success, format_multi_edit_success, format_preview, format_write_success,
    FormatEditArgs, FormatMultiEditArgs, FormatPreviewArgs, FormatWriteArgs,
};
use crate::ledger::LedgerEntry;
use crate::schema::{
    safe_parse_edit_params, safe_parse_multi_edit_params, safe_parse_write_params, EditParams,
    EditSpec, MultiEditParams, WriteParams,
};
use crate::types::{
    AnyMeta, EditMeta, EditResult, ErrorResult, MultiEditMeta, MultiEditResult, PreviewMeta,
    PreviewResult, TextWriteResult, WriteMeta, WriteResult, WriteSessionConfig,
};

fn err_w(error: ToolError) -> WriteResult {
    WriteResult::Error(ErrorResult { error })
}
fn err_e(error: ToolError) -> EditResult {
    EditResult::Error(ErrorResult { error })
}
fn err_m(error: ToolError) -> MultiEditResult {
    MultiEditResult::Error(ErrorResult { error })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- write ----

pub async fn write(input: Value, session: &WriteSessionConfig) -> WriteResult {
    let params = match safe_parse_write_params(&input) {
        Ok(p) => p,
        Err(e) => return err_w(ToolError::new(ToolErrorCode::InvalidParam, e.to_string())),
    };

    let resolved = resolve_path(&session.cwd, &params.path).await;
    if let Some(e) = fence_write(&session.permissions, &resolved) {
        return err_w(e);
    }

    execute_write(session, &resolved, &params).await
}

async fn execute_write(
    session: &WriteSessionConfig,
    resolved: &Path,
    params: &WriteParams,
) -> WriteResult {
    let meta_res = tokio::fs::metadata(resolved).await;
    let exists = meta_res.as_ref().map(|m| m.is_file()).unwrap_or(false);
    let is_dir = meta_res.as_ref().map(|m| m.is_dir()).unwrap_or(false);
    if is_dir {
        return err_w(
            ToolError::new(
                ToolErrorCode::InvalidParam,
                format!("Path is a directory, not a file: {}", resolved.to_string_lossy()),
            )
            .with_meta(serde_json::json!({ "path": resolved.to_string_lossy() })),
        );
    }

    let mut previous_sha: Option<String> = None;
    let mut previous_bytes: u64 = 0;

    if exists {
        let existing = match tokio::fs::read(resolved).await {
            Ok(b) => b,
            Err(e) => {
                return err_w(ToolError::new(
                    ToolErrorCode::IoError,
                    format!("read failed: {}", e),
                ));
            }
        };
        previous_bytes = existing.len() as u64;
        let cur_sha = sha256_hex(&existing);
        previous_sha = Some(cur_sha.clone());

        let ledger = session.ledger.get_latest(&resolved.to_string_lossy());
        let entry = match ledger {
            Some(e) => e,
            None => {
                return err_w(
                    ToolError::new(
                        ToolErrorCode::NotReadThisSession,
                        format!(
                            "Write refuses to overwrite a file that has not been Read in this session: {}\n\nCall Read on this path first, then retry Write.",
                            resolved.to_string_lossy()
                        ),
                    )
                    .with_meta(serde_json::json!({ "path": resolved.to_string_lossy() })),
                );
            }
        };
        if entry.sha256 != cur_sha {
            return err_w(
                ToolError::new(
                    ToolErrorCode::StaleRead,
                    format!(
                        "File has changed on disk since the last Read: {}\n\nOld sha256: {}\nNew sha256: {}\n\nRe-Read the file to refresh the ledger, then retry Write.",
                        resolved.to_string_lossy(),
                        entry.sha256,
                        cur_sha
                    ),
                )
                .with_meta(serde_json::json!({
                    "path": resolved.to_string_lossy(),
                    "ledger_sha256": entry.sha256,
                    "current_sha256": cur_sha,
                })),
            );
        }
    }

    if !exists {
        if let Some(parent) = resolved.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return err_w(ToolError::new(
                    ToolErrorCode::IoError,
                    format!("mkdir failed: {}", e),
                ));
            }
        }
    }

    let bytes = params.content.as_bytes();
    if let Err(e) = atomic_write(resolved, bytes).await {
        return err_w(ToolError::new(
            ToolErrorCode::IoError,
            format!("write failed: {}", e),
        ));
    }

    let new_sha = sha256_hex(bytes);
    let mtime = tokio::fs::metadata(resolved)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now_ms);

    session.ledger.record(LedgerEntry {
        path: resolved.to_string_lossy().into_owned(),
        sha256: new_sha.clone(),
        mtime_ms: mtime,
        size_bytes: bytes.len() as u64,
        timestamp_ms: now_ms(),
    });

    let output = format_write_success(FormatWriteArgs {
        path: &resolved.to_string_lossy(),
        created: !exists,
        bytes_before: previous_bytes,
        bytes_after: bytes.len() as u64,
    });

    WriteResult::Text(TextWriteResult {
        output,
        meta: AnyMeta::Write(WriteMeta {
            path: resolved.to_string_lossy().into_owned(),
            bytes_written: bytes.len() as u64,
            sha256: new_sha,
            mtime_ms: mtime,
            created: !exists,
            previous_sha256: previous_sha,
        }),
    })
}

// ---- edit ----

struct Preflight {
    existing_content: String,
    existing_bytes: Vec<u8>,
    previous_sha: String,
}

async fn preflight_mutation(
    session: &WriteSessionConfig,
    resolved: &Path,
) -> Result<Preflight, ToolError> {
    let meta = tokio::fs::metadata(resolved).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ToolError::new(
                ToolErrorCode::NotFound,
                format!(
                    "File not found: {}. Edit requires an existing file; use Write to create new files.",
                    resolved.to_string_lossy()
                ),
            )
            .with_meta(serde_json::json!({ "path": resolved.to_string_lossy() }))
        } else {
            ToolError::new(
                ToolErrorCode::IoError,
                format!("stat failed: {}", e),
            )
        }
    })?;

    if meta.is_dir() {
        return Err(ToolError::new(
            ToolErrorCode::InvalidParam,
            format!("Path is a directory, not a file: {}", resolved.to_string_lossy()),
        )
        .with_meta(serde_json::json!({ "path": resolved.to_string_lossy() })));
    }

    let max_size = session.max_file_size.unwrap_or(MAX_EDIT_FILE_SIZE);
    if meta.len() > max_size {
        return Err(ToolError::new(
            ToolErrorCode::TooLarge,
            format!(
                "File size {} exceeds max {} for in-memory edit. Narrow the file or use a streaming tool.",
                meta.len(),
                max_size
            ),
        )
        .with_meta(serde_json::json!({
            "path": resolved.to_string_lossy(),
            "size": meta.len(),
            "max": max_size,
        })));
    }

    let bytes = tokio::fs::read(resolved).await.map_err(|e| {
        ToolError::new(
            ToolErrorCode::IoError,
            format!("read failed: {}", e),
        )
    })?;

    let sample_end = BINARY_SAMPLE_BYTES.min(bytes.len());
    if is_binary(&resolved.to_string_lossy(), &bytes[..sample_end]) {
        return Err(ToolError::new(
            ToolErrorCode::BinaryNotEditable,
            format!(
                "Cannot Edit binary file: {}. Use Write to replace binary content wholesale if intentional.",
                resolved.to_string_lossy()
            ),
        )
        .with_meta(serde_json::json!({ "path": resolved.to_string_lossy() })));
    }

    let current_sha = sha256_hex(&bytes);
    let ledger = session.ledger.get_latest(&resolved.to_string_lossy());
    let entry = match ledger {
        Some(e) => e,
        None => {
            return Err(ToolError::new(
                ToolErrorCode::NotReadThisSession,
                format!(
                    "File has not been Read in this session: {}\n\nCall Read on this path first, then retry the edit.",
                    resolved.to_string_lossy()
                ),
            )
            .with_meta(serde_json::json!({ "path": resolved.to_string_lossy() })));
        }
    };
    if entry.sha256 != current_sha {
        return Err(ToolError::new(
            ToolErrorCode::StaleRead,
            format!(
                "File has changed on disk since the last Read: {}\n\nOld sha256: {}\nNew sha256: {}\n\nRe-Read the file to refresh the ledger, then retry the edit.",
                resolved.to_string_lossy(),
                entry.sha256,
                current_sha
            ),
        )
        .with_meta(serde_json::json!({
            "path": resolved.to_string_lossy(),
            "ledger_sha256": entry.sha256,
            "current_sha256": current_sha,
        })));
    }

    let content = String::from_utf8_lossy(&bytes).into_owned();
    Ok(Preflight {
        existing_content: content,
        existing_bytes: bytes,
        previous_sha: current_sha,
    })
}

pub async fn edit(input: Value, session: &WriteSessionConfig) -> EditResult {
    let params = match safe_parse_edit_params(&input) {
        Ok(p) => p,
        Err(e) => return err_e(ToolError::new(ToolErrorCode::InvalidParam, e.to_string())),
    };

    let resolved = resolve_path(&session.cwd, &params.path).await;
    if let Some(e) = fence_write(&session.permissions, &resolved) {
        return err_e(e);
    }

    execute_edit(session, &resolved, &params).await
}

async fn execute_edit(
    session: &WriteSessionConfig,
    resolved: &Path,
    params: &EditParams,
) -> EditResult {
    let pre = match preflight_mutation(session, resolved).await {
        Ok(p) => p,
        Err(e) => return err_e(e),
    };

    let edit_spec = EditSpec {
        old_string: params.old_string.clone(),
        new_string: params.new_string.clone(),
        replace_all: params.replace_all,
    };

    let result = match apply_edit(&pre.existing_content, &edit_spec) {
        Ok(r) => r,
        Err(e) => return err_e(e),
    };

    let new_content = result.content;
    let new_bytes = new_content.as_bytes();

    if params.dry_run.unwrap_or(false) {
        let diff = unified_diff(UnifiedDiffArgs {
            old_path: &resolved.to_string_lossy(),
            new_path: &resolved.to_string_lossy(),
            old_content: &pre.existing_content,
            new_content: &new_content,
        });
        return EditResult::Preview(PreviewResult {
            output: format_preview(FormatPreviewArgs {
                path: &resolved.to_string_lossy(),
                diff: &diff,
                would_write_bytes: new_bytes.len() as u64,
                bytes_before: pre.existing_bytes.len() as u64,
            }),
            diff,
            meta: PreviewMeta {
                path: resolved.to_string_lossy().into_owned(),
                would_write_bytes: new_bytes.len() as u64,
                bytes_delta: new_bytes.len() as i64 - pre.existing_bytes.len() as i64,
                previous_sha256: pre.previous_sha,
            },
        });
    }

    if let Err(e) = atomic_write(resolved, new_bytes).await {
        return err_e(ToolError::new(
            ToolErrorCode::IoError,
            format!("write failed: {}", e),
        ));
    }

    let new_sha = sha256_hex(new_bytes);
    let mtime = tokio::fs::metadata(resolved)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now_ms);

    session.ledger.record(LedgerEntry {
        path: resolved.to_string_lossy().into_owned(),
        sha256: new_sha.clone(),
        mtime_ms: mtime,
        size_bytes: new_bytes.len() as u64,
        timestamp_ms: now_ms(),
    });

    EditResult::Text(TextWriteResult {
        output: format_edit_success(FormatEditArgs {
            path: &resolved.to_string_lossy(),
            replacements: result.replacements,
            replace_all: params.replace_all.unwrap_or(false),
            bytes_before: pre.existing_bytes.len() as u64,
            bytes_after: new_bytes.len() as u64,
            warnings: &result.warnings,
        }),
        meta: AnyMeta::Edit(EditMeta {
            path: resolved.to_string_lossy().into_owned(),
            replacements: result.replacements,
            bytes_delta: new_bytes.len() as i64 - pre.existing_bytes.len() as i64,
            sha256: new_sha,
            mtime_ms: mtime,
            previous_sha256: pre.previous_sha,
            warnings: if result.warnings.is_empty() {
                None
            } else {
                Some(result.warnings)
            },
        }),
    })
}

// ---- multiedit ----

pub async fn multi_edit(input: Value, session: &WriteSessionConfig) -> MultiEditResult {
    let params = match safe_parse_multi_edit_params(&input) {
        Ok(p) => p,
        Err(e) => return err_m(ToolError::new(ToolErrorCode::InvalidParam, e.to_string())),
    };

    let resolved = resolve_path(&session.cwd, &params.path).await;
    if let Some(e) = fence_write(&session.permissions, &resolved) {
        return err_m(e);
    }

    execute_multi_edit(session, &resolved, &params).await
}

async fn execute_multi_edit(
    session: &WriteSessionConfig,
    resolved: &Path,
    params: &MultiEditParams,
) -> MultiEditResult {
    let pre = match preflight_mutation(session, resolved).await {
        Ok(p) => p,
        Err(e) => return err_m(e),
    };

    let edits: Vec<EditSpec> = params
        .edits
        .iter()
        .map(|e| EditSpec {
            old_string: e.old_string.clone(),
            new_string: e.new_string.clone(),
            replace_all: e.replace_all,
        })
        .collect();

    let pipeline = apply_pipeline(&pre.existing_content, &edits);
    let (new_content, total_replacements, warnings) = match pipeline {
        PipelineResult::Ok {
            content,
            total_replacements,
            warnings,
        } => (content, total_replacements, warnings),
        PipelineResult::Err { error, .. } => return err_m(error),
    };

    let new_bytes = new_content.as_bytes();

    if params.dry_run.unwrap_or(false) {
        let diff = unified_diff(UnifiedDiffArgs {
            old_path: &resolved.to_string_lossy(),
            new_path: &resolved.to_string_lossy(),
            old_content: &pre.existing_content,
            new_content: &new_content,
        });
        return MultiEditResult::Preview(PreviewResult {
            output: format_preview(FormatPreviewArgs {
                path: &resolved.to_string_lossy(),
                diff: &diff,
                would_write_bytes: new_bytes.len() as u64,
                bytes_before: pre.existing_bytes.len() as u64,
            }),
            diff,
            meta: PreviewMeta {
                path: resolved.to_string_lossy().into_owned(),
                would_write_bytes: new_bytes.len() as u64,
                bytes_delta: new_bytes.len() as i64 - pre.existing_bytes.len() as i64,
                previous_sha256: pre.previous_sha,
            },
        });
    }

    if let Err(e) = atomic_write(resolved, new_bytes).await {
        return err_m(ToolError::new(
            ToolErrorCode::IoError,
            format!("write failed: {}", e),
        ));
    }

    let new_sha = sha256_hex(new_bytes);
    let mtime = tokio::fs::metadata(resolved)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now_ms);

    session.ledger.record(LedgerEntry {
        path: resolved.to_string_lossy().into_owned(),
        sha256: new_sha.clone(),
        mtime_ms: mtime,
        size_bytes: new_bytes.len() as u64,
        timestamp_ms: now_ms(),
    });

    MultiEditResult::Text(TextWriteResult {
        output: format_multi_edit_success(FormatMultiEditArgs {
            path: &resolved.to_string_lossy(),
            edits_applied: edits.len(),
            total_replacements,
            bytes_before: pre.existing_bytes.len() as u64,
            bytes_after: new_bytes.len() as u64,
            warnings: &warnings,
        }),
        meta: AnyMeta::MultiEdit(MultiEditMeta {
            path: resolved.to_string_lossy().into_owned(),
            edits_applied: edits.len(),
            total_replacements,
            bytes_delta: new_bytes.len() as i64 - pre.existing_bytes.len() as i64,
            sha256: new_sha,
            mtime_ms: mtime,
            previous_sha256: pre.previous_sha,
            warnings: if warnings.is_empty() { None } else { Some(warnings) },
        }),
    })
}

// ---- helpers ----

async fn resolve_path(cwd: &str, input: &str) -> PathBuf {
    let abs: PathBuf = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        Path::new(cwd).join(input)
    };
    tokio::fs::canonicalize(&abs).await.unwrap_or(abs)
}

async fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp_name = format!(".{}.tmp-{}", uuid::Uuid::new_v4(), std::process::id());
    let tmp_path = parent.join(tmp_name);
    tokio::fs::write(&tmp_path, bytes).await?;
    tokio::fs::rename(&tmp_path, path).await?;
    Ok(())
}
