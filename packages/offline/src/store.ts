// The generic offline store: implements the client's `StorageAdapter` over any `OfflineBackend`.
//
// Replication by ownership. Every confirmed value of an *offline* query (registered to run locally, or listed in
// `sync`) owns the complete documents it contains. A row is kept while at least one stored query record owns it;
// when the last owner's new server value no longer contains it (deleted, or moved out of every cached range), the
// row is deleted. So the replica is always the union of the last server results of the offline queries — never a
// row the server did not return, never a row no stored result vouches for. Other queries only get their last value
// cached (`source: "cache"`).
//
// Values by reference, changes as row diffs. A replicated document is stored once, as a row; the record keeps a
// skeleton of its value where those documents are references `{ _id, $row: 1 }`. A new server value whose
// skeleton is a doc array (or an object holding doc arrays, such as a `{page}`: a value diff) is persisted as a diff
// against the previous skeleton (appended to the record's log,
// usually a few ids) plus the rows that changed; the record is rewritten whole (compaction) when the log would
// outgrow it. So a patch touching k rows of an n-row result writes O(k), not O(n).
//
// Writes in bursts. The client hands over every changed query of a server frame one by one; the updates queued
// together (nothing else in between) are applied in order in memory and committed as one backend transaction per
// shard. A commit that fails rolls the memory of all of them back (they all reject), as if each had failed alone.
//
// Reactive local results. `watchQueryLocally` keeps the read set of each local run (`runLocalQuery`) and re-runs
// the query when replicated rows change inside it (this store's writes, another tab's through the leader, or a
// backend's external writer), and re-sends a cached value when the record of its args changes.

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
  localReadSetMatches,
  localTableOfId,
  runLocalQuery,
  type AnyRegisteredFunction,
  type Doc,
  type ForeignIds,
  type LocalRowChange,
  type LocalSchema,
  type ReadSet,
} from "@freecorps/ember-server";
import { applyAnyDiff, isPlainObject, rowDiff, valueDiff } from "@freecorps/ember-values";
import {
  NeedData,
  ownerKey,
  recordKey,
  hasFingerprint,
  sameValue,
  UNKNOWN_OWNER,
  updateOwner,
  valueFingerprint,
  type BackendReader,
  type Commit,
  type ExternalChange,
  type OfflineBackend,
  type PendingOp as PendingWrite,
  type QueryLogEntry,
  type QueryRecord,
  type SavedNotice,
} from "./backend.ts";

export { ownerKey } from "./backend.ts";

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
  /**
   * Store replicated documents in values as row references and persist a changed value as a row diff appended to
   * the record's log (default true). `false` rewrites the whole value on every change (the previous format; kept
   * for measurements and as an escape hatch).
   */
  persistDiffs?: boolean;
  /**
   * The shard's table-number map of ids imported from Convex (`foreignIds` in the `ember import convex` report,
   * `{ convex: { "10001": "tasks", ... } }`). With it, imported documents are replicated row by row like any other,
   * and local runs resolve their ids by it. Without it the store cannot tell an imported id's table, so those
   * documents are not replicated (a row is never stored under a guessed table): local runs do not see them, and accept
   * a Convex-shaped id for any `v.id()` (`ValidateOptions.acceptId`; the server checks it again). Apps with imported
   * data pass the map.
   */
  foreignIds?: ForeignIds;
  /**
   * Replicated rows kept decoded in memory (least recently written or read first out; default 50 000): written ones
   * and read ones, so a re-run reads them without a backend round trip (IndexedDB) or a decode, gets the very objects
   * it got before (cheap to fingerprint and diff), and an unchanged row the server sends again is not rewritten. A row
   * out of it is read from the backend again when needed, and rewritten if the server sends it again.
   */
  maxCachedRows?: number;
  now?: () => number;
}

/** A stored record in memory: the persisted skeleton (after replaying its log) and, once known, the full value. */
interface Rec {
  key: string;
  shard: string;
  fn: string;
  args: Record<string, unknown>;
  argsJson: string;
  version: number;
  epoch: string | undefined;
  ik: string | undefined;
  owner: string | undefined;
  updatedAt: number;
  ids: string[];
  skel: unknown;
  refs: boolean;
  /** `value` is the full value (else: resolve the skeleton's row references first). */
  materialized: boolean;
  value: unknown;
  seq: number;
  logCount: number;
  logBytes: number;
  /** Encoded size of the persisted base (0: unknown → the next change compacts). */
  baseBytes: number;
  /** `encodeJson` of the full value, once computed (a local run equal to it may `resume` from this record). */
  json?: string | undefined;
  /** `valueFingerprint` of the full value (undefined: unknown, a record or entry written before it). */
  fp: string | undefined;
}

/** The updates of one burst for one shard: one merged commit, and how to undo their effect on memory. */
interface ShardTx {
  puts: Map<string, QueryRecord>;
  drops: Set<string>;
  appends: Map<string, QueryLogEntry[]>;
  /** `${table}\0${id}` → the row's last write in the burst. */
  rows: Map<string, { table: string; doc: Doc } | { table: string; id: string }>;
  changes: LocalRowChange[];
  keys: Set<string>;
  undo: Array<() => void>;
}

type Pending = { u: QueryUpdate; resolve(): void; reject(e: unknown): void };

/** A pending-queue write (`persistPending.put` with `record`, `.remove` without) waiting in a batch. */
type PendingOp = PendingWrite & { resolve(): void; reject(e: unknown): void };

interface Watch {
  req: LocalQueryRequest;
  key: string;
  fn: AnyRegisteredFunction | undefined;
  readSet: ReadSet | null;
  /** The last result sent (null: none yet). */
  last: LocalQueryResult | undefined | null;
  dirty: boolean;
  closed: boolean;
  failed: boolean;
  onResult(r: LocalQueryResult | undefined): void;
  onError?(e: Error): void;
}

const DAY = 86_400_000;
/** Log entries per record before it is rewritten whole. */
const MAX_LOG = 64;
const ROW = "$row";

const isRef = (x: unknown): x is { _id: string; $row: 1 } =>
  isPlainObject(x) && x[ROW] === 1 && typeof x._id === "string" && Object.keys(x).length === 2;

/** `value` with the documents of `docs` (by identity) replaced by row references. */
function toSkeleton(value: unknown, docs: Set<object>): unknown {
  if (Array.isArray(value)) return value.map((x) => toSkeleton(x, docs));
  if (!isPlainObject(value)) return value;
  if (docs.has(value)) return { _id: value._id, [ROW]: 1 };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(value)) out[k] = toSkeleton(x, docs);
  return out;
}

function refsIn(skel: unknown, out: string[] = []): string[] {
  if (Array.isArray(skel)) for (const x of skel) refsIn(x, out);
  else if (isRef(skel)) out.push(skel._id);
  else if (isPlainObject(skel)) for (const x of Object.values(skel)) refsIn(x, out);
  return out;
}

function resolveRefs(skel: unknown, row: (id: string) => Doc): unknown {
  if (Array.isArray(skel)) return skel.map((x) => resolveRefs(x, row));
  if (isRef(skel)) return row(skel._id);
  if (!isPlainObject(skel)) return skel;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(skel)) out[k] = resolveRefs(x, row);
  return out;
}

export class OfflineStore implements StorageAdapter {
  readonly sync: readonly SyncSpec[];
  readonly persistPending: PendingStorage;
  private readonly registry: Map<string, AnyRegisteredFunction>;
  private readonly replicated: Set<string>;
  private readonly records = new Map<string, Rec>();
  /** Shards whose records the backend has not read yet (`OfflineBackend.openShard`). */
  private readonly unloaded = new Set<string>();
  /** `${shard}\0${id}` → number of records owning the row. */
  private readonly refs = new Map<string, number>();
  /** `${shard}\0${id}` → the row as last written / read (unknown after a restart until needed). */
  private readonly rows: RowCache;
  private readonly watches = new Set<Watch>();
  private rerunQueued = false;
  /** The burst of `applyPatch` calls still accepting more (closed by any other queued operation). */
  private burst: Pending[] | null = null;
  /** The batch of pending-queue writes still accepting more (closed by any queued operation but another one). */
  private pendingOps: PendingOp[] | null = null;
  private readonly saved = new Set<(n: SavedNotice) => void>();
  private meta: Record<string, string> = {};
  private chain: Promise<unknown> = Promise.resolve();
  private opened: Promise<void> | null = null;
  private stopExternal: (() => void) | null = null;
  private readonly now: () => number;

  constructor(
    private readonly backend: OfflineBackend,
    private readonly options: OfflineOptions,
  ) {
    this.registry = localQueryRegistry(options.queries ?? {});
    this.sync = options.sync ?? [];
    this.now = options.now ?? Date.now;
    this.rows = new RowCache(Math.max(1, options.maxCachedRows ?? 50_000));
    this.replicated = new Set([...this.registry.keys(), ...this.sync.map((s) => getFunctionName(s.query))]);
    // Through the same write queue as results, so `flush()` covers the pending queue too.
    this.persistPending = {
      getClientId: () => this.enqueue(async () => this.meta.clientId ?? null),
      setClientId: (id: string) =>
        this.enqueue(async () => {
          await this.backend.setMeta("clientId", id);
          this.meta.clientId = id;
        }),
      load: () => this.enqueue(async () => await this.backend.loadPending()),
      // Batched (see `queuePending`): a burst of updates queued before them stays open.
      put: (r: PendingMutationRecord) => this.queuePending({ mid: r.mid, record: r }),
      remove: (mid: string) => this.queuePending({ mid }),
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
        const { meta, queries, log = [], lazy } = await this.backend.open();
        this.meta = { ...meta };
        // Shards the backend did not read yet: their records load on first use (`ensureShard`).
        if (lazy && this.backend.openShard) for (const shard of lazy) this.unloaded.add(shard);
        await this.addRecords(queries, log);
        this.stopExternal = this.backend.onExternalChange?.((c) => this.onExternal(c)) ?? null;
      })();
      this.chain = this.opened.catch(() => undefined);
    }
    return this.opened;
  }

  /** Stored records (and their log) into memory; then retention drops what the server has not refreshed for too long. */
  private async addRecords(queries: QueryRecord[], log: QueryLogEntry[]): Promise<void> {
    const logs = new Map<string, QueryLogEntry[]>();
    for (const e of log) {
      const list = logs.get(e.key);
      if (list) list.push(e);
      else logs.set(e.key, [e]);
    }
    const cutoff = this.now() - (this.options.retentionMs ?? 30 * DAY);
    const stale: Rec[] = [];
    for (const r of queries) {
      const rec = this.replay(r, (logs.get(r.key) ?? []).sort((a, b) => a.seq - b.seq));
      this.records.set(rec.key, rec);
      for (const id of rec.ids) this.ref(rec.shard, id, +1);
      // Retention: with the rows only it owned. A log that does not apply: the same.
      if (rec.updatedAt < cutoff || rec.skel === BROKEN) stale.push(rec);
    }
    if (stale.length) await this.dropRecords(stale);
  }

  /**
   * A shard's records in memory before anything reads or writes it (a backend that opens shards lazily: only the
   * first use of each reads them). In the write queue, like every caller. A failed read leaves it unloaded (retried by
   * the next use) and fails this one.
   */
  private async ensureShard(shard: string): Promise<void> {
    if (!this.unloaded.has(shard)) return;
    const { queries, log = [] } = await this.backend.openShard!(shard);
    this.unloaded.delete(shard);
    await this.addRecords(queries, log);
  }

  /** A stored record with its log applied. A log that does not apply marks the record broken (dropped on open). */
  private replay(r: QueryRecord, entries: QueryLogEntry[]): Rec {
    let skel = r.value;
    let { version, updatedAt } = r;
    let epoch = r.epoch;
    let { ik, owner, fp } = r;
    const ids = new Set(r.ids);
    let seq = 0;
    let logBytes = 0;
    try {
      for (const e of entries) {
        skel = applyAnyDiff(skel, e.diff);
        version = e.version;
        epoch = e.epoch;
        // An entry without them (written before they existed) keeps what the record had.
        ik = e.ik ?? ik;
        owner = e.owner ?? owner;
        // The value changed: an entry without a fingerprint leaves it unknown (not the record's).
        fp = e.fp;
        updatedAt = e.updatedAt;
        for (const id of e.add) ids.add(id);
        for (const id of e.remove) ids.delete(id);
        seq = e.seq;
        logBytes += e.bytes ?? encodeJson(e.diff).length;
      }
    } catch {
      // Own every row any entry added, so dropping the record releases them all.
      for (const e of entries) for (const id of e.add) ids.add(id);
      skel = BROKEN;
    }
    const refs = r.refs === true;
    return {
      key: r.key,
      shard: r.shard,
      fn: r.fn,
      args: r.args,
      argsJson: r.argsJson,
      version,
      epoch,
      ik,
      owner,
      updatedAt,
      ids: [...ids],
      skel,
      refs,
      materialized: !refs,
      value: refs ? undefined : skel,
      seq,
      logCount: entries.length,
      logBytes,
      baseBytes: r.size ?? 0,
      fp,
    };
  }

  private ref(shard: string, id: string, d: number): number {
    const k = `${shard}\u0000${id}`;
    const n = (this.refs.get(k) ?? 0) + d;
    if (n > 0) this.refs.set(k, n);
    else this.refs.delete(k);
    return n;
  }

  /**
   * Queues `f` after everything handed over so far. `pending`: a batch of pending-queue writes, which leaves the
   * burst of updates queued before it open (see `queuePending`); anything else closes both.
   */
  private enqueue<T>(f: () => Promise<T>, pending = false): Promise<T> {
    // Anything queued after a burst of updates runs after it: later updates start a new burst.
    if (!pending) this.burst = null;
    // Nothing joins a batch of pending writes once anything else is queued after it: they never run earlier.
    this.pendingOps = null;
    const next = this.chain.then(() => this.open()).then(f);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Resolves when every write handed to the store so far is committed. */
  flush(): Promise<void> {
    return this.enqueue(async () => {});
  }

  applyPatch(u: QueryUpdate): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const item: Pending = { u, resolve, reject };
      if (this.burst) {
        this.burst.push(item);
        return;
      }
      const burst: Pending[] = [item];
      void this.enqueue(() => this.applyBurst(burst)).catch((e) => {
        // The store did not open: the burst never ran. Its updates fail (as each did alone before), and the next ones
        // start a new burst instead of joining this one.
        if (this.burst === burst) this.burst = null;
        for (const it of burst) it.reject(e);
      });
      this.burst = burst;
    });
  }

  /**
   * Pending-queue writes handed over together (nothing but other pending writes and updates in between) run as one
   * queue step: the last write of each `mid` (a put then a remove of the same mutation is one remove), in the order
   * the mids first came, each settling when its write is durable. Updates handed over while the batch waits may join
   * a burst queued before it — committed before these pending writes, never after: a confirmed value never waits on
   * the queue, and a mutation's removal never lands before a value queued ahead of it. So a server frame that settles
   * mutations between query updates (the client removes them a microtask later) does not split the burst.
   */
  private queuePending(op: Omit<PendingOp, "resolve" | "reject">): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const item: PendingOp = { ...op, resolve, reject };
      if (this.pendingOps) {
        this.pendingOps.push(item);
        return;
      }
      const batch: PendingOp[] = [item];
      void this.enqueue(() => this.writePending(batch), true).catch((e) => {
        // The store did not open: none of the batch ran.
        if (this.pendingOps === batch) this.pendingOps = null;
        for (const it of batch) it.reject(e);
      });
      this.pendingOps = batch;
    });
  }

  private async writePending(batch: PendingOp[]): Promise<void> {
    if (this.pendingOps === batch) this.pendingOps = null;
    const byMid = new Map<string, PendingOp[]>();
    for (const it of batch) {
      const list = byMid.get(it.mid);
      if (list) list.push(it);
      else byMid.set(it.mid, [it]);
    }
    if (this.backend.batchPending) {
      // One transaction for the whole batch: every write lands, or none (they all reject).
      const writes = [...byMid].map(([mid, ops]) => {
        const last = ops[ops.length - 1]!;
        return last.record ? { mid, record: last.record } : { mid };
      });
      try {
        await this.backend.batchPending(writes);
      } catch (e) {
        for (const it of batch) it.reject(e);
        return;
      }
      for (const it of batch) it.resolve();
      return;
    }
    for (const [mid, ops] of byMid) {
      const last = ops[ops.length - 1]!;
      try {
        if (last.record) await this.backend.putPending(last.record);
        else await this.backend.removePending(mid);
      } catch (e) {
        for (const it of ops) it.reject(e);
        continue;
      }
      for (const it of ops) it.resolve();
    }
  }

  /**
   * Called with what each burst made durable (records written, records dropped). `serveStorage` broadcasts it to the
   * other tabs, which then skip handing over values already stored (remote.ts).
   */
  onSaved(listener: (n: SavedNotice) => void): () => void {
    this.saved.add(listener);
    return () => this.saved.delete(listener);
  }

  private emitSaved(n: SavedNotice): void {
    if (!n.put.length && !n.drop.length) return;
    for (const l of this.saved) {
      try {
        l(n);
      } catch {
        /* a listener's problem */
      }
    }
  }

  /**
   * How long a stored value is not written again when the same one comes (the same version, owner and fingerprint):
   * half the retention window, at most a day, so `updatedAt` keeps the record from expiring while the server keeps
   * refreshing it.
   */
  private refreshAfter(): number {
    return Math.min(DAY, (this.options.retentionMs ?? 30 * DAY) / 2);
  }

  /** Applies a burst of updates in order, then commits once per shard (all of a shard's updates, or none of them). */
  private async applyBurst(items: Pending[]): Promise<void> {
    if (this.burst === items) this.burst = null;
    const txs = new Map<string, { tx: ShardTx; items: Pending[] }>();
    const failed = new Map<string, unknown>();
    for (const shard of new Set(items.map((it) => it.u.shard))) {
      try {
        await this.ensureShard(shard);
      } catch (e) {
        failed.set(shard, e);
      }
    }
    for (const it of items) {
      if (failed.has(it.u.shard)) {
        it.reject(failed.get(it.u.shard));
        continue;
      }
      let t = txs.get(it.u.shard);
      if (!t) txs.set(it.u.shard, (t = { tx: newTx(), items: [] }));
      try {
        await this.apply(it.u, t.tx);
        t.items.push(it);
      } catch (e) {
        it.reject(e);
      }
    }
    const done: Pending[] = [];
    const keep = new Set<string>();
    const notice: SavedNotice = { put: [], drop: [] };
    for (const [shard, { tx, items: mine }] of txs) {
      if (!mine.length) continue;
      const c = commitOf(tx);
      if (c) {
        try {
          await this.backend.commit(shard, c);
        } catch (e) {
          for (let i = tx.undo.length - 1; i >= 0; i--) tx.undo[i]!();
          for (const it of mine) it.reject(e);
          continue;
        }
      }
      for (const k of tx.keys) {
        keep.add(k);
        const r = this.records.get(k);
        if (r) notice.put.push([k, r.version, r.epoch ?? null, r.owner ?? null, r.fp ?? null, r.updatedAt + this.refreshAfter()]);
      }
      this.notify(shard, tx.changes, [...tx.keys]);
      done.push(...mine);
    }
    this.emitSaved(notice);
    try {
      await this.evict(keep);
    } catch (e) {
      for (const it of done) it.reject(e);
      return;
    }
    for (const it of done) it.resolve();
  }

  /**
   * The backend's reader for `shard` through the rows this store already knows (written or read since open): `get` is
   * answered from them (an async backend, IndexedDB, needs no round trip; a SQLite one no decode), a scanned row known
   * already comes back as the known object (a re-run returns the objects of the previous one: identity diffs and
   * memoized fingerprints), and what the backend reads is remembered. The known rows always hold what storage holds:
   * every write goes through `setRow`, every drop forgets them, an external writer's change forgets its shard's.
   */
  private reader(shard: string): BackendReader {
    const inner = this.backend.reader(shard);
    const m = this.options.schema.manifest;
    const rows = this.rows;
    const known = (table: string, doc: Doc): Doc => {
      const k = `${shard}\u0000${doc._id}`;
      const cached = rows.get(k);
      if (cached) return cached;
      if (localTableOfId(m, doc._id, this.options.foreignIds) === table) rows.set(k, doc);
      return doc;
    };
    const out: BackendReader = {
      get misses() {
        return inner.misses ?? 0;
      },
      scan: (table, index, lo, hi, asc, limit) => {
        const r = inner.scan(table, index, lo, hi, asc, limit);
        for (let i = 0; i < r.length; i++) {
          const doc = known(table, r[i]!.doc);
          if (doc !== r[i]!.doc) r[i] = { key: r[i]!.key, doc };
        }
        return r;
      },
      get: (table, id) => {
        const doc = rows.get(`${shard}\u0000${id}`);
        if (doc && localTableOfId(m, id, this.options.foreignIds) === table) return doc;
        const got = inner.get(table, id);
        return got ? known(table, got) : got;
      },
    };
    if (inner.pluginQuery) out.pluginQuery = (...a) => inner.pluginQuery!(...a);
    if (inner.fetch) out.fetch = () => inner.fetch!();
    return out;
  }

  /** Reads rows by id from the backend (async readers: fetch and retry until nothing is missing). */
  private async readRows(shard: string, ids: string[]): Promise<Map<string, Doc | null>> {
    const m = this.options.schema.manifest;
    const reader = this.backend.reader(shard);
    for (let attempt = 0; ; attempt++) {
      const out = new Map<string, Doc | null>();
      for (const id of ids) {
        const table = localTableOfId(m, id, this.options.foreignIds);
        if (!table) {
          out.set(id, null);
          continue;
        }
        try {
          out.set(id, reader.get(table, id));
        } catch (e) {
          if (!(e instanceof NeedData)) throw e;
        }
      }
      if (reader.misses && reader.fetch && attempt < 100) {
        await reader.fetch();
        continue;
      }
      // Rows still missing after the retries are reported as missing (null), never left out of the map.
      for (const id of ids) if (!out.has(id)) out.set(id, null);
      return out;
    }
  }

  /** The full value of a record (resolving its row references from the replica). */
  private async valueOf(rec: Rec): Promise<unknown> {
    if (rec.materialized) return rec.value;
    // Resolved from a map of its own: the known rows may drop some of these meanwhile (their LRU).
    const got = new Map<string, Doc>();
    const missing: string[] = [];
    for (const id of new Set(refsIn(rec.skel))) {
      const doc = this.rows.get(`${rec.shard}\u0000${id}`);
      if (doc) got.set(id, doc);
      else missing.push(id);
    }
    if (missing.length) {
      for (const [id, doc] of await this.readRows(rec.shard, missing)) {
        if (!doc) throw new Error(`offline store: replicated row ${id} of ${rec.fn} is missing`);
        this.know(rec.shard, doc);
        got.set(id, doc);
      }
    }
    rec.value = resolveRefs(rec.skel, (id) => got.get(id)!);
    rec.materialized = true;
    rec.json = undefined;
    return rec.value;
  }

  /** `encodeJson` of a record's full value (computed once per value). */
  private async jsonOf(rec: Rec): Promise<string> {
    const value = await this.valueOf(rec);
    return (rec.json ??= encodeJson(value));
  }

  /** Knows / forgets a row inside a burst, recording how to put the previous state back. */
  private setRow(tx: ShardTx, k: string, doc: Doc | null, sig?: string): void {
    const prev = this.rows.entry(k);
    tx.undo.push(() => {
      if (prev) this.rows.set(k, prev.doc, prev.sig);
      else this.rows.delete(k);
    });
    if (doc) this.rows.set(k, doc, sig);
    else this.rows.delete(k);
  }

  private know(shard: string, doc: Doc, sig?: string): void {
    this.rows.set(`${shard}\u0000${doc._id}`, doc, sig);
  }

  /**
   * One update of a burst: computes its writes against memory as the burst's previous updates left it, merges them
   * into the shard's pending commit and moves memory forward, recording the undo (the commit may still fail). An
   * update that throws here leaves nothing behind.
   */
  private async apply(u: QueryUpdate, tx: ShardTx): Promise<void> {
    const m = this.options.schema.manifest;
    const key = recordKey(u.shard, u.fn, u.argsJson);
    const prev = this.records.get(key);
    // Whose value it is. Unknown to the client (an opaque token): nobody's, never served — `EmberClient` sends
    // `ownerUnknown: true` (`QueryUpdate.ownerUnknown`) for every value whose owner it cannot tell: see `persist()` in
    // packages/client/src/client.ts and `test/resume.test.ts`. Not said at all (an older client, a direct caller of
    // the adapter): no owner, as before these fields existed, unless the record had one: a value of unknown provenance
    // never makes an owned record public.
    const owner = updateOwner(u) ?? (prev?.owner !== undefined ? UNKNOWN_OWNER : undefined);
    // Older than what is stored (another tab persisted a newer value first, or a call resent after a leader
    // handover): dropped, so the replica never goes back. Versions only compare within one shard epoch; a new
    // epoch (a restore reuses versions) or an unknown one is taken as it comes.
    const sameEpoch = prev !== undefined && prev.epoch !== undefined && prev.epoch === u.epoch;
    if (sameEpoch && u.version < prev.version) return;
    // The same version for the same known identity with the same value (its fingerprint, `valueFingerprint`): each
    // tab persists what it receives, so with N tabs this is one write instead of N. Only the fingerprint tells the
    // value: one can change at the same version without a commit (a debounced search re-run, an index that became
    // ready: the shard's `unbumpedAt`), and that one is written, whoever sends it (a new subscription's first value,
    // the retry of a write that failed). No owner or an unknown one, or a record without a fingerprint (written
    // before it): taken, the value may be another identity's. Coalesced, not dropped: past `refreshAfter()` it is
    // written again, so `updatedAt` keeps the record from expiring while the server keeps refreshing it.
    // The fingerprint is a structural hash memoized per object (`valueFingerprint`): the rows the client kept from the
    // previous value cost nothing. A match is confirmed by comparing the values in full (`sameValue`, identity first),
    // so a collision never skips a write.
    const fp = valueFingerprint(u.value);
    const coalesce =
      sameEpoch &&
      u.version === prev.version &&
      prev.fp === fp &&
      owner !== undefined &&
      owner !== UNKNOWN_OWNER &&
      prev.owner === owner &&
      this.now() - prev.updatedAt < this.refreshAfter();
    // The previous rows' content tells which rows are unchanged (not rewritten) and how changed rows moved (and, to
    // coalesce, whether the value is the same).
    if (prev && !prev.materialized) {
      // Resolved against memory as this burst left it (rows an earlier update of it wrote): undone with the burst,
      // or the record would keep rows its storage never got.
      await this.valueOf(prev).catch(() => undefined);
      if (prev.materialized) {
        tx.undo.push(() => {
          prev.materialized = false;
          prev.value = undefined;
          prev.json = undefined;
        });
      }
    }
    if (coalesce && prev.materialized && sameValue(prev.value, u.value)) return;
    const found = this.replicated.has(u.fn) ? documentsIn(m, u.value, undefined, this.options.foreignIds) : [];
    const prevIds = new Set(prev?.ids ?? []);
    const newIds = new Set<string>();
    const c: Commit = { upsert: [], delete: [] };
    const changes: LocalRowChange[] = [];
    const written: Array<{ doc: Doc; sig: string | undefined }> = [];
    const removed: string[] = [];
    // Refcount changes are applied as computed and undone if the commit fails, so memory never runs ahead of storage.
    const deltas: Array<[string, number]> = [];
    const ref = (id: string, d: number) => {
      deltas.push([id, d]);
      return this.ref(u.shard, id, d);
    };
    const before = (k: string): Doc | null | undefined => this.rows.get(k) ?? (this.refs.has(k) ? undefined : null);
    const docSet = new Set<object>(found.map((f) => f.doc));
    const diffs = this.options.persistDiffs !== false;
    const now = this.now();
    let skel: unknown;
    let entry: QueryLogEntry | null = null;
    let entryBytes = 0;
    /** `encodeJson` of the persisted base, when written whole. */
    let json: string | undefined;
    try {
      for (const { table, doc } of found) {
        const k = `${u.shard}\u0000${doc._id}`;
        newIds.add(doc._id);
        // The very object already stored (an unchanged row the client reused, or one read back): unchanged. Else its
        // signature against the known row's (computed now for a row only read so far: not rewritten after a restart).
        const known = this.rows.entry(k);
        const same = known !== undefined && known.doc === doc;
        const sig = same ? undefined : stableStringify(doc);
        if (!same && (known === undefined || this.rows.sigOf(k, known) !== sig)) {
          c.upsert!.push({ table, doc });
          changes.push({ table, id: doc._id, before: before(k), after: doc });
          written.push({ doc, sig });
        }
        if (!prevIds.has(doc._id)) ref(doc._id, +1);
      }
      for (const id of prevIds) {
        if (newIds.has(id)) continue;
        const k = `${u.shard}\u0000${id}`;
        const was = before(k);
        if (ref(id, -1) === 0) {
          const table = localTableOfId(m, id, this.options.foreignIds);
          if (table) {
            c.delete!.push({ table, id });
            changes.push({ table, id, before: was, after: null });
            removed.push(k);
          }
        }
      }
      skel = docSet.size && diffs ? toSkeleton(u.value, docSet) : u.value;
      if (prev && prev.skel !== BROKEN && diffs && prev.logCount < MAX_LOG && prev.baseBytes > 0) {
        // A doc array: a row diff; an object holding doc arrays (a `{page}`): a value diff (its rows' row diffs).
        const diff = rowDiff(prev.skel, skel) ?? valueDiff(prev.skel, skel);
        if (diff) {
          entryBytes = encodeJson(diff).length;
          if (prev.logBytes + entryBytes <= prev.baseBytes) {
            entry = {
              key,
              seq: prev.seq + 1,
              diff,
              version: u.version,
              ...(u.epoch !== undefined ? { epoch: u.epoch } : {}),
              ...(u.ik !== undefined ? { ik: u.ik } : {}),
              ...(owner !== undefined ? { owner } : {}),
              updatedAt: now,
              add: [...newIds].filter((id) => !prevIds.has(id)),
              remove: [...prevIds].filter((id) => !newIds.has(id)),
              bytes: entryBytes,
              fp,
            };
          }
        }
      }
      if (entry) c.append = [entry];
      else {
        const record: QueryRecord = {
          key,
          shard: u.shard,
          fn: u.fn,
          args: u.args,
          argsJson: u.argsJson,
          value: skel,
          version: u.version,
          ...(u.epoch !== undefined ? { epoch: u.epoch } : {}),
          ...(u.ik !== undefined ? { ik: u.ik } : {}),
          ...(owner !== undefined ? { owner } : {}),
          updatedAt: now,
          ids: [...newIds],
          size: 0,
          ...(docSet.size && diffs ? { refs: true as const } : {}),
          fp,
        };
        json = encodeJson(skel);
        record.size = json.length;
        c.put = [record];
      }
    } catch (e) {
      for (let i = deltas.length - 1; i >= 0; i--) this.ref(u.shard, deltas[i]![0], -deltas[i]![1]);
      throw e;
    }
    // Nothing below throws: merge into the burst's commit and move memory forward (undone if the commit fails).
    const baseBytes = entry ? (prev?.baseBytes ?? 0) : c.put![0]!.size!;
    tx.undo.push(() => {
      for (let i = deltas.length - 1; i >= 0; i--) this.ref(u.shard, deltas[i]![0], -deltas[i]![1]);
    });
    mergeInto(tx, c);
    for (const w of written) this.setRow(tx, `${u.shard}\u0000${w.doc._id}`, w.doc, w.sig);
    for (const k of removed) this.setRow(tx, k, null);
    tx.undo.push(prev ? () => this.records.set(key, prev) : () => this.records.delete(key));
    tx.changes.push(...changes);
    tx.keys.add(key);
    this.records.set(key, {
      key,
      shard: u.shard,
      fn: u.fn,
      args: u.args,
      argsJson: u.argsJson,
      version: u.version,
      epoch: u.epoch,
      ik: u.ik,
      owner,
      updatedAt: now,
      ids: [...newIds],
      skel,
      refs: docSet.size > 0 && diffs,
      materialized: true,
      value: u.value,
      seq: entry ? entry.seq : 0,
      logCount: entry ? prev!.logCount + 1 : 0,
      logBytes: entry ? prev!.logBytes + entryBytes : 0,
      baseBytes,
      // The full value's encoding, when that is what went to storage (no row references).
      json: skel === u.value ? json : undefined,
      fp,
    });
  }

  /** Over `maxQueries`: drop the least recently refreshed records (never one just written). */
  private async evict(keep: Set<string>): Promise<void> {
    const max = this.options.maxQueries ?? 500;
    const over = this.records.size - max;
    if (over <= 0) return;
    let victims: Rec[];
    if (over === 1) {
      // The usual case at capacity (one new record): the oldest, in one pass.
      let oldest: Rec | undefined;
      for (const r of this.records.values()) if (!keep.has(r.key) && (!oldest || r.updatedAt < oldest.updatedAt)) oldest = r;
      victims = oldest ? [oldest] : [];
    } else {
      victims = [...this.records.values()]
        .filter((r) => !keep.has(r.key))
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, over);
    }
    if (victims.length) await this.dropRecords(victims);
  }

  /**
   * Per shard: commit the drop first, then forget the records and their refcounts in memory, so a failed commit
   * leaves memory matching storage (shards committed before the failure stay dropped, as they are in storage).
   */
  private async dropRecords(rs: Rec[]): Promise<void> {
    const m = this.options.schema.manifest;
    const byShard = new Map<string, Rec[]>();
    for (const r of rs) {
      const list = byShard.get(r.shard);
      if (list) list.push(r);
      else byShard.set(r.shard, [r]);
    }
    for (const [shard, records] of byShard) {
      const c: Commit = { drop: records.map((r) => r.key), delete: [] };
      const changes: LocalRowChange[] = [];
      const dec = new Map<string, number>();
      for (const r of records) for (const id of r.ids) dec.set(id, (dec.get(id) ?? 0) + 1);
      for (const [id, n] of dec) {
        const k = `${shard}\u0000${id}`;
        if ((this.refs.get(k) ?? 0) - n > 0) continue;
        const table = localTableOfId(m, id, this.options.foreignIds);
        if (table) {
          c.delete!.push({ table, id });
          changes.push({ table, id, before: this.rows.get(k), after: null });
        }
      }
      await this.backend.commit(shard, c);
      for (const r of records) this.records.delete(r.key);
      for (const [id, n] of dec) {
        if (this.ref(shard, id, -n) > 0) continue;
        this.rows.delete(`${shard}\u0000${id}`);
      }
      this.notify(shard, changes, records.map((r) => r.key));
      this.emitSaved({ put: [], drop: records.map((r) => r.key) });
    }
  }

  async runQueryLocally(req: LocalQueryRequest): Promise<LocalQueryResult | undefined> {
    // In the write queue, like a watch's re-run: after every write handed over before it, and a run that waits for
    // the backend (async reader) never sees rows of a burst whose commit is still pending (and may fail).
    return (await this.enqueue(() => this.evaluate(req, this.registry.get(req.fn)))).result;
  }

  /**
   * The local result of a request (registered: run over the replica; else / on failure: the cached value). A local run
   * that is exactly the value cached for its owner carries that value's `version`/`epoch`/`ik`: it is the server's
   * value at that version, so the client may `resume` from it.
   */
  private async evaluate(req: LocalQueryRequest, fn: AnyRegisteredFunction | undefined): Promise<{ result: LocalQueryResult | undefined; readSet: ReadSet | null }> {
    await this.ensureShard(req.shard);
    const cached = this.records.get(recordKey(req.shard, req.fn, req.argsJson));
    // Only its owner's (an unknown owner is nobody's); one stored before owners were recorded is shown, never resumed.
    const mine = cached !== undefined && cached.owner !== undefined && cached.owner === ownerKey(req.identity);
    const resumable = mine && cached.epoch !== undefined && cached.ik !== undefined;
    const fromCache = async (): Promise<{ result: LocalQueryResult | undefined }> => {
      if (!cached) return { result: undefined };
      if (cached.owner !== undefined && !mine) return { result: undefined };
      try {
        const value = await this.valueOf(cached);
        return { result: resumable ? { value, source: "cache", version: cached.version, epoch: cached.epoch!, ik: cached.ik! } : { value, source: "cache" } };
      } catch {
        return { result: undefined };
      }
    };
    if (!fn) return { ...(await fromCache()), readSet: null };
    let local: { value: unknown; readSet: ReadSet };
    try {
      local = await this.runLocal(fn, req);
    } catch (e) {
      const c = await fromCache();
      if (c.result) return { ...c, readSet: null };
      throw e;
    }
    if (resumable) {
      // Is the local run the value the server sent at `cached.version`? Its fingerprint says so without resolving
      // the record's row references (a cold record: no backend reads) — and against the value as it was stored, not
      // re-read from rows another record may have moved past that version since. A record written before
      // fingerprints existed is compared by its encoding, as before.
      const same =
        cached.fp !== undefined
          ? hasFingerprint(local.value, cached.fp)
          : await this.jsonOf(cached).then(
              (j) => j === encodeJson(local.value),
              () => false,
            );
      if (same) return { result: { value: local.value, source: "local", version: cached.version, epoch: cached.epoch!, ik: cached.ik! }, readSet: local.readSet };
    }
    return { result: { value: local.value, source: "local" }, readSet: local.readSet };
  }

  /** Runs a registered query over a shard's replica (re-running after async fetches until nothing is missing). */
  private async runLocal(fn: AnyRegisteredFunction, req: LocalQueryRequest): Promise<{ value: unknown; readSet: ReadSet }> {
    const reader = this.reader(req.shard);
    for (let attempt = 0; ; attempt++) {
      let out: { value: unknown; readSet: ReadSet } | undefined;
      let error: unknown;
      try {
        out = runLocalQuery(fn, req.args, { schema: this.options.schema, reader, identity: req.identity, now: this.now(), ...(this.options.foreignIds ? { foreignIds: this.options.foreignIds } : {}) });
      } catch (e) {
        error = e;
      }
      if (reader.misses && reader.fetch) {
        if (attempt >= 1000) throw new Error(`${req.fn}: too many storage round trips`);
        await reader.fetch();
        continue;
      }
      if (!out) throw error;
      return out;
    }
  }

  // ---------------------------------------------------------------------------------------------- reactive local results

  /**
   * The local result of `req` now, and again whenever it may have changed: a registered query re-runs when rows
   * inside its read set change; any request re-reads when the cached record of its args changes. Results equal to
   * the last one sent are not re-sent.
   */
  watchQueryLocally(req: LocalQueryRequest, onResult: (r: LocalQueryResult | undefined) => void, onError?: (e: Error) => void): () => void {
    const w: Watch = {
      req,
      key: recordKey(req.shard, req.fn, req.argsJson),
      fn: this.registry.get(req.fn),
      readSet: null,
      last: null,
      dirty: false,
      closed: false,
      failed: false,
      onResult,
      ...(onError ? { onError } : {}),
    };
    this.watches.add(w);
    this.schedule([w]);
    return () => {
      w.closed = true;
      this.watches.delete(w);
    };
  }

  private schedule(ws: Iterable<Watch>): void {
    let any = false;
    for (const w of ws) {
      if (w.closed) continue;
      w.dirty = true;
      any = true;
    }
    if (!any || this.rerunQueued) return;
    this.rerunQueued = true;
    // In the write queue: a re-run sees every write handed to the store before it, and none half-done.
    void this.enqueue(async () => {
      this.rerunQueued = false;
      for (const w of [...this.watches]) if (w.dirty) await this.rerun(w);
    }).catch(() => {
      this.rerunQueued = false;
    });
  }

  private async rerun(w: Watch): Promise<void> {
    w.dirty = false;
    let result: LocalQueryResult | undefined;
    try {
      const r = await this.evaluate(w.req, w.fn);
      result = r.result;
      w.readSet = r.readSet;
      w.failed = false;
    } catch (e) {
      w.readSet = null;
      if (!w.failed && !w.closed) w.onError?.(e as Error);
      w.failed = true;
      return;
    }
    if (w.closed) return;
    // The version too: a local value that becomes resumable (its record caught up) is sent again with it. Values are
    // compared in full (a re-run reuses the rows it read before by identity: `reader`), not encoded.
    const last = w.last;
    if (last !== null && (last === undefined ? result === undefined : result !== undefined && last.source === result.source && last.version === result.version && sameValue(last.value, result.value))) return;
    w.last = result;
    try {
      w.onResult(result);
    } catch {
      /* a listener's problem */
    }
  }

  /** Rows of `shard` changed (and these records were rewritten): mark the watches they may affect. */
  private notify(shard: string, changes: LocalRowChange[], keys: string[]): void {
    if (!this.watches.size || (!changes.length && !keys.length)) return;
    const touched = new Set(keys);
    const hit: Watch[] = [];
    for (const w of this.watches) {
      if (w.req.shard !== shard) continue;
      if (touched.has(w.key)) hit.push(w);
      else if (w.fn && changes.length && (!w.readSet || localReadSetMatches(this.options.schema, w.readSet, changes))) hit.push(w);
    }
    this.schedule(hit);
  }

  /** Someone else wrote rows (a shared TinyBase store): what we knew about them is stale; re-run what reads them. */
  private onExternal(c: ExternalChange): void {
    const prefix = `${c.shard}\u0000`;
    this.rows.forgetPrefix(prefix);
    for (const r of this.records.values()) {
      if (r.shard === c.shard && r.refs) {
        r.materialized = false;
        r.value = undefined;
        r.json = undefined;
      }
    }
    this.notify(
      c.shard,
      c.tables.map((table) => ({ table, id: "", before: undefined, after: null })),
      [],
    );
  }

  async setIdentity(identity: LocalIdentity | null): Promise<void> {
    await this.enqueue(async () => {
      const v = identity ? encodeJson(identity) : null;
      // Storage first: a failed write leaves memory as it was.
      await this.backend.setMeta("identity", v);
      if (v === null) delete this.meta.identity;
      else this.meta.identity = v;
    });
  }

  /** Forget every cached result and replicated row (e.g. on sign-out on a shared device). Pending mutations stay. */
  async clear(): Promise<void> {
    await this.enqueue(async () => {
      // Every shard, read or not yet.
      for (const shard of [...this.unloaded]) await this.ensureShard(shard);
      await this.dropRecords([...this.records.values()]);
    });
  }

  async close(): Promise<void> {
    await this.flush().catch(() => undefined);
    for (const w of this.watches) w.closed = true;
    this.watches.clear();
    this.stopExternal?.();
    this.stopExternal = null;
    await this.backend.close();
  }
}

/**
 * Replicated rows known decoded, by `${shard}\0${id}`, least recently set first; their `stableStringify` once computed
 * (a row read back has none until a server value compares against it).
 */
class RowCache {
  private readonly m = new Map<string, { doc: Doc; sig: string | undefined }>();
  constructor(private readonly max: number) {}
  entry(k: string): { doc: Doc; sig: string | undefined } | undefined {
    return this.m.get(k);
  }
  get(k: string): Doc | undefined {
    return this.m.get(k)?.doc;
  }
  /** The row's signature (computed now from the known doc if it has none yet). */
  sigOf(_k: string, e: { doc: Doc; sig: string | undefined }): string {
    return (e.sig ??= stableStringify(e.doc));
  }
  set(k: string, doc: Doc, sig?: string): void {
    this.m.delete(k);
    this.m.set(k, { doc, sig });
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
  delete(k: string): void {
    this.m.delete(k);
  }
  forgetPrefix(prefix: string): void {
    // Deleting the entry just visited while iterating a Map is safe: no copy of every key.
    for (const k of this.m.keys()) if (k.startsWith(prefix)) this.m.delete(k);
  }
}

const newTx = (): ShardTx => ({ puts: new Map(), drops: new Set(), appends: new Map(), rows: new Map(), changes: [], keys: new Set(), undo: [] });

/** Adds one update's commit to its burst's (later writes of a record or a row replace earlier ones). */
function mergeInto(tx: ShardTx, c: Commit): void {
  for (const r of c.put ?? []) {
    // A put rewrites the record and clears its log: the burst's earlier appends are part of what it replaces.
    tx.puts.set(r.key, r);
    tx.drops.delete(r.key);
    tx.appends.delete(r.key);
  }
  for (const k of c.drop ?? []) {
    tx.puts.delete(k);
    tx.appends.delete(k);
    tx.drops.add(k);
  }
  for (const e of c.append ?? []) {
    const list = tx.appends.get(e.key);
    if (list) list.push(e);
    else tx.appends.set(e.key, [e]);
  }
  // Backends apply deletes and upserts in either order: each row goes once, as its last write in the burst.
  for (const d of c.delete ?? []) {
    const k = `${d.table}\u0000${d.id}`;
    tx.rows.delete(k);
    tx.rows.set(k, d);
  }
  for (const w of c.upsert ?? []) {
    const k = `${w.table}\u0000${w.doc._id}`;
    tx.rows.delete(k);
    tx.rows.set(k, w);
  }
}

/** The burst's single commit (null: nothing to write). */
function commitOf(tx: ShardTx): Commit | null {
  const c: Commit = {};
  if (tx.puts.size) c.put = [...tx.puts.values()];
  if (tx.drops.size) c.drop = [...tx.drops];
  if (tx.appends.size) c.append = [...tx.appends.values()].flat();
  const upsert: Array<{ table: string; doc: Doc }> = [];
  const del: Array<{ table: string; id: string }> = [];
  for (const r of tx.rows.values()) {
    if ("doc" in r) upsert.push(r);
    else del.push(r);
  }
  if (upsert.length) c.upsert = upsert;
  if (del.length) c.delete = del;
  return c.put || c.drop || c.append || c.upsert || c.delete ? c : null;
}

/** Marks a record whose log does not apply (dropped on open). */
const BROKEN: unknown = Object.freeze({ broken: true });

/** A `StorageAdapter` over any backend. */
export function createOfflineStorage(backend: OfflineBackend, options: OfflineOptions): OfflineStore {
  return new OfflineStore(backend, options);
}
