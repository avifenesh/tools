import path from "node:path";
import {
  defaultNodeOperations,
  isInsideAnyRoot,
  matchesAnyPattern,
  toolError,
  type ReadOperations,
  type ToolError,
} from "@agent-sh/harness-core";
import type { LspOperation, LspSessionConfig } from "./types.js";

export async function resolvePath(
  ops: ReadOperations,
  session: LspSessionConfig,
  requested: string | undefined,
): Promise<string | undefined> {
  if (requested === undefined) return undefined;
  const absolute = path.isAbsolute(requested)
    ? requested
    : path.resolve(session.cwd, requested);
  try {
    return await ops.realpath(absolute);
  } catch {
    return absolute;
  }
}

export async function fenceLsp(
  session: LspSessionConfig,
  resolvedPath: string | undefined,
): Promise<ToolError | undefined> {
  if (resolvedPath === undefined) return undefined; // workspaceSymbol
  const { permissions } = session;
  const isSensitive = matchesAnyPattern(
    resolvedPath,
    permissions.sensitivePatterns,
  );
  const insideWorkspace = isInsideAnyRoot(resolvedPath, permissions.roots);

  if (isSensitive && permissions.hook === undefined) {
    return toolError(
      "SENSITIVE",
      `Refusing to query sensitive path: ${resolvedPath}`,
      { meta: { path: resolvedPath } },
    );
  }
  if (
    !insideWorkspace &&
    permissions.bypassWorkspaceGuard !== true &&
    permissions.hook === undefined
  ) {
    return toolError(
      "OUTSIDE_WORKSPACE",
      `Path is outside all configured workspace roots: ${resolvedPath}`,
      { meta: { path: resolvedPath, roots: permissions.roots } },
    );
  }
  return undefined;
}

export async function askPermission(
  session: LspSessionConfig,
  args: {
    operation: LspOperation;
    path: string | undefined;
    language: string | undefined;
    line: number | undefined;
    character: number | undefined;
    query: string | undefined;
  },
): Promise<
  | { decision: "allow" | "allow_once" }
  | { decision: "deny"; reason: string }
> {
  const { permissions } = session;
  const pattern = `Lsp(${args.operation}:*)`;

  if (permissions.hook === undefined) {
    if (permissions.unsafeAllowLspWithoutHook === true) {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      reason:
        "lsp tool has no permission hook configured; refusing to spawn language servers against untrusted code. Wire a hook or set session.permissions.unsafeAllowLspWithoutHook for test fixtures.",
    };
  }

  const decision = await permissions.hook({
    tool: "lsp",
    path: args.path ?? session.cwd,
    action: "read",
    always_patterns: [pattern],
    metadata: {
      operation: args.operation,
      language: args.language ?? null,
      line: args.line ?? null,
      character: args.character ?? null,
      query: args.query ?? null,
    },
  });
  if (decision === "deny") {
    return {
      decision: "deny",
      reason: `LSP operation blocked by permission policy. Pattern hint: ${pattern}`,
    };
  }
  if (decision === "allow" || decision === "allow_once") {
    return { decision };
  }
  return {
    decision: "deny",
    reason:
      "Permission hook returned 'ask' but lsp runs in autonomous mode. Configure the hook to return allow or deny.",
  };
}

export function resolveOps(session: LspSessionConfig): ReadOperations {
  return session.ops ?? defaultNodeOperations();
}

declare module "./types.js" {
  interface LspSessionConfig {
    readonly ops?: ReadOperations;
  }
}
