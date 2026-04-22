export interface CacheKey {
  readonly path: string;
  readonly mtime_ms: number;
  readonly size_bytes: number;
  readonly offset: number;
  readonly limit: number;
}

export interface CacheEntry<T> {
  readonly key: CacheKey;
  readonly value: T;
}

export interface Cache<T> {
  get(key: CacheKey): T | undefined;
  set(key: CacheKey, value: T): void;
  invalidate(path: string): void;
  clear(): void;
}

export class InMemoryCache<T> implements Cache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  private keyString(k: CacheKey): string {
    return `${k.path}|${k.mtime_ms}|${k.size_bytes}|${k.offset}|${k.limit}`;
  }

  get(k: CacheKey): T | undefined {
    const entry = this.store.get(this.keyString(k));
    return entry?.value;
  }

  set(k: CacheKey, value: T): void {
    this.store.set(this.keyString(k), { key: k, value });
  }

  invalidate(p: string): void {
    for (const key of Array.from(this.store.keys())) {
      if (key.startsWith(p + "|")) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }
}
