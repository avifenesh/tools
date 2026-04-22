import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { formatToolError, type ToolError } from "@agent-sh/harness-core";
import type { WriteSessionConfig } from "@agent-sh/harness-write";
import {
  writeToolDefinition,
  editToolDefinition,
  multieditToolDefinition,
} from "@agent-sh/harness-write";
import type { OllamaTool } from "./ollama.js";
import type { ToolExecutor } from "./agent.js";

/**
 * Rust-backed write/edit/multiedit executor trio. One CLI process per
 * session; all three tools share the same binary. The Rust CLI keeps
 * an in-process ledger; `registerRead` forwards TS-side read events so
 * read-before-edit gates pass when the TS `read` tool is in use
 * alongside Rust write.
 */

export interface RustWriteRunner {
  readonly write: ToolExecutor;
  readonly edit: ToolExecutor;
  readonly multiEdit: ToolExecutor;
  registerRead(path: string, content: string | Uint8Array): Promise<void>;
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
  const fromEnv = process.env.HARNESS_WRITE_RUST_BIN;
  if (fromEnv) return fromEnv;
  const cargoTarget =
    process.env.CARGO_TARGET_DIR ??
    path.join(process.env.HOME ?? ".", "rust-target-harness");
  return path.join(cargoTarget, "debug", "harness-write-cli");
}

function sha256Hex(input: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(typeof input === "string" ? Buffer.from(input, "utf8") : input);
  return h.digest("hex");
}

export function makeWriteExecutorsRust(
  session: WriteSessionConfig,
): RustWriteRunner {
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
        h.reject(new Error("harness-write-cli exited unexpectedly"));
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
      process.stderr.write(`[harness-write-cli] ${chunk.toString("utf8")}`);
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
    };
  }

  function sendCall(method: string, params: unknown): Promise<string> {
    const p = ensureProc();
    const id = nextId++;
    const payload =
      method === "read_record"
        ? { id, method, params }
        : { id, method, params: { params, session: sessionSpec() } };
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

  async function runRpc(method: string, args: unknown): Promise<string> {
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

  async function registerRead(
    p: string,
    content: string | Uint8Array,
  ): Promise<void> {
    const sha = sha256Hex(content);
    const bytes =
      typeof content === "string"
        ? Buffer.byteLength(content, "utf8")
        : content.length;
    await sendCall("read_record", {
      path: p,
      sha256: sha,
      size_bytes: bytes,
    });
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
    write: {
      tool: toOllamaTool(writeToolDefinition),
      execute: (args: unknown) => runRpc("write", args),
    },
    edit: {
      tool: toOllamaTool(editToolDefinition),
      execute: (args: unknown) => runRpc("edit", args),
    },
    multiEdit: {
      tool: toOllamaTool(multieditToolDefinition),
      execute: (args: unknown) => runRpc("multiedit", args),
    },
    registerRead,
    close,
  };
}
