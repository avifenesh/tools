import path from "node:path";
import {
  defaultNodeOperations,
  isInsideAnyRoot,
  matchesAnyPattern,
  toolError,
  type ReadOperations,
  type ToolError,
} from "@agent-sh/harness-core";
import type { GrepSessionConfig } from "./types.js";

export async function resolveSearchPath(
  ops: ReadOperations,
  cwd: string,
  input: string | undefined,
): Promise<string> {
  const raw = input ?? cwd;
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  try {
    return await ops.realpath(absolute);
  } catch {
    return absolute;
  }
}

export async function fenceSearch(
  session: GrepSessionConfig,
  resolvedPath: string,
): Promise<ToolError | undefined> {
  const { permissions } = session;
  const isSensitive = matchesAnyPattern(
    resolvedPath,
    permissions.sensitivePatterns,
  );
  const insideWorkspace = isInsideAnyRoot(resolvedPath, permissions.roots);

  if (isSensitive && permissions.hook === undefined) {
    return toolError(
      "SENSITIVE",
      `Refusing to grep sensitive path: ${resolvedPath}`,
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

  if (permissions.hook !== undefined) {
    const needsAsk =
      isSensitive ||
      (!insideWorkspace && permissions.bypassWorkspaceGuard !== true);
    const reason = isSensitive
      ? "sensitive"
      : !insideWorkspace
        ? "outside_workspace"
        : "in_workspace";
    const alwaysPatterns = needsAsk
      ? [path.dirname(resolvedPath) + "/*"]
      : ["*"];
    const decision = await permissions.hook({
      tool: "grep",
      path: resolvedPath,
      action: "read",
      always_patterns: alwaysPatterns,
      metadata: { reason },
    });
    if (decision === "deny") {
      return toolError(
        "PERMISSION_DENIED",
        `Grep denied by user: ${resolvedPath}`,
        { meta: { path: resolvedPath } },
      );
    }
  }

  return undefined;
}

export function resolveOps(session: GrepSessionConfig): ReadOperations {
  return session.ops ?? defaultNodeOperations();
}
