import path from "node:path";
import {
  defaultNodeOperations,
  isInsideAnyRoot,
  matchesAnyPattern,
  toolError,
  type ReadOperations,
  type ToolError,
} from "@agent-sh/harness-core";
import type { BashSessionConfig } from "./types.js";

export async function resolveCwd(
  ops: ReadOperations,
  session: BashSessionConfig,
  requested: string | undefined,
): Promise<string> {
  const base = requested ?? session.logicalCwd?.value ?? session.cwd;
  const absolute = path.isAbsolute(base) ? base : path.resolve(session.cwd, base);
  try {
    return await ops.realpath(absolute);
  } catch {
    return absolute;
  }
}

export async function fenceBash(
  session: BashSessionConfig,
  resolvedCwd: string,
): Promise<ToolError | undefined> {
  const { permissions } = session;
  const isSensitive = matchesAnyPattern(
    resolvedCwd,
    permissions.sensitivePatterns,
  );
  const insideWorkspace = isInsideAnyRoot(resolvedCwd, permissions.roots);

  if (isSensitive && permissions.hook === undefined) {
    return toolError(
      "SENSITIVE",
      `Refusing to run bash in sensitive path: ${resolvedCwd}`,
      { meta: { path: resolvedCwd } },
    );
  }

  if (
    !insideWorkspace &&
    permissions.bypassWorkspaceGuard !== true &&
    permissions.hook === undefined
  ) {
    return toolError(
      "OUTSIDE_WORKSPACE",
      `cwd is outside all configured workspace roots: ${resolvedCwd}`,
      { meta: { path: resolvedCwd, roots: permissions.roots } },
    );
  }

  return undefined;
}

/**
 * Permission hook call, bash-specific metadata.
 *
 * Returns one of:
 *   "allow"       — run
 *   "allow_once"  — run (no persistent rule learned)
 *   "deny"        — refuse with PERMISSION_DENIED
 *   "ask"         — treated as "deny" in this autonomous tool; caller
 *                   gets a hint to configure the hook properly
 */
export async function askPermission(
  session: BashSessionConfig,
  args: {
    command: string;
    cwd: string;
    background: boolean;
    timeoutMs: number;
    envKeys: readonly string[];
  },
): Promise<
  | { decision: "allow" | "allow_once" }
  | { decision: "deny"; reason: string }
> {
  const { permissions } = session;
  // Extract the first whitespace token as the "command head" for pattern
  // hints (`git`, `npm`, `python`, ...). Matches Claude Code convention.
  const commandHead = args.command.trimStart().split(/\s+/)[0] ?? "";
  const alwaysPatterns = commandHead
    ? [`Bash(${commandHead}:*)`]
    : ["Bash(*)"];

  if (permissions.hook === undefined) {
    if (permissions.unsafeAllowBashWithoutHook === true) {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      reason:
        "bash tool has no permission hook configured; refusing to run untrusted commands. Wire a hook or set session.permissions.unsafeAllowBashWithoutHook for test fixtures.",
    };
  }

  const decision = await permissions.hook({
    tool: "bash",
    path: args.cwd,
    action: "read",
    always_patterns: alwaysPatterns,
    metadata: {
      command: args.command,
      cwd: args.cwd,
      background: args.background,
      timeout_ms: args.timeoutMs,
      env_keys: args.envKeys,
      network_required: null,
    },
  });
  if (decision === "deny") {
    return {
      decision: "deny",
      reason: `Command blocked by permission policy. Pattern hint: ${alwaysPatterns.join(", ")}`,
    };
  }
  if (decision === "allow" || decision === "allow_once") {
    return { decision };
  }
  // "ask" in autonomous mode → deny with hint.
  return {
    decision: "deny",
    reason:
      "Permission hook returned 'ask' but bash runs in autonomous mode. Configure the hook to return allow or deny.",
  };
}

export function resolveOps(session: BashSessionConfig): ReadOperations {
  return session.ops ?? defaultNodeOperations();
}

// Add a minimal ops accessor if session extends with it. Bash uses the
// shared default for realpath/stat only.
declare module "./types.js" {
  interface BashSessionConfig {
    readonly ops?: ReadOperations;
  }
}
