use crate::constants::{MAX_OUTPUT_BYTES_FILE, MAX_OUTPUT_BYTES_INLINE};
use crate::types::TimeoutReason;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

/// Per-stream output buffer. Keeps head in memory, spills the rest to a
/// temp file when overflow triggers. Matches the TS HeadTailBuffer
/// simplification (head-only inline; full file recoverable via Read).
pub struct HeadTailBuffer {
    max_inline: usize,
    max_file: usize,
    kind: &'static str,
    spill_dir: PathBuf,
    chunks: Vec<Vec<u8>>,
    total_bytes: usize,
    spilled: bool,
    spill_path: Option<PathBuf>,
    spill_file: Option<File>,
    file_bytes_written: usize,
}

impl HeadTailBuffer {
    pub fn new(max_inline: usize, max_file: usize, kind: &'static str, spill_dir: PathBuf) -> Self {
        Self {
            max_inline,
            max_file,
            kind,
            spill_dir,
            chunks: Vec::new(),
            total_bytes: 0,
            spilled: false,
            spill_path: None,
            spill_file: None,
            file_bytes_written: 0,
        }
    }

    pub fn with_defaults(kind: &'static str, spill_dir: PathBuf) -> Self {
        Self::new(
            MAX_OUTPUT_BYTES_INLINE,
            MAX_OUTPUT_BYTES_FILE,
            kind,
            spill_dir,
        )
    }

    pub fn write(&mut self, chunk: &[u8]) {
        self.total_bytes += chunk.len();
        if self.total_bytes <= self.max_inline {
            self.chunks.push(chunk.to_vec());
            return;
        }
        if !self.spilled {
            self.spilled = true;
            let _ = fs::create_dir_all(&self.spill_dir);
            let path = self.spill_dir.join(format!(
                "{}-{}.{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0),
                self.kind
            ));
            self.spill_path = Some(path.clone());
            if let Ok(mut f) = File::create(&path) {
                // Dump whatever's already buffered so the spill file has
                // the full stream from the start.
                for c in &self.chunks {
                    let _ = f.write_all(c);
                    self.file_bytes_written += c.len();
                }
                self.spill_file = OpenOptions::new().append(true).open(&path).ok();
            }
        }
        if self.file_bytes_written + chunk.len() > self.max_file {
            return;
        }
        if let Some(f) = self.spill_file.as_mut() {
            let _ = f.write_all(chunk);
            self.file_bytes_written += chunk.len();
        }
    }

    pub fn render(&self) -> HeadTailRender {
        if !self.spilled {
            let joined: Vec<u8> = self.chunks.iter().flatten().copied().collect();
            return HeadTailRender {
                text: String::from_utf8_lossy(&joined).into_owned(),
                byte_cap: false,
                log_path: None,
            };
        }
        let mut head_bytes: Vec<u8> = Vec::with_capacity(self.max_inline);
        for c in &self.chunks {
            for &b in c {
                if head_bytes.len() >= self.max_inline {
                    break;
                }
                head_bytes.push(b);
            }
            if head_bytes.len() >= self.max_inline {
                break;
            }
        }
        let head_str = String::from_utf8_lossy(&head_bytes).into_owned();
        let log_path = self
            .spill_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned());
        let marker = format!(
            "\n... (stream exceeded {} bytes; full log at {}) ...",
            self.max_inline,
            log_path.as_deref().unwrap_or("?")
        );
        HeadTailRender {
            text: format!("{}{}", head_str, marker),
            byte_cap: true,
            log_path,
        }
    }

    pub fn bytes_total(&self) -> usize {
        self.total_bytes
    }
}

pub struct HeadTailRender {
    pub text: String,
    pub byte_cap: bool,
    pub log_path: Option<String>,
}

// ---- result text formatters ----

pub struct FormatResultArgs<'a> {
    pub command: &'a str,
    pub exit_code: i32,
    pub stdout: &'a str,
    pub stderr: &'a str,
    pub duration_ms: u64,
    pub byte_cap: bool,
    pub log_path: Option<&'a str>,
    pub kind_ok: bool,
}

pub fn format_result_text(args: FormatResultArgs<'_>) -> String {
    let header = format!("<command>{}</command>", args.command);
    let exit_line = format!("<exit_code>{}</exit_code>", args.exit_code);
    let stdout_block = format!("<stdout>\n{}\n</stdout>", args.stdout);
    let stderr_block = format!("<stderr>\n{}\n</stderr>", args.stderr);
    let hint = if args.byte_cap {
        format!(
            "(Output capped. Full log: {}. Read it with pagination if you need the middle.)",
            args.log_path.unwrap_or("?")
        )
    } else if args.kind_ok {
        format!(
            "(Command completed in {}ms. exit=0.)",
            args.duration_ms
        )
    } else {
        format!(
            "(Command exited nonzero in {}ms. Exit code: {}.)",
            args.duration_ms, args.exit_code
        )
    };
    format!(
        "{}\n{}\n{}\n{}\n{}",
        header, exit_line, stdout_block, stderr_block, hint
    )
}

pub struct FormatTimeoutArgs<'a> {
    pub command: &'a str,
    pub stdout: &'a str,
    pub stderr: &'a str,
    pub reason: TimeoutReason,
    pub duration_ms: u64,
    pub partial_bytes: usize,
    pub log_path: Option<&'a str>,
}

pub fn format_timeout_text(args: FormatTimeoutArgs<'_>) -> String {
    let header = format!("<command>{}</command>", args.command);
    let stdout_block = format!("<stdout>\n{}\n</stdout>", args.stdout);
    let stderr_block = format!("<stderr>\n{}\n</stderr>", args.stderr);
    let log_hint = args
        .log_path
        .map(|p| format!(" Full log: {}.", p))
        .unwrap_or_default();
    let hint = format!(
        "(Command hit {} after {}ms. {} bytes captured. Kill signal: SIGTERM then SIGKILL.{} If the command is long-running, retry with background: true.)",
        args.reason.as_str(),
        args.duration_ms,
        args.partial_bytes,
        log_hint
    );
    format!("{}\n{}\n{}\n{}", header, stdout_block, stderr_block, hint)
}

pub fn format_background_started_text(command: &str, job_id: &str) -> String {
    format!(
        "<command>{}</command>\n<job_id>{}</job_id>\n(Background job started. Poll output with bash_output(job_id). Kill with bash_kill(job_id).)",
        command, job_id
    )
}

pub struct FormatBashOutputArgs<'a> {
    pub job_id: &'a str,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub stdout: &'a str,
    pub stderr: &'a str,
    pub since_byte: u64,
    pub returned_bytes: u64,
    pub total_bytes: u64,
}

pub fn format_bash_output_text(args: FormatBashOutputArgs<'_>) -> String {
    let next = args.since_byte + args.returned_bytes;
    format!(
        "<job_id>{}</job_id>\n<running>{}</running>\n<exit_code>{}</exit_code>\n<stdout>\n{}\n</stdout>\n<stderr>\n{}\n</stderr>\n(Showing bytes {}-{} of {}. Next since_byte: {}. Job running: {}.)",
        args.job_id,
        args.running,
        args.exit_code.map(|v| v.to_string()).unwrap_or_else(|| "null".to_string()),
        args.stdout,
        args.stderr,
        args.since_byte,
        next,
        args.total_bytes,
        next,
        args.running,
    )
}

pub fn format_bash_kill_text(job_id: &str, signal: &str) -> String {
    format!(
        "<job_id>{}</job_id>\n({} sent. Poll bash_output to confirm termination.)",
        job_id, signal
    )
}
