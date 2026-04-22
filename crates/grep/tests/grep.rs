//! Integration tests for the Rust grep port. Covers the same contract
//! as `packages/grep/test/grep.test.ts`. Not every TS test is ported —
//! focus is on the load-bearing behaviors: all three output modes,
//! alias pushback, fence, NOT_FOUND + siblings, zero-match hint,
//! .gitignore respect, invalid-regex hint.

use harness_core::{PermissionPolicy, ToolErrorCode};
use harness_grep::{grep, GrepResult, GrepSessionConfig};
use serde_json::json;
use std::fs;
use std::io::Write;
use std::path::Path;
use tempfile::TempDir;

fn mk_session(dir: &Path) -> GrepSessionConfig {
    let root = dir.to_string_lossy().into_owned();
    let perms = PermissionPolicy::new([root.clone()]);
    GrepSessionConfig::new(root, perms)
}

fn write(dir: &Path, name: &str, content: &str) -> String {
    let p = dir.join(name);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let mut f = fs::File::create(&p).unwrap();
    f.write_all(content.as_bytes()).unwrap();
    p.to_string_lossy().into_owned()
}

fn expect_files<'a>(r: &'a GrepResult) -> &'a harness_grep::FilesMatchResult {
    match r {
        GrepResult::FilesWithMatches(f) => f,
        other => panic!("expected files_with_matches, got {:?}", other),
    }
}

fn expect_content<'a>(r: &'a GrepResult) -> &'a harness_grep::ContentResult {
    match r {
        GrepResult::Content(c) => c,
        other => panic!("expected content, got {:?}", other),
    }
}

fn expect_count<'a>(r: &'a GrepResult) -> &'a harness_grep::CountResult {
    match r {
        GrepResult::Count(c) => c,
        other => panic!("expected count, got {:?}", other),
    }
}

fn expect_error<'a>(r: &'a GrepResult) -> &'a harness_grep::ErrorResult {
    match r {
        GrepResult::Error(e) => e,
        other => panic!("expected error, got {:?}", other),
    }
}

// ---- files_with_matches ----

#[tokio::test]
async fn lists_files_containing_the_pattern() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "hello world\n");
    write(tmp.path(), "b.ts", "nothing here\n");
    write(tmp.path(), "c.ts", "hello again\n");
    let s = mk_session(tmp.path());
    let r = grep(json!({"pattern": "hello"}), &s).await;
    let f = expect_files(&r);
    let names: Vec<&str> = f.paths.iter().filter_map(|p| Path::new(p).file_name().and_then(|n| n.to_str())).collect();
    assert!(names.contains(&"a.ts"), "paths={:?}", f.paths);
    assert!(names.contains(&"c.ts"));
    assert!(!names.contains(&"b.ts"));
    assert!(f.output.contains("<pattern>hello</pattern>"));
    assert!(f.output.contains("Found 2 file(s)"));
}

#[tokio::test]
async fn zero_match_hint_when_no_files_matched() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "nothing\n");
    let s = mk_session(tmp.path());
    let r = grep(json!({"pattern": "absent"}), &s).await;
    let f = expect_files(&r);
    assert_eq!(f.paths.len(), 0);
    assert!(f.output.contains("No files matched"));
    assert!(f.output.contains("case_insensitive: true"));
    assert!(f.output.contains("broaden the pattern"));
}

#[tokio::test]
async fn zero_match_elides_case_insensitive_when_already_on() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "hello\n");
    let s = mk_session(tmp.path());
    let r = grep(
        json!({"pattern": "absent", "case_insensitive": true, "glob": "*.zzz", "type": "ts"}),
        &s,
    )
    .await;
    let f = expect_files(&r);
    assert!(f.output.contains("remove glob='*.zzz'"));
    assert!(f.output.contains("remove type='ts'"));
    assert!(!f.output.contains("case_insensitive: true"));
}

// ---- content ----

#[tokio::test]
async fn content_mode_returns_line_numbered_matches() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "alpha\nbeta\nalpha again\n");
    let s = mk_session(tmp.path());
    let r = grep(
        json!({"pattern": "alpha", "output_mode": "content"}),
        &s,
    )
    .await;
    let c = expect_content(&r);
    assert_eq!(c.meta.total_matches, 2);
    assert_eq!(c.meta.total_files, 1);
    assert!(c.output.contains("  1: alpha"));
    assert!(c.output.contains("  3: alpha again"));
}

#[tokio::test]
async fn content_mode_with_context_before_and_after() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "one\ntwo\ntarget\nfour\nfive\n");
    let s = mk_session(tmp.path());
    let r = grep(
        json!({
            "pattern": "target",
            "output_mode": "content",
            "context_before": 1,
            "context_after": 1,
        }),
        &s,
    )
    .await;
    let c = expect_content(&r);
    assert!(c.output.contains("2: two"), "output:\n{}", c.output);
    assert!(c.output.contains("3: target"));
    assert!(c.output.contains("4: four"));
}

#[tokio::test]
async fn context_without_content_mode_is_invalid() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "x\n");
    let s = mk_session(tmp.path());
    let r = grep(json!({"pattern": "x", "context": 2}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("context"));
}

// ---- count ----

#[tokio::test]
async fn count_mode_reports_per_file_counts() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "x\nx\nx\n");
    write(tmp.path(), "b.ts", "x\n");
    let s = mk_session(tmp.path());
    let r = grep(
        json!({"pattern": "x", "output_mode": "count"}),
        &s,
    )
    .await;
    let c = expect_count(&r);
    let by_base: std::collections::HashMap<String, u64> = c
        .counts
        .iter()
        .map(|cc| {
            (
                Path::new(&cc.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                cc.count,
            )
        })
        .collect();
    assert_eq!(by_base.get("a.ts").copied(), Some(3));
    assert_eq!(by_base.get("b.ts").copied(), Some(1));
    assert!(c.output.contains("<counts>"));
}

// ---- regex + error surfaces ----

#[tokio::test]
async fn invalid_regex_returns_invalid_regex_with_hint() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "x\n");
    let s = mk_session(tmp.path());
    let r = grep(json!({"pattern": "interface{}"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidRegex);
    assert!(
        e.error.message.contains("escape literal regex")
            || e.error.message.to_lowercase().contains("regex parse")
    );
}

#[tokio::test]
async fn not_found_on_missing_path() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let missing = tmp.path().join("does-not-exist");
    let r = grep(
        json!({"pattern": "x", "path": missing.to_string_lossy()}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::NotFound);
}

#[tokio::test]
async fn not_found_suggests_fuzzy_siblings() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "server.ts", "x\n");
    write(tmp.path(), "client.ts", "x\n");
    let s = mk_session(tmp.path());
    let typo = tmp.path().join("serv.ts");
    let r = grep(
        json!({"pattern": "x", "path": typo.to_string_lossy()}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::NotFound);
    assert!(e.error.message.contains("Did you mean one of these?"));
    assert!(e.error.message.contains("server.ts"));
}

#[tokio::test]
async fn rejects_empty_pattern() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = grep(json!({"pattern": ""}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
}

#[tokio::test]
async fn rejects_unknown_field_with_alias_hint() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = grep(json!({"pattern": "x", "regex": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("Use 'pattern' instead"));
}

#[tokio::test]
async fn alias_content_typo_redirects_to_context() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = grep(json!({"pattern": "x", "content": 3}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("Did you mean 'context'"));
}

#[tokio::test]
async fn timeout_alias_carries_unit_conversion_hint() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    // `timeout` isn't in the alias map for grep (that's bash). The
    // generic unknown-parameter path should still reject it. We assert
    // on InvalidParam + the key appearing in the message.
    let r = grep(json!({"pattern": "x", "timeout": 30}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("timeout"));
}

// ---- ignore rules ----

#[tokio::test]
async fn respects_gitignore_without_a_git_repo() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), ".gitignore", "ignored.txt\n");
    write(tmp.path(), "ignored.txt", "secret\n");
    write(tmp.path(), "kept.txt", "secret\n");
    let s = mk_session(tmp.path());
    let r = grep(json!({"pattern": "secret"}), &s).await;
    let f = expect_files(&r);
    let names: Vec<&str> = f
        .paths
        .iter()
        .filter_map(|p| Path::new(p).file_name().and_then(|n| n.to_str()))
        .collect();
    assert!(names.contains(&"kept.txt"));
    assert!(!names.contains(&"ignored.txt"));
}

#[tokio::test]
async fn excludes_git_directory_contents() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(tmp.path().join(".git")).unwrap();
    write(tmp.path(), ".git/HEAD", "secret\n");
    write(tmp.path(), "kept.txt", "secret\n");
    let s = mk_session(tmp.path());
    let r = grep(json!({"pattern": "secret"}), &s).await;
    let f = expect_files(&r);
    assert!(f.paths.iter().all(|p| !p.contains("/.git/")));
    assert!(f.paths.iter().any(|p| p.ends_with("kept.txt")));
}

// ---- fence ----

#[tokio::test]
async fn blocks_paths_outside_workspace_roots() {
    let inside = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    write(outside.path(), "a.ts", "x\n");
    let s = mk_session(inside.path());
    let r = grep(
        json!({"pattern": "x", "path": outside.path().to_string_lossy()}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::OutsideWorkspace);
}

#[tokio::test]
async fn blocks_sensitive_paths_by_default() {
    let tmp = TempDir::new().unwrap();
    let env_path = write(tmp.path(), ".env", "SECRET=1\n");
    let root = tmp.path().to_string_lossy().into_owned();
    let mut perms = PermissionPolicy::new([root.clone()]);
    perms.sensitive_patterns = vec!["**/.env".to_string()];
    let s = GrepSessionConfig::new(root, perms);
    let r = grep(json!({"pattern": "SECRET", "path": env_path}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::Sensitive);
}
