import path from "node:path";
import { ripgrep } from "ripgrep";
import type { GlobEngine, GlobEngineInput } from "./types.js";

/**
 * Line-buffered Writable that yields full lines from rg's stdout.
 *
 * IMPORTANT: no `fd` property. pi0/ripgrep prefers Node's built-in `node:wasi`
 * when a numeric `fd` is present, which writes directly to the real fd and
 * bypasses this `write` callback — leaking ripgrep's output onto the host's
 * process.stdout. Omitting `fd` forces the bundled WASI shim, which honors
 * the `write` callback. Same fix as @agent-sh/harness-grep's LineQueue.
 */
class LineQueue {
  private readonly lines: string[] = [];
  private readonly waiters: Array<(v: IteratorResult<string>) => void> = [];
  private buffer = "";
  private done = false;

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
    if (waiter) waiter({ value: line, done: false });
    else this.lines.push(line);
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

function buildArgs(input: GlobEngineInput): string[] {
  // Enumerate files respecting .gitignore + hidden-file + .git rules.
  // We DO NOT pass `--glob=<pattern>` here — adding a whitelist --glob to
  // rg overrides its default ignore posture (observed in a probe: a
  // `--glob=*.ts` call includes gitignored .ts files). Pattern filtering
  // happens in-process against the enumeration using picomatch with
  // bash-glob semantics, which matches what most models learn first.
  return [
    "--files",
    "--no-config",
    "--no-messages",
    "--no-require-git",
    "--glob=!.git/*",
    `--max-filesize=${input.maxFilesize}`,
    "--",
    input.root,
  ];
}

function preopensFor(root: string): Record<string, string> {
  // WASI needs both the cwd and the search root preopened; map each
  // absolute path to itself so rg can resolve paths as given.
  const out: Record<string, string> = { ".": process.cwd() };
  if (path.isAbsolute(root)) out[root] = root;
  return out;
}

function normalize(p: string): string {
  // ripgrep emits `./a/b` or `a/b` relative to cwd. Resolve to absolute.
  const cleaned = p.replace(/^\.[\\/]/, "");
  return path.isAbsolute(cleaned)
    ? cleaned
    : path.resolve(process.cwd(), cleaned);
}

export const defaultGlobEngine: GlobEngine = {
  async *list(input: GlobEngineInput): AsyncGenerator<{ path: string }> {
    const queue = new LineQueue();
    const args = buildArgs(input);
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
        if (line.length === 0) continue;
        yield { path: normalize(line) };
      }
    } finally {
      await finalize;
    }
  },
};
