# Glob Tool — Cross-Language Design Spec

**Status**: Draft v1 — 2026-04-20
**Implementations**: TypeScript (`@agent-sh/harness-glob`), Rust (pending)
**Scope**: Language-neutral contract. Implementation files (`packages/glob/` for TS, `crates/glob/` for Rust) must conform.

This spec is the source of truth. Implementation-specific ergonomics are allowed; public semantics are not.

Prior art surveyed: Claude Code `Glob`, opencode `glob` (`packages/opencode/src/tool/glob.ts`), Gemini CLI `glob` (`packages/core/src/tools/glob.ts`), Continue `FileGlobSearch`, MCP filesystem `search_files`, Codex CLI (no Glob tool; `rg --files -g` via shell). See `agent-knowledge/glob-impl-and-prompts-in-major-tools.md` for the cross-harness analysis that informed the decisions below.

---

## 1. Purpose

Expose filesystem pattern matching to an LLM as a structured tool. The model should be able to:

1. Ask "which files match this pattern?" cheaply — no file I/O on contents, just paths.
2. Get results sorted by "most-recently-edited first" so the top of the list is nearly always the intended anchor.
3. Narrow a wide pattern without re-scanning the tree (pagination).
4. Recover from a zero-match result with actionable next steps, not a dead-end.

Enforce at the tool layer every invariant that cannot be trusted to the model:

- Workspace-bounded search (same roots/sensitive logic as Read and Grep).
- Output size bounds so `**/*` does not wipe the context window.
- `.gitignore` / `.ignore` respect by default (model should not glob `node_modules`).
- A structured error surface that tells the model what went wrong and what to try next.
- Deterministic mtime-sorted results with path-ascending tiebreak so pagination is stable.

Non-goals: content search (that is the Grep tool), directory tree rendering, file reading, semantic/AST search, ranked repo-map.

---

## 2. Input contract

```text
{
  pattern:      string      // required, bash-style glob (picomatch)
  path?:        string      // optional, default: session cwd
  head_limit?:  int ≥ 1     // default 250
  offset?:      int ≥ 0     // default 0; skip first N entries
}
```

### Deliberate omissions

- **No `case_sensitive` flag.** Defaults to case-insensitive match for filename patterns — matches Claude Code and OpenCode. A session-level override exists for monorepos that rely on case (Linux-only projects with intentional `User.ts` vs `user.ts`); the model should not carry this complexity per call.
- **No `respect_git_ignore` / `respect_hidden` flag.** Gitignore respected, dotfiles excluded, by default. Same posture as Grep §6: per-call escape hatches are a foot-gun — a frustrated model flips them and floods the context. Session config may relax for exotic workspaces (e.g. searching inside `node_modules` on purpose).
- **No `recursive` boolean.** Recursion is a property of the pattern (`**/` is present or not); a `recursive` flag redundantly encodes what the pattern already says and creates two sources of truth.
- **No `exclude_patterns`.** Gitignore + the pattern itself cover every legitimate use. Models that want negation should use a leading `!`-segment pattern (handled by rg `--glob`).
- **No `max_depth`.** Globstar already bounds depth via the pattern; a depth flag invites confusion with `**`.
- **No `follow_symlinks`.** Never follow. Symlink loops are a denial-of-service vector. rg's default (don't follow) matches.
- **No `sort` knob.** Always mtime DESC, path ASC tiebreak. See §4.

### Parameter validation

- `pattern` empty → `INVALID_PARAM`: "pattern is required".
- `pattern` is a regex-style string (contains `\\`, `\\d`, `[^...]`, etc.) but not a glob → still runs; rg will treat most as literals. We do not reject — some models write glob-ish shapes that happen to work.
- `head_limit < 1` or `offset < 0` → `INVALID_PARAM`.
- `path` not absolute → resolve against `cwd`. Same normalization rules as Read and Grep.
- Unknown key → `INVALID_PARAM` via `strictObject`. See §2.1 for known-alias pushback.

### 2.1 Known-alias pushback

Models routinely pass alternate names for common parameters. Instead of the generic "Unknown key: X" we emit a targeted INVALID_PARAM with a redirect. Mirrors `@agent-sh/harness-grep`'s §2.1.

Required aliases for Glob (minimum set):

- `glob`, `glob_pattern`, `pattern_glob` → `pattern`
- `regex`, `query` → `pattern` (with note: "Glob uses glob syntax, not regex.")
- `dir`, `directory`, `cwd`, `dir_path` → `path`
- `limit`, `max_results`, `max_count` → `head_limit`
- `skip` → `offset`
- `recursive` → drop (use `**/`)
- `case_sensitive`, `ignore_case`, `insensitive` → drop (pattern-level only; session config)
- `include_hidden`, `hidden`, `no_ignore` → drop (session config)

### 2.2 Absolute-path-in-pattern auto-split

Gemma-family models observed (gemma4:26b, gemma4:e2b) pass the absolute search root INSIDE `pattern` instead of via `path:`:

```json
{ "pattern": "/tmp/project/**/*.tsx" }              // what the model sends
{ "pattern": "**/*.tsx", "path": "/tmp/project" }   // what the tool needs
```

Since our matcher evaluates against paths *relative to the search root*, the absolute-prefixed pattern never matches anything. Without a fix, the model thrashes — observed 6-7 calls in G7/G8 traces, blowing the turn budget and hitting workspace-fence errors as it "broadens" upward.

The tool silently auto-splits: find the first path segment containing a wildcard; move everything before it into `path:`, keep the rest as `pattern`. **Guarded** — if the caller already provided an explicit `path:` we do NOT rewrite (trust the call). This is the "never trust the model exact call; add parsing when the shape is brittle" rule.

Not applied when:
- `path:` was explicit (trust the caller).
- Pattern has no wildcards (treat as literal; tool will report what happens).
- Pattern starts with a wildcard despite the leading `/` (unusual shape, left alone).

Validation at `packages/glob/test/glob.test.ts` — "absolute-path pattern auto-split" suite.

### Pattern guidance (lives in the tool description, not the schema)

Tool description must call out:

> Bash-style glob syntax: `*` matches within a single path segment (does not cross `/`), `**` matches any number of segments, `?` matches one character, `{a,b,c}` is brace expansion. Case-insensitive by default. To match recursively across subdirectories, include `**/`. Example: `**/*.ts` finds every TypeScript file in the tree; `src/**/*.{ts,tsx}` restricts to `src/`. A bare `*.ts` matches only top-level files — it is NOT recursive. A bare name like `UserService.ts` matches only the exact top-level file; use `**/UserService.ts` to find it at any depth.

Research backing: `agent-knowledge/glob-impl-and-prompts-in-major-tools.md` §Concept 5 documents the "forgotten `**`" as the most common model mistake. Showing `**/*.ts` in the example reduces it ~10× versus prose alone. We deliberately do NOT use picomatch's `basename: true` heuristic (which would make `*.ts` DWIM-match at any depth): forcing the model through the zero-match-hint → `**/` upgrade loop is the chosen guardrail.

---

## 3. Output contract

Output is a discriminated union by `kind`.

### 3.1 `kind: "paths"` (success)

```text
<pattern>{pattern}</pattern>
<paths>
{path_1}
{path_2}
...
</paths>

{continuation_hint}
```

- Paths sorted by mtime DESC, path ASC tiebreak.
- One path per line, absolute.
- Empty result: `(No files matched {pattern}. Try: add '**/' for recursive search; broaden the pattern; try a different path.)` — never return an empty body. See §3.3 for the full zero-match hint construction.
- Continuation hint:
  - Full: `(Found {N} file(s) matching the pattern.)`
  - Capped: `(Showing files {offset+1}-{offset+returned} of {total}. Next offset: {offset+returned}.)`

### 3.2 `kind: "error"`

Structured, not thrown.

| `code` | When |
|---|---|
| `INVALID_PARAM` | Bad schema (empty pattern, bad head_limit, unknown key, known-alias pushback). |
| `NOT_FOUND` | `path` does not exist. Include up to 3 fuzzy sibling suggestions. Mirrors Read and Grep. |
| `OUTSIDE_WORKSPACE` | Resolved `path` is outside all configured roots, no hook, bypass off. |
| `SENSITIVE` | `path` matches a sensitive-pattern deny list, no hook. |
| `PERMISSION_DENIED` | Hook denied the glob. |
| `TIMEOUT` | Scan exceeded the session deadline. |
| `IO_ERROR` | Unexpected filesystem / backend failure; preserve `cause`. |

Error message format (consumed by `formatToolError` at the executor boundary):

```text
Error [{code}]: {human message}
```

`INVALID_PARAM` with alias pushback example:

```text
Error [INVALID_PARAM]: unknown parameter 'regex'. Glob uses glob syntax, not regex — use 'pattern' with syntax like '**/*.ts'.
```

`NOT_FOUND` with sibling suggestions:

```text
Error [NOT_FOUND]: Path does not exist: /repo/src/componets

Did you mean one of these?
/repo/src/components
/repo/src/component-utils.ts
```

### 3.3 Zero-match hint construction

The empty-result hint is context-aware. We never emit a bare `(No files matched)`.

Inputs: the resolved pattern, the `path` (if explicit), and whether the pattern contains a recursive marker.

Hint segments, in order:

1. Pattern echo: `No files matched {pattern}.`
2. If pattern does NOT contain `**`: suggest `add '**/' before the pattern to search recursively, e.g. '**/{pattern}'`.
3. `broaden the pattern (e.g. replace .ts with .{ts,tsx,js})`.
4. If `path` was explicit: `try a different path, or omit path to search the workspace root`.

Rationale: the single most observed model failure on Glob tools is writing `*.ts` expecting recursion. The hint rewrites that for the model in one turn.

---

## 4. Size and shape bounds

All caps apply together. Hit whichever first.

| Constant | Default | Override |
|---|---|---|
| `DEFAULT_HEAD_LIMIT` | 250 | per-call `head_limit` |
| `GLOB_MAX_BYTES` (output payload) | 51200 (50 KB) | session config |
| `GLOB_MAX_PATHS_SCANNED` (internal scan cap) | 50000 | session config |
| `DEFAULT_TIMEOUT_MS` | 30000 | session config |

Rationale for 250 and 50 KB: matches Grep's `DEFAULT_HEAD_LIMIT` and Read's `MAX_BYTES`. Holding caps constant across tools means a model that has learned "this tool costs roughly X tokens" transfers the intuition. Research convergence is at 100; we pick 250 because we offer pagination — 100 leaves too many legitimate patterns needing 3+ calls.

### Byte cap

Accumulate UTF-8 byte length of each path plus 1 (for `\n`). When adding the next path would exceed `GLOB_MAX_BYTES`, stop; set `more = true`, report `Next offset`.

### Internal scan cap (`GLOB_MAX_PATHS_SCANNED`)

If ripgrep enumerates more than 50,000 paths before reaching head_limit, abort and return an error `GLOB_EXECUTION_ERROR` (an `IO_ERROR` subtype) with "Pattern matched too many files; narrow the pattern." This is defence against `**/*` on a 10M-file monorepo.

### Entry cap (`head_limit`)

Unit is files. Entries skipped by `offset` are not re-counted.

---

## 5. Glob engine

Two-stage pipeline:

1. **Enumeration** — ripgrep `--files` (no pattern filter) lists every file in the search root that respects `.gitignore` / `.ignore` / `.rgignore` / hidden-file rules.
2. **Pattern match** — in-process using `picomatch` with bash-glob semantics against paths relative to the search root.

For the TypeScript implementation, stage (1) uses `pi0/ripgrep` (WASM, same dep as `@agent-sh/harness-grep`); stage (2) uses `picomatch` (~50 KB, no transitive deps, battle-tested — dep of fast-glob/micromatch).

### Why two stages instead of rg's built-in `-g`

A probe confirmed rg's `-g` behavior surprises: when `--files --glob=PATTERN` is passed with a *whitelist* pattern (doesn't start with `!`), rg treats the pattern as an explicit inclusion and **ignores `.gitignore`**. A `--glob=*.ts` call returns `ignored.ts` even when `.gitignore` has `ignored.ts`. The documented-but-surprising behavior trips users and makes the tool leak secrets through what looks like a normal filter.

The two-stage design keeps rg's enumeration posture intact (correct gitignore/hidden/binary semantics) and lets picomatch handle the pattern syntax the model actually knows from bash.

### Why picomatch for stage 2

- **Bash-glob semantics** — matches what most models learn first, not rg's gitignore-style dialect.
- **~50 KB, zero transitive deps**, already a dep of fast-glob + micromatch so our tree has it either way.
- **Safe-by-default regex compiler** — no known ReDoS on reasonable patterns.
- **Case-insensitive default and no-dotfile default** — both line up with our design.

Trade-off: we inherit picomatch's edge cases (empty braces `{}`, some extglob operators). Acceptable — the description advertises the common forms; rare forms fall back to zero-match-hint recovery.

### Engine invocation

```text
rg --files \
  --no-config \
  --no-messages \
  --no-require-git \
  --glob=!.git/* \
  --max-filesize=5M \
  {root}
```

Notes:

- `--files` lists every file rg would consider, respecting `.gitignore` and hidden-file rules.
- **No `--glob=PATTERN` whitelist here.** That would turn off gitignore. See the "two stages" note above.
- `--glob=!.git/*` is a negative exclusion (allowed; does not disable gitignore). Defence in depth — `.git/` is already excluded by rg's hardcoded default, so this is belt-and-braces.
- `--no-require-git` is **mandatory**: without it, a fresh non-git directory's `.gitignore` is ignored.
- No `--hidden`, no `--follow` (see §2 omissions).

### Pattern match (stage 2)

```text
const matches = picomatch(pattern, {
  nocase: true,    // case-insensitive default (G-D9)
  dot: false,      // dotfiles excluded (ignored at stage 1 anyway;
                   //   here we additionally require dot to be matched
                   //   explicitly in the pattern if the model unsets dot-exclusion)
  // basename: false — deliberately NOT enabled. Forces '*.ts' to match
  //   only top-level, not any-depth. Zero-match hint steers to '**/*.ts'.
});
// Match each enumerated abs-path against its relative-to-root form.
```

### Process model

- Stream stdout line-by-line.
- Per-call timeout (`DEFAULT_TIMEOUT_MS`). On timeout, abort the WASI call; return `TIMEOUT` with the partial count.
- Count scanned paths; stop at `GLOB_MAX_PATHS_SCANNED` and return `IO_ERROR` with "too many files" message.

### Pluggable backend

All engine calls route through an abstract interface so a future Rust implementation, SSH-remote backend, or cloud-indexed backend can substitute:

```text
interface GlobEngine {
  // Enumerate all paths under root that pass ignore/hidden filtering.
  // The orchestrator filters by pattern afterwards. Engines do NOT
  // see the pattern — keeps the abstraction small and the test matrix
  // obvious (swap the engine, re-use the matcher).
  list(input: {
    root: string,
    maxFilesize: int,
    signal?: AbortSignal,
  }): AsyncIterable<{ path: string }>
}
```

The default implementation wraps pi0/ripgrep. Implementations are free to cache, batch, or precompute indexes — as long as the enumeration is ignore-respecting and the output contract in §3 is preserved.

---

## 6. Workspace, permissions, and `.gitignore`

Reuses the same fence used by Read and Grep.

### 6.1 Workspace roots

Same as Grep §6.1. Scan is scoped to the resolved `path`. If `path` is outside all roots and no hook is configured, return `OUTSIDE_WORKSPACE`.

### 6.2 Sensitive paths

Same sensitive-pattern deny list as Read §5.3 and Grep §6.2. If the search root itself matches a sensitive pattern (e.g. globbing under `~/.ssh`), return `SENSITIVE` without a hook, or ask via hook.

**Not filtered:** individual file matches under a non-sensitive root. If the model globs `.` and a `.env` file appears, its path is included. The path itself is not the secret — reading the file's contents would be, and Read has its own sensitive-path guard.

### 6.3 Permission hook

Same signature as Grep §6.3 with `tool: "glob"`, `action: "read"`. Hook receives the resolved search root, not each matched path.

### 6.4 `.gitignore` / `.ignore` / `.rgignore`

Respected by default via ripgrep. Hidden files (`.*`) are skipped by default (we never pass `--hidden`). No per-call escape hatch — see §2 omissions.

---

## 7. Sort order and determinism

Paths sorted by **mtime descending, path ascending as tiebreaker**. This is the load-bearing return-shape decision: research shows the top 5 of an mtime-sorted result almost always contain the file the task is about.

Implementation:

- After rg emits paths, `stat` each and sort. Sort happens server-side inside the Glob tool, not in rg.
- Paths that fail to `stat` (race condition between rg and stat) keep relative order and sort last.
- Identical mtime (common on fresh clones) tiebroken by path ascending — deterministic.

Two globs of the same tree with the same args produce byte-identical output. No clocks (mtime is filesystem state, not wallclock at call time), no randomness.

---

## 8. Timeouts and abort

- Default per-call timeout 30s. Overridable via session config.
- Must respect a session-provided `AbortSignal` (TS) / `CancellationToken` (Rust).
- On timeout, return `TIMEOUT` with `partial_count` in the error metadata so the model can decide whether to re-run with a narrower scope.

---

## 9. Pagination semantics

`offset` and `head_limit` together give `tail -n +N | head -N` semantics, identical to Read's and Grep's offset/limit. This is a deliberate cross-tool invariant.

- First page: `offset = 0, head_limit = 250` (default).
- Next page: `offset = previous_offset + returned_count`.
- `offset >= total` returns an empty page with a hint, not an error. Mirrors Grep §8.

### Stability

For pagination to be useful, the result set must be stable between calls on an unchanged tree:

- Files sorted by mtime descending, path ascending tiebreak.
- If a file's mtime changes between pages, pagination may skip or repeat. Acceptable; the model can notice duplicates and re-query.

---

## 10. Ledger integration

Glob does not participate in the read ledger. Listing a path is not a read of its contents.

---

## 11. Determinism, idempotence, concurrency

- Two globs with the same args on an unchanged tree produce byte-identical output.
- Multiple concurrent globs in the same session are allowed and independent. Glob does not take the per-path mutex.

---

## 12. Relationship to Grep and Read

- **Glob → Read:** the canonical "find file + open it" flow. Glob returns paths; model picks one; Read opens it.
- **Glob → Grep:** narrow by filename first (cheap), then content-search only the narrowed set. When the pattern is clearly content-shaped ("find references to `handleAuth`"), the model should skip Glob and Grep directly.
- **Don't use Glob as a directory listing:** a dedicated `ls`/`list_dir` is out of scope for v1. Model should use `pattern: "*"` with an explicit `path` if it truly wants a single-level listing (accepts the performance cost).

The description must explicitly nudge:

> Prefer this tool over `find` / `ls -R` for file discovery. If you need to search file **contents**, use Grep instead.

---

## 13. Tests (acceptance matrix — both languages must pass equivalents)

Full test catalogue lives alongside the TS implementation at `packages/glob/test/`.

### 13.1 Unit (code correctness)

1. Empty pattern → `INVALID_PARAM`.
2. `head_limit < 1` → `INVALID_PARAM`.
3. `offset < 0` → `INVALID_PARAM`.
4. Unknown key (`regex`, `dir`, `limit`, etc.) → `INVALID_PARAM` with alias redirect.
5. `path` does not exist → `NOT_FOUND` with up to 3 fuzzy sibling suggestions.
6. `path` outside workspace, no hook → `OUTSIDE_WORKSPACE`.
7. `path` matches sensitive pattern, no hook → `SENSITIVE`.
8. `.gitignore` excludes a file → not in results (with and without `.git` dir).
9. Hidden file (`.secret`) → not in results.
10. `node_modules/` → not in results.
11. `**/*.ts` on a 600-file tree → paginates at head_limit=250 with Next offset hint.
12. `offset >= total` → empty `paths`, hint, not an error.
13. Two files with same mtime → tiebroken by path ascending (deterministic output).
14. Pattern matches nothing → `(No files matched <pattern>. Try: add '**/' ... broaden ...)` hint.
15. Zero-match hint with recursive pattern already present → omits the `**/` suggestion.
16. Pattern with brace expansion `*.{ts,tsx}` → correctly matches both extensions.
17. Timeout → `TIMEOUT` with partial count.
18. `path` is a file, not a directory → `NOT_FOUND` or `INVALID_PARAM` (implementation chooses; test asserts one of the two).
19. `GLOB_MAX_PATHS_SCANNED` exceeded → `IO_ERROR` with "too many files" message.
20. mtime sort is stable across two invocations on an unchanged tree.

### 13.2 LLM e2e (model-contract validation)

E2E suites live in `packages/harness-e2e/test/glob.e2e*.ts` and exercise real models. Minimum categories:

- **G1 golden**: "Find the file containing the `UserService` class." Model runs `glob **/UserService*.ts` or similar, picks the single hit. Expect: ≤ 2 calls, answer matches the file path.
- **G2 refine**: tree has 600 `.ts` files. Model runs `**/*.ts`, sees truncation hint, narrows. Expect: first call truncated, second call scoped.
- **G3 forgot-**: user asks "find all TypeScript files"; model first writes `*.ts`, gets 0-or-few matches with recursive suggestion, re-runs `**/*.ts`. Expect: recovers within 2 calls.
- **G4 bash-decoy**: shell is available. Model prefers `glob` over `find . -name '*.ts'`. Expect: shell tool not invoked for filename search.
- **G5 gitignore respect**: tree has matches in `node_modules/` and source. Expect: only source hits returned; model does not manually filter or disable gitignore.
- **G6 comma-list gotcha**: user asks for "all TypeScript/JavaScript files". Strong model writes `**/*.{ts,tsx,js}`; weak model may write `**/*.ts,*.js`. Expect: either works or the alias hint kicks in.
- **G7 pagination**: scripted fixture with 600 matches. Expect: at most three Glob calls to cover the result set using offset hints, or a narrowing strategy.
- **G8 cross-tool handoff (deferred to cross-tool integration suite, next session)**: Glob → Read.

Multi-model coverage follows the matrix policy in `memory/project_matrix_policy.md`: default matrix is 2× Gemma 4 + 2× Qwen local; Bedrock reserved for per-new-tool and release gates.

---

## 14. Stability

Breaking changes bump the spec major. Additions (new error codes, new output fields) are minor. Error `code` values are a public contract and cannot be renamed without a major bump.

---

## 15. Open questions (deferred)

- **Per-call `include_hidden` escape hatch.** Currently session-config only. Revisit if we see real evidence models need dotfile globbing mid-session.
- **Content-addressed cache for repeated globs.** Two globs of the same tree with the same pattern could share work. Deferred until we measure the cost on real agent sessions.
- **Glob + content-grep fusion tool.** Could ship a single `find_files_with_text` that combines Glob + Grep in one call. Research (`glob-impl-and-prompts-in-major-tools.md`) shows Cline does this and the model measurably confuses regex-vs-glob syntax — rejected for v1.
- **Directory listing primitive.** MCP filesystem ships `list_directory` and `directory_tree` as separate tools. Out of scope for v1; model can use `pattern: "*"` with explicit `path` as a workaround.
- **Empty-pattern → default listing.** Rejected: requires special-case logic and obscures the "no files matched" feedback loop.

---

## 16. References

OSS implementations studied in forming this spec:

- `sst/opencode` — `packages/opencode/src/tool/glob.ts` + `packages/opencode/src/tool/glob.txt`. Primary inspiration for the "DO NOT enter 'undefined' or 'null'" path-parameter description and the 100-entry cap pattern.
- `anthropics` Claude Code — `Glob` tool description and parameter surface. Primary inspiration for the minimal schema (pattern + path) and the "use the Agent tool instead" redirect for open-ended exploration.
- `google-gemini/gemini-cli` — `packages/core/src/tools/glob.ts`. Primary inspiration for the structured error catalog (`PATH_NOT_IN_WORKSPACE`, `GLOB_EXECUTION_ERROR`) and the pattern-echo in no-match messages.
- `continuedev/continue` — `core/tools/definitions/globSearch.ts`. Inspiration for the inline truncation warning in the description ("use targeted patterns").
- `modelcontextprotocol/servers` `filesystem/search_files`. Evaluated; minimatch-based, `excludePatterns` via arrays — rejected as too ceremonial vs. gitignore inheritance.
- `openai/codex` — `codex-rs/core/src/tools/handlers/list_dir.rs` + `gpt_5_codex_prompt.md`. The "no Glob tool, route through shell" design. Counter-data-point; we ship Glob because we target many models.
- `BurntSushi/ripgrep` user guide — `--files`, `-g`, gitignore override. Engine invocation in §5 is derived from this.
- `agent-knowledge/glob-impl-and-prompts-in-major-tools.md` — cross-harness research that frames the "ship separate from Grep" decision and the "forgotten `**`" gotcha.

---

## Addendum: decision log

- **G-D1** (Engine): two-stage pipeline — pi0/ripgrep `--files` for ignore-respecting enumeration + picomatch for bash-glob pattern matching. Trade-off accepted: +1 small dep (`picomatch`). Revised from v0 which used `rg --files -g PATTERN` — a probe showed `-g <whitelist>` disables `.gitignore`, so the built-in filter leaks ignored files. Two-stage keeps the correct defaults and gives us bash-glob semantics (what models learn first) instead of gitignore dialect.
- **G-D2** (Schema): minimal — `pattern`, `path`, `head_limit`, `offset`. No per-call `case_sensitive` or `respect_git_ignore`. Trade-off accepted: less flexibility than Gemini CLI. Chosen because per-call flags are measured foot-guns on weak models; session config covers the legitimate override cases.
- **G-D3** (Output): discriminated union (`kind: "paths" | "error"`), same shape as Grep. Trade-off accepted: more schema surface than a raw path-list string. Chosen for cross-tool parse-pattern consistency (Read, Grep, Glob all discriminated unions).
- **G-D4** (Head_limit default): 250. Matches Grep and Read. Trade-off accepted: ~2.5× the research convergence (100). Chosen because we offer pagination and a bigger default reduces multi-turn loops on legitimately large result sets.
- **G-D5** (Paths): absolute in output. Matches Claude Code + Gemini CLI + our Grep. Trade-off accepted: more tokens per path than relative. Chosen to eliminate cwd-drift confusion across multi-worktree sessions.
- **G-D6** (Sort): mtime DESC, path ASC tiebreak. Matches Claude Code + OpenCode + Gemini CLI. Non-negotiable: the single highest-leverage return-shape decision per research.
- **G-D7** (Zero-match hint): echo pattern + suggest `**/` + suggest broadening. Mirrors Grep's zero-match hint shipped in this session. Trade-off accepted: slightly more verbose than Claude Code's "(No files matched)". Chosen because the forgotten-`**` failure mode is measurable and the hint corrects in one turn.
- **G-D8** (Alias pushback): reject `regex`, `dir`, `cwd`, `limit`, etc. with a targeted redirect. Mirrors Grep's `KNOWN_PARAM_ALIASES` table. Rationale: content-vs-context typo on Grep showed the pattern generalizes.
- **G-D8b** (Absolute-path auto-split): when `pattern` starts with an absolute path prefix and no `path:` was given, silently split. Added after round-3 baseline data showed gemma:26b thrashing on G7/G8 with absolute-prefixed patterns while opencode's harness recovers via `bash`. Rationale: we never trust the model's exact call; parsing around known-brittle shapes is cheap and lets the weak models land on the happy path. See §2.2.
- **G-D9** (No `case_sensitive` / `respect_git_ignore` params): consistent with Grep §6. Escape hatches for this class of posture belong at session config, not per-call.
- **G-D10** (Ledger): Glob does not touch the read ledger. Listing a path is not a read.
