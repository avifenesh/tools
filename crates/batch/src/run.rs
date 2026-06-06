use std::process::Stdio;

use harness_core::{ToolError, ToolErrorCode};

use crate::schema::{BatchMode, BatchParams, BatchTarget};

/// Result for a single target execution.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct TargetResult {
    pub path: String,
    pub status: BatchStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum BatchStatus {
    Success,
    Failed { exit_code: i32 },
    TimedOut,
    Skipped,
}

/// Resolves targets from the batch params.
fn resolve_targets(targets: &BatchTarget) -> Result<Vec<String>, String> {
    match targets {
        BatchTarget::Subdirs { path, name_filter } => {
            let root = std::path::Path::new(path);
            if !root.is_dir() {
                return Err(format!("Not a directory: {}", path));
            }
            let mut results = Vec::new();
            for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name();
                let name_str = name.to_string_lossy().to_string();
                if let Some(filter) = name_filter {
                    // Simple glob: support * prefix/suffix
                    if !matches_name(&name_str, filter) {
                        continue;
                    }
                }
                results.push(path.to_string_lossy().into_owned());
            }
            results.sort();
            Ok(results)
        }
        BatchTarget::Glob { pattern } => {
            // Expand ~ to home dir
            let expanded = expand_tilde(pattern);
            let mut results = Vec::new();
            let entries: Vec<_> = glob::glob(&expanded)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .filter(|p| p.is_dir())
                .collect();
            for entry in entries {
                results.push(entry.to_string_lossy().into_owned());
            }
            results.sort();
            Ok(results)
        }
        BatchTarget::Explicit { paths } => {
            Ok(paths.clone())
        }
    }
}

/// Glob matching for subdirectory names supporting * and ? wildcards.
/// Converts the glob pattern to a regex for proper matching.
fn matches_name(name: &str, pattern: &str) -> bool {
    let regex_src = pattern
        .replace('+', r"\+")
        .replace('.', r"\.")
        .replace('^', r"\^")
        .replace('$', r"\$")
        .replace('{', r"\{")
        .replace('}', r"\}")
        .replace('(', r"\(")
        .replace(')', r"\)")
        .replace('|', r"\|")
        .replace('\\', r"\\")
        .replace('*', ".*")
        .replace('?', ".");
    match regex::Regex::new(&format!("(?i)^{}$", regex_src)) {
        Ok(re) => re.is_match(name),
        Err(_) => false,
    }
}

/// Expand ~ to home directory.
fn expand_tilde(path: &str) -> String {
    if path.starts_with("~") {
        if let Some(home) = std::env::var_os("HOME") {
            return format!("{}{}", home.to_string_lossy(), &path[1..]);
        }
    }
    path.to_string()
}

/// Run a single command in the given target directory.
async fn run_one(
    command: &str,
    target: &str,
    timeout_secs: u64,
) -> Result<TargetResult, String> {
    let start = std::time::Instant::now();

    // Pass TARGET as env var to avoid shell injection via path interpolation.
    let mut cmd = tokio::process::Command::new("bash");
    let child = match cmd
        .arg("-c")
        .arg(command)
        .env("TARGET", target)
        .current_dir(target)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return Ok(TargetResult {
                path: target.to_string(),
                status: BatchStatus::Failed { exit_code: -1 },
                stdout: None,
                stderr: Some(format!("spawn failed: {}", e)),
                duration_ms: Some(start.elapsed().as_millis() as u64),
            });
        }
    };

    // Use timeout; if it fires, kill the child to avoid orphaned processes.
    let result =
        tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            child.wait_with_output(),
        )
        .await;

    if result.is_err() {
        // Timeout — `wait_with_output` future was dropped. Since
        // `kill_on_drop(true)` is set on the command, the child is
        // automatically killed and won't become orphaned.
    }

    let duration = start.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            let status = if output.status.success() {
                BatchStatus::Success
            } else {
                BatchStatus::Failed {
                    exit_code: output
                        .status
                        .code()
                        .unwrap_or(-1),
                }
            };

            Ok(TargetResult {
                path: target.to_string(),
                status,
                stdout: if stdout.is_empty() { None } else { Some(stdout) },
                stderr: if stderr.is_empty() { None } else { Some(stderr) },
                duration_ms: Some(duration),
            })
        }
        Ok(Err(e)) => Ok(TargetResult {
            path: target.to_string(),
            status: BatchStatus::Failed { exit_code: -1 },
            stdout: None,
            stderr: Some(e.to_string()),
            duration_ms: Some(duration),
        }),
        Err(_) => Ok(TargetResult {
            path: target.to_string(),
            status: BatchStatus::TimedOut,
            stdout: None,
            stderr: None,
            duration_ms: Some(duration),
        }),
    }
}

/// Execute a batch operation across all resolved targets.
/// If `workspace_root` is provided, targets outside the workspace are filtered out
/// after resolving symlinks via canonicalize, preventing symlink-based escape.
pub async fn execute_batch(
    params: &BatchParams,
    workspace_root: Option<&str>,
) -> Result<BatchResponse, ToolError> {
    // Resolve targets
    let targets = resolve_targets(&params.targets)
        .map_err(|e| ToolError::new(ToolErrorCode::InvalidParam, e))?;

    // Canonicalize targets and fence inside workspace if workspace_root is set.
    let targets: Vec<String> = targets
        .into_iter()
        .map(|t| {
            std::fs::canonicalize(&t)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| t)
        })
        .filter(|t| {
            // If no workspace_root, allow all targets.
            if let Some(root) = workspace_root {
                // Check containment: path must start with root or equal root.
                // On Unix this is sufficient; on Windows different drives would
                // fail the starts_with check naturally.
                t == root || t.starts_with(&format!("{}/", root))
            } else {
                true
            }
        })
        .collect();

    if targets.is_empty() {
        return Ok(BatchResponse::Summary(SummaryResult {
            total: 0,
            success: 0,
            failed: 0,
            timed_out: 0,
            message: "No matching targets found.".to_string(),
        }));
    }

    // Execute based on mode
    let results: Vec<TargetResult> = match &params.mode {
        BatchMode::Sequential => {
            let mut results = Vec::new();
            for target in &targets {
                let result = run_one(&params.command, target, params.timeout_secs)
                    .await
                    .map_err(|e| ToolError::new(ToolErrorCode::IoError, e))?;
                // Note: run_one now returns a Failed TargetResult for spawn errors,
                // so this branch is only hit for truly unexpected errors.

                if params.fail_fast {
                    if !matches!(&result.status, BatchStatus::Success | BatchStatus::Skipped) {
                        // Failed — stop early
                        results.push(result);
                        break;
                    }
                }
                results.push(result);
            }
            results
        }
        BatchMode::Parallel => {
            let targets_owned: Vec<String> = targets.clone();
            // Clamp to at least 1 to avoid a zero-permit semaphore that would deadlock.
            let max_concurrent = params.max_concurrent.max(1);
            let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(max_concurrent));
            let mut handles: Vec<tokio::task::JoinHandle<Result<TargetResult, ToolError>>> = Vec::new();
            let failed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

            for target in targets_owned {
                let cmd = params.command.clone();
                let timeout = params.timeout_secs;
                let sem = sem.clone();
                let fail_fast = params.fail_fast;
                let failed = failed.clone();

                handles.push(tokio::spawn(async move {
                    // Acquire semaphore slot to limit concurrency.
                    let _permit = match (*sem).acquire().await {
                        Ok(p) => p,
                        Err(e) => {
                            return Ok(TargetResult {
                                path: target.clone(),
                                status: BatchStatus::Failed { exit_code: -1 },
                                stdout: None,
                                stderr: Some(format!("semaphore error: {}", e)),
                                duration_ms: None,
                            });
                        }
                    };

                    // Check if we should stop (fail_fast).
                    if fail_fast && failed.load(std::sync::atomic::Ordering::Relaxed) {
                        return Ok(TargetResult {
                            path: target.clone(),
                            status: BatchStatus::Skipped,
                            stdout: None,
                            stderr: None,
                            duration_ms: Some(0),
                        });
                    }

                    // run_one returns a Failed TargetResult for spawn errors,
                    // so this ? only propagates truly unexpected errors.
                    let result = run_one(&cmd, &target, timeout).await
                        .unwrap_or_else(|e| TargetResult {
                            path: target.clone(),
                            status: BatchStatus::Failed { exit_code: -1 },
                            stdout: None,
                            stderr: Some(format!("unexpected error: {}", e)),
                            duration_ms: None,
                        });

                    if fail_fast && !matches!(&result.status, BatchStatus::Success | BatchStatus::Skipped) {
                        failed.store(true, std::sync::atomic::Ordering::Relaxed);
                    }

                    Ok(result)
                }));
            }

            let mut results = Vec::new();
            for handle in handles {
                match handle.await {
                    Ok(Ok(result)) => {
                        results.push(result);
                    }
                    Ok(Err(_)) => {
                        // Should not happen (run_one returns TargetResult for errors),
                        // but handle gracefully.
                    }
                    Err(_) => {
                        // Task join error — skip.
                    }
                }
            }
            results
        }
    };

    // Build response
    if params.summary_only {
        build_summary(&results)
    } else {
        build_detailed(&results)
    }
}

fn build_summary(results: &[TargetResult]) -> Result<BatchResponse, ToolError> {
    let total = results.len();
    let success = results
        .iter()
        .filter(|r| matches!(&r.status, BatchStatus::Success))
        .count();
    let failed = results
        .iter()
        .filter(|r| matches!(&r.status, BatchStatus::Failed { .. }))
        .count();
    let timed_out = results
        .iter()
        .filter(|r| matches!(&r.status, BatchStatus::TimedOut))
        .count();

    let msg = format!(
        "Batch complete: {}/{} succeeded, {} failed, {} timed out",
        success, total, failed, timed_out
    );

    Ok(BatchResponse::Summary(SummaryResult {
        total,
        success,
        failed,
        timed_out,
        message: msg,
    }))
}

fn build_detailed(results: &[TargetResult]) -> Result<BatchResponse, ToolError> {
    let mut lines = Vec::new();
    lines.push(format!("Batch complete: {} targets", results.len()));
    lines.push(String::new());

    for r in results {
        let status_str = match &r.status {
            BatchStatus::Success => "✓".to_string(),
            BatchStatus::Failed { exit_code } => format!("✗ (exit {})", exit_code),
            BatchStatus::TimedOut => "⏱ timeout".to_string(),
            BatchStatus::Skipped => "○ skipped".to_string(),
        };
        lines.push(format!("{} {}", status_str, r.path));

        if let Some(ref stderr) = r.stderr {
            // Only include stderr for failed jobs to keep output manageable.
            if !matches!(&r.status, BatchStatus::Success) {
                lines.push(indent(&stderr.lines().take(5).collect::<Vec<_>>().join("\n")));
            }
        }
    }

    let msg = lines.join("\n");

    // Build per-target metadata
    let target_results: Vec<serde_json::Value> = results
        .iter()
        .map(|r| {
            let status_str = match &r.status {
                BatchStatus::Success => "success".to_string(),
                BatchStatus::Failed { exit_code } => format!("failed({})", exit_code),
                BatchStatus::TimedOut => "timed_out".to_string(),
                BatchStatus::Skipped => "skipped".to_string(),
            };
            serde_json::json!({
                "path": r.path,
                "status": status_str,
                "duration_ms": r.duration_ms,
            })
        })
        .collect();

    Ok(BatchResponse::Detailed(DetailedResult {
        message: msg,
        targets: target_results,
    }))
}

fn indent(s: &str) -> String {
    s.lines()
        .map(|l| format!("    {}", l))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Batch operation response.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BatchResponse {
    #[serde(rename = "summary")]
    Summary(SummaryResult),
    #[serde(rename = "detailed")]
    Detailed(DetailedResult),
}

/// Summary result for batch operations.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct SummaryResult {
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub timed_out: usize,
    pub message: String,
}

/// Detailed result for batch operations.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct DetailedResult {
    pub message: String,
    pub targets: Vec<serde_json::Value>,
}
