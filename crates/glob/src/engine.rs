use anyhow::Result;
use ignore::WalkBuilder;
use std::path::PathBuf;

/// Pluggable engine — default enumerates files via `ignore::WalkBuilder`
/// (the same machinery ripgrep uses for its ignore-aware walk). The
/// pattern filter happens OUTSIDE this engine in the orchestrator,
/// matching the TS design where the engine is pure enumeration.
pub trait GlobEngine: Send + Sync {
    fn list(&self, input: &GlobEngineInput) -> Result<Vec<String>>;
}

#[derive(Debug, Clone)]
pub struct GlobEngineInput {
    pub root: PathBuf,
    pub max_filesize: u64,
}

pub fn default_engine() -> Box<dyn GlobEngine> {
    Box::new(IgnoreWalkEngine)
}

pub struct IgnoreWalkEngine;

impl GlobEngine for IgnoreWalkEngine {
    fn list(&self, input: &GlobEngineInput) -> Result<Vec<String>> {
        let mut wb = WalkBuilder::new(&input.root);
        wb.hidden(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .ignore(true)
            .parents(true)
            .follow_links(false)
            .max_filesize(Some(input.max_filesize))
            .require_git(false)
            .add_custom_ignore_filename(".rgignore");
        let walker = wb.build();
        let mut out: Vec<String> = Vec::new();
        for entry in walker.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            out.push(path.to_string_lossy().into_owned());
        }
        Ok(out)
    }
}
