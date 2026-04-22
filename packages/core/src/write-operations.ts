import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface WriteOperations {
  /**
   * Write `bytes` to `target` atomically: write to a temp file in the same
   * directory, fsync, then rename over the target. On any failure, the temp
   * file is unlinked best-effort and the original target is left untouched.
   */
  writeAtomic(target: string, bytes: Uint8Array): Promise<void>;
  /**
   * Recursively create directory (`mkdir -p`). No-op if already exists.
   */
  mkdirp(dir: string): Promise<void>;
}

export function defaultNodeWriteOperations(): WriteOperations {
  return {
    async writeAtomic(target, bytes) {
      const dir = path.dirname(target);
      const base = path.basename(target);
      const rand = randomBytes(4).toString("hex");
      const tmp = path.join(dir, `.${base}.${process.pid}.${rand}.tmp`);

      let fd: number | undefined;
      try {
        fd = openSync(tmp, "wx", 0o644);
        let written = 0;
        while (written < bytes.length) {
          written += writeSync(fd, bytes, written, bytes.length - written);
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(tmp, target);
      } catch (err) {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            /* ignore */
          }
        }
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw err;
      }
    },
    async mkdirp(dir) {
      mkdirSync(dir, { recursive: true });
    },
  };
}
