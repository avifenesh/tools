use harness_core::{ToolError, ToolErrorCode};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::constants::{
    BACKGROUND_MAX_JOBS, DEFAULT_INACTIVITY_TIMEOUT_MS, DEFAULT_WALLCLOCK_BACKSTOP_MS,
    KILL_GRACE_MS, MAX_OUTPUT_BYTES_FILE, MAX_OUTPUT_BYTES_INLINE, SENSITIVE_ENV_PREFIXES,
};
use crate::executor::BashRunInput;
use crate::fence::{fence_bash, resolve_cwd};
use crate::format::{
    format_background_started_text, format_bash_kill_text, format_bash_output_text,
    format_result_text, format_timeout_text, FormatBashOutputArgs, FormatResultArgs,
    FormatTimeoutArgs, HeadTailBuffer,
};
use crate::schema::{
    safe_parse_bash_kill_params, safe_parse_bash_output_params, safe_parse_bash_params,
};
use crate::types::{
    BashBackgroundStarted, BashError, BashKillResult, BashNonzeroExit, BashOk,
    BashOutputResult, BashResult, BashSessionConfig, BashTimeout, TimeoutReason,
};

fn err<T: From<BashError>>(e: ToolError) -> T {
    T::from(BashError { error: e })
}

impl From<BashError> for BashResult {
    fn from(e: BashError) -> Self {
        BashResult::Error(e)
    }
}
impl From<BashError> for BashOutputResult {
    fn from(e: BashError) -> Self {
        BashOutputResult::Error(e)
    }
}
impl From<BashError> for BashKillResult {
    fn from(e: BashError) -> Self {
        BashKillResult::Error(e)
    }
}

/// Top-level grammar check for a `cd <path>` command. Returns the target
/// only for a single, unambiguous cd with no shell operators.
pub fn detect_top_level_cd(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Reject any shell metachar that would make this a compound command.
    if !trimmed.starts_with("cd ") {
        return None;
    }
    let rest = trimmed[3..].trim_start();
    if rest.is_empty() {
        return None;
    }
    for ch in rest.chars() {
        if matches!(ch, '&' | '|' | ';' | '`' | '$' | '(' | ')') {
            return None;
        }
        if ch.is_whitespace() {
            return None;
        }
    }
    let stripped = if (rest.starts_with('"') && rest.ends_with('"'))
        || (rest.starts_with('\'') && rest.ends_with('\''))
    {
        rest[1..rest.len() - 1].to_string()
    } else {
        rest.to_string()
    };
    Some(stripped)
}

#[derive(Debug, Clone, Copy)]
pub struct CwdCarryOutcome {
    pub changed: bool,
    pub escaped: bool,
}

/// Mirror of the TS `applyCwdCarry`. Takes the executed command, its
/// exit code, and mutates `session.logical_cwd` if a top-level `cd`
/// landed inside the workspace. Returns a summary so the caller can
/// annotate the tool result if an escape attempt was blocked.
pub fn apply_cwd_carry(
    session: &BashSessionConfig,
    command: &str,
    exit_code: Option<i32>,
) -> CwdCarryOutcome {
    if exit_code != Some(0) {
        return CwdCarryOutcome { changed: false, escaped: false };
    }
    let Some(target) = detect_top_level_cd(command) else {
        return CwdCarryOutcome { changed: false, escaped: false };
    };
    let Some(logical) = &session.logical_cwd else {
        return CwdCarryOutcome { changed: false, escaped: false };
    };
    let base = logical.get();
    let resolved: PathBuf = if Path::new(&target).is_absolute() {
        Path::new(&target).to_path_buf()
    } else {
        Path::new(&base).join(&target)
    };
    let resolved = resolved
        .canonicalize()
        .unwrap_or_else(|_| resolved.clone());
    let path_str = resolved.to_string_lossy().into_owned();
    let inside = session
        .permissions
        .inner
        .roots
        .iter()
        .any(|root| path_str == *root || path_str.starts_with(&format!("{}/", root)));
    if !inside && !session.permissions.inner.bypass_workspace_guard {
        return CwdCarryOutcome { changed: false, escaped: true };
    }
    logical.set(path_str);
    CwdCarryOutcome { changed: true, escaped: false }
}

fn check_env(env: &HashMap<String, String>) -> Option<String> {
    for key in env.keys() {
        for prefix in SENSITIVE_ENV_PREFIXES {
            let hit = if prefix.ends_with('_') {
                key.starts_with(prefix)
            } else {
                key == prefix
            };
            if hit {
                return Some(format!(
                    "env may not set sensitive-prefix variable '{}' (prefix '{}').",
                    key, prefix
                ));
            }
        }
    }
    None
}

pub async fn bash_run(input: Value, session: &BashSessionConfig) -> BashResult {
    let params = match safe_parse_bash_params(&input) {
        Ok(v) => v,
        Err(e) => return err(ToolError::new(ToolErrorCode::InvalidParam, e.to_string())),
    };

    let background = params.background.unwrap_or(false);
    if background && params.timeout_ms.is_some() {
        return err(ToolError::new(
            ToolErrorCode::InvalidParam,
            "timeout_ms does not apply to background jobs; they have their own lifecycle (bash_kill). Drop timeout_ms or set background: false.",
        ));
    }

    let env = params.env.unwrap_or_default();
    if let Some(msg) = check_env(&env) {
        return err(ToolError::new(ToolErrorCode::InvalidParam, msg));
    }

    // Fail-closed if no hook AND not explicitly bypassed.
    if session.permissions.inner.hook.is_none()
        && !session.permissions.unsafe_allow_bash_without_hook
    {
        return err(ToolError::new(
            ToolErrorCode::PermissionDenied,
            "bash tool has no permission hook configured; refusing to run untrusted commands. Wire a hook or set permissions.unsafe_allow_bash_without_hook for test fixtures.",
        ));
    }

    let logical = session.logical_cwd.as_ref().map(|l| l.get());
    let resolved = resolve_cwd(&session.cwd, params.cwd.as_deref(), logical.as_deref());
    if let Some(fe) = fence_bash(&session.permissions.inner, &resolved) {
        return err(fe);
    }
    let stat = std::fs::metadata(&resolved);
    match stat {
        Err(_) => {
            return err(ToolError::new(
                ToolErrorCode::NotFound,
                format!("cwd does not exist: {}", resolved.to_string_lossy()),
            ));
        }
        Ok(m) if !m.is_dir() => {
            return err(ToolError::new(
                ToolErrorCode::IoError,
                format!(
                    "cwd is not a directory: {}",
                    resolved.to_string_lossy()
                ),
            ));
        }
        _ => {}
    }

    let cwd_str = resolved.to_string_lossy().into_owned();

    // Merge session env + call env. Session env None → inherit process env.
    let merged_env: HashMap<String, String> = {
        let base: HashMap<String, String> = match &session.env {
            Some(e) => e.clone(),
            None => std::env::vars().collect(),
        };
        let mut out = base;
        for (k, v) in env {
            out.insert(k, v);
        }
        out
    };

    if background {
        return run_background(session, params.command, cwd_str, merged_env).await;
    }

    run_foreground(
        session,
        params.command,
        cwd_str,
        merged_env,
        params
            .timeout_ms
            .or(session.default_inactivity_timeout_ms)
            .unwrap_or(DEFAULT_INACTIVITY_TIMEOUT_MS),
    )
    .await
}

async fn run_background(
    session: &BashSessionConfig,
    command: String,
    cwd: String,
    env: HashMap<String, String>,
) -> BashResult {
    let max_jobs = session.max_background_jobs.unwrap_or(BACKGROUND_MAX_JOBS);
    let _ = max_jobs; // Enforcement responsibility belongs to the executor;
                     // core behavior is forwarded. The LocalBashExecutor
                     // doesn't enforce the cap today — callers that need
                     // it substitute a wrapping executor.
    match session
        .executor
        .spawn_background(command.clone(), cwd, env)
        .await
    {
        Ok(job_id) => BashResult::BackgroundStarted(BashBackgroundStarted {
            output: format_background_started_text(&command, &job_id),
            job_id,
        }),
        Err(e) => err(ToolError::new(
            ToolErrorCode::IoError,
            format!("spawn_background failed: {}", e),
        )),
    }
}

async fn run_foreground(
    session: &BashSessionConfig,
    command: String,
    cwd: String,
    env: HashMap<String, String>,
    inactivity_ms: u64,
) -> BashResult {
    let wallclock_ms = session
        .wallclock_backstop_ms
        .unwrap_or(DEFAULT_WALLCLOCK_BACKSTOP_MS);
    let max_inline = session
        .max_output_bytes_inline
        .unwrap_or(MAX_OUTPUT_BYTES_INLINE);
    let max_file = session
        .max_output_bytes_file
        .unwrap_or(MAX_OUTPUT_BYTES_FILE);
    let spill_dir = std::env::temp_dir().join("agent-sh-bash-spill");

    let stdout_buf = Arc::new(Mutex::new(HeadTailBuffer::new(
        max_inline,
        max_file,
        "out",
        spill_dir.clone(),
    )));
    let stderr_buf = Arc::new(Mutex::new(HeadTailBuffer::new(
        max_inline,
        max_file,
        "err",
        spill_dir.clone(),
    )));

    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let timed_out_flag = Arc::new(Mutex::new(None::<TimeoutReason>));
    let inactivity_reset_tx = Arc::new(tokio::sync::Notify::new());

    // Wall-clock backstop.
    let timed_out_clone = Arc::clone(&timed_out_flag);
    let cancel_tx_clone = cancel_tx.clone();
    let wall_task = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(wallclock_ms)).await;
        *timed_out_clone.lock().unwrap() = Some(TimeoutReason::WallClockBackstop);
        let _ = cancel_tx_clone.send(true);
    });

    // Inactivity timer.
    let timed_out_clone = Arc::clone(&timed_out_flag);
    let cancel_tx_clone = cancel_tx.clone();
    let inactivity_reset = Arc::clone(&inactivity_reset_tx);
    let inactivity_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = inactivity_reset.notified() => continue,
                _ = tokio::time::sleep(std::time::Duration::from_millis(inactivity_ms)) => {
                    *timed_out_clone.lock().unwrap() = Some(TimeoutReason::InactivityTimeout);
                    let _ = cancel_tx_clone.send(true);
                    break;
                }
            }
        }
    });

    let started = std::time::Instant::now();

    let stdout_clone = Arc::clone(&stdout_buf);
    let stderr_clone = Arc::clone(&stderr_buf);
    let reset_clone_out = Arc::clone(&inactivity_reset_tx);
    let reset_clone_err = Arc::clone(&inactivity_reset_tx);

    let input = BashRunInput {
        command: command.clone(),
        cwd,
        env,
        cancel: cancel_rx,
        on_stdout: Box::new(move |chunk: &[u8]| {
            stdout_clone.lock().unwrap().write(chunk);
            reset_clone_out.notify_waiters();
        }),
        on_stderr: Box::new(move |chunk: &[u8]| {
            stderr_clone.lock().unwrap().write(chunk);
            reset_clone_err.notify_waiters();
        }),
    };

    let result = session.executor.run(input).await;
    let duration = started.elapsed().as_millis() as u64;
    wall_task.abort();
    inactivity_task.abort();
    let _ = KILL_GRACE_MS;

    let stdout_render = stdout_buf.lock().unwrap().render();
    let stderr_render = stderr_buf.lock().unwrap().render();
    let byte_cap = stdout_render.byte_cap || stderr_render.byte_cap;
    let log_path = stdout_render
        .log_path
        .clone()
        .or(stderr_render.log_path.clone());

    let timed_out = *timed_out_flag.lock().unwrap();
    if let Some(reason) = timed_out {
        let partial = stdout_buf.lock().unwrap().bytes_total()
            + stderr_buf.lock().unwrap().bytes_total();
        return BashResult::Timeout(BashTimeout {
            output: format_timeout_text(FormatTimeoutArgs {
                command: &command,
                stdout: &stdout_render.text,
                stderr: &stderr_render.text,
                reason,
                duration_ms: duration,
                partial_bytes: partial,
                log_path: log_path.as_deref(),
            }),
            stdout: stdout_render.text,
            stderr: stderr_render.text,
            reason,
            duration_ms: duration,
            log_path,
        });
    }

    let exit_code = result.exit_code.unwrap_or(-1);
    let kind_ok = exit_code == 0;
    let output = format_result_text(FormatResultArgs {
        command: &command,
        exit_code,
        stdout: &stdout_render.text,
        stderr: &stderr_render.text,
        duration_ms: duration,
        byte_cap,
        log_path: log_path.as_deref(),
        kind_ok,
    });

    if kind_ok {
        BashResult::Ok(BashOk {
            output,
            exit_code,
            stdout: stdout_render.text,
            stderr: stderr_render.text,
            duration_ms: duration,
            log_path,
            byte_cap,
        })
    } else {
        BashResult::NonzeroExit(BashNonzeroExit {
            output,
            exit_code,
            stdout: stdout_render.text,
            stderr: stderr_render.text,
            duration_ms: duration,
            log_path,
            byte_cap,
        })
    }
}

pub async fn bash_output_run(
    input: Value,
    session: &BashSessionConfig,
) -> BashOutputResult {
    let params = match safe_parse_bash_output_params(&input) {
        Ok(v) => v,
        Err(e) => {
            return err::<BashOutputResult>(ToolError::new(
                ToolErrorCode::InvalidParam,
                e.to_string(),
            ));
        }
    };
    let since = params.since_byte.unwrap_or(0);
    let head_limit = params.head_limit.unwrap_or(30_720);
    match session
        .executor
        .read_background(&params.job_id, since, head_limit)
        .await
    {
        Err(e) => err(ToolError::new(ToolErrorCode::NotFound, e)),
        Ok(r) => {
            let returned = r.stdout.len() as u64 + r.stderr.len() as u64;
            let total = r.total_bytes_stdout + r.total_bytes_stderr;
            BashOutputResult::Output {
                output: format_bash_output_text(FormatBashOutputArgs {
                    job_id: &params.job_id,
                    running: r.running,
                    exit_code: r.exit_code,
                    stdout: &r.stdout,
                    stderr: &r.stderr,
                    since_byte: since,
                    returned_bytes: returned,
                    total_bytes: total,
                }),
                running: r.running,
                exit_code: r.exit_code,
                stdout: r.stdout,
                stderr: r.stderr,
                total_bytes_stdout: r.total_bytes_stdout,
                total_bytes_stderr: r.total_bytes_stderr,
                next_since_byte: since + returned,
            }
        }
    }
}

pub async fn bash_kill_run(
    input: Value,
    session: &BashSessionConfig,
) -> BashKillResult {
    let params = match safe_parse_bash_kill_params(&input) {
        Ok(v) => v,
        Err(e) => {
            return err::<BashKillResult>(ToolError::new(
                ToolErrorCode::InvalidParam,
                e.to_string(),
            ));
        }
    };
    let signal = params.signal.unwrap_or_else(|| "SIGTERM".to_string());
    match session
        .executor
        .kill_background(&params.job_id, &signal)
        .await
    {
        Err(e) => err(ToolError::new(ToolErrorCode::NotFound, e)),
        Ok(()) => BashKillResult::Killed {
            output: format_bash_kill_text(&params.job_id, &signal),
            job_id: params.job_id,
            signal,
        },
    }
}
