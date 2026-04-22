import { describe, expect, it } from "vitest";
import {
  safeParseBashParams,
  safeParseBashOutputParams,
  safeParseBashKillParams,
} from "../src/schema.js";

describe("bash schema", () => {
  it("accepts a minimal command", () => {
    const r = safeParseBashParams({ command: "echo hi" });
    expect(r.ok).toBe(true);
  });

  it("rejects empty command", () => {
    const r = safeParseBashParams({ command: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing command", () => {
    const r = safeParseBashParams({});
    expect(r.ok).toBe(false);
  });

  it("accepts all optional fields", () => {
    const r = safeParseBashParams({
      command: "echo hi",
      cwd: "/tmp",
      timeout_ms: 5000,
      description: "greet",
      background: false,
      env: { FOO: "bar" },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects timeout_ms < 100", () => {
    const r = safeParseBashParams({ command: "x", timeout_ms: 50 });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown fields via strictObject", () => {
    const r = safeParseBashParams({ command: "x", bogus: true } as unknown);
    expect(r.ok).toBe(false);
  });

  it("redirects 'cmd' alias to 'command'", () => {
    const r = safeParseBashParams({ cmd: "echo hi" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/Use 'command' instead/);
    }
  });

  it("redirects 'timeout' with unit-conversion note", () => {
    const r = safeParseBashParams({ command: "x", timeout: 30 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/milliseconds/);
      expect(msg).toMatch(/30000/);
    }
  });

  it("redirects 'lang' to language one-liner note", () => {
    const r = safeParseBashParams({ command: "x", lang: "python" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/python -c/);
    }
  });

  it("redirects 'stdin' with v1-not-supported note", () => {
    const r = safeParseBashParams({ command: "x", stdin: "y" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msg = r.issues.map((i) => i.message).join(" ");
      expect(msg).toMatch(/Interactive stdin is not supported/);
    }
  });

  it("redirects common alias typos", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["shell_command", "foo", /Use 'command'/],
      ["script", "foo", /Use 'command'/],
      ["run", "foo", /Use 'command'/],
      ["directory", "/tmp", /Use 'cwd'/],
      ["dir", "/tmp", /Use 'cwd'/],
      ["path", "/tmp", /Use 'cwd'/],
      ["working_directory", "/tmp", /Use 'cwd'/],
      ["time_limit", 30, /milliseconds/],
      ["timeout_seconds", 30, /multiply by 1000/],
      ["env_vars", {}, /Use 'env'/],
      ["environment", {}, /Use 'env'/],
      ["interpreter", "python", /inside the command/],
      ["runtime", "node", /inside the command/],
      ["input", "y", /Interactive input is not supported/],
      ["sandbox", "docker", /session, not per-call/],
      ["sandbox_mode", "read-only", /session, not per-call/],
      ["network", true, /session \/ executor adapter/],
      ["shell", "/bin/sh", /Shell binary is configured/],
    ];
    for (const [key, val, expected] of cases) {
      const r = safeParseBashParams({ command: "x", [key]: val });
      expect(r.ok, `expected ${key} to be rejected`).toBe(false);
      if (!r.ok) {
        const msg = r.issues.map((i) => i.message).join(" ");
        expect(msg, `hint for ${key} missing redirect`).toMatch(expected);
      }
    }
  });
});

describe("bash_output schema", () => {
  it("accepts job_id", () => {
    const r = safeParseBashOutputParams({ job_id: "abc" });
    expect(r.ok).toBe(true);
  });

  it("rejects missing job_id", () => {
    const r = safeParseBashOutputParams({});
    expect(r.ok).toBe(false);
  });

  it("rejects negative since_byte", () => {
    const r = safeParseBashOutputParams({ job_id: "abc", since_byte: -1 });
    expect(r.ok).toBe(false);
  });
});

describe("bash_kill schema", () => {
  it("accepts job_id with default signal", () => {
    const r = safeParseBashKillParams({ job_id: "abc" });
    expect(r.ok).toBe(true);
  });

  it("accepts SIGKILL signal", () => {
    const r = safeParseBashKillParams({ job_id: "abc", signal: "SIGKILL" });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown signal", () => {
    const r = safeParseBashKillParams({ job_id: "abc", signal: "SIGBOGUS" });
    expect(r.ok).toBe(false);
  });
});
