//! Integration tests for Rust write/edit/multiedit. Mirrors the
//! critical cases from `packages/write/test/*.test.ts`.

use harness_core::{PermissionPolicy, ToolErrorCode};
use harness_write::{
    edit, multi_edit, write, EditResult, InMemoryLedger, Ledger, LedgerEntry, MultiEditResult,
    WriteResult, WriteSessionConfig,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tempfile::TempDir;

fn mk_session(dir: &Path) -> (WriteSessionConfig, Arc<InMemoryLedger>) {
    let root = fs::canonicalize(dir).unwrap().to_string_lossy().into_owned();
    let perms = PermissionPolicy::new([root.clone()]);
    let ledger: Arc<InMemoryLedger> = Arc::new(InMemoryLedger::new());
    let cfg = WriteSessionConfig::new(root, perms, ledger.clone());
    (cfg, ledger)
}

fn record_read(ledger: &Arc<InMemoryLedger>, path: &str, content: &[u8]) {
    let mut h = Sha256::new();
    h.update(content);
    let d = h.finalize();
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut sha = String::new();
    for b in d {
        sha.push(HEX[(b >> 4) as usize] as char);
        sha.push(HEX[(b & 0x0f) as usize] as char);
    }
    ledger.record(LedgerEntry {
        path: path.to_string(),
        sha256: sha,
        mtime_ms: 0,
        size_bytes: content.len() as u64,
        timestamp_ms: 0,
    });
}

fn canon(p: &Path) -> String {
    fs::canonicalize(p).unwrap().to_string_lossy().into_owned()
}

fn write_file(dir: &Path, name: &str, content: &[u8]) -> String {
    let p = dir.join(name);
    fs::write(&p, content).unwrap();
    canon(&p)
}

fn expect_write_ok(r: &WriteResult) -> &harness_write::TextWriteResult {
    match r {
        WriteResult::Text(t) => t,
        other => panic!("expected write text, got: {:?}", other),
    }
}

fn expect_write_error(r: &WriteResult) -> &harness_write::ErrorResult {
    match r {
        WriteResult::Error(e) => e,
        other => panic!("expected write error, got: {:?}", other),
    }
}

fn expect_edit_ok(r: &EditResult) -> &harness_write::TextWriteResult {
    match r {
        EditResult::Text(t) => t,
        other => panic!("expected edit text, got: {:?}", other),
    }
}

fn expect_edit_preview(r: &EditResult) -> &harness_write::PreviewResult {
    match r {
        EditResult::Preview(p) => p,
        other => panic!("expected edit preview, got: {:?}", other),
    }
}

fn expect_edit_error(r: &EditResult) -> &harness_write::ErrorResult {
    match r {
        EditResult::Error(e) => e,
        other => panic!("expected edit error, got: {:?}", other),
    }
}

fn expect_multiedit_ok(r: &MultiEditResult) -> &harness_write::TextWriteResult {
    match r {
        MultiEditResult::Text(t) => t,
        other => panic!("expected multiedit text, got: {:?}", other),
    }
}

fn expect_multiedit_error(r: &MultiEditResult) -> &harness_write::ErrorResult {
    match r {
        MultiEditResult::Error(e) => e,
        other => panic!("expected multiedit error, got: {:?}", other),
    }
}

// ---- Schema ----

#[tokio::test]
async fn write_rejects_empty_path() {
    let tmp = TempDir::new().unwrap();
    let (s, _l) = mk_session(tmp.path());
    let r = write(json!({"path": "", "content": "x"}), &s).await;
    let e = expect_write_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
}

#[tokio::test]
async fn edit_rejects_empty_old_string() {
    let tmp = TempDir::new().unwrap();
    let (s, _l) = mk_session(tmp.path());
    let r = edit(
        json!({"path": "/x", "old_string": "", "new_string": "y"}),
        &s,
    )
    .await;
    let e = expect_edit_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
}

// ---- Write happy paths ----

#[tokio::test]
async fn writes_new_file_no_read_required() {
    let tmp = TempDir::new().unwrap();
    let (s, _l) = mk_session(tmp.path());
    let p = tmp.path().join("new.txt");
    let abs = p.to_string_lossy().into_owned();
    let r = write(json!({"path": abs.clone(), "content": "hello\n"}), &s).await;
    let ok = expect_write_ok(&r);
    assert!(ok.output.contains("Wrote"));
    let disk = fs::read_to_string(&p).unwrap();
    assert_eq!(disk, "hello\n");
}

#[tokio::test]
async fn overwriting_existing_requires_read_ledger() {
    let tmp = TempDir::new().unwrap();
    let (s, _l) = mk_session(tmp.path());
    let abs = write_file(tmp.path(), "a.txt", b"hi");
    let r = write(json!({"path": abs, "content": "bye"}), &s).await;
    let e = expect_write_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::NotReadThisSession);
}

#[tokio::test]
async fn overwriting_after_read_succeeds() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let abs = write_file(tmp.path(), "a.txt", b"old");
    record_read(&l, &abs, b"old");
    let r = write(json!({"path": abs.clone(), "content": "new"}), &s).await;
    let _ok = expect_write_ok(&r);
    assert_eq!(fs::read_to_string(&abs).unwrap(), "new");
}

#[tokio::test]
async fn overwriting_with_stale_read_errors() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let abs = write_file(tmp.path(), "a.txt", b"version1");
    record_read(&l, &abs, b"version1");
    // Change file on disk behind our back.
    fs::write(&abs, b"version2").unwrap();
    let r = write(json!({"path": abs, "content": "new"}), &s).await;
    let e = expect_write_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::StaleRead);
}

// ---- Edit happy paths ----

#[tokio::test]
async fn edit_replaces_unique_match() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let abs = write_file(tmp.path(), "f.txt", b"hello world\n");
    record_read(&l, &abs, b"hello world\n");
    let r = edit(
        json!({"path": abs.clone(), "old_string": "world", "new_string": "Rust"}),
        &s,
    )
    .await;
    let _ok = expect_edit_ok(&r);
    assert_eq!(fs::read_to_string(&abs).unwrap(), "hello Rust\n");
}

#[tokio::test]
async fn edit_rejects_non_unique_without_replace_all() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let abs = write_file(tmp.path(), "f.txt", b"cat\ncat\n");
    record_read(&l, &abs, b"cat\ncat\n");
    let r = edit(
        json!({"path": abs, "old_string": "cat", "new_string": "dog"}),
        &s,
    )
    .await;
    let e = expect_edit_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::OldStringNotUnique);
    assert!(e.error.message.contains("matches 2 locations"));
}

#[tokio::test]
async fn edit_replace_all_replaces_every_occurrence() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let abs = write_file(tmp.path(), "f.txt", b"foo bar foo baz foo\n");
    record_read(&l, &abs, b"foo bar foo baz foo\n");
    let r = edit(
        json!({"path": abs.clone(), "old_string": "foo", "new_string": "FOO", "replace_all": true}),
        &s,
    )
    .await;
    let _ok = expect_edit_ok(&r);
    let disk = fs::read_to_string(&abs).unwrap();
    assert_eq!(disk, "FOO bar FOO baz FOO\n");
}

#[tokio::test]
async fn edit_not_found_returns_fuzzy_candidates() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let content = b"function handleClick(event) {\n  return true;\n}\n";
    let abs = write_file(tmp.path(), "f.ts", content);
    record_read(&l, &abs, content);
    let r = edit(
        json!({"path": abs, "old_string": "function handleClik(event) {", "new_string": "function handleClick(event) {"}),
        &s,
    )
    .await;
    let e = expect_edit_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::OldStringNotFound);
    // Fuzzy should flag the close match on line 1.
    assert!(e.error.message.contains("Candidate"));
}

#[tokio::test]
async fn edit_dry_run_returns_preview_without_writing() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let abs = write_file(tmp.path(), "f.txt", b"original\n");
    record_read(&l, &abs, b"original\n");
    let r = edit(
        json!({"path": abs.clone(), "old_string": "original", "new_string": "changed", "dry_run": true}),
        &s,
    )
    .await;
    let p = expect_edit_preview(&r);
    assert!(p.diff.contains("-original"));
    assert!(p.diff.contains("+changed"));
    // File unchanged
    assert_eq!(fs::read_to_string(&abs).unwrap(), "original\n");
}

#[tokio::test]
async fn edit_refuses_no_op() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let abs = write_file(tmp.path(), "f.txt", b"hello\n");
    record_read(&l, &abs, b"hello\n");
    let r = edit(
        json!({"path": abs, "old_string": "hello", "new_string": "hello"}),
        &s,
    )
    .await;
    let e = expect_edit_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::NoOpEdit);
}

#[tokio::test]
async fn edit_refuses_without_prior_read() {
    let tmp = TempDir::new().unwrap();
    let (s, _l) = mk_session(tmp.path());
    let abs = write_file(tmp.path(), "f.txt", b"hello\n");
    let r = edit(
        json!({"path": abs, "old_string": "hello", "new_string": "hi"}),
        &s,
    )
    .await;
    let e = expect_edit_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::NotReadThisSession);
}

#[tokio::test]
async fn edit_refuses_missing_file_with_not_found() {
    let tmp = TempDir::new().unwrap();
    let (s, _l) = mk_session(tmp.path());
    let target = tmp.path().join("does-not-exist.txt");
    let r = edit(
        json!({"path": target.to_string_lossy(), "old_string": "x", "new_string": "y"}),
        &s,
    )
    .await;
    let e = expect_edit_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::NotFound);
}

#[tokio::test]
async fn edit_refuses_binary_file() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let bytes: Vec<u8> = vec![0x00, 0x01, 0x02, b'a', b'b', b'c'];
    let abs = write_file(tmp.path(), "b.dat", &bytes);
    record_read(&l, &abs, &bytes);
    let r = edit(
        json!({"path": abs, "old_string": "a", "new_string": "z"}),
        &s,
    )
    .await;
    let e = expect_edit_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::BinaryNotEditable);
}

// ---- MultiEdit ----

#[tokio::test]
async fn multiedit_applies_sequentially() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let src = "function oldName() {\n  return 1;\n}\n";
    let abs = write_file(tmp.path(), "f.ts", src.as_bytes());
    record_read(&l, &abs, src.as_bytes());
    let r = multi_edit(
        json!({
            "path": abs.clone(),
            "edits": [
                {"old_string": "oldName", "new_string": "newName"},
                {"old_string": "return 1", "new_string": "return 42"},
            ]
        }),
        &s,
    )
    .await;
    let _ok = expect_multiedit_ok(&r);
    let disk = fs::read_to_string(&abs).unwrap();
    assert!(disk.contains("function newName()"));
    assert!(disk.contains("return 42"));
}

#[tokio::test]
async fn multiedit_rolls_back_on_mid_pipeline_error() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let src = "alpha\nbeta\n";
    let abs = write_file(tmp.path(), "f.txt", src.as_bytes());
    record_read(&l, &abs, src.as_bytes());
    let r = multi_edit(
        json!({
            "path": abs.clone(),
            "edits": [
                {"old_string": "alpha", "new_string": "A"},
                {"old_string": "MISSING", "new_string": "X"},
            ]
        }),
        &s,
    )
    .await;
    let e = expect_multiedit_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::OldStringNotFound);
    // File must be untouched.
    assert_eq!(fs::read_to_string(&abs).unwrap(), src);
}

// ---- Fence ----

#[tokio::test]
async fn write_outside_workspace_errors() {
    let tmp = TempDir::new().unwrap();
    let other = TempDir::new().unwrap();
    let (s, _l) = mk_session(tmp.path()); // root is tmp
    let target = other.path().join("x.txt").to_string_lossy().into_owned();
    let r = write(json!({"path": target, "content": "y"}), &s).await;
    let e = expect_write_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::OutsideWorkspace);
}

// ---- Serialization shape ----

#[tokio::test]
async fn edit_result_serializes_with_kind_tag() {
    let tmp = TempDir::new().unwrap();
    let (s, l) = mk_session(tmp.path());
    let abs = write_file(tmp.path(), "f.txt", b"hi\n");
    record_read(&l, &abs, b"hi\n");
    let r = edit(
        json!({"path": abs, "old_string": "hi", "new_string": "yo"}),
        &s,
    )
    .await;
    let v: Value = serde_json::to_value(&r).unwrap();
    assert_eq!(v.get("kind").and_then(|x| x.as_str()), Some("text"));
}

#[tokio::test]
async fn error_result_serializes_with_kind_tag() {
    let tmp = TempDir::new().unwrap();
    let (s, _l) = mk_session(tmp.path());
    let r = write(json!({"path": "", "content": "x"}), &s).await;
    let v: Value = serde_json::to_value(&r).unwrap();
    assert_eq!(v.get("kind").and_then(|x| x.as_str()), Some("error"));
}
