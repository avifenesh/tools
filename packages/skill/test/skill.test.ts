import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionHook, PermissionPolicy } from "@agent-sh/harness-core";
import {
  FilesystemSkillRegistry,
  skill,
  type SkillPermissionPolicy,
  type SkillSessionConfig,
  type SkillResult,
  type SkillTrustPolicy,
} from "../src/index.js";

function mkRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "skill-test-")));
}

function writeSkill(
  rootDir: string,
  name: string,
  frontmatter: string,
  body: string,
): string {
  const dir = path.join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\n${frontmatter}\n---\n${body}`,
  );
  return dir;
}

function writeResource(
  skillDir: string,
  folder: string,
  name: string,
  content = "",
): void {
  const dir = path.join(skillDir, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), content);
}

function baseSession(opts: {
  rootDir: string;
  permissions?: Partial<SkillPermissionPolicy>;
  trust?: SkillTrustPolicy;
  userInitiated?: boolean;
  activated?: Set<string>;
}): SkillSessionConfig {
  const permissions: SkillPermissionPolicy = {
    roots: [opts.rootDir],
    sensitivePatterns: [],
    unsafeAllowSkillWithoutHook: true,
    ...opts.permissions,
  };
  const registry = new FilesystemSkillRegistry([opts.rootDir]);
  // Default: trust the test root so happy-path tests don't have to wire
  // it every time. Tests that specifically exercise trust gating pass
  // `trust` explicitly to override.
  const trust: SkillTrustPolicy = opts.trust ?? {
    trustedRoots: [opts.rootDir],
  };
  return {
    cwd: opts.rootDir,
    permissions,
    registry,
    trust,
    ...(opts.userInitiated !== undefined
      ? { userInitiated: opts.userInitiated }
      : {}),
    ...(opts.activated !== undefined ? { activated: opts.activated } : {}),
  };
}

function expectError(r: SkillResult): { code: string; message: string } {
  if (r.kind !== "error") {
    throw new Error(`expected error, got kind=${r.kind}`);
  }
  return { code: r.error.code, message: r.error.message };
}

describe("schema validation", () => {
  it("rejects empty name", async () => {
    const root = mkRoot();
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "" }, s);
    const e = expectError(r);
    expect(e.code).toBe("INVALID_PARAM");
  });

  it("rejects name with uppercase", async () => {
    const root = mkRoot();
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "MySkill" }, s);
    const e = expectError(r);
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toContain("lowercase-kebab-case");
  });

  it("rejects name > 64 chars", async () => {
    const root = mkRoot();
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "a".repeat(65) }, s);
    const e = expectError(r);
    expect(e.code).toBe("INVALID_PARAM");
  });

  it("rejects alias 'skill_name'", async () => {
    const root = mkRoot();
    const s = baseSession({ rootDir: root });
    const r = await skill({ skill_name: "foo" }, s);
    const e = expectError(r);
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toContain("'name'");
  });

  it("rejects alias 'params'", async () => {
    const root = mkRoot();
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo", params: "x" }, s);
    const e = expectError(r);
    expect(e.message).toContain("arguments");
  });

  it("rejects alias 'reload'", async () => {
    const root = mkRoot();
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo", reload: true }, s);
    const e = expectError(r);
    expect(e.message).toContain("load once");
  });
});

describe("registry discovery", () => {
  it("NOT_FOUND with fuzzy siblings", async () => {
    const root = mkRoot();
    writeSkill(root, "tweet-thread", "name: tweet-thread\ndescription: x", "body");
    writeSkill(root, "joi", "name: joi\ndescription: y", "body");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "tweet-threads" }, s);
    expect(r.kind).toBe("not_found");
    if (r.kind === "not_found") {
      expect(r.siblings).toContain("tweet-thread");
    }
  });

  it("skips a directory with no SKILL.md", async () => {
    const root = mkRoot();
    mkdirSync(path.join(root, "not-a-skill"));
    writeSkill(root, "real", "name: real\ndescription: x", "body");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "real" }, s);
    expect(r.kind).toBe("ok");
  });

  it("NAME_MISMATCH when frontmatter name != dir", async () => {
    const root = mkRoot();
    writeSkill(root, "bar", "name: foo\ndescription: x", "body");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "bar" }, s);
    const e = expectError(r);
    expect(e.code).toBe("NAME_MISMATCH");
  });

  it("INVALID_FRONTMATTER on missing description", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo", "body");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo" }, s);
    const e = expectError(r);
    expect(e.code).toBe("INVALID_FRONTMATTER");
    expect(e.message).toContain("description");
  });

  it("INVALID_FRONTMATTER on broken YAML", async () => {
    const root = mkRoot();
    writeSkill(
      root,
      "foo",
      "name foo\ndescription: x",
      "body",
    );
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo" }, s);
    const e = expectError(r);
    expect(e.code).toBe("INVALID_FRONTMATTER");
  });
});

describe("activation", () => {
  it("ok on first activation", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "# Foo\nhello");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo" }, s);
    if (r.kind !== "ok") {
      throw new Error(
        `expected ok, got ${r.kind}: ${r.kind === "error" ? r.error.message : "?"}`,
      );
    }
    expect(r.body).toContain("hello");
    expect(r.output).toContain('<skill name="foo"');
  });

  it("already_loaded on second activation", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "body");
    const activated = new Set<string>();
    const s = baseSession({ rootDir: root, activated });
    await skill({ name: "foo" }, s);
    const r2 = await skill({ name: "foo" }, s);
    expect(r2.kind).toBe("already_loaded");
  });

  it("does not dedupe if activated set omitted", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "body");
    const s = baseSession({ rootDir: root });
    const r1 = await skill({ name: "foo" }, s);
    const r2 = await skill({ name: "foo" }, s);
    expect(r1.kind).toBe("ok");
    expect(r2.kind).toBe("ok");
  });

  it("enumerates resources from scripts/ and references/", async () => {
    const root = mkRoot();
    const dir = writeSkill(root, "foo", "name: foo\ndescription: hi", "body");
    writeResource(dir, "scripts", "audit.py");
    writeResource(dir, "scripts", "format.sh");
    writeResource(dir, "references", "schema.md");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo" }, s);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.resources).toContain(path.join("scripts", "audit.py"));
      expect(r.resources).toContain(path.join("scripts", "format.sh"));
      expect(r.resources).toContain(path.join("references", "schema.md"));
    }
  });

  it("DISABLED when disable-model-invocation is true and not user-initiated", async () => {
    const root = mkRoot();
    writeSkill(
      root,
      "foo",
      "name: foo\ndescription: hi\ndisable-model-invocation: true",
      "body",
    );
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo" }, s);
    const e = expectError(r);
    expect(e.code).toBe("DISABLED");
  });

  it("activates disabled skill when userInitiated=true", async () => {
    const root = mkRoot();
    writeSkill(
      root,
      "foo",
      "name: foo\ndescription: hi\ndisable-model-invocation: true",
      "body",
    );
    const s = baseSession({ rootDir: root, userInitiated: true });
    const r = await skill({ name: "foo" }, s);
    expect(r.kind).toBe("ok");
  });
});

describe("fence", () => {
  it("OUTSIDE_WORKSPACE when skill dir is not under any root", async () => {
    const skillRoot = mkRoot();
    const fenceRoot = mkRoot(); // unrelated
    writeSkill(skillRoot, "foo", "name: foo\ndescription: x", "body");
    const s = baseSession({
      rootDir: skillRoot,
      permissions: { roots: [fenceRoot] },
    });
    const r = await skill({ name: "foo" }, s);
    const e = expectError(r);
    expect(e.code).toBe("OUTSIDE_WORKSPACE");
  });

  it("SENSITIVE when dir matches a sensitive pattern", async () => {
    const root = mkRoot();
    writeSkill(root, "secrets-skill", "name: secrets-skill\ndescription: x", "body");
    const s = baseSession({
      rootDir: root,
      permissions: { sensitivePatterns: ["**/secrets-*/**", "**/secrets-*"] },
    });
    const r = await skill({ name: "secrets-skill" }, s);
    const e = expectError(r);
    expect(e.code).toBe("SENSITIVE");
  });
});

describe("permissions + trust", () => {
  it("PERMISSION_DENIED without hook and no bypass", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "body");
    const s = baseSession({
      rootDir: root,
      permissions: { unsafeAllowSkillWithoutHook: false },
      trust: { trustedRoots: [root] },
    });
    const r = await skill({ name: "foo" }, s);
    const e = expectError(r);
    expect(e.code).toBe("PERMISSION_DENIED");
  });

  it("NOT_TRUSTED for project skill with no hook", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "body");
    const s = baseSession({
      rootDir: root,
      permissions: { unsafeAllowSkillWithoutHook: true },
      trust: { untrustedProjectSkills: "hook_required" },
    });
    const r = await skill({ name: "foo" }, s);
    const e = expectError(r);
    expect(e.code).toBe("NOT_TRUSTED");
  });

  it("ok when trust mode is 'allow'", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "body");
    const s = baseSession({
      rootDir: root,
      trust: { untrustedProjectSkills: "allow" },
    });
    const r = await skill({ name: "foo" }, s);
    expect(r.kind).toBe("ok");
  });

  it("hook receives skill frontmatter as metadata", async () => {
    const root = mkRoot();
    writeSkill(
      root,
      "foo",
      "name: foo\ndescription: hi\nversion: 1.0.0",
      "body",
    );
    let captured: unknown = null;
    const hook: PermissionHook = async (req) => {
      captured = req.metadata;
      return "allow";
    };
    const permissions: SkillPermissionPolicy = {
      roots: [root],
      sensitivePatterns: [],
      hook,
    };
    const s: SkillSessionConfig = {
      cwd: root,
      permissions,
      registry: new FilesystemSkillRegistry([root]),
      trust: { trustedRoots: [root] },
    };
    const r = await skill({ name: "foo" }, s);
    expect(r.kind).toBe("ok");
    expect((captured as { name: string }).name).toBe("foo");
    expect(
      ((captured as { frontmatter: Record<string, unknown> }).frontmatter)
        .version,
    ).toBe("1.0.0");
  });

  it("denies when hook returns deny", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "body");
    const hook: PermissionHook = async () => "deny";
    const permissions: SkillPermissionPolicy = {
      roots: [root],
      sensitivePatterns: [],
      hook,
    };
    const s: SkillSessionConfig = {
      cwd: root,
      permissions,
      registry: new FilesystemSkillRegistry([root]),
      trust: { trustedRoots: [root] },
    };
    const r = await skill({ name: "foo" }, s);
    const e = expectError(r);
    expect(e.code).toBe("PERMISSION_DENIED");
  });

  it("treats hook 'ask' as deny (autonomous)", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "body");
    const hook: PermissionHook = async () => "ask";
    const permissions: SkillPermissionPolicy = {
      roots: [root],
      sensitivePatterns: [],
      hook,
    };
    const s: SkillSessionConfig = {
      cwd: root,
      permissions,
      registry: new FilesystemSkillRegistry([root]),
      trust: { trustedRoots: [root] },
    };
    const r = await skill({ name: "foo" }, s);
    const e = expectError(r);
    expect(e.code).toBe("PERMISSION_DENIED");
  });
});

describe("argument substitution", () => {
  it("substitutes $ARGUMENTS with string form", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "run: $ARGUMENTS");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo", arguments: "path/to/x" }, s);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.body).toContain("run: path/to/x");
  });

  it("substitutes $1 and $2 positional", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "a=$1 b=$2");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo", arguments: "one two" }, s);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.body).toContain("a=one b=two");
  });

  it("leaves unsubstituted placeholders literal", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "p=$ARGUMENTS q=$1");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo" }, s);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.body).toContain("$ARGUMENTS");
      expect(r.body).toContain("$1");
    }
  });

  it("substitutes ${name} when frontmatter declares arguments", async () => {
    const root = mkRoot();
    writeSkill(
      root,
      "foo",
      `name: foo
description: hi
arguments:
  path: {type: string}`,
      "target=${path}",
    );
    const s = baseSession({ rootDir: root });
    const r = await skill(
      { name: "foo", arguments: { path: "/tmp/x" } },
      s,
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.body).toContain("target=/tmp/x");
  });

  it("rejects object args when skill has no arguments declaration", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "body");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo", arguments: { x: "y" } }, s);
    const e = expectError(r);
    expect(e.message).toContain("named arguments");
  });

  it("rejects string args when skill declares named arguments", async () => {
    const root = mkRoot();
    writeSkill(
      root,
      "foo",
      `name: foo
description: hi
arguments:
  path: {type: string}`,
      "body",
    );
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo", arguments: "ignored" }, s);
    const e = expectError(r);
    expect(e.message).toContain("named arguments");
  });
});

describe("output shape", () => {
  it("wraps body in <skill> element", async () => {
    const root = mkRoot();
    writeSkill(root, "foo", "name: foo\ndescription: hi", "body goes here");
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo" }, s);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.output).toMatch(/<skill name="foo"/);
      expect(r.output).toContain("<frontmatter>");
      expect(r.output).toContain("<instructions>");
      expect(r.output).toContain("body goes here");
      expect(r.output).toContain("</skill>");
    }
  });

  it("preserves unknown frontmatter fields", async () => {
    const root = mkRoot();
    writeSkill(
      root,
      "foo",
      "name: foo\ndescription: hi\nhooks: some-thing\nmodel: opus",
      "body",
    );
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo" }, s);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.frontmatter.hooks).toBe("some-thing");
      expect(r.frontmatter.model).toBe("opus");
    }
  });

  it("normalizes allowed-tools string to array", async () => {
    const root = mkRoot();
    writeSkill(
      root,
      "foo",
      `name: foo\ndescription: hi\nallowed-tools: "Read, Grep, Bash(git:*)"`,
      "body",
    );
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo" }, s);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.frontmatter["allowed-tools"]).toEqual([
        "Read",
        "Grep",
        "Bash(git:*)",
      ]);
    }
  });
});

describe("multi-root precedence", () => {
  it("project root shadows user root on name collision", async () => {
    const projectRoot = mkRoot();
    const userRoot = mkRoot();
    writeSkill(
      projectRoot,
      "foo",
      "name: foo\ndescription: project version",
      "project",
    );
    writeSkill(
      userRoot,
      "foo",
      "name: foo\ndescription: user version",
      "user",
    );
    const permissions: SkillPermissionPolicy = {
      roots: [projectRoot, userRoot],
      sensitivePatterns: [],
      unsafeAllowSkillWithoutHook: true,
    };
    const s: SkillSessionConfig = {
      cwd: projectRoot,
      permissions,
      registry: new FilesystemSkillRegistry([projectRoot, userRoot]),
      trust: { trustedRoots: [projectRoot, userRoot] },
    };
    const r = await skill({ name: "foo" }, s);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.body).toContain("project");
      expect(r.body).not.toContain("user");
    }
  });
});

describe("CRLF compatibility", () => {
  it("parses SKILL.md with CRLF line endings", async () => {
    const root = mkRoot();
    const dir = path.join(root, "foo");
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\r\nname: foo\r\ndescription: hi\r\n---\r\nbody with crlf\r\n`,
    );
    const s = baseSession({ rootDir: root });
    const r = await skill({ name: "foo" }, s);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.body).toContain("body with crlf");
  });
});
