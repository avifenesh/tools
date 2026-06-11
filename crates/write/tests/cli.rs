//! Integration tests for the `harness-write-cli` JSON-RPC dispatch:
//! the canonical `multi_edit` method and the deprecated `multiedit`
//! alias must dispatch identically, and the alias must emit exactly one
//! deprecation warning per process on stderr.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use tempfile::TempDir;

struct Cli {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl Cli {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_harness-write-cli"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn harness-write-cli");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Cli { child, stdin, stdout }
    }

    fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        let req = json!({"id": id, "method": method, "params": params});
        let line = serde_json::to_string(&req).unwrap();
        self.stdin.write_all(line.as_bytes()).unwrap();
        self.stdin.write_all(b"\n").unwrap();
        self.stdin.flush().unwrap();
        let mut resp = String::new();
        self.stdout.read_line(&mut resp).unwrap();
        serde_json::from_str(&resp).expect("valid JSON-RPC response")
    }

    /// Close stdin, wait for exit, and return captured stderr.
    fn finish(mut self) -> String {
        drop(self.stdin);
        let mut stderr = String::new();
        use std::io::Read;
        self.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        let _ = self.child.wait();
        stderr
    }
}

fn session_params(root: &str, tool_params: Value) -> Value {
    json!({
        "params": tool_params,
        "session": { "cwd": root, "roots": [root] },
    })
}

fn result_kind(resp: &Value) -> &str {
    resp.get("result")
        .and_then(|r| r.get("kind"))
        .and_then(|k| k.as_str())
        .unwrap_or_else(|| panic!("response missing result.kind: {resp}"))
}

#[test]
fn multi_edit_canonical_and_legacy_methods_dispatch_identically() {
    let tmp = TempDir::new().unwrap();
    let root = std::fs::canonicalize(tmp.path())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let file = format!("{root}/f.txt");

    let mut cli = Cli::spawn();

    // Seed: write a new file (no prior read required) so the ledger has it.
    let resp = cli.call(
        1,
        "write",
        session_params(&root, json!({"path": file, "content": "alpha beta gamma\n"})),
    );
    assert_eq!(result_kind(&resp), "text");

    // Canonical method name.
    let resp = cli.call(
        2,
        "multi_edit",
        session_params(
            &root,
            json!({"path": file, "edits": [{"old_string": "alpha", "new_string": "ALPHA"}]}),
        ),
    );
    assert_eq!(result_kind(&resp), "text", "canonical multi_edit dispatches");

    // Deprecated legacy alias — same handler, same behavior.
    let resp = cli.call(
        3,
        "multiedit",
        session_params(
            &root,
            json!({"path": file, "edits": [{"old_string": "beta", "new_string": "BETA"}]}),
        ),
    );
    assert_eq!(result_kind(&resp), "text", "legacy multiedit still dispatches");

    // Second legacy call: still works, but must not emit a second warning.
    let resp = cli.call(
        4,
        "multiedit",
        session_params(
            &root,
            json!({"path": file, "edits": [{"old_string": "gamma", "new_string": "GAMMA"}]}),
        ),
    );
    assert_eq!(result_kind(&resp), "text");

    // A non-name is still method-not-found.
    let resp = cli.call(5, "multi-edit", session_params(&root, json!({})));
    assert!(
        resp.get("error").is_some(),
        "unknown method must error: {resp}"
    );

    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "ALPHA BETA GAMMA\n",
        "all three edits landed through both method spellings"
    );

    let stderr = cli.finish();
    let warnings = stderr
        .lines()
        .filter(|l| l.contains("DEPRECATION") && l.contains("multiedit"))
        .count();
    assert_eq!(
        warnings, 1,
        "legacy alias warns exactly once per process; stderr was: {stderr:?}"
    );
    assert!(
        stderr.contains("multi_edit"),
        "warning must say what to migrate to; stderr was: {stderr:?}"
    );
}

#[test]
fn canonical_method_does_not_warn() {
    let tmp = TempDir::new().unwrap();
    let root = std::fs::canonicalize(tmp.path())
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let file = format!("{root}/g.txt");

    let mut cli = Cli::spawn();
    let resp = cli.call(
        1,
        "write",
        session_params(&root, json!({"path": file, "content": "one two\n"})),
    );
    assert_eq!(result_kind(&resp), "text");

    let resp = cli.call(
        2,
        "multi_edit",
        session_params(
            &root,
            json!({"path": file, "edits": [{"old_string": "one", "new_string": "1"}]}),
        ),
    );
    assert_eq!(result_kind(&resp), "text");

    let stderr = cli.finish();
    assert!(
        !stderr.contains("DEPRECATION"),
        "canonical name must not warn; stderr was: {stderr:?}"
    );
}
