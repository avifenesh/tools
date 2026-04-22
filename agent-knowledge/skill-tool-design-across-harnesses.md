# Learning Guide: Skill Tool Design Across AI Agent Harnesses

**Generated**: 2026-04-22
**Sources**: 40 resources analyzed
**Depth**: deep
**Scope**: The "Skill" primitive as shipped (and deliberately not shipped) across the 2026 agent-harness ecosystem. Concrete tool schemas, discovery, activation, invalidation, and the design question: **should `@agent-sh/harness-*` ship a typed `skill` tool?**

## What this guide is (and isn't)

This is a **tool-design audit for the Skill pattern**, parallel in shape to our `exec-tool-design-across-harnesses.md`, `webfetch-tool-design-across-harnesses.md`, and `lsp-tool-design-across-harnesses.md`. It answers:

- What exactly IS a Skill in each harness (tool call vs prompt injection vs file read)?
- What's the SKILL.md standard (from agentskills.io) vs per-harness extensions?
- Skill vs MCP vs subagent vs hook — where does the line actually hold?
- For autonomous-agent scenarios, what job does Skill do that a system prompt doesn't?
- Does it make sense to design a `skill` tool for `@agent-sh/harness-*`?

For the cross-harness tool surface matrix (who ships Skill at all), see `harness-tool-surface-audit.md`. For the architectural framing (harness vs SDK), see `ai-agent-harness-tooling.md`.

**Ground rule**: verified from 2026 source-of-truth docs. `agentskills.io` published its spec in late-2025, and the standard has been adopted — explicitly, not just name-aligned — by at least 35 agent products by Q2 2026.

## TL;DR — the six things you need to know

1. **Skill is a standard, not a Claude Code feature.** As of Oct 2025, `agentskills.io` is an open spec (originally Anthropic, now community-maintained) adopted by Claude Code, OpenCode, Gemini CLI, Cursor, Amp, Junie, OpenHands, Codex, Letta, Goose, Roo Code, Firebender, Kiro, Trae, fast-agent, Factory, Mux, Spring AI, Databricks Genie, Laravel Boost, GitHub Copilot, VS Code, and ~15 more. **This is already a settled primitive.**

2. **A "skill" is a folder, not a tool.** The spec: `skill-name/SKILL.md` with YAML frontmatter (`name`, `description` required; `license`, `compatibility`, `metadata`, `allowed-tools` optional). Optional `scripts/`, `references/`, `assets/` subdirs. The Markdown body after frontmatter is the instructions.

3. **Progressive disclosure is the core design.** Three tiers: **metadata** (~100 tokens per skill, always in system prompt) → **body** (~<5000 tokens, loaded on activation) → **bundled files** (effectively unbounded, loaded via Read/Bash on demand). This is how Skills fit 100+ installed skills into a 200k window without cost.

4. **"Skill" the TOOL is one of multiple activation patterns.** The spec explicitly says the model can activate via (a) a dedicated tool call (`Skill`, `skill`, `readSkill`, `activate-skill`), (b) a file-read via the existing Read tool, or (c) a slash-command intercepted by the harness. These are interchangeable from the model's POV — the harness picks.

5. **Skills solve the "autonomous behavior specialization" problem that system prompts can't.** System prompt is static, global, and paid-for on every turn. Skills are: (a) dynamically loaded, (b) user/project-authorable without harness redeploy, (c) composable (multiple active at once), (d) discoverable by the model via a catalog the user doesn't curate. That's the job.

6. **For autonomous coding, the verdict is: Skill is worth shipping, but NOT as a tool invocation — as a prompt-catalog + filesystem-read pattern.** The Claude Code–shaped `Skill` tool is one defensible design. The more common shape in 2026 is: harness scans a skill dir, injects a catalog section into the system prompt, and lets the model load content by calling Read on `SKILL.md`. Both work; the tool-call variant gains: (a) permission hook, (b) structured wrapping for context compaction, (c) bundled-file enumeration.

## Prerequisites

Before reading further you should know:

- What a tool-call / function-calling loop looks like (see `agent-tool-use-methods.md`).
- The Claude Code tool surface at a glance (see `harness-tool-surface-audit.md`).
- The distinction between harness (Claude Code, Codex, OpenCode, ...) and SDK (Claude Agent SDK, OpenAI Agents SDK) — see `ai-agent-harness-tooling.md`.
- Our autonomous-mode stance: no `ask` semantics, fail-closed without a hook (from `CLAUDE.md` Decision D11).

## 1. Anatomy of a Skill — the open standard

### 1.1 The SKILL.md file

Every skill is a folder with a `SKILL.md` at its root. The file has two parts:

```markdown
---
name: pdf-processing
description: Extract PDF text, fill forms, merge files. Use when handling PDFs.
license: Apache-2.0
compatibility: Requires Python 3.10+ and pdfplumber
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(git:*) Bash(jq:*) Read
---

# PDF Processing

When the user asks about PDF files...
```

**Required frontmatter (from the spec, §agentskills.io/specification):**

| Field | Constraint |
|---|---|
| `name` | 1-64 chars, `[a-z0-9]+(-[a-z0-9]+)*`. Must match the parent directory name. No leading/trailing hyphen, no double hyphens. |
| `description` | 1-1024 chars. What the skill does AND when to use it. |

**Optional frontmatter (spec):**

| Field | Purpose |
|---|---|
| `license` | License identifier or bundled filename. |
| `compatibility` | 1-500 chars. Environment requirements (intended product, system packages, network access). |
| `metadata` | Arbitrary key/value map. Clients use for additional properties. |
| `allowed-tools` | Space-separated pre-approved tools. **Experimental.** |

**Claude Code's extensions (non-standard but widely copied):**

| Field | Purpose |
|---|---|
| `disable-model-invocation: true` | Only the user can `/name` invoke it. Removes the skill from the model's catalog entirely. |
| `user-invocable: false` | Only the model can invoke it. Hidden from the `/` menu. |
| `argument-hint` | Autocomplete hint like `[issue-number]`. |
| `arguments` | Named positional args for `$name` substitution. |
| `context: fork` | Run the skill in an isolated subagent context. |
| `agent: Explore \| Plan \| general-purpose \| <custom>` | Which subagent type to use when `context: fork`. |
| `hooks` | Skill-scoped PreToolUse / PostToolUse hooks. |
| `model` | Override the model for the rest of the turn (`sonnet`, `opus`, `haiku`, `inherit`). |
| `effort` | Effort level override (`low`, `medium`, `high`, `xhigh`, `max`). |
| `paths` | Glob patterns that gate auto-activation ("only load when editing `**/*.py`"). |
| `shell` | `bash` or `powershell` for `` !`<command>` `` blocks. |
| `when_to_use` | Additional trigger text; appended to description (1,536-char total cap). |

### 1.2 The directory layout

```
skill-name/
├── SKILL.md         # required
├── scripts/         # optional — executables; run via Bash, NOT loaded as text
├── references/      # optional — markdown docs; Read on demand
└── assets/          # optional — templates, images; used in output
```

`scripts/` is the key efficiency feature: a script can implement deterministic operations without its code ever entering the context window. The model calls `Bash(python scripts/validate.py ...)` and sees only the output.

### 1.3 Progressive disclosure — the three-tier loading model

The spec defines exactly three tiers (verbatim from §agentskills.io):

| Tier | What loads | When | Cost |
|---|---|---|---|
| 1. Catalog | `name` + `description` | Session start | ~50-100 tokens per skill |
| 2. Instructions | Full `SKILL.md` body | On activation | <5000 tokens recommended |
| 3. Resources | `scripts/`, `references/`, `assets/` | When the body references them | Unbounded (filesystem) |

This tiering is what makes the "install 100 skills" pitch work. You pay catalog cost for everything, body cost only for what's active, and resource cost only for what's read.

**Behavioral constraint: once loaded, skill content stays.** Claude Code documents this explicitly: "When you or Claude invoke a skill, the rendered `SKILL.md` content enters the conversation as a single message and stays there for the rest of the session. Claude Code does not re-read the skill file on later turns." Skills don't refresh mid-session unless re-invoked.

## 2. Activation shapes across harnesses — four patterns

The spec's "Adding skills support" guide explicitly enumerates these four activation patterns. Every harness picks one or more.

### Pattern A: Dedicated tool call (`Skill` / `skill` / `activate-skill` / `readSkill`)

The harness registers a tool whose input is a skill name (usually an enum of installed skills). When the model calls it, the harness looks up the skill, expands the body, and returns it as the tool result.

Adopters and their tools:

| Harness | Tool name | Schema | Return shape |
|---|---|---|---|
| **Claude Code** | `Skill` | Input: skill slug, with `$ARGUMENTS` passing. Yes permission-required. | Rendered SKILL.md injected into conversation as one message. |
| **OpenCode** | `skill` | Input: `{ name: string }`. `skill.ts` in `packages/opencode/src/tool/skill.ts`. | Trimmed body + base dir URL + up to 10 sampled files in the skill dir, excluding SKILL.md. Permission-checked. |
| **Gemini CLI** | `activate-skill` | Input: `{ name: string }` where `name` is dynamically constrained to installed-skill enum via `getActivateSkillDefinition(skillNames)`. | `llmContent`: `<activated_skill>` XML with body and resources. Errors list available skills. |
| **Continue.dev** | `readSkill` | Input: `{ skillName: string }`. `readSkill.ts` in `core/tools/definitions/`. Dynamic enumeration in description. | Markdown content, with `{{{ skillName }}}` templating for user-facing messages. |

**Pros of the tool-call shape:**
- Permission hook intercepts every activation.
- Result can be structurally wrapped (`<skill_content name="...">`) so compaction can preserve it.
- Bundled-file enumeration surfaced without eager reads.
- Natural catalog placement in tool description (rather than bloating the system prompt).
- Deduplicable: the harness can detect "this skill's already loaded in context" and no-op.

**Cons:**
- Adds a tool to the surface (contributes to tool-count pressure — see `agent-tool-use-methods.md` §tool-count limits).
- Models may hallucinate skill names if the enum isn't dynamically generated.

### Pattern B: File-read activation (existing Read tool + skill catalog in system prompt)

The harness injects a `<available_skills>` block into the system prompt with `{name, description, location}` for each skill. The model calls Read (or cat via Bash) on the SKILL.md path. No dedicated tool.

Adopters:

| Harness | Mechanism |
|---|---|
| **Anthropic API (platform)** | Skills run in the code-execution VM. The system prompt has the catalog; Claude calls `bash: read pdf-skill/SKILL.md` to load. No `Skill` tool at the API level — it's a filesystem pattern. |
| **Codex CLI** | `core-skills` crate builds an `AvailableSkills` catalog, injects into system prompt. No dedicated tool. Explicit `/skills` user command, `$skill-name` mention syntax. `detect_implicit_skill_invocation_for_command()` pattern-matches shell history. |
| **Amp** | "Amp doesn't ship a dedicated Skill tool. Instead, skills integrate transparently: their names and descriptions remain visible to the model, but the full `SKILL.md` content loads only when invoked." |
| **OpenHands** | File-based; "always-on" context or "keyword-triggered" or "agent-invoked." No dedicated tool. |
| **Goose** | Context-engineering skills; prompt injection. |
| **Junie** | Auto-invoked, not a tool call. Scans `.junie/skills/` and matches by description. |

**Pros of the file-read shape:**
- No additional tool surface. The model uses the Read tool it already has.
- Portable: any harness with Read can "support skills" without re-plumbing.
- Spec-endorsed: agentskills.io explicitly allows this. "If the model has file-reading capabilities, it can read `SKILL.md` files directly."

**Cons:**
- No natural place to hook permission without intercepting Read.
- Catalog lives in system prompt → occupies baseline context.
- Harder to flag-protect from compaction (the loaded SKILL.md is just a tool_result indistinguishable from other reads).
- No bundled-file enumeration unless the harness does extra work.

### Pattern C: System-prompt injection (no tool, no Read — catalog IS the skill)

This is what Amp-style and some earlier implementations do: the skill description alone is in the system prompt; the model is trained to follow it when relevant without "loading" anything separate. This is really "using frontmatter as a system-prompt supplement" and doesn't use progressive disclosure.

Adopters: rare and controversial. Most implementations use Pattern B or A with a Pattern C fallback for skills so small the body fits in the description.

### Pattern D: Slash command / mention syntax (user-explicit, harness-intercepted)

`/skill-name` (Claude Code, Cursor, OpenCode, Codex) or `$skill-name` (Codex) or `@skill-name`: the harness parses these out of the user's message, expands the skill content into the conversation, and the model never makes a tool call. This is **user-driven activation**; every harness that ships skills also ships this because users want deterministic manual triggering.

Most harnesses ship some combination:

| Harness | Pattern A | Pattern B | Pattern D |
|---|:-:|:-:|:-:|
| Claude Code | Y (`Skill`) | | Y (`/name`) |
| OpenCode | Y (`skill`) | | Y (`/name`) |
| Gemini CLI | Y (`activate-skill`) | | Y |
| Continue | Y (`readSkill`) | | Y |
| Codex CLI | | Y | Y (`$name`, `/skills`) |
| Amp | | Y (catalog-only) | |
| OpenHands | | Y | Y |
| Anthropic API | | Y (bash cat) | |

## 3. The tool schemas — side by side

### 3.1 Claude Code `Skill`

Listed in the 2026 tool reference with permission **Yes** required. It "executes a skill within the main conversation." Invocation can happen three ways:

1. Model auto-invokes from the description match.
2. User types `/skill-name [args]`.
3. Subagent is launched with `skills: [name]` preload (skill content injected at startup, not made invokable).

Permission syntax (in `/permissions`):
- `Skill` — globally deny the tool.
- `Skill(name)` — deny specific skill by name.
- `Skill(name *)` — prefix match with any arguments.

Notable: **Claude Code's Skill tool is gated by permission** (column "Yes" in the tools-reference table). This is unusual among the Skill-tool harnesses — most just check a permission on the underlying activities (Read, Bash).

### 3.2 OpenCode `skill`

Source: `packages/opencode/src/tool/skill.ts`. Input schema:

```typescript
{
  name: string // must match one of available_skills
}
```

Implementation flow (from source analysis):
1. Call `Skill.Service` to look up the skill by name. Throw if not found, listing all installed skills.
2. Request user permission via a `skill` permission type with the skill name as a pattern.
3. Use Ripgrep to discover up to 10 files in the skill dir (excluding `SKILL.md`) → converted to file URLs.
4. Return: trimmed body, base directory URL, sampled relative files, metadata.

Permission config in `opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "skill": "allow" | "deny" | "ask"
  }
}
```

### 3.3 Gemini CLI `activate-skill`

Source: `packages/core/src/tools/activate-skill.ts`. Input type:

```typescript
interface ActivateSkillToolParams {
  name: string;
}
```

Schema generated dynamically: `getActivateSkillDefinition(skillNames)` builds a JSON Schema constraining `name` to the enum of installed-skill names. Classic anti-hallucination pattern.

Returns `ToolResult`:
```typescript
{
  llmContent: string;   // <activated_skill>...</activated_skill> XML
  returnDisplay: string; // human UI
  error?: { message, type: ToolErrorType };
}
```

### 3.4 Continue.dev `readSkill`

Source: `core/tools/definitions/readSkill.ts`. Input:

```typescript
{ skillName: string }
```

Properties:
- `displayTitle`: "Read Skill"
- `readonly`: true
- `isInstant`: true

Description is dynamically generated to list all available skills with their names and descriptions. Implementation: `loadMarkdownSkills(params.ide)` loads the skills, description string is templated with them, and the tool returns markdown content.

### 3.5 Codex core-skills crate (Rust)

Not a tool — a skills catalog builder. Public API from `codex-rs/core-skills/src/lib.rs`:

- Types: `SkillMetadata`, `SkillPolicy`, `SkillError`, `SkillLoadOutcome`, `AvailableSkills`, `SkillMetadataBudget`, `SkillDependencyInfo`.
- Functions: `detect_implicit_skill_invocation_for_command()`, `build_skill_name_counts()`, `build_available_skills()`.
- Modules: `loader`, `manager`, `model`, `render`, `injection`, `config_rules`, `remote`.

This confirms Codex's choice: system-prompt injection of the catalog + pattern-based command detection, **no tool call**.

## 4. Discovery — where harnesses look for skills

The spec leaves "where" under-defined on purpose; the "Adding skills support" guide documents the de-facto conventions. The universal pattern is: scan `<scope>/<.harness-name>/skills/` plus `<scope>/.agents/skills/` (cross-harness convention) plus sometimes `<scope>/.claude/skills/` (pragmatic compatibility because so many skills live there).

| Harness | Discovery order (project → user → …) |
|---|---|
| Claude Code | (1) enterprise managed, (2) `~/.claude/skills/`, (3) `.claude/skills/`, (4) plugin `skills/`. Nested `.claude/skills/` in monorepo packages auto-discovered. Live change detection via filesystem watch. |
| OpenCode | Project: `.opencode/skills/`, `.claude/skills/`, `.agents/skills/`. Global: `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/`. Walks up to git worktree root. |
| Cursor | `.cursor/skills/`, `.agents/skills/`, `~/.cursor/skills/`, `~/.agents/skills/`, + legacy `.claude/` and `.codex/` as fallback. |
| Amp | `~/.config/agents/skills/`, `~/.config/amp/skills/`, `.agents/skills/`, `.claude/skills/`, `~/.claude/skills/`, plugins, toolbox, built-in. First-wins precedence. |
| Codex CLI | Global `$CODEX_HOME/skills/` (default `~/.codex/skills/`), project `.agents/skills/`, `.codex/skills/`. `.system/` subfolder is pre-installed. |
| Gemini CLI | Per-CLI convention; adopts agentskills.io spec. |
| Junie | `.junie/skills/` project-level, `~/.junie/skills/` user-level. |
| OpenHands | `.agents/skills/`, deprecated `.openhands/skills/`, `.openhands/microagents/`, `~/.agents/skills/`. Community registry on GitHub. |
| Roo Code | `~/.roo/skills/`, `.roo/skills/`, mode-specific `skills-{mode}/`. `.roo/` overrides `.agents/` at same scope. |
| Letta | `~/.letta/skills/` + agent-scoped `~/.letta/agents/{id}/skills/` + project scope. |
| Amp & Kiro & Factory & Firebender | Documented variants of the above. |

**Takeaway**: `.agents/skills/` is the de-facto cross-client interoperability directory. `.claude/skills/` is the "legacy fallback most harnesses pragmatically support." If you're writing a harness in 2026, scanning both is the expectation.

### Collision handling

Universal convention (spec-endorsed): **project-level skills override user-level skills.** Log a warning on collision. Some harnesses add enterprise-managed > personal > project > plugin (Claude Code). Plugin skills use `plugin-name:skill-name` namespacing (Claude Code) to sidestep collisions entirely.

### Trust considerations

The spec calls this out: project-level skills come from the repo, which may be untrusted. Recommendation: gate project-level skill loading on "user trusts this directory" (the same gate most editors use for workspace trust).

## 5. Lifecycle — the five phases

The "Adding skills support" guide gives a 5-phase model. It's useful for our design.

1. **Discover** — scan skill directories at session start. Cache skill metadata keyed by name.
2. **Parse** — extract YAML frontmatter, validate frontmatter, store body (or defer body read to activation).
3. **Disclose** — build the catalog (name, description, location) and put it in the system prompt or tool description.
4. **Activate** — on model's decision or user's `/name`: deliver the body into the conversation. If Pattern A, return from a tool call; if Pattern B, the model calls Read on the path.
5. **Manage over time** — protect skill content from compaction, dedupe re-invocations, optionally run skills in forked subagent context.

### Invalidation

Three invalidation modes observed:

- **Session-scoped (default).** Once a skill's body is in context, it stays until session end. Claude Code explicitly doesn't re-read between turns. Re-invoking replaces with a fresh load.
- **Live-change detection.** Claude Code watches skill dirs; new/edited skills are picked up mid-session without restart (for existing top-level dirs). Creating a brand-new skills dir requires session restart.
- **Auto-compaction carryforward.** After /compact, Claude Code re-attaches the most recent invocation of each invoked skill after the summary, keeping the first 5k tokens per skill, with a total budget of 25k for all re-attached skills. **Older skills can be dropped** if you invoked many.

### Content permanence vs refresh

Claude Code's docs are explicit: "If a skill seems to stop influencing behavior after the first response, the content is usually still present and the model is choosing other tools or approaches." The fix is to strengthen the description, **not** to re-invoke. Or use hooks to enforce behavior deterministically.

## 6. Skill vs MCP vs subagent vs hook — the four-way distinction

This is the "survives design review" answer. Each primitive has a different job:

| Primitive | Owns | When to use | Loaded when |
|---|---|---|---|
| **Skill** | Instructions (prose + optional scripts) for the MODEL to follow. | Encode a workflow, playbook, style guide, or checklist. | On activation, into the main context. |
| **MCP server** | Tools the MODEL calls (functions with schemas). | Expose a capability that needs code: DB query, GitHub API, custom tool. | Server up at session start; tool schemas always in context (unless deferred via ToolSearch). |
| **Subagent** | A whole agent loop (own system prompt, own tools, own context) that your MAIN agent dispatches to. | Isolate heavy exploration or specialization from main conversation context. | Spawned on demand, returns a summary. |
| **Hook** | Deterministic code that runs around tool calls (PreToolUse/PostToolUse/SessionStart). | Enforce invariants the model can't be trusted to enforce (security, observability). | Fires on event; no model involvement. |

### Concrete boundary tests

- "Format commit messages consistently" → **Skill**. Prose guidance for the model.
- "Call our internal billing API" → **MCP**. Code that exposes a typed function.
- "Explore the repo without flooding my context" → **Subagent** (Claude Code's `Explore`). The subagent reads 20 files and returns a 200-token summary.
- "Block edits to `.env`" → **Hook**. PreToolUse validates the Edit's path and returns deny.
- "Run tests automatically after every Edit" → **Hook**. PostToolUse.
- "Onboard a new team member to our API conventions" → **Skill** (the skill body becomes the onboarding). If it needs a script, bundle one in `scripts/`.
- "Talk to our JIRA" → **MCP**. (Not a skill: no way to expose the typed tool surface.)

### Overlaps and the "why not just X?" arguments

- **"Why not just put it in the system prompt?"** Because the system prompt is (a) paid on every turn, (b) global (applies to every task), (c) maintained by the harness author, not the user. Skills are (a) loaded on demand, (b) per-task, (c) author-editable. This is the core argument in Anthropic's Oct 16 2025 announcement and in Simon Willison's "Claude Skills are awesome, maybe a bigger deal than MCP" post.

- **"Why not just put it in CLAUDE.md?"** CLAUDE.md is the same category as system prompt — always-in-context. Skills are the missing "load on demand" tier between "never in context" and "always in context." Claude Code's docs explicitly call this out: "Unlike CLAUDE.md content, a skill's body loads only when it's used, so long reference material costs almost nothing until you need it."

- **"Why not just a subagent?"** Subagent is heavier: separate context, separate model turn, summarization back. Great for bounded subtasks; wrong tool for "apply this style guide to my current turn." Skill keeps the model in the same context with richer instructions.

- **"Why not just an MCP server?"** MCP tool schemas consume context continuously (as Simon Willison documents: GitHub's MCP is tens of thousands of tokens). Skills are ~100 tokens each until activated. MCP is for capabilities (typed functions); skills are for instructions (natural language). They compose — a skill can say "call the `BigQuery:bigquery_schema` MCP tool, then ..."

## 7. Autonomous-agent scenarios — what skills actually solve

The user's framing: "ask is relevant for non-autonomous; skill might be relevant for autonomous — let's research it." The research confirms this is correct and specific.

### Why Skill is autonomous-aligned

Five reasons:

1. **No human-in-the-loop required.** The model activates skills itself based on the catalog. No pause, no dialog, no structured-question round-trip like AskUserQuestion.

2. **Domain specialization without harness rebuild.** A user or a deployment operator can drop a new skill folder without redeploying the agent. Autonomous agents running in CI or cron don't have humans to configure them at startup; skills let the ops layer specialize them per-job.

3. **Context efficiency for long-running agents.** An agent running for 50+ turns with compaction benefits hugely from progressive disclosure. Loading only what's relevant per task = fewer re-summarizations = less context drift.

4. **Composable workflows.** "Deploy to staging" might need skill-A (testing conventions) + skill-B (k8s patterns) + skill-C (notification etiquette). Composition is native — the model chains activations. This is what Anthropic's Oct 2025 post means by "composable specialization."

5. **Deterministic reinforcement via bundled scripts.** For autonomous agents, bundling a `scripts/validate.py` in the skill gives a deterministic check that the model MUST pass before proceeding. The skill body says "run this script, then decide based on output." This is `ai-agent-harness-tooling.md` §reinforcement at the skill layer.

### What skills are NOT great for in autonomous scenarios

- **Dynamic runtime config.** Skills are read from disk; if your autonomous agent needs config passed at job-launch time, that's environment variables or a config file read, not a skill.
- **Tool capability exposure.** Typed function-calling surfaces belong in MCP, not a skill.
- **Secrets / credentials.** Don't put them in a skill; skills are designed to be committed.
- **Per-turn adaptation.** Skills are session-loaded. They don't re-evaluate per turn.

### Concrete autonomous-agent skill examples

What do skills look like for autonomous coding specifically (not generic)?

- `code-review` — "When the user asks for a review, check: (a) error handling, (b) input validation, (c) tests. Use the bundled `scripts/check-coverage.sh` to verify coverage hit the 80% threshold."
- `migrate-to-typescript` — multi-step workflow in the body; bundled `scripts/ts-audit.py` for deterministic checks.
- `api-conventions` — "All endpoints MUST use RESTful naming. All errors MUST use the shared error schema. See `references/error-schema.json`."
- `pre-commit-fixer` — workflow for cleaning up a commit (format, lint, conventional-commits message). Bundled `scripts/stage-and-format.sh`.
- `onboarding-context` — "This project uses X framework version Y. Entry points are A, B, C. Auth flow in D. Testing strategy in E." Replaces 2000 tokens of CLAUDE.md that was only needed half the time.

Each of these would bloat CLAUDE.md if always-in-context, bloat tool schemas if done as MCP, and be overkill as a subagent. Skills fit exactly.

## 8. What Claude Code, OpenCode, and Codex do differently

Three detailed comparison points. All three ship the spec, but differ at the edges.

### 8.1 Tool-call vs catalog-injection

| Harness | Shape | Catalog location |
|---|---|---|
| Claude Code | `Skill` tool (Pattern A) + `/slash` (Pattern D) | Tool descriptions dynamically generated with skills; system prompt also has a trimmed listing (~8k char default budget, scaling to 1% of context window). |
| OpenCode | `skill` tool (Pattern A) + `/slash` (Pattern D) | System prompt has skills listing; tool descr is a pointer. |
| Codex | NO tool (Pattern B) + `$name` (Pattern D) + `/skills` | System prompt has the catalog; model uses Bash-with-cat to read the body. `injection` module in `core-skills` handles the catalog-to-prompt wiring. |

### 8.2 Argument passing

- **Claude Code**: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name` (named args from `arguments` frontmatter), and `${CLAUDE_SKILL_DIR}` for resolving relative paths regardless of cwd. Also `!`<bash>`` for dynamic context injection (preprocessing before the model sees the skill).
- **OpenCode**: args passed through, skill body includes them.
- **Codex**: pattern-matched from the command.

The Claude Code feature set here is richest — they treat a skill as a templated prompt with shell preprocessing. OpenCode is simpler. Codex is the simplest.

### 8.3 Subagent fork — running skills in isolation

Only Claude Code ships this explicitly: `context: fork` + `agent: Explore|Plan|general-purpose|<custom>` frontmatter.

What it does: instead of loading the skill body into the main conversation, spawn a subagent. The skill body becomes the subagent's initial prompt. The `agent` field picks which subagent definition to use (determines model, allowed tools). On return, only the subagent's final summary comes back into the main context.

Why it matters: "Research this repo for X" is a huge context burn. Running it as a forked skill means the main context never sees the 20 Read results — just the synthesis.

This is a case where Skill composes with Subagent. They're not alternatives, they're orthogonal.

## 9. Who hasn't shipped it, and why

The interesting data point: **Cline does not ship Skill tooling.** The Cline docs discuss Plan/Act modes extensively, `.clinerules` files (still a system-prompt mechanism), `@url` context providers, and `@mentions`. They do NOT implement the Agent Skills standard as of Q1 2026.

Other non-shippers (or deferred shippers):

- **Aider** — no function calling at all, so skills would be a fundamentally different primitive. Aider's `/add`, `/architect`, etc. are the slash-command activation (Pattern D) without the catalog.
- **SWE-agent / OpenDevin** — these are benchmark-focused harnesses; skills are not in the ACI surface.
- **Early LangChain / CrewAI** — system-prompt and toolkit-based; skills don't fit the framework-style abstraction well without wrapping.

**What do they do instead?**

- **Cline**: `.clinerules` (project-level) as system-prompt supplements, Plan mode as an operational split, `@url` / `@file` context providers as Pattern-B-ish "load this on demand but only user-driven."
- **Aider**: slash commands (`/add`, `/architect`), `CONVENTIONS.md` loaded as system prompt, `/run` and `/test` as deterministic verification.
- **Cursor**: rules in `.cursor/rules/` (the old system) → migrating to skills via a `/migrate-to-skills` command.
- **Roo Code**: Mode-scoped rules (architect, code, debug modes) with mode-specific skill dirs (`skills-code/`, etc.). This is Skill-plus-Mode as a combined primitive.

**Is Skill actually better than "put it in the system prompt"?** The evidence argues yes, with three mechanisms: (1) ~100 tokens per skill catalog vs full-body cost, (2) user-authorable without harness redeploy, (3) composable activation. Anthropic's internal evaluations (per the Oct 2025 announcement) show skills "unlock substantial capabilities" without the MCP token cost. Simon Willison's "maybe a bigger deal than MCP" echoes this with concrete numbers: MCP GitHub alone = "tens of thousands of tokens", skills = "few dozen extra tokens per skill." For autonomous use-cases, the math is especially compelling.

## 10. Design recommendation for `@agent-sh/harness-*`

Given: we ship Read, Write, Edit, Grep, Glob. We're planning Bash, WebFetch, AskUserQuestion, LSP as next. Our posture: **autonomous mode, no `ask`, fail-closed without a hook** (CLAUDE.md Decision D11), tool-library not harness (we don't own the loop).

### 10.1 Is it worth building?

**Yes**, with caveats:

- Universality: 35+ adopters, stabilizing as an ecosystem standard.
- Autonomous alignment: direct — the user's framing is correct.
- Spec maturity: agentskills.io/specification is stable; SKILL.md format is a contract.
- Training signal: Claude models explicitly trained for it; Qwen/Gemma/GPT all understand the pattern through the catalog.

**But**: Skill is *partially* a harness concern. A tool library can ship the activation tool and the catalog formatter — but the discovery, permission, and compaction behaviors are harness-level. Our job is to provide the primitives, not the lifecycle.

### 10.2 The shape I'd ship

A **stateful tool, stateless-from-the-outside**: we provide a `Skill` (or `skill`) tool that loads a skill body given a name. Discovery and catalog building are harness responsibilities; we expose typed APIs for them.

**Tool input (candidate spec):**

```typescript
{
  name: string;       // required; constrained to enum of available skills
  arguments?: string; // optional; passed through as $ARGUMENTS
}
```

**Tool output (discriminated union, same pattern as Bash/WebFetch/LSP specs):**

```typescript
  kind: "ok" | "not_found" | "permission_denied" | "outside_workspace" 
      | "disabled" | "invalid_frontmatter" | "error"

  // On ok:
  body: string;               // SKILL.md body (frontmatter stripped by default)
  skill_dir: string;          // absolute path, for resolving relative refs
  resources?: string[];       // up to 10 bundled files (excluding SKILL.md)
  metadata?: Record<string, string>;  // frontmatter.metadata passthrough

  // On error:
  code: string;
  hint?: string;
  available?: string[];       // list of valid skill names on not_found
```

This mirrors OpenCode's shape and extends it with our discriminated-union error convention from LSP/WebFetch.

### 10.3 Discovery — pluggable, NOT built-in

Following the `SandboxAdapter` / `LspClient` pattern from our other tools, define:

```typescript
interface SkillRegistry {
  // Called by the harness to populate the catalog
  listSkills(): Promise<SkillMetadata[]>;
  
  // Called by our tool when the model activates a skill
  loadSkill(name: string): Promise<LoadedSkill | NotFound>;
  
  // Optional: pre-load skill content for hot paths
  warmSkill?(name: string): Promise<void>;
}

interface SkillMetadata {
  name: string;
  description: string;
  location: string;           // absolute path to SKILL.md
  frontmatter: Record<string, unknown>;
}

interface LoadedSkill {
  body: string;               // frontmatter-stripped body
  skillDir: string;
  resources: string[];
}
```

We ship:
- `@agent-sh/harness-skill` — the tool + `FilesystemSkillRegistry` (scans `.agents/skills/`, `.claude/skills/`, configurable extras).
- `@agent-sh/harness-skill-mcp` — adapter that proxies to an MCP skills server (future).
- `@agent-sh/harness-skill-stub` — in-memory registry for unit tests.

Discovery *details* (glob patterns, precedence, caching) live in the registry, not our tool. This keeps the tool tight.

### 10.4 Permission model

Autonomous — no `ask`. Extends the hook contract from `CLAUDE.md` Decision D11:

```typescript
hook({
  tool: "skill",
  action: "activate",
  skill: name,
  skill_dir: skillDir,
  always_patterns: [`Skill(${name}:*)`, `Skill`],
  metadata: { frontmatter: loadedSkill.frontmatter }
}) → "allow" | "allow_once" | "deny"
```

Fail-closed if no hook AND `session.permissions.unsafeAllowSkillWithoutHook !== true` → `permission_denied`.

Why gate activation specifically (not just the downstream Read/Bash): skills carry `allowed-tools` frontmatter that pre-approves tool usage while active. Activating a skill can silently bypass downstream permission gates. The hook must evaluate the skill-as-package.

### 10.5 Catalog building — library function, not tool

We expose a pure function for the harness to call:

```typescript
function buildSkillCatalog(
  registry: SkillRegistry,
  options?: { budget?: number; format?: "xml" | "json" | "markdown" }
): Promise<string>;
```

The harness decides whether to put this in system prompt (Pattern B) or tool description (Pattern A). Both work with our tool.

### 10.6 Open questions (v1.1 roadmap material)

- **Subagent fork** (`context: fork` + `agent: X`). Useful but requires us to own subagent semantics, which we currently don't. Defer until we have a subagent primitive.
- **Dynamic shell injection** (`` !`<cmd>` `` in the body). Claude Code's killer feature; needs our Bash tool shipped first. Also a security surface — the body can `rm -rf /` if misused. Defer.
- **Live-change detection.** Filesystem watcher on the registry. Nice but not load-bearing for v1.
- **Namespacing** (`plugin:skill`). Claude Code's namespace convention. Useful for the MCP adapter story.
- **`paths` frontmatter** (auto-activation gated on file globs). Interesting, but requires integration with the harness's file-context awareness. Defer.
- **`disable-model-invocation` / `user-invocable`**. These are harness-level decisions; our tool either exposes a skill or doesn't. The registry can filter.

### 10.7 Why ship it NOW vs defer

**Argue for ship in v1.x** (with Bash):
- The catalog injection pattern works with zero Skill tool — we could just document "use Read on SKILL.md." But autonomous users will ask for permission gating and compaction-safe wrapping almost immediately.
- `allowed-tools` frontmatter is an interesting feature: a skill can declare "I need Bash(git:*)" and we could pre-approve those tools only while the skill is active. This composes nicely with our per-tool permission hooks.
- Competitive pressure: OpenCode, Gemini CLI, Continue all ship skill tools. A TS-first library without one misses the 2026 conversation.

**Argue for defer to v1.x+N:**
- Skills are partially a harness concern, not a library concern.
- Our 4 shipped tools + Bash + WebFetch + Ask + LSP is a lot of ground to cover. Skills have lower per-tool urgency than LSP.
- The Pattern B shape (catalog-in-system-prompt + Read tool) works with our current surface. We could ship a `buildSkillCatalog` helper and defer the tool.

**Recommendation**: ship a minimal `skill` tool in v1.x **after** Bash (because allowed-tools frontmatter composes), explicitly scoped to Pattern A, with the registry as a pluggable adapter. Don't implement discovery in the library — provide the interface and a default `FilesystemSkillRegistry`, and let the harness choose what to scan. Skip subagent-fork, shell injection, paths gating for v1.

### 10.8 The hardest design questions

1. **How should we name it?** `skill` (OpenCode), `Skill` (Claude Code), `readSkill` (Continue), `activate-skill` (Gemini). Ecosystem-wise, `Skill` has the most training signal; `skill` matches our lowercase convention consideration from other tools. Either defensible; lean `Skill` for training signal, per the naming guidance in `harness-tool-surface-audit.md`.

2. **Should the tool return raw frontmatter or stripped body?** Spec says either is fine. Most implementations strip. We should strip by default and expose frontmatter via metadata. Less model-facing noise.

3. **How to handle `allowed-tools`?** The cleanest option: when a skill with `allowed-tools` is active, the hook gets a session flag that pre-approves those patterns ONLY for the duration of that skill's activation. Implementation is in the hook layer, not the tool. The tool just returns the skill's `allowed-tools` in metadata.

4. **How to stop runaway activations?** Some harnesses limit "skills activated in one turn" (since re-activating a skill mid-turn is wasteful). We could track session-scoped activations and dedupe.

5. **What does `error.available` look like with 100 skills?** Not all. Top-10 by name similarity to the requested name (Levenshtein). This is the "did you mean X?" pattern from our other tools.

6. **Should the tool itself appear in the description of `allowed-tools`?** Meta: a skill whose `allowed-tools: Skill` would allow recursive skill-of-skill. Circular reference potential. Block by default.

## 11. Common pitfalls when designing a Skill tool

| Pitfall | Why it happens | How to avoid |
|---|---|---|
| Treating Skill as MCP. | They look similar: "declare something in a directory, model uses it." | Skill is a prompt/data package; MCP is a typed function surface. Keep them separate. |
| Shipping Skill without progressive disclosure. | Easy to just inject all skills into the system prompt. | Honor the three-tier model. Catalog in prompt, body on activation, resources on demand. |
| Hallucinated skill names. | If `name` is a free-string param, the model invents. | Constrain to enum dynamically (Gemini pattern). Alternatively, return a discriminated error with fuzzy siblings. |
| Skill content loss on compaction. | Tool results look the same regardless of source; compactor prunes indiscriminately. | Wrap skill content in identifying tags (`<activated_skill>`) and flag those messages as protected. |
| Overloading the skill system for state. | "Put the user's preferences in a skill." | Skills are read-only at runtime. Use filesystem/config/session state for mutable data. |
| Activating skills too aggressively. | Poor description discipline = model loads 5 skills per turn. | Strong description writing; `disable-model-invocation` for side-effect skills. |
| Unrestricted shell injection in the body. | `` !`<cmd>` `` runs before the model sees it → user's skill body can arbitrary-exec. | Disable-by-default (Claude Code's `disableSkillShellExecution: true`), require explicit opt-in. |
| Trusting project-level skills unconditionally. | Fresh-cloned repo ships with a malicious skill that tells the model to exfiltrate secrets. | Trust-gate project skills. Only load if the user has marked the project as trusted. |
| Per-session staleness. | Skill content is pinned once loaded; doesn't update on body re-read. | Explicit re-activation, or stronger: live-change detection for in-session updates. |
| Skill-as-escape-hatch for tool restrictions. | `allowed-tools: Bash(*)` in a skill silently grants unrestricted shell. | Audit this at hook time. Skill allow-lists compose, not override, the session permission model. |
| Double-activation / duplicate content in context. | Model or user activates the same skill twice; the SKILL.md ends up in context twice. | Dedupe activations per-session; return a `{kind: "already_loaded"}` or no-op. |
| Subagent preload confusion. | `skills: [foo]` in a subagent frontmatter vs `context: fork` in a skill — two directions of the same composition. | Document the matrix (see Claude Code's skills-and-subagents section). |

## 12. Best practices synthesized from 40 sources

1. **Honor the spec.** `agentskills.io` is the contract for portable skills. Required fields (`name`, `description`) are non-negotiable; don't invent new required fields. Optional extensions (`disable-model-invocation`, `paths`, `hooks`) are client-specific and should NOT be required for spec-compliant skills.

2. **Scan both `.<harness>/skills/` and `.agents/skills/`.** Cross-client interop demands it. For Claude-lineage compatibility, fall back to `.claude/skills/` too.

3. **Catalog is per-session, body is per-activation, resources are per-reference.** This is the three-tier loading model; violating it (loading bodies eagerly, loading resources at discovery) destroys the efficiency argument.

4. **Treat the body like standing instructions.** It's there for the whole session; don't write one-shot procedural steps. Write behaviors Claude should follow for the remainder of the session.

5. **Invalidate on re-activation, not automatically.** The body stays loaded; changing the file doesn't re-load. Re-activation does.

6. **Permission-check at activation, not at each downstream tool.** Once a skill is active, its `allowed-tools` pre-approves those patterns for the duration. This is ergonomic but requires careful hook design.

7. **Wrap skill content in identifying tags for compaction survival.** `<activated_skill>` (Gemini) / `<skill_content>` (Claude Code) / custom. This is load-bearing for multi-turn agents.

8. **Dedupe per session.** If the model activates the same skill twice, no-op the second.

9. **Don't auto-install language-server-style dependencies.** Same principle as LSP spec: if a skill needs `pdfplumber`, document it in `compatibility`, don't install it. Build reproducibility matters.

10. **Name skills in gerund form or clear verb phrases.** `processing-pdfs`, `analyzing-spreadsheets`, `managing-databases`. Per Anthropic's best-practices doc. Avoid `helper`, `utils`, `tools`.

11. **Write descriptions in third person.** "Processes Excel files" not "I can help with Excel." Because the description is injected into the system prompt; first-person is a point-of-view hazard.

12. **Front-load the key use case.** Descriptions are capped at 1,536 chars combined for rendering; put the most important trigger phrase first.

13. **Test with every model you'll use.** Haiku needs more explicit guidance than Opus. Qwen3.5 in thinking mode picks up descriptions differently than GPT-5. Our matrix policy applies here.

14. **Build evaluations first (pre-skill baseline), then iterate.** Anthropic's guidance: measure unskilled Claude's failure modes, then write the skill to address them. Don't pre-optimize for imagined tasks.

15. **For Skills that use MCP, fully qualify tool names.** `BigQuery:bigquery_schema`, not `bigquery_schema`. Multi-MCP sessions break unqualified names.

16. **For autonomous agents specifically: prefer bundled scripts to instructions.** A `scripts/validate.py` deterministic gate is far more reliable than "please run a validation check." Writes the skill body short and the script explicit.

17. **`allowed-tools` in a skill is a power-feature; use sparingly.** It effectively creates a per-skill permission model. Misuse = agent punches through deny rules during that skill. Good for `Bash(git:*)` on a `/commit` skill; bad for `Bash(*)` generally.

## 13. Worked example — a `skill` tool for `@agent-sh/harness-skill`

Concrete sketch of the v1 package surface (not code I'm going to write, a design target):

```typescript
// @agent-sh/harness-skill
import { createTool } from "@agent-sh/harness-core";
import { Type } from "valibot";

export function createSkillTool(options: {
  registry: SkillRegistry;
  permissionHook?: SkillPermissionHook;
  stripFrontmatter?: boolean;
  maxResources?: number;
}): Tool<SkillInput, SkillOutput>;

export interface SkillRegistry {
  listSkills(): Promise<SkillMetadata[]>;
  loadSkill(name: string): Promise<LoadedSkill | NotFound>;
  warmSkill?(name: string): Promise<void>;
}

export class FilesystemSkillRegistry implements SkillRegistry {
  constructor(opts: {
    roots: string[];               // e.g. [".agents/skills", ".claude/skills"]
    userRoots?: string[];          // e.g. ["~/.agents/skills", "~/.claude/skills"]
    precedence?: "first-wins" | "last-wins";
  });
}

export function buildSkillCatalog(
  skills: SkillMetadata[],
  options?: { format?: "xml" | "json" | "markdown"; budget?: number }
): string;
```

The `harness-e2e` test matrix for this would include the six categories from `testing-harness-tools.md`:

- **Golden**: user asks "summarize my PDF" with `pdf-processing` skill installed → model activates + uses it.
- **Ambiguous**: user asks something adjacent to a skill's description → model chooses the right skill (or no skill if confidence is low).
- **Adversarial**: user's query matches two skills → model picks the more specific one.
- **Multi-turn**: skill is activated, then conversation goes long → does the skill body survive (or is re-activation needed)?
- **Pagination**: 100+ skills installed → catalog respects budget, skills are still discoverable.
- **Schema-edge**: skill with invalid frontmatter, skill with no body, skill with malicious script in body (hooked).

## 14. Further reading

| Resource | Type | Why recommended |
|---|---|---|
| [agentskills.io — Specification](https://agentskills.io/specification) | Official spec | The contract. Required/optional fields, directory layout, progressive disclosure, validation. Source of truth. |
| [agentskills.io — What are skills?](https://agentskills.io/what-are-skills) | Concept explainer | The "why." Contrasts with system prompts, MCP, subagents. |
| [agentskills.io — Adding skills support to your agent](https://agentskills.io/client-implementation/adding-skills-support) | Implementation guide | Five-phase lifecycle (discover → parse → disclose → activate → manage). Essential for our design. |
| [Claude Code Skills](https://code.claude.com/docs/en/skills) | Official docs | Richest feature set in 2026. Frontmatter reference, argument passing, subagent fork, dynamic context. |
| [Claude Code tools reference (Skill tool)](https://code.claude.com/docs/en/tools-reference) | Official docs | Confirms `Skill` is a tool (permission: yes). |
| [Platform API — Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) | Official docs | How skills work at the Claude API level (not just Claude Code). Cross-surface differences. |
| [Platform API — Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) | Official docs | How to author good skills. Description writing, progressive disclosure patterns, anti-patterns. |
| [Anthropic blog: Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | Engineering blog (Oct 16 2025) | The announcement. Core argument for progressive disclosure, contrast with MCP. |
| [Anthropic news: Skills announcement](https://claude.com/blog/skills) | News post (Oct 16 2025) | Consumer-facing framing. Composable / portable / efficient / powerful. |
| [Simon Willison: Claude Skills are awesome, maybe a bigger deal than MCP](https://simonwillison.net/2025/Oct/16/claude-skills/) | Independent blog (Oct 16 2025) | Third-party analysis. MCP token cost comparison. "General computer automation" framing. |
| [OpenCode tools overview](https://opencode.ai/docs/tools/) | Official docs | The `skill` tool in the OpenCode 13-tool surface. |
| [OpenCode skills documentation](https://opencode.ai/docs/skills/) | Official docs | Discovery order, permission model, frontmatter (name/description/license/compatibility/metadata). |
| [OpenCode skill.ts source](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/skill.ts) | Source | Schema: `{ name }`. Permission-checked, ripgrep-sampled resources. |
| [Continue readSkill source](https://github.com/continuedev/continue/blob/main/core/tools/definitions/readSkill.ts) | Source | `{ skillName }`. `readonly: true, isInstant: true`. Dynamic description. |
| [Gemini CLI activate-skill source](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/activate-skill.ts) | Source | `{ name }` with enum-constrained schema. `<activated_skill>` XML return. |
| [Codex CLI skills docs](https://developers.openai.com/codex/skills/) | Official docs | No tool — `$name` / `/skills` + system-prompt injection. Pattern B exemplar. |
| [Codex core-skills Rust crate](https://github.com/openai/codex/tree/main/codex-rs/core-skills) | Source | `AvailableSkills`, `SkillPolicy`, `SkillMetadataBudget`. Injection-based. |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) | Official docs | Subagent-skill composition: `skills` field preloads skill bodies into a subagent's context. |
| [Claude Code MCP](https://code.claude.com/docs/en/mcp) | Official docs | MCP vs skills framing; ToolSearch / defer_loading for MCP tool-count scaling. |
| [Cursor skills](https://cursor.com/docs/context/skills) | Official docs | Cursor-side adoption. `/migrate-to-skills` from the old rules system. |
| [Amp manual (Agent Skills section)](https://ampcode.com/manual#agent-skills) | Official docs | Pattern-B adopter without a tool; skills integrate transparently via catalog-only. |
| [Junie Agent Skills docs](https://junie.jetbrains.com/docs/agent-skills.html) | Official docs | JetBrains-IDE-adjacent; `.junie/skills/`; no tool call, auto-invocation. |
| [OpenHands skills](https://docs.openhands.dev/overview/skills) | Official docs | Multi-mode activation (always-on, keyword, agent-invoked); deprecated `.openhands/microagents/`. |
| [Roo Code skills](https://docs.roocode.com/features/skills) | Official docs | Mode-scoped skills (`skills-code/`). `.roo/skills/` + `.agents/skills/`. No dedicated tool. |
| [Goose skills guide](https://block.github.io/goose/docs/guides/context-engineering/using-skills/) | Official docs | Block/Square's Goose harness. Context-engineering framing. |
| [Letta skills](https://docs.letta.com/letta-code/skills/) | Official docs | Stateful-agent platform's take. Multi-scope: `~/.letta/agents/{id}/skills/`. |
| [Kiro skills](https://kiro.dev/docs/skills/) | Official docs | Spec-driven development's adoption. |
| [anthropics/skills repo](https://github.com/anthropics/skills) | Reference implementations | Example skills: PDF/DOCX/XLSX/PPTX + creative/enterprise/dev categories. |
| [skills-ref library](https://github.com/agentskills/agentskills/tree/main/skills-ref) | Validation tooling | Validate SKILL.md frontmatter, generate prompt XML. |
| [Codex skill-installer example](https://github.com/openai/skills) | Curated skills | `.curated/` and `.experimental/` and `.system/` conventions. |
| [Mistral AI Vibe (skills adopter)](https://github.com/mistralai/mistral-vibe) | Source | Open-source CLI agent with skills. |
| [fast-agent skills](https://fast-agent.ai/agents/skills/) | Official docs | ACP / skills interplay in the fast-agent framework. |
| [Spring AI generic agent skills](https://spring.io/blog/2026/01/13/spring-ai-generic-agent-skills/) | Official blog | Java/Spring adoption path — proves the spec's language-neutrality. |
| [Laravel Boost skills](https://laravel.com/docs/12.x/boost#agent-skills) | Official docs | Framework-packaged skills for Laravel; proves the "bundled with library" distribution model. |
| [VS Code skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills) | Official docs | Microsoft/VS Code Copilot adoption. |
| [GitHub Copilot agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) | Official docs | Copilot's adoption of the same spec. |
| [Databricks Genie skills](https://docs.databricks.com/aws/en/assistant/skills) | Official docs | Data-platform vertical adoption. |
| [Factory CLI skills](https://docs.factory.ai/cli/configuration/skills) | Official docs | CI/CD delegation harness. |
| [Firebender skills](https://docs.firebender.com/multi-agent/skills) | Official docs | Android-native coding agent. |
| [Qodo skills](https://www.qodo.ai/blog/how-i-use-qodos-agent-skills-to-auto-fix-issues-in-pull-requests/) | Case study | PR-automation skills. |
| [Emdash skills](https://docs.emdash.sh/skills) | Official docs | Desktop multi-agent parallel execution. |

---

*This guide was synthesized from 40 sources on 2026-04-22. See `resources/skill-tool-design-across-harnesses-sources.json` for full source metadata including per-source quality scores and key insights.*

*Cross-references: for architectural framing see `ai-agent-harness-tooling.md`; for tool-surface matrix see `harness-tool-surface-audit.md`; for testing approaches see `testing-harness-tools.md`; for comparable tool designs see `exec-tool-design-across-harnesses.md`, `webfetch-tool-design-across-harnesses.md`, `lsp-tool-design-across-harnesses.md`.*
