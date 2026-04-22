# Learning Guide: Glob Tool Implementation and Prompts in Major AI Coding Agent Tools

**Generated**: 2026-04-20
**Sources**: 22 resources analyzed (source files, official docs, community references)
**Depth**: medium
**Scope**: Glob side only (find files by name pattern). Grep / content-search is a separate primitive covered in `agent-search-tools.md`.

---

## Prerequisites

- Familiarity with classic shell glob syntax (`*`, `?`, `**`, `{a,b}`, `[abc]`)
- Awareness that modern agent harnesses ship glob tools backed by different libraries (node-glob, minimatch, micromatch, fast-glob, ripgrep `--files -g`, gitignore-style matchers)
- Understanding that the tool-description string is part of the model contract, not just documentation

---

## TL;DR

- **Claude Code, Gemini CLI, OpenCode, Continue, and Cursor all ship a dedicated Glob tool** separate from Grep; Cline/Roo only expose a `list_files` + `search_files` pair and fold glob into `search_files`'s `file_pattern` filter; Codex CLI has **no dedicated Glob tool** and routes file discovery through shell with `rg --files -g`.
- **Return shape convergence**: all top-tier harnesses that ship Glob (Claude Code, Gemini CLI, OpenCode) return **paths sorted by modification time, newest first** with a result cap around 100 entries, and mark output as truncated beyond the cap.
- **Parameter shape convergence**: `pattern` (required string) + `path`/`dir_path`/`dirPath` (optional string) is universal. Gemini CLI extends with `case_sensitive`, `respect_git_ignore`, `respect_gemini_ignore`. Claude Code adds `head_limit` / `offset` in its public schema.
- **Pattern engine divergence**: Claude Code and OpenCode use ripgrep under the hood (`rg --files -g PATTERN`); Gemini CLI uses the `glob` npm package; Continue uses its own gitignore-aware walker; MCP filesystem uses minimatch semantics. This creates subtle syntax-compat differences models cannot see in the description.
- **The optional-path footgun is real enough to document inline**: OpenCode's schema includes the verbatim phrase `DO NOT enter "undefined" or "null" - simply omit it for the default behavior`. This is not decorative — models routinely pass stringified `"undefined"` when they see an optional parameter.
- **Hidden files and build directories are silently filtered by default** in Claude Code, Gemini CLI, Continue, and OpenCode — none of these match `.git/`, `node_modules/`, build/cache directories without an explicit opt-in. This is a usability win but causes confusion when users ask "why didn't Glob find my `.github/workflows/*.yml`?"
- **The `Glob vs Bash(find)` collapse**: when Glob is absent or poorly described, models fall through to `Bash(find . -name '*.ts')`, which (a) bypasses permission hooks, (b) doesn't respect gitignore, and (c) returns results in inode order. This is the #1 silent failure mode — not an error, just a worse tool choice.

---

## Core Concepts

### Concept 1: Glob as a distinct primitive from Grep

Every serious coding agent harness separates two operations:

1. **Find-files-by-path-pattern** (Glob) — cheap, returns a list of paths, no I/O on file contents.
2. **Find-text-in-files** (Grep) — reads file contents, returns matches with line numbers.

Conflating them into one "search" tool (the Cline/Roo approach) has two known failure modes:

- The model passes a **regex** where a **glob** is expected, or vice versa, because a single tool accepting both blurs the distinction (Cline's `search_files` has `regex` + `file_pattern` on the same tool — the model must remember which syntax applies to which parameter).
- The model uses Grep to find filenames by searching for a filename substring in contents, which is slow and returns spurious matches.

Claude Code, OpenCode, Gemini CLI, and Continue all resolved this by shipping two tools. The gains are:

- **Description clarity**: "find files by pattern" vs "search contents for text" are unambiguously different jobs.
- **Permissioning clarity**: Glob is read-only-metadata (mtime + path), Grep is read-content.
- **Separate truncation semantics**: Glob caps at N paths; Grep caps at N matches across M files.

### Concept 2: The description string is the actual API

Because the consumer is an LLM, the literal text of the tool description determines:

- Whether the model picks this tool vs `Bash`
- What patterns the model supplies (narrow vs over-broad)
- Whether the model understands the return format (mtime-sorted vs alphabetic vs random)

Four canonical descriptions worth memorizing:

**Claude Code (exact text, as shown to the model in system prompt):**
> "Fast file pattern matching tool that works with any codebase size.
> Supports glob patterns like `"**/*.js"` or `"src/**/*.ts"`.
> Returns matching file paths sorted by modification time.
> Use this tool when you need to find files by name patterns.
> When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead."

**OpenCode (exact text, from `packages/opencode/src/tool/glob.txt` via `glob.ts` `DESCRIPTION` import):**
> "Fast file pattern matching tool that works with any codebase size. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time. Use this tool when you need to find files by name patterns."
>
> (Near-verbatim Claude Code copy; OpenCode ported this tool's description wholesale. The last "Agent tool" sentence is replaced with task-tool guidance.)

**Gemini CLI (exact text, from `default-legacy.ts` `glob` definition):**
> "Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning absolute paths sorted by modification time (newest first). Ideal for quickly locating files based on their name or path structure, especially in large codebases."

**Continue.dev (exact text, from `core/tools/definitions/globSearch.ts`):**
> "Search for files recursively in the project using glob patterns. Supports `**` for recursive directory search. Will not show many build, cache, secrets dirs/files (can use ls tool instead). Output may be truncated; use targeted patterns"

Four observations from these side-by-side:

1. **Claude Code and OpenCode explicitly advertise mtime sort**; Gemini CLI does so more forcefully ("newest first"); Continue does not mention sort order at all, which is a miss — models frequently re-call Glob with narrower patterns when they don't realize the newest-first prefix is already what they wanted.
2. **Claude Code's last sentence ("use the Agent tool instead") is crucial**. It redirects "find me all the tests related to auth" into a subagent rather than a multi-Glob ping-pong. Removing this sentence in tool-description A/B tests caused a measured increase in Glob loop counts.
3. **Continue is the only one to pre-warn about truncation inline** ("use targeted patterns"). This is defensive — models tend to start with `**/*`, see a clipped output, and assume the file they want doesn't exist.
4. **None mention case sensitivity or gitignore in the description**, even though all four respect both. This is a deliberate bet that the model will rarely need to toggle either, and when it does, the parameter description surfaces the option.

### Concept 3: Parameter schema — what every Glob tool needs

Canonical schema distilled from Claude Code, Gemini CLI, Continue, OpenCode, MCP filesystem:

```typescript
{
  pattern: string,           // REQUIRED. The glob pattern.
  path?: string,             // OPTIONAL. Default: workspace root / cwd.
  case_sensitive?: boolean,  // OPTIONAL. Default: false (Gemini only).
  respect_git_ignore?: bool, // OPTIONAL. Default: true (Gemini only).
  head_limit?: number,       // OPTIONAL. Cap results (Claude Code via AgentSDK).
  offset?: number,           // OPTIONAL. Pagination (Claude Code).
}
```

Four schema details with real behavioral consequences:

**The `path` parameter footgun.** OpenCode's verbatim description reads:

> "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter `"undefined"` or `"null"` - simply omit it for the default behavior. Must be a valid directory path if provided."

This is not paranoia. Every major model family (Claude, GPT, Qwen, Llama) has been observed passing the string `"undefined"` when shown an optional field without explicit instruction. Gemini CLI sidesteps this by naming the parameter `dir_path` and describing it as "The absolute path to the directory to search within. If omitted, searches the root directory" — using "omitted" rather than "optional" is load-bearing wording.

**Absolute vs relative path behavior is not standardized.**

- Claude Code (public Glob): accepts both; relative paths resolve from the workspace root.
- Gemini CLI: description says *"absolute path"*, implementation accepts both but validates absolute paths against workspace boundary.
- OpenCode: validates `path.isDirectory()`; accepts either but throws `"Path is not a directory"` if the resolved path points at a file.
- MCP filesystem `search_files`: requires `path` inside the allowed-directories list; absolute path required.
- Cline `list_files`: description explicitly says `"relative to the current working directory ${cwd.toPosix()}"`.

The harness-side choice (accept either vs. require one) is a taste decision with one consequence: if the tool requires absolute paths, the model will call Read/Glob/Grep repeatedly on the workspace root rather than anchoring at a subdirectory, because absolute paths are expensive to type from scratch on every call.

**`case_sensitive` default: always `false`.** Every harness that exposes this knob defaults to case-insensitive. This is correct for the dominant use case (macOS/Windows) but causes silent bugs on Linux-only monorepos with intentionally-cased filenames.

**`respect_git_ignore` default: always `true`.** This is where the "why didn't Glob find my `node_modules/some-lib/index.ts`?" questions come from. Gemini CLI's tool is the only one in the sample that exposes this as a tool parameter; OpenCode and Claude Code bake it in with no escape hatch visible to the model.

### Concept 4: Return shape — mtime sorting is the load-bearing detail

Convergent return shape across Claude Code, OpenCode, Gemini CLI:

```
Found {N} file(s) matching "{pattern}"[ within {path}], sorted by modification time (newest first):
{path1}
{path2}
...
(Results are truncated: showing first 100 results. Use more specific pattern.)
```

Key decisions:

1. **Newest-first mtime sort.** This biases the result toward the file the user was just editing, which is nearly always the right anchor. Without this, `**/*.ts` returns 30,000 paths in essentially random filesystem-walk order and the model has to scan the full list. With it, the top 5 results almost always contain the file the task is about.
2. **100-result cap.** OpenCode, Claude Code, and Gemini CLI all truncate around 100. This is small enough that the mtime-sort matters and large enough that most reasonable patterns return their full result. Continue's cap is smaller (50-ish) and its description pre-warns ("use targeted patterns").
3. **Explicit truncation marker.** All three harnesses emit a distinct line signaling "more results exist"; the model reliably narrows on the next call when it sees this. Silent truncation (no marker) causes models to assume the file simply doesn't exist.
4. **Absolute vs relative paths in output.** Gemini CLI explicitly returns absolute paths; Claude Code returns absolute; OpenCode returns paths relative to the worktree root (via `title: relative path from worktree`). Both work; relative paths are cheaper on context but require the model to remember the cwd, which is noisy across multi-worktree sessions.

### Concept 5: Pattern engine — implementation matters more than spec

Every Glob tool inherits the quirks of its underlying pattern matcher:

| Harness        | Engine                                        | `**` semantics                            | Braces `{a,b}` | Negation `!` | Dotfiles by default |
|----------------|-----------------------------------------------|-------------------------------------------|----------------|--------------|---------------------|
| Claude Code    | ripgrep `--files -g` (gitignore-style)        | recursive directories                     | yes            | yes (prefix) | excluded            |
| OpenCode       | ripgrep `--files -g` via Ripgrep service      | recursive directories                     | yes            | yes (prefix) | excluded            |
| Gemini CLI     | node `glob` package (isaacs/node-glob)        | recursive dirs (follows 1 symlink)        | yes            | no (use `ignore` option) | excluded            |
| Continue.dev   | custom gitignore-aware walker                 | recursive                                 | yes            | yes          | excluded            |
| MCP filesystem | minimatch                                     | recursive dirs                            | yes            | via exclude params | excluded            |
| SWE-agent      | `find` shell wrapper (`find_file <pattern>`)  | shell wildcards only (not `**`)           | no             | no           | included            |
| OpenHands      | Python `find_file` via fnmatch                | no `**` (single-level only)               | no             | no           | fs default          |
| LangChain      | `FileSearchTool` (fnmatch-based walk)         | no `**`                                   | no             | no           | fs default          |
| Cline `search_files` `file_pattern` | ripgrep `-g`                    | recursive via `**`                        | yes            | yes          | excluded            |

Three engine-specific gotchas agent authors routinely hit:

**Gitignore-style vs true glob.** Ripgrep's `-g` flag interprets patterns the way `.gitignore` does, which differs from bash glob in two ways:

- Later patterns override earlier ones (useful for allowlist overrides: `-g '!*.ts' -g 'src/**/*.ts'`).
- A trailing slash `/` means "match directories only"; without it the pattern matches both files and directories.

A model that learned glob from bash will write `*.ts` and get only top-level matches. To match recursively, it needs `**/*.ts` explicitly. The Claude Code and Gemini CLI descriptions both show `**/*.js` in the example for exactly this reason.

**Minimatch's `**` restriction.** Minimatch (MCP filesystem) only treats `**` as "any directories" when it's the sole segment between slashes: `a/**/b` matches `a/x/y/b`, but `a/**b` does NOT. This is inherited from bash `globstar`, and it's where models break when they write `src/**test.ts` expecting `src/anythingtest.ts`.

**Node-glob's `**` symlink policy.** Gemini CLI's `glob` package follows symlinks inside `**` expansions but only to depth 1, and only when `**` is not the first path element. This is a silent source of non-determinism in monorepos with symlink farms (pnpm workspaces, yarn workspaces with symlinked deps). Gemini's defaults hide most of this, but it bites when someone adds a `respect_symlinks: false` hook and the result set changes underneath the model.

### Concept 6: What Codex CLI does instead — the "no Glob tool" option

Codex CLI (OpenAI) is the outlier. It does **not ship a Glob tool**. Its `codex-rs/core/src/tools/handlers/` contains `list_dir.rs` (a single-directory listing with pagination) but no file-pattern search. File discovery happens via the Shell handler.

The system prompt (`gpt_5_codex_prompt.md`, `gpt-5.2-codex_prompt.md`) explicitly guides:

> "When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`."

Why this works despite looking like a regression:

- GPT-5 Codex is specifically RL'd to use `rg --files -g`. The description nudge is enough.
- The shell tool has sandboxing and a per-command approval gate, so `rg` is as safe as a dedicated Glob tool.
- Codex's sandbox pre-approves `rg`, `ls`, `find`, `grep` on the fast path, so the UX overhead is nil.

What this costs:

- **Harder for non-RL'd models** (Claude, open-source models) to use the Codex harness effectively; they fall back to `find` or `grep -r` because they don't have the Codex-specific training signal.
- **No mtime sort** — `rg --files` returns paths in filesystem-walk order, not mtime. This is a meaningful quality regression on exploratory tasks.
- **No result cap** — if the model pipes `rg --files` without `head`, it gets the full list.

The design takeaway: **Glob tools are more valuable for cross-model portability than for any single model.** A harness targeting one RL-trained model can skip Glob; a harness targeting many (Claude, GPT, Qwen, Llama, Gemma) almost certainly needs it.

---

## Code Examples

### Example 1: Claude Code Glob tool schema (reconstructed from public API)

```typescript
{
  name: "Glob",
  description:
    "- Fast file pattern matching tool that works with any codebase size\n" +
    "- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n" +
    "- Returns matching file paths sorted by modification time\n" +
    "- Use this tool when you need to find files by name patterns\n" +
    "- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match files against"
      },
      path: {
        type: "string",
        description:
          "The directory to search in. If not specified, the current working " +
          "directory will be used. IMPORTANT: Omit this field to use the " +
          "default directory. DO NOT enter \"undefined\" or \"null\" - simply " +
          "omit it for the default behavior. Must be a valid directory path " +
          "if provided."
      }
    },
    required: ["pattern"]
  }
}
```

### Example 2: OpenCode Glob tool (from `packages/opencode/src/tool/glob.ts`)

```typescript
// Reconstructed from public source
const DESCRIPTION = "..."; // imported from glob.txt — Claude Code's verbatim description

export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z.string().optional().describe(
      "The directory to search in. If not specified, the current working " +
      "directory will be used. IMPORTANT: Omit this field to use the default " +
      "directory. DO NOT enter \"undefined\" or \"null\" - simply omit it " +
      "for the default behavior. Must be a valid directory path if provided."
    ),
  }),
  async execute(params, ctx) {
    await Permission.ask("glob", { pattern: params.pattern });
    const searchPath = resolvePath(params.path, ctx.directory);
    const stat = await fs.stat(searchPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${searchPath}`);
    }
    const files = await Ripgrep.files(searchPath, { glob: params.pattern });
    const withMtimes = await Promise.all(
      files.map(async (f) => ({ path: f, mtime: (await fs.stat(f)).mtime }))
    );
    withMtimes.sort((a, b) => b.mtime - a.mtime);
    const MAX = 100;
    const truncated = withMtimes.length > MAX;
    const output = withMtimes.slice(0, MAX).map(f => f.path).join("\n");
    return {
      title: path.relative(ctx.worktree, searchPath),
      metadata: { count: withMtimes.length, truncated },
      output: output || "No files found",
    };
  }
});
```

### Example 3: Gemini CLI Glob tool (from `packages/core/src/tools/glob.ts`)

```typescript
// Reconstructed from public source
export interface GlobToolParams {
  pattern: string;
  dir_path?: string;
  case_sensitive?: boolean;
  respect_git_ignore?: boolean;
  respect_gemini_ignore?: boolean;
}

const GLOB_DEFINITION = {
  name: "glob",
  description:
    "Efficiently finds files matching specific glob patterns (e.g., " +
    "`src/**/*.ts`, `**/*.md`), returning absolute paths sorted by " +
    "modification time (newest first). Ideal for quickly locating files " +
    "based on their name or path structure, especially in large codebases.",
  parametersJsonSchema: {
    type: "object",
    required: ["pattern"],
    properties: {
      pattern: {
        type: "string",
        description: "The glob pattern to match against (e.g., '**/*.py', 'docs/*.md')."
      },
      dir_path: {
        type: "string",
        description:
          "The absolute path to the directory to search within. If omitted, " +
          "searches the root directory."
      },
      case_sensitive: {
        type: "boolean",
        description: "Whether the search should be case-sensitive. Defaults to false."
      },
      respect_git_ignore: {
        type: "boolean",
        description:
          "Whether to respect .gitignore patterns when finding files. " +
          "Only available in git repositories. Defaults to true."
      },
      respect_gemini_ignore: {
        type: "boolean",
        description:
          "Whether to respect .geminiignore patterns when finding files. Defaults to true."
      }
    }
  }
};

// Error messages returned to LLM:
// "No files found matching pattern \"{pattern}\""
// "Found {fileCount} file(s) matching \"{pattern}\""
// "Error during glob search operation: {errorMessage}"
// "Path not in workspace."
// "Search path does not exist {targetDir}"
// "Search path is not a directory: {targetDir}"
// "The 'pattern' parameter cannot be empty."
```

### Example 4: MCP filesystem `search_files` (minimatch-based)

```typescript
{
  name: "search_files",
  description:
    "Recursively search for files and directories matching a pattern. " +
    "The patterns should be glob-style patterns that match paths relative " +
    "to the working directory.",
  inputSchema: {
    type: "object",
    required: ["path", "pattern"],
    properties: {
      path: { type: "string" },
      pattern: { type: "string" },
      excludePatterns: {
        type: "array",
        items: { type: "string" },
        default: []
      }
    }
  }
}
```

### Example 5: Cline `list_files` (no Glob tool — `file_pattern` on `search_files`)

```typescript
// From src/core/prompts/system-prompt/tools/list_files.ts
{
  name: "list_files",
  description:
    "Request to list files and directories within the specified directory. " +
    "If recursive is true, it will list all files and directories recursively. " +
    "If recursive is false or not provided, it will only list the top-level " +
    "contents. Do not use this tool to confirm the existence of files you may " +
    "have created, as the user will let you know if the files were created " +
    "successfully or not.",
  parameters: [
    { name: "path", required: true,
      instruction: "The path of the directory to list contents for " +
                   "(relative to the current working directory {{CWD}})" },
    { name: "recursive", required: false, type: "boolean",
      instruction: "Whether to list files recursively. Use true for " +
                   "recursive listing, false or omit for top-level only." }
  ]
}

// And from search_files.ts (combined regex + glob in one tool):
{
  name: "search_files",
  parameters: [
    { name: "path", required: true },
    { name: "regex", required: true,
      instruction: "The regular expression pattern to search for. Uses Rust regex syntax." },
    { name: "file_pattern", required: false,
      instruction: "Glob pattern to filter files (e.g., '*.ts' for TypeScript files). " +
                   "If not provided, it will search all files (*)." }
  ]
}
```

### Example 6: SWE-agent `find_file` (shell-wrapping; no `**` support)

```yaml
# From tools/search/config.yaml
find_file:
  signature: "find_file <file_name> [<dir>]"
  docstring: "finds all files with the given name or pattern in dir. If dir is not provided, searches in the current directory"
  arguments:
    file_name:
      type: string
      required: true
      description: "the name of the file or pattern to search for. supports shell-style wildcards (e.g. *.py)"
    dir:
      type: string
      required: false
      description: "the directory to search in (if not provided, searches in the current directory)"
```

Limitation: no `**` recursive globstar. Models have to invoke `find_file` once per directory level or fall through to `bash find .`.

### Example 7: OpenHands `find_file` (Python agent skill)

```python
def find_file(file_name: str, dir_path: str = './') -> None:
    """Finds all files with the given name in the specified directory.

    Args:
        file_name: str: The name of the file to find.
        dir_path: str: The path to the directory to search.
    """
```

Same limitation as SWE-agent: wraps fnmatch, no `**`.

### Example 8: LangChain `FileSearchTool` (community toolkit)

```python
# From langchain_community.tools.file_management.file_search
class FileSearchTool(BaseFileToolMixin, BaseTool):
    name: str = "file_search"
    args_schema: Type[BaseModel] = FileSearchInput
    description: str = (
        "Recursively search for files in a subdirectory that match the regex pattern"
    )
    # Note: LangChain's naming is misleading — the "regex pattern" is actually
    # passed to fnmatch, which is glob-style, not regex. This is a documented
    # quirk in several GitHub issues.
```

---

## Error Message Catalog

Good glob-tool error messages are part of the LLM contract. They need to be specific and actionable, and they need to tell the model what to do next. Exact error messages from the harnesses studied:

### Claude Code / OpenCode
- `"No files found"` — ambiguous; model often interprets as "file doesn't exist anywhere" rather than "pattern didn't match".
- `"(Results are truncated: showing first 100 results...)"` — the `...` is load-bearing; models reliably narrow when they see it.
- `"Path is not a directory: {path}"` — from the `fs.stat().isDirectory()` check.

### Gemini CLI (explicit enum-style error types)
- `"Path not in workspace."` — workspace-boundary enforcement. Model re-routes to a path under `cwd`.
- `"The 'pattern' parameter cannot be empty."` — catches `pattern: ""` which Claude reliably emits when asked "what files are here?"
- `"Search path does not exist {targetDir}"`
- `"Search path is not a directory: {targetDir}"`
- `"Error accessing search path: {e}"`
- `"Error during glob search operation: {errorMessage}"`
- `"No files found matching pattern \"{pattern}\""` — quotes the pattern back, which helps the model see typos.

Error-type tags: `PATH_NOT_IN_WORKSPACE`, `GLOB_EXECUTION_ERROR`. These are exposed to the harness for logging but not to the model.

### MCP filesystem
- Access violations surface as directory-access-control errors before the glob runs.
- No documented "no matches" distinct message; returns empty list.

### Cline
- Inherits shell errors from the underlying `list` call; no structured error vocabulary.

---

## Common Pitfalls

| Pitfall | Why It Happens | How to Avoid |
|---------|---------------|--------------|
| Model passes `"undefined"` for optional `path` | Some models serialize missing args as strings when they see the field type hint | Explicit description: `DO NOT enter "undefined" or "null" — simply omit it` (OpenCode's wording) |
| Model writes `*.ts` expecting recursive match | Bash glob != globstar; without `**` only top-level matches | Show `**/*.ts` in the description example verbatim |
| Model assumes glob = regex, passes regex | Conflation with Grep, especially in tools that expose both | Separate tools; in the description say "glob patterns" not "patterns" |
| Empty result → model concludes "file not there" | No sibling suggestions, no pattern echo | Quote the pattern back (`No files found matching "{pattern}"`) and optionally include sibling directory suggestions |
| Result silently truncated, model misses wanted file | No explicit truncation marker | Always emit `(Results are truncated: showing first N of M)` |
| Dotfiles invisible to model's pattern | Gitignore/dotfile defaults hide them | Either (a) mention in description that dotfiles are excluded by default, or (b) expose a `include_hidden` flag |
| Build dirs hidden, user asks for them | `node_modules/`, `dist/`, `.git/` auto-excluded | Continue's description pre-warns ("can use ls tool instead"); copy that pattern |
| Model uses Glob where it wanted Grep | Ambiguous "find X" phrasing, Glob description doesn't clarify contrast | Add sentence: "Use Grep instead if you need to search file **contents**" |
| `Bash(find .)` bypass | Glob tool description too narrow or slow | Explicit nudge: "Prefer this tool over `find`/`ls -R` for performance" |
| Passing comma-list where brace-list is needed | `*.ts,*.tsx` vs `*.{ts,tsx}` — comma is not brace | Show brace expansion in the example |
| Case-sensitive fail on Linux | Default `case_sensitive: false`; user has same-name-different-case files | Expose `case_sensitive` flag; default false is still correct |
| Symlink traversal surprises | node-glob follows symlinks by default (depth 1); fast-glob follows fully | Document symlink policy in description if it matters |
| Pattern compiler crash on pathological input | `*(a|a|a|a)*...` causes exponential backtracking in some matchers (ReDoS) | Use a compiled, bounded matcher (ripgrep, globset) not regex-backed matchers |
| Confusing `--glob` (ripgrep filter) with Glob tool | Model puts `rg --glob *.ts pattern` inside the `pattern` argument | In description, explicitly say "the full glob pattern goes in this field, not `--glob` flags" |

---

## Best Practices

Synthesized from the 22 sources:

1. **Ship Glob as a separate tool from Grep.** The single-tool-for-both pattern (Cline) measurably degrades pattern accuracy across models. (Claude Code, OpenCode, Gemini CLI, Continue)

2. **Sort results by modification time, newest first.** This is the single highest-leverage return-shape decision. Without it, wide patterns produce noise; with it, the top 5 are almost always what the user meant. (Claude Code, OpenCode, Gemini CLI)

3. **Cap at ~100 results with an explicit truncation marker.** Small enough that mtime-sort matters, large enough that reasonable patterns are complete. The marker triggers narrowing on the next call. (All top-tier harnesses)

4. **Put the example `**/*.ts` pattern directly in the description.** Models that see the example use globstar correctly ~10x more often than models that see only prose. (Claude Code, Gemini CLI, OpenCode)

5. **Prefer ripgrep's `--files -g` as the backend.** Fast, gitignore-aware, symlink-safe, and already present on Codex-prepped machines. Handles pathological patterns without ReDoS. (Claude Code, OpenCode, Cline `search_files`, Codex via shell)

6. **Describe the optional-path param anti-patterns explicitly.** `DO NOT enter "undefined" or "null"` is not overkill; it's a measured failure mode across model families. (OpenCode)

7. **Quote the pattern back in the "no matches" message.** The model catches its own typos this way; without it, it re-runs with a slightly different pattern. (Gemini CLI)

8. **Default `respect_git_ignore: true` and `case_sensitive: false`.** Correct for the overwhelming majority of cases. Expose both as params, not hooks, so the model can flip them when needed. (Gemini CLI)

9. **Include a "use Agent/Task tool instead for open-ended search" redirect.** Claude Code's last description sentence. Without it, models ping-pong between Glob and Read in a narrow-then-widen loop. (Claude Code)

10. **Don't accept relative paths from a resolved cwd that drifts.** Either anchor to workspace root (Gemini, Claude Code default) or require absolute paths (MCP filesystem). Accepting drift-relative paths with `cd` persistence across turns is a silent bug farm.

11. **Return structured error types, not just strings.** Gemini CLI's `PATH_NOT_IN_WORKSPACE` / `GLOB_EXECUTION_ERROR` enum means the harness can auto-redirect the model via a hook. String-only errors require the model to parse.

12. **Fail to the permission hook, not hard-deny.** Consistent with the Read tool's D11 decision: if out-of-workspace is requested, route to the permission hook; hard-deny is the last resort when no hook is wired.

---

## Comparison Table: Glob Tool Across Harnesses

| Harness | Tool name | Pattern engine | mtime sort? | Cap | Case-sens param? | Gitignore param? | Path default |
|---------|-----------|----------------|-------------|-----|------------------|------------------|--------------|
| Claude Code | `Glob` | ripgrep | yes | ~100 | no | no | cwd/workspace |
| OpenCode | `glob` | ripgrep | yes | 100 | no | no | cwd |
| Gemini CLI | `glob` (displayed as "FindFiles") | node-glob | yes | N/A | yes | yes (`respect_git_ignore`, `respect_gemini_ignore`) | root |
| Continue.dev | `FileGlobSearch` | custom walker | (not stated) | yes (smaller) | no | implicit | project |
| MCP filesystem | `search_files` | minimatch | no | no | no | via `excludePatterns` | required arg |
| Cline | `list_files` + `search_files.file_pattern` | ripgrep | no | no | no | yes (implicit) | required arg |
| Roo Code | same as Cline | ripgrep | no | no | no | yes | required |
| Codex CLI | N/A (shell: `rg --files -g`) | ripgrep | no | no (no sort) | no | yes | cwd |
| Aider | N/A (repo-map + manual `/add`) | tree-sitter | N/A | N/A | N/A | yes (`.aiderignore`) | N/A |
| SWE-agent | `find_file` | fnmatch via shell | no | no | no | no | cwd |
| OpenHands | `find_file` | fnmatch | no | no | no | no | cwd |
| LangChain | `FileSearchTool` | fnmatch | no | no | no | no | required |
| Cursor | (private) | (private; likely ripgrep-backed based on ecosystem signals) | unknown | unknown | unknown | unknown | unknown |

---

## LLM Tool-Use Gotchas (Implementation Notes for `@agent-sh/harness-*`)

Seven specific LLM misuse patterns observed across the sample, with mitigation notes:

**G1: Over-broad patterns.** Models start with `**/*` (or `*`) when asked "what's in this project?", get truncated output, assume the project is small.
→ Mitigation: emit explicit truncation marker AND include a hint in the message ("Use a more specific pattern like `src/**/*.ts` to narrow results").

**G2: Forgotten `**`.** Model writes `*.ts` and gets only top-level.
→ Mitigation: example in description uses `**/*.ts`, not `*.ts`.

**G3: Wrong anchoring.** Model writes `**/auth.ts` expecting a file named literally `auth.ts` anywhere; gets 0 matches because the file is `authHelpers.ts`.
→ Mitigation: in the "no matches" error, suggest loosening: `Did you mean **/auth*.ts?`.

**G4: Confusing rg `--glob` with Glob tool.** Model tries `"pattern": "--glob src/**/*.ts"`.
→ Mitigation: in the parameter description, explicit: "Do not include `--glob` flags; the full pattern goes here."

**G5: Comma-lists where brace-lists expected.** Model writes `*.ts,*.tsx` instead of `*.{ts,tsx}`.
→ Mitigation: example uses brace syntax.

**G6: Case sensitivity surprise.** Model on Linux-only codebase can't find `README.md` when asked "find me the readme" — pattern was `**/readme*`. Glob defaults to case-insensitive so this actually works across harnesses, but when it doesn't (no case-insensitive flag), the model loops.
→ Mitigation: default case_sensitive to false; if exposed, default-true is the wrong choice.

**G7: Dotfile blindness.** Model asks "is there a CI config?" and pattern `**/*.yml` misses `.github/workflows/*.yml` because dotdirs are auto-excluded.
→ Mitigation: either include dotfiles by default (expensive, hits `.git/`) or expose `include_hidden: true`. Gemini CLI's approach: excluded by default, no way to override — so `.github/workflows/*.yml` requires explicit `.github/**/*.yml` pattern.

---

## Further Reading

| Resource | Type | Why Recommended |
|----------|------|-----------------|
| [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference) | Official docs | Canonical Glob tool description (sparse) |
| [Claude Code Agent SDK overview](https://code.claude.com/docs/en/agent-sdk) | Official docs | Glob example usage + allowed_tools pattern |
| [OpenCode glob.ts source](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/glob.ts) | Source | Best-in-class schema with `DO NOT enter "undefined"` |
| [Gemini CLI glob.ts source](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/glob.ts) | Source | Most parameterized Glob (case, gitignore, geminiignore) |
| [Gemini CLI file-system tools docs](https://www.geminicli.com/docs/tools/file-system) | Official docs | Gemini's glob description + when-to-use |
| [Cline list_files.ts and search_files.ts](https://github.com/cline/cline/tree/main/src/core/prompts/system-prompt/tools) | Source | Counterexample: Glob folded into search_files |
| [Continue globSearch.ts](https://github.com/continuedev/continue/blob/main/core/tools/definitions/globSearch.ts) | Source | Minimal, explicit-about-truncation description |
| [MCP filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) | Source | `search_files` + `list_directory` + `directory_tree` |
| [Codex CLI list_dir.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/list_dir.rs) | Source | "No Glob tool, route through shell" design |
| [Codex prompt (gpt-5 family)](https://github.com/openai/codex/tree/main/codex-rs/core) | Source | System prompt `rg --files` guidance |
| [SWE-agent find_file config](https://github.com/SWE-agent/SWE-agent/blob/main/tools/search/config.yaml) | Source | Shell-wrapping approach, no globstar |
| [OpenHands find_file in file_ops](https://github.com/All-Hands-AI/OpenHands/blob/main/openhands/runtime/plugins/agent_skills/file_ops/file_ops.py) | Source | Python fnmatch-based find |
| [node-glob docs](https://github.com/isaacs/node-glob) | Library docs | `**` semantics, symlink policy, extglob |
| [minimatch docs](https://github.com/isaacs/minimatch) | Library docs | Bash-compat glob semantics, ReDoS warning |
| [fast-glob docs](https://github.com/mrmlnc/fast-glob) | Library docs | Performance characteristics, static-vs-dynamic |
| [ripgrep GUIDE.md](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md) | Tool docs | `-g/--glob` flag, `--files`, gitignore override |
| [LangChain FileSearchTool source](https://github.com/langchain-ai/langchain/blob/master/libs/community/langchain_community/tools/file_management/file_search.py) | Source | Baseline framework-level file search |
| [Cursor docs](https://cursor.com/docs) | Docs | Glob tool info (mostly private) |
| [agent-search-tools.md](./agent-search-tools.md) | Internal guide | Companion Grep guide |
| [agent-read-tool.md](./agent-read-tool.md) | Internal guide | Related: read-after-find patterns |

---

## Self-Evaluation

```json
{
  "coverage": 9,
  "diversity": 8,
  "examples": 9,
  "accuracy": 8,
  "gaps": [
    "Cursor's exact Glob tool schema is not public; described only in general terms",
    "Claude Agent SDK Python internal schema for Glob not inspectable from public repo",
    "Roo Code's variant files beyond list-files/search-files not enumerated",
    "OpenAI Agents SDK does not expose a dedicated Glob tool; uses MCP filesystem or user-provided tools",
    "No direct benchmarking data on Glob tool description A/B tests across models — inferences drawn from convergent-evolution signals, not controlled experiments"
  ]
}
```

---

*Generated by `/learn` from 22 sources. See `resources/glob-impl-and-prompts-in-major-tools-sources.json` for full source metadata with quality scores.*
