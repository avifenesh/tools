# Write Tool — Cross-Language Design Spec

**Status**: Draft v1 — 2026-04-20
**Implementations**: TypeScript (`@agent-sh/harness-write`), Rust (pending)
**Scope**: Language-neutral contract for Write, Edit, and MultiEdit. Implementation files (`packages/write/` for TS, `crates/write/` for Rust) must conform.
**Companion**: `read.md` (shared ledger + path-safety + permission hook).

This spec is the source of truth. Implementation-specific ergonomics are allowed; public semantics are not.

---

## 1. Purpose

Expose file mutation to an LLM as three structured tools (`Write`, `Edit`, `MultiEdit`) with invariants the tool layer enforces because the model cannot be trusted with them:

- **Read-before-mutate** via a sha-anchored session ledger (see §8 in `read.md`).
- **Uniqueness of `old_string`** on `Edit` (or explicit `replace_all`).
- **Structured fuzzy diagnostics** on `old_string` miss so the model self-corrects in one turn.
- **Per-file atomicity**: fail-fast in memory, atomic rename on commit.
- **Path safety** mirroring Read: absolute-only, realpath, workspace-bounded, sensitive-path hook.
- **Binary refusal on string-based edits**; binary-permitting Write only.
- **Opt-in validate/lint hook** to reject bad edits before disk.

Non-goals (deliberately excluded in v1):

- `apply_patch` / V4A / SEARCH-REPLACE parsing.
- Cross-file atomicity, `begin_edit`/`commit_edit`, transactional wrappers.
- Notebook (`.ipynb`) editing — rejected with a structured error.
- `undo_edit` — encourages reverting over diagnosing.
- Rename or delete as tool primitives — use Bash or a future file-ops tool.

Rationale: Every major autonomous system that ships cross-file atomicity ships it via external git transactions, not a tool primitive. Ours will too. `apply_patch` regresses on Qwen well-formedness (our primary model target) and adds surface the user explicitly declined. See `feedback_write_atomicity.md`.

---

## 2. Tool surface

Three tools, all subject to the same permission model, ledger, and path safety:

```text
Write(path, content)
Edit(path, old_string, new_string, replace_all?, dry_run?)
MultiEdit(path, edits[], dry_run?)
```

Rationale: This is the Claude Code shape. Qwen and Claude are both trained on this vocabulary; it's the highest-coverage surface in public SFT data. See Decision D1.

### 2.1 Tool descriptions (LLM-facing)

The exact description text shipped with the tool schema matters as much as the code. These are the contract with the model.

- **Write**: *"Create a new file, or overwrite an existing file. If the file already exists, you must Read it first in this session. Prefer `Edit` or `MultiEdit` for targeted changes to existing files — use `Write` only for new files or genuine wholesale rewrites."*
- **Edit**: *"Replace exactly one occurrence of `old_string` with `new_string` in a file. The file must have been Read first. `old_string` must match the file content exactly, character for character, including whitespace. If `old_string` appears more than once, you will get an error listing all matches; widen `old_string` with surrounding context until unique, or pass `replace_all: true` for rename-style changes."*
- **MultiEdit**: *"Apply a sequence of edits to a single file atomically. Each edit is `{old_string, new_string, replace_all?}`; later edits see the output of earlier ones. If any edit fails, none are applied and the file is untouched."*

---

## 3. Input contract

### 3.1 `Write`

```text
{
  path:    string   // required, absolute
  content: string   // required; bytes for binary created via a typed overload
}
```

### 3.2 `Edit`

```text
{
  path:        string
  old_string:  string   // must match exactly once, unless replace_all: true
  new_string:  string
  replace_all: bool?    // default false
  dry_run:     bool?    // default false
}
```

### 3.3 `MultiEdit`

```text
{
  path:    string
  edits:   [{
    old_string:  string,
    new_string:  string,
    replace_all: bool?  // default false, scoped to this edit only
  }, ...]
  dry_run: bool?
}
```

### 3.4 Path normalization

Same rules as Read:

1. Relative → resolve against session `cwd`.
2. Windows → normalize separators internally; preserve display form in errors.
3. Resolve symlinks (`realpath`). All later checks use the resolved path.
4. Reject with `OUTSIDE_WORKSPACE` if the resolved path escapes every configured workspace root (unless the permission hook allows).

### 3.5 Parameter validation

- Empty `old_string` on a non-empty file → `INVALID_PARAM` (ambiguous).
- Empty `old_string` on an empty file → `EMPTY_FILE` (use Write instead).
- `old_string == new_string` on any edit → `NO_OP_EDIT`.
- `edits.length == 0` on MultiEdit → `INVALID_PARAM`.
- Absent `path` → `INVALID_PARAM`.

---

## 4. Output contract

Output is a discriminated union by `kind`, same shape as Read.

### 4.1 `kind: "text"` (success)

```text
<path>{absolute_path}</path>
<result>
{human-readable summary}
</result>
```

Summary is one line per meaningful fact:

- `Wrote N bytes to {path}` (new file)
- `Overwrote {path} (was N bytes, now M bytes, +A -B)`
- `Edited {path}: 1 replacement (+A -B bytes)`
- `Edited {path}: 12 replacements (replace_all) (+A -B bytes)`
- `MultiEdit {path}: 4 edits applied (+A -B bytes)`

Warnings append on their own line:

- `Warning: replace_all pattern matched inside larger identifiers at lines [...]`

### 4.2 `kind: "preview"` (dry_run)

```text
<path>{absolute_path}</path>
<preview>
{unified diff, git-style, 3 lines of context}
</preview>
(would write N bytes, +A -B; no changes applied)
```

Unified diff produced via the same algorithm MCP filesystem uses (`createTwoFilesPatch` equivalent). Dynamic fencing is not required — output already escapes the diff header.

### 4.3 `kind: "error"`

Same shape as Read. Every error carries a stable `code`. Message format:

```text
Error [{code}]: {human message}

{optional structured candidates or hints}
```

### 4.4 Error taxonomy

| `code` | When |
|---|---|
| `NOT_READ_THIS_SESSION` | File exists but no ledger entry for the path. Message tells the model to call Read first. |
| `STALE_READ` | Ledger sha doesn't match current on-disk sha. Return new sha; instruct model to Re-Read. |
| `OLD_STRING_NOT_FOUND` | Zero matches. Include top-K fuzzy candidates (§5.2). |
| `OLD_STRING_NOT_UNIQUE` | ≥2 exact matches (and `replace_all` is false). List each match with line number + ±3 lines of context. |
| `EMPTY_FILE` | Edit invoked on a 0-byte file. Suggest Write. |
| `NO_OP_EDIT` | `old_string == new_string`. |
| `BINARY_NOT_EDITABLE` | Edit / MultiEdit invoked on a binary path. Write is allowed. |
| `NOTEBOOK_UNSUPPORTED` | Any mutation on `*.ipynb`. Suggest future NotebookEdit tool. |
| `NOT_FOUND` | Only Edit/MultiEdit — Write creates. Include fuzzy sibling suggestions. |
| `OUTSIDE_WORKSPACE` | Resolved path outside every configured root; no hook allowed. |
| `SENSITIVE_PATH` | Path matches default sensitive list; no hook or hook denied. |
| `DENIED_BY_HOOK` | Permission hook returned deny. |
| `VALIDATE_FAILED` | User-supplied validate hook rejected the post-edit content. Include `errors[]`. |
| `INVALID_PARAM` | Schema-level validation failure. |
| `IO_ERROR` | Unexpected filesystem failure; preserve underlying message in `cause`. |

---

## 5. `old_string` matching

### 5.1 Matching algorithm

1. **Normalize line endings**: CRLF on both sides → LF. Nothing else is normalized — tabs, trailing spaces, and indentation are preserved exactly.
2. **Exact substring search** on the normalized file content.
3. Count matches:
   - `0` and no fuzzy candidates above threshold → `OLD_STRING_NOT_FOUND` with empty `candidates`.
   - `0` and fuzzy candidates exist → `OLD_STRING_NOT_FOUND` with top-K.
   - `1` → apply.
   - `≥2` and `replace_all: true` → apply to all, include `warning` listing identifier-substring collisions (§5.3).
   - `≥2` and `replace_all: false` → `OLD_STRING_NOT_UNIQUE` with all match locations.

### 5.2 Fuzzy candidates on miss

When `OLD_STRING_NOT_FOUND` fires and the file is non-empty, compute top-K (default K=3) fuzzy matches:

- Windowing: slide a window of `len(old_string)` lines across the file.
- Scoring: Levenshtein similarity on normalized content. Threshold: `≥ 0.70`.
- Length tolerance: `|window_len - old_string_len| / max(...) < 0.15`.

Each candidate in the output:

```text
{
  line: <1-based line number of window start>,
  score: <0.00–1.00>,
  preview: <the candidate window content, verbatim>,
  context: {
    before: <up to 3 lines before>,
    after:  <up to 3 lines after>
  }
}
```

Rationale: SWE-agent's lint-gate + Aider's recovery strategies both validate that structured error signal dramatically raises the model's next-turn success rate. Prior art returns strings; we return structured candidates the model can pattern-match on.

### 5.3 `replace_all` substring detection

When `replace_all: true` succeeds with ≥2 replacements, run a post-hoc check: for each replacement position, if `old_string` is preceded or followed by a character in `[A-Za-z0-9_]` in the original text, flag the position. Report any flags in the success warning, naming line numbers. This catches the classic `user` vs `username` trap without rejecting the edit.

---

## 6. MultiEdit semantics

- Edits apply **sequentially in memory**, each against the output of the previous.
- Each edit has its own `replace_all` scope.
- **Fail-fast**: on the first failing edit, abort. Return the edit index that failed and the structured error for that specific edit (`OLD_STRING_NOT_FOUND` with candidates, `OLD_STRING_NOT_UNIQUE` with match list, `NO_OP_EDIT`, etc.).
- Disk is never touched on any failure — atomic rename happens only after all edits succeed and the validate hook (if any) passes.
- `dry_run: true` returns the final unified diff and does not write.

---

## 7. Read-before-mutate ledger

Read's ledger (`read.md` §8) is the source of truth. The Write tool consumes it for both Write-overwrite and Edit/MultiEdit cases.

### 7.1 Ledger gate

Before any mutation:

1. Look up the most recent ledger entry for the resolved path.
2. If `Write` on a non-existent path → no ledger check (pure create).
3. If `Write` on an existing path → ledger entry required.
4. If `Edit` / `MultiEdit` → ledger entry required regardless.
5. With an entry, compute current `sha256` of disk bytes:
   - Equal to ledger sha → proceed.
   - Different → `STALE_READ` with the new sha and instruction to Re-Read.

Rationale (Decision D2): Exact-string match alone is insufficient for autonomous mode. A background modification that leaves the edited region untouched produces a silent incorrect edit elsewhere. Sha gate catches this; string match alone doesn't.

### 7.2 Ledger write on success

On a successful mutation, append a **post-mutation** ledger entry with the new sha. This becomes the anchor for subsequent edits without requiring the model to Re-Read after every write.

---

## 8. Path safety and permission model

Identical to Read (`read.md` §5):

- **Workspace roots** — resolved path must fall under one.
- **Sensitive patterns** — `.env`, `.ssh/**`, `*.pem`, `credentials.json`, etc. (same list as Read).
- **Permission hook** — same signature, with `tool: "write" | "edit" | "multiedit"`. Hook is called for out-of-workspace and sensitive-path cases. No hook wired → `OUTSIDE_WORKSPACE` / `SENSITIVE_PATH` error.

The hook receives the full intended mutation:

```text
async ask(req: {
  tool: "write" | "edit" | "multiedit",
  path: string,
  action: "write" | "edit",
  always_patterns: string[],
  metadata: {
    old_string_preview?: string,      // first 200 chars, edit/multiedit
    new_string_preview?: string,
    edit_count?: int,                 // multiedit
    write_bytes?: int,                // write
  },
}) → "allow" | "deny"
```

---

## 9. Binary handling

Binary detection uses the same hybrid rule as Read (§6 of `read.md`).

- `Write(path, content)` — allowed on any path. Content may be UTF-8 string (default) or raw bytes (via typed API / base64 hint). No content inspection.
- `Edit(path, ...)` on a binary-detected path → `BINARY_NOT_EDITABLE`. Binary detection applies to the target's pre-edit content.
- `MultiEdit(path, ...)` same as Edit.

Rationale: Textual `old_string` anchors in binary content are undefined behavior. Writing raw bytes wholesale is a legitimate use (test fixtures, generated assets).

---

## 10. Notebook refusal

Any path ending in `.ipynb` on Write / Edit / MultiEdit → `NOTEBOOK_UNSUPPORTED` with message:

```text
Error [NOTEBOOK_UNSUPPORTED]: Notebook editing is not supported in this version.
Use Read to inspect notebook cells. A dedicated NotebookEdit tool is planned for v2.
```

No special-case for JSON-as-text. If a user genuinely wants to treat an .ipynb as text, they can copy to `.ipynb.json`.

---

## 11. Disk atomicity

Every successful mutation lands via:

1. Open `<target>.{pid}.{rand}.tmp` in the same directory as the target.
2. Write bytes.
3. `fsync` the file descriptor.
4. `rename(tmp, target)` — atomic on POSIX and on Windows NTFS.
5. `fsync` the parent directory (Linux) or equivalent (best-effort cross-platform).

If any step fails, remove the tmp file (best-effort) and return `IO_ERROR`. No partial state on disk.

The rename defeats concurrent-reader tearing and symlink races. If the target is a symlink, the rename replaces the symlink itself (not the target) — this is intentional and documented; users who want symlink-target edits must resolve the path beforehand.

---

## 12. Validate hook (optional)

Off by default. If configured on the session:

```text
async validate(ctx: {
  path: string,
  content: string,              // post-mutation content
  previous_content?: string,    // null on Write-create
}) → { ok: bool, errors?: [{line?, message}] }
```

Runs after in-memory mutation, before the atomic rename. If `ok: false`, no disk write occurs and the tool returns `VALIDATE_FAILED` with the error list.

Canonical implementations:

- TS: `tsc --noEmit` on changed TS/TSX files.
- JSON: `JSON.parse`.
- Python: `compile(source, path, "exec")`.
- Shell: `bash -n`.

No validator is bundled in v1; users wire their own. Off-by-default for performance.

---

## 13. Concurrency

Mutations of the same resolved path are **serialized** via a realpath-keyed mutex (same mutex as Read's §12). Across different paths, mutations are parallel.

Across Write/Edit/MultiEdit and Read, the same mutex prevents a Read from seeing an in-flight write's tmp file or half-renamed state.

---

## 14. Determinism

Two identical MultiEdit calls against an identical starting file produce byte-identical disk state. Ledger entries differ by timestamp; nothing else carries clocks.

---

## 15. Pluggable I/O backend

`WriteOperations` complements `ReadOperations` from Read:

```text
interface WriteOperations {
  writeAtomic(path, bytes, mode?): void         // temp + fsync + rename
  stat(path): { type, size, mtime_ms, readonly } | null
  sha256(path): string                           // byte-level
  mkdirp(path): void                             // for Write to new dirs
  realpath(path): string
}
```

Default implementation uses the host filesystem. Alternate backends (S3, WASM sandbox, remote FS) plug in without core changes.

---

## 16. Tests (acceptance suite — both languages must pass equivalent)

Minimum matrix (more in `write.tests.md`):

**Ledger / read-before-mutate**
1. Edit without prior Read → `NOT_READ_THIS_SESSION`.
2. Edit after Read, unchanged file → applies.
3. Edit after Read, file mutated externally in-between → `STALE_READ` with new sha.
4. Write on existing path without prior Read → `NOT_READ_THIS_SESSION`.
5. Write on new path (never existed) → creates, no ledger check.

**Matching**
6. Exact unique match → applies.
7. Exact non-unique match, `replace_all: false` → `OLD_STRING_NOT_UNIQUE` with ≥2 locations.
8. Exact non-unique match, `replace_all: true` → applies all; warning if substring collisions.
9. Zero match, fuzzy candidate at 0.91 → `OLD_STRING_NOT_FOUND` with candidate.
10. Zero match, no fuzzy candidate above 0.70 → `OLD_STRING_NOT_FOUND` with empty candidates.
11. CRLF file, LF-only `old_string` → matches (normalization).
12. Tab-vs-spaces mismatch → does not match (exact semantics preserved).

**MultiEdit**
13. Two edits, second depends on first's output → applies.
14. Two edits, second misses → entire batch rolled back, file untouched, error identifies failing edit index.
15. Dry-run → returns unified diff, no disk write.

**Edge cases**
16. Edit on empty file → `EMPTY_FILE`.
17. `old_string == new_string` → `NO_OP_EDIT`.
18. Edit on `.ipynb` → `NOTEBOOK_UNSUPPORTED`.
19. Edit on binary file → `BINARY_NOT_EDITABLE`.
20. Write of raw bytes to a new path, binary content → succeeds.

**Safety**
21. Edit path outside workspace, no hook → `OUTSIDE_WORKSPACE`.
22. Edit `.env`, no hook → `SENSITIVE_PATH`.
23. Edit sensitive path, hook returns allow → applies.
24. Edit sensitive path, hook returns deny → `DENIED_BY_HOOK`.

**Atomicity**
25. Interrupt simulation between tmp-write and rename → target retains old content.
26. Concurrent Edits on same path → serialized; both end states reflect both mutations.
27. Validate hook rejects → `VALIDATE_FAILED`, disk unchanged.

---

## 17. Decisions (rationale log)

Each captured via AskUserQuestion during the design walkthrough.

| ID | Decision | Rationale |
|---|---|---|
| D1 | Tool surface = `Write` + `Edit` + `MultiEdit`. | Claude Code shape has highest public-transcript coverage (Qwen/Claude training data). No `apply_patch` / V4A in v1. |
| D2 | Per-edit format = Anthropic `{old_string, new_string}`. | Highest well-formedness across Qwen/Claude/GPT per Aider benchmark + our own Read e2e observations. |
| D3 | No multi-file atomicity, now or ever via this tool. | User's firm position. Cross-file atomicity lives at the harness layer (git-as-transaction). See `feedback_write_atomicity.md`. |
| D4 | Model matrix for e2e = Qwen3.5:27b + Qwen3:8b + Claude via Bedrock Converse. | Covers size-sensitive regressions (27b vs 8b) plus cross-family coverage (Qwen vs Claude). OpenAI deferred — no V4A to validate against. |
| D5 | Ledger with sha + mtime, reject stale reads. | No upstream autonomous system ships sha-gated staleness. String-match alone misses "region unchanged, other region changed" bugs. |
| D6 | `old_string` must be unique or error with all match locations. | Claude Code behavior; keeps rename-vs-targeted-edit intent explicit. |
| D7 | On miss, return top-K fuzzy candidates with line numbers + ±3 lines context. | Structured recovery signal. Model's next-turn success rises sharply when error carries candidates vs. "not found" alone. |
| D8 | CRLF → LF normalization on both sides; exact otherwise. | MCP filesystem pattern. Catches Windows-repo drift without silently fixing indentation bugs the model should see. |
| D9 | Path safety mirrors Read: abs-only, realpath, workspace-bounded, sensitive-path hook, SENSITIVE_PATH / OUTSIDE_WORKSPACE fallback errors. | Symmetry with Read. Same mental model for the model. |
| D10 | Edit/MultiEdit refuse binary; Write allows raw bytes. | Textual anchors in binary content undefined; Write wholesale is a legitimate use. |
| D11 | MultiEdit applies sequentially in memory; later edits see earlier edits' output; fail-fast; atomic rename on full success. | Claude Code + MCP edit_file semantics. Enables "rename fn, then change signature" patterns. |
| D12 | `dry_run` on Edit and MultiEdit; not on Write. | MCP filesystem pattern. Write dry-run redundant with Read. |
| D13 | `replace_all` shipped as opt-in boolean on Edit. Warning emitted on substring-boundary collisions. | Rename use case is common; substring trap is documented and flagged post-hoc rather than rejected. |
| D14 | Validate hook shipped, off by default. | SWE-agent lint-gate is empirically valuable but has performance cost. Users opt in. |
| D15 | Output shape = discriminated union `text | preview | error`, mirroring Read. | Single parser across both tools; keeps the agent loop predictable. |
| D16 | Notebook files rejected via `NOTEBOOK_UNSUPPORTED`. | Str_replace on cell JSON corrupts notebooks in practice. A real NotebookEdit is a future package. |
| D17 | Write is one tool for both create and overwrite. Overwrite requires ledger + sha match. | Single-surface simplicity; clobber guard via ledger. |
| D18 | Atomic disk write: tmp + fsync + rename + parent dir fsync. | Standard Unix atomic-write pattern. Crash-safe. |
| D19 | Edit on empty file rejects with `EMPTY_FILE`. | Empty `old_string` is ambiguous; direct the model to Write. |
| D20 | `old == new` rejects with `NO_OP_EDIT`. | Usually a model mistake; explicit error prevents false success signal downstream. |

---

## 18. Stability

Breaking changes bump the spec major. Additions (new error codes, new metadata fields, new hook variants) are minor.

Public API for implementers: the `write()`, `edit()`, `multiEdit()` orchestrators plus `WriteOperations` and the permission hook signature. Everything else is internal.

---

## 19. References

OSS implementations studied in forming this spec:

- `anthropics/claude-code` — Tools reference for Write, Edit, MultiEdit, NotebookEdit. Canonical shape.
- `All-Hands-AI/OpenHands` — `str_replace_editor` as the reference autonomous-mode Anthropic text_editor port. Read-before-edit via exact match.
- `sst/opencode` — `packages/opencode/src/tool/edit.*` / `write.*` / `multiedit.*`. Read-before-edit + single permission gate across all four mutation tools.
- `modelcontextprotocol/servers` — `src/filesystem/lib.ts` `applyFileEdits`. Reference for sequential-in-memory apply, fail-fast-before-disk, atomic rename, unified-diff return.
- `SWE-agent/SWE-agent` — `tools/windowed_edit_linting/`. Lint-on-save gate pattern (our validate hook generalizes this).
- `Aider-AI/aider` — `editblock_coder.py`, `udiff_coder.py`. Fuzzy-match recovery and edit-format benchmarks.
- `openai/openai-agents-python` — `ApplyPatchTool` / `ApplyPatchEditor` protocol. Reviewed; V4A deferred per D1.
- `langchain-ai/deepagents` — `edit_file` string-replacement tool. Claude-Code-shape open-source port.

Not used as reference (explicit counter-examples): AutoGPT `WriteFile`, CrewAI `FileWriterTool`, LangChain `WriteFileTool` — all whole-file, no read-before-write, no atomicity. Documented in `agent-write-across-ecosystems.md` as the lower bound.
