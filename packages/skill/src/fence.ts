import {
  isInsideAnyRoot,
  matchesAnyPattern,
  toolError,
  type ToolError,
} from "@agent-sh/harness-core";
import type {
  LoadedSkill,
  SkillPermissionPolicy,
  SkillSessionConfig,
  SkillTrustMode,
} from "./types.js";

/**
 * Returns a ToolError if the skill dir is out-of-workspace or matches
 * sensitive patterns and no hook is wired.
 */
export function fenceSkill(
  session: SkillSessionConfig,
  skill: LoadedSkill,
): ToolError | undefined {
  const { permissions } = session;
  const isSensitive = matchesAnyPattern(
    skill.dir,
    permissions.sensitivePatterns,
  );
  if (isSensitive && permissions.hook === undefined) {
    return toolError(
      "SENSITIVE",
      `Refusing to activate skill in sensitive path: ${skill.dir}`,
      { meta: { name: skill.name, dir: skill.dir } },
    );
  }
  const inside = isInsideAnyRoot(skill.dir, permissions.roots);
  if (
    !inside &&
    permissions.bypassWorkspaceGuard !== true &&
    permissions.hook === undefined
  ) {
    return toolError(
      "OUTSIDE_WORKSPACE",
      `Skill directory is outside all configured workspace roots: ${skill.dir}`,
      {
        meta: {
          name: skill.name,
          dir: skill.dir,
          roots: permissions.roots,
        },
      },
    );
  }
  return undefined;
}

/**
 * Resolve the trust mode for a skill. See design §5.5. Defaults:
 *
 * - Skills under `session.trust.trustedRoots` always activate (hook
 *   still runs as advisory).
 * - Skills elsewhere fall back to
 *   `session.trust.untrustedProjectSkills` (default `hook_required`).
 */
export function resolveTrustMode(
  session: SkillSessionConfig,
  skillDir: string,
): { trusted: boolean; mode: SkillTrustMode } {
  const trusted = (session.trust?.trustedRoots ?? []).some((root) =>
    isUnderRoot(skillDir, root),
  );
  if (trusted) {
    return { trusted: true, mode: "allow" };
  }
  const mode: SkillTrustMode =
    session.trust?.untrustedProjectSkills ?? "hook_required";
  return { trusted: false, mode };
}

/**
 * Permission hook invocation. Returns `allow`, `allow_once`, or
 * `deny` with a reason. `ask` maps to `deny` in autonomous mode.
 */
export async function askPermission(
  session: SkillSessionConfig,
  args: {
    skill: LoadedSkill;
    reason: "normal" | "untrusted_project_skill";
  },
): Promise<
  | { decision: "allow" | "allow_once" }
  | { decision: "deny"; why: string }
> {
  const perms: SkillPermissionPolicy = session.permissions;
  const pattern = `Skill(name:${args.skill.name})`;
  if (perms.hook === undefined) {
    if (args.reason === "untrusted_project_skill") {
      return {
        decision: "deny",
        why: "untrusted project skill; no permission hook is configured to review it",
      };
    }
    if (perms.unsafeAllowSkillWithoutHook === true) {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      why: "skill tool has no permission hook configured; refusing to activate untrusted skills. Wire a hook or set session.permissions.unsafeAllowSkillWithoutHook for test fixtures.",
    };
  }
  const decision = await perms.hook({
    tool: "skill",
    path: args.skill.dir,
    action: "activate",
    always_patterns: [pattern],
    metadata: {
      name: args.skill.name,
      root_index: args.skill.rootIndex,
      frontmatter: args.skill.frontmatter,
      reason: args.reason,
    },
  });
  if (decision === "deny") {
    return {
      decision: "deny",
      why: `skill activation blocked by permission policy. Pattern hint: ${pattern}`,
    };
  }
  if (decision === "allow" || decision === "allow_once") {
    return { decision };
  }
  return {
    decision: "deny",
    why: "permission hook returned 'ask' but skill runs in autonomous mode. Configure the hook to return allow or deny.",
  };
}

function isUnderRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  if (!candidate.startsWith(root)) return false;
  const next = candidate.charCodeAt(root.length);
  return next === 0x2f /* '/' */ || next === 0x5c; /* '\\' */
}
