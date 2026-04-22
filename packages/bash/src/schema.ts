import * as v from "valibot";
import type { ToolDefinition } from "@agent-sh/harness-core";
import { MAX_COMMAND_LENGTH } from "./constants.js";
import type { BashParams, BashOutputParams, BashKillParams } from "./types.js";

export const BashParamsSchema = v.strictObject({
  command: v.pipe(
    v.string(),
    v.minLength(1, "command is required"),
    v.maxLength(
      MAX_COMMAND_LENGTH,
      `command exceeds ${MAX_COMMAND_LENGTH} bytes`,
    ),
  ),
  cwd: v.optional(v.pipe(v.string(), v.minLength(1, "cwd must not be empty"))),
  timeout_ms: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(100, "timeout_ms must be >= 100 ms"),
    ),
  ),
  description: v.optional(v.string()),
  background: v.optional(v.boolean()),
  env: v.optional(v.record(v.string(), v.string())),
});

export const BashOutputParamsSchema = v.strictObject({
  job_id: v.pipe(v.string(), v.minLength(1, "job_id is required")),
  since_byte: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0, "since_byte must be >= 0")),
  ),
  head_limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1, "head_limit must be >= 1")),
  ),
});

export const BashKillParamsSchema = v.strictObject({
  job_id: v.pipe(v.string(), v.minLength(1, "job_id is required")),
  signal: v.optional(v.picklist(["SIGTERM", "SIGKILL"])),
});

export type ParsedBashParams = v.InferOutput<typeof BashParamsSchema>;

/**
 * Alias table mirroring grep/glob's KNOWN_PARAM_ALIASES. Models routinely
 * pass alternate names; we return a targeted INVALID_PARAM redirect rather
 * than the generic strictObject "Unknown key: X".
 */
const KNOWN_PARAM_ALIASES: Record<string, string> = {
  cmd: "unknown parameter 'cmd'. Use 'command' instead.",
  shell_command: "unknown parameter 'shell_command'. Use 'command' instead.",
  script: "unknown parameter 'script'. Use 'command' instead.",
  run: "unknown parameter 'run'. Use 'command' instead.",

  directory: "unknown parameter 'directory'. Use 'cwd' instead.",
  dir: "unknown parameter 'dir'. Use 'cwd' instead.",
  path: "unknown parameter 'path'. Use 'cwd' instead.",
  working_directory:
    "unknown parameter 'working_directory'. Use 'cwd' instead.",

  timeout:
    "unknown parameter 'timeout'. Use 'timeout_ms' instead (milliseconds, not seconds). For 30s pass timeout_ms: 30000.",
  time_limit:
    "unknown parameter 'time_limit'. Use 'timeout_ms' instead (milliseconds).",
  timeout_seconds:
    "unknown parameter 'timeout_seconds'. Use 'timeout_ms' instead (multiply by 1000).",

  env_vars: "unknown parameter 'env_vars'. Use 'env' instead.",
  environment: "unknown parameter 'environment'. Use 'env' instead.",

  lang: "unknown parameter 'lang'. Bash runs shell commands; invoke other languages via the command itself (e.g. 'python -c \"...\"', 'node -e \"...\"').",
  language:
    "unknown parameter 'language'. Invoke other languages via the command (e.g. 'python -c \"...\"', 'node -e \"...\"').",
  interpreter:
    "unknown parameter 'interpreter'. Invoke the interpreter inside the command itself (e.g. 'python -c \"...\"').",
  runtime:
    "unknown parameter 'runtime'. Invoke the runtime inside the command itself (e.g. 'node -e \"...\"').",

  stdin:
    "unknown parameter 'stdin'. Interactive stdin is not supported in v1. Pipe data into the command instead (e.g. 'echo \"y\" | npm init').",
  input:
    "unknown parameter 'input'. Interactive input is not supported in v1. Make the command non-interactive with flags like --yes.",

  sandbox:
    "unknown parameter 'sandbox'. Sandboxing is configured on the session, not per-call.",
  sandbox_mode:
    "unknown parameter 'sandbox_mode'. Sandboxing is configured on the session, not per-call.",
  permissions:
    "unknown parameter 'permissions'. The permission hook is configured on the session.",
  network:
    "unknown parameter 'network'. Network access is configured on the session / executor adapter.",
  network_access:
    "unknown parameter 'network_access'. Network access is configured on the session / executor adapter.",

  shell: "unknown parameter 'shell'. Shell binary is configured on the session.",
  shell_binary:
    "unknown parameter 'shell_binary'. Shell binary is configured on the session.",
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

function makeAliasIssues(messages: string[]): v.BaseIssue<unknown>[] {
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

export function safeParseBashParams(input: unknown):
  | { ok: true; value: BashParams }
  | { ok: false; issues: v.BaseIssue<unknown>[] } {
  const aliases = checkAliases(input);
  if (aliases.length > 0) {
    return { ok: false, issues: makeAliasIssues(aliases) };
  }
  const result = v.safeParse(BashParamsSchema, input);
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, issues: result.issues };
}

export function safeParseBashOutputParams(input: unknown):
  | { ok: true; value: BashOutputParams }
  | { ok: false; issues: v.BaseIssue<unknown>[] } {
  const result = v.safeParse(BashOutputParamsSchema, input);
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, issues: result.issues };
}

export function safeParseBashKillParams(input: unknown):
  | { ok: true; value: BashKillParams }
  | { ok: false; issues: v.BaseIssue<unknown>[] } {
  const result = v.safeParse(BashKillParamsSchema, input);
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, issues: result.issues };
}

// Tool definitions exposed to the LLM.

export const BASH_TOOL_NAME = "bash";

export const BASH_TOOL_DESCRIPTION = `Run a single shell command in a bash subprocess. Output is captured and returned with the exit code.

Usage:
- 'cd' carries over to subsequent calls if it stays inside the workspace; otherwise the cwd is reset. Environment variables do NOT persist across calls — set them inline (FOO=bar some-cmd) or via 'env'.
- For non-shell code, use language one-liners: 'python -c "print(2+2)"', 'node -e "console.log(2+2)"', 'deno eval "console.log(2+2)"'. For multi-line scripts, write a temp file with the write tool and invoke the interpreter on it.
- Long-running processes (servers, watchers) MUST use background: true. The tool returns a job_id; poll output with bash_output(job_id). Do not leave a foreground command running past the 5-minute wall-clock backstop.
- No interactive commands. Anything that needs stdin (pagers, Y/n prompts, REPLs, 'git commit' without -m) will hang until the inactivity timeout. Use flags to make commands non-interactive (--yes, -y, --no-pager) or pipe 'echo "y" |' in front.
- Inactivity timeout resets on any output; default 60000 ms. Override with timeout_ms. Wall-clock backstop is 5 minutes for foreground calls.
- Prefer this tool over other ways of running shell commands. For filename search prefer 'glob'; for content search prefer 'grep'.`;

export const bashToolDefinition: ToolDefinition = {
  name: BASH_TOOL_NAME,
  description: BASH_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to run (single string, interpreted by bash -c).",
      },
      cwd: {
        type: "string",
        description:
          "Absolute working directory. Defaults to the session cwd plus any carried-over cd. Must be inside the workspace.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 100,
        description:
          "Inactivity timeout in milliseconds. Any output resets the clock. Default 60000 (60 s). Wall-clock backstop is 5 minutes regardless.",
      },
      description: {
        type: "string",
        description: "One-line human-readable 'why' (optional, for traces).",
      },
      background: {
        type: "boolean",
        description:
          "Run as a background job. Returns a job_id; poll output with bash_output. Use for servers, watchers, long-running builds.",
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Environment variables merged on top of the session env. Keys with sensitive prefixes (AWS_*, GITHUB_TOKEN, etc.) are rejected.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

export const BASH_OUTPUT_TOOL_NAME = "bash_output";

export const BASH_OUTPUT_TOOL_DESCRIPTION = `Poll a backgrounded bash job's output since a given byte offset.

Returns stdout and stderr slices plus whether the job is still running and its exit code if finished. Use 'since_byte' from the previous call to paginate through a long-running job's output without re-fetching already-seen bytes.`;

export const bashOutputToolDefinition: ToolDefinition = {
  name: BASH_OUTPUT_TOOL_NAME,
  description: BASH_OUTPUT_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description:
          "The job_id returned by a previous bash call with background: true.",
      },
      since_byte: {
        type: "integer",
        minimum: 0,
        description:
          "Start of the requested slice per stream, in bytes. Defaults to 0. Use next_since_byte from a previous output call to resume.",
      },
      head_limit: {
        type: "integer",
        minimum: 1,
        description: "Max bytes per stream (default 30720 / 30 KB).",
      },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
};

export const BASH_KILL_TOOL_NAME = "bash_kill";

export const BASH_KILL_TOOL_DESCRIPTION = `Send a termination signal to a backgrounded bash job.

Defaults to SIGTERM (graceful). Use SIGKILL for an unresponsive job. The job's next bash_output call will report running: false.`;

export const bashKillToolDefinition: ToolDefinition = {
  name: BASH_KILL_TOOL_NAME,
  description: BASH_KILL_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      job_id: {
        type: "string",
        description: "The job_id returned by a previous bash call with background: true.",
      },
      signal: {
        type: "string",
        enum: ["SIGTERM", "SIGKILL"],
        description: "Signal to send. Default SIGTERM.",
      },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
};
