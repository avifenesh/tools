import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { formatToolError, type ToolError } from "@agent-sh/harness-core";
import type { GrepSessionConfig } from "@agent-sh/harness-grep";
import { grepToolDefinition } from "@agent-sh/harness-grep";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

/**
 * Rust-backed grep executor. Spawns the `harness-grep-cli` binary once
 * per session and proxies tool calls over newline-delimited JSON-RPC on
 * stdio. Same wire contract as `makeGrepExecutor` so e2e tests can swap
 * engines with one line.
 *
 * The CLI binary is assumed to be built at `target/debug/harness-grep-cli`
 * (workspace-level, using CARGO_TARGET_DIR=~/rust-target-harness on
 * WSL). Override via env `HARNESS_GREP_RUST_BIN`.
 */

export interface RustGrepRunner {
  readonly tool: OllamaTool;
  execute: ToolExecutor["execute"];
  close(): Promise<void>;
}

interface Pending {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

function defaultBinPath(): string {
  const fromEnv = process.env.HARNESS_GREP_RUST_BIN;
  if (fromEnv) return fromEnv;
  const cargoTarget =
    process.env.CARGO_TARGET_DIR ??
    path.join(process.env.HOME ?? ".", "rust-target-harness");
  return path.join(cargoTarget, "debug", "harness-grep-cli");
}

export function makeGrepExecutorRust(session: GrepSessionConfig): RustGrepRunner {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: grepToolDefinition.name,
      description: grepToolDefinition.description,
      parameters: grepToolDefinition.inputSchema as unknown as Record<
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
      env: {
        ...process.env,
        LD_LIBRARY_PATH: "",
      },
    });
    p.on("exit", () => {
      for (const [, handler] of pending) {
        handler.reject(new Error("harness-grep-cli exited unexpectedly"));
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
      process.stderr.write(`[harness-grep-cli] ${chunk.toString("utf8")}`);
    });
    proc = p;
    return p;
  }

  function sendCall(params: unknown): Promise<string> {
    const p = ensureProc();
    const id = nextId++;
    const payload = {
      id,
      method: "grep",
      params: {
        params,
        session: {
          cwd: session.cwd,
          roots: session.permissions.roots,
          sensitive_patterns: session.permissions.sensitivePatterns,
          bypass_workspace_guard:
            session.permissions.bypassWorkspaceGuard ?? false,
          default_head_limit: session.defaultHeadLimit ?? null,
          max_bytes: session.maxBytes ?? null,
          max_line_length: session.maxLineLength ?? null,
          max_filesize: session.maxFilesize ?? null,
          timeout_ms: session.timeoutMs ?? null,
        },
      },
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

  return { tool, execute, close };
}
