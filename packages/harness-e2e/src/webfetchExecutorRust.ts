import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { formatToolError, type ToolError } from "@agent-sh/harness-core";
import type { WebFetchSessionConfig } from "@agent-sh/harness-webfetch";
import { webfetchToolDefinition } from "@agent-sh/harness-webfetch";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

/**
 * Rust-backed webfetch executor. Spawns `harness-webfetch-cli` once per
 * session and proxies calls over newline-delimited JSON-RPC on stdio.
 * Matches `makeWebFetchExecutor` so e2e tests can swap with
 * `HARNESS_WEBFETCH_ENGINE=rust`.
 */

export interface RustWebFetchRunner {
  readonly tool: OllamaTool;
  execute: ToolExecutor["execute"];
  close(): Promise<void>;
}

interface Pending {
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

function defaultBinPath(): string {
  const fromEnv = process.env.HARNESS_WEBFETCH_RUST_BIN;
  if (fromEnv) return fromEnv;
  const cargoTarget =
    process.env.CARGO_TARGET_DIR ??
    path.join(process.env.HOME ?? ".", "rust-target-harness");
  return path.join(cargoTarget, "debug", "harness-webfetch-cli");
}

export function makeWebFetchExecutorRust(
  session: WebFetchSessionConfig,
): RustWebFetchRunner {
  const tool: OllamaTool = {
    type: "function",
    function: {
      name: webfetchToolDefinition.name,
      description: webfetchToolDefinition.description,
      parameters: webfetchToolDefinition.inputSchema as unknown as Record<
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
        handler.reject(new Error("harness-webfetch-cli exited unexpectedly"));
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
      process.stderr.write(`[harness-webfetch-cli] ${chunk.toString("utf8")}`);
    });
    proc = p;
    return p;
  }

  function sessionSpec() {
    return {
      roots: session.permissions.roots,
      sensitive_patterns: session.permissions.sensitivePatterns ?? [],
      bypass_workspace_guard:
        session.permissions.bypassWorkspaceGuard ?? false,
      unsafe_allow_fetch_without_hook:
        session.permissions.unsafeAllowFetchWithoutHook ?? false,
      default_headers: session.defaultHeaders ?? null,
      allow_loopback: session.allowLoopback ?? false,
      allow_private_networks: session.allowPrivateNetworks ?? false,
      allow_metadata: session.allowMetadata ?? false,
      default_timeout_ms: session.defaultTimeoutMs ?? null,
      session_backstop_ms: session.sessionBackstopMs ?? null,
      max_redirects: session.maxRedirects ?? null,
      inline_markdown_cap: session.inlineMarkdownCap ?? null,
      inline_raw_cap: session.inlineRawCap ?? null,
      spill_hard_cap: session.spillHardCap ?? null,
      spill_dir: session.spillDir ?? null,
      session_id: session.sessionId ?? null,
    };
  }

  function sendCall(params: unknown): Promise<string> {
    const p = ensureProc();
    const id = nextId++;
    const payload = {
      id,
      method: "webfetch",
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
