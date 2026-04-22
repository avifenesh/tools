import { createReadStream, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

export type FsEntryType = "file" | "directory" | "symlink";

export interface FsStat {
  readonly type: FsEntryType;
  readonly size: number;
  readonly mtime_ms: number;
  readonly readonly: boolean;
}

export interface FsDirEntry {
  readonly name: string;
  readonly type: FsEntryType;
}

export interface ReadOperations {
  stat(p: string): Promise<FsStat | undefined>;
  readFile(p: string): Promise<Uint8Array>;
  readDirectory(p: string): Promise<readonly string[]>;
  readDirectoryEntries(p: string): Promise<readonly FsDirEntry[]>;
  realpath(p: string): Promise<string>;
  mimeType(p: string): string;
  openLineStream(
    p: string,
    opts: { signal?: AbortSignal },
  ): AsyncIterable<string>;
}

export function defaultNodeOperations(): ReadOperations {
  return {
    async stat(p) {
      try {
        const s = await fs.lstat(p);
        if (s.isSymbolicLink()) {
          return {
            type: "symlink",
            size: s.size,
            mtime_ms: s.mtimeMs,
            readonly: false,
          };
        }
        return {
          type: s.isDirectory() ? "directory" : "file",
          size: s.size,
          mtime_ms: s.mtimeMs,
          readonly: false,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },
    async readFile(p) {
      const buf = await fs.readFile(p);
      return new Uint8Array(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength,
      );
    },
    async readDirectory(p) {
      return await fs.readdir(p);
    },
    async readDirectoryEntries(p) {
      const entries = await fs.readdir(p, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        type: e.isSymbolicLink()
          ? ("symlink" as const)
          : e.isDirectory()
            ? ("directory" as const)
            : ("file" as const),
      }));
    },
    async realpath(p) {
      try {
        return realpathSync.native
          ? realpathSync.native(p)
          : await fs.realpath(p);
      } catch {
        return path.resolve(p);
      }
    },
    mimeType(p) {
      return guessMime(p);
    },
    openLineStream(p, opts) {
      const stream = createReadStream(p, { encoding: "utf8" });
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });
      const signal = opts.signal;
      const iter: AsyncIterableIterator<string> = (async function* () {
        try {
          for await (const line of rl) {
            if (signal?.aborted) break;
            yield line;
          }
        } finally {
          rl.close();
          stream.destroy();
        }
      })();
      return iter;
    },
  };
}

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".yml": "text/yaml",
  ".yaml": "text/yaml",
  ".toml": "text/plain",
};

function guessMime(p: string): string {
  const ext = path.extname(p).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}
