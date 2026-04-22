import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { formatToolError, type ToolError } from "@agent-sh/harness-core";
import type { BashSessionConfig } from "@agent-sh/harness-bash";
import {
  bashToolDefinition,
  bashOutputToolDefinition,
  bashKillToolDefinition,
} from "@agent-sh/harness-bash";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

/**
 * Rust-backed bash executor trio. Spawns the `harness-bash-cli` binary
 * once per session and proxies `bash` / `bash_output` / `bash_kill` calls
 * over newline-delimited JSON-RPC on stdio. Matches the wire surface of
 * `makeBashExecutor` so e2e tests can swap engines with `HARNESS_BASH_ENGINE=rust`.
 */

export interface RustBashRunner {
  readonly bash: ToolExecutor;
  readonly bashOutput: ToolExecutor;
  readonly bashKill: ToolExecutor;
  close(): Promise<void>;
}

interface Pending {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

function toOllamaTool(def: {
  name: string;
  description: string;
  inputSchema: unknown;
}): OllamaTool {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: def.inputSchema as Record<string, unknown>,
    },
  };
}

function defaultBinPath(): string {
  const fromEnv = process.env.HARNESS_BASH_RUST_BIN;
  if (fromEnv) return fromEnv;
  const cargoTarget =
    process.env.CARGO_TARGET_DIR ??
    path.join(process.env.HOME ?? ".", "rust-target-harness");
  return path.join(cargoTarget, "debug", "harness-bash-cli");
}

export function makeBashExecutorsRust(session: BashSessionConfig): RustBashRunner {
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
        handler.reject(new Error("harness-bash-cli exited unexpectedly"));
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
      process.stderr.write(`[harness-bash-cli] ${chunk.toString("utf8")}`);
    });
    proc = p;
    return p;
  }

  function sessionSpec() {
    return {
      cwd: session.cwd,
      roots: session.permissions.roots,
      sensitive_patterns: session.permissions.sensitivePatterns ?? [],
      bypass_workspace_guard:
        session.permissions.bypassWorkspaceGuard ?? false,
      unsafe_allow_bash_without_hook:
        session.permissions.unsafeAllowBashWithoutHook ?? false,
      default_inactivity_timeout_ms:
        session.defaultInactivityTimeoutMs ?? null,
      wallclock_backstop_ms: session.wallclockBackstopMs ?? null,
      max_output_bytes_inline: session.maxOutputBytesInline ?? null,
      max_output_bytes_file: session.maxOutputBytesFile ?? null,
      max_background_jobs: session.maxBackgroundJobs ?? null,
    };
  }

  function sendCall(method: string, params: unknown): Promise<string> {
    const p = ensureProc();
    const id = nextId++;
    const payload = {
      id,
      method,
      params: {
        params,
        session: sessionSpec(),
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

  async function execute(method: string, args: unknown): Promise<string> {
    const raw = await sendCall(method, args);
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

  return {
    bash: {
      tool: toOllamaTool(bashToolDefinition),
      execute: (args: unknown) => execute("bash", args),
    },
    bashOutput: {
      tool: toOllamaTool(bashOutputToolDefinition),
      execute: (args: unknown) => execute("bash_output", args),
    },
    bashKill: {
      tool: toOllamaTool(bashKillToolDefinition),
      execute: (args: unknown) => execute("bash_kill", args),
    },
    close,
  };
}
