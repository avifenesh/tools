import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { formatToolError, type ToolError } from "@agent-sh/harness-core";
import type { SkillSessionConfig } from "@agent-sh/harness-skill";
import { skillToolDefinition } from "@agent-sh/harness-skill";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

/**
 * Rust-backed skill executor. Spawns `harness-skill-cli` once per
 * session and proxies calls over newline-delimited JSON-RPC on stdio.
 * Session-keyed WeakMap ensures the same CLI process is reused for the
 * session (matches the write/lsp pattern so dedupe across calls works).
 */

export interface RustSkillRunner {
  readonly tool: OllamaTool;
  execute: ToolExecutor["execute"];
  close(): Promise<void>;
}

interface Pending {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

function defaultBinPath(): string {
  const fromEnv = process.env.HARNESS_SKILL_RUST_BIN;
  if (fromEnv) return fromEnv;
  const cargoTarget =
    process.env.CARGO_TARGET_DIR ??
    path.join(process.env.HOME ?? ".", "rust-target-harness");
  return path.join(cargoTarget, "debug", "harness-skill-cli");
}

const sessionRunners = new WeakMap<object, RustSkillRunner>();

export function makeSkillExecutorRust(
  session: SkillSessionConfig,
): RustSkillRunner {
  const existing = sessionRunners.get(session as unknown as object);
  if (existing) return existing;

  const tool: OllamaTool = {
    type: "function",
    function: {
      name: skillToolDefinition.name,
      description: skillToolDefinition.description,
      parameters: skillToolDefinition.inputSchema as unknown as Record<
        string,
        unknown
      >,
    },
  };

  const binPath = defaultBinPath();
  let proc: ChildProcess | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let buffered = "";

  function ensureProc(): ChildProcess {
    if (proc && !proc.killed && proc.exitCode === null) return proc;
    const p = spawn(binPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LD_LIBRARY_PATH: "" },
    });
    p.on("exit", () => {
      for (const [, h] of pending) {
        h.reject(new Error("harness-skill-cli exited unexpectedly"));
      }
      pending.clear();
      proc = null;
    });
    p.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      while (true) {
        const nl = buffered.indexOf("\n");
        if (nl < 0) break;
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line.trim().length === 0) continue;
        let parsed: {
          id?: number;
          result?: unknown;
          error?: { code?: number; message?: string };
        };
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed.id !== "number") continue;
        const handler = pending.get(parsed.id);
        if (!handler) continue;
        pending.delete(parsed.id);
        if (parsed.error) {
          handler.reject(
            new Error(
              `rust rpc error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "unknown"}`,
            ),
          );
        } else {
          handler.resolve(JSON.stringify(parsed.result ?? null));
        }
      }
    });
    p.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[harness-skill-cli] ${chunk.toString("utf8")}`);
    });
    proc = p;
    return p;
  }

  function sessionSpec() {
    const skillRoots: string[] = session.registry
      ? // Peek at FilesystemSkillRegistry private roots if available
        // (pragmatic — the TS side constructs registries from known paths).
        ((session.registry as unknown as { roots?: string[] }).roots ?? [])
      : [];
    return {
      cwd: session.cwd,
      roots: session.permissions.roots,
      sensitive_patterns: session.permissions.sensitivePatterns ?? [],
      bypass_workspace_guard:
        session.permissions.bypassWorkspaceGuard ?? false,
      unsafe_allow_skill_without_hook:
        session.permissions.unsafeAllowSkillWithoutHook ?? false,
      skill_roots: skillRoots,
      trusted_roots: session.trust?.trustedRoots ?? [],
      untrusted_project_skills: session.trust?.untrustedProjectSkills ?? null,
      user_initiated: session.userInitiated ?? false,
    };
  }

  function sendCall(params: unknown): Promise<string> {
    const p = ensureProc();
    const id = nextId++;
    const payload = {
      id,
      method: "skill",
      params: { params, session: sessionSpec() },
    };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      p.stdin!.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) {
          pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async function execute(args: unknown): Promise<string> {
    const raw = await sendCall(args);
    const parsed = JSON.parse(raw) as {
      kind?: string;
      output?: string;
      error?: ToolError;
    };
    if (parsed.kind === "error" && parsed.error) {
      return formatToolError(parsed.error);
    }
    if (typeof parsed.output === "string") return parsed.output;
    return raw;
  }

  async function close(): Promise<void> {
    if (proc && !proc.killed) {
      proc.stdin?.end();
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    proc = null;
  }

  const runner = { tool, execute, close };
  sessionRunners.set(session as unknown as object, runner);
  return runner;
}
