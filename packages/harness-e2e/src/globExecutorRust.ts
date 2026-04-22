import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { formatToolError, type ToolError } from "@agent-sh/harness-core";
import type { GlobSessionConfig } from "@agent-sh/harness-glob";
import { globToolDefinition } from "@agent-sh/harness-glob";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

/**
 * Rust-backed glob executor. Same pattern as `makeGrepExecutorRust`:
 * spawn `harness-glob-cli`, proxy tool calls over newline-delimited
 * JSON-RPC on stdio. Enables parity testing between the TS orchestrator
 * and the Rust port without duplicating e2e fixtures.
 *
 * Override the bin path via env `HARNESS_GLOB_RUST_BIN`. Defaults to
 * `$CARGO_TARGET_DIR/debug/harness-glob-cli` (or
 * `$HOME/rust-target-harness/debug/...` on the WSL workaround layout).
 */

export interface RustGlobRunner {
  readonly tool: OllamaTool;
  execute: ToolExecutor["execute"];
  close(): Promise<void>;
}

interface Pending {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

function defaultBinPath(): string {
  const fromEnv = process.env.HARNESS_GLOB_RUST_BIN;
  if (fromEnv) return fromEnv;
  const cargoTarget =
    process.env.CARGO_TARGET_DIR ??
    path.join(process.env.HOME ?? ".", "rust-target-harness");
  return path.join(cargoTarget, "debug", "harness-glob-cli");
}

export function makeGlobExecutorRust(
  session: GlobSessionConfig,
): RustGlobRunner {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: globToolDefinition.name,
      description: globToolDefinition.description,
      parameters: globToolDefinition.inputSchema as unknown as Record<
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
        h.reject(new Error("harness-glob-cli exited unexpectedly"));
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
        const h = pending.get(parsed.id);
        if (!h) continue;
        pending.delete(parsed.id);
        if (parsed.error) {
          h.reject(
            new Error(
              `rust rpc error ${parsed.error.code ?? "?"}: ${parsed.error.message ?? "unknown"}`,
            ),
          );
        } else {
          h.resolve(JSON.stringify(parsed.result ?? null));
        }
      }
    });
    p.stderr!.on("data", (chunk: Buffer) => {
      process.stderr.write(`[harness-glob-cli] ${chunk.toString("utf8")}`);
    });
    proc = p;
    return p;
  }

  function sendCall(params: unknown): Promise<string> {
    const p = ensureProc();
    const id = nextId++;
    const payload = {
      id,
      method: "glob",
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
          max_filesize: session.maxFilesize ?? null,
          max_paths_scanned: session.maxPathsScanned ?? null,
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
