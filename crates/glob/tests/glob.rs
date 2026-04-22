//! Integration tests for the Rust glob port. Mirrors the critical
//! cases from `packages/glob/test/glob.test.ts`.

use harness_core::{PermissionPolicy, ToolErrorCode};
use harness_glob::{glob, GlobResult, GlobSessionConfig};
use serde_json::json;
use std::fs;
use std::io::Write;
use std::path::Path;
use tempfile::TempDir;

fn mk_session(dir: &Path) -> GlobSessionConfig {
    let root = dir.to_string_lossy().into_owned();
    let perms = PermissionPolicy::new([root.clone()]);
    GlobSessionConfig::new(root, perms)
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

fn expect_paths(r: &GlobResult) -> &harness_glob::GlobPathsResult {
    match r {
        GlobResult::Paths(p) => p,
        GlobResult::Error(e) => panic!("expected paths, got error: {:?}", e.error),
    }
}

fn expect_error(r: &GlobResult) -> &harness_glob::ErrorResult {
    match r {
        GlobResult::Error(e) => e,
        GlobResult::Paths(_) => panic!("expected error, got paths"),
    }
}

// ---- basic pattern matching ----

#[tokio::test]
async fn top_level_only_for_non_recursive_pattern() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "x");
    write(tmp.path(), "b.ts", "x");
    write(tmp.path(), "nested/c.ts", "x");
    let s = mk_session(tmp.path());
    let r = glob(json!({"pattern": "*.ts"}), &s).await;
    let p = expect_paths(&r);
    let names: Vec<&str> = p
        .paths
        .iter()
        .filter_map(|p| Path::new(p).file_name().and_then(|n| n.to_str()))
        .collect();
    assert!(names.contains(&"a.ts"));
    assert!(names.contains(&"b.ts"));
    assert!(!names.contains(&"c.ts"));
}

#[tokio::test]
async fn recursive_matches_for_globstar() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "x");
    write(tmp.path(), "nested/deep/b.ts", "x");
    let s = mk_session(tmp.path());
    let r = glob(json!({"pattern": "**/*.ts"}), &s).await;
    let p = expect_paths(&r);
    let mut names: Vec<&str> = p
        .paths
        .iter()
        .filter_map(|p| Path::new(p).file_name().and_then(|n| n.to_str()))
        .collect();
    names.sort();
    assert_eq!(names, vec!["a.ts", "b.ts"]);
}

#[tokio::test]
async fn brace_expansion_works() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "x");
    write(tmp.path(), "b.tsx", "x");
    write(tmp.path(), "c.js", "x");
    let s = mk_session(tmp.path());
    let r = glob(json!({"pattern": "*.{ts,tsx}"}), &s).await;
    let p = expect_paths(&r);
    let mut names: Vec<&str> = p
        .paths
        .iter()
        .filter_map(|p| Path::new(p).file_name().and_then(|n| n.to_str()))
        .collect();
    names.sort();
    assert_eq!(names, vec!["a.ts", "b.tsx"]);
}

#[tokio::test]
async fn returns_absolute_paths() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "x");
    let s = mk_session(tmp.path());
    let r = glob(json!({"pattern": "*.ts"}), &s).await;
    let p = expect_paths(&r);
    assert!(p.paths.iter().all(|p| p.starts_with('/')));
}

// ---- zero-match hint ----

#[tokio::test]
async fn zero_match_suggests_recursive_marker() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "nested/a.ts", "x");
    let s = mk_session(tmp.path());
    let r = glob(json!({"pattern": "*.xyz"}), &s).await;
    let p = expect_paths(&r);
    assert!(p.paths.is_empty());
    assert!(p.output.contains("No files matched '*.xyz'"));
    assert!(p.output.contains("add '**/'"));
    assert!(p.output.contains("broaden the pattern"));
}

#[tokio::test]
async fn zero_match_omits_recursive_marker_when_already_present() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = glob(json!({"pattern": "**/*.xyz"}), &s).await;
    let p = expect_paths(&r);
    assert!(p.output.contains("No files matched"));
    assert!(!p.output.contains("add '**/'"));
}

// ---- pagination ----

#[tokio::test]
async fn paginates_with_head_limit_and_offset() {
    let tmp = TempDir::new().unwrap();
    for i in 0..10 {
        write(tmp.path(), &format!("f{i}.txt"), "x");
    }
    let s = mk_session(tmp.path());
    let r = glob(
        json!({"pattern": "*.txt", "head_limit": 3, "offset": 0}),
        &s,
    )
    .await;
    let p = expect_paths(&r);
    assert_eq!(p.paths.len(), 3);
    assert_eq!(p.meta.total, 10);
    assert!(p.meta.more);
    assert!(p.output.contains("re-call with offset: 3"));
}

#[tokio::test]
async fn offset_past_total_returns_empty_paths_with_hint() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "a.ts", "x");
    let s = mk_session(tmp.path());
    let r = glob(
        json!({"pattern": "*.ts", "head_limit": 10, "offset": 100}),
        &s,
    )
    .await;
    let p = expect_paths(&r);
    assert!(p.paths.is_empty());
    assert!(p.output.contains("No files matched"));
}

// ---- errors / fence ----

#[tokio::test]
async fn not_found_with_fuzzy_siblings() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "components/a.ts", "x");
    write(tmp.path(), "component-utils.ts", "x");
    let s = mk_session(tmp.path());
    let typo = tmp.path().join("componets");
    let r = glob(
        json!({"pattern": "*.ts", "path": typo.to_string_lossy()}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::NotFound);
    assert!(e.error.message.contains("Did you mean"));
    assert!(e.error.message.contains("components"));
}

#[tokio::test]
async fn blocks_paths_outside_workspace() {
    let inside = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    write(outside.path(), "a.ts", "x");
    let s = mk_session(inside.path());
    let r = glob(
        json!({"pattern": "*.ts", "path": outside.path().to_string_lossy()}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::OutsideWorkspace);
}

#[tokio::test]
async fn rejects_empty_pattern() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = glob(json!({"pattern": ""}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
}

#[tokio::test]
async fn alias_regex_redirects_to_pattern_with_grep_hint() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = glob(json!({"regex": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("Glob uses glob syntax, not regex"));
    assert!(e.error.message.contains("use the grep tool"));
}

#[tokio::test]
async fn alias_recursive_redirects_to_pattern_syntax() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = glob(json!({"pattern": "*.ts", "recursive": true}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("prefix with '**/'"));
}

// ---- ignore rules ----

#[tokio::test]
async fn respects_gitignore() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), ".gitignore", "ignored.ts\n");
    write(tmp.path(), "ignored.ts", "x");
    write(tmp.path(), "kept.ts", "x");
    let s = mk_session(tmp.path());
    let r = glob(json!({"pattern": "*.ts"}), &s).await;
    let p = expect_paths(&r);
    let names: Vec<&str> = p
        .paths
        .iter()
        .filter_map(|p| Path::new(p).file_name().and_then(|n| n.to_str()))
        .collect();
    assert!(names.contains(&"kept.ts"));
    assert!(!names.contains(&"ignored.ts"));
}

#[tokio::test]
async fn excludes_hidden_files() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), ".secret", "x");
    write(tmp.path(), "visible.ts", "x");
    let s = mk_session(tmp.path());
    let r = glob(json!({"pattern": "*"}), &s).await;
    let p = expect_paths(&r);
    let names: Vec<&str> = p
        .paths
        .iter()
        .filter_map(|p| Path::new(p).file_name().and_then(|n| n.to_str()))
        .collect();
    assert!(names.contains(&"visible.ts"));
    assert!(!names.contains(&".secret"));
}

// ---- absolute-path auto-split ----

#[tokio::test]
async fn auto_splits_absolute_path_in_pattern() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "src/Target.tsx", "x");
    write(tmp.path(), "other.ts", "x");
    let s = mk_session(tmp.path());
    let abs_pattern = format!(
        "{}/{}",
        tmp.path().to_string_lossy(),
        "**/*.tsx"
    );
    let r = glob(json!({"pattern": abs_pattern}), &s).await;
    let p = expect_paths(&r);
    let names: Vec<&str> = p
        .paths
        .iter()
        .filter_map(|p| Path::new(p).file_name().and_then(|n| n.to_str()))
        .collect();
    assert_eq!(names, vec!["Target.tsx"]);
}

#[tokio::test]
async fn auto_split_does_not_override_explicit_path() {
    let tmp = TempDir::new().unwrap();
    write(tmp.path(), "sub/a.ts", "x");
    let s = mk_session(tmp.path());
    // Absolute pattern + explicit path: trust the caller, don't rewrite.
    // Pattern is absolute relative to the explicit path so it won't match
    // anything — we expect zero matches, not a silent rewrite.
    let r = glob(
        json!({
            "pattern": format!("{}/**/*.ts", tmp.path().to_string_lossy()),
            "path": tmp.path().to_string_lossy(),
        }),
        &s,
    )
    .await;
    let p = expect_paths(&r);
    assert_eq!(p.paths.len(), 0);
}
