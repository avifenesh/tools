//! Integration tests mirroring `packages/skill/test/skill.test.ts`.
//! Same 30+ cases covering schema validation, registry discovery,
//! activation lifecycle, fence, permission/trust gating, argument
//! substitution, output shape, multi-root precedence, CRLF compat.

use harness_core::{PermissionDecision, PermissionPolicy};
use harness_core::permissions::{PermissionHook, PermissionQuery};
use harness_skill::types::{
    ActivatedSet, SkillArguments, SkillPermissionPolicy, SkillResult, SkillSessionConfig,
    SkillTrustMode, SkillTrustPolicy,
};
use harness_skill::{skill, FilesystemSkillRegistry};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;

fn write_skill(root: &Path, name: &str, frontmatter: &str, body: &str) -> PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\n{}\n---\n{}", frontmatter, body),
    )
    .unwrap();
    dir
}

fn write_resource(skill_dir: &Path, folder: &str, name: &str, content: &str) {
    let dir = skill_dir.join(folder);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(name), content).unwrap();
}

struct SessionOpts {
    root_dir: PathBuf,
    roots: Vec<String>,
    sensitive_patterns: Vec<String>,
    unsafe_allow_skill_without_hook: bool,
    hook: Option<PermissionHook>,
    trust: Option<SkillTrustPolicy>,
    user_initiated: bool,
    activated: Option<ActivatedSet>,
}

fn default_session(root: &Path) -> SessionOpts {
    SessionOpts {
        root_dir: root.to_path_buf(),
        roots: vec![root.to_string_lossy().into_owned()],
        sensitive_patterns: Vec::new(),
        unsafe_allow_skill_without_hook: true,
        hook: None,
        trust: Some(SkillTrustPolicy {
            trusted_roots: vec![root.to_string_lossy().into_owned()],
            untrusted_project_skills: None,
        }),
        user_initiated: false,
        activated: None,
    }
}

fn build(opts: SessionOpts) -> SkillSessionConfig {
    let mut perms = PermissionPolicy::new(opts.roots);
    perms.sensitive_patterns = opts.sensitive_patterns;
    perms.hook = opts.hook;
    let skill_perms = SkillPermissionPolicy::new(perms)
        .with_unsafe_bypass(opts.unsafe_allow_skill_without_hook);
    let registry = Arc::new(FilesystemSkillRegistry::new(vec![
        opts.root_dir.to_string_lossy().into_owned()
    ]));
    let mut cfg =
        SkillSessionConfig::new(opts.root_dir.to_string_lossy().into_owned(), skill_perms, registry);
    if let Some(t) = opts.trust {
        cfg.trust = t;
    }
    cfg.user_initiated = opts.user_initiated;
    if let Some(a) = opts.activated {
        cfg.activated = Some(a);
    }
    cfg
}

fn expect_error(r: &SkillResult) -> &harness_core::ToolError {
    match r {
        SkillResult::Error(e) => &e.error,
        _ => panic!("expected error, got {:?}", r),
    }
}

// ---- schema validation ----

#[tokio::test]
async fn rejects_empty_name() {
    let tmp = TempDir::new().unwrap();
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": ""}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::InvalidParam);
}

#[tokio::test]
async fn rejects_name_with_uppercase() {
    let tmp = TempDir::new().unwrap();
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "MySkill"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::InvalidParam);
    assert!(e.message.contains("lowercase-kebab-case"));
}

#[tokio::test]
async fn rejects_name_too_long() {
    let tmp = TempDir::new().unwrap();
    let s = build(default_session(tmp.path()));
    let too_long: String = "a".repeat(65);
    let r = skill(json!({"name": too_long}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::InvalidParam);
}

#[tokio::test]
async fn rejects_alias_skill_name() {
    let tmp = TempDir::new().unwrap();
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"skill_name": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::InvalidParam);
    assert!(e.message.contains("'name'"));
}

#[tokio::test]
async fn rejects_alias_params() {
    let tmp = TempDir::new().unwrap();
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo", "params": "x"}), &s).await;
    let e = expect_error(&r);
    assert!(e.message.contains("arguments"));
}

#[tokio::test]
async fn rejects_alias_reload() {
    let tmp = TempDir::new().unwrap();
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo", "reload": true}), &s).await;
    let e = expect_error(&r);
    assert!(e.message.contains("load once"));
}

// ---- registry discovery ----

#[tokio::test]
async fn not_found_with_fuzzy_siblings() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "tweet-thread", "name: tweet-thread\ndescription: x", "body");
    write_skill(tmp.path(), "joi", "name: joi\ndescription: y", "body");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "tweet-threads"}), &s).await;
    match r {
        SkillResult::NotFound(nf) => {
            assert!(nf.siblings.contains(&"tweet-thread".to_string()));
        }
        other => panic!("expected not_found, got {:?}", other),
    }
}

#[tokio::test]
async fn skips_directory_with_no_skill_md() {
    let tmp = TempDir::new().unwrap();
    fs::create_dir_all(tmp.path().join("not-a-skill")).unwrap();
    write_skill(tmp.path(), "real", "name: real\ndescription: x", "body");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "real"}), &s).await;
    assert!(matches!(r, SkillResult::Ok(_)));
}

#[tokio::test]
async fn name_mismatch_when_frontmatter_and_dir_disagree() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "bar", "name: foo\ndescription: x", "body");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "bar"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::NameMismatch);
}

#[tokio::test]
async fn invalid_frontmatter_on_missing_description() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo", "body");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::InvalidFrontmatter);
    assert!(e.message.contains("description"));
}

#[tokio::test]
async fn invalid_frontmatter_on_broken_yaml() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name foo\ndescription: x", "body");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::InvalidFrontmatter);
}

// ---- activation ----

#[tokio::test]
async fn ok_on_first_activation() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "# Foo\nhello");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo"}), &s).await;
    match r {
        SkillResult::Ok(ok) => {
            assert!(ok.body.contains("hello"));
            assert!(ok.output.contains("<skill name=\"foo\""));
        }
        other => panic!("expected ok, got {:?}", other),
    }
}

#[tokio::test]
async fn already_loaded_on_second_activation() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "body");
    let activated = ActivatedSet::new();
    let mut opts = default_session(tmp.path());
    opts.activated = Some(activated);
    let s = build(opts);
    let _ = skill(json!({"name": "foo"}), &s).await;
    let r2 = skill(json!({"name": "foo"}), &s).await;
    assert!(matches!(r2, SkillResult::AlreadyLoaded(_)));
}

#[tokio::test]
async fn does_not_dedupe_if_activated_omitted() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "body");
    let s = build(default_session(tmp.path()));
    let r1 = skill(json!({"name": "foo"}), &s).await;
    let r2 = skill(json!({"name": "foo"}), &s).await;
    assert!(matches!(r1, SkillResult::Ok(_)));
    assert!(matches!(r2, SkillResult::Ok(_)));
}

#[tokio::test]
async fn enumerates_resources() {
    let tmp = TempDir::new().unwrap();
    let dir = write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "body");
    write_resource(&dir, "scripts", "audit.py", "");
    write_resource(&dir, "scripts", "format.sh", "");
    write_resource(&dir, "references", "schema.md", "");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo"}), &s).await;
    match r {
        SkillResult::Ok(ok) => {
            assert!(ok.resources.iter().any(|r| r == "scripts/audit.py"));
            assert!(ok.resources.iter().any(|r| r == "scripts/format.sh"));
            assert!(ok.resources.iter().any(|r| r == "references/schema.md"));
        }
        other => panic!("expected ok, got {:?}", other),
    }
}

#[tokio::test]
async fn disabled_when_disable_model_invocation_and_not_user_initiated() {
    let tmp = TempDir::new().unwrap();
    write_skill(
        tmp.path(),
        "foo",
        "name: foo\ndescription: hi\ndisable-model-invocation: true",
        "body",
    );
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::Disabled);
}

#[tokio::test]
async fn activates_disabled_skill_when_user_initiated() {
    let tmp = TempDir::new().unwrap();
    write_skill(
        tmp.path(),
        "foo",
        "name: foo\ndescription: hi\ndisable-model-invocation: true",
        "body",
    );
    let mut opts = default_session(tmp.path());
    opts.user_initiated = true;
    let s = build(opts);
    let r = skill(json!({"name": "foo"}), &s).await;
    assert!(matches!(r, SkillResult::Ok(_)));
}

// ---- fence ----

#[tokio::test]
async fn outside_workspace_when_skill_dir_not_under_root() {
    let skill_root = TempDir::new().unwrap();
    let fence_root = TempDir::new().unwrap();
    write_skill(skill_root.path(), "foo", "name: foo\ndescription: x", "body");
    let mut opts = default_session(skill_root.path());
    // fence root is the unrelated dir, but we discover from skill_root.
    opts.roots = vec![fence_root.path().to_string_lossy().into_owned()];
    let s = build(opts);
    let r = skill(json!({"name": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::OutsideWorkspace);
}

#[tokio::test]
async fn sensitive_when_dir_matches_sensitive_pattern() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "secrets-skill", "name: secrets-skill\ndescription: x", "body");
    let mut opts = default_session(tmp.path());
    opts.sensitive_patterns = vec!["**/secrets-*/**".into(), "**/secrets-*".into()];
    let s = build(opts);
    let r = skill(json!({"name": "secrets-skill"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::Sensitive);
}

// ---- permissions + trust ----

#[tokio::test]
async fn permission_denied_without_hook_and_no_bypass() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "body");
    let mut opts = default_session(tmp.path());
    opts.unsafe_allow_skill_without_hook = false;
    // Trust policy still trusts our root so we exercise normal-reason denial.
    let s = build(opts);
    let r = skill(json!({"name": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::PermissionDenied);
}

#[tokio::test]
async fn not_trusted_for_untrusted_project_skill_with_no_hook() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "body");
    let mut opts = default_session(tmp.path());
    opts.trust = Some(SkillTrustPolicy {
        trusted_roots: vec![],
        untrusted_project_skills: Some(SkillTrustMode::HookRequired),
    });
    let s = build(opts);
    let r = skill(json!({"name": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::NotTrusted);
}

#[tokio::test]
async fn ok_when_trust_mode_is_allow() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "body");
    let mut opts = default_session(tmp.path());
    opts.trust = Some(SkillTrustPolicy {
        trusted_roots: vec![],
        untrusted_project_skills: Some(SkillTrustMode::Allow),
    });
    let s = build(opts);
    let r = skill(json!({"name": "foo"}), &s).await;
    assert!(matches!(r, SkillResult::Ok(_)));
}

#[tokio::test]
async fn hook_receives_skill_frontmatter_as_metadata() {
    use std::sync::Mutex;
    let tmp = TempDir::new().unwrap();
    write_skill(
        tmp.path(),
        "foo",
        "name: foo\ndescription: hi\nversion: 1.0.0",
        "body",
    );
    let captured: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
    let captured_clone = Arc::clone(&captured);
    let hook: PermissionHook = Arc::new(move |q: PermissionQuery| {
        let captured_clone = Arc::clone(&captured_clone);
        Box::pin(async move {
            *captured_clone.lock().unwrap() = Some(q.metadata);
            PermissionDecision::Allow
        })
    });
    let mut opts = default_session(tmp.path());
    opts.hook = Some(hook);
    let s = build(opts);
    let r = skill(json!({"name": "foo"}), &s).await;
    assert!(matches!(r, SkillResult::Ok(_)));
    let meta = captured.lock().unwrap().clone().unwrap();
    assert_eq!(meta.get("name").and_then(|v| v.as_str()), Some("foo"));
    assert_eq!(
        meta.get("frontmatter")
            .and_then(|f| f.get("version"))
            .and_then(|v| v.as_str()),
        Some("1.0.0"),
    );
}

#[tokio::test]
async fn denies_when_hook_returns_deny() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "body");
    let hook: PermissionHook = Arc::new(|_q| Box::pin(async { PermissionDecision::Deny }));
    let mut opts = default_session(tmp.path());
    opts.hook = Some(hook);
    let s = build(opts);
    let r = skill(json!({"name": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::PermissionDenied);
}

#[tokio::test]
async fn treats_hook_ask_as_deny_autonomous() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "body");
    let hook: PermissionHook = Arc::new(|_q| Box::pin(async { PermissionDecision::Ask }));
    let mut opts = default_session(tmp.path());
    opts.hook = Some(hook);
    let s = build(opts);
    let r = skill(json!({"name": "foo"}), &s).await;
    let e = expect_error(&r);
    assert_eq!(e.code, harness_core::ToolErrorCode::PermissionDenied);
}

// ---- argument substitution ----

#[tokio::test]
async fn substitutes_arguments_string_form() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "run: $ARGUMENTS");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo", "arguments": "path/to/x"}), &s).await;
    match r {
        SkillResult::Ok(ok) => assert!(ok.body.contains("run: path/to/x")),
        other => panic!("expected ok, got {:?}", other),
    }
}

#[tokio::test]
async fn substitutes_positional_dollar_n() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "a=$1 b=$2");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo", "arguments": "one two"}), &s).await;
    match r {
        SkillResult::Ok(ok) => assert!(ok.body.contains("a=one b=two")),
        other => panic!("expected ok, got {:?}", other),
    }
}

#[tokio::test]
async fn leaves_unsubstituted_placeholders_literal() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "p=$ARGUMENTS q=$1");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo"}), &s).await;
    match r {
        SkillResult::Ok(ok) => {
            assert!(ok.body.contains("$ARGUMENTS"));
            assert!(ok.body.contains("$1"));
        }
        other => panic!("expected ok, got {:?}", other),
    }
}

#[tokio::test]
async fn substitutes_named_when_frontmatter_declares_arguments() {
    let tmp = TempDir::new().unwrap();
    write_skill(
        tmp.path(),
        "foo",
        "name: foo\ndescription: hi\narguments:\n  path: {type: string}",
        "target=${path}",
    );
    let s = build(default_session(tmp.path()));
    let r = skill(
        json!({"name": "foo", "arguments": {"path": "/tmp/x"}}),
        &s,
    )
    .await;
    match r {
        SkillResult::Ok(ok) => assert!(ok.body.contains("target=/tmp/x")),
        other => panic!("expected ok, got {:?}", other),
    }
}

#[tokio::test]
async fn rejects_object_args_when_no_decl() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "body");
    let s = build(default_session(tmp.path()));
    let r = skill(
        json!({"name": "foo", "arguments": {"x": "y"}}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.message.contains("named arguments"));
}

#[tokio::test]
async fn rejects_string_args_when_skill_declares_named() {
    let tmp = TempDir::new().unwrap();
    write_skill(
        tmp.path(),
        "foo",
        "name: foo\ndescription: hi\narguments:\n  path: {type: string}",
        "body",
    );
    let s = build(default_session(tmp.path()));
    let r = skill(
        json!({"name": "foo", "arguments": "ignored"}),
        &s,
    )
    .await;
    let e = expect_error(&r);
    assert!(e.message.contains("named arguments"));
}

// ---- output shape ----

#[tokio::test]
async fn wraps_body_in_skill_element() {
    let tmp = TempDir::new().unwrap();
    write_skill(tmp.path(), "foo", "name: foo\ndescription: hi", "body goes here");
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo"}), &s).await;
    match r {
        SkillResult::Ok(ok) => {
            assert!(ok.output.contains("<skill name=\"foo\""));
            assert!(ok.output.contains("<frontmatter>"));
            assert!(ok.output.contains("<instructions>"));
            assert!(ok.output.contains("body goes here"));
            assert!(ok.output.contains("</skill>"));
        }
        other => panic!("expected ok, got {:?}", other),
    }
}

#[tokio::test]
async fn preserves_unknown_frontmatter_fields() {
    let tmp = TempDir::new().unwrap();
    write_skill(
        tmp.path(),
        "foo",
        "name: foo\ndescription: hi\nhooks: some-thing\nmodel: opus",
        "body",
    );
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo"}), &s).await;
    match r {
        SkillResult::Ok(ok) => {
            assert_eq!(
                ok.frontmatter.get("hooks").and_then(|v| v.as_str()),
                Some("some-thing")
            );
            assert_eq!(
                ok.frontmatter.get("model").and_then(|v| v.as_str()),
                Some("opus")
            );
        }
        other => panic!("expected ok, got {:?}", other),
    }
}

#[tokio::test]
async fn normalizes_allowed_tools_string_to_array() {
    let tmp = TempDir::new().unwrap();
    write_skill(
        tmp.path(),
        "foo",
        r#"name: foo
description: hi
allowed-tools: "Read, Grep, Bash(git:*)""#,
        "body",
    );
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo"}), &s).await;
    match r {
        SkillResult::Ok(ok) => {
            let tools = ok
                .frontmatter
                .get("allowed-tools")
                .and_then(|v| v.as_array())
                .unwrap();
            let names: Vec<&str> = tools.iter().filter_map(|v| v.as_str()).collect();
            assert_eq!(names, vec!["Read", "Grep", "Bash(git:*)"]);
        }
        other => panic!("expected ok, got {:?}", other),
    }
}

// ---- multi-root precedence ----

#[tokio::test]
async fn project_root_shadows_user_root_on_name_collision() {
    let project_root = TempDir::new().unwrap();
    let user_root = TempDir::new().unwrap();
    write_skill(
        project_root.path(),
        "foo",
        "name: foo\ndescription: project version",
        "project",
    );
    write_skill(
        user_root.path(),
        "foo",
        "name: foo\ndescription: user version",
        "user",
    );
    let mut perms = PermissionPolicy::new(vec![
        project_root.path().to_string_lossy().into_owned(),
        user_root.path().to_string_lossy().into_owned(),
    ]);
    perms.sensitive_patterns = Vec::new();
    let skill_perms = SkillPermissionPolicy::new(perms).with_unsafe_bypass(true);
    let registry = Arc::new(FilesystemSkillRegistry::new(vec![
        project_root.path().to_string_lossy().into_owned(),
        user_root.path().to_string_lossy().into_owned(),
    ]));
    let mut cfg = SkillSessionConfig::new(
        project_root.path().to_string_lossy().into_owned(),
        skill_perms,
        registry,
    );
    cfg.trust = SkillTrustPolicy {
        trusted_roots: vec![
            project_root.path().to_string_lossy().into_owned(),
            user_root.path().to_string_lossy().into_owned(),
        ],
        untrusted_project_skills: None,
    };
    let r = skill(json!({"name": "foo"}), &cfg).await;
    match r {
        SkillResult::Ok(ok) => {
            assert!(ok.body.contains("project"));
            assert!(!ok.body.contains("user"));
        }
        other => panic!("expected ok, got {:?}", other),
    }
}

// ---- CRLF compatibility ----

#[tokio::test]
async fn parses_crlf_skill_md() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("foo");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        "---\r\nname: foo\r\ndescription: hi\r\n---\r\nbody with crlf\r\n",
    )
    .unwrap();
    let s = build(default_session(tmp.path()));
    let r = skill(json!({"name": "foo"}), &s).await;
    match r {
        SkillResult::Ok(ok) => assert!(ok.body.contains("body with crlf")),
        other => panic!("expected ok, got {:?}", other),
    }
}

// ---- smoke: SkillArguments variants serialize/deserialize cleanly ----

#[test]
fn skill_arguments_deserializes_string() {
    let s: SkillArguments = serde_json::from_value(json!("hello")).unwrap();
    match s {
        SkillArguments::String(v) => assert_eq!(v, "hello"),
        _ => panic!("expected string variant"),
    }
}

#[test]
fn skill_arguments_deserializes_object() {
    let s: SkillArguments = serde_json::from_value(json!({"a": "1", "b": "2"})).unwrap();
    match s {
        SkillArguments::Object(map) => assert_eq!(map.len(), 2),
        _ => panic!("expected object variant"),
    }
}
