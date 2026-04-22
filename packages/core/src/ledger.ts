export interface LedgerEntry {
  readonly path: string;
  readonly sha256: string;
  readonly mtime_ms: number;
  readonly size_bytes: number;
  readonly lines_returned: number;
  readonly offset: number;
  readonly limit: number;
  readonly timestamp_ms: number;
}

export interface Ledger {
  record(entry: LedgerEntry): void;
  getLatest(path: string): LedgerEntry | undefined;
  getAll(path: string): readonly LedgerEntry[];
  clear(): void;
}

export class InMemoryLedger implements Ledger {
  private readonly entries = new Map<string, LedgerEntry[]>();

  record(entry: LedgerEntry): void {
    const list = this.entries.get(entry.path) ?? [];
    list.push(entry);
    this.entries.set(entry.path, list);
  }

  getLatest(p: string): LedgerEntry | undefined {
    const list = this.entries.get(p);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  getAll(p: string): readonly LedgerEntry[] {
    return this.entries.get(p) ?? [];
  }

  clear(): void {
    this.entries.clear();
  }
}
