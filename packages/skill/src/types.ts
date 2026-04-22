import type { PermissionPolicy, ToolError } from "@agent-sh/harness-core";

/**
 * Session permission policy plus the autonomous escape hatch for tests.
 * Mirrors the pattern in bash / lsp / webfetch.
 */
export interface SkillPermissionPolicy extends PermissionPolicy {
  readonly unsafeAllowSkillWithoutHook?: boolean;
}

/**
 * Trust posture for project-root skills. See design §5.5.
 *
 * - `hook_required` — default. Skills under roots NOT listed in
 *   `trustedRoots` require explicit hook approval on activation.
 * - `warn` — allow activation, emit console warning.
 * - `allow` — legacy; no gating.
 */
export type SkillTrustMode = "hook_required" | "warn" | "allow";

export interface SkillTrustPolicy {
  readonly trustedRoots?: readonly string[];
  readonly untrustedProjectSkills?: SkillTrustMode;
}

export interface SkillParams {
  readonly name: string;
  readonly arguments?: string | Readonly<Record<string, string>>;
}

/**
 * Declared arguments shape in a skill's frontmatter. When present,
 * activation with object-form `arguments` is validated against this.
 */
export interface SkillArgumentsDecl {
  readonly [key: string]: {
    readonly type?: "string";
    readonly required?: boolean;
    readonly description?: string;
  };
}

export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly dir: string;
  readonly rootIndex: number;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Names of skills this one shadows (lower-precedence roots). */
  readonly shadowed?: readonly string[];
}

export interface LoadedSkill extends SkillEntry {
  /** SKILL.md body with frontmatter stripped. Verbatim. */
  readonly body: string;
  /** Resource filenames enumerated from scripts/ references/ assets/. */
  readonly resources: readonly string[];
}

/** Pluggable backend. Default ships a FilesystemSkillRegistry. */
export interface SkillRegistry {
  discover(): Promise<readonly SkillEntry[]>;
  load(name: string): Promise<LoadedSkill | null>;
}

/**
 * Set of skill names already activated in this session. Callers
 * typically pass `new Set()` at session start; the tool mutates it
 * to record activations for idempotence checks.
 */
export type ActivatedSet = Set<string>;

export interface SkillSessionConfig {
  readonly cwd: string;
  readonly permissions: SkillPermissionPolicy;
  readonly registry: SkillRegistry;
  readonly trust?: SkillTrustPolicy;
  /**
   * Whether this call originated from the user (slash-command) or the
   * model. When true, skills with `disable-model-invocation: true`
   * still activate. Default: false (model-initiated).
   */
  readonly userInitiated?: boolean;
  /**
   * Tracks which skills are already loaded. If omitted, dedupe is
   * disabled and every activation returns a fresh body.
   */
  readonly activated?: ActivatedSet;
  readonly signal?: AbortSignal;
}

// ---- Result union ----

export interface SkillOk {
  readonly kind: "ok";
  readonly output: string;
  readonly name: string;
  readonly dir: string;
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly resources: readonly string[];
  readonly bytes: number;
}

export interface SkillAlreadyLoaded {
  readonly kind: "already_loaded";
  readonly output: string;
  readonly name: string;
}

export interface SkillNotFound {
  readonly kind: "not_found";
  readonly output: string;
  readonly name: string;
  readonly siblings: readonly string[];
}

export interface SkillErrorResult {
  readonly kind: "error";
  readonly error: ToolError;
}

export type SkillResult =
  | SkillOk
  | SkillAlreadyLoaded
  | SkillNotFound
  | SkillErrorResult;
