import { createHash } from "node:crypto";
import path from "node:path";
import {
  defaultNodeOperations,
  defaultNodeWriteOperations,
  isInsideAnyRoot,
  matchesAnyPattern,
  toolError,
  type ReadOperations,
  type ToolError,
  type WriteOperations,
} from "@agent-sh/harness-core";
import type { WriteSessionConfig } from "./types.js";

export interface ResolvedSession {
  readonly ops: ReadOperations;
  readonly writeOps: WriteOperations;
}

export function resolveSession(session: WriteSessionConfig): ResolvedSession {
  return {
    ops: session.ops ?? defaultNodeOperations(),
    writeOps: session.writeOps ?? defaultNodeWriteOperations(),
  };
}

export async function resolvePath(
  ops: ReadOperations,
  cwd: string,
  input: string,
): Promise<string> {
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input);
  try {
    return await ops.realpath(absolute);
  } catch {
    return absolute;
  }
}

export async function fencePath(
  session: WriteSessionConfig,
  resolvedPath: string,
  tool: "write" | "edit" | "multiedit",
  metadata: Readonly<Record<string, unknown>>,
): Promise<ToolError | undefined> {
  const { permissions } = session;

  if (resolvedPath.endsWith(".ipynb")) {
    return toolError(
      "NOTEBOOK_UNSUPPORTED",
      "Notebook editing is not supported in this version. Use Read to inspect notebook cells; a dedicated NotebookEdit tool is planned for v2.",
      { meta: { path: resolvedPath } },
    );
  }

  const isSensitive = matchesAnyPattern(
    resolvedPath,
    permissions.sensitivePatterns,
  );
  const insideWorkspace = isInsideAnyRoot(resolvedPath, permissions.roots);

  if (isSensitive && permissions.hook === undefined) {
    return toolError(
      "SENSITIVE",
      `Refusing to ${tool} sensitive path: ${resolvedPath}`,
      { meta: { path: resolvedPath } },
    );
  }

  if (
    !insideWorkspace &&
    permissions.bypassWorkspaceGuard !== true &&
    permissions.hook === undefined
  ) {
    if (process.env.E2E_DEBUG_PERMISSIONS) {
      // eslint-disable-next-line no-console
      console.error(
        `[write fencePath ${tool}] OUTSIDE_WORKSPACE reject: resolvedPath=${JSON.stringify(resolvedPath)} roots=${JSON.stringify(permissions.roots)}`,
      );
    }
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
      tool,
      path: resolvedPath,
      action: tool === "write" ? "write" : "edit",
      always_patterns: alwaysPatterns,
      metadata: { reason, ...metadata },
    });
    if (decision === "deny") {
      return toolError(
        "DENIED_BY_HOOK",
        `${tool} denied by permission hook: ${resolvedPath}`,
        { meta: { path: resolvedPath } },
      );
    }
  }

  return undefined;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
