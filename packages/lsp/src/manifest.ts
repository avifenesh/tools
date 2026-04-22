import { readFile } from "node:fs/promises";
import path from "node:path";
import { MANIFEST_FILENAME } from "./constants.js";
import type { LspManifest, LspServerProfile } from "./types.js";

/**
 * Load an .lsp.json manifest from a workspace root, or from an explicit
 * path. Returns undefined if the file doesn't exist — that's not an
 * error; the orchestrator then returns SERVER_NOT_AVAILABLE on the
 * first operation that needs a server.
 *
 * Validation is permissive: we accept the Claude Code manifest shape
 * and reject entries that look malformed (e.g. missing command).
 * Parse errors throw.
 */
export async function loadManifest(
  explicitPath: string | undefined,
  workspaceRoot: string,
): Promise<LspManifest | undefined> {
  const manifestPath = explicitPath ?? path.join(workspaceRoot, MANIFEST_FILENAME);
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(text) as unknown;
  return normalizeManifest(parsed, manifestPath);
}

function normalizeManifest(
  raw: unknown,
  source: string,
): LspManifest {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`Invalid LSP manifest at ${source}: expected object`);
  }
  const servers = (raw as { servers?: unknown }).servers;
  if (servers === undefined || servers === null || typeof servers !== "object") {
    throw new Error(
      `Invalid LSP manifest at ${source}: expected { servers: { ... } }`,
    );
  }
  const out: Record<string, LspServerProfile> = {};
  for (const [key, value] of Object.entries(
    servers as Record<string, unknown>,
  )) {
    const profile = normalizeProfile(key, value, source);
    out[key] = profile;
  }
  return { servers: out };
}

function normalizeProfile(
  name: string,
  raw: unknown,
  source: string,
): LspServerProfile {
  if (raw === null || typeof raw !== "object") {
    throw new Error(
      `Invalid LSP server profile '${name}' in ${source}: expected object`,
    );
  }
  const r = raw as {
    extensions?: unknown;
    command?: unknown;
    rootPatterns?: unknown;
    initializationOptions?: unknown;
  };
  const extensions = Array.isArray(r.extensions)
    ? (r.extensions as string[]).filter((x) => typeof x === "string")
    : [];
  if (extensions.length === 0) {
    throw new Error(
      `LSP server '${name}' in ${source}: 'extensions' must be a non-empty string[]`,
    );
  }
  const command = Array.isArray(r.command)
    ? (r.command as string[]).filter((x) => typeof x === "string")
    : [];
  if (command.length === 0) {
    throw new Error(
      `LSP server '${name}' in ${source}: 'command' must be a non-empty string[]`,
    );
  }
  const rootPatterns = Array.isArray(r.rootPatterns)
    ? (r.rootPatterns as string[]).filter((x) => typeof x === "string")
    : undefined;
  const initializationOptions =
    r.initializationOptions !== undefined &&
    typeof r.initializationOptions === "object" &&
    r.initializationOptions !== null
      ? (r.initializationOptions as Record<string, unknown>)
      : undefined;
  return {
    language: name,
    extensions,
    command,
    ...(rootPatterns !== undefined ? { rootPatterns } : {}),
    ...(initializationOptions !== undefined ? { initializationOptions } : {}),
  };
}

/**
 * Given a filesystem path and a manifest, return the matching server
 * profile based on extension. Returns undefined if no match.
 */
export function profileForPath(
  filePath: string,
  manifest: LspManifest | undefined,
): LspServerProfile | undefined {
  if (manifest === undefined) return undefined;
  const ext = path.extname(filePath).toLowerCase();
  if (ext.length === 0) return undefined;
  for (const profile of Object.values(manifest.servers)) {
    if (profile.extensions.some((e) => e.toLowerCase() === ext)) {
      return profile;
    }
  }
  return undefined;
}

/**
 * Find the LSP root for a server profile by walking up from the file
 * until we find one of `rootPatterns`. Falls back to the workspace cwd
 * if no pattern matches.
 */
export async function findLspRoot(
  filePath: string,
  profile: LspServerProfile,
  workspaceCwd: string,
): Promise<string> {
  if (!profile.rootPatterns || profile.rootPatterns.length === 0) {
    return workspaceCwd;
  }
  const { access } = await import("node:fs/promises");
  let current = path.dirname(filePath);
  while (current.length > 1) {
    for (const pattern of profile.rootPatterns) {
      const candidate = path.join(current, pattern);
      try {
        await access(candidate);
        return current;
      } catch {
        // not this dir; keep walking
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return workspaceCwd;
}
