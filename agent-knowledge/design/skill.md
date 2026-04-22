# Skill Tool — Cross-Language Design Spec

**Status**: Draft v1 — 2026-04-22
**Implementations**: TypeScript (`@agent-sh/harness-skill`, pending), Rust (`crates/skill`, pending)
**Scope**: Language-neutral contract. Implementation files (`packages/skill/` for TS, `crates/skill/` for Rust) must conform.

This spec is the source of truth. Implementation-specific ergonomics are allowed; public semantics are not.

Prior art surveyed: Agent Skills open spec (`agentskills.io`), Claude Code `Skill` tool, OpenCode `skill.ts`, Gemini CLI `activate-skill`, Continue `readSkill`, Codex CLI `core-skills`, Anthropic API skill execution, and 35+ adopter harnesses. Research summary in `agent-knowledge/skill-tool-design-across-harnesses.md` and `agent-knowledge/skill-tool-in-autonomous-agents.md`.

---

## 1. Purpose

Expose **authored skills** to an LLM as a structured tool. A skill is a folder — `skill-name/SKILL.md` with YAML frontmatter plus optional `scripts/`, `references/`, `assets/` — that encodes specialized workflows, project conventions, or compressed expertise. The tool's job is to:

1. Enumerate installed skills as a low-cost catalog (≤100 tokens per skill, always available).
2. Expand a skill's full body into the conversation on demand, exactly once per activation.
3. Enforce that skills are authored files, not runtime-generated prompts — you can commit them, diff them, review them.
4. Interoperate with the rest of the tool surface: `allowed-tools`, scripts invoked via `bash`, references opened via `read`.

Scope note: **v1 ships the authored-skill pattern only.** Runtime-learned skills (Voyager / Letta-style) are out of scope — they belong in a separate `@agent-sh/harness-skill-learner` adapter package if demand appears.

Enforce at the tool layer every invariant the model cannot be trusted on:

- **Name matches directory.** `name: foo` inside `skills/bar/SKILL.md` is rejected.
- **Frontmatter validates.** Malformed YAML → structured error, not silently dropped.
- **Discovery paths are bounded.** Only session-configured roots are scanned; no walking up to `/`.
- **Activation is permission-gated.** Every activation passes through the permission hook, carrying the skill's `allowed-tools` declaration as metadata.
- **Trust gating for autonomous mode.** Project-root skills from untrusted repos require hook approval or explicit opt-in; `unsafeAllowSkillWithoutHook` for fixtures.
- **Dedupe.** Re-activating the same skill in the same session is a no-op (returns a "already loaded" marker), not a context-bloat replay.
- **Compaction-safe body wrapping.** Skill bodies return wrapped in a stable structural marker so auto-compaction preserves them correctly.

Non-goals for v1:

- **Subagent-forked skills** (Claude Code's `context: fork` + `agent: <type>`). Requires our own subagent primitive, which we don't ship.
- **Dynamic shell injection** in skill bodies (Claude Code's `` !`<cmd>` `` backtick blocks). Security surface; needs careful design.
- **File-path gating for auto-activation** (`paths: ["**/*.py"]`). Requires file-context awareness we don't have.
- **Model/effort overrides** (`model: opus`, `effort: high`). These are harness concerns, not tool concerns.
- **Per-skill hooks** (skill-scoped `PreToolUse` / `PostToolUse`). Needs design round.
- **Live filesystem watching** for in-session skill changes. Nice-to-have; not load-bearing.

---

## 2. Input contract

```text
{
  name:        string                        // required, matches an installed skill
  arguments?:  string | Record<string,str>   // optional, positional or named
}
```

Deliberate omissions:

- **No `path`.** The tool dispatches on `name`, not on a filesystem path. The harness owns discovery; the model chooses by name.
- **No `scope`.** Skills are session-scoped once loaded; there's no per-turn / per-tool-call scope.
- **No `reload: true`.** Session-lifetime contract is simpler; if the skill author edits mid-session, they invalidate by re-running.
- **No free-form `input` map.** `arguments` is the Claude Code `$ARGUMENTS` / `$N` / `$name` conventions; if a skill declares named `arguments` in its frontmatter, the tool validates against that declaration.

### Parameter validation

- `name` not a string, empty, or > 64 chars → `INVALID_PARAM`.
- `name` does not match `/^[a-z0-9]+(-[a-z0-9]+)*$/` → `INVALID_PARAM`: "skill name must be lowercase-kebab-case".
- `name` not in the session's installed-skill catalog → `NOT_FOUND`, with `siblings` listing fuzzy-matched installed names.
- `arguments` is a string AND the skill declares named `arguments` in its frontmatter → `INVALID_PARAM`: "skill `{name}` expects named arguments: {list}".
- `arguments` is a map AND the skill declares no `arguments` frontmatter → `INVALID_PARAM`: "skill `{name}` does not accept named arguments".

### 2.1 Known-alias pushback

Mirrors the pattern from bash / webfetch / grep / glob. Required alias set:

- `skill`, `skill_name`, `name_of_skill`, `slug` → `name`
- `invoke`, `activate`, `run` → drop; the tool activates implicitly
- `args`, `args_string`, `input`, `params`, `parameters` → `arguments`
- `context`, `session` → drop with note "skill context is session-scoped; no per-call override"
- `reload`, `fresh`, `force_reload`, `refresh` → drop with note "skills load once per session; edit the skill file and restart the session to refresh"
- `fork`, `subagent`, `isolated` → drop with v1.1 note "subagent-forked skills deferred to v1.1"
- `paths`, `scope_paths` → drop with v1.1 note
- `model`, `effort` → drop with v1.1 note "model / effort overrides are harness concerns, not tool parameters"
- `file`, `file_path`, `skill_path`, `dir` → drop with note "skills dispatch by name, not path; the harness owns discovery"

### 2.2 Description guidance (model-facing)

Tool description must call out:

> Activate an installed skill by name. A skill is a reusable package of instructions, optional scripts, and reference docs, authored as a folder at `skill-name/SKILL.md`. Activating loads the skill's body into the conversation for the rest of the session.
>
> **When to use.** Activate a skill when the user's request matches its description. The catalog of installed skills, each with name and short description, is always visible in your tool-call context. If two skills plausibly apply, pick the one whose description most precisely matches.
>
> **Idempotence.** Activating the same skill twice in one session is a no-op — the body is already loaded. The tool returns a `already_loaded` marker so you know the content is still in context.
>
> **Arguments.** Pass `arguments` as a string for positional skills (those declaring `$ARGUMENTS` or `$1` / `$2`) or as a JSON object for skills that declare named arguments in frontmatter. Run without arguments if the skill doesn't need them.
>
> **Permission.** Activation runs through the session's permission hook. A skill's `allowed-tools` frontmatter is an advisory declaration of what tools it expects to need — it does not pre-approve anything; downstream tool calls still pass the session's permission hook.

Research backing: Anthropic's Oct 2025 Agent Skills announcement emphasizes progressive disclosure ("load on demand, not always"); Simon Willison documents that skill metadata costs 50-100 tokens vs MCP's 10,000+ for identical capability exposure.

---

## 3. Output contract

Output is a discriminated union by `kind`.

### 3.1 `kind: "ok"` — skill activated, body loaded

```text
<skill name="{name}" dir="{skill_dir}">
<frontmatter>
{the parsed frontmatter, re-serialized minus body}
</frontmatter>
<instructions>
{the SKILL.md body — everything after the closing ---}
</instructions>
<resources>
{optional; up to 10 sampled file names from scripts/ references/ assets/ — names only, not contents}
</resources>
</skill>
(Skill "{name}" activated. Body is {N} bytes. Scripts available via bash(<skill-dir>/scripts/<name>). References via read(<skill-dir>/references/<name>).)
```

The `<skill>` XML wrapper is load-bearing for auto-compaction: harnesses that summarize history can recognize the marker and preserve the full body verbatim (matching Claude Code's 5000-per-skill / 25000-total compaction carryforward policy).

Structured result shape (what TS/Rust return):

```text
{
  kind: "ok",
  name: string,
  dir: string,                    // absolute path to the skill directory
  body: string,                   // the markdown body, frontmatter-stripped
  frontmatter: Record<string,unknown>,  // parsed YAML
  resources: string[],            // up to 10 filenames from scripts/ references/ assets/
  bytes: number,
  output: string                  // the rendered <skill>…</skill> block above
}
```

### 3.2 `kind: "already_loaded"` — skill is in-context from a prior call

```text
(Skill "{name}" is already active in this session. Body was loaded at turn {turn}. No new content was added.)
```

Structured: `{ kind: "already_loaded", name, at_turn }`.

This is idempotence. The model may call `skill` with the same name twice without burning context; the second call is a short no-op hint.

### 3.3 `kind: "not_found"`

```text
(No skill matches "{name}". Did you mean: {siblings}? Run with a listed name from the catalog.)
```

Structured: `{ kind: "not_found", name, siblings: string[] }`.

Siblings are Levenshtein-ranked installed skill names (top 3, similarity threshold 0.6). Mirrors `read`'s NOT_FOUND fuzzy behavior.

### 3.4 `kind: "error"`

Structured errors, not thrown. Format: `Error [CODE]: message`.

| `code` | When |
|---|---|
| `INVALID_PARAM` | Schema error, alias pushback, bad argument shape. |
| `NOT_FOUND` | Skill name does not exist in any configured skill root. |
| `SENSITIVE` | Skill dir matches sensitive-patterns (e.g. `**/.env/**`) and no hook approved. |
| `OUTSIDE_WORKSPACE` | Skill dir resolved outside all configured workspace roots with no hook approval. |
| `INVALID_FRONTMATTER` | YAML parse error, missing required fields, or constraints violated. |
| `NAME_MISMATCH` | `name: foo` inside `skills/bar/SKILL.md`. Rejected with the path + declared name. |
| `DISABLED` | Skill has `disable-model-invocation: true` and the activation came from the model, not the user. |
| `NOT_TRUSTED` | Project-root skill from an untrusted dir; session required hook approval; hook denied or returned ask. |
| `PERMISSION_DENIED` | Hook explicitly denied activation. |
| `IO_ERROR` | Filesystem read of SKILL.md or resource enumeration failed. |

Error messages echo the requested `name`:

```text
Error [INVALID_FRONTMATTER]: skill "my-skill" has malformed YAML frontmatter.
Path: /workspace/.skills/my-skill/SKILL.md
Reason: expected colon after 'description' on line 4
Hint: frontmatter must be valid YAML between two `---` lines at the top of the file. See agentskills.io/specification.
```

---

## 4. Frontmatter schema

The frontmatter contract is this spec's primary surface. Parity with the agentskills.io open standard plus a minimal set of extensions widely adopted in Claude Code and in the project author's own 66-file skill corpus.

### 4.1 Required fields

| Field | Constraint | Notes |
|---|---|---|
| `name` | 1-64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`, must equal the containing directory's basename | Matches agentskills.io spec verbatim. |
| `description` | 1-1024 chars | Must include *what the skill does AND when to use it*. The description drives both catalog discovery and model activation choice. |

### 4.2 Optional fields — standardized

| Field | Shape | Notes |
|---|---|---|
| `version` | semver string (`1.0.0`, `2.1.3-beta`) | Not in agentskills.io spec but present in 71% of our corpus; de facto universal. Recommended for any skill shipped publicly. |
| `argument-hint` | string, ≤ 200 chars | Autocomplete hint shown in slash-menus (`[path] [--fix]`). Present in 42% of our corpus. |
| `license` | SPDX identifier (`MIT`, `Apache-2.0`) or bundled filename (`LICENSE`) | Per spec. |
| `compatibility` | string, 1-500 chars | Free-form environment requirements (`node >= 20, requires ripgrep`). Per spec. |
| `metadata` | object, string → string | Arbitrary client-extension key/value map. Per spec. Our parser passes through verbatim. |

### 4.3 Optional fields — behavior hints

| Field | Shape | Semantics | v1? |
|---|---|---|---|
| `allowed-tools` | comma- or space-separated string (`Read, Grep, Bash(git:*)`) | **Advisory only in v1** — declares what tools the skill expects to need. See §6 for composition semantics. | **yes** |
| `disable-model-invocation` | boolean (default `false`) | When `true`, only user-initiated `/name` invocations load the skill. Model calls to `skill({ name })` return `kind: "disabled"`. | **yes** |
| `user-invocable` | boolean (default `true`) | When `false`, the skill is hidden from any slash-menu catalog the harness may render. Model-only skills. | **yes** |
| `arguments` | object, declaring named positional args for `$name` substitution | Opt-in named-argument contract. If declared, `arguments` input to the tool must be an object whose keys match this declaration. | optional v1 |

### 4.4 Optional fields — deferred to v1.1

These are Claude Code extensions we explicitly defer. Parser must **ignore unknown fields, not reject**, to keep forward-compatibility with skill authors who author for multiple harnesses.

| Field | Why deferred |
|---|---|
| `context: fork` | Requires a subagent primitive we don't ship. |
| `agent: <type>` | Same. |
| `hooks` | Skill-scoped hooks need a hook runtime design pass. |
| `model` | Model choice is a harness concern, not a tool concern. |
| `effort` | Same. |
| `paths` | Auto-activation gating on file context; we don't track file context. |
| `shell` | Only meaningful once we add dynamic `` !`<cmd>` `` injection. |
| `when_to_use` | The `description` field carries this already. |

### 4.5 Parser rules

1. Frontmatter is YAML between two `---` lines at the top of the file. Missing opening `---` → no frontmatter (body is the whole file). Missing closing `---` → `INVALID_FRONTMATTER`.
2. Parse YAML into a `Record<string, unknown>`. Validate required fields first.
3. Validate `name` matches the containing directory's basename. `name: foo` inside `skills/bar/SKILL.md` → `NAME_MISMATCH`.
4. Normalize `allowed-tools` from either string or array form into `string[]`.
5. Unknown fields are preserved in the output's `frontmatter` field; the parser does not reject them.
6. The body (everything after the closing `---`) is stored verbatim — no markdown processing. The model sees it raw.

### 4.6 Canonical SKILL.md

```yaml
---
# Required
name: api-conventions
description: |
  Use when designing or auditing HTTP APIs in this project. Covers endpoint naming,
  error envelope shape, pagination, and deprecation conventions. Run before drafting
  new routes or when reviewing PRs that add endpoints.

# Strongly recommended
version: 1.2.0
argument-hint: "[--audit path/to/file]"

# Pass-throughs
license: MIT
compatibility: "any node runtime"
metadata:
  short-description: "Project HTTP API style guide"
  owner: platform-team

# Advisory — v1 does not pre-approve tools; see §6
allowed-tools: Read, Grep, Bash(git log:*)

# Visibility
disable-model-invocation: false
user-invocable: true
---

# API Conventions

This project uses RESTful endpoint naming. ...

## When reviewing a new endpoint

1. Does the path use plural nouns? `/users`, not `/user`.
2. Does the response envelope match `references/error-schema.json`?
3. ...

## Scripts

Run `scripts/audit-endpoints.js <path>` to scan an endpoint file for convention
violations. The script prints a report; no context is consumed by the script's
source.
```

---

## 5. Workspace, discovery, and permission model

### 5.1 Skill roots

A session declares one or more skill roots. Each root is an absolute directory that contains skill subdirectories. Example:

```text
session.skill_roots = [
  "/workspace/.skills",             // project skills, committed with code
  "/home/user/.claude/skills",      // user skills, personal
  "/home/user/.agents/skills"       // shared across harnesses
]
```

The harness controls which roots are active. The tool scans only these; no walking up to `/`.

**Precedence.** Lower-index roots shadow higher-index ones. Project skills (index 0) override user skills (index 1) with the same name. Name collisions are resolved silently; a `meta.shadowed: string[]` field is populated on the catalog entry so tooling can audit.

### 5.2 Discovery

At session start (or when the catalog is queried):

1. For each root, list immediate subdirectories.
2. For each subdirectory, look for `SKILL.md`. Skip dirs without one.
3. Parse frontmatter. Skills with `INVALID_FRONTMATTER` are logged but omitted from the catalog.
4. Build `catalog: { name, description, dir, root_index }[]`, sorted by name.

Discovery errors are never fatal to session start — a broken skill shouldn't prevent the harness from running. They surface as warnings in the harness log and as `INVALID_FRONTMATTER` errors when the model attempts to activate by name.

### 5.3 Workspace fence

Same pattern as `read`/`write`/`lsp`. The resolved skill dir must be inside one of the session's configured skill roots. A skill whose `dir` resolves outside any configured root — via symlink, `..`, or session misconfiguration — returns `OUTSIDE_WORKSPACE`.

### 5.4 Sensitive patterns

If a skill dir matches any `sensitive_patterns` entry (e.g. `**/.env/**`, `**/secrets/**`) AND no hook is configured, activation is refused with `SENSITIVE`. Rationale: skill bodies can contain code snippets referencing credentials; a skill under `.env/` is almost certainly a misconfiguration.

### 5.5 Trust gating (autonomous-mode extension)

Autonomous-mode-specific. Session config:

```text
session.skill_trust = {
  trusted_roots: string[],          // e.g. [user's home skills dir]
  untrusted_project_skills: "hook_required" | "warn" | "allow"
}
```

Semantics:

- Skills under a root listed in `trusted_roots` activate freely (permission hook still runs as advisory).
- Skills under *other* roots with `untrusted_project_skills: "hook_required"` (the default) require explicit hook approval. The hook receives the skill's dir, frontmatter, and a `reason: "untrusted_project_skill"` flag.
- `"warn"` allows activation but emits a console warning.
- `"allow"` matches legacy behavior; no gating.

Skills are code-adjacent (they can call tools via `allowed-tools`, execute scripts). Cloning a repo and activating its skills without review is a supply-chain risk. This flag lets harness authors enforce a review step.

### 5.6 Permission hook signature

```text
hook({
  tool: "skill",
  action: "activate",
  path: skill_dir,
  always_patterns: ["Skill(name:{name})"],
  metadata: {
    name,
    root_index,
    frontmatter: { name, description, version, allowed_tools, ... },
    reason: "normal" | "untrusted_project_skill",
  }
}) → "allow" | "allow_once" | "deny"
```

`ask` → deny, matching autonomous-mode semantics of all other tools in this library. `unsafeAllowSkillWithoutHook: true` on the session permission policy is the no-hook escape hatch for test fixtures.

---

## 6. `allowed-tools` composition

This is the field that couples skills to the rest of the tool surface. Design decision (§4.3 option 1 in the author's proposal):

**`allowed-tools` is advisory in v1.** A skill's `allowed-tools: Bash(git:*), Read, Grep` does **not** pre-approve those tools for the skill's lifetime. The session's permission hook is authoritative on every downstream tool call. The field serves three purposes:

1. **Documentation.** The model sees `allowed-tools` in the skill body wrap (§3.1). It can plan tool usage accordingly.
2. **Catalog signaling.** Skills that need no tools (pure-instructions skills) can omit the field; skills that need `Bash(git:*)` signal that up front.
3. **Audit.** The hook receives `allowed-tools` as metadata on activation and on every downstream tool call, so a harness can enforce consistency ("this skill is active; the hook should allow its declared tools automatically").

v1.1 may add a `"pre-approve"` opt-in mode where activation with explicit hook consent pre-approves the listed tools for the skill's lifetime. Deferred until we have an audit-log surface to record the pre-approvals.

Anti-pattern to block in v1: a skill with `allowed-tools: Bash(*)` activating to circumvent a session-level deny-Bash policy. The advisory posture makes this structurally impossible.

---

## 7. Activation lifecycle

1. **Catalog load** (session start or first `skill` call). Walk `skill_roots`, parse frontmatter, build catalog. Cost: ~50-100 tokens per skill of metadata, stored in the tool's description-level or in a system-prompt injection (harness choice).

2. **Model calls `skill({ name, arguments })`.**

3. **Validation.** Parse params, verify name is in catalog, check permission hook, check trust gate, check `disable-model-invocation`.

4. **Body expansion.** Read SKILL.md, strip frontmatter, substitute `$ARGUMENTS` / `$1` / `$name` placeholders if `arguments` was provided. Enumerate up to 10 resource filenames from `scripts/`, `references/`, `assets/` (names only, not contents).

5. **Return.** The `ok` result includes the wrapped `<skill>` block. The harness is free to cache that the skill has been activated this session.

6. **Dedupe.** Subsequent calls to `skill({ name: same })` return `already_loaded`. The dedupe key is the skill name — not the full content — because the model treats skill identity by name, not by body hash.

7. **Session end.** Catalog discarded; activated-skill set discarded. No persistence.

**Explicit non-behavior:** the tool does not watch the filesystem. Editing a skill file mid-session does not invalidate the dedupe cache — authors restart the session to pick up edits. Simpler semantics; avoids surprise when edit-and-re-activate returns a stale body.

---

## 8. Resource expansion — `scripts/`, `references/`, `assets/`

Per agentskills.io, a skill folder may contain:

- `scripts/` — executables. **Source code is NOT loaded into context.** The skill body tells the model "run `scripts/audit.py <arg>`"; the model calls `bash(<dir>/scripts/audit.py <arg>)`; the script's output (not its source) enters the context.
- `references/` — Markdown docs too big for the skill body. The skill body says "see `references/error-schema.md`"; the model calls `read(<dir>/references/error-schema.md)` when needed.
- `assets/` — templates, diagrams, images. Used in output; copied by scripts or read by Read.

The `skill` tool **does not** eagerly load any of these. It lists up to 10 filenames per folder in the `<resources>` block so the model can see what's available, and stops there.

Rationale: this is the efficiency story. A skill with a 200-line script and a 3000-line reference doc costs ~100 tokens in the catalog, ~2000 tokens to activate, and 0 tokens for the script/reference until they're explicitly called. The agentskills.io spec is emphatic: "progressive disclosure is the point."

---

## 9. Argument substitution

If the skill body contains one or more of the following, and `arguments` is provided:

- `$ARGUMENTS` → the full string form of arguments (if arguments is a string) or the arguments formatted as space-separated `key=value` pairs (if object).
- `$1`, `$2`, ..., `$N` → positional tokens from `arguments` split on whitespace (string form only).
- `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, ... → same as `$N` but 0-indexed.
- `${name}` — a named argument, substituted from `arguments` object's `name` key. Only honored if the frontmatter declares `arguments: { name: {type, required, ...} }`.

Unsubstituted placeholders are left as literal text (not stripped). If the skill references `$1` but no arguments were passed, the model sees `$1` in the body and can proceed or retry with arguments.

Deliberately **not supported** in v1: `${SKILL_DIR}` path resolution. Scripts and references are called with full paths the tool emits in the `<resources>` block; the model doesn't need relative-path resolution.

---

## 10. Pluggable adapter

```text
interface SkillRegistry {
  // Called once at session start (or lazy on first tool call).
  discover(): Promise<readonly SkillEntry[]>;

  // Called on every activation. May re-read from disk or serve from cache.
  load(name: string): Promise<LoadedSkill | null>;
}

interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly dir: string;
  readonly root_index: number;
  readonly frontmatter: Readonly<Record<string, unknown>>;
}

interface LoadedSkill extends SkillEntry {
  readonly body: string;               // frontmatter-stripped
  readonly resources: readonly string[]; // filenames only
}
```

Default: `FilesystemSkillRegistry(roots: string[])` — the §5 behavior.

Adapters allow skills to come from non-filesystem sources:

- `@agent-sh/harness-skill-git` — skills pulled from a git repo, versioned.
- `@agent-sh/harness-skill-http` — skills served from an HTTP endpoint (enterprise skill library).
- `@agent-sh/harness-skill-db` — skills stored in a database with audit logging.

Core never depends on adapters. The `FilesystemSkillRegistry` is the only default.

---

## 11. Ledger integration

Skill activation is not a filesystem mutation, so the read-before-edit ledger doesn't apply to `skill` itself. However:

- **Scripts invoked by a skill** pass through `bash` and its normal permission hook.
- **References read by a skill** pass through `read` and record into the read-ledger normally.
- **Edits made during an active skill** pass through `edit` / `multiedit` and their normal NOT_READ_THIS_SESSION / STALE_READ checks.

No special ledger exemption for skill-triggered mutations. This keeps the read-before-edit invariant intact. Skills that want to pre-authorize edits must document "read file X before calling edit on it" in their body — same discipline the model already has.

---

## 12. Determinism, idempotence, concurrency

- **Determinism.** Skill body is byte-exact from disk. Frontmatter-strip is deterministic. Argument substitution is deterministic. Given the same SKILL.md + same `arguments`, `skill({name, arguments})` returns the same output within a session. Across sessions it depends on filesystem state.
- **Idempotence.** Explicit via `already_loaded`. Second call is a no-op.
- **Concurrency.** Multiple in-flight `skill` calls in the same session are serialized through a per-session lock on the catalog. Parallel activation of *different* skills is allowed but their bodies are appended to context in call-order, not in tool-response-order, to keep the conversation stable.

---

## 13. Tests — acceptance matrix

### 13.1 Unit (code correctness)

1. Empty `name` → `INVALID_PARAM`.
2. `name` not lowercase-kebab → `INVALID_PARAM`.
3. `name` > 64 chars → `INVALID_PARAM`.
4. `name` not in catalog → `NOT_FOUND` with fuzzy siblings.
5. Alias pushback (`skill_name`, `params`, `reload`) → `INVALID_PARAM`.
6. SKILL.md with name mismatch (`name: foo` in `bar/SKILL.md`) → `NAME_MISMATCH`.
7. SKILL.md with malformed YAML → `INVALID_FRONTMATTER`.
8. SKILL.md with missing required `description` → `INVALID_FRONTMATTER`.
9. SKILL.md with unknown field `hooks` → passes parse, field preserved in `frontmatter` output.
10. Skill dir with `../` escape → `OUTSIDE_WORKSPACE`.
11. Skill dir matching sensitive pattern, no hook → `SENSITIVE`.
12. `disable-model-invocation: true` activated from model → `DISABLED`.
13. `disable-model-invocation: true` activated from user-initiated (harness flag) → ok.
14. Trust: untrusted project skill with no hook → `NOT_TRUSTED`.
15. Trust: untrusted project skill with `unsafeAllowSkillWithoutHook: true` → ok.
16. First activation → `kind: "ok"`, body in output.
17. Second activation same name → `kind: "already_loaded"`.
18. Activation with string `arguments` → `$ARGUMENTS` substituted in body.
19. Activation with object `arguments` + frontmatter `arguments` declaration → `${name}` substituted.
20. Object `arguments` on a skill with no `arguments` frontmatter → `INVALID_PARAM`.
21. String `arguments` on a skill with named `arguments` frontmatter → `INVALID_PARAM`.
22. Resources enumeration: skill with `scripts/a.py`, `scripts/b.sh`, `references/r.md` → all listed in output, up to 10.
23. Resource count > 10 → output lists 10 + "(... {N} more)" marker.
24. Permission hook returns `deny` → `PERMISSION_DENIED`.
25. Permission hook returns `ask` → treated as deny.
26. `allowed-tools` string form (`"Read, Grep"`) → parsed to `["Read", "Grep"]`.
27. `allowed-tools` array form → accepted.
28. Name collision project > user → catalog shows project skill; `frontmatter.metadata.shadowed` lists the shadowed user skill dir.
29. Broken skill dir (no SKILL.md) → omitted from catalog silently.
30. SKILL.md with CRLF line endings → body and frontmatter parse correctly.

### 13.2 LLM e2e (model-contract validation)

Lives in `packages/harness-e2e/test/skill.e2e*.ts`. Minimum categories (SK1…SK8):

- **SK1 golden**: prompt references a skill's described trigger; model calls `skill({name})` once, then follows its instructions.
- **SK2 wrong-name**: prompt mentions a skill by paraphrase; model picks from catalog, NOT_FOUND on first try, recovers via siblings.
- **SK3 already-loaded**: agent activates the same skill twice; second call returns `already_loaded` and the model doesn't re-ask for content.
- **SK4 allowed-tools-advisory**: skill declares `allowed-tools: Bash(git:*)`; model attempts `bash(git log)` which the hook permits; but attempts `bash(rm -rf)` which the hook denies. Verifies skill declaration does not pre-approve.
- **SK5 disable-model-invocation**: skill has `disable-model-invocation: true`; model calls `skill({name})` and gets `DISABLED`; does not retry.
- **SK6 resource-reference**: skill body says "run scripts/audit.py"; model calls `bash(<dir>/scripts/audit.py)` with the dir from the skill's resource listing.
- **SK7 argument-passing**: skill declares named `arguments`; model calls `skill({name, arguments: {path: "..."}})` with correct shape.
- **SK8 trust-gate**: untrusted project skill, no hook approval; model gets NOT_TRUSTED; does not try to bypass by changing activation shape.

Stochastic ones (SK4 especially) in pass@k.

Multi-model coverage per `agent-knowledge/testing-harness-tools.md`: gemma4:e2b + gemma4:26b + qwen3:8b + qwen3.5:27b via Ollama; per-release Bedrock Opus 4.7.

---

## 14. Stability

Breaking changes bump major. Additions (new error codes, new optional frontmatter fields, new params) are minor. Error `code` values are a public contract. Frontmatter field names are a public contract — renaming `description` → `desc` is breaking.

Forward-compatibility stance: the parser **ignores unknown frontmatter fields**, so authors can target future Claude Code / OpenCode extensions without our parser rejecting their file.

---

## 15. Open questions (deferred)

- **`context: fork` — subagent-isolated skills.** Requires a subagent primitive we don't ship. When we do, this is the first v1.1 addition. The design question is the context-forking semantics: does the parent see the fork's tool calls? Does the fork inherit the parent's read-ledger?
- **Dynamic shell injection** (`` !`<cmd>` `` in the body). Killer ergonomic feature. Security surface: a skill body can `rm -rf` on activation. Defer until we have a sandbox layer or a per-block confirmation flow.
- **Live filesystem watching.** Nice but not load-bearing. Skill authors currently restart sessions to pick up edits; that's fine.
- **`paths` auto-activation gating.** Needs a file-context awareness layer we don't have. Could be added later as a session-level filter on the catalog.
- **`allowed-tools` pre-approval mode.** See §6. Wait for evidence that the advisory mode is insufficient before adding an audited pre-approve option.
- **Skill composition.** Can a skill's body reference `{{skill:other-skill}}` to pull in another skill's body at expansion time? Spec says no; model can call `skill` again if it needs both. Watch for author demand.
- **Skill argument types beyond strings.** Named arguments in v1 are strings only. Frontmatter `arguments: { count: { type: "integer" } }` would let the harness coerce. Defer.
- **Project-trust UX.** The trust gate (§5.5) is the right safety posture, but the UX of "a new skill appeared in your project, approve it?" is a harness concern. Our design leaves that to the hook.
- **MCP cross-exposure.** Skills as MCP prompts — `@agent-sh/skill-mcp-bridge` could expose installed skills as MCP prompts to non-Claude harnesses. Secondary distribution; not core.

---

## 16. References

- `agent-knowledge/skill-tool-design-across-harnesses.md` — the 14-section deep dive across Claude Code, OpenCode, Gemini, Continue, Codex, Amp, and 35+ adopters (primary).
- `agent-knowledge/skill-tool-in-autonomous-agents.md` — complementary research on autonomous-agent skill patterns: OpenHands, Hermes, SWE-agent, Voyager lineage, Letta, OpenAI Agents SDK primitives.
- `agent-knowledge/harness-tool-surface-audit.md` §Skill — the gap analysis that motivated the ship decision.
- `agent-knowledge/ai-agent-harness-tooling.md` §Progressive disclosure — the architectural argument.
- Anthropic "Agent Skills" announcement — Oct 16 2025 engineering blog.
- `agentskills.io/specification` — the required-vs-optional frontmatter table that §4 mirrors.
- Claude Code `Skill` docs — `code.claude.com/docs/en/skills` (tool description, frontmatter extensions).
- OpenCode `skill.ts` — `packages/opencode/src/tool/skill.ts` (the resource-enumeration pattern).
- Simon Willison's "Claude Skills are awesome, maybe a bigger deal than MCP" — the token-economics argument.
- `anthropics/skills` repository — Apache 2.0 reference skills (structure and style reference).

---

## Addendum: decision log

- **S-D1** (Tool name): `skill` (lowercase). Matches OpenCode / Gemini CLI convention. Claude Code uses `Skill` (uppercase); we match the emerging consensus.
- **S-D2** (Activation pattern): Pattern A — dedicated tool. Alternatives (file-read + catalog-in-system-prompt, slash-command-only) considered and rejected on tool-surface-count grounds per `agent-tool-use-methods.md` §tool-count limits. A dedicated tool gives us the dedupe, permission-gate, and structured-wrap hooks we need; the extra tool cost is 1 schema in the surface.
- **S-D3** (Frontmatter scope): agentskills.io required + optional fields + 4 Claude Code extensions widely adopted in our corpus (`version`, `argument-hint`, `disable-model-invocation`, `user-invocable`). Other Claude Code extensions deferred to v1.1.
- **S-D4** (`allowed-tools` semantics): advisory in v1. Matches our autonomous-mode posture (no implicit privilege grants). Pre-approve mode deferred to v1.1 with audit logging.
- **S-D5** (Trust gating): autonomous-specific extension. Untrusted project skills default to hook-required. Matches the pattern set by `unsafeAllowLspWithoutHook` on LSP.
- **S-D6** (Dedupe by name): identity is skill name, not body hash. Edit-and-re-activate does not bust the cache; session-restart does. Simpler mental model.
- **S-D7** (Resource expansion): names only, max 10 per folder. Scripts and references load on demand via bash/read. Matches OpenCode behavior.
- **S-D8** (Argument substitution): `$ARGUMENTS` / `$N` / `$name`. v1 strings only; named-argument typing deferred.
- **S-D9** (Ledger): skill doesn't mutate, so no ledger interaction. Downstream tools still use their normal ledger semantics.
- **S-D10** (Permission): hook receives skill dir + frontmatter on activation. Follows the fail-closed-without-hook pattern of bash / webfetch / lsp. `unsafeAllowSkillWithoutHook` is the test-fixture escape.
- **S-D11** (Pluggable registry): `SkillRegistry` interface with `FilesystemSkillRegistry` default. Mirrors `SandboxAdapter` (bash), `WebFetchEngine` (webfetch), `LspClient` (lsp) plugin boundaries.
- **S-D12** (Forward compat): unknown frontmatter fields preserved, not rejected. Authors target Claude Code's newer extensions without our parser breaking.
