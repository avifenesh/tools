import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCwdCarry,
  bash,
  bashKill,
  bashOutput,
  detectTopLevelCd,
} from "../src/bash.js";
import { createLocalBashExecutor } from "../src/executor.js";
import type { BashResult } from "../src/types.js";
import { makeSession, makeTempDir } from "./helpers.js";

function assertKind<T extends { kind: string }>(
  r: T,
  kind: T["kind"],
): asserts r is Extract<T, { kind: typeof kind }> {
  if (r.kind !== kind) {
    throw new Error(
      `Expected kind=${kind}, got kind=${r.kind}:\n${
        "output" in r
          ? (r as unknown as { output: string }).output
          : JSON.stringify(r)
      }`,
    );
  }
}

describe("bash — foreground happy path", () => {
  it("runs `echo hi` and returns kind=ok exit=0", async () => {
    const dir = makeTempDir();
    const r = await bash({ command: "echo hi" }, makeSession(dir));
    assertKind(r, "ok");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hi");
    expect(r.stderr).toBe("");
    expect(r.output).toContain("<exit_code>0</exit_code>");
    expect(r.output).toMatch(/exit=0/);
  });

  it("reports nonzero exit as kind=nonzero_exit", async () => {
    const dir = makeTempDir();
    const r = await bash({ command: "false" }, makeSession(dir));
    assertKind(r, "nonzero_exit");
    expect(r.exitCode).toBe(1);
  });

  it("captures stderr separately from stdout", async () => {
    const dir = makeTempDir();
    const r = await bash(
      { command: "echo OUT; echo ERR 1>&2" },
      makeSession(dir),
    );
    assertKind(r, "ok");
    expect(r.stdout).toContain("OUT");
    expect(r.stderr).toContain("ERR");
  });

  it("runs cwd-relative commands at session cwd", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "marker.txt"), "found\n");
    const r = await bash({ command: "cat marker.txt" }, makeSession(dir));
    assertKind(r, "ok");
    expect(r.stdout).toContain("found");
  });
});

describe("bash — timeout behavior", () => {
  it("inactivity timeout fires and returns kind=timeout", async () => {
    const dir = makeTempDir();
    const r = await bash(
      { command: "sleep 3", timeout_ms: 200 },
      makeSession(dir),
    );
    assertKind(r, "timeout");
    expect(r.reason).toBe("inactivity timeout");
  });

  it("streaming output resets inactivity timer (does NOT time out)", async () => {
    const dir = makeTempDir();
    // Prints a line every 50ms for 400ms — total > 200ms but activity
    // resets the clock each time.
    const cmd =
      'for i in 1 2 3 4 5 6 7 8; do echo "tick $i"; sleep 0.05; done';
    const r = await bash(
      { command: cmd, timeout_ms: 300 },
      makeSession(dir),
    );
    assertKind(r, "ok");
    expect(r.stdout).toContain("tick 8");
  });
});

describe("bash — fence", () => {
  it("rejects cwd outside workspace roots", async () => {
    const inside = makeTempDir();
    const outside = makeTempDir();
    const r = await bash(
      { command: "pwd", cwd: outside },
      makeSession(inside),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("OUTSIDE_WORKSPACE");
  });

  it("refuses bash with no hook and no unsafe flag", async () => {
    const dir = makeTempDir();
    const session = makeSession(dir, {
      permissions: {
        roots: [dir],
        sensitivePatterns: [],
        // No hook, no unsafeAllowBashWithoutHook.
      },
    });
    const r = await bash({ command: "echo x" }, session);
    assertKind(r, "error");
    expect(r.error.code).toBe("PERMISSION_DENIED");
    expect(r.error.message).toMatch(/no permission hook configured/);
  });

  it("permission hook decision=deny → PERMISSION_DENIED with command echo", async () => {
    const dir = makeTempDir();
    const session = makeSession(dir, {
      permissions: {
        roots: [dir],
        sensitivePatterns: [],
        hook: async () => "deny",
      },
    });
    const r = await bash({ command: "rm -rf /etc" }, session);
    assertKind(r, "error");
    expect(r.error.code).toBe("PERMISSION_DENIED");
    expect(r.error.message).toContain("rm -rf /etc");
  });

  it("permission hook 'ask' is treated as deny (autonomous mode)", async () => {
    const dir = makeTempDir();
    const session = makeSession(dir, {
      permissions: {
        roots: [dir],
        sensitivePatterns: [],
        hook: async () => "ask",
      },
    });
    const r = await bash({ command: "echo x" }, session);
    assertKind(r, "error");
    expect(r.error.code).toBe("PERMISSION_DENIED");
    expect(r.error.message).toMatch(/autonomous mode/);
  });
});

describe("bash — env filtering", () => {
  it("rejects sensitive env prefix", async () => {
    const dir = makeTempDir();
    const r = await bash(
      { command: "echo x", env: { AWS_SECRET: "nope" } },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
    expect(r.error.message).toContain("AWS_");
  });

  it("allows benign env", async () => {
    const dir = makeTempDir();
    const r = await bash(
      { command: "echo $MY_VAR", env: { MY_VAR: "hello" } },
      makeSession(dir),
    );
    assertKind(r, "ok");
    expect(r.stdout).toContain("hello");
  });
});

describe("bash — cwd-carry (detectTopLevelCd + applyCwdCarry)", () => {
  it("detects a bare `cd /path`", () => {
    expect(detectTopLevelCd("cd /tmp/foo")).toBe("/tmp/foo");
  });

  it("does NOT detect `cd` inside a pipeline", () => {
    expect(detectTopLevelCd("cd /tmp && ls")).toBeNull();
    expect(detectTopLevelCd("cd /tmp; ls")).toBeNull();
    expect(detectTopLevelCd("cd /tmp | cat")).toBeNull();
    expect(detectTopLevelCd("(cd /tmp)")).toBeNull();
  });

  it("does not detect cd with whitespace in the path (keep parser strict)", () => {
    // Quoted-cd-with-spaces is an edge case we deliberately reject.
    // The detector intentionally limits itself to single-word paths
    // (matching what models actually emit); full shell-quote parsing
    // is out of scope for v1.
    expect(detectTopLevelCd('cd "/tmp/with space"')).toBeNull();
    expect(detectTopLevelCd("cd '/tmp/with space'")).toBeNull();
  });

  it("applyCwdCarry updates logicalCwd on successful top-level cd inside workspace", () => {
    const root = makeTempDir();
    const session = makeSession(root, {
      logicalCwd: { value: root },
    });
    // Make a real subdir to target.
    const sub = path.join(root, "sub");
    require("node:fs").mkdirSync(sub);
    const r = applyCwdCarry(session, `cd ${sub}`, 0);
    expect(r.changed).toBe(true);
    expect(r.newCwd).toBe(sub);
    expect(r.escaped).toBe(false);
    expect(session.logicalCwd?.value).toBe(sub);
  });

  it("applyCwdCarry blocks escape", () => {
    const root = makeTempDir();
    const session = makeSession(root, {
      logicalCwd: { value: root },
    });
    const r = applyCwdCarry(session, "cd /etc", 0);
    expect(r.changed).toBe(false);
    expect(r.escaped).toBe(true);
    expect(session.logicalCwd?.value).toBe(root);
  });

  it("applyCwdCarry no-op on nonzero exit", () => {
    const root = makeTempDir();
    const session = makeSession(root, {
      logicalCwd: { value: root },
    });
    const r = applyCwdCarry(session, `cd ${root}/sub`, 1);
    expect(r.changed).toBe(false);
    expect(session.logicalCwd?.value).toBe(root);
  });
});

describe("bash — background jobs", () => {
  it("background: true returns job_id; bash_output polls; bash_kill terminates", async () => {
    const dir = makeTempDir();
    const session = makeSession(dir, {
      executor: createLocalBashExecutor(),
    });
    const start = (await bash(
      {
        command:
          "for i in 1 2 3 4 5; do echo tick-$i; sleep 0.1; done",
        background: true,
      },
      session,
    )) as BashResult;
    assertKind(start, "background_started");
    const jobId = start.jobId;

    // Let it run a moment.
    await new Promise((r) => setTimeout(r, 250));
    const poll1 = await bashOutput({ job_id: jobId }, session);
    assertKind(poll1, "output");
    expect(poll1.stdout).toMatch(/tick-/);

    // Kill.
    const killed = await bashKill({ job_id: jobId }, session);
    assertKind(killed, "killed");
    expect(killed.signal).toBe("SIGTERM");

    // Poll again; eventually should report running:false.
    await new Promise((r) => setTimeout(r, 300));
    const poll2 = await bashOutput({ job_id: jobId }, session);
    assertKind(poll2, "output");
    expect(poll2.running).toBe(false);
  });

  it("rejects background: true with timeout_ms", async () => {
    const dir = makeTempDir();
    const r = await bash(
      { command: "sleep 10", background: true, timeout_ms: 1000 },
      makeSession(dir),
    );
    assertKind(r, "error");
    expect(r.error.code).toBe("INVALID_PARAM");
    expect(r.error.message).toMatch(/background jobs/);
  });
});

describe("bash — output cap / stream-to-file", () => {
  it("caps at maxOutputBytesInline and spills to disk", async () => {
    const dir = makeTempDir();
    // Generate ~5 KB of output with a tiny 1 KB cap to force a spill.
    const r = await bash(
      { command: "yes ABCDEFGH | head -c 5000" },
      makeSession(dir, {
        maxOutputBytesInline: 1024,
        maxOutputBytesFile: 10 * 1024 * 1024,
      }),
    );
    assertKind(r, "ok");
    expect(r.byteCap).toBe(true);
    expect(r.logPath).toBeTruthy();
    expect(r.output).toMatch(/Full log:/);
  });
});

describe("bash — abort signal", () => {
  it("session AbortSignal kills the command", async () => {
    const dir = makeTempDir();
    const controller = new AbortController();
    const session = makeSession(dir, { signal: controller.signal });
    const p = bash({ command: "sleep 5" }, session);
    setTimeout(() => controller.abort(), 100);
    const r = await p;
    // When the outer signal aborts, the child gets SIGTERM. The executor
    // observes a clean-but-signal-killed exit (code null, signal SIGTERM)
    // and the orchestrator reports it however the downstream kind logic
    // lands. Accept any of: timeout (inactivity fired too), nonzero_exit
    // (signal-killed reported as exit -1 or nonzero), error (if the abort
    // path propagated up). What we're proving is it doesn't hang.
    expect(["timeout", "nonzero_exit", "error"]).toContain(r.kind);
  });
});
