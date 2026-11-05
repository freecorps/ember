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
// skeleton is a doc array is persisted as a row diff against the previous skeleton (appended to the record's log,
// usually a few ids) plus the rows that changed; the record is rewritten whole (compaction) when the log would
// outgrow it. So a patch touching k rows of an n-row result writes O(k), not O(n).
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
  type LocalRowChange,
  type LocalSchema,
  type ReadSet,
} from "@freecorps/ember-server";
import { applyRowDiff, isPlainObject, rowDiff } from "@freecorps/ember-values";
import { NeedData, recordKey, type Commit, type ExternalChange, type OfflineBackend, type QueryLogEntry, type QueryRecord } from "./backend.ts";

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
   * Persist a changed value as a row diff appended to the record's log (default true). `false` rewrites the whole
   * record on every change (the pre-0.2 behaviour; kept for measurements).
   */
  persistDiffs?: boolean;
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
}

interface Watch {
  req: LocalQueryRequest;
  key: string;
  fn: AnyRegisteredFunction | undefined;
  readSet: ReadSet | null;
  last: string | null;
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
  /** `${shard}\0${id}` → number of records owning the row. */
  private readonly refs = new Map<string, number>();
  /** `${shard}\0${id}` → the row as last written / read (unknown after a restart until needed). */
  private readonly rowDoc = new Map<string, Doc>();
  private readonly rowSig = new Map<string, string>();
  private readonly watches = new Set<Watch>();
  private rerunQueued = false;
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
        const { meta, queries, log = [] } = await this.backend.open();
        this.meta = { ...meta };
        const logs = new Map<string, QueryLogEntry[]>();
        for (const e of log) logs.set(e.key, [...(logs.get(e.key) ?? []), e]);
        const broken: Rec[] = [];
        for (const r of queries) {
          const rec = this.replay(r, (logs.get(r.key) ?? []).sort((a, b) => a.seq - b.seq));
          this.records.set(rec.key, rec);
          for (const id of rec.ids) this.ref(rec.shard, id, +1);
          if (rec.skel === BROKEN) broken.push(rec);
        }
        // Retention: what the server has not refreshed for too long goes, with the rows only it owned.
        const cutoff = this.now() - (this.options.retentionMs ?? 30 * DAY);
        const stale = [...this.records.values()].filter((r) => r.updatedAt < cutoff || r.skel === BROKEN);
        if (stale.length) await this.dropRecords(stale);
        this.stopExternal = this.backend.onExternalChange?.((c) => this.onExternal(c)) ?? null;
      })();
      this.chain = this.opened.catch(() => undefined);
    }
    return this.opened;
  }

  /** A stored record with its log applied. A log that does not apply marks the record broken (dropped on open). */
  private replay(r: QueryRecord, entries: QueryLogEntry[]): Rec {
    let skel = r.value;
    let { version, updatedAt } = r;
    const ids = new Set(r.ids);
    let seq = 0;
    let logBytes = 0;
    try {
      for (const e of entries) {
        skel = applyRowDiff(skel, e.diff);
        version = e.version;
        updatedAt = e.updatedAt;
        for (const id of e.add) ids.add(id);
        for (const id of e.remove) ids.delete(id);
        seq = e.seq;
        logBytes += encodeJson(e.diff).length;
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
    };
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

  /** Reads rows by id from the backend (async readers: fetch and retry until nothing is missing). */
  private async readRows(shard: string, ids: string[]): Promise<Map<string, Doc | null>> {
    const m = this.options.schema.manifest;
    const reader = this.backend.reader(shard);
    for (let attempt = 0; ; attempt++) {
      const out = new Map<string, Doc | null>();
      for (const id of ids) {
        const table = localTableOfId(m, id);
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
      return out;
    }
  }

  /** The full value of a record (resolving its row references from the replica). */
  private async valueOf(rec: Rec): Promise<unknown> {
    if (rec.materialized) return rec.value;
    const missing = [...new Set(refsIn(rec.skel))].filter((id) => !this.rowDoc.has(`${rec.shard}\u0000${id}`));
    if (missing.length) {
      for (const [id, doc] of await this.readRows(rec.shard, missing)) {
        if (!doc) throw new Error(`offline store: replicated row ${id} of ${rec.fn} is missing`);
        this.know(rec.shard, doc);
      }
    }
    rec.value = resolveRefs(rec.skel, (id) => this.rowDoc.get(`${rec.shard}\u0000${id}`)!);
    rec.materialized = true;
    return rec.value;
  }

  private know(shard: string, doc: Doc, sig?: string): void {
    const k = `${shard}\u0000${doc._id}`;
    this.rowDoc.set(k, doc);
    this.rowSig.set(k, sig ?? stableStringify(doc));
  }

  private async apply(u: QueryUpdate): Promise<void> {
    const m = this.options.schema.manifest;
    const key = recordKey(u.shard, u.fn, u.argsJson);
    const prev = this.records.get(key);
    // The previous rows' content tells which rows are unchanged (not rewritten) and how changed rows moved.
    if (prev && !prev.materialized) await this.valueOf(prev).catch(() => undefined);
    const found = this.replicated.has(u.fn) ? documentsIn(m, u.value) : [];
    const prevIds = new Set(prev?.ids ?? []);
    const newIds = new Set<string>();
    const c: Commit = { upsert: [], delete: [] };
    const changes: LocalRowChange[] = [];
    const written: Array<{ doc: Doc; sig: string }> = [];
    const removed: string[] = [];
    // Refcount changes are applied as computed and undone if the commit fails, so memory never runs ahead of storage.
    const deltas: Array<[string, number]> = [];
    const ref = (id: string, d: number) => {
      deltas.push([id, d]);
      return this.ref(u.shard, id, d);
    };
    const before = (k: string): Doc | null | undefined => (this.rowDoc.has(k) ? this.rowDoc.get(k)! : this.refs.has(k) ? undefined : null);
    for (const { table, doc } of found) {
      const k = `${u.shard}\u0000${doc._id}`;
      const sig = stableStringify(doc);
      newIds.add(doc._id);
      if (this.rowSig.get(k) !== sig) {
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
        const table = localTableOfId(m, id);
        if (table) {
          c.delete!.push({ table, id });
          changes.push({ table, id, before: was, after: null });
          removed.push(k);
        }
      }
    }
    const docSet = new Set<object>(found.map((f) => f.doc));
    const skel = docSet.size ? toSkeleton(u.value, docSet) : u.value;
    const now = this.now();
    let entry: QueryLogEntry | null = null;
    let entryBytes = 0;
    if (prev && prev.skel !== BROKEN && this.options.persistDiffs !== false && prev.logCount < MAX_LOG && prev.baseBytes > 0) {
      const diff = rowDiff(prev.skel, skel);
      if (diff) {
        entryBytes = encodeJson(diff).length;
        if (prev.logBytes + entryBytes <= prev.baseBytes) {
          entry = {
            key,
            seq: prev.seq + 1,
            diff,
            version: u.version,
            updatedAt: now,
            add: [...newIds].filter((id) => !prevIds.has(id)),
            remove: [...prevIds].filter((id) => !newIds.has(id)),
          };
        }
      }
    }
    let baseBytes = prev?.baseBytes ?? 0;
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
        updatedAt: now,
        ids: [...newIds],
        size: 0,
        ...(docSet.size ? { refs: true as const } : {}),
      };
      record.size = baseBytes = encodeJson(skel).length;
      c.put = [record];
    }
    try {
      await this.backend.commit(u.shard, c);
    } catch (e) {
      for (const [id, d] of deltas.reverse()) this.ref(u.shard, id, -d);
      throw e;
    }
    for (const w of written) this.know(u.shard, w.doc, w.sig);
    for (const k of removed) {
      this.rowDoc.delete(k);
      this.rowSig.delete(k);
    }
    this.records.set(key, {
      key,
      shard: u.shard,
      fn: u.fn,
      args: u.args,
      argsJson: u.argsJson,
      version: u.version,
      updatedAt: now,
      ids: [...newIds],
      skel,
      refs: docSet.size > 0,
      materialized: true,
      value: u.value,
      seq: entry ? entry.seq : 0,
      logCount: entry ? prev!.logCount + 1 : 0,
      logBytes: entry ? prev!.logBytes + entryBytes : 0,
      baseBytes,
    });
    this.notify(u.shard, changes, [key]);
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

  /**
   * Per shard: commit the drop first, then forget the records and their refcounts in memory, so a failed commit
   * leaves memory matching storage (shards committed before the failure stay dropped, as they are in storage).
   */
  private async dropRecords(rs: Rec[]): Promise<void> {
    const m = this.options.schema.manifest;
    const byShard = new Map<string, Rec[]>();
    for (const r of rs) byShard.set(r.shard, [...(byShard.get(r.shard) ?? []), r]);
    for (const [shard, records] of byShard) {
      const c: Commit = { drop: records.map((r) => r.key), delete: [] };
      const changes: LocalRowChange[] = [];
      const dec = new Map<string, number>();
      for (const r of records) for (const id of r.ids) dec.set(id, (dec.get(id) ?? 0) + 1);
      for (const [id, n] of dec) {
        const k = `${shard}\u0000${id}`;
        if ((this.refs.get(k) ?? 0) - n > 0) continue;
        const table = localTableOfId(m, id);
        if (table) {
          c.delete!.push({ table, id });
          changes.push({ table, id, before: this.rowDoc.has(k) ? this.rowDoc.get(k)! : undefined, after: null });
        }
      }
      await this.backend.commit(shard, c);
      for (const r of records) this.records.delete(r.key);
      for (const [id, n] of dec) {
        if (this.ref(shard, id, -n) > 0) continue;
        this.rowDoc.delete(`${shard}\u0000${id}`);
        this.rowSig.delete(`${shard}\u0000${id}`);
      }
      this.notify(shard, changes, records.map((r) => r.key));
    }
  }

  async runQueryLocally(req: LocalQueryRequest): Promise<LocalQueryResult | undefined> {
    await this.flush();
    return await this.evaluate(req, this.registry.get(req.fn)).then((r) => r.result);
  }

  /** The local result of a request (registered: run over the replica; else / on failure: the cached value). */
  private async evaluate(req: LocalQueryRequest, fn: AnyRegisteredFunction | undefined): Promise<{ result: LocalQueryResult | undefined; readSet: ReadSet | null }> {
    const cached = this.records.get(recordKey(req.shard, req.fn, req.argsJson));
    const fromCache = async () => {
      if (!cached) return undefined;
      try {
        return { value: await this.valueOf(cached), source: "cache" as const };
      } catch {
        return undefined;
      }
    };
    if (!fn) return { result: await fromCache(), readSet: null };
    try {
      const { value, readSet } = await this.runLocal(fn, req);
      return { result: { value, source: "local" }, readSet };
    } catch (e) {
      const result = await fromCache();
      if (result) return { result, readSet: null };
      throw e;
    }
  }

  /** Runs a registered query over a shard's replica (re-running after async fetches until nothing is missing). */
  private async runLocal(fn: AnyRegisteredFunction, req: LocalQueryRequest): Promise<{ value: unknown; readSet: ReadSet }> {
    const reader = this.backend.reader(req.shard);
    for (let attempt = 0; ; attempt++) {
      let out: { value: unknown; readSet: ReadSet } | undefined;
      let error: unknown;
      try {
        out = runLocalQuery(fn, req.args, { schema: this.options.schema, reader, identity: req.identity, now: this.now() });
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
    const sig = result ? `${result.source}\u0000${encodeJson(result.value)}` : "";
    if (sig === w.last) return;
    w.last = sig;
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
    for (const k of [...this.rowDoc.keys()]) {
      if (!k.startsWith(`${c.shard}\u0000`)) continue;
      this.rowDoc.delete(k);
      this.rowSig.delete(k);
    }
    for (const r of this.records.values()) {
      if (r.shard === c.shard && r.refs) {
        r.materialized = false;
        r.value = undefined;
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
    for (const w of this.watches) w.closed = true;
    this.watches.clear();
    this.stopExternal?.();
    this.stopExternal = null;
    await this.backend.close();
  }
}

/** Marks a record whose log does not apply (dropped on open). */
const BROKEN: unknown = Object.freeze({ broken: true });

/** A `StorageAdapter` over any backend. */
export function createOfflineStorage(backend: OfflineBackend, options: OfflineOptions): OfflineStore {
  return new OfflineStore(backend, options);
}
