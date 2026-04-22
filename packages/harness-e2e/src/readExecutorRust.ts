import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { formatToolError, type ToolError } from "@agent-sh/harness-core";
import type { ReadSessionConfig } from "@agent-sh/harness-read";
import { readToolDefinition } from "@agent-sh/harness-read";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

/**
 * Rust-backed read executor. Spawns `harness-read-cli` once per session
 * and proxies calls over newline-delimited JSON-RPC on stdio. Matches
 * `makeReadExecutor` so e2e tests swap engines with HARNESS_READ_ENGINE=rust.
 */

export interface RustReadRunner {
  readonly tool: OllamaTool;
  execute: ToolExecutor["execute"];
  close(): Promise<void>;
}

interface Pending {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

function defaultBinPath(): string {
  const fromEnv = process.env.HARNESS_READ_RUST_BIN;
  if (fromEnv) return fromEnv;
  const cargoTarget =
    process.env.CARGO_TARGET_DIR ??
    path.join(process.env.HOME ?? ".", "rust-target-harness");
  return path.join(cargoTarget, "debug", "harness-read-cli");
}

export function makeReadExecutorRust(
  session: ReadSessionConfig,
): RustReadRunner {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: readToolDefinition.name,
      description: readToolDefinition.description,
      parameters: readToolDefinition.inputSchema as unknown as Record<
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
      for (const [, handler] of pending) {
        handler.reject(new Error("harness-read-cli exited unexpectedly"));
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
      process.stderr.write(`[harness-read-cli] ${chunk.toString("utf8")}`);
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
      max_file_size: session.maxFileSize ?? null,
      max_bytes: session.maxBytes ?? null,
      default_limit: session.defaultLimit ?? null,
      max_line_length: session.maxLineLength ?? null,
      model_context_tokens: session.modelContextTokens ?? null,
      tokens_per_byte: session.tokensPerByte ?? null,
    };
  }

  function sendCall(params: unknown): Promise<string> {
    const p = ensureProc();
    const id = nextId++;
    const payload = {
      id,
      method: "read",
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
      attachments?: Array<{ mime: string }>;
      meta?: { size_bytes?: number };
    };
    if (parsed.kind === "error" && parsed.error) {
      return formatToolError(parsed.error);
    }
    if (parsed.kind === "attachment") {
      const mime = parsed.attachments?.[0]?.mime ?? "application/octet-stream";
      const bytes = parsed.meta?.size_bytes ?? 0;
      return `${parsed.output}\n(mime=${mime}, bytes=${bytes}; attachment body omitted in text channel)`;
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
