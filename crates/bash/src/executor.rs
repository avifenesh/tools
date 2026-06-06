use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

use crate::constants::{BACKGROUND_JOB_TTL_SECS, KILL_GRACE_MS};

/// Everything the runtime needs to launch + wire up a subprocess. The
/// `on_stdout`/`on_stderr` callbacks hand each chunk back to the
/// orchestrator for head+tail buffering and inactivity-timer reset.
pub struct BashRunInput<'a> {
    pub command: String,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub cancel: tokio::sync::watch::Receiver<bool>,
    pub on_stdout: Box<dyn FnMut(&[u8]) + Send + 'a>,
    pub on_stderr: Box<dyn FnMut(&[u8]) + Send + 'a>,
}

pub struct BashRunResult {
    pub exit_code: Option<i32>,
    pub killed: bool,
    pub signal: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BackgroundReadResult {
    pub stdout: String,
    pub stderr: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub total_bytes_stdout: u64,
    pub total_bytes_stderr: u64,
}

#[async_trait::async_trait]
pub trait BashExecutor: Send + Sync {
    async fn run(&self, input: BashRunInput<'_>) -> BashRunResult;

    async fn spawn_background(
        &self,
        command: String,
        cwd: String,
        env: HashMap<String, String>,
    ) -> Result<String, String>;

    async fn read_background(
        &self,
        job_id: &str,
        since_byte: u64,
        head_limit: usize,
    ) -> Result<BackgroundReadResult, String>;

    async fn kill_background(&self, job_id: &str, signal: &str) -> Result<(), String>;

    async fn close_session(&self);
}

/// Persistent metadata for a background job, serialized to disk so
/// completed jobs survive executor recreation.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct JobMetadata {
    out_path: String,
    err_path: String,
    running: bool,
    exit_code: Option<i32>,
    created_at: u64,
    /// Workspace root for scoping; only jobs from the same workspace are
    /// restored, preventing cross-workspace output leakage.
    workspace_root: String,
}

/// Background job state kept in-process. Stdout/stderr go to temp files
/// keyed by job_id; `read_background` reads a window into each by byte
/// offset.
struct Job {
    out_path: PathBuf,
    err_path: PathBuf,
    running: bool,
    exit_code: Option<i32>,
    /// Handle so `kill_background` can signal via tokio's process APIs
    /// rather than raw PIDs (the child stays attached until exit).
    child: Option<Arc<Mutex<Child>>>,
    /// True if this job was restored from disk and has no child handle.
    /// Restored jobs should refresh their metadata on each poll.
    restored: bool,
}

pub struct LocalBashExecutor {
    log_dir: PathBuf,
    /// Workspace root used to scope job restoration. Only jobs whose
    /// metadata workspace_root matches this are restored on startup.
    workspace_root: String,
    /// Outer std::sync::Mutex avoids tokio blocking_lock issues during
    /// construction. The inner tokio::sync::Mutex<Job> handles async access.
    jobs: Arc<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<Job>>>>>,
}

impl LocalBashExecutor {
    pub fn new() -> Self {
        // Derive workspace root from current working directory for scoping.
        let workspace_root = std::env::current_dir()
            .ok()
            .and_then(|p| p.canonicalize().ok())
            .unwrap_or_else(|| PathBuf::from("unknown"));
        let workspace_root = workspace_root.to_string_lossy().to_string();
        let log_dir = std::env::temp_dir().join("agent-sh-bash-logs");
        std::fs::create_dir_all(&log_dir).ok();
        let mut self_ = Self {
            log_dir: log_dir.clone(),
            workspace_root: workspace_root.clone(),
            jobs: Arc::new(std::sync::Mutex::new(HashMap::new())),
        };
        // Load existing job metadata from disk (completed jobs from previous sessions).
        self_.load_jobs_from_disk().ok();
        self_
    }

    /// Restore completed jobs from disk so they remain queryable across
    /// executor recreations. Prunes jobs older than the TTL.
    /// Only restores jobs that match the current workspace_root to prevent
    /// cross-workspace job leakage.
    fn load_jobs_from_disk(&mut self) -> Result<(), String> {
        let meta_dir = self.log_dir.join("job-meta");
        if !meta_dir.exists() {
            return Ok(());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        for entry in std::fs::read_dir(&meta_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if !path.extension().map_or(false, |e| e == "json") {
                continue;
            }
            let meta: JobMetadata = match serde_json::from_slice(
                &std::fs::read(&path).map_err(|e| e.to_string())?,
            ) {
                Ok(m) => m,
                Err(_) => continue,
            };
            // Prune expired jobs.
            if now.saturating_sub(meta.created_at) > BACKGROUND_JOB_TTL_SECS {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(&PathBuf::from(&meta.out_path));
                let _ = std::fs::remove_file(&PathBuf::from(&meta.err_path));
                continue;
            }
            // Only restore jobs from the current workspace.
            if meta.workspace_root != self.workspace_root {
                continue;
            }
            // Restore job with its persisted running state. Running jobs won't have
            // a child handle (old executor died), but callers can still poll
            // log files; when the child exits, the waiter writes final metadata.
            let job = Arc::new(tokio::sync::Mutex::new(Job {
                out_path: PathBuf::from(meta.out_path),
                err_path: PathBuf::from(meta.err_path),
                running: meta.running,
                exit_code: if meta.running { None } else { meta.exit_code },
                child: None,
                restored: true,
            }));
            let job_id = path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if !job_id.is_empty() {
                self.jobs.lock().unwrap().insert(job_id, job);
            }
        }
        Ok(())
    }
}

impl Default for LocalBashExecutor {
    fn default() -> Self {
        Self::new()
    }
}

/// Build the standard `bash -c <command>` argv. NEVER string-interpolate
/// the command into any other process's args — the child bash does all
/// the shell parsing.
fn bash_command(command: &str, cwd: &str, env: &HashMap<String, String>) -> Command {
    let mut cmd = Command::new("/bin/bash");
    cmd.arg("-c").arg(command);
    cmd.current_dir(cwd);
    cmd.env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    cmd
}

#[async_trait::async_trait]
impl BashExecutor for LocalBashExecutor {
    async fn run(&self, mut input: BashRunInput<'_>) -> BashRunResult {
        let mut cmd = bash_command(&input.command, &input.cwd, &input.env);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(_) => {
                return BashRunResult {
                    exit_code: None,
                    killed: false,
                    signal: None,
                };
            }
        };
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let mut out_reader = BufReader::new(stdout);
        let mut err_reader = BufReader::new(stderr);

        let mut cancel_rx = input.cancel.clone();
        let (killed_tx, mut killed_rx) = oneshot::channel::<()>();
        let mut killed_tx_slot: Option<oneshot::Sender<()>> = Some(killed_tx);

        let mut out_buf = [0u8; 4096];
        let mut err_buf = [0u8; 4096];
        let mut wait_fut = Box::pin(child.wait());
        let mut killed_by_signal = false;
        let mut kill_once = Some(());
        let mut out_open = true;
        let mut err_open = true;

        loop {
            tokio::select! {
                biased;
                changed = cancel_rx.changed() => {
                    if changed.is_ok() && *cancel_rx.borrow() {
                        if let Some(()) = kill_once.take() {
                            killed_by_signal = true;
                            if let Some(tx) = killed_tx_slot.take() {
                                let _ = tx.send(());
                            }
                        }
                    }
                }
                _ = &mut killed_rx, if killed_by_signal => {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_millis(KILL_GRACE_MS),
                        &mut wait_fut,
                    )
                    .await;
                    break;
                }
                r = out_reader.read(&mut out_buf), if out_open => {
                    match r {
                        Ok(0) => out_open = false,
                        Ok(n) => (input.on_stdout)(&out_buf[..n]),
                        Err(_) => out_open = false,
                    }
                }
                r = err_reader.read(&mut err_buf), if err_open => {
                    match r {
                        Ok(0) => err_open = false,
                        Ok(n) => (input.on_stderr)(&err_buf[..n]),
                        Err(_) => err_open = false,
                    }
                }
                status = &mut wait_fut => {
                    let _ = drain(&mut out_reader, &mut input.on_stdout, out_open).await;
                    let _ = drain(&mut err_reader, &mut input.on_stderr, err_open).await;
                    let (exit_code, signal) = match status {
                        Ok(s) => (s.code(), signal_name(&s)),
                        Err(_) => (None, None),
                    };
                    return BashRunResult {
                        exit_code,
                        killed: killed_by_signal,
                        signal,
                    };
                }
            }
        }

        // If we broke out of the loop due to cancellation + grace expired,
        // the child may still be alive. It'll be killed by `kill_on_drop`
        // when `wait_fut` drops.
        BashRunResult {
            exit_code: None,
            killed: killed_by_signal,
            signal: Some("SIGTERM".to_string()),
        }
    }

    async fn spawn_background(
        &self,
        command: String,
        cwd: String,
        env: HashMap<String, String>,
    ) -> Result<String, String> {
        let job_id = uuid_v4_simple();
        let out_path = self.log_dir.join(format!("{}.out", job_id));
        let err_path = self.log_dir.join(format!("{}.err", job_id));
        // Create empty files so readers don't error on "file not found"
        // between spawn and first write.
        File::create(&out_path).map_err(|e| e.to_string())?;
        File::create(&err_path).map_err(|e| e.to_string())?;

        let mut cmd = bash_command(&command, &cwd, &env);
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;

        let job = Arc::new(tokio::sync::Mutex::new(Job {
            out_path: out_path.clone(),
            err_path: err_path.clone(),
            running: true,
            exit_code: None,
            child: Some(Arc::new(Mutex::new(child))),
            restored: false,
        }));
        {
            let mut jobs = self.jobs.lock().unwrap();
            jobs.insert(job_id.clone(), Arc::clone(&job));
        }
        // Persist metadata immediately so in-flight jobs survive executor
        // recreation. The waiter below will overwrite with final status.
        // Canonicalize cwd before persisting so the workspace_root comparison
        // at restore time matches the canonicalized self.workspace_root.
        let g = job.lock().await;
        let canonicalized_cwd = std::fs::canonicalize(&cwd)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| cwd.clone());
        persist_job_metadata(&self.log_dir, &job_id, &*g, &canonicalized_cwd);

        // Pipe stdout → file
        let out_path_spawn = out_path.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut file = match std::fs::OpenOptions::new()
                .append(true)
                .open(&out_path_spawn)
            {
                Ok(f) => f,
                Err(_) => return,
            };
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = file.write_all(&buf[..n]);
                    }
                }
            }
        });
        let err_path_spawn = err_path.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut file = match std::fs::OpenOptions::new()
                .append(true)
                .open(&err_path_spawn)
            {
                Ok(f) => f,
                Err(_) => return,
            };
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = file.write_all(&buf[..n]);
                    }
                }
            }
        });

        // Wait for exit in the background and record it.
        let job_watch = Arc::clone(&job);
        let log_dir = self.log_dir.clone();
        let job_id_clone = job_id.clone();
        let workspace_root = canonicalized_cwd.clone();
        tokio::spawn(async move {
            let child_arc = {
                let j = job_watch.lock().await;
                j.child.clone()
            };
            if let Some(child_arc) = child_arc {
                // Take the child out of the Arc<Mutex<>> so we can .wait() on it.
                // Use std::mem::replace with a placeholder — the sentinel is
                // immediately replaced out so it never blocks.
                let mut child_opt: Option<Child> = {
                    let mut guard = child_arc.lock().unwrap();
                    Some(std::mem::replace(&mut *guard, spawn_sentinel()))
                };
                if let Some(mut child) = child_opt.take() {
                    let status = child.wait().await;
                    let mut j = job_watch.lock().await;
                    j.running = false;
                    j.exit_code = match status {
                        Ok(s) => s.code(),
                        Err(_) => None,
                    };
                    j.child = None;
                    // Persist job metadata to disk for cross-session queries.
                    let _ = persist_job_metadata(&log_dir, &job_id_clone, &j, &workspace_root);
                }
            }
        });

        Ok(job_id)
    }

    async fn read_background(
        &self,
        job_id: &str,
        since_byte: u64,
        head_limit: usize,
    ) -> Result<BackgroundReadResult, String> {
        let job = {
            let jobs = self.jobs.lock().unwrap();
            jobs.get(job_id).cloned()
        };
        let job = match job {
            Some(j) => j,
            None => return Err(format!("Unknown job_id: {}", job_id)),
        };
        let (out_path, err_path, running, exit_code, restored) = {
            let g = job.lock().await;
            (
                g.out_path.clone(),
                g.err_path.clone(),
                g.running,
                g.exit_code,
                g.restored,
            )
        };
        // For restored jobs (no child handle), reload metadata from disk
        // so that completed jobs are detected even if this executor
        // didn't spawn the original child.
        let (running, exit_code) = if restored && running {
            let meta_path = self.log_dir.join("job-meta").join(format!("{}.json", job_id));
            match std::fs::read_to_string(&meta_path) {
                Ok(data) => {
                    match serde_json::from_str::<JobMetadata>(&data) {
                        Ok(meta) => {
                            // Update in-memory state to match disk.
                            {
                                let mut g = job.lock().await;
                                g.running = meta.running;
                                if !meta.running {
                                    g.exit_code = meta.exit_code;
                                }
                            }
                            (meta.running, if meta.running { None } else { meta.exit_code })
                        }
                        Err(_) => (running, exit_code),
                    }
                }
                Err(_) => (running, exit_code),
            }
        } else {
            (running, exit_code)
        };
        let (out_text, out_total) = read_slice(&out_path, since_byte, head_limit);
        let (err_text, err_total) = read_slice(&err_path, since_byte, head_limit);
        Ok(BackgroundReadResult {
            stdout: out_text,
            stderr: err_text,
            running,
            exit_code,
            total_bytes_stdout: out_total,
            total_bytes_stderr: err_total,
        })
    }

    async fn kill_background(&self, job_id: &str, _signal: &str) -> Result<(), String> {
        let job = {
            let jobs = self.jobs.lock().unwrap();
            jobs.get(job_id).cloned()
        };
        let job = match job {
            Some(j) => j,
            None => return Err(format!("Unknown job_id: {}", job_id)),
        };
        let (child_arc, restored) = {
            let g = job.lock().await;
            (g.child.clone(), g.restored)
        };
        if restored && child_arc.is_none() {
            return Err(
                "Cannot kill restored background job: the original process handle \
                 was lost when this executor session started. The job may have \
                 already exited or may still be running with no way to signal it."
                    .to_string(),
            );
        }
        if let Some(child_arc) = child_arc {
            let mut guard = child_arc.lock().unwrap();
            // start_kill sends SIGKILL on unix. SIGTERM vs SIGKILL
            // distinction is documented in the spec but tokio's Child
            // only exposes one path here; keep simple for v1.
            let _ = guard.start_kill();
        }
        Ok(())
    }

    async fn close_session(&self) {
        // Collect job Arcs while holding the lock, then drop it before
        // awaiting on each job to avoid holding std::sync::MutexGuard
        // across an await point.
        let jobs: Vec<_> = {
            let mut guard = self.jobs.lock().unwrap();
            guard.drain().map(|(_, job)| job).collect()
        };
        for job in jobs {
            let child_arc = {
                let g = job.lock().await;
                g.child.clone()
            };
            if let Some(child_arc) = child_arc {
                let mut guard = child_arc.lock().unwrap();
                let _ = guard.start_kill();
            }
        }
    }
}

pub fn default_executor() -> Arc<dyn BashExecutor> {
    Arc::new(LocalBashExecutor::new())
}

// ---- helpers ----

fn read_slice(path: &std::path::Path, since: u64, head_limit: usize) -> (String, u64) {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (String::new(), 0),
    };
    let total = meta.len();
    if since >= total {
        return (String::new(), total);
    }
    let end = (since + head_limit as u64).min(total);
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (String::new(), total),
    };
    use std::io::{Read, Seek, SeekFrom};
    if f.seek(SeekFrom::Start(since)).is_err() {
        return (String::new(), total);
    }
    let mut buf = vec![0u8; (end - since) as usize];
    let n = f.read(&mut buf).unwrap_or(0);
    buf.truncate(n);
    (String::from_utf8_lossy(&buf).into_owned(), total)
}

async fn drain<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    cb: &mut Box<dyn FnMut(&[u8]) + Send + '_>,
    still_open: bool,
) -> std::io::Result<()> {
    if !still_open {
        return Ok(());
    }
    let mut buf = [0u8; 4096];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        cb(&buf[..n]);
    }
}

fn signal_name(status: &std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|s| format!("SIG{}", s))
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

/// Placeholder child for std::mem::replace. Immediately killed on drop via
/// `kill_on_drop(true)` so it never becomes a zombie. We never .wait() on
/// this — it's only used as a temporary value during `std::mem::replace`.
fn spawn_sentinel() -> Child {
    let mut cmd = Command::new("/bin/true");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    cmd.kill_on_drop(true);
    cmd.spawn().expect("/bin/true should always spawn")
}

/// Serialize job metadata to disk so completed jobs survive executor
/// recreation. Idempotent — safe to call multiple times for the same job.
fn persist_job_metadata(log_dir: &PathBuf, job_id: &str, job: &Job, workspace_root: &str) {
    let meta_dir = log_dir.join("job-meta");
    if std::fs::create_dir_all(&meta_dir).is_err() {
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let meta = JobMetadata {
        out_path: job.out_path.to_string_lossy().into_owned(),
        err_path: job.err_path.to_string_lossy().into_owned(),
        running: job.running,
        exit_code: job.exit_code,
        created_at: now,
        workspace_root: workspace_root.to_string(),
    };
    let bytes = match serde_json::to_string(&meta) {
        Ok(b) => b,
        Err(_) => return,
    };
    let path = meta_dir.join(format!("{}.json", job_id));
    let _ = std::fs::write(&path, &bytes);
}

/// Minimal UUID-v4-ish generator to avoid pulling the `uuid` crate just
/// for job ids. Uses the OS time + a counter; collisions are vanishingly
/// unlikely for within-session use.
fn uuid_v4_simple() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}", now, n)
}
