/**
 * Peer runner: dispatches W1–W8 style prompts against an external agent CLI
 * (today: opencode) and returns a trace shape compatible with our e2e asserts.
 *
 * Why: CLAUDE.md's thesis is "the description is the API." To validate that
 * our tool descriptions/error messages actually deliver, we run the same
 * fixture + prompt against a peer harness that has its own read/edit/write
 * descriptions, and compare behavior. We are NOT testing our executors here;
 * we are testing whether *their* tool surface produces equivalent trajectories
 * on the same fixtures.
 *
 * Currently only opencode is wired. Cline/aider can be added later behind the
 * same `runPeer()` surface by extending the switch on `peer`.
 *
 * opencode CLI reference (v1.14.19):
 *   opencode run --format json --dir <cwd> --model <provider/model>
 *     --dangerously-skip-permissions "<prompt>"
 * Event stream on stdout (one JSON per line):
 *   {type:"step_start"|"step_finish", ...}
 *   {type:"tool_use", part:{tool, state:{input, output}}}
 *   {type:"text", part:{text}}
 */

import { spawn } from "node:child_process";

export type Peer = "opencode";

export interface PeerRunOptions {
  readonly peer: Peer;
  /** opencode-format model id, e.g. "ollama/qwen3:8b". */
  readonly model: string;
  readonly cwd: string;
  readonly prompt: string;
  /** Hard cap on wall time. */
  readonly timeoutMs?: number;
  readonly onEvent?: (e: PeerEvent) => void;
}

export interface PeerToolCall {
  readonly name: string;
  readonly input: unknown;
  readonly output: string;
  readonly status: string;
}

export interface PeerRunResult {
  readonly peer: Peer;
  readonly model: string;
  readonly toolCalls: readonly PeerToolCall[];
  readonly toolSeq: readonly string[];
  readonly finalText: string;
  readonly events: readonly unknown[];
  readonly exitCode: number;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface PeerEvent {
  readonly type: string;
  readonly raw: unknown;
}

export async function runPeer(opts: PeerRunOptions): Promise<PeerRunResult> {
  if (opts.peer !== "opencode") {
    throw new Error(`Unsupported peer: ${opts.peer}`);
  }
  return runOpencode(opts);
}

async function runOpencode(opts: PeerRunOptions): Promise<PeerRunResult> {
  const start = Date.now();
  const args = [
    "run",
    "--format",
    "json",
    "--dir",
    opts.cwd,
    "--model",
    opts.model,
    "--dangerously-skip-permissions",
    opts.prompt,
  ];

  const proc = spawn("opencode", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
  }, timeoutMs);

  const exitCode: number = await new Promise((resolve) => {
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });

  const events: unknown[] = [];
  const toolCalls: PeerToolCall[] = [];
  const toolSeq: string[] = [];
  let finalText = "";

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    events.push(parsed);
    const e = parsed as {
      type?: string;
      part?: {
        type?: string;
        tool?: string;
        text?: string;
        state?: { status?: string; input?: unknown; output?: unknown };
      };
    };
    if (opts.onEvent && e.type) {
      opts.onEvent({ type: e.type, raw: parsed });
    }
    if (e.type === "tool_use" && e.part?.tool) {
      const name = e.part.tool;
      const input = e.part.state?.input ?? null;
      const outputRaw = e.part.state?.output;
      const output =
        typeof outputRaw === "string"
          ? outputRaw
          : outputRaw !== undefined
            ? JSON.stringify(outputRaw)
            : "";
      const status = e.part.state?.status ?? "unknown";
      toolCalls.push({ name, input, output, status });
      toolSeq.push(name);
    }
    if (e.type === "text" && typeof e.part?.text === "string") {
      finalText += (finalText ? "\n" : "") + e.part.text;
    }
  }

  return {
    peer: "opencode",
    model: opts.model,
    toolCalls,
    toolSeq,
    finalText,
    events,
    exitCode,
    stderr,
    durationMs: Date.now() - start,
    timedOut,
  };
}
