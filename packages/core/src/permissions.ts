import path from "node:path";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRequest {
  readonly tool: string;
  readonly path: string;
  readonly action: string;
  readonly always_patterns: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type PermissionHook = (
  req: PermissionRequest,
) => Promise<"allow" | "deny">;

export interface PermissionPolicy {
  readonly roots: readonly string[];
  readonly sensitivePatterns: readonly string[];
  readonly bypassWorkspaceGuard?: boolean;
  readonly hook?: PermissionHook;
}

export const DEFAULT_SENSITIVE_PATTERNS: readonly string[] = Object.freeze([
  "**/.env",
  "**/.env.*",
  "**/id_rsa",
  "**/id_rsa.pub",
  "**/id_ed25519",
  "**/id_ed25519.pub",
  "**/.ssh/**",
  "**/.aws/credentials",
  "**/.aws/config",
  "**/*.pem",
  "**/*.key",
  "**/*.pfx",
  "**/*.p12",
  "**/credentials.json",
  "**/service-account*.json",
]);

export function isInsideAnyRoot(
  absolutePath: string,
  roots: readonly string[],
): boolean {
  if (roots.length === 0) return false;
  const normalized = normalize(absolutePath);
  for (const root of roots) {
    const r = normalize(root);
    if (normalized === r) return true;
    if (normalized.startsWith(r.endsWith("/") ? r : r + "/")) return true;
  }
  return false;
}

export function matchesAnyPattern(
  absolutePath: string,
  patterns: readonly string[],
): boolean {
  const normalized = normalize(absolutePath).toLowerCase();
  const base = path.basename(normalized);
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (globMatch(p, normalized) || globMatch(p, base)) return true;
  }
  return false;
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

export function globMatch(pattern: string, target: string): boolean {
  const re = globToRegExp(pattern);
  return re.test(target);
}

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        const after = pattern[i + 2];
        if (after === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (".+^$()|{}[]\\".includes(c)) {
      re += "\\" + c;
      i += 1;
      continue;
    }
    re += c;
    i += 1;
  }
  re += "$";
  return new RegExp(re);
}
