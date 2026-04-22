import * as v from "valibot";
import type { ToolDefinition } from "@agent-sh/harness-core";
import { MAX_NAME_LENGTH, SKILL_NAME_RE } from "./constants.js";
import type { SkillParams } from "./types.js";

/**
 * Valibot schema for the `skill` tool parameters. The name is
 * constrained to lowercase-kebab-case at schema time so typos get a
 * schema-level INVALID_PARAM, not a catalog miss that's harder to
 * diagnose.
 */
export const SkillParamsSchema = v.object({
  name: v.pipe(
    v.string(),
    v.minLength(1, "name must not be empty"),
    v.maxLength(MAX_NAME_LENGTH, `name exceeds ${MAX_NAME_LENGTH} chars`),
    v.regex(
      SKILL_NAME_RE,
      "name must be lowercase-kebab-case (/^[a-z0-9]+(-[a-z0-9]+)*$/)",
    ),
  ),
  arguments: v.optional(
    v.union([v.string(), v.record(v.string(), v.string())]),
  ),
});

export type ParsedSkillParams = v.InferOutput<typeof SkillParamsSchema>;

/**
 * Alias table. Mirrors the pattern from bash / webfetch / grep / glob.
 * The most common model drifts for a skill tool are param-name drift
 * (`skill`, `invoke`, `run`) and v1-not-supported features (fork, paths,
 * model overrides).
 */
const KNOWN_PARAM_ALIASES: Record<string, string> = {
  skill: "unknown parameter 'skill'. Use 'name' instead.",
  skill_name: "unknown parameter 'skill_name'. Use 'name' instead.",
  name_of_skill: "unknown parameter 'name_of_skill'. Use 'name' instead.",
  slug: "unknown parameter 'slug'. Use 'name' instead.",

  invoke:
    "unknown parameter 'invoke'. Just call skill({name}); activation is implicit.",
  activate:
    "unknown parameter 'activate'. Just call skill({name}); activation is implicit.",
  run: "unknown parameter 'run'. Just call skill({name}); activation is implicit.",

  args: "unknown parameter 'args'. Use 'arguments' instead.",
  args_string: "unknown parameter 'args_string'. Use 'arguments' instead.",
  input: "unknown parameter 'input'. Use 'arguments' instead.",
  params: "unknown parameter 'params'. Use 'arguments' instead.",
  parameters: "unknown parameter 'parameters'. Use 'arguments' instead.",

  context:
    "unknown parameter 'context'. Skill context is session-scoped; no per-call override.",
  session:
    "unknown parameter 'session'. Skill context is session-scoped; no per-call override.",

  reload:
    "unknown parameter 'reload'. Skills load once per session; edit the skill file and restart the session to refresh.",
  fresh:
    "unknown parameter 'fresh'. Skills load once per session; edit the skill file and restart the session to refresh.",
  force_reload:
    "unknown parameter 'force_reload'. Skills load once per session; edit the skill file and restart the session to refresh.",
  refresh:
    "unknown parameter 'refresh'. Skills load once per session; edit the skill file and restart the session to refresh.",

  fork:
    "unknown parameter 'fork'. Subagent-forked skills are deferred to v1.1.",
  subagent:
    "unknown parameter 'subagent'. Subagent-forked skills are deferred to v1.1.",
  isolated:
    "unknown parameter 'isolated'. Subagent-forked skills are deferred to v1.1.",

  paths:
    "unknown parameter 'paths'. Auto-activation gating on file paths is deferred to v1.1.",
  scope_paths:
    "unknown parameter 'scope_paths'. Auto-activation gating on file paths is deferred to v1.1.",

  model:
    "unknown parameter 'model'. Model override is a harness concern, not a tool parameter.",
  effort:
    "unknown parameter 'effort'. Effort override is a harness concern, not a tool parameter.",

  file:
    "unknown parameter 'file'. Skills dispatch by 'name', not path; the harness owns discovery.",
  file_path:
    "unknown parameter 'file_path'. Skills dispatch by 'name', not path; the harness owns discovery.",
  skill_path:
    "unknown parameter 'skill_path'. Skills dispatch by 'name', not path; the harness owns discovery.",
  dir: "unknown parameter 'dir'. Skills dispatch by 'name', not path; the harness owns discovery.",
};

function checkAliases(input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const hints: string[] = [];
  for (const key of Object.keys(input as Record<string, unknown>)) {
    const hint = KNOWN_PARAM_ALIASES[key];
    if (hint) hints.push(hint);
  }
  return hints;
}

function makeAliasIssues(messages: readonly string[]): v.BaseIssue<unknown>[] {
  return messages.map(
    (m) =>
      ({
        kind: "validation",
        type: "custom",
        input: undefined,
        expected: null,
        received: "unknown",
        message: m,
      }) as unknown as v.BaseIssue<unknown>,
  );
}

export function safeParseSkillParams(input: unknown):
  | { ok: true; value: SkillParams }
  | { ok: false; issues: v.BaseIssue<unknown>[] } {
  const aliases = checkAliases(input);
  if (aliases.length > 0) {
    return { ok: false, issues: makeAliasIssues(aliases) };
  }
  const result = v.safeParse(SkillParamsSchema, input);
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, issues: result.issues };
}

export const SKILL_TOOL_NAME = "skill";

export const SKILL_TOOL_DESCRIPTION = `Activate an installed skill by name. A skill is a reusable package of instructions, optional scripts, and reference docs, authored as a folder at \`skill-name/SKILL.md\`. Activating loads the skill's body into the conversation for the rest of the session.

When to use. Activate a skill when the user's request matches its description. The catalog of installed skills, each with name and short description, is always visible in your tool-call context. If two skills plausibly apply, pick the one whose description most precisely matches.

Idempotence. Activating the same skill twice in one session is a no-op — the body is already loaded. The tool returns an \`already_loaded\` marker so you know the content is still in context.

Arguments. Pass \`arguments\` as a string for positional skills (those declaring \`$ARGUMENTS\` or \`$1\`/\`$2\`) or as a JSON object for skills that declare named arguments in frontmatter. Run without arguments if the skill doesn't need them.

Permission. Activation runs through the session's permission hook. A skill's \`allowed-tools\` frontmatter is an advisory declaration of what tools it expects to need — it does not pre-approve anything; downstream tool calls still pass the session's permission hook.`;

export const skillToolDefinition: ToolDefinition = {
  name: SKILL_TOOL_NAME,
  description: SKILL_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Slug of an installed skill (lowercase-kebab-case). Pick from the skill catalog.",
      },
      arguments: {
        oneOf: [
          { type: "string" },
          { type: "object", additionalProperties: { type: "string" } },
        ],
        description:
          "Optional arguments. Use a string for $ARGUMENTS / $1 / $2 positional skills, or a JSON object for skills with named arguments in their frontmatter.",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
};
