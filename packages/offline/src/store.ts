// The generic offline store: implements the client's `StorageAdapter` over any `OfflineBackend`.
//
// Replication by ownership. Every confirmed value of an *offline* query (registered to run locally, or listed in
// `sync`) owns the complete documents it contains. A row is kept while at least one stored query record owns it;
// when the last owner's new server value no longer contains it (deleted, or moved out of every cached range), the
// row is deleted. So the replica is always the union of the last server results of the offline queries — never a
// row the server did not return, never a row no stored result vouches for. Other queries only get their last value
// cached (`source: "cache"`).

import {
  decodeJson,
  encodeJson,
  getFunctionName,
  stableStringify,
  type LocalIdentity,
  type LocalQueryRequest,
  type LocalQueryResult,
  type PendingMutationRecord,
  type PendingStorage,
  type QueryUpdate,
  type StorageAdapter,
  type SyncSpec,
} from "@freecorps/ember-client";
import {
  documentsIn,
  localQueryRegistry,
  localTableOfId,
  runLocalQuery,
  type AnyRegisteredFunction,
  type LocalSchema,
} from "@freecorps/ember-server";
import { recordKey, type Commit, type OfflineBackend, type QueryRecord } from "./backend.ts";

export interface OfflineOptions {
  /** The app's schema (`ember/schema.ts` default export): tables, indexes, index kinds. */
  schema: LocalSchema;
  /**
   * Queries that may run on the client, by name: `{ "messages:list": list }` or modules `{ messages }` — the same
   * `query()` definitions the server registers (import them from your `ember/` modules). Only public queries are
   * accepted. Their results are replicated row by row and they run locally on cold start / offline.
   */
  queries?: unknown;
  /** Queries kept subscribed for the client's whole life, so their rows stay replicated (e.g. "last 90 days"). */
  sync?: SyncSpec[];
  /** Cached query records kept (least recently refreshed are evicted first). Default 500. */
  maxQueries?: number;
  /** Records not refreshed by the server for this long are dropped on load (with the rows only they own). Default 30 days. */
  retentionMs?: number;
  now?: () => number;
}

const DAY = 86_400_000;

export class OfflineStore implements StorageAdapter {
  readonly sync: readonly SyncSpec[];
  readonly persistPending: PendingStorage;
  private readonly registry: Map<string, AnyRegisteredFunction>;
  private readonly replicated: Set<string>;
  private readonly records = new Map<string, QueryRecord>();
  /** `${shard}\0${id}` → number of records owning the row. */
  private readonly refs = new Map<string, number>();
  /** record key → id → stable JSON of the doc (lazy): unchanged rows are not rewritten. */
  private readonly sigs = new Map<string, Map<string, string>>();
  private meta: Record<string, string> = {};
  private chain: Promise<unknown> = Promise.resolve();
  private opened: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly backend: OfflineBackend,
    private readonly options: OfflineOptions,
  ) {
    this.registry = localQueryRegistry(options.queries ?? {});
    this.sync = options.sync ?? [];
    this.now = options.now ?? Date.now;
    this.replicated = new Set([...this.registry.keys(), ...this.sync.map((s) => getFunctionName(s.query))]);
    // Through the same write queue as results, so `flush()` covers the pending queue too.
    this.persistPending = {
      getClientId: () => this.enqueue(async () => this.meta.clientId ?? null),
      setClientId: (id: string) =>
        this.enqueue(async () => {
          this.meta.clientId = id;
          await this.backend.setMeta("clientId", id);
        }),
      load: () => this.enqueue(async () => await this.backend.loadPending()),
      put: (r: PendingMutationRecord) => this.enqueue(async () => void (await this.backend.putPending(r))),
      remove: (mid: string) => this.enqueue(async () => void (await this.backend.removePending(mid))),
    };
  }

  /** Names of the queries that run locally. */
  get localQueries(): string[] {
    return [...this.registry.keys()];
  }

  async load(): Promise<{ identity: LocalIdentity | null }> {
    await this.open();
    const raw = this.meta.identity;
    let identity: LocalIdentity | null = null;
    try {
      identity = raw ? (decodeJson(raw) as LocalIdentity) : null;
    } catch {
      identity = null;
    }
    return { identity };
  }

  private open(): Promise<void> {
    if (!this.opened) {
      this.opened = (async () => {
        const { meta, queries } = await this.backend.open();
        this.meta = { ...meta };
        for (const r of queries) {
          this.records.set(r.key, r);
          for (const id of r.ids) this.ref(r.shard, id, +1);
        }
        // Retention: what the server has not refreshed for too long goes, with the rows only it owned.
        const cutoff = this.now() - (this.options.retentionMs ?? 30 * DAY);
        const stale = [...this.records.values()].filter((r) => r.updatedAt < cutoff);
        if (stale.length) await this.dropRecords(stale);
      })();
      this.chain = this.opened.catch(() => undefined);
    }
    return this.opened;
  }

  private ref(shard: string, id: string, d: number): number {
    const k = `${shard}\u0000${id}`;
    const n = (this.refs.get(k) ?? 0) + d;
    if (n > 0) this.refs.set(k, n);
    else this.refs.delete(k);
    return n;
  }

  private enqueue<T>(f: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() => this.open()).then(f);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Resolves when every write handed to the store so far is committed. */
  flush(): Promise<void> {
    return this.enqueue(async () => {});
  }

  applyPatch(u: QueryUpdate): Promise<void> {
    return this.enqueue(() => this.apply(u));
  }

  private sigsOf(r: QueryRecord): Map<string, string> {
    let m = this.sigs.get(r.key);
    if (!m) {
      m = new Map(documentsIn(this.options.schema.manifest, r.value).map(({ doc }) => [doc._id, stableStringify(doc)]));
      this.sigs.set(r.key, m);
    }
    return m;
  }

  private async apply(u: QueryUpdate): Promise<void> {
    const m = this.options.schema.manifest;
    const key = recordKey(u.shard, u.fn, u.argsJson);
    const prev = this.records.get(key);
    const docs = this.replicated.has(u.fn) ? documentsIn(m, u.value) : [];
    const oldSigs = prev ? this.sigsOf(prev) : new Map<string, string>();
    const newSigs = new Map<string, string>();
    const c: Commit = { put: [], upsert: [], delete: [] };
    // Refcount changes are applied as computed and undone if the commit fails, so memory never runs ahead of storage.
    const deltas: Array<[string, number]> = [];
    const ref = (id: string, d: number) => {
      deltas.push([id, d]);
      return this.ref(u.shard, id, d);
    };
    for (const { table, doc } of docs) {
      const sig = stableStringify(doc);
      newSigs.set(doc._id, sig);
      if (oldSigs.get(doc._id) !== sig) c.upsert!.push({ table, doc });
      if (!oldSigs.has(doc._id)) ref(doc._id, +1);
    }
    for (const id of prev?.ids ?? []) {
      if (newSigs.has(id)) continue;
      if (ref(id, -1) === 0) {
        const table = localTableOfId(m, id);
        if (table) c.delete!.push({ table, id });
      }
    }
    const record: QueryRecord = {
      key,
      shard: u.shard,
      fn: u.fn,
      args: u.args,
      argsJson: u.argsJson,
      value: u.value,
      version: u.version,
      updatedAt: this.now(),
      ids: [...newSigs.keys()],
    };
    c.put!.push(record);
    try {
      await this.backend.commit(u.shard, c);
    } catch (e) {
      for (const [id, d] of deltas.reverse()) this.ref(u.shard, id, -d);
      throw e;
    }
    this.records.set(key, record);
    this.sigs.set(key, newSigs);
    await this.evict(key);
  }

  /** Over `maxQueries`: drop the least recently refreshed records (never the one just written). */
  private async evict(keep: string): Promise<void> {
    const max = this.options.maxQueries ?? 500;
    if (this.records.size <= max) return;
    const victims = [...this.records.values()]
      .filter((r) => r.key !== keep)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, this.records.size - max);
    await this.dropRecords(victims);
  }

  private async dropRecords(rs: QueryRecord[]): Promise<void> {
    const m = this.options.schema.manifest;
    const byShard = new Map<string, Commit>();
    for (const r of rs) {
      let c = byShard.get(r.shard);
      if (!c) byShard.set(r.shard, (c = { drop: [], delete: [] }));
      c.drop!.push(r.key);
      this.records.delete(r.key);
      this.sigs.delete(r.key);
      for (const id of r.ids) {
        if (this.ref(r.shard, id, -1) === 0) {
          const table = localTableOfId(m, id);
          if (table) c.delete!.push({ table, id });
        }
      }
    }
    for (const [shard, c] of byShard) await this.backend.commit(shard, c);
  }

  async runQueryLocally(req: LocalQueryRequest): Promise<LocalQueryResult | undefined> {
    await this.flush();
    const cached = this.records.get(recordKey(req.shard, req.fn, req.argsJson));
    const fn = this.registry.get(req.fn);
    if (!fn) return cached ? { value: cached.value, source: "cache" } : undefined;
    try {
      return { value: await this.runLocal(fn, req), source: "local" };
    } catch (e) {
      if (cached) return { value: cached.value, source: "cache" };
      throw e;
    }
  }

  /** Runs a registered query over a shard's replica (re-running after async fetches until nothing is missing). */
  private async runLocal(fn: AnyRegisteredFunction, req: LocalQueryRequest): Promise<unknown> {
    const reader = this.backend.reader(req.shard);
    for (let attempt = 0; ; attempt++) {
      let value: unknown;
      let error: unknown;
      let failed = false;
      try {
        value = runLocalQuery(fn, req.args, { schema: this.options.schema, reader, identity: req.identity, now: this.now() }).value;
      } catch (e) {
        failed = true;
        error = e;
      }
      if (reader.misses && reader.fetch) {
        if (attempt >= 1000) throw new Error(`${req.fn}: too many storage round trips`);
        await reader.fetch();
        continue;
      }
      if (failed) throw error;
      return value;
    }
  }

  async setIdentity(identity: LocalIdentity | null): Promise<void> {
    await this.enqueue(async () => {
      const v = identity ? encodeJson(identity) : null;
      if (v === null) delete this.meta.identity;
      else this.meta.identity = v;
      await this.backend.setMeta("identity", v);
    });
  }

  /** Forget every cached result and replicated row (e.g. on sign-out on a shared device). Pending mutations stay. */
  async clear(): Promise<void> {
    await this.enqueue(() => this.dropRecords([...this.records.values()]));
  }

  async close(): Promise<void> {
    await this.flush().catch(() => undefined);
    await this.backend.close();
  }
}

/** A `StorageAdapter` over any backend. */
export function createOfflineStorage(backend: OfflineBackend, options: OfflineOptions): OfflineStore {
  return new OfflineStore(backend, options);
}
