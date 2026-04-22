import { toolError, type ToolError } from "@agent-sh/harness-core";
import { askPermission, fenceSkill, resolveTrustMode } from "./fence.js";
import {
  formatAlreadyLoaded,
  formatNotFound,
  formatSkill,
} from "./format.js";
import { safeParseSkillParams } from "./schema.js";
import { substituteArguments } from "./substitute.js";
import { suggestSkillSiblings } from "./suggest.js";
import type {
  SkillErrorResult,
  SkillResult,
  SkillSessionConfig,
} from "./types.js";

function err(error: ToolError): SkillErrorResult {
  return { kind: "error", error };
}

export async function skill(
  input: unknown,
  session: SkillSessionConfig,
): Promise<SkillResult> {
  const parsed = safeParseSkillParams(input);
  if (!parsed.ok) {
    const messages = parsed.issues.map((i) => i.message).join("; ");
    return err(toolError("INVALID_PARAM", messages, { cause: parsed.issues }));
  }
  const params = parsed.value;

  // Dedupe: if the skill is already loaded in this session, no-op.
  if (session.activated?.has(params.name)) {
    return {
      kind: "already_loaded",
      output: formatAlreadyLoaded(params.name),
      name: params.name,
    };
  }

  // Look up the skill in the registry.
  const entries = await session.registry.discover();
  const entry = entries.find((e) => e.name === params.name);
  if (!entry) {
    const siblings = suggestSkillSiblings(
      params.name,
      entries.map((e) => e.name),
    );
    return {
      kind: "not_found",
      output: formatNotFound({ name: params.name, siblings }),
      name: params.name,
      siblings,
    };
  }

  // Surface INVALID_FRONTMATTER / NAME_MISMATCH from discovery.
  if (entry.frontmatter["__skill_error"] !== undefined) {
    const reason = entry.frontmatter["__skill_error"] as string;
    const codeRaw = entry.frontmatter["__skill_error_code"];
    const code =
      codeRaw === "NAME_MISMATCH" ? "NAME_MISMATCH" : "INVALID_FRONTMATTER";
    return err(
      toolError(code, `skill "${entry.name}": ${reason}`, {
        meta: {
          name: entry.name,
          dir: entry.dir,
          ...(entry.frontmatter["__skill_error_line"] !== undefined
            ? { line: entry.frontmatter["__skill_error_line"] }
            : {}),
        },
      }),
    );
  }

  // disable-model-invocation
  if (
    entry.frontmatter["disable-model-invocation"] === true &&
    session.userInitiated !== true
  ) {
    return err(
      toolError(
        "DISABLED",
        `skill "${entry.name}" has disable-model-invocation: true; only user-initiated activation is allowed`,
        { meta: { name: entry.name, dir: entry.dir } },
      ),
    );
  }

  // Arguments shape check against frontmatter `arguments` declaration.
  const argsDecl = entry.frontmatter.arguments;
  if (argsDecl !== undefined && argsDecl !== null) {
    if (typeof params.arguments === "string") {
      return err(
        toolError(
          "INVALID_PARAM",
          `skill "${entry.name}" declares named arguments; pass them as an object, not a string`,
          { meta: { name: entry.name } },
        ),
      );
    }
  } else if (
    params.arguments !== undefined &&
    typeof params.arguments !== "string"
  ) {
    return err(
      toolError(
        "INVALID_PARAM",
        `skill "${entry.name}" does not declare named arguments; pass 'arguments' as a string or omit it`,
        { meta: { name: entry.name } },
      ),
    );
  }

  // Load body + resources.
  const loaded = await session.registry.load(params.name);
  if (!loaded) {
    return err(
      toolError(
        "IO_ERROR",
        `failed to load skill "${entry.name}" from ${entry.dir}`,
        { meta: { name: entry.name, dir: entry.dir } },
      ),
    );
  }

  // Workspace + sensitive fence.
  const fenceError = fenceSkill(session, loaded);
  if (fenceError) return err(fenceError);

  // Trust gate.
  const trust = resolveTrustMode(session, loaded.dir);
  if (!trust.trusted && trust.mode === "hook_required") {
    const decision = await askPermission(session, {
      skill: loaded,
      reason: "untrusted_project_skill",
    });
    if (decision.decision === "deny") {
      return err(
        toolError("NOT_TRUSTED", decision.why, {
          meta: { name: loaded.name, dir: loaded.dir },
        }),
      );
    }
  } else {
    if (!trust.trusted && trust.mode === "warn") {
      // eslint-disable-next-line no-console
      console.warn(
        `[skill] activating untrusted skill "${loaded.name}" at ${loaded.dir} (trust.untrustedProjectSkills=warn)`,
      );
    }
    const decision = await askPermission(session, {
      skill: loaded,
      reason: "normal",
    });
    if (decision.decision === "deny") {
      return err(
        toolError("PERMISSION_DENIED", decision.why, {
          meta: { name: loaded.name, dir: loaded.dir },
        }),
      );
    }
  }

  // Substitute arguments in the body.
  const substituted = substituteArguments(loaded.body, params.arguments);
  const bytes = Buffer.byteLength(substituted, "utf8");

  const output = formatSkill({
    name: loaded.name,
    dir: loaded.dir,
    frontmatter: loaded.frontmatter,
    body: substituted,
    resources: loaded.resources,
    bytes,
  });

  // Record activation for dedupe.
  session.activated?.add(loaded.name);

  return {
    kind: "ok",
    output,
    name: loaded.name,
    dir: loaded.dir,
    body: substituted,
    frontmatter: loaded.frontmatter,
    resources: loaded.resources,
    bytes,
  };
}
