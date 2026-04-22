import path from "node:path";
import { ripgrep } from "ripgrep";
import type {
  GrepEngine,
  GrepEngineInput,
  RgCount,
  RgMatch,
} from "./types.js";

/**
 * ripgrep --json record shapes. We only consume a subset.
 */
interface RgBegin {
  type: "begin";
  data: { path: { text?: string } };
}
interface RgMatchRecord {
  type: "match";
  data: {
    path: { text?: string };
    lines: { text?: string };
    line_number: number;
  };
}
interface RgContext {
  type: "context";
  data: {
    path: { text?: string };
    lines: { text?: string };
    line_number: number;
  };
}
type RgRecord = RgBegin | RgMatchRecord | RgContext | { type: string };

/**
 * A minimal line-buffered Writable that yields each full line from stdout into
 * an async queue. pi0/ripgrep accepts any `{ write, fd }` shaped object for
 * stdout, and ripgrep writes newline-delimited JSON (--json), so a line split
 * is enough to stream one record at a time without buffering the whole thing.
 */
class LineQueue {
  private readonly lines: string[] = [];
  private readonly waiters: Array<(v: IteratorResult<string>) => void> = [];
  private buffer = "";
  private done = false;

  // IMPORTANT: no `fd` property. pi0/ripgrep prefers Node's built-in `node:wasi`
  // when a numeric `fd` is present, which writes directly to the real fd and
  // bypasses this `write` callback — leaking ripgrep's --json output onto the
  // host's process.stdout. Omitting `fd` forces the bundled WASI shim, which
  // honors the `write` callback.
  writable = {
    write: (chunk: Uint8Array | Buffer | string): boolean => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : Buffer.from(chunk).toString("utf8");
      this.buffer += text;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.push(line);
      }
      return true;
    },
  };

  private push(line: string): void {
    if (line.length === 0) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: line, done: false });
    } else {
      this.lines.push(line);
    }
  }

  end(): void {
    this.done = true;
    if (this.buffer.length > 0) {
      const tail = this.buffer;
      this.buffer = "";
      this.push(tail);
    }
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: (): Promise<IteratorResult<string>> => {
        const existing = this.lines.shift();
        if (existing !== undefined) {
          return Promise.resolve({ value: existing, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function buildArgs(input: GrepEngineInput, jsonMode: boolean): string[] {
  const args: string[] = [
    "--no-config",
    "--no-messages",
    "--no-require-git",
    "--glob=!.git/*",
    `--max-filesize=${input.maxFilesize}`,
    `--max-columns=${input.maxColumns}`,
  ];
  if (jsonMode) {
    args.push("--json");
  } else if (input.countOnly) {
    args.push("--count");
  }
  if (input.caseInsensitive) args.push("-i");
  if (input.multiline) args.push("-U", "--multiline-dotall");
  if (input.type) args.push(`--type=${input.type}`);
  if (input.glob) args.push(`--glob=${input.glob}`);
  if (!input.countOnly) {
    if (input.contextBefore && input.contextBefore > 0) {
      args.push(`-B${input.contextBefore}`);
    }
    if (input.contextAfter && input.contextAfter > 0) {
      args.push(`-A${input.contextAfter}`);
    }
  }
  args.push("--", input.pattern, input.root);
  return args;
}

function preopensFor(root: string): Record<string, string> {
  // WASI needs both the cwd and the search root preopened; map each
  // absolute path to itself so rg can resolve paths as given.
  const out: Record<string, string> = { ".": process.cwd() };
  if (path.isAbsolute(root)) out[root] = root;
  return out;
}

async function* runJson(
  input: GrepEngineInput,
  signal?: AbortSignal,
): AsyncGenerator<RgRecord> {
  const queue = new LineQueue();
  const args = buildArgs(input, true);
  const run = ripgrep(args, {
    buffer: false,
    stdout: queue.writable,
    preopens: preopensFor(input.root),
    returnOnExit: true,
  });
  // When rg finishes, flush the line queue so the iterator terminates.
  const finalize = run
    .catch(() => undefined)
    .finally(() => queue.end());

  // If an abort signal fires, the pi0/ripgrep promise has no cancellation
  // hook (WASI runs to completion). We stop yielding so the caller unblocks;
  // the WASI task will complete in the background and its output is dropped.
  const abortWatcher = signal
    ? new Promise<"aborted">((resolve) => {
        if (signal.aborted) return resolve("aborted");
        signal.addEventListener("abort", () => resolve("aborted"), {
          once: true,
        });
      })
    : null;

  try {
    for await (const line of queue) {
      if (signal?.aborted) return;
      let rec: RgRecord;
      try {
        rec = JSON.parse(line) as RgRecord;
      } catch {
        continue;
      }
      yield rec;
    }
  } finally {
    if (abortWatcher) {
      // drain but don't await cancellation; the WASI task has no kill handle
      void abortWatcher;
    }
    await finalize;
  }
}

function normalize(p: string): string {
  // ripgrep emits `./a/b` or `a/b` relative to cwd when searching a directory.
  // Resolve to absolute so callers always see a stable shape.
  const cleaned = p.replace(/^\.[\\/]/, "");
  return path.isAbsolute(cleaned) ? cleaned : path.resolve(process.cwd(), cleaned);
}

export const defaultGrepEngine: GrepEngine = {
  async *search(input: GrepEngineInput): AsyncGenerator<RgMatch> {
    for await (const rec of runJson(input, input.signal)) {
      if (rec.type === "match" || rec.type === "context") {
        const r = rec as RgMatchRecord | RgContext;
        const p = r.data.path.text;
        const text = r.data.lines.text ?? "";
        if (!p) continue;
        yield {
          path: normalize(p),
          lineNumber: r.data.line_number,
          text: text.endsWith("\n") ? text.slice(0, -1) : text,
          isContext: rec.type === "context",
        };
      }
    }
  },

  async *count(input: GrepEngineInput): AsyncGenerator<RgCount> {
    // --json emits `end` records with stats.matched_lines per file, but using
    // --count via a separate invocation is simpler and matches rg's own
    // "lines containing a match" semantics we document.
    const queue = new LineQueue();
    const args = buildArgs({ ...input, countOnly: true }, false);
    const run = ripgrep(args, {
      buffer: false,
      stdout: queue.writable,
      preopens: preopensFor(input.root),
      returnOnExit: true,
    });
    const finalize = run.catch(() => undefined).finally(() => queue.end());
    try {
      for await (const line of queue) {
        if (input.signal?.aborted) return;
        const sep = line.lastIndexOf(":");
        if (sep < 0) continue;
        const p = line.slice(0, sep);
        const n = Number.parseInt(line.slice(sep + 1), 10);
        if (!Number.isFinite(n)) continue;
        yield { path: normalize(p), count: n };
      }
    } finally {
      await finalize;
    }
  },
};

/**
 * Detect a ripgrep regex-compile error from its stderr shape. pi0/ripgrep
 * returns exit code 2 for bad regex; the stderr lines look like:
 *   regex parse error:
 *       interface{}
 *                ^
 *   error: repetition operator missing expression
 *
 * We expose this so the orchestrator can raise INVALID_REGEX with a useful
 * message rather than a generic failure.
 */
export async function compileProbe(
  pattern: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let stderr = "";
  // No `fd` — see the LineQueue comment. With nodeWasi the numeric fd would
  // bypass this callback and leak to the real stderr.
  const errWritable = {
    write: (chunk: Uint8Array | Buffer | string): boolean => {
      stderr +=
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : Buffer.from(chunk).toString("utf8");
      return true;
    },
  };
  // Use --regexp with an empty file list via stdin-style args. The simplest
  // portable probe is to aim rg at a file that does not exist, which still
  // forces regex compilation before the path check. Exit codes:
  //   2 = error (bad regex or no such file)
  //   0/1 = no error (compilation succeeded)
  const nonExistent = path.join(process.cwd(), ".__rg_compile_probe_nope__");
  const res = await ripgrep(
    ["--no-config", "--no-messages", "--", pattern, nonExistent],
    { buffer: true, stderr: errWritable, returnOnExit: true },
  );
  const combined = (res.stderr ?? "") + stderr;
  if (/regex parse error|error parsing regex/i.test(combined)) {
    return { ok: false, message: combined.trim() };
  }
  return { ok: true };
}
