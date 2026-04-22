import { realpathSync } from "node:fs";
import path from "node:path";

const fileMutexes = new Map<string, Promise<void>>();

function canonicalKey(filePath: string): string {
  const abs = path.resolve(filePath);
  try {
    return realpathSync.native
      ? realpathSync.native(abs)
      : realpathSync(abs);
  } catch {
    return abs;
  }
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = canonicalKey(filePath);
  const prev = fileMutexes.get(key) ?? Promise.resolve();

  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  fileMutexes.set(
    key,
    prev.then(() => next),
  );

  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (fileMutexes.get(key) === next || fileMutexes.get(key) === prev.then(() => next)) {
      queueMicrotask(() => {
        if (fileMutexes.get(key) === next) fileMutexes.delete(key);
      });
    }
  }
}
