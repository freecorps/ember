/**
 * Where unconfirmed mutations live until the server answers. The default keeps them in memory; a persistent
 * implementation (localStorage, AsyncStorage, expo-sqlite) lets them survive a reload and be retried.
 * The server dedups by (identity, clientId, mid), so a retried mutation runs at most once — which is why the
 * clientId is stored next to the queue.
 */
export interface PendingMutationRecord {
  mid: string;
  shard: string;
  fn: string;
  args: Record<string, unknown>;
  /** ms since epoch. */
  createdAt: number;
}

export interface PendingStorage {
  /** The stable clientId, or null on first run. */
  getClientId(): string | null | Promise<string | null>;
  setClientId(clientId: string): void | Promise<void>;
  /** Unconfirmed mutations in send order. */
  load(): PendingMutationRecord[] | Promise<PendingMutationRecord[]>;
  put(record: PendingMutationRecord): void | Promise<void>;
  remove(mid: string): void | Promise<void>;
}

export class MemoryPendingStorage implements PendingStorage {
  private clientId: string | null = null;
  private readonly records = new Map<string, PendingMutationRecord>();
  getClientId() {
    return this.clientId;
  }
  setClientId(id: string) {
    this.clientId = id;
  }
  load() {
    return [...this.records.values()];
  }
  put(r: PendingMutationRecord) {
    this.records.set(r.mid, r);
  }
  remove(mid: string) {
    this.records.delete(mid);
  }
}

/** Minimal sync/async key-value API: `window.localStorage`, or an adapter over AsyncStorage. */
export interface KeyValueStore {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

/**
 * PendingStorage over a key-value store (one JSON blob). Args must be JSON/tagged-JSON serializable.
 * Writes are serialized so an async store never sees them out of order.
 */
export class KeyValuePendingStorage implements PendingStorage {
  private cache: PendingMutationRecord[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly kv: KeyValueStore,
    private readonly prefix = "ember",
    private readonly codec: { stringify(v: unknown): string; parse(s: string): unknown } = JSON,
  ) {}
  async getClientId() {
    return await this.kv.getItem(`${this.prefix}:clientId`);
  }
  async setClientId(id: string) {
    await this.kv.setItem(`${this.prefix}:clientId`, id);
  }
  async load() {
    const raw = await this.kv.getItem(`${this.prefix}:pending`);
    try {
      this.cache = raw ? (this.codec.parse(raw) as PendingMutationRecord[]) : [];
    } catch {
      this.cache = [];
    }
    return [...this.cache];
  }
  put(r: PendingMutationRecord) {
    return this.write((list) => [...list.filter((x) => x.mid !== r.mid), r]);
  }
  remove(mid: string) {
    return this.write((list) => list.filter((x) => x.mid !== mid));
  }
  private write(f: (l: PendingMutationRecord[]) => PendingMutationRecord[]): Promise<void> {
    const next = this.chain.then(async () => {
      if (!this.cache) await this.load();
      this.cache = f(this.cache!);
      await this.kv.setItem(`${this.prefix}:pending`, this.codec.stringify(this.cache));
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
