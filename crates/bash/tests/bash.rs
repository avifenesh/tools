//! Integration tests for the Rust bash port. Mirrors the critical
//! cases from `packages/bash/test/bash.test.ts`.

use harness_bash::{
    apply_cwd_carry, bash, bash_kill, bash_output, default_executor,
    detect_top_level_cd, BashKillResult, BashOutputResult, BashPermissionPolicy,
    BashResult, BashSessionConfig,
};
use harness_core::{PermissionPolicy, ToolErrorCode};
use serde_json::{json, Value};
use std::path::Path;
use tempfile::TempDir;

fn mk_session(dir: &Path) -> BashSessionConfig {
    let root = dir.to_string_lossy().into_owned();
    let perms = PermissionPolicy::new([root.clone()]);
    let bash_perms = BashPermissionPolicy::new(perms).with_unsafe_bypass(true);
    BashSessionConfig::new(root, bash_perms, default_executor())
}

fn mk_session_with_carry(dir: &Path) -> BashSessionConfig {
    mk_session(dir).with_logical_cwd_carry()
}

fn expect_ok(r: &BashResult) -> &harness_bash::BashOk {
    match r {
        BashResult::Ok(o) => o,
        other => panic!("expected ok, got: {:?}", other),
    }
}

fn expect_nonzero(r: &BashResult) -> &harness_bash::BashNonzeroExit {
    match r {
        BashResult::NonzeroExit(o) => o,
        other => panic!("expected nonzero, got: {:?}", other),
    }
}

fn expect_error(r: &BashResult) -> &harness_bash::BashError {
    match r {
        BashResult::Error(e) => e,
        other => panic!("expected error, got: {:?}", other),
    }
}

fn expect_background(r: &BashResult) -> &harness_bash::BashBackgroundStarted {
    match r {
        BashResult::BackgroundStarted(b) => b,
        other => panic!("expected background_started, got: {:?}", other),
    }
}

// ---- Schema / alias pushback ----

#[tokio::test]
async fn rejects_unknown_param_cmd_with_alias_hint() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(json!({"cmd": "echo hi"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("command"), "msg={}", e.error.message);
}

#[tokio::test]
async fn rejects_timeout_with_milliseconds_hint() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(json!({"command": "echo hi", "timeout": 30}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
    assert!(e.error.message.contains("timeout_ms"));
}

#[tokio::test]
async fn rejects_stdin_with_v1_hint() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(json!({"command": "cat", "stdin": "hello"}), &s).await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("Interactive stdin is not supported"));
}

#[tokio::test]
async fn rejects_empty_command() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(json!({"command": "   "}), &s).await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("command is required"));
}

#[tokio::test]
async fn rejects_timeout_below_100ms() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(json!({"command": "echo hi", "timeout_ms": 50}), &s).await;
    let e = expect_error(&r);
    assert!(e.error.message.contains(">= 100"));
}

#[tokio::test]
async fn rejects_background_with_timeout_ms() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(
        json!({"command": "sleep 1", "background": true, "timeout_ms": 500}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("background"));
}

// ---- Permission + env guard ----

#[tokio::test]
async fn rejects_sensitive_env_prefix() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(
        json!({"command": "echo hi", "env": {"AWS_SECRET": "x"}}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.error.message.contains("AWS_") || e.error.message.contains("sensitive"));
}

#[tokio::test]
async fn rejects_when_hook_missing_and_no_bypass() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_string_lossy().into_owned();
    let perms = PermissionPolicy::new([root.clone()]);
    let bash_perms = BashPermissionPolicy::new(perms); // no bypass, no hook
    let s = BashSessionConfig::new(root, bash_perms, default_executor());
    let r = bash(json!({"command": "echo hi"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::PermissionDenied);
    assert!(e.error.message.contains("hook"));
}

// ---- Foreground execution ----

#[tokio::test]
async fn runs_simple_echo() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(json!({"command": "echo hello"}), &s).await;
    let ok = expect_ok(&r);
    assert_eq!(ok.exit_code, 0);
    assert!(ok.stdout.contains("hello"));
}

#[tokio::test]
async fn captures_stderr_independently() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(
        json!({"command": "echo out; echo err 1>&2"}),
        &s,
    )
    .await;
    let ok = expect_ok(&r);
    assert!(ok.stdout.contains("out"));
    assert!(ok.stderr.contains("err"));
}

#[tokio::test]
async fn nonzero_exit_surfaced() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(json!({"command": "false"}), &s).await;
    let nz = expect_nonzero(&r);
    assert_ne!(nz.exit_code, 0);
}

#[tokio::test]
async fn cwd_flows_through_to_child() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(json!({"command": "pwd"}), &s).await;
    let ok = expect_ok(&r);
    let canonical = std::fs::canonicalize(tmp.path()).unwrap();
    let expected = canonical.to_string_lossy();
    assert!(
        ok.stdout.contains(&*expected) || ok.stdout.contains(&*tmp.path().to_string_lossy()),
        "stdout={} want contains={}",
        ok.stdout,
        expected
    );
}

#[tokio::test]
async fn rejects_missing_cwd() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let missing = tmp.path().join("does-not-exist");
    let r = bash(
        json!({"command": "pwd", "cwd": missing.to_string_lossy()}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert_eq!(e.error.code, ToolErrorCode::NotFound);
}

// ---- cwd-carry helpers ----

#[test]
fn detect_cd_simple() {
    assert_eq!(detect_top_level_cd("cd src"), Some("src".to_string()));
}

#[test]
fn detect_cd_absolute() {
    assert_eq!(detect_top_level_cd("cd /tmp"), Some("/tmp".to_string()));
}

#[test]
fn detect_cd_rejects_compound() {
    assert_eq!(detect_top_level_cd("cd src && ls"), None);
    assert_eq!(detect_top_level_cd("ls && cd src"), None);
    assert_eq!(detect_top_level_cd("cd src; ls"), None);
    assert_eq!(detect_top_level_cd("cd `pwd`"), None);
}

#[test]
fn detect_cd_strips_quotes() {
    assert_eq!(detect_top_level_cd("cd \"src\""), Some("src".to_string()));
    assert_eq!(detect_top_level_cd("cd 'src'"), Some("src".to_string()));
}

#[test]
fn detect_cd_requires_target() {
    assert_eq!(detect_top_level_cd("cd"), None);
    assert_eq!(detect_top_level_cd("cd "), None);
}

#[tokio::test]
async fn apply_cwd_carry_updates_logical_cwd_on_success() {
    let tmp = TempDir::new().unwrap();
    std::fs::create_dir_all(tmp.path().join("src")).unwrap();
    let s = mk_session_with_carry(tmp.path());
    let before = s.logical_cwd.as_ref().unwrap().get();
    let outcome = apply_cwd_carry(&s, "cd src", Some(0));
    assert!(outcome.changed);
    assert!(!outcome.escaped);
    let after = s.logical_cwd.as_ref().unwrap().get();
    assert_ne!(before, after);
    assert!(after.ends_with("src"));
}

#[tokio::test]
async fn apply_cwd_carry_blocks_escape_outside_workspace() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session_with_carry(tmp.path());
    let outcome = apply_cwd_carry(&s, "cd /", Some(0));
    assert!(!outcome.changed);
    assert!(outcome.escaped);
}

#[tokio::test]
async fn apply_cwd_carry_ignores_nonzero_exit() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session_with_carry(tmp.path());
    let outcome = apply_cwd_carry(&s, "cd src", Some(1));
    assert!(!outcome.changed);
    assert!(!outcome.escaped);
}

// ---- Background jobs ----

fn expect_output(r: &BashOutputResult) -> (&str, &str, bool, Option<i32>) {
    match r {
        BashOutputResult::Output {
            stdout,
            stderr,
            running,
            exit_code,
            ..
        } => (stdout.as_str(), stderr.as_str(), *running, *exit_code),
        BashOutputResult::Error(e) => panic!("expected output, got error: {:?}", e.error),
    }
}

async fn wait_for_done(session: &BashSessionConfig, job_id: &str) -> BashOutputResult {
    for _ in 0..60 {
        let r = bash_output(json!({"job_id": job_id}), session).await;
        if let BashOutputResult::Output { running, .. } = &r {
            if !running {
                return r;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("job {} did not finish within 6s", job_id);
}

#[tokio::test]
async fn background_job_runs_and_reports_output() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(
        json!({"command": "echo started; sleep 0.1; echo done", "background": true}),
        &s,
    )
    .await;
    let bg = expect_background(&r);
    let job_id = bg.job_id.clone();
    let final_ = wait_for_done(&s, &job_id).await;
    let (stdout, _stderr, running, exit_code) = expect_output(&final_);
    assert!(!running);
    assert_eq!(exit_code, Some(0));
    assert!(stdout.contains("started"));
    assert!(stdout.contains("done"));
}

#[tokio::test]
async fn bash_output_paginates_by_since_byte() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(
        json!({"command": "printf 'one\\ntwo\\nthree\\n'", "background": true}),
        &s,
    )
    .await;
    let bg = expect_background(&r);
    let job_id = bg.job_id.clone();
    let done = wait_for_done(&s, &job_id).await;
    let next_since = match &done {
        BashOutputResult::Output { next_since_byte, .. } => *next_since_byte,
        _ => unreachable!(),
    };
    assert!(next_since > 0);

    let second = bash_output(
        json!({"job_id": job_id, "since_byte": next_since}),
        &s,
    )
    .await;
    match second {
        BashOutputResult::Output { stdout, .. } => assert!(stdout.is_empty()),
        _ => panic!("expected output"),
    }
}

#[tokio::test]
async fn bash_kill_terminates_background_job() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(
        json!({"command": "sleep 5", "background": true}),
        &s,
    )
    .await;
    let bg = expect_background(&r);
    let job_id = bg.job_id.clone();

    let kill = bash_kill(json!({"job_id": job_id}), &s).await;
    match kill {
        BashKillResult::Killed { .. } => {}
        BashKillResult::Error(e) => panic!("expected killed, got {:?}", e.error),
    }

    let final_ = wait_for_done(&s, &job_id).await;
    let (_o, _e, running, _code) = expect_output(&final_);
    assert!(!running);
}

#[tokio::test]
async fn bash_output_rejects_unknown_job_id() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash_output(json!({"job_id": "does-not-exist"}), &s).await;
    match r {
        BashOutputResult::Error(e) => assert_eq!(e.error.code, ToolErrorCode::NotFound),
        _ => panic!("expected error"),
    }
}

#[tokio::test]
async fn bash_kill_rejects_unknown_job_id() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash_kill(json!({"job_id": "does-not-exist"}), &s).await;
    match r {
        BashKillResult::Error(e) => assert_eq!(e.error.code, ToolErrorCode::NotFound),
        _ => panic!("expected error"),
    }
}

#[tokio::test]
async fn bash_kill_rejects_bad_signal() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash_kill(
        json!({"job_id": "x", "signal": "SIGHUP"}),
        &s,
    )
    .await;
    match r {
        BashKillResult::Error(e) => {
            assert_eq!(e.error.code, ToolErrorCode::InvalidParam);
            assert!(e.error.message.contains("SIGTERM") || e.error.message.contains("SIGKILL"));
        }
        _ => panic!("expected error"),
    }
}

// ---- Serialization shape ----

#[tokio::test]
async fn ok_result_serializes_with_kind_tag() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(json!({"command": "echo hi"}), &s).await;
    let v: Value = serde_json::to_value(&r).unwrap();
    assert_eq!(v.get("kind").and_then(|v| v.as_str()), Some("ok"));
    assert!(v.get("stdout").is_some());
}

#[tokio::test]
async fn error_result_serializes_with_kind_tag() {
    let tmp = TempDir::new().unwrap();
    let s = mk_session(tmp.path());
    let r = bash(json!({"command": ""}), &s).await;
    let v: Value = serde_json::to_value(&r).unwrap();
    assert_eq!(v.get("kind").and_then(|v| v.as_str()), Some("error"));
}
