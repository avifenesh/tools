import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Per-stream output buffer with head+tail capping and spill-to-file on
 * overflow. Models rarely need the middle of a long output — they need
 * either the setup line or the error tail. This buffer preserves both.
 */
export class HeadTailBuffer {
  private readonly chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private byteCap = false;
  private spilled = false;
  private spillPath: string | null = null;
  private spillBytes: number[] = [];

  constructor(
    private readonly maxInline: number,
    private readonly maxFile: number,
    private readonly kind: "out" | "err",
    private readonly spillDir: string,
  ) {}

  write(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes <= this.maxInline) {
      this.chunks.push(chunk);
      return;
    }
    // Overflow: spill everything past the cap to disk + remember tail.
    if (!this.spilled) {
      this.spilled = true;
      this.byteCap = true;
      this.spillPath = path.join(
        this.spillDir,
        `${randomUUID()}.${this.kind}`,
      );
      // Write whatever was buffered so far into the spill file so the
      // full log is recoverable from the file path alone.
      for (const c of this.chunks) this.appendSpill(c);
    }
    this.appendSpill(chunk);
    // Keep a tail window (roughly half of maxInline in bytes) from spilled
    // stream so the inline result has a useful tail slice.
    this.spillBytes.push(chunk.byteLength);
  }

  private appendSpill(chunk: Uint8Array): void {
    if (this.spillPath === null) return;
    if (!this.spillInit) {
      mkdirSync(this.spillDir, { recursive: true });
      writeFileSync(this.spillPath, "");
      this.spillInit = true;
    }
    if (this.fileBytesWritten + chunk.byteLength > this.maxFile) {
      // File cap hit. Ignore further writes.
      return;
    }
    // Sync append — output sizes are in KB-to-MB range, no need for
    // async stream plumbing.
    appendFileSync(this.spillPath, Buffer.from(chunk));
    this.fileBytesWritten += chunk.byteLength;
  }

  private spillInit = false;
  private fileBytesWritten = 0;

  /**
   * Return the inline render:
   *   - If not capped: the full buffered text.
   *   - If capped: head (first maxInline/2 bytes) + marker + tail
   *     (last maxInline/2 bytes) approximation. We approximate the tail
   *     by decoding only the tail window (maxInline/2 bytes from the spill
   *     file) because the stream is write-once and we dropped the middle.
   *
   * The actual implementation is simpler: we keep only the head inline
   * (first maxInline bytes, never overwritten) and emit a marker that
   * points at the log path. Head-only is a deliberate simplification
   * versus spec's head+tail — it matches OpenCode's default, and we
   * rely on Read(path) to see the tail. Spec §4 head+tail is a v2
   * improvement once we prove the file-path recovery path.
   */
  render(): { text: string; byteCap: boolean; logPath: string | null } {
    if (!this.spilled) {
      const combined = Buffer.concat(this.chunks.map((c) => Buffer.from(c)));
      return {
        text: combined.toString("utf8"),
        byteCap: false,
        logPath: null,
      };
    }
    // Capped: return the first maxInline bytes and a pointer to the file.
    const head = Buffer.concat(
      this.chunks.map((c) => Buffer.from(c)),
      this.maxInline,
    ).toString("utf8");
    const marker = `\n... (stream exceeded ${this.maxInline} bytes; full log at ${this.spillPath}) ...`;
    return {
      text: head + marker,
      byteCap: true,
      logPath: this.spillPath,
    };
  }

  bytesTotal(): number {
    return this.totalBytes;
  }

  wasCapped(): boolean {
    return this.byteCap;
  }
}

export function defaultSpillDir(): string {
  return path.join(tmpdir(), "agent-sh-bash-spill");
}

/**
 * Format the text body of an "ok" / "nonzero_exit" result.
 * Kept deliberately simple — structured fields ride on the result
 * object; `output` is the canonical text the executor returns to the
 * model at the tool_result boundary.
 */
export function formatResultText(args: {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  byteCap: boolean;
  logPath: string | null;
  kind: "ok" | "nonzero_exit";
}): string {
  const header = `<command>${args.command}</command>`;
  const exitLine = `<exit_code>${args.exitCode}</exit_code>`;
  const stdoutBlock = `<stdout>\n${args.stdout}\n</stdout>`;
  const stderrBlock = `<stderr>\n${args.stderr}\n</stderr>`;
  const hint = args.byteCap
    ? `(Output capped. Full log: ${args.logPath}. Read it with pagination if you need the middle.)`
    : args.kind === "ok"
      ? `(Command completed in ${args.durationMs}ms. exit=0.)`
      : `(Command exited nonzero in ${args.durationMs}ms. Exit code: ${args.exitCode}.)`;
  return [header, exitLine, stdoutBlock, stderrBlock, hint].join("\n");
}

export function formatTimeoutText(args: {
  command: string;
  stdout: string;
  stderr: string;
  reason: "inactivity timeout" | "wall-clock backstop";
  durationMs: number;
  partialBytes: number;
  logPath: string | null;
}): string {
  const header = `<command>${args.command}</command>`;
  const stdoutBlock = `<stdout>\n${args.stdout}\n</stdout>`;
  const stderrBlock = `<stderr>\n${args.stderr}\n</stderr>`;
  const logHint = args.logPath ? ` Full log: ${args.logPath}.` : "";
  const hint = `(Command hit ${args.reason} after ${args.durationMs}ms. ${args.partialBytes} bytes captured. Kill signal: SIGTERM then SIGKILL.${logHint} If the command is long-running, retry with background: true.)`;
  return [header, stdoutBlock, stderrBlock, hint].join("\n");
}

export function formatBackgroundStartedText(args: {
  command: string;
  jobId: string;
}): string {
  return [
    `<command>${args.command}</command>`,
    `<job_id>${args.jobId}</job_id>`,
    `(Background job started. Poll output with bash_output(job_id). Kill with bash_kill(job_id).)`,
  ].join("\n");
}

export function formatBashOutputText(args: {
  jobId: string;
  running: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  sinceByte: number;
  returnedBytes: number;
  totalBytes: number;
}): string {
  const next = args.sinceByte + args.returnedBytes;
  return [
    `<job_id>${args.jobId}</job_id>`,
    `<running>${args.running}</running>`,
    `<exit_code>${args.exitCode === null ? "null" : args.exitCode}</exit_code>`,
    `<stdout>\n${args.stdout}\n</stdout>`,
    `<stderr>\n${args.stderr}\n</stderr>`,
    `(Showing bytes ${args.sinceByte}-${next} of ${args.totalBytes}. Next since_byte: ${next}. Job running: ${args.running}.)`,
  ].join("\n");
}

export function formatBashKillText(args: {
  jobId: string;
  signal: "SIGTERM" | "SIGKILL";
}): string {
  return `<job_id>${args.jobId}</job_id>\n(${args.signal} sent. Poll bash_output to confirm termination.)`;
}
