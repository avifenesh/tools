use async_trait::async_trait;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::constants::{MAX_RESOURCES_PER_FOLDER, RESOURCE_FOLDERS, SKILL_FILENAME};
use crate::frontmatter::{split_frontmatter, validate_frontmatter, ValidationError};
use crate::types::{LoadedSkill, SkillEntry, SkillRegistry};

/// Filesystem-backed SkillRegistry. Mirrors the TS FilesystemSkillRegistry:
/// walk each root, look for `<name>/SKILL.md`, parse, dedupe by name with
/// project (lower-index) > user precedence.
pub struct FilesystemSkillRegistry {
    roots: Vec<String>,
}

impl FilesystemSkillRegistry {
    pub fn new(roots: impl IntoIterator<Item = String>) -> Self {
        Self {
            roots: roots.into_iter().collect(),
        }
    }
}

#[async_trait]
impl SkillRegistry for FilesystemSkillRegistry {
    async fn discover(&self) -> Result<Vec<SkillEntry>, String> {
        let mut by_name: HashMap<String, SkillEntry> = HashMap::new();
        let mut shadows: HashMap<String, Vec<String>> = HashMap::new();

        for (root_index, root) in self.roots.iter().enumerate() {
            let mut read_dir = match tokio::fs::read_dir(root).await {
                Ok(rd) => rd,
                Err(_) => continue,
            };
            while let Ok(Some(entry)) = read_dir.next_entry().await {
                let child = match entry.file_name().to_str() {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                let dir = entry.path();
                let file_type = match entry.file_type().await {
                    Ok(ft) => ft,
                    Err(_) => continue,
                };
                if !file_type.is_dir() {
                    continue;
                }
                let skill_path = dir.join(SKILL_FILENAME);
                let text = match tokio::fs::read_to_string(&skill_path).await {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let split = match split_frontmatter(&text) {
                    Ok(Some(pair)) => pair,
                    Ok(None) => continue, // no frontmatter — not a skill
                    Err(e) => {
                        // Surface invalid frontmatter as a synthetic entry
                        // so the orchestrator can emit a structured error.
                        let mut fm = Map::new();
                        fm.insert(
                            "__skill_error".to_string(),
                            Value::String(e.reason.clone()),
                        );
                        if let Some(line) = e.line {
                            fm.insert("__skill_error_line".to_string(), Value::from(line));
                        }
                        by_name.insert(
                            child.clone(),
                            SkillEntry {
                                name: child.clone(),
                                description: String::new(),
                                dir: dir.to_string_lossy().into_owned(),
                                root_index,
                                frontmatter: Value::Object(fm),
                                shadowed: None,
                            },
                        );
                        continue;
                    }
                };
                let (fm_text, body) = split;
                let validated = match validate_frontmatter(&fm_text, &body, &child) {
                    Ok(v) => v,
                    Err(e) => {
                        let (reason, code, line) = match e {
                            ValidationError::InvalidFrontmatter { reason, line } => {
                                (reason, "INVALID_FRONTMATTER", line)
                            }
                            ValidationError::NameMismatch { reason } => {
                                (reason, "NAME_MISMATCH", None)
                            }
                        };
                        let mut fm = Map::new();
                        fm.insert("__skill_error".into(), Value::String(reason));
                        fm.insert("__skill_error_code".into(), Value::String(code.into()));
                        if let Some(l) = line {
                            fm.insert("__skill_error_line".into(), Value::from(l));
                        }
                        by_name.insert(
                            child.clone(),
                            SkillEntry {
                                name: child.clone(),
                                description: String::new(),
                                dir: dir.to_string_lossy().into_owned(),
                                root_index,
                                frontmatter: Value::Object(fm),
                                shadowed: None,
                            },
                        );
                        continue;
                    }
                };

                // Shadow handling: lower-index root wins.
                if let Some(existing) = by_name.get(&child) {
                    if existing.root_index <= root_index {
                        shadows
                            .entry(child.clone())
                            .or_default()
                            .push(dir.to_string_lossy().into_owned());
                        continue;
                    } else {
                        shadows
                            .entry(child.clone())
                            .or_default()
                            .push(existing.dir.clone());
                    }
                }

                let description = validated
                    .frontmatter
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                by_name.insert(
                    child.clone(),
                    SkillEntry {
                        name: child,
                        description,
                        dir: dir.to_string_lossy().into_owned(),
                        root_index,
                        frontmatter: Value::Object(validated.frontmatter),
                        shadowed: None,
                    },
                );
            }
        }

        let mut entries: Vec<SkillEntry> = by_name.into_values().collect();
        for e in &mut entries {
            if let Some(shadow_list) = shadows.get(&e.name) {
                if !shadow_list.is_empty() {
                    e.shadowed = Some(shadow_list.clone());
                }
            }
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    }

    async fn load(&self, name: &str) -> Result<Option<LoadedSkill>, String> {
        let entries = self.discover().await?;
        let entry = match entries.into_iter().find(|e| e.name == name) {
            Some(e) => e,
            None => return Ok(None),
        };
        let skill_path = PathBuf::from(&entry.dir).join(SKILL_FILENAME);
        let text = match tokio::fs::read_to_string(&skill_path).await {
            Ok(t) => t,
            Err(_) => return Ok(None),
        };
        let (fm_text, body) = match split_frontmatter(&text) {
            Ok(Some(pair)) => pair,
            _ => return Ok(None),
        };
        let validated = match validate_frontmatter(&fm_text, &body, name) {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };
        let resources = enumerate_resources(Path::new(&entry.dir)).await;
        Ok(Some(LoadedSkill {
            name: entry.name,
            description: entry.description,
            dir: entry.dir,
            root_index: entry.root_index,
            frontmatter: Value::Object(validated.frontmatter),
            body: validated.body,
            resources,
            shadowed: entry.shadowed,
        }))
    }
}

async fn enumerate_resources(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for folder in RESOURCE_FOLDERS {
        let p = dir.join(folder);
        let mut read_dir = match tokio::fs::read_dir(&p).await {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        let mut children: Vec<String> = Vec::new();
        while let Ok(Some(entry)) = read_dir.next_entry().await {
            if let Some(n) = entry.file_name().to_str() {
                children.push(n.to_string());
            }
        }
        children.sort();
        let total = children.len();
        let take_count = MAX_RESOURCES_PER_FOLDER.min(total);
        for c in children.iter().take(take_count) {
            out.push(format!("{}/{}", folder, c));
        }
        if total > MAX_RESOURCES_PER_FOLDER {
            out.push(format!(
                "{}/(... {} more)",
                folder,
                total - MAX_RESOURCES_PER_FOLDER
            ));
        }
    }
    out
}
