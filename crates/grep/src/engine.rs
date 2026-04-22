use crate::types::{RgCount, RgMatch};
use anyhow::{anyhow, Result};
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::{WalkBuilder, WalkState};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

/// Inputs to the engine. Shape-compatible with the TS `GrepEngineInput`;
/// the only divergence is `signal` — Rust tool calls don't take an
/// explicit cancel signal at this layer (yet), so the engine runs to
/// natural completion.
#[derive(Debug, Clone)]
pub struct GrepEngineInput {
    pub pattern: String,
    pub root: PathBuf,
    pub glob: Option<String>,
    pub r#type: Option<String>,
    pub case_insensitive: bool,
    pub multiline: bool,
    pub context_before: usize,
    pub context_after: usize,
    pub max_columns: usize,
    pub max_filesize: u64,
}

/// Same pluggable-backend idea as the TS `GrepEngine`: default wraps
/// ripgrep's library, tests or SSH-remote harnesses can substitute.
pub trait GrepEngine: Send + Sync {
    fn search(&self, input: &GrepEngineInput) -> Result<Vec<RgMatch>>;
    fn count(&self, input: &GrepEngineInput) -> Result<Vec<RgCount>>;
}

pub fn default_engine() -> Box<dyn GrepEngine> {
    Box::new(RipgrepLibEngine::new())
}

/// The default engine using BurntSushi/ripgrep's library crates directly.
///
/// We deliberately mirror the CLI invariants the TS version passes to
/// the `ripgrep` npm wrapper: no hidden, no follow-symlink, no ignore
/// config, .gitignore respected, max_filesize cap, max_columns cap. The
/// `ignore` crate handles file discovery; `grep-searcher` does the line
/// iteration; `grep-regex` is the matcher.
pub struct RipgrepLibEngine;

impl Default for RipgrepLibEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RipgrepLibEngine {
    pub fn new() -> Self {
        Self
    }

    fn build_matcher(
        &self,
        input: &GrepEngineInput,
    ) -> Result<grep_regex::RegexMatcher> {
        RegexMatcherBuilder::new()
            .case_insensitive(input.case_insensitive)
            .multi_line(input.multiline)
            .dot_matches_new_line(input.multiline)
            .build(&input.pattern)
            .map_err(|e| anyhow!(e.to_string()))
    }

    fn build_walk(&self, input: &GrepEngineInput) -> WalkBuilder {
        let mut wb = WalkBuilder::new(&input.root);
        wb.hidden(true) // skip hidden by default
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .ignore(true)
            .parents(true)
            .follow_links(false)
            .max_filesize(Some(input.max_filesize))
            .require_git(false)
            .add_custom_ignore_filename(".rgignore");

        if let Some(g) = input.glob.as_deref() {
            let mut b = ignore::overrides::OverrideBuilder::new(&input.root);
            // Leading `!` inverts an `.ignore`-style entry; we pass glob
            // as-is, matching the ripgrep `-g` semantics.
            let _ = b.add(g);
            if let Ok(over) = b.build() {
                wb.overrides(over);
            }
        }
        if let Some(t) = input.r#type.as_deref() {
            let mut tb = ignore::types::TypesBuilder::new();
            tb.add_defaults();
            let _ = tb.select(t);
            if let Ok(types) = tb.build() {
                wb.types(types);
            }
        }
        wb
    }

    fn make_searcher(&self, input: &GrepEngineInput) -> Searcher {
        let mut sb = SearcherBuilder::new();
        sb.binary_detection(BinaryDetection::quit(b'\x00'))
            .multi_line(input.multiline);
        if input.context_before > 0 {
            sb.before_context(input.context_before);
        }
        if input.context_after > 0 {
            sb.after_context(input.context_after);
        }
        sb.build()
    }
}

impl GrepEngine for RipgrepLibEngine {
    fn search(&self, input: &GrepEngineInput) -> Result<Vec<RgMatch>> {
        let matcher = self.build_matcher(input)?;
        let walker = self.build_walk(input).build_parallel();
        let (tx, rx): (Sender<RgMatch>, Receiver<RgMatch>) = mpsc::channel();
        let max_cols = input.max_columns;

        let before_ctx = input.context_before;
        let after_ctx = input.context_after;
        let multi = input.multiline;
        walker.run(|| {
            let matcher = matcher.clone();
            let tx = tx.clone();
            Box::new(move |result| {
                let entry = match result {
                    Ok(e) => e,
                    Err(_) => return WalkState::Continue,
                };
                let p = entry.path();
                if !p.is_file() {
                    return WalkState::Continue;
                }
                // Build a per-file searcher that honors context + multiline.
                // Doing it inside the closure keeps thread-safety simple —
                // Searcher is not Send, so we can't hoist it.
                let mut sb = SearcherBuilder::new();
                sb.binary_detection(BinaryDetection::quit(b'\x00'))
                    .multi_line(multi);
                if before_ctx > 0 {
                    sb.before_context(before_ctx);
                }
                if after_ctx > 0 {
                    sb.after_context(after_ctx);
                }
                let mut searcher = sb.build();
                let mut sink = VecSink {
                    path: p.to_string_lossy().into_owned(),
                    matches: Vec::new(),
                    max_cols,
                };
                let _ = searcher.search_path(&matcher, p, &mut sink);
                for m in sink.matches {
                    let _ = tx.send(m);
                }
                WalkState::Continue
            })
        });
        drop(tx);
        Ok(rx.into_iter().collect())
    }

    fn count(&self, input: &GrepEngineInput) -> Result<Vec<RgCount>> {
        let matcher = self.build_matcher(input)?;
        let walker = self.build_walk(input).build_parallel();
        let counts: Arc<Mutex<Vec<RgCount>>> = Arc::new(Mutex::new(Vec::new()));
        let max_cols = input.max_columns;

        walker.run(|| {
            let matcher = matcher.clone();
            let counts = Arc::clone(&counts);
            Box::new(move |result| {
                let entry = match result {
                    Ok(e) => e,
                    Err(_) => return WalkState::Continue,
                };
                let p = entry.path();
                if !p.is_file() {
                    return WalkState::Continue;
                }
                let mut searcher = SearcherBuilder::new()
                    .binary_detection(BinaryDetection::quit(b'\x00'))
                    .build();
                let mut sink = CountSink {
                    count: 0,
                    max_cols,
                };
                let _ = searcher.search_path(&matcher, p, &mut sink);
                if sink.count > 0 {
                    let mut g = counts.lock().unwrap();
                    g.push(RgCount {
                        path: p.to_string_lossy().into_owned(),
                        count: sink.count,
                    });
                }
                WalkState::Continue
            })
        });
        let mut out = Arc::try_unwrap(counts).unwrap().into_inner().unwrap();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }
}

// ---- grep-searcher sinks ----

struct VecSink {
    path: String,
    matches: Vec<RgMatch>,
    max_cols: usize,
}

impl Sink for VecSink {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        let text = decode_line(mat.bytes(), self.max_cols);
        let line_number = mat.line_number().unwrap_or(0);
        self.matches.push(RgMatch {
            path: self.path.clone(),
            line_number,
            text,
            is_context: false,
        });
        Ok(true)
    }

    fn context(
        &mut self,
        _searcher: &Searcher,
        ctx: &grep_searcher::SinkContext<'_>,
    ) -> Result<bool, Self::Error> {
        let text = decode_line(ctx.bytes(), self.max_cols);
        let line_number = ctx.line_number().unwrap_or(0);
        self.matches.push(RgMatch {
            path: self.path.clone(),
            line_number,
            text,
            is_context: true,
        });
        Ok(true)
    }
}

struct CountSink {
    count: u64,
    max_cols: usize,
}

impl Sink for CountSink {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        _mat: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        self.count += 1;
        let _ = self.max_cols; // unused; silence warning
        Ok(true)
    }
}

fn decode_line(bytes: &[u8], max_cols: usize) -> String {
    let s = String::from_utf8_lossy(bytes);
    let trimmed = s.trim_end_matches(|c| c == '\n' || c == '\r');
    if trimmed.len() > max_cols {
        format!(
            "{}... (line truncated to {} chars)",
            &trimmed[..max_cols],
            max_cols
        )
    } else {
        trimmed.to_string()
    }
}

/// Detect whether a pattern compiles. Used so the tool can return
/// `INVALID_REGEX` with the upstream error BEFORE attempting a full
/// walk.
pub fn compile_probe(pattern: &str) -> Result<(), String> {
    match RegexMatcherBuilder::new().build(pattern) {
        Ok(_) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Reasonably stable mtime sort used by `files_with_matches` and
/// `content` modes. Falls back to path order when mtime is unavailable.
pub fn sort_paths_by_mtime(paths: &mut Vec<String>) {
    let mut with_mtime: Vec<(Option<std::time::SystemTime>, String)> = paths
        .drain(..)
        .map(|p| {
            let mtime = std::fs::metadata(&p).ok().and_then(|m| m.modified().ok());
            (mtime, p)
        })
        .collect();
    with_mtime.sort_by(|a, b| match (a.0, b.0) {
        (Some(ta), Some(tb)) => tb.cmp(&ta).then(a.1.cmp(&b.1)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.1.cmp(&b.1),
    });
    paths.extend(with_mtime.into_iter().map(|(_, p)| p));
}
