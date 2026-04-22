# Read Tool — Cross-Language Design Spec

**Status**: Draft v1 — 2026-04-20
**Implementations**: TypeScript (`@agent-sh/harness-read`), Rust (pending)
**Scope**: Language-neutral contract. Implementation files (`packages/read/` for TS, `crates/read/` for Rust) must conform.

This spec is the source of truth. Implementation-specific ergonomics are allowed; public semantics are not.

---

## 1. Purpose

Expose file reading to an LLM as a structured tool. Enforce at the tool layer every invariant that cannot be trusted to the model:

- Path safety (absolute, workspace-bounded, symlink-resolved).
- Output size bounds (line count + byte count + per-line length).
- Binary detection and refusal.
- Deterministic line-numbered output so downstream Edit tools can anchor.
- File-not-found diagnostics that guide, not frustrate.

Non-goals: vector retrieval, semantic search, RAG. Those are separate tools.

---

## 2. Input contract

```text
{
  path:   string          // required
  offset: int ≥ 1         // optional, default 1
  limit:  int ≥ 1         // optional, default 2000
}
```

No other fields. Deliberate omissions:

- No `encoding` — always UTF-8 with lossy replacement.
- No `include_line_numbers` — always on.
- No `follow_symlinks` — always resolved to realpath.
- No `pages` — PDFs handled via attachment path; `offset`/`limit` apply to text only.

### Path normalization

1. If `path` is not absolute, resolve against the session `cwd`.
2. On Windows, normalize separators to forward slashes internally; preserve display form for errors.
3. Resolve symlinks (`realpath`). All later checks use the resolved path.
4. Reject if the resolved path escapes every configured workspace root (see §5).

### Parameter validation

- `offset < 1` → error with message `offset must be greater than or equal to 1`.
- `limit < 1` → error with message `limit must be greater than or equal to 1`.
- `offset > total_lines` when `total_lines > 0` → error: `Offset {offset} is out of range for this file ({total_lines} lines)`.

---

## 3. Output contract

Output is a discriminated union by `kind`:

### 3.1 `kind: "text"`

```text
<path>{absolute_path}</path>
<type>file</type>
<content>
{offset}: {line_content}
{offset+1}: {line_content}
...
</content>

{continuation_hint}
```

- Each line is prefixed with its 1-based line number, a colon, a single space, then the line content.
- No trailing newline inside `<content>`.
- Continuation hint is one of:
  - Full read: `(End of file · {N} lines total)`
  - Line-limit hit: `(Showing lines {offset}-{last} of {total} · {pct}% covered · {remaining} lines remaining. Next offset: {last+1}.)`
  - Byte-cap hit: `(Output capped at {LIMIT} KB. Showing lines {offset}-{last} of {total} · {pct}% covered · {remaining} lines remaining. Next offset: {last+1}.)`
- Empty file: `(File exists but is empty)` — **never return an empty result**; the model retries on empty.

Rationale: the hint reports **progress state** (covered, remaining), not an
imperative ("keep reading"). The model decides whether to paginate, switch to
grep, sample, or stop — the tool just makes the state legible so that
decision is informed. Early e2e runs showed a model petering out after two
windows without a progress signal; `% covered / remaining` let it reason
about distance to the end without being told what to do.

### 3.2 `kind: "directory"`

```text
<path>{absolute_path}</path>
<type>directory</type>
<entries>
{name_or_name_slash}
...
(Showing N of M entries · K remaining. Next offset: O.)
</entries>
```

- One entry per line, alphabetically sorted (case-insensitive locale).
- Subdirectories suffixed with `/`.
- Symlinks resolved: if target is a directory, suffix `/`.
- Respect `offset`/`limit` with the same pagination semantics as text.

### 3.3 `kind: "attachment"` (image / PDF)

```text
output:  "{Image|PDF} read successfully"
attachments: [{ mime, url: "data:{mime};base64,..." }]
```

- Images (MIME `image/*` except `image/svg+xml`) and `application/pdf` return raw bytes as a base64 data-URL attachment.
- No text body; the harness feeds the attachment into a multimodal content block.

### 3.4 `kind: "error"`

Errors are structured, not thrown. Every error carries a stable `code`:

| `code` | When |
|---|---|
| `NOT_FOUND` | Path does not exist. Include up to 3 fuzzy sibling suggestions. |
| `BINARY` | Binary detected; cannot read as text. |
| `TOO_LARGE` | Would exceed half the declared context window (see §7). |
| `OUTSIDE_WORKSPACE` | Resolved path is outside all configured roots and bypass is false. |
| `SENSITIVE` | Path matches a sensitive-pattern deny list. |
| `PERMISSION_DENIED` | User or policy denied the read. |
| `INVALID_PARAM` | Bad offset/limit. |
| `IO_ERROR` | Unexpected filesystem failure; preserve underlying message in `cause`. |

Error message format (model-readable):

```text
Error [{code}]: {human message}
```

For `NOT_FOUND` with suggestions:

```text
Error [NOT_FOUND]: File not found: {path}

Did you mean one of these?
{suggestion_1}
{suggestion_2}
{suggestion_3}
```

---

## 4. Size and shape bounds

All three caps apply together. Hit whichever first.

| Constant | Default | Override |
|---|---|---|
| `DEFAULT_LIMIT` (lines) | 2000 | per-call `limit` |
| `MAX_LINE_LENGTH` (chars per line) | 2000 | session config |
| `MAX_BYTES` (output payload) | 51200 (50 KB) | session config |
| `MAX_FILE_SIZE` (input gate) | 5 MB | session config |
| `CONTEXT_HALF_GUARD` | `floor(modelContextTokens / 2)` | session config |

### Per-line truncation

Lines longer than `MAX_LINE_LENGTH` are truncated to `MAX_LINE_LENGTH` chars and suffixed with `... (line truncated to 2000 chars)`. Counted as the truncated length for the byte cap.

### Byte cap

Accumulate UTF-8 byte length of each output line plus 1 (for `\n`). When adding the next line would exceed `MAX_BYTES`, stop and set `cut = true`, `more = true`.

### Streaming read

Use a streaming reader (`readline` / `BufReader::lines`) with CRLF support. Never load entire file into memory before line-slicing.

---

## 5. Workspace and permission model

### 5.1 Workspace roots

A session declares one or more workspace root directories. A resolved path is "in-workspace" iff it's equal to or under any root (after realpath).

### 5.2 Permission actions

Three actions per request: `allow` | `ask` | `deny`.

Default policy:

| Condition | Default |
|---|---|
| Path inside workspace, not sensitive | `allow` |
| Path outside workspace | `ask` (via hook; `OUTSIDE_WORKSPACE` if no hook) |
| Path matches sensitive list | `ask` (via hook; `SENSITIVE` if no hook) |

### 5.3 Sensitive patterns (default ask list)

Minimum set; extend per session:

```text
**/.env
**/.env.*
**/id_rsa
**/id_rsa.pub
**/id_ed25519
**/id_ed25519.pub
**/.ssh/**
**/.aws/credentials
**/.aws/config
**/*.pem
**/*.key
**/*.pfx
**/*.p12
**/credentials.json
**/service-account*.json
```

Match is case-insensitive, basename-or-path against the resolved absolute path.

### 5.4 Permission hook signature

```text
async ask(req: {
  tool: "read",
  path: string,
  action: "read",
  always_patterns: string[],   // patterns the user can allow-forever
  metadata: {},
}) → "allow" | "deny"
```

Hook is optional. If absent, default policy runs with no prompt (CI/autonomous mode).

---

## 6. Binary detection

Hybrid of extension and content sniff. File is binary iff either:

1. Extension is in the hard list: `.zip .tar .gz .exe .dll .so .class .jar .war .7z .doc .docx .xls .xlsx .ppt .pptx .odt .ods .odp .bin .dat .obj .o .a .lib .wasm .pyc .pyo`
2. Content sniff on first 4096 bytes:
   - Any NUL byte → binary.
   - Or > 30% of bytes are non-printable (byte < 9 or (byte > 13 && byte < 32)).

`image/*` (except svg) and `application/pdf` are **not** binary for this tool's purposes — they route to the attachment path before the binary check.

---

## 7. Half-of-context guard

Before reading, if the file's byte size multiplied by `tokensPerByte` (default 0.3) exceeds `floor(modelContextTokens / 2)`, return `TOO_LARGE` with a hint to use `offset`/`limit` or grep first.

This is conservative and language-agnostic; implementations may plug in tokenizer-aware estimation.

---

## 8. Ledger (optional)

When a ledger is provided on the session, every successful read appends:

```text
{
  path: string,              // resolved absolute path
  sha256: string,            // sha256 of file bytes at read time
  mtime_ms: int,             // file mtime in ms
  size_bytes: int,
  lines_returned: int,
  offset: int,
  limit: int,
  timestamp_ms: int,
}
```

The Edit tool reads the ledger and must refuse mutation if:

- No entry exists for the path, OR
- `sha256` on disk now differs from the ledger entry (stale read).

Ledger is per-session, in-memory. Persistence is out of scope for this spec.

---

## 9. Cache (optional)

When a cache is provided, reads check `{path, mtime, size}` for a hit. Cache invalidates on mtime change. Cache stores the computed output string; on hit, returns the same output without re-reading bytes (but still consults the ledger to re-append an entry).

Cache is an optimization, not a correctness feature. Disabling it must not change output.

---

## 10. Pluggable I/O backend

All filesystem operations route through an abstract interface so implementations can target remote FS (SSH, S3, WASM sandbox) without touching the core.

```text
interface ReadOperations {
  stat(path): { type: "file"|"directory"|"symlink", size, mtime_ms, readonly }
  readFile(path): bytes
  readDirectory(path): string[]                // names only
  readDirectoryEntries(path): { name, type }[]
  open(path): FileHandle  // streaming read
  realpath(path): string
  mimeType(path): string
}
```

Default implementation uses the host filesystem.

---

## 11. Determinism and idempotence

Two reads of the same unchanged file with the same `offset`/`limit` produce byte-identical output (excluding ledger timestamps). No clocks in the output. No randomness.

---

## 12. Concurrency

Reads of the same path by the same session are **serialized** per-path via a realpath-keyed mutex. Different paths are fully parallel. This matches pi-mono's `file-mutation-queue.ts`.

Rationale: prevents read-during-write torn content between concurrent Read and Edit invocations.

---

## 13. Tests (acceptance suite — both languages must pass equivalent)

See `agent-knowledge/design/read.tests.md` (to be written) for the full matrix. Minimum:

1. Absolute path required path → resolves correctly.
2. Relative path → resolved against cwd.
3. `~/` or `file://` — not supported at tool boundary; caller normalizes.
4. Workspace escape → `OUTSIDE_WORKSPACE` without bypass, `ask` with bypass flag off.
5. Symlink pointing outside workspace → blocked.
6. `.env` match → `SENSITIVE`.
7. 100k-line file, `offset=50000, limit=100` → exactly 100 lines, numbered 50000..50099.
8. Empty file → "(File exists but is empty)".
9. Binary random bytes → `BINARY`.
10. 20 MB text file → returns first `MAX_BYTES` worth with `cut=true, more=true`, correct continuation hint.
11. CRLF input → LF in output, byte counts correct.
12. Single 500 KB line → truncated to `MAX_LINE_LENGTH`, continuation hint references next line.
13. PDF under size → attachment, no text body.
14. Image → attachment, no text body.
15. Directory → list output with pagination.
16. Non-existent path with siblings → `NOT_FOUND` with suggestions.
17. Concurrent reads of same file → serialized, both succeed.
18. Cache hit with unchanged mtime → returns cached output, ledger still records.
19. Cache invalidation on mtime change.
20. Ledger entry sha256 matches actual file sha256 at time of read.

---

## 14. Stability

Breaking changes bump the spec major. Additions (new error codes, new metadata fields) are minor.

Public API for implementers is the `read()` orchestrator plus the `ReadOperations` interface. Everything else is internal.

---

## 15. References

OSS implementations studied in forming this spec:

- `sst/opencode` — `packages/opencode/src/tool/read.ts`. Primary inspiration for line+byte caps, binary sniff, continuation hints, fuzzy sibling suggestion.
- `badlogic/pi-mono` — `packages/coding-agent/src/core/tools/read.ts` + `file-mutation-queue.ts`. Primary inspiration for pluggable `ReadOperations` and realpath-keyed mutex.
- `Kilo-Org/kilocode` — `packages/opencode/src/tool/read.ts`. Opencode fork; confirmed the opencode pattern as canonical.
- `cline/cline` — `src/core/task/tools/handlers/ReadFileToolHandler.ts`. Inspiration for mtime-keyed cache and workspace resolution.
- `continuedev/continue` — `core/tools/definitions/readFile.ts` + `implementations/readFile.ts`. Inspiration for half-of-context guard and evaluated file-access policy.
- `can1357/oh-my-pi` — considered; hash-anchored chunks deferred to Edit tool.
- `RooCodeInc/Roo-Code` — considered; semantic-block extraction deferred as separate tool.
