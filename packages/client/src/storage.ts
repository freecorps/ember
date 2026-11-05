import type { FunctionReference } from "./functions.ts";

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

// ------------------------------------------------------------------------------------------------ offline storage

/** Who local queries run as: decoded from the last JWT the client saw (`sub`, `iss`), never verified locally. */
export interface LocalIdentity {
  subject: string;
  issuer?: string;
}

/** A server-confirmed value of a subscribed query (`snap` or `patch`). */
export interface QueryUpdate {
  shard: string;
  fn: string;
  args: Record<string, unknown>;
  /** `stableStringify(args)`: the client's identity for `(fn, args)`. */
  argsJson: string;
  value: unknown;
  /** The shard's version this value is current as of (only comparable within one `epoch`). */
  version: number;
  /**
   * The shard's epoch (`ready.epoch`) the value was computed under. A restore (PITR) starts a new epoch and may
   * reuse versions, so stores compare versions only within an epoch. Absent: unknown.
   */
  epoch?: string;
}

export interface LocalQueryRequest {
  shard: string;
  fn: string;
  args: Record<string, unknown>;
  argsJson: string;
  identity: LocalIdentity | null;
}

/** `local`: computed now from replicated rows; `cache`: the last server value stored for these args. */
export interface LocalQueryResult {
  value: unknown;
  source: "local" | "cache";
}

/** A query the client keeps subscribed while it lives, so its rows stay replicated (e.g. "the last 90 days"). */
export interface SyncSpec {
  query: string | FunctionReference<"query">;
  args?: Record<string, unknown>;
  /** Default: the client's `defaultShard`. */
  shard?: string;
}

/**
 * Optional offline-first storage (PLAN §10, docs/design/contracts.md "Offline"). Implemented by
 * `@freecorps/ember-offline` (IndexedDB, expo-sqlite / SQLite, memory). The client:
 * - calls `load()` once before anything else (open, migrate, read the last identity);
 * - keeps the clientId and the pending mutation queue in `persistPending` (survives restarts, replayed on connect);
 * - shows `watchQueryLocally()` / `runQueryLocally()` for a subscription until the server's first value arrives
 *   (cold start, offline), re-rendering when the replica changes underneath;
 * - hands every confirmed value to `applyPatch()` (persist the result, reconcile the replicated rows);
 * - subscribes to `sync` for its whole life.
 */
export interface StorageAdapter {
  load(): Promise<{ identity?: LocalIdentity | null } | void>;
  readonly persistPending: PendingStorage;
  /** Called in server order; the adapter serializes its writes. */
  applyPatch(update: QueryUpdate): Promise<void> | void;
  /** A local value for a subscription, or undefined (not registered offline and nothing cached). */
  runQueryLocally(request: LocalQueryRequest): Promise<LocalQueryResult | undefined> | LocalQueryResult | undefined;
  /**
   * Optional, preferred over `runQueryLocally`: the local value now and again whenever the replica changes in a way
   * that may affect it (rows this query read, the cached value of these args, another tab's writes). The client
   * watches until the server's first value arrives, then unwatches (the server value wins).
   */
  watchQueryLocally?(request: LocalQueryRequest, onResult: (result: LocalQueryResult | undefined) => void, onError?: (e: Error) => void): () => void;
  /** Remember who local queries run as (null on sign-out). */
  setIdentity?(identity: LocalIdentity | null): Promise<void> | void;
  readonly sync?: readonly SyncSpec[];
  /** Wait for queued writes. */
  flush?(): Promise<void>;
  close?(): Promise<void> | void;
}

export const isStorageAdapter = (s: unknown): s is StorageAdapter =>
  typeof s === "object" && s !== null && typeof (s as StorageAdapter).applyPatch === "function" && typeof (s as StorageAdapter).runQueryLocally === "function" &&
  typeof (s as StorageAdapter).persistPending?.load === "function";
