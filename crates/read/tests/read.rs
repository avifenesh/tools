//! Integration tests for the Rust read port. Mirrors the critical cases
//! from `packages/read/test/read.test.ts`.

use harness_core::{PermissionPolicy, ToolErrorCode};
use harness_read::{read, ReadResult, ReadSessionConfig};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;
use tempfile::TempDir;

fn mk_session(dir: &Path) -> ReadSessionConfig {
    let root = fs::canonicalize(dir).unwrap().to_string_lossy().into_owned();
    let perms = PermissionPolicy::new([root.clone()]);
    ReadSessionConfig::new(root, perms)
}

fn write(dir: &Path, name: &str, content: &[u8]) -> String {
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let mut f = fs::File::create(&p).unwrap();
    f.write_all(content).unwrap();
    p.to_string_lossy().into_owned()
}

fn expect_text(r: &ReadResult) -> &harness_read::TextReadResult {
    match r {
        ReadResult::Text(t) => t,
        other => panic!("expected text, got: {:?}", other),
    }
}

fn expect_dir(r: &ReadResult) -> &harness_read::DirReadResult {
    match r {
        ReadResult::Directory(d) => d,
        other => panic!("expected directory, got: {:?}", other),
    }
}

fn expect_attachment(r: &ReadResult) -> &harness_read::AttachmentReadResult {
    match r {
        ReadResult::Attachment(a) => a,
        other => panic!("expected attachment, got: {:?}", other),
    }
}

fn expect_error(r: &ReadResult) -> &harness_read::ErrorReadResult {
    match r {
        ReadResult::Error(e) => e,
        other => panic!("expected error, got: {:?}", other),
    }
}

// ---- Schema ----

#[tokio::test]
async fn rejects_empty_path() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = read(json!({"path": ""}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
}

#[tokio::test]
async fn rejects_unknown_param() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = read(json!({"path": "x", "foo": 1}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
}

#[tokio::test]
async fn rejects_offset_zero() {
    let tmp = TempDir::new().unwrap();
    let path = write(tmp.path(), "a.txt", b"hi\n");
    let s = mk_session(tmp.path());
    let r = read(json!({"path": path, "offset": 0}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
}

// ---- Happy path ----

#[tokio::test]
async fn reads_text_file_with_cat_n_format() {
    let tmp = TempDir::new().unwrap();
    let path = write(tmp.path(), "a.txt", b"hello\nworld\n");
    let s = mk_session(tmp.path());
    let r = read(json!({"path": path}), &s).await;
    let t = expect_text(&r);
    assert!(t.output.contains("1: hello"));
    assert!(t.output.contains("2: world"));
    assert_eq!(t.meta.total_lines, 2);
}

#[tokio::test]
async fn paginates_with_offset_and_limit() {
    let tmp = TempDir::new().unwrap();
    let body: String = (1..=10).map(|i| format!("L{}\n", i)).collect();
    let path = write(tmp.path(), "big.txt", body.as_bytes());
    let s = mk_session(tmp.path());
    let r = read(json!({"path": path, "offset": 4, "limit": 3}), &s).await;
    let t = expect_text(&r);
    assert!(t.output.contains("4: L4"));
    assert!(t.output.contains("6: L6"));
    assert!(!t.output.contains("1: L1"));
    assert_eq!(t.meta.returned_lines, 3);
    assert!(t.meta.more);
}

#[tokio::test]
async fn offset_past_eof_errors() {
    let tmp = TempDir::new().unwrap();
    let path = write(tmp.path(), "a.txt", b"one\ntwo\n");
    let s = mk_session(tmp.path());
    let r = read(json!({"path": path, "offset": 99}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("out of range"));
}

#[tokio::test]
async fn empty_file_message() {
    let tmp = TempDir::new().unwrap();
    let path = write(tmp.path(), "empty.txt", b"");
    let s = mk_session(tmp.path());
    let r = read(json!({"path": path}), &s).await;
    let t = expect_text(&r);
    assert!(t.output.contains("(File exists but is empty)"));
}

// ---- Binary / attachment ----

#[tokio::test]
async fn rejects_binary_by_nul() {
    let tmp = TempDir::new().unwrap();
    let path = write(tmp.path(), "b.dat", b"abc\0def");
    let s = mk_session(tmp.path());
    let r = read(json!({"path": path}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::Binary);
}

#[tokio::test]
async fn rejects_binary_by_extension() {
    let tmp = TempDir::new().unwrap();
    let path = write(tmp.path(), "archive.zip", b"not zip content but ext is");
    let s = mk_session(tmp.path());
    let r = read(json!({"path": path}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::Binary);
}

#[tokio::test]
async fn returns_image_as_attachment() {
    let tmp = TempDir::new().unwrap();
    // PNG magic + trailing bytes
    let bytes: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
    let path = write(tmp.path(), "pic.png", bytes);
    let s = mk_session(tmp.path());
    let r = read(json!({"path": path}), &s).await;
    let a = expect_attachment(&r);
    assert_eq!(a.meta.mime, "image/png");
    assert!(a.attachments[0].data_url.starts_with("data:image/png;base64,"));
    assert!(a.output.contains("Image read successfully"));
}

// ---- Directory ----

#[tokio::test]
async fn lists_directory_sorted_with_trailing_slash() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "b.txt", b"");
    write(tmp.path(), "a.txt", b"");
    fs::create_dir_all(tmp.path().join("sub")).unwrap();
    let s = mk_session(tmp.path());
    let r = read(json!({"path": tmp.path().to_string_lossy()}), &s).await;
    let d = expect_dir(&r);
    assert_eq!(d.meta.total_entries, 3);
    assert!(d.output.contains("a.txt"));
    assert!(d.output.contains("b.txt"));
    assert!(d.output.contains("sub/"));
    let ai = d.output.find("a.txt").unwrap();
    let bi = d.output.find("b.txt").unwrap();
    assert!(ai < bi, "alphabetical order");
}

// ---- NOT_FOUND + fuzzy siblings ----

#[tokio::test]
async fn missing_file_suggests_siblings() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "config.ts", b"");
    write(tmp.path(), "configs.ts", b"");
    write(tmp.path(), "unrelated.md", b"");
    let target = tmp.path().join("config").to_string_lossy().into_owned();
    let s = mk_session(tmp.path());
    let r = read(json!({"path": target}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::NotFound);
    assert!(e.error.message.contains("Did you mean"));
    assert!(e.error.message.contains("config.ts") || e.error.message.contains("configs.ts"));
}

// ---- Fence ----

#[tokio::test]
async fn rejects_outside_workspace() {
    let tmp = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let outside_file = write(other.path(), "x.txt", b"hello");
    let s = mk_session(tmp.path()); // root = tmp; outside is in `other`
    let r = read(json!({"path": outside_file}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::OutsideWorkspace);
}

#[tokio::test]
async fn sensitive_pattern_blocks_when_no_hook() {
    let tmp = TempDir::new().unwrap();
    let path = write(tmp.path(), ".env", b"SECRET=x");
    let root = fs::canonicalize(tmp.path()).unwrap().to_string_lossy().into_owned();
    let mut perms = PermissionPolicy::new([root.clone()]);
    perms.sensitive_patterns = vec!["**/.env".to_string()];
    let s = ReadSessionConfig::new(root, perms);
    let r = read(json!({"path": path}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::Sensitive);
}

// ---- Too large ----

#[tokio::test]
async fn too_large_over_max_file_size() {
    let tmp = TempDir::new().unwrap();
    let body = vec![b'x'; 2000];
    let path = write(tmp.path(), "big.txt", &body);
    let root = fs::canonicalize(tmp.path()).unwrap().to_string_lossy().into_owned();
    let perms = PermissionPolicy::new([root.clone()]);
    let mut s = ReadSessionConfig::new(root, perms);
    s.max_file_size = Some(1000);
    let r = read(json!({"path": path}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::TooLarge);
}

// ---- Long-line truncation ----

#[tokio::test]
async fn truncates_long_lines() {
    let tmp = TempDir::new().unwrap();
    let long = "A".repeat(3000);
    let path = write(tmp.path(), "long.txt", long.as_bytes());
    let root = fs::canonicalize(tmp.path()).unwrap().to_string_lossy().into_owned();
    let perms = PermissionPolicy::new([root.clone()]);
    let mut s = ReadSessionConfig::new(root, perms);
    s.max_line_length = Some(100);
    let r = read(json!({"path": path}), &s).await;
    let t = expect_text(&r);
    assert!(t.output.contains("line truncated"));
}

// ---- Serialization shape ----

#[tokio::test]
async fn text_result_serializes_with_kind_tag() {
    let tmp = TempDir::new().unwrap();
    let path = write(tmp.path(), "a.txt", b"hi\n");
    let s = mk_session(tmp.path());
    let r = read(json!({"path": path}), &s).await;
    let v: Value = serde_json::to_value(&r).unwrap();
    assert_eq!(v.get("kind").and_then(|x| x.as_str()), Some("text"));
}

#[tokio::test]
async fn error_result_serializes_with_kind_tag() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = read(json!({"path": ""}), &s).await;
    let v: Value = serde_json::to_value(&r).unwrap();
    assert_eq!(v.get("kind").and_then(|x| x.as_str()), Some("error"));
}
