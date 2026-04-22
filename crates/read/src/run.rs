use base64::{engine::general_purpose::STANDARD, Engine as _};
use harness_core::{ToolError, ToolErrorCode};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::binary::{is_binary, is_image_mime, is_pdf_mime, mime_for};
use crate::constants::{
    BINARY_SAMPLE_BYTES, DEFAULT_LIMIT, MAX_FILE_SIZE,
};
use crate::fence::fence_read;
use crate::format::{
    format_attachment, format_directory, format_text, FormatDirArgs, FormatTextArgs,
};
use crate::lines::{stream_lines, StreamLinesOptions};
use crate::schema::safe_parse_read_params;
use crate::suggest::suggest_siblings;
use crate::types::{
    Attachment, AttachmentMeta, AttachmentReadResult, DirMeta, DirReadResult, ErrorReadResult,
    ReadResult, ReadSessionConfig, TextMeta, TextReadResult,
};

fn err(error: ToolError) -> ReadResult {
    ReadResult::Error(ErrorReadResult { error })
}

pub async fn read_run(input: Value, session: &ReadSessionConfig) -> ReadResult {
    let params = match safe_parse_read_params(&input) {
        Ok(p) => p,
        Err(e) => return err(ToolError::new(ToolErrorCode::InvalidParam, e.to_string())),
    };

    let resolved = resolve_path(&session.cwd, &params.path).await;
    if let Some(e) = fence_read(&session.permissions, &resolved) {
        return err(e);
    }

    let stat = match tokio::fs::metadata(&resolved).await {
        Ok(m) => m,
        Err(_) => {
            let suggestions = suggest_siblings(&resolved).await;
            let base = format!("File not found: {}", resolved.to_string_lossy());
            let msg = if suggestions.is_empty() {
                base
            } else {
                format!("{}\n\nDid you mean one of these?\n{}", base, suggestions.join("\n"))
            };
            return err(ToolError::new(ToolErrorCode::NotFound, msg).with_meta(
                serde_json::json!({
                    "path": resolved.to_string_lossy(),
                    "suggestions": suggestions,
                }),
            ));
        }
    };

    if stat.is_dir() {
        return read_directory(&resolved, params.offset, params.limit).await;
    }

    let max_size = session.max_file_size.unwrap_or(MAX_FILE_SIZE);
    if stat.len() > max_size {
        return err(ToolError::new(
            ToolErrorCode::TooLarge,
            format!(
                "File size {} exceeds max {}. Use a narrower offset/limit or grep first.",
                stat.len(),
                max_size
            ),
        )
        .with_meta(serde_json::json!({
            "path": resolved.to_string_lossy(),
            "size": stat.len(),
            "maxSize": max_size,
        })));
    }

    if let Some(ctx) = session.model_context_tokens {
        let half = ctx / 2;
        let tpb = session.tokens_per_byte.unwrap_or(0.3);
        let estimated = (stat.len() as f64 * tpb) as u64;
        if estimated > half {
            return err(ToolError::new(
                ToolErrorCode::TooLarge,
                format!(
                    "File would consume more than half of the model context (~{} tokens > {}). Use offset/limit or grep first.",
                    estimated, half
                ),
            )
            .with_meta(serde_json::json!({
                "path": resolved.to_string_lossy(),
                "size": stat.len(),
                "half": half,
            })));
        }
    }

    let mime = mime_for(&resolved.to_string_lossy());
    if is_image_mime(&mime) || is_pdf_mime(&mime) {
        return read_attachment(&resolved, &mime, stat.len()).await;
    }

    let sample = read_sample(&resolved, stat.len()).await;
    if is_binary(&resolved.to_string_lossy(), &sample) {
        return err(ToolError::new(
            ToolErrorCode::Binary,
            format!("Cannot read binary file: {}", resolved.to_string_lossy()),
        )
        .with_meta(serde_json::json!({ "path": resolved.to_string_lossy() })));
    }

    read_text(session, &resolved, &stat, params.offset, params.limit).await
}

async fn resolve_path(cwd: &str, input: &str) -> PathBuf {
    let abs: PathBuf = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        Path::new(cwd).join(input)
    };
    tokio::fs::canonicalize(&abs).await.unwrap_or(abs)
}

async fn read_sample(path: &Path, size: u64) -> Vec<u8> {
    if size == 0 {
        return Vec::new();
    }
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            if bytes.len() > BINARY_SAMPLE_BYTES {
                bytes[..BINARY_SAMPLE_BYTES].to_vec()
            } else {
                bytes
            }
        }
        Err(_) => Vec::new(),
    }
}

async fn read_directory(
    resolved: &Path,
    offset: Option<usize>,
    limit: Option<usize>,
) -> ReadResult {
    let mut read_dir = match tokio::fs::read_dir(resolved).await {
        Ok(r) => r,
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("readdir failed: {}", e),
            ));
        }
    };
    let mut named: Vec<String> = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let file_name = match entry.file_name().to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };
        let file_type = match entry.file_type().await {
            Ok(ft) => ft,
            Err(_) => {
                named.push(file_name);
                continue;
            }
        };
        if file_type.is_dir() {
            named.push(format!("{}/", file_name));
        } else if file_type.is_symlink() {
            let full = resolved.join(&file_name);
            let target_is_dir = tokio::fs::metadata(&full)
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false);
            if target_is_dir {
                named.push(format!("{}/", file_name));
            } else {
                named.push(file_name);
            }
        } else {
            named.push(file_name);
        }
    }
    named.sort_by(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));

    let offset = offset.unwrap_or(1);
    let limit = limit.unwrap_or(DEFAULT_LIMIT);
    let start = offset.saturating_sub(1);
    let sliced: Vec<String> = named.iter().skip(start).take(limit).cloned().collect();
    let more = start + sliced.len() < named.len();

    let out = format_directory(FormatDirArgs {
        path: &resolved.to_string_lossy(),
        entries: &sliced,
        offset,
        total_entries: named.len(),
        more,
    });

    ReadResult::Directory(DirReadResult {
        output: out,
        meta: DirMeta {
            path: resolved.to_string_lossy().into_owned(),
            total_entries: named.len(),
            returned_entries: sliced.len(),
            offset,
            limit,
            more,
        },
    })
}

async fn read_attachment(resolved: &Path, mime: &str, size: u64) -> ReadResult {
    let bytes = match tokio::fs::read(resolved).await {
        Ok(b) => b,
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("readFile failed: {}", e),
            ));
        }
    };
    let kind = if is_pdf_mime(mime) { "PDF" } else { "Image" };
    let data_url = format!("data:{};base64,{}", mime, STANDARD.encode(&bytes));
    ReadResult::Attachment(AttachmentReadResult {
        output: format_attachment(kind),
        attachments: vec![Attachment {
            mime: mime.to_string(),
            data_url,
        }],
        meta: AttachmentMeta {
            path: resolved.to_string_lossy().into_owned(),
            mime: mime.to_string(),
            size_bytes: size,
        },
    })
}

async fn read_text(
    session: &ReadSessionConfig,
    resolved: &Path,
    stat: &std::fs::Metadata,
    offset: Option<usize>,
    limit: Option<usize>,
) -> ReadResult {
    let offset = offset.unwrap_or(1);
    let limit = limit.or(session.default_limit).unwrap_or(DEFAULT_LIMIT);

    let opts = StreamLinesOptions {
        offset,
        limit,
        max_bytes: session.max_bytes,
        max_line_length: session.max_line_length,
    };
    let res = match stream_lines(resolved, opts).await {
        Ok(r) => r,
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("stream_lines failed: {}", e),
            ));
        }
    };

    if res.total_lines > 0 && offset > res.total_lines {
        return err(ToolError::new(
            ToolErrorCode::InvalidParam,
            format!(
                "Offset {} is out of range for this file ({} lines)",
                offset, res.total_lines
            ),
        )
        .with_meta(serde_json::json!({
            "path": resolved.to_string_lossy(),
            "totalLines": res.total_lines,
        })));
    }

    let bytes = match tokio::fs::read(resolved).await {
        Ok(b) => b,
        Err(e) => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!("readFile failed: {}", e),
            ));
        }
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let sha256 = hex_encode(&digest);

    let mtime_ms = stat
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let output = format_text(FormatTextArgs {
        path: &resolved.to_string_lossy(),
        offset,
        lines: &res.lines,
        total_lines: res.total_lines,
        more: res.more,
        byte_cap: res.byte_cap,
    });

    ReadResult::Text(TextReadResult {
        output,
        meta: TextMeta {
            path: resolved.to_string_lossy().into_owned(),
            total_lines: res.total_lines,
            returned_lines: res.lines.len(),
            offset,
            limit,
            byte_cap: res.byte_cap,
            more: res.more,
            sha256,
            mtime_ms,
            size_bytes: stat.len(),
        },
    })
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}
