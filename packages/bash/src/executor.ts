import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { KILL_GRACE_MS } from "./constants.js";
import type {
  BackgroundReadResult,
  BashExecutor,
  BashRunInput,
  BashRunResult,
} from "./types.js";

/**
 * Default local-subprocess executor.
 *
 * Launches the bash binary with `-c <command>` via the argv form of
 * node:child_process.spawn — NEVER the string-based shell-eval entry
 * point. The command string is passed as a single argument to the bash
 * binary, not interpolated into our own spawn args. All shell parsing
 * happens inside the child bash process.
 *
 * This executor ships unsandboxed; sandboxing is the job of adapter
 * packages that implement the same BashExecutor interface. See
 * packages/bash/src/types.ts.
 */
export function createLocalBashExecutor(opts?: {
  bashPath?: string;
  logDir?: string;
}): BashExecutor {
  const bashPath = opts?.bashPath ?? "/bin/bash";
  const logDir = opts?.logDir ?? path.join(tmpdir(), "agent-sh-bash-logs");
  mkdirSync(logDir, { recursive: true });

  interface Job {
    readonly id: string;
    readonly outPath: string;
    readonly errPath: string;
    running: boolean;
    exitCode: number | null;
    killed: boolean;
    proc: ReturnType<typeof spawn> | null;
  }

  const jobs = new Map<string, Job>();

  async function runForeground(input: BashRunInput): Promise<BashRunResult> {
    const child = spawn(bashPath, ["-c", input.command], {
      cwd: input.cwd,
      env: { ...input.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => input.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => input.onStderr(chunk));

    let killedBySignal = false;
    const onAbort = () => {
      killedBySignal = true;
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, KILL_GRACE_MS).unref();
      } catch {
        // best effort
      }
    };
    if (input.signal.aborted) {
      onAbort();
    } else {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    return new Promise((resolve) => {
      child.on("close", (code, signal) => {
        input.signal.removeEventListener("abort", onAbort);
        resolve({
          exitCode: code,
          killed: killedBySignal,
          signal: signal ?? null,
        });
      });
      child.on("error", () => {
        input.signal.removeEventListener("abort", onAbort);
        resolve({ exitCode: null, killed: killedBySignal, signal: null });
      });
    });
  }

  async function spawnBackground(args: {
    command: string;
    cwd: string;
    env: Readonly<Record<string, string>>;
  }): Promise<{ jobId: string }> {
    const jobId = randomUUID();
    const outPath = path.join(logDir, `${jobId}.out`);
    const errPath = path.join(logDir, `${jobId}.err`);
    const outStream = createWriteStream(outPath, { flags: "w" });
    const errStream = createWriteStream(errPath, { flags: "w" });

    const child = spawn(bashPath, ["-c", args.command], {
      cwd: args.cwd,
      env: { ...args.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    child.stdout.pipe(outStream);
    child.stderr.pipe(errStream);

    const job: Job = {
      id: jobId,
      outPath,
      errPath,
      running: true,
      exitCode: null,
      killed: false,
      proc: child,
    };
    jobs.set(jobId, job);

    child.on("close", (code) => {
      job.running = false;
      job.exitCode = code;
      job.proc = null;
    });
    child.on("error", () => {
      job.running = false;
      job.proc = null;
    });

    return { jobId };
  }

  async function readBackground(
    jobId: string,
    opts: { since_byte?: number; head_limit?: number },
  ): Promise<BackgroundReadResult> {
    const job = jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown job_id: ${jobId}`);
    }
    const since = opts.since_byte ?? 0;
    const limit = opts.head_limit ?? 30_720;
    const stdout = readSlice(job.outPath, since, limit);
    const stderr = readSlice(job.errPath, since, limit);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      running: job.running,
      exitCode: job.exitCode,
      totalBytesStdout: stdout.totalBytes,
      totalBytesStderr: stderr.totalBytes,
    };
  }

  async function killBackground(
    jobId: string,
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  ): Promise<void> {
    const job = jobs.get(jobId);
    if (!job || !job.proc) return;
    job.killed = true;
    try {
      job.proc.kill(signal);
      if (signal === "SIGTERM") {
        setTimeout(() => {
          if (job.running && job.proc) {
            try {
              job.proc.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, KILL_GRACE_MS).unref();
      }
    } catch {
      // ignore
    }
  }

  async function closeSession(): Promise<void> {
    for (const job of jobs.values()) {
      if (job.running && job.proc) {
        try {
          job.proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
  }

  return {
    run: runForeground,
    spawnBackground,
    readBackground,
    killBackground,
    closeSession,
  };
}

function readSlice(
  filePath: string,
  since: number,
  limit: number,
): { text: string; totalBytes: number } {
  if (!existsSync(filePath)) return { text: "", totalBytes: 0 };
  const totalBytes = statSync(filePath).size;
  if (since >= totalBytes) return { text: "", totalBytes };
  const end = Math.min(since + limit, totalBytes);
  const buf = readFileSync(filePath).subarray(since, end);
  return { text: buf.toString("utf8"), totalBytes };
}
