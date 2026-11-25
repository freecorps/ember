// The engine (contracts.md): one shard's database over a SqlDriver. Runs queries (recording read sets) and
// mutations (capturing row changes and scheduled jobs), group-commits batches, migrates the schema, and decides
// whether a commit's changes can affect a recorded read set.

import { encodeJsonStable, ESCAPE, inKeyRange, pointRange, rangeFor, stringifyValue, toSqlValue, valueSize, validate, type ObjectShape, type Shape, type ValidateOptions, withDefaults } from "@freecorps/ember-values";
import { AggregateMaintainer, aggregateDoc, aggregateReader, aggregatesOf, aggregateTable, type AggregateSpec } from "./aggregate.ts";
import { q, type SqlDriver, type SqlRow, type SqlValue } from "./driver.ts";
import { CLASSIC_STORAGE, dbIndexesOf, docKey, indexFields, legacyIdIndex, readSetFields, selectById, storageOfSql, type CompactFormat, type TableStorage } from "./ddl.ts";
import { STORAGE_FORMAT_CONVERTED, STORAGE_FORMAT_SUPPORTED, storageConverted } from "./storage.ts";
import { EmberError, errorInfo, type WireError } from "./errors.ts";
import { collectFiles, FILES_DDL, FileStore, shapeHasFiles, type FileStoreOptions, type StorageReader, type StorageWriter } from "./files.ts";
import { passes } from "./filter.ts";
import { externalChanged, isExternalKind, OUTBOX_DDL, outboxEnqueue } from "./external.ts";
import {
  authApi,
  checkShard,
  failApi,
  flattenFunctions,
  getFunctionName,
  type AnyFunctionReference,
  type AnyRegisteredFunction,
  type FunctionType,
  type PrivateSqlCtx,
  type RegisteredHttpAction,
  type Visibility,
} from "./functions.ts";
import { FOREIGN_IDS_META, foreignTableOf, parseForeignIds, type ForeignIds } from "./foreignIds.ts";
import { idPrefix, makeId, makeIdMicros, seededRandom } from "./ids.ts";
import { Importer } from "./importer.ts";
import type { IndexKind, MatchHelpers } from "./indexKinds.ts";
import { decodeRow, encodeFields, encodeJsonOnly, fieldOf, keyColumn, layoutOf, type Layout } from "./layout.ts";
import { sameKeyFields } from "./matchIndex.ts";
import {
  applyMigration,
  backfillStep,
  classicTables,
  compactTables,
  planMigration,
  stagedIndexes,
  storedVersion,
  type BackfillProgress,
  type MigrationPlan,
  type MigrationReport,
  type PlanOptions,
} from "./migrate.ts";
import { QueryImpl, sqlPluginQuery, sqlScan, type QueryEnv, type QueryProfile, type TableRuntime } from "./query.ts";
import type { PrivateSql, SchemaDefinition, SchemaManifest } from "./schema.ts";
import { makeSqlReader, SqlCache } from "./sqlQuery.ts";
import type { AuthCtx, Doc, Job, ReadSet, RowChange } from "./types.ts";
import { checkAccess, resolveReference, scopesOf, type ComponentScopes, type Scope } from "./components.ts";
import { resolveTriggers, type Change, type TriggersDefinition } from "./triggers.ts";
import {
  JOBS_TABLE,
  LIST_SCHEDULED_DEFAULT,
  LIST_SCHEDULED_MAX,
  SCHEDULED_STATE_KINDS,
  type ListScheduledOptions,
  type ScheduledFunction,
  type ScheduledReader,
  type SchedulerReader,
} from "./scheduled.ts";
import { isReplicaApplier, readReplicaStatus, receivesReplicated, REPLICA_INSERT, REPLICA_SQL, REPLICATED_SOURCE, shardKindOf, type ReplicaStatus } from "./replica.ts";
import { idMicros } from "./ids.ts";

import { checkLimits, DEFAULT_LIMITS, type Limits, type Usage } from "./limits.ts";

export interface CreateEngineOptions {
  schema: SchemaDefinition<any, any>;
  /** `{ "dir/mod:fn": fn }` or modules `{ "dir/mod": { fn } }`. */
  functions?: unknown;
  driver: SqlDriver;
  now?: () => number;
  random?: () => number;
  /**
   * Project limits (`defineApp({ limits })`) over `DEFAULT_LIMITS`; a function's own `limits` override them for its
   * top-level calls. Each at most `MAX_LIMITS` (throws otherwise).
   */
  limits?: Partial<Limits>;
  /**
   * Files (`ctx.storage`, `_files` refcounts). The runtime passes the shard name and a URL signer (R2 S3 presign or
   * the Worker proxy); without a signer, `getUrl`/`generateUploadUrl` throw StorageError but refcounts still work.
   */
  storage?: Partial<FileStoreOptions>;
  /**
   * Table storage (ddl.ts). "compact" (default): one row written per inserted document, existing classic tables are
   * converted by `migrate()`. "classic": an `_id` index and a `by_creation_time` index per table (local replicas).
   */
  tableStorage?: "compact" | "classic";
  /**
   * The compact format of the tables `migrate()` creates (storage.ts). Default: 3 (no `_k_by_creation_time` column),
   * or 2 while the shard still has classic tables to convert (also with `compactFormat: 3`, which cannot skip that
   * conversion). Existing tables keep theirs: 2 and 3 both stay readable.
   */
  compactFormat?: CompactFormat;
  /** The shard this engine serves (`<kind>:<key>`), for functions declared with `shard:`; unknown = not checked. */
  shardName?: () => string | null | undefined;
  /**
   * Per-table triggers (`ember/triggers.ts`, contracts.md "Triggers"): `defineTriggers({...})` or a plain
   * `{ table: fn | fn[] }`. Only the app's own tables; anything else throws `InvalidTrigger` here.
   */
  triggers?: TriggersDefinition | Record<string, unknown>;
  /**
   * The shard's scheduled jobs, for `ctx.scheduler.get/list` (the runtime reads its `_jobs`; the test harness its
   * queue). Without one, only the jobs a mutation scheduled itself are known.
   */
  scheduledFunctions?: ScheduledReader;
}

/** `usage`: what the call used against the limits it ran with (nested calls included). */
export type QueryResult = { value: unknown; readSet: ReadSet; usage?: Usage };
/** `cancelled`: ids of jobs scheduled by earlier mutations that `ctx.scheduler.cancel(id)` cancelled (the runtime
 * deletes them from `_jobs` in the same transaction). Jobs scheduled and cancelled by the same mutation are just
 * dropped from `scheduled`. */
/**
 * `files`: the mutation read or wrote `_files` (uploads, refcounts): the runtime re-arms the file GC alarm only then.
 * Absent (an engine that does not say) means "maybe".
 */
export type MutationBatchOptions = { savepointEach?: boolean; afterEach?: (result: MutationBatchResult, index: number) => void };
export type MutationResult = { value: unknown; changes: RowChange[]; scheduled: Job[]; cancelled: string[]; files?: boolean; usage?: Usage };
/**
 * `touched`: filled with every table the query opened (db.query / db.get), even when it throws.
 * `identity`: set to `read: true` when any part of the run (middlewares, `authorize`, the handler, nested
 * `ctx.runQuery`) called `ctx.auth.getUserIdentity()` or `ctx.auth.require()`, even when it throws. A run that did not
 * read the identity returns the same value (or error) for every caller: the runtime shares it between identities.
 * `phase` (queries declared with `authorize`): `"authorize"` runs only the per-identity check (middlewares +
 * `authorize`, value undefined) and records its own read set; `"handler"` runs only the handler, without the check.
 * The runtime gates every `"handler"` result behind a passing `"authorize"` of the same caller; nothing else may skip it.
 * `readSet`: the array the run records into, so the caller keeps what was read before a throw (complete when user code
 * threw between reads, as `ctx.fail` and `ctx.auth.require()` do; a scan records its range only once it finishes).
 * `nested`: results of queries that did not read the identity, reused by every run handed the same memo while the
 * data cannot have changed (the runtime keeps one per shard version): a nested `ctx.runQuery` of such a query costs a
 * copy of its value instead of a run (see `NestedQueryMemo`).
 */
export type RunQueryOptions = { touched?: Set<string>; identity?: { read: boolean }; phase?: "authorize" | "handler"; readSet?: ReadSet; profile?: QueryProfile; nested?: NestedQueryMemo };

/** Default byte budget of a `NestedQueryMemo` (estimated: `copyValue`'s meter): a bounded share of a 128 MB isolate. */
export const NESTED_MEMO_MAX_BYTES = 12 * 1024 * 1024;

/** Thrown by `copyValue` when its meter goes over its limit (the copy is abandoned). */
const OVER_BUDGET = Symbol("over budget");

/**
 * Results of queries that never read the identity, by `(function, args)`, shared by the runs given the same memo: a
 * per-user query calling `ctx.runQuery` of a list every user sees runs the list once, not once per user. Valid only
 * while the data does not change (the runtime makes a new one per shard version). Each hit gets its own copy of the
 * value (a handler may change what it got) and adds the nested read set and tables to the caller's; the nested
 * query's `authorize` still runs per caller. At most `max` entries and about `maxBytes` (estimated while copying):
 * the oldest go first, and a result over a quarter of the budget is not kept (that call runs every time).
 */
export class NestedQueryMemo {
  readonly entries = new Map<string, { value: unknown; readSet: ReadSet; touched: string[]; bytes: number }>();
  /** Nested calls answered from the memo / run (and stored when they did not read the identity). */
  hits = 0;
  misses = 0;
  /** Estimated bytes held by `entries`. */
  bytes = 0;
  constructor(
    readonly max = 256,
    readonly maxBytes = NESTED_MEMO_MAX_BYTES,
  ) {}
  static key(fn: string, args: unknown): string {
    return `${fn}\u0000${encodeJsonStable(args ?? {})}`;
  }
  get(key: string) {
    return this.entries.get(key);
  }
  set(key: string, value: unknown, readSet: ReadSet, touched: Iterable<string>): void {
    const ts = [...touched];
    // The key, the read set (bounds, names, filter literals, plugin data) and tables: what the entry holds besides its
    // value, counted against the same quarter of the budget.
    const meter = { bytes: key.length * 2 + 64, limit: Math.floor(this.maxBytes / 4) };
    let copy: unknown;
    try {
      for (const e of readSet) {
        meter.bytes += 96 + e.lo.byteLength + e.hi.byteLength + (e.table.length + e.index.length + e.kind.length) * 2;
        if (e.filter !== undefined) measureValue(e.filter, meter);
        if (e.data !== undefined) measureValue(e.data, meter);
      }
      for (const t of ts) meter.bytes += t.length * 2 + 16;
      if (meter.bytes > meter.limit) return;
      copy = copyValue(value, meter);
    } catch {
      // Not plain data (a class instance, a Date, a Map): handed out as is, never shared. Over the budget: not kept.
      return;
    }
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.bytes;
    }
    for (const [k, e] of this.entries) {
      if (this.entries.size < this.max && this.bytes + meter.bytes <= this.maxBytes) break;
      this.entries.delete(k);
      this.bytes -= e.bytes;
    }
    this.entries.set(key, { value: copy, readSet: [...readSet], touched: ts, bytes: meter.bytes });
    this.bytes += meter.bytes;
  }
}

/**
 * `copyValue`'s estimate of what `x` holds, without copying it (read-set filters and plugin data, kept as recorded):
 * any value, walked once per object. Throws `OVER_BUDGET` past the meter's limit.
 */
function measureValue(x: unknown, meter: { bytes: number; limit: number }): void {
  const seen = new Set<object>();
  const stack: unknown[] = [x];
  // Each pending value adds at least 16 bytes once popped: a collection past the budget stops while it is pushed,
  // before the stack holds a reference per child.
  const push = (e: unknown): void => {
    if (meter.bytes + 16 * (stack.length + 1) > meter.limit) throw OVER_BUDGET;
    stack.push(e);
  };
  while (stack.length) {
    const y = stack.pop();
    meter.bytes += typeof y === "string" ? 16 + y.length * 2 : typeof y === "bigint" ? 16 + y.toString(16).length : 16;
    if (typeof y === "object" && y !== null && !seen.has(y)) {
      seen.add(y);
      if (ArrayBuffer.isView(y)) meter.bytes += 48 + y.byteLength;
      else if (y instanceof ArrayBuffer) meter.bytes += 48 + y.byteLength;
      else if (y instanceof Map || y instanceof Set) for (const e of y instanceof Map ? y.entries() : y.values()) push(e);
      else if (Array.isArray(y)) for (const e of y) push(e);
      else
        for (const k of Object.keys(y)) {
          meter.bytes += 8 + k.length * 2;
          push((y as Record<string, unknown>)[k]);
        }
    }
    if (meter.bytes > meter.limit) throw OVER_BUDGET;
  }
}

/**
 * A deep copy of a query result (plain objects, arrays, bytes, primitives): what each memo hit hands out. Throws on
 * anything else (a copy would change what the caller gets).
 */
export function copyValue(x: unknown, meter?: { bytes: number; limit: number }): unknown {
  if (meter) {
    // A cheap estimate of what the copy holds (V8-ish sizes), checked as it grows: an oversized value stops early.
    meter.bytes += typeof x === "string" ? 16 + x.length * 2 : x instanceof Uint8Array ? 64 + x.byteLength : 16;
    if (meter.bytes > meter.limit) throw OVER_BUDGET;
  }
  if (typeof x !== "object" || x === null) return x;
  // `new Uint8Array(x)` copies: a Node `Buffer`'s `slice()` is a view over the same memory.
  if (x instanceof Uint8Array) return new Uint8Array(x);
  if (Array.isArray(x)) {
    const out = new Array<unknown>(x.length);
    for (let i = 0; i < x.length; i++) out[i] = copyValue(x[i], meter);
    return out;
  }
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== null) throw new TypeError("not plain data");
  const out: Record<string, unknown> = {};
  for (const k in x as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
    if (meter) meter.bytes += 8 + k.length * 2;
    const v = copyValue((x as Record<string, unknown>)[k], meter);
    if (k === "__proto__") Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
    else out[k] = v;
  }
  return out;
}
export type MutationBatchItem = { name: string; args: unknown; ctx: AuthCtx };
export type MutationBatchResult = ({ ok: true } & MutationResult) | { ok: false; error: WireError };
/**
 * `sensitive`: the caller's session must be re-checked in the Auth DO (mutations and actions). `component`: the
 * install path of a component function; those report `visibility: "internal"` (clients never call them).
 */
export type FunctionInfo = {
  type: FunctionType | "httpAction";
  visibility: Visibility;
  sensitive?: true;
  component?: string;
  /**
   * A query with a per-identity check (`authorize`, or a `fromAuth` shard whose claim is checked per caller), then a
   * handler whose result every admitted caller shares.
   */
  authorize?: true;
  /** `fromAuth` shard: the claim holding the shard key (part of the per-caller check's identity). */
  claim?: string;
};

/** Queries the runtime gates per caller (`phase: "authorize"`) before sharing the handler's result. */
const gated = (fn: AnyRegisteredFunction): boolean => fn.type === "query" && (!!fn.authorize || fn.shard?.fromClaim !== undefined);

type Tx = { exec(sql: string, ...params: SqlValue[]): SqlRow[] };
type TxState = ReturnType<EngineImpl["tx"]>;

type FnArg = string | AnyFunctionReference | AnyRegisteredFunction;

/** Nested calls (`ctx.runQuery`/`ctx.runMutation`) deeper than this are refused (runaway recursion). */
const MAX_CALL_DEPTH = 32;

type TriggerFn = (ctx: unknown, change: Change) => unknown;

/**
 * The trigger queue of one mutation, shared by its nested calls and by the triggers themselves. `draining`: a trigger
 * is running, so writes only enqueue (the loop already running picks them up, in order).
 */
type TriggerState = {
  queue: Array<{ fn: TriggerFn; change: Change }>;
  draining: boolean;
  runs: number;
  /** The ctx every trigger of this mutation gets (built on first use). */
  ctx: Record<string, unknown> | null;
};

/** How a writer reports row writes to the trigger queue (app-scope writers of an engine with triggers). */
type TriggerHooks = {
  has(table: string): boolean;
  enqueue(table: string, change: Change): void;
  /** Runs an outermost write and drains the queue, all in one savepoint (undone together if a trigger throws). */
  write<T>(op: () => T): T;
};

/** State shared by a mutation and the mutations / queries it calls (one transaction). */
type MutationState = {
  tx: ReturnType<EngineImpl["tx"]>;
  now: number;
  random: () => number;
  changes: Map<string, RowChange>;
  scheduled: Job[];
  cancelled: string[];
  auth: AuthCtx | undefined;
  depth: number;
  /** Shared by nested calls (`{ ...st }` copies the reference): set by any `_files` statement. */
  files: { touched: boolean };
  /** Set when the engine has triggers (shared by nested calls like `files`). */
  trig: TriggerState | undefined;
};

export interface Engine {
  readonly manifest: SchemaManifest;
  /** Idempotent. Plans and applies the schema (throws MigrationRefused), using `_ember_meta`. */
  migrate(): MigrationReport;
  /** Dry run of `migrate()`. */
  planMigration(): MigrationPlan;
  /**
   * `migrate()` has storage work left even when the schema version is unchanged (classic tables to convert), or the
   * shard's storage format is newer than this runtime's (`migrate()` then throws `StorageFormatTooNew`).
   */
  storageBehind(): boolean;
  /** Fills up to `limit` rows of a staged index (call until `done`). */
  backfillStep(limit?: number): BackfillProgress;
  runQuery(name: FnArg, args?: unknown, ctx?: AuthCtx, opts?: RunQueryOptions): QueryResult;
  runMutation(name: FnArg, args?: unknown, ctx?: AuthCtx): MutationResult;
  /**
   * Group commit: one transaction, one savepoint per item; a failing item is rolled back alone. Never throws per item.
   * `savepointEach`: one savepoint per item from the start (items likely to fail, such as retried jobs), instead of one
   * for the whole batch and a second pass when an item fails. `afterEach` (implies it): called in the transaction
   * after each item, before the next runs, so what it writes (a job's outcome, its scheduled jobs) is what the next
   * one reads.
   */
  runMutationBatch(items: MutationBatchItem[], opts?: MutationBatchOptions): MutationBatchResult[];
  /** Whether any of `changes` may affect a result that recorded `readSet` (no false negatives). */
  matches(readSet: ReadSet, changes: RowChange[]): boolean;
  /** The table an id belongs to (an Ember id, or a foreign id of an imported table: foreignIds.ts), or undefined. */
  tableOfId(id: string): string | undefined;
  functionInfo(name: string): FunctionInfo | undefined;
  /** Raw import of documents with their own ids (admin, `ember import`): importer.ts. */
  readonly importer: Importer;
}

/**
 * A mutation's changes with an undo journal while a savepoint is open: `set`/`delete` record the previous entry, so a
 * rolled-back savepoint restores exactly what it changed. Outside savepoints nothing is journaled.
 */
class ChangeMap extends Map<string, RowChange> {
  private log: Array<[string, RowChange | undefined]> = [];
  private open = 0;
  begin(): number {
    this.open++;
    return this.log.length;
  }
  end(): void {
    if (--this.open === 0) this.log.length = 0;
  }
  rollback(mark: number): void {
    for (let i = this.log.length - 1; i >= mark; i--) {
      const [k, prev] = this.log[i]!;
      if (prev === undefined) super.delete(k);
      else super.set(k, prev);
    }
    this.log.length = mark;
  }
  override set(k: string, v: RowChange): this {
    if (this.open) this.log.push([k, super.get(k)]);
    return super.set(k, v);
  }
  override delete(k: string): boolean {
    if (this.open && super.has(k)) this.log.push([k, super.get(k)]);
    return super.delete(k);
  }
  override clear(): void {
    if (this.open) for (const [k, v] of super.entries()) this.log.push([k, v]);
    super.clear();
  }
}


/**
 * `_ember_meta.storage` as stored, or undefined (no marker yet: a new shard, or classic storage never converted). A
 * blank value counts as no marker: no runtime writes one, so it cannot be a newer format.
 */
function storedStorageFormat(driver: SqlDriver): string | undefined {
  return storageMarker(missingTableIsEmpty(() => driver.exec(`SELECT value FROM "_ember_meta" WHERE key = 'storage'`).rows)[0]?.value);
}

const storageMarker = (v: unknown): string | undefined => (v === undefined || v === null || String(v).trim() === "" ? undefined : String(v));

/** `read()`, or no rows when the table it reads does not exist yet (one statement instead of a sqlite_master probe). */
function missingTableIsEmpty(read: () => SqlRow[]): SqlRow[] {
  try {
    return read();
  } catch (e) {
    if (/no such table/i.test(String((e as Error | null)?.message ?? e))) return [];
    throw e;
  }
}

/** The name an idempotent `CREATE [UNIQUE] TABLE|INDEX IF NOT EXISTS <name>` creates (null: run it anyway). */
const IDEMPOTENT_DDL = /^\s*create\s+(?:unique\s+)?(?:table|index)\s+if\s+not\s+exists\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i;
/** The name an idempotent `DROP TABLE|INDEX IF EXISTS <name>` drops (an index replaced by another one). */
const IDEMPOTENT_DROP = /^\s*drop\s+(?:table|index)\s+if\s+exists\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i;

/**
 * What a wake needs from the schema, in two statements: every table and index (sqlite_master) and the `_ember_meta`
 * keys `migrate()` reads. The fast path of `migrate()` (schema unchanged, storage current) derives everything from it.
 */
type BootSnapshot = { objects: Map<string, { type: string; sql: string }>; lower: Set<string>; meta: Map<string, string> | null };

function readBootSnapshot(driver: SqlDriver): BootSnapshot {
  const objects = new Map<string, { type: string; sql: string }>();
  const lower = new Set<string>();
  for (const r of driver.exec(`SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index')`).rows) {
    objects.set(String(r.name), { type: String(r.type), sql: typeof r.sql === "string" ? r.sql : "" });
    lower.add(String(r.name).toLowerCase());
  }
  let meta: Map<string, string> | null = null;
  if (objects.has("_ember_meta")) {
    meta = new Map();
    for (const r of driver.exec(`SELECT key, value FROM "_ember_meta" WHERE key IN ('version', 'storage', ?)`, FOREIGN_IDS_META).rows) {
      if (r.value !== null && r.value !== undefined) meta.set(String(r.key), String(r.value));
    }
  }
  return { objects, lower, meta };
}

/**
 * Runs the idempotent DDL whose object is missing from the snapshot, the idempotent drops whose object is still there,
 * and any statement it cannot name. A wake with everything current runs none.
 */
function ensureDdl(driver: SqlDriver, snap: BootSnapshot, ddl: readonly string[]): void {
  for (const sql of ddl) {
    const create = IDEMPOTENT_DDL.exec(sql)?.[1];
    if (create !== undefined) {
      if (!snap.lower.has(create.toLowerCase())) driver.exec(sql);
      continue;
    }
    const drop = IDEMPOTENT_DROP.exec(sql)?.[1];
    if (drop === undefined || snap.lower.has(drop.toLowerCase())) driver.exec(sql);
  }
}

/** `readStorage` over the snapshot. */
function storageFromSnapshot(snap: BootSnapshot, table: string): TableStorage {
  const t = snap.objects.get(table);
  if (!t || t.type !== "table") return CLASSIC_STORAGE;
  return storageOfSql(t.sql, snap.objects.get(legacyIdIndex(table))?.type === "index");
}

/**
 * The storage marker was written by a newer runtime (a format greater than STORAGE_FORMAT_SUPPORTED, or one this
 * runtime cannot read as a number): this runtime may misread the data, and converting would overwrite the marker.
 * Compared as numbers.
 */
function storageAhead(stored: string | undefined): boolean {
  if (stored === undefined) return false;
  const n = /^\d+$/.test(stored) ? Number(stored) : NaN;
  return !(n <= Number(STORAGE_FORMAT_SUPPORTED));
}

function storageTooNew(stored: string): EmberError {
  return new EmberError(
    "StorageFormatTooNew",
    `This shard was written by a newer Ember runtime (storage format ${stored}; this runtime understands up to ${STORAGE_FORMAT_SUPPORTED}). ` +
      `Nothing was changed: deploy the newer runtime again, or restore the shard to before that deploy (ember restore --to deploy:<version>).`,
    { stored, supported: STORAGE_FORMAT_SUPPORTED },
  );
}

/** An item of a group-committed batch failed: the batch's single savepoint is rolled back (see runMutationBatch). */
class BatchItemFailed extends Error {
  constructor(readonly failure: unknown) {
    super("batch item failed");
  }
}

export function createEngine(options: CreateEngineOptions): Engine {
  return new EngineImpl(options);
}

const isThenable = (x: unknown): x is PromiseLike<unknown> =>
  (typeof x === "object" || typeof x === "function") && x !== null && typeof (x as any).then === "function";

const ANON: AuthCtx = { identity: null };

/** `ctx.sql` of an app without `privateSql`. */
const NO_PRIVATE_SQL: PrivateSqlCtx = Object.freeze({
  exec: () => {
    throw new EmberError("PrivateSql", "ctx.sql needs defineSchema({ privateSql })");
  },
  transaction: () => {
    throw new EmberError("PrivateSql", "ctx.sql needs defineSchema({ privateSql })");
  },
});

/** Scans of at most this many rows feed a mutation's read cache (`tx.rows`); larger ones are not kept. */
const CACHED_SCAN_ROWS = 32;
/** Most documents a mutation's read cache holds. */
const CACHED_ROWS = 256;
/** Top-level field -> positions (in `keyIndexes`) of the indexes whose key reads it (system fields left out). */
function keyIndexesByField(keyIndexes: ReadonlyArray<{ fields: readonly string[] }>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  keyIndexes.forEach((ix, i) => {
    for (const f of ix.fields) {
      const top = f.split(".")[0]!;
      if (top === "_id" || top === "_creationTime") continue;
      let list = out.get(top);
      if (!list) out.set(top, (list = []));
      if (!list.includes(i)) list.push(i);
    }
  });
  return out;
}

/**
 * The columns of `values` that differ from the stored `row`: an UPDATE that sets an indexed column rewrites its index
 * entry even when the value is the same (one more billed row per index), so a patch sets only what changed.
 */
function changedValues(row: SqlRow, values: Array<[string, SqlValue]>): Array<[string, SqlValue]> {
  return values.filter(([c, x]) => !sameSqlValue(row[c], x));
}

function sameSqlValue(a: SqlValue | undefined, b: SqlValue): boolean {
  if (a === undefined) return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return Object.is(a, b);
}

/**
 * `row` with its `v.bytes()` columns copied (`bytesColumns`, from the table's layout): a decoded document reuses
 * those Uint8Arrays (`fromSqlValue`), and a handler may mutate them in place, which must change neither the cached
 * row (`changedValues` compares against it) nor another document decoded from it. With no such column it is the
 * same row, no allocation.
 *
 * The `_k_*` index BLOBs (and any other BLOB of the row) are not copied: no document is decoded from them, the
 * engine only reads them (compares, binds as parameters), and drivers hand out a fresh buffer per value and call
 * (node:sqlite builds a new Uint8Array per row; the DO driver wraps the ArrayBuffer workerd returns per row), so
 * nothing can write into them after the fact.
 */
export function cloneBytes(row: SqlRow, bytesColumns: readonly string[]): SqlRow {
  if (bytesColumns.length === 0) return row;
  let out: SqlRow | undefined;
  for (const k of bytesColumns) {
    const x = row[k];
    if (x instanceof Uint8Array) (out ??= { ...row })[k] = new Uint8Array(x);
  }
  return out ?? row;
}

/** A document handed to a trigger: its own copy (a trigger changing it must not change the recorded RowChange). */
function triggerDoc(doc: Doc): Doc {
  try {
    return copyValue(doc) as Doc;
  } catch {
    return doc;
  }
}

const remember = (cache: Map<string, SqlRow>, id: string, row: SqlRow) => {
  if (cache.size >= CACHED_ROWS) cache.clear();
  cache.set(id, row);
};

/**
 * Whether SQLite hands `s` back as it is: TEXT is stored as UTF-8, so a lone surrogate reads back as U+FFFD (and a
 * NUL is left to the driver). A row holding such a string is not kept as written (`writtenRow`): it is read again.
 */
const LOSSY_TEXT = /[\u0000]|\p{Cs}/u;
const storesAsIs = (s: string): boolean => !LOSSY_TEXT.test(s);
/** What a lossy string (`storesAsIs`) may have read back as: its key was written from what it was before. */
const MAYBE_LOSSY = /[\u0000\ufffd]/;

class EngineImpl implements Engine {
  readonly manifest: SchemaManifest;
  private readonly privateSql: PrivateSql | undefined;
  private readonly kinds: ReadonlyMap<string, IndexKind>;
  private readonly driver: SqlDriver;
  /** `SqlDriver.truncatesTextAtNul`: a TEXT value read back may have lost what followed a NUL (`keyOfBefore`). */
  private readonly textTruncates: boolean;
  private readonly functions: Map<string, AnyRegisteredFunction | RegisteredHttpAction>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly limits: Limits;
  private readonly tables = new Map<
    string,
    TableRuntime & {
      keyIndexes: Array<{ name: string; fields: string[] }>;
      /** Top-level field -> the `keyIndexes` whose key reads it (a patch recomputes only those keys). */
      keyIndexesOf: Map<string, number[]>;
      /** The select list of a read that only decodes documents (`Layout.dataColumns`, quoted). */
      dataColumnsSql: string;
      /** A mutation's read (its read cache): `_rowid` (writes go by it) and the document's columns, no `_k_*` BLOB. */
      rowColumnsSql: string;
      /** The INSERT of a new row (its first `CHUNK` columns), built once per storage format (`insertSql`). */
      insert?: { storage: TableStorage; returning: boolean; columns: number; sql: string };
      /** The schema's fields (`Layout.fieldOrder`). */
      fieldSet: ReadonlySet<string>;
      hasFiles: boolean;
      aggregates: AggregateSpec[];
      /** External indexes (Vectorize, AI Search): a write changing `fields` goes to the outbox. */
      external: Array<{ name: string; fields: string[] }>;
      storage: TableStorage;
    }
  >();
  private readonly storageOpts: FileStoreOptions;
  private readonly prefixes = new Map<string, string>();
  /** `${table}\0${index}` -> backfill window: rows `(cursor, until]` are not indexed / aggregated yet. */
  private staged = new Map<string, { cursor: number; until: number }>();
  private migrated = false;
  private lastCreationTime = 0;
  /** Compact tables: the highest `_rowid` handed out per table (a lower bound for the next one). */
  private readonly topRowid = new Map<string, number>();
  private readonly compact: boolean;
  private readonly compactFormat: CompactFormat | undefined;
  private readonly scopes: ComponentScopes;
  private readonly shardName: () => string | null | undefined;
  /** Physical table -> its triggers (app tables only). */
  private readonly triggers: ReadonlyMap<string, readonly TriggerFn[]>;
  private readonly jobs: ScheduledReader | undefined;
  /** Table numbers of imported foreign ids (`_ember_meta.foreign_ids`), read at migrate and after an import call. */
  private foreign: ForeignIds | undefined;
  private readonly foreignOf = (id: string): string | undefined => foreignTableOf(this.foreign, id);
  readonly importer: Importer;

  constructor(o: CreateEngineOptions) {
    this.manifest = o.schema.manifest;
    this.privateSql = o.schema.privateSql;
    this.kinds = o.schema.indexKinds;
    this.driver = o.driver;
    this.textTruncates = o.driver.truncatesTextAtNul === true;
    this.functions = flattenFunctions(o.functions ?? {});
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...checkLimits(o.limits, "createEngine") });
    this.storageOpts = { shard: () => null, ...o.storage };
    this.shardName = o.shardName ?? (() => this.storageOpts.shard());
    this.jobs = o.scheduledFunctions;
    this.scopes = scopesOf(o.schema);
    this.compact = (o.tableStorage ?? "compact") === "compact";
    this.compactFormat = o.compactFormat;
    for (const [name, t] of Object.entries(this.manifest.tables)) {
      const layout: Layout = layoutOf(name, t.document);
      const keyIndexes = dbIndexesOf(t).map((i) => ({ name: i.name, fields: indexFields(t, i.name)! }));
      this.tables.set(name, {
        name,
        manifest: t,
        layout,
        decode: (row: SqlRow) => decodeRow(layout, row),
        keyIndexes,
        keyIndexesOf: keyIndexesByField(keyIndexes),
        dataColumnsSql: layout.dataColumns.map(q).join(", "),
        rowColumnsSql: ["_rowid", ...layout.dataColumns].map(q).join(", "),
        fieldSet: new Set(layout.fieldOrder),
        hasFiles: shapeHasFiles(t.document),
        aggregates: aggregatesOf(t),
        external: t.indexes.flatMap((spec) => {
          const kind = this.kinds.get(spec.kind);
          return isExternalKind(kind) ? [{ name: spec.name, fields: kind.external.fields(spec) }] : [];
        }),
        storage: CLASSIC_STORAGE,
      });
      this.prefixes.set(t.idPrefix, name);
    }
    // App tables only (their logical name is the physical one).
    this.triggers = resolveTriggers(this.manifest, o.triggers);
    this.importer = new Importer({
      driver: this.driver,
      manifest: this.manifest,
      kinds: this.kinds,
      documentSize: this.limits.documentSize,
      shard: () => this.storageOpts.shard(),
      tableOfId: (id) => this.tableOfId(id),
      ensureMigrated: () => this.ensureMigrated(),
      refresh: () => {
        this.refreshStaged();
        this.refreshStorage();
        this.refreshForeign();
        this.topRowid.clear();
      },
    });
  }

  // ------------------------------------------------------------------------------------------ schema

  migrate(): MigrationReport {
    const snap = readBootSnapshot(this.driver);
    // Before any write: a runtime rolled back under a newer one must not convert (and re-mark) the shard.
    const stored = snap.meta ? storageMarker(snap.meta.get("storage")) : undefined;
    if (storageAhead(stored)) throw storageTooNew(stored!);
    ensureDdl(this.driver, snap, FILES_DDL);
    // The outbox's own indexes follow the runtime, not the schema version: a shard whose schema did not change still
    // gets them on its next wake (they are also in SYSTEM_DDL, which only a migration runs).
    ensureDdl(this.driver, snap, OUTBOX_DDL);
    ensureDdl(this.driver, snap, this.privateSql?.ddl ?? []);
    const from = snap.meta?.get("version") ?? null;
    if (from === this.manifest.version && !(this.compact && !storageConverted(stored))) {
      // The common wake: nothing to change, everything read from the snapshot (and `_ember_indexes`, when present).
      const staged = snap.objects.has("_ember_indexes") ? this.driver.exec(`SELECT "tbl", "name", "kind", "cursor", "until" FROM "_ember_indexes" ORDER BY "tbl", "name"`).rows : [];
      this.migrated = true;
      this.staged = new Map(staged.map((r) => [`${r.tbl}\u0000${r.name}`, { cursor: Number(r.cursor), until: Number(r.until) }] as const));
      for (const t of this.tables.values()) {
        t.storage = storageFromSnapshot(snap, t.name);
        t.compact = t.storage.compact;
        t.v3 = t.storage.v3;
      }
      this.foreign = parseForeignIds(snap.meta?.get(FOREIGN_IDS_META));
      return { changed: false, fromVersion: from, toVersion: this.manifest.version, steps: [], staged: staged.map((r) => ({ table: String(r.tbl), index: String(r.name), kind: String(r.kind) })) };
    }
    let report: MigrationReport;
    if (from === this.manifest.version) {
      report = { changed: false, fromVersion: from, toVersion: this.manifest.version, steps: [], staged: stagedIndexes(this.driver) };
    } else {
      report = applyMigration(this.driver, planMigration(this.driver, this.manifest, this.kinds, this.planOptions()), this.manifest);
    }
    // Also after a schema change: a table skipped before (columns, size, a failed conversion) may convert now.
    if (this.storageBehind() || (this.compact && report.changed)) {
      const converted = this.compactNow();
      if (converted.length) report = { ...report, changed: true, compacted: converted };
    }
    this.migrated = true;
    this.refreshStaged();
    this.refreshStorage();
    this.refreshForeign();
    return report;
  }

  planMigration(): MigrationPlan {
    const stored = storedStorageFormat(this.driver);
    if (storageAhead(stored)) throw storageTooNew(stored!);
    return planMigration(this.driver, this.manifest, this.kinds, this.planOptions());
  }

  private planOptions(): PlanOptions {
    return { compact: this.compact, classic: classicTables(this.driver), shard: this.shardName() ?? null, ...(this.compactFormat ? { compactFormat: this.compactFormat } : {}) };
  }

  private refreshForeign() {
    const row = missingTableIsEmpty(() => this.driver.exec(`SELECT value FROM "_ember_meta" WHERE key = ?`, FOREIGN_IDS_META).rows)[0];
    this.foreign = parseForeignIds(row?.value);
  }

  /** Converts the classic tables that can be (compactTables); the storage marker once none is left waiting. */
  private compactNow(): string[] {
    const c = compactTables(this.driver, this.manifest, this.kinds);
    if (!c.pending) this.setStorageFormat();
    return c.converted;
  }

  storageBehind(): boolean {
    const stored = storedStorageFormat(this.driver);
    if (storageAhead(stored)) return true;
    return this.compact && !storageConverted(stored);
  }

  /** Marks the conversion done ("2"); a marker of "3" (format 3 tables, storage.ts) already says so and is kept. */
  private setStorageFormat() {
    if (storageConverted(storedStorageFormat(this.driver))) return;
    this.driver.exec(`INSERT INTO "_ember_meta" ("key", "value") VALUES ('storage', ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`, STORAGE_FORMAT_CONVERTED);
  }

  private refreshStorage() {
    // One sqlite_master read for every table (not one per table).
    const snap: BootSnapshot = { objects: new Map(), lower: new Set(), meta: null };
    for (const r of this.driver.exec(`SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index')`).rows) {
      snap.objects.set(String(r.name), { type: String(r.type), sql: typeof r.sql === "string" ? r.sql : "" });
    }
    for (const t of this.tables.values()) {
      t.storage = storageFromSnapshot(snap, t.name);
      t.compact = t.storage.compact;
      t.v3 = t.storage.v3;
    }
  }

  backfillStep(limit = 500): BackfillProgress {
    this.ensureMigrated();
    let progress = backfillStep(this.driver, this.manifest, this.kinds, limit);
    this.refreshStaged();
    // A conversion that waited for this backfill runs once it is done (no new boot needed).
    if (progress.done && this.storageBehind()) {
      const converted = this.compactNow();
      if (converted.length) {
        this.refreshStorage();
        progress = { ...progress, compacted: converted };
      }
    }
    return progress;
  }

  private refreshStaged() {
    this.staged = new Map(
      missingTableIsEmpty(() => this.driver.exec(`SELECT "tbl", "name", "cursor", "until" FROM "_ember_indexes"`).rows).map(
        (r) => [`${r.tbl}\u0000${r.name}`, { cursor: Number(r.cursor), until: Number(r.until) }] as const,
      ),
    );
  }

  private ensureMigrated() {
    if (!this.migrated) this.migrate();
  }

  tableOfId(id: string): string | undefined {
    const prefix = idPrefix(id);
    return prefix !== undefined ? this.prefixes.get(prefix) : this.foreign && this.foreignOf(id);
  }

  functionInfo(name: string): FunctionInfo | undefined {
    const f = this.functions.get(name);
    if (!f) return undefined;
    const component = name.startsWith("@") ? this.scopes.scopeOfFunction(name)?.key : undefined;
    // Component functions are never client-callable: the app reaches them through ctx.run* (scope rules).
    const visibility: Visibility = component !== undefined ? "internal" : f.type === "httpAction" ? "public" : f.visibility;
    const info: FunctionInfo = { type: f.type, visibility };
    if (f.type !== "httpAction" && f.sensitive) info.sensitive = true;
    if (f.type !== "httpAction" && gated(f)) info.authorize = true;
    if (f.type !== "httpAction" && f.shard?.fromClaim !== undefined) info.claim = f.shard.fromClaim;
    if (component !== undefined) info.component = component;
    return info;
  }

  /** The scope a function runs in (the app for inline functions and app names). */
  private scopeOf(name: string): Scope {
    if (!name.startsWith("@")) return this.scopes.root;
    const s = this.scopes.scopeOfFunction(name);
    if (!s) throw new EmberError("FunctionNotFound", `Function ${name} not found`);
    return s;
  }

  /** A logical table name of `scope` -> its physical name. */
  private phys(scope: Scope, table: string): string {
    const t = typeof table === "string" ? scope.tables.get(table) : undefined;
    if (!t) throw new EmberError("ValidationError", `Unknown table ${JSON.stringify(table)}`);
    return t;
  }

  /** Throws when `table` (physical) is not one of `scope`'s tables. */
  private ownTable(scope: Scope, table: string, id: string) {
    if (!scope.logical.has(table)) {
      throw new EmberError("ValidationError", `Id ${id} belongs to a table outside ${scope.path.length ? `component ${scope.key}` : "the app"} (component tables are isolated)`);
    }
  }

  /** Resolves a nested call (`ctx.runQuery/runMutation`) from `scope`. */
  private resolveCall(scope: Scope, ref: unknown, type: "query" | "mutation"): { name: string; fn: AnyRegisteredFunction } {
    const r = resolveReference(scope.path, ref as AnyFunctionReference);
    const f = checkAccess(this.functions, r);
    if (f.type !== type) throw new EmberError("InvalidFunction", `${r.name} is a ${f.type}, not a ${type}`);
    return { name: r.name, fn: f as AnyRegisteredFunction };
  }

  private componentInfo(scope: Scope) {
    return scope.path.length ? { name: scope.key, config: scope.config } : undefined;
  }

  private table(name: string) {
    const t = this.tables.get(name);
    if (!t) throw new EmberError("ValidationError", `Unknown table ${JSON.stringify(name)}`);
    return t;
  }

  private resolve(fn: FnArg, type: "query" | "mutation"): { name: string; fn: AnyRegisteredFunction } {
    if (typeof fn === "object" && fn !== null && "handler" in fn) {
      if (fn.type !== type) throw new EmberError("InvalidFunction", `Expected a ${type}, got a ${fn.type}`);
      return { name: "(inline)", fn };
    }
    const name = getFunctionName(fn as string | AnyFunctionReference);
    const f = this.functions.get(name);
    if (!f) throw new EmberError("FunctionNotFound", `Function ${name} not found`);
    if (f.type !== type) throw new EmberError("InvalidFunction", `${name} is a ${f.type}, not a ${type}`);
    return { name, fn: f };
  }

  /** Per scope: the options validating ids as that scope sees them, and its `ctx.db.sql` cache (built once each). */
  private readonly perScope = new WeakMap<Scope, { validate: ValidateOptions; sql: SqlCache }>();
  private scoped(scope: Scope): { validate: ValidateOptions; sql: SqlCache } {
    let x = this.perScope.get(scope);
    if (!x) {
      x = { validate: { tableOfId: (id) => this.scopes.tableOfIdIn(scope, id, this.foreignOf) }, sql: new SqlCache(scope.tables.keys()) };
      this.perScope.set(scope, x);
    }
    return x;
  }
  /** Document validation (`checkDoc`): ids by physical table. */
  private readonly docValidation: ValidateOptions = { tableOfId: (id) => this.tableOfId(id) };

  private checkArgs(name: string, shape: ObjectShape, args: unknown) {
    const scope = this.scopeOf(name);
    const r = validate(shape, args ?? {}, this.scoped(scope).validate);
    if (!r.ok) throw new EmberError("ValidationError", `Invalid arguments for ${name}: ${r.path}: ${r.message}`, { path: r.path, issues: [{ path: r.path, message: r.message }] });
  }

  private checkReturns(name: string, shape: Shape | undefined, value: unknown) {
    if (!shape) return;
    const scope = this.scopeOf(name);
    const r = validate(shape, value, this.scoped(scope).validate);
    if (!r.ok) throw new EmberError("ValidationError", `Invalid return value of ${name}: ${r.path}: ${r.message}`, { path: r.path });
  }

  // ------------------------------------------------------------------------------------------ transactions

  /** The limits a top-level call of `fn` runs with: the project's, then the function's own (`query({ limits })`). */
  private limitsOf(fn: AnyRegisteredFunction): Limits {
    if (!fn.limits) return this.limits;
    let l = this.fnLimits.get(fn);
    if (!l) this.fnLimits.set(fn, (l = Object.freeze({ ...this.limits, ...fn.limits })));
    return l;
  }
  /** `ctx.sql` statements already checked (`privateSqlRefusal`), oldest first. */
  private readonly refusals = new Map<string, { name: string | undefined }>();
  private tableNames: string[] | undefined;
  /** `limitsOf` per function (merged once, not per call). */
  private readonly fnLimits = new WeakMap<AnyRegisteredFunction, Limits>();

  /** One transaction's counters, shared by the nested calls it makes (they spend the outer call's budget). */
  private tx(readSet: ReadSet | null, limits: Limits = this.limits) {
    const { driver } = this;
    const usage: Usage = { rowsRead: 0, documentsRead: 0, rowsWritten: 0, limits };
    const exec = (sql: string, ...params: SqlValue[]): SqlRow[] => {
      const r = driver.exec(sql, ...params);
      usage.rowsRead += r.rowsRead;
      usage.rowsWritten += r.rowsWritten;
      if (usage.rowsRead > limits.rowsRead) throw new EmberError("TooManyReads", `Too many rows read in one transaction (limit ${limits.rowsRead})`);
      if (usage.rowsWritten > limits.rowsWritten) throw new EmberError("TooManyWrites", `Too many rows written in one transaction (limit ${limits.rowsWritten})`);
      return r.rows;
    };
    /** Documents handed to the engine (by id, a scan, a search): counted against `documentsRead`. */
    const docs = (n: number) => {
      usage.documentsRead += n;
      if (usage.documentsRead > limits.documentsRead) {
        throw new EmberError("TooManyDocumentsRead", `Too many documents read in one transaction (limit ${limits.documentsRead})`);
      }
    };
    // A mutation's documents as last read (by id or a small scan), until it writes them: a read-modify-write reads
    // its document once. Queries keep none (they never write).
    const rows: Map<string, SqlRow> | undefined = readSet ? undefined : new Map();
    return { exec, docs, readSet, rows, usage, limits };
  }

  private reader(tx: TxState, touched?: Set<string>, scope: Scope = this.scopes.root, profile?: QueryProfile) {
    const cache = tx.rows;
    const getRaw = (id: string): { t: ReturnType<EngineImpl["table"]>; row: SqlRow; doc: Doc } | null => {
      const table = this.tableOfId(id);
      if (!table) return null;
      this.ownTable(scope, table, id);
      const t = this.table(table);
      const cached = cache?.get(id);
      // A cached row's bytes are never handed out: the document gets its own copies.
      if (cached) {
        tx.docs(1);
        return { t, row: cached, doc: t.decode(cloneBytes(cached, t.layout.bytesColumns)) };
      }
      // A query keeps no rows (it never writes): only the columns its document needs. A mutation also reads
      // `_rowid` (it writes by it); index keys are compared from the documents (`keyChanged`), not read.
      const row = selectById(tx.exec, table, t.storage, id, cache ? t.rowColumnsSql : t.dataColumnsSql);
      if (!row) return null;
      tx.docs(1);
      if (cache) remember(cache, id, cloneBytes(row, t.layout.bytesColumns));
      return { t, row, doc: t.decode(row) };
    };
    const getById = (id: string): Doc | null => {
      if (typeof id !== "string") throw new EmberError("ValidationError", "db.get() needs an id string");
      const table = this.tableOfId(id);
      if (!table) return null;
      this.ownTable(scope, table, id);
      touched?.add(table);
      if (tx.readSet) {
        // [key, key ++ 0x00): `docKey({ _id: id }, ["_id"])` and its successor, from one encoding.
        const { lo, hi } = pointRange([id]);
        tx.readSet.push({ table, index: "by_id", lo, hi, kind: "db" });
      }
      return getRaw(id)?.doc ?? null;
    };
    const env: QueryEnv = {
      scan: (t, index, lo, hi, asc, limit) => {
        // A query keeps no rows (it never writes): only the columns its documents need.
        const rows = sqlScan(tx.exec, t, index, lo, hi, asc, limit, cache ? "row" : true);
        tx.docs(rows.length);
        // Raw rows, decoded again on use: the handler may mutate the documents it got.
        if (cache && rows.length <= CACHED_SCAN_ROWS) for (const r of rows) if (r.row) remember(cache, String(r.row._id), cloneBytes(r.row, t.layout.bytesColumns));
        return rows;
      },
      pluginQuery: (kind, t, spec, arg, limit) => {
        const out = sqlPluginQuery(tx.exec, kind, t, spec, arg, limit);
        tx.docs(out.docs.length);
        return out;
      },
      readSet: tx.readSet,
      table: (name) => this.table(name),
      isStaged: (table, index) => this.staged.has(`${table}\u0000${index}`),
      kinds: this.kinds,
      getById,
      ...(profile ? { profile } : {}),
    };
    const db = {
      get: getById,
      query: (logical: string) => {
        const table = this.phys(scope, logical);
        touched?.add(table);
        return QueryImpl.of(env, this.table(table));
      },
      normalizeId: (table: string, id: string) => (typeof table === "string" && scope.tables.has(table) && this.tableOfId(id) === scope.tables.get(table) ? id : null),
      aggregate: (logical: string, name: string) => {
        const table = this.phys(scope, logical);
        const t = this.table(table);
        const spec = t.aggregates.find((a) => a.name === name);
        if (!spec) throw new EmberError("QueryError", `Aggregate ${table}.${name} not found`);
        if (this.staged.has(`${table}\u0000${name}`)) {
          throw new EmberError("IndexNotReady", `Aggregate ${table}.${name} is still backfilling and cannot be read yet`);
        }
        touched?.add(aggregateTable(table, name));
        return aggregateReader({ exec: tx.exec, readSet: tx.readSet, table, spec, document: t.manifest.document });
      },
      /**
       * How far this shard's copy of a `.replicated()` (or replica) table is. Reactive through the table's rows: a
       * query re-runs when a delivery changes them (a delivery that changes no row does not move it).
       */
      replicaStatus: (logical: string): ReplicaStatus => {
        const table = this.phys(scope, logical);
        const t = this.table(table);
        if (!t.manifest.replicated && !t.manifest.replica) throw new EmberError("QueryError", `${table} is not a replicated table`);
        touched?.add(table);
        const { lo, hi } = rangeFor([]);
        tx.readSet?.push({ table, index: "by_creation_time", lo, hi, kind: "db" });
        const me = this.shardName() ?? null;
        if (t.manifest.replicated) {
          if (me === REPLICATED_SOURCE) return { state: "source", seq: 0, updatedAt: null };
          if (me && !receivesReplicated(t.manifest, shardKindOf(me))) return { state: "off", seq: 0, updatedAt: null };
        }
        return readReplicaStatus(tx.exec, t.manifest.replica?.source ?? REPLICATED_SOURCE);
      },
      // Read-only SQL; reactivity is table-level: the full key range of every table it references.
      sql: makeSqlReader(
        (c) => {
          if (profile) profile.sql++;
          const { lo, hi } = rangeFor([]);
          for (const logical of c.tables) {
            const table = this.phys(scope, logical);
            touched?.add(table);
            tx.readSet?.push({ table, index: "by_creation_time", lo, hi, kind: "db" });
          }
          return tx.exec(scope.path.length ? scopedSql(c.sql, c.tables, scope) : c.sql, ...c.params);
        },
        this.scoped(scope).sql,
        this.scoped(scope).validate.tableOfId,
      ),
    };
    return { db, getRaw };
  }

  private writer(
    tx: TxState,
    now: number,
    random: () => number,
    changes: Map<string, RowChange>,
    scope: Scope = this.scopes.root,
    filesExec: Tx["exec"] = tx.exec,
    hooks?: TriggerHooks,
    replica = false,
  ) {
    const { db, getRaw: read } = this.reader(tx, undefined, scope);
    // Replica tables (replica.ts) are written only by the replication applier.
    const writable = <T extends { manifest: { replica?: unknown; replicated?: unknown }; name: string }>(t: T): T => {
      if (replica) return t;
      if (t.manifest.replica) throw new EmberError("ReadOnlyTable", `${t.name} is a replica table: it is read-only (its source writes it)`);
      // `.replicated()` tables: written in global:main only, copied to the other shards.
      if (t.manifest.replicated) {
        const me = this.shardName() ?? null;
        if (me !== REPLICATED_SOURCE) {
          throw new EmberError(
            "ReadOnlyTable",
            `${t.name} is a replicated table: it is written only in ${REPLICATED_SOURCE} and read-only in ${me ?? "this shard"} (write it from a mutation that runs in ${REPLICATED_SOURCE}, e.g. ctx.onShard("${REPLICATED_SOURCE}") in an action)`,
            { table: t.name, source: REPLICATED_SOURCE, shard: me },
          );
        }
      }
      return t;
    };
    const getRaw = (id: string) => {
      const cur = read(id);
      if (cur) writable(cur.t);
      return cur;
    };
    // Built on first use: only a table with files (or the files API) needs it.
    let fileStore: FileStore | undefined;
    const files = () => (fileStore ??= new FileStore(filesExec, this.storageOpts));
    const maintainers = new Map<string, AggregateMaintainer>();
    const maintainer = (t: ReturnType<EngineImpl["table"]>) => {
      let m = maintainers.get(t.name);
      if (!m) {
        m = new AggregateMaintainer(tx.exec, t.name, t.manifest.document, (spec, key, b, a) => {
          const pseudo = aggregateTable(t.name, spec.name);
          const after = a && aggregateDoc(spec, key, a);
          const before = b && aggregateDoc(spec, key, b);
          const id = (after ?? before)!._id;
          const prev = changes.get(`${pseudo}:${id}`);
          changes.set(`${pseudo}:${id}`, { table: pseudo, id, before: prev ? prev.before : before, after });
        });
        maintainers.set(t.name, m);
      }
      return m;
    };
    /** `row`: the row as written (`writtenRow`), kept in the read cache; none: the cached one is dropped. */
    const record = (table: string, id: string, before: Doc | null, after: Doc | null, rowid: number, row?: SqlRow) => {
      if (row && tx.rows) remember(tx.rows, id, row);
      else tx.rows?.delete(id);
      const prev = changes.get(id);
      changes.set(id, { table, id, before: prev ? prev.before : before, after });
      // Aggregates move in the same transaction too, except for rows a staged backfill has not reached yet.
      const ta = this.tables.get(table);
      if (ta?.aggregates.length) {
        for (const spec of ta.aggregates) {
          const w = this.staged.get(`${table}\u0000${spec.name}`);
          if (w && rowid > w.cursor && rowid <= w.until) continue;
          maintainer(ta).apply(spec, before, after);
        }
      }
      // External indexes (Vectorize, AI Search): the outbox row is written in this transaction too; rows in a
      // staged backfill window are left to the backfill.
      if (ta?.external.length) {
        for (const x of ta.external) {
          const w = this.staged.get(`${table}\u0000${x.name}`);
          if (w && rowid > w.cursor && rowid <= w.until) continue;
          if (externalChanged(x.fields, prev ? prev.before : before, after)) outboxEnqueue(tx.exec, table, x.name, id);
        }
      }
      // File refcounts move in the same transaction as the document (PLAN §7).
      const t = this.tables.get(table);
      if (t?.hasFiles) {
        const deltas = new Map<string, number>();
        if (before) for (const f of collectFiles(t.manifest.document, before)) deltas.set(f, (deltas.get(f) ?? 0) - 1);
        if (after) for (const f of collectFiles(t.manifest.document, after)) deltas.set(f, (deltas.get(f) ?? 0) + 1);
        files().adjust(deltas, now);
      }
      // Triggers see this one write (not the mutation's net change), with their own copies of the documents.
      if (hooks?.has(table)) {
        const oldDoc = before && triggerDoc(before);
        const newDoc = after && triggerDoc(after);
        hooks.enqueue(
          table,
          (oldDoc ? (newDoc ? { id, operation: "update", oldDoc, newDoc } : { id, operation: "delete", oldDoc, newDoc: null }) : { id, operation: "insert", oldDoc: null, newDoc: newDoc! }) as Change,
        );
      }
    };
    /** A write of `table` (undefined: an id of no table, which the write itself refuses) and the triggers it fires. */
    const fire = <T>(table: string | undefined, op: () => T): T => (hooks && table !== undefined && hooks.has(table) ? hooks.write(op) : op());
    const checkFields = (value: unknown, current?: Doc): Record<string, unknown> => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EmberError("ValidationError", "Expected a document object");
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(value)) {
        if (k.startsWith("_")) {
          if (current && (k === "_id" || k === "_creationTime") && (x === undefined || x === current[k])) continue;
          throw new EmberError("ValidationError", `System field ${k} cannot be written`);
        }
        out[k] = x;
      }
      return out;
    };
    const checkDoc = (t: ReturnType<EngineImpl["table"]>, fields: Record<string, unknown>) => {
      if (this.manifest.schemaValidation) {
        const r = validate(t.manifest.document, fields, this.docValidation);
        if (!r.ok) throw new EmberError("ValidationError", `Document for ${t.name} is invalid: ${r.path}: ${r.message}`, { path: r.path });
      }
      const size = valueSize(fields);
      if (size > tx.limits.documentSize) {
        throw new EmberError("DocumentTooLarge", `Document for ${t.name} is ${size} bytes (limit ${tx.limits.documentSize})`);
      }
    };
    const normalize = (t: ReturnType<EngineImpl["table"]>, id: string, ct: number, fields: Record<string, unknown>): Doc => {
      const doc: Record<string, unknown> = { _id: id, _creationTime: ct };
      for (const f of t.layout.fieldOrder) if (fields[f] !== undefined) doc[f] = fields[f];
      return doc as Doc;
    };
    /**
     * Whether the stored key of `fields` is the key of `before`: true unless one of them is a typed TEXT column whose
     * value may have been written as another string (`storesAsIs`: the key holds what was written, the column what
     * SQLite gave back). On a driver that cuts TEXT at a NUL (`textTruncates`) any such string may be a cut one.
     */
    const textTruncates = this.textTruncates;
    const keyOfBefore = (t: ReturnType<EngineImpl["table"]>, before: Doc, fields: readonly string[]): boolean => {
      for (const f of fields) {
        const x = before[f];
        if (typeof x === "string" && (textTruncates || MAYBE_LOSSY.test(x)) && t.layout.column(f)?.spec.cls === "text") return false;
      }
      return true;
    };
    /**
     * Whether the write must set index `ix`'s key to `key` (of the new document): not when it is the stored one. The
     * stored key is `before`'s (it was written from the same document), so it is compared from the documents, without
     * reading the `_k_*` BLOB, except in the rare case `keyOfBefore` refuses (then `stored` reads it).
     */
    const keyChanged = (t: ReturnType<EngineImpl["table"]>, before: Doc, doc: Doc, ix: { name: string; fields: readonly string[] }, stored: (column: string) => SqlValue | undefined): Uint8Array | null => {
      // A key a staged backfill has not written yet (NULL: every write outside a window sets it) is left to the
      // backfill, which writes every row it reaches. Below, documents with the same key fields mean no write either.
      if (!keyOfBefore(t, before, ix.fields)) {
        const storedKey = stored(keyColumn(ix.name));
        if (storedKey == null) return null;
        const key = docKey(doc, ix.fields);
        return sameSqlValue(storedKey, key) ? null : key;
      }
      if (sameKeyFields(before, doc, ix.fields)) return null;
      const key = docKey(doc, ix.fields);
      return sameSqlValue(docKey(before, ix.fields), key) ? null : key;
    };
    /** The stored value of `column` of `cur`'s row: from the row read when it has it, else read now. */
    const storedOf = (cur: { t: ReturnType<EngineImpl["table"]>; row: SqlRow }) => (column: string): SqlValue | undefined => {
      if (column in cur.row) return cur.row[column];
      return tx.exec(`SELECT ${q(column)} AS v FROM ${q(cur.t.name)} WHERE "_rowid" = ?`, Number(cur.row._rowid))[0]?.v;
    };
    /** `before` (a rewrite): the stored document; the index keys that stay the same are left out (`keyChanged`). */
    const rowValues = (t: ReturnType<EngineImpl["table"]>, doc: Doc, before?: { doc: Doc; stored: (column: string) => SqlValue | undefined }): Array<[string, SqlValue]> => {
      const cols = encodeFields(t.layout, doc);
      const out: Array<[string, SqlValue]> = Object.entries(cols);
      // Compact format 3: no `by_creation_time` key column (`_rowid` is its order). Skipped by name, not position.
      const v3 = t.storage.v3;
      for (const i of t.keyIndexes) {
        if (v3 && i.name === "by_creation_time") continue;
        const key = before ? keyChanged(t, before.doc, doc, i, before.stored) : docKey(doc, i.fields);
        if (key) out.push([keyColumn(i.name), key]);
      }
      return out;
    };
    /**
     * The row a write leaves, for the read cache only: `base` (the row it rewrote) with `values` set, the bytes columns
     * copied (the document's own arrays stay the handler's). Undefined means "nothing to cache": the transaction keeps
     * no read cache (not built at all then), or a string would not read back the same. Not a general "row written".
     */
    const writtenRow = (t: ReturnType<EngineImpl["table"]>, base: SqlRow | undefined, values: ReadonlyArray<readonly [string, SqlValue]>): SqlRow | undefined => {
      if (!tx.rows) return undefined;
      const row: SqlRow = base ? { ...base } : {};
      const bytes = t.layout.bytesColumns;
      for (const [c, x] of values) {
        if (typeof x === "string" && !storesAsIs(x)) return undefined;
        row[c] = x instanceof Uint8Array && bytes.length && bytes.includes(c) ? new Uint8Array(x) : x; // a copy, also of a Node `Buffer` (its `slice()` shares memory)
      }
      return row;
    };
    /**
     * The INSERT of `values`' first `n` columns. One slot per table is enough: the columns are the same on every insert
     * of a table in a storage format (`encodeFields` gives every column of the layout, absent fields as NULL, then every
     * key index; the layout is fixed per engine), and `returning` goes with the format (compact: no RETURNING).
     */
    const insertSql = (t: ReturnType<EngineImpl["table"]>, values: Array<[string, SqlValue]>, n: number, returning: boolean): string => {
      const c = t.insert;
      if (c && c.storage === t.storage && c.returning === returning && c.columns === n) return c.sql;
      let cols = "";
      let marks = "";
      for (let i = 0; i < n; i++) {
        cols += (i ? ", " : "") + q(values[i]![0]);
        marks += i ? ", ?" : "?";
      }
      const sql = `INSERT INTO ${q(t.name)} (${cols}) VALUES (${marks})${returning ? ` RETURNING "_rowid"` : ""}`;
      t.insert = { storage: t.storage, returning, columns: n, sql };
      return sql;
    };
    /** Inserts the row (its first `CHUNK` columns; `update` writes the rest): the `_rowid` when `returning`. */
    const insertRow = (t: ReturnType<EngineImpl["table"]>, values: Array<[string, SqlValue]>, returning: boolean): number | undefined => {
      const n = Math.min(values.length, CHUNK);
      const params = new Array<SqlValue>(n);
      for (let i = 0; i < n; i++) params[i] = values[i]![1];
      const rows = tx.exec(insertSql(t, values, n, returning), ...params);
      return returning ? Number(rows[0]!._rowid) : undefined;
    };
    // DO SQLite allows 100 bound parameters per statement: write wide rows in chunks.
    const CHUNK = 90;
    const update = (table: string, rowid: number, values: Array<[string, SqlValue]>) => {
      for (let i = 0; i < values.length; i += CHUNK) {
        const part = values.slice(i, i + CHUNK);
        tx.exec(`UPDATE ${q(table)} SET ${part.map(([c]) => `${q(c)} = ?`).join(", ")} WHERE "_rowid" = ?`, ...part.map(([, x]) => x), rowid);
      }
    };
    /**
     * The row values a patch of `keys` can change: the typed columns of those fields, `_json` when one of them is
     * (or was, or becomes) in it, and the keys of the indexes that read them; never `by_creation_time` (its fields are
     * system fields). Every other value is what the stored row already holds (it was written from the same document),
     * so the row's changed values are the ones `rowValues` would give. `_json` is recomputed whole whenever the
     * document has fields outside the schema (`normalize` drops them, as a full rewrite does).
     */
    const patchValues = (t: ReturnType<EngineImpl["table"]>, before: Doc, doc: Doc, keys: Iterable<string>, stored: (column: string) => SqlValue | undefined): Array<[string, SqlValue]> => {
      const out: Array<[string, SqlValue]> = [];
      let json = false;
      const indexes = new Set<number>();
      for (const k of keys) {
        const c = t.layout.column(k);
        if (c) {
          const sv = toSqlValue(c.spec.cls, doc[k]);
          if (sv === ESCAPE) {
            json = true;
            out.push([k, null]);
          } else out.push([k, sv]);
          if (!json && toSqlValue(c.spec.cls, before[k]) === ESCAPE) json = true;
        } else json = true;
        for (const i of t.keyIndexesOf.get(k) ?? []) indexes.add(i);
      }
      if (!json) for (const k in before) if (k !== "_id" && k !== "_creationTime" && !t.fieldSet.has(k)) json = true;
      if (json) out.push(["_json", encodeJsonOnly(t.layout, doc)]);
      for (const i of indexes) {
        const ix = t.keyIndexes[i]!;
        const key = keyChanged(t, before, doc, ix, stored);
        if (key) out.push([keyColumn(ix.name), key]);
      }
      return out;
    };
    /** `patch` of a document already read (`db.increment` reuses its own read). */
    const patchRaw = (cur: NonNullable<ReturnType<typeof getRaw>>, id: string, value: unknown): void => {
      const before = cur.doc;
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EmberError("ValidationError", "Expected a document object");
      // The stored fields, then the patch merged in (`checkFields`' checks, in its order: one copy, not three).
      const fields: Record<string, unknown> = {};
      for (const k of Object.keys(before)) {
        if (k === "_id" || k === "_creationTime") continue;
        if (k === "__proto__") Object.defineProperty(fields, k, { value: before[k], enumerable: true, writable: true, configurable: true });
        else fields[k] = before[k];
      }
      // The keys the merge walks: what it can change is exactly these.
      const keys: string[] = [];
      const patch = value as Record<string, unknown>;
      for (const k of Object.keys(patch)) {
        const x = patch[k];
        if (k.startsWith("_")) {
          if ((k === "_id" || k === "_creationTime") && (x === undefined || x === before[k])) continue;
          throw new EmberError("ValidationError", `System field ${k} cannot be written`);
        }
        // Never "__proto__" here (it starts with "_", refused above): `fields[k] = x` sets an own field.
        keys.push(k);
        if (x === undefined) delete fields[k];
        else fields[k] = x;
      }
      checkDoc(cur.t, fields);
      const doc = normalize(cur.t, before._id, before._creationTime, fields);
      const changed = changedValues(cur.row, patchValues(cur.t, before, doc, keys, storedOf(cur)));
      // Nothing changed: no write, no change (no version, change-log row, fan-out or trigger).
      if (!changed.length) return;
      update(cur.t.name, Number(cur.row._rowid), changed);
      record(cur.t.name, id, before, doc, Number(cur.row._rowid), writtenRow(cur.t, cur.row, changed));
    };
    const write = {
      ...db,
      insert: (logical: string, value: unknown): string => fire(this.phys(scope, logical), () => {
        const table = this.phys(scope, logical);
        const t = writable(this.table(table));
        const fields = checkFields(value);
        checkDoc(t, fields);
        let rowid: number;
        let id: string;
        let doc: Doc;
        let values: Array<[string, SqlValue]>;
        if (t.storage.compact) {
          // `_rowid` = `_creationTime` in µs, unique and increasing per table; the id carries it (ddl.ts).
          let top = this.topRowid.get(table);
          if (top === undefined) top = Number(tx.exec(`SELECT coalesce(max("_rowid"), 0) AS m FROM ${q(table)}`)[0]!.m);
          rowid = Math.max(Math.floor(now * 1000), Math.round(this.lastCreationTime * 1000) + 1, top + 1);
          this.topRowid.set(table, rowid);
          const ct = (this.lastCreationTime = rowid / 1000);
          id = makeIdMicros(t.manifest.idPrefix, rowid, random);
          doc = normalize(t, id, ct, fields);
          values = [["_rowid", rowid], ["_id", id], ["_creationTime", ct], ...rowValues(t, doc)];
          insertRow(t, values, false);
        } else {
          const ct = (this.lastCreationTime = Math.max(now, this.lastCreationTime + 0.001));
          id = makeId(t.manifest.idPrefix, ct, random);
          doc = normalize(t, id, ct, fields);
          values = [["_id", id], ["_creationTime", ct], ...rowValues(t, doc)];
          rowid = insertRow(t, values, true)!;
        }
        if (values.length > CHUNK) update(table, rowid, values.slice(CHUNK));
        record(table, id, null, doc, rowid, writtenRow(t, { _rowid: rowid }, values));
        return id;
      }),
      patch: (id: string, value: unknown) => fire(typeof id === "string" ? this.tableOfId(id) : undefined, () => {
        const cur = getRaw(id);
        if (!cur) throw new EmberError("NotFound", `Document ${id} not found`);
        patchRaw(cur, id, value);
      }),
      replace: (id: string, value: unknown) => fire(typeof id === "string" ? this.tableOfId(id) : undefined, () => {
        const cur = getRaw(id);
        if (!cur) throw new EmberError("NotFound", `Document ${id} not found`);
        const fields = Object.fromEntries(Object.entries(checkFields(value, cur.doc)).filter(([, x]) => x !== undefined));
        checkDoc(cur.t, fields);
        const doc = normalize(cur.t, cur.doc._id, cur.doc._creationTime, fields);
        const changed = changedValues(cur.row, rowValues(cur.t, doc, { doc: cur.doc, stored: storedOf(cur) }));
        if (!changed.length) return;
        update(cur.t.name, Number(cur.row._rowid), changed);
        record(cur.t.name, id, cur.doc, doc, Number(cur.row._rowid), writtenRow(cur.t, cur.row, changed));
      }),
      delete: (id: string) => fire(typeof id === "string" ? this.tableOfId(id) : undefined, () => {
        const cur = getRaw(id);
        if (!cur) throw new EmberError("NotFound", `Document ${id} not found`);
        tx.exec(`DELETE FROM ${q(cur.t.name)} WHERE "_rowid" = ?`, Number(cur.row._rowid));
        record(cur.t.name, id, cur.doc, null, Number(cur.row._rowid));
      }),
      // The replication applier only (replica.ts): a `.replicated()` row arriving with the source's `_id`/`_creationTime`.
      ...(replica
        ? {
            [REPLICA_INSERT]: (table: string, id: string, ct: number, value: unknown): void =>
              fire(table, () => {
                const t = this.table(table);
                if (this.tableOfId(id) !== table) throw new EmberError("ValidationError", `replicaApply: ${id} is not an id of ${table}`);
                if (typeof ct !== "number" || !Number.isFinite(ct)) throw new EmberError("ValidationError", `replicaApply: ${id} has no _creationTime`);
                const fields = checkFields(value);
                checkDoc(t, fields);
                const doc = normalize(t, id, ct, fields);
                let rowid: number;
                let values: Array<[string, SqlValue]>;
                if (t.storage.compact) {
                  // Replicated tables are classic (migrate.ts); a compact one (rows of its own from before) takes ids
                  // that carry their rowid only.
                  const micros = idMicros(id);
                  if (micros === undefined || micros !== Math.round(ct * 1000) || tx.exec(`SELECT 1 AS x FROM ${q(table)} WHERE "_rowid" = ?`, micros).length) {
                    throw new EmberError("ValidationError", `replicaApply: ${table} uses compact storage here and ${id} does not fit it (the next migration rebuilds it as classic)`);
                  }
                  rowid = micros;
                  values = [["_rowid", rowid], ["_id", id], ["_creationTime", ct], ...rowValues(t, doc)];
                  insertRow(t, values, false);
                  this.topRowid.set(table, Math.max(this.topRowid.get(table) ?? 0, rowid));
                } else {
                  values = [["_id", id], ["_creationTime", ct], ...rowValues(t, doc)];
                  rowid = insertRow(t, values, true)!;
                }
                if (values.length > CHUNK) update(table, rowid, values.slice(CHUNK));
                record(table, id, null, doc, rowid, writtenRow(t, { _rowid: rowid }, values));
              }),
          }
        : {}),
      /**
       * Adds `delta` to a numeric (number or int64) top-level field, read and written by the engine in this
       * transaction: no read of the document in user code. A missing field counts as 0. Returns the new value.
       */
      increment: (id: string, field: string, delta: number | bigint): number | bigint => {
        if (typeof field !== "string" || !field || field.startsWith("_") || field.includes(".")) {
          throw new EmberError("ValidationError", "increment() needs a top-level, non-system field name");
        }
        if (typeof delta === "number" ? !Number.isFinite(delta) : typeof delta !== "bigint") {
          throw new EmberError("ValidationError", "increment() needs a finite number or a bigint delta");
        }
        // One read of the document (`patchRaw` writes from it), the triggers fired as for `patch`.
        return fire(typeof id === "string" ? this.tableOfId(id) : undefined, () => {
          const cur = getRaw(id);
          if (!cur) throw new EmberError("NotFound", `Document ${id} not found`);
          const x = cur.doc[field];
          let next: number | bigint;
          if (typeof delta === "bigint") {
            if (x !== undefined && typeof x !== "bigint") throw new EmberError("ValidationError", `increment(): ${field} is not an int64`);
            next = (x ?? 0n) + delta;
          } else {
            if (x !== undefined && typeof x !== "number") throw new EmberError("ValidationError", `increment(): ${field} is not a number`);
            next = ((x as number | undefined) ?? 0) + delta;
          }
          patchRaw(cur, id, { [field]: next });
          return next;
        });
      },
    };
    return write;
  }

  /** `files`: the store, built on first use (most calls never touch `ctx.storage`). */
  private storageReader(files: () => FileStore, now: number): StorageReader {
    return {
      getUrl: (id, o) => files().getUrl(id, o ?? {}, now),
      getMetadata: (id) => files().getMetadata(id),
    };
  }

  /**
   * `ctx.scheduler.get/list`: the shard's jobs (`CreateEngineOptions.scheduledFunctions`), recorded in the read set
   * (`_jobs` by id, or the whole table for `list`). In a mutation, `own` overlays what it scheduled or cancelled so far.
   */
  private schedulerReader(readSet: ReadSet | null, touched: Set<string> | undefined, own?: { scheduled: Job[]; cancelled: string[]; now: number }): SchedulerReader {
    const pendingOf = (j: Job): ScheduledFunction => ({ id: j.id, _creationTime: own!.now, name: j.fn, args: j.args, scheduledTime: j.runAt, state: { kind: "pending" }, attempts: 0 });
    const cancel = (j: ScheduledFunction): ScheduledFunction =>
      own?.cancelled.includes(j.id) && j.state.kind === "pending" ? { ...j, state: { kind: "canceled" }, completedTime: own.now } : j;
    return {
      get: (id) => {
        if (typeof id !== "string" || !id) throw new EmberError("ValidationError", "scheduler.get() needs a job id");
        touched?.add(JOBS_TABLE);
        if (readSet) {
          const k = docKey({ _id: id } as Doc, ["_id"]);
          readSet.push({ table: JOBS_TABLE, index: "by_id", lo: k, hi: Uint8Array.from([...k, 0]), kind: "db" });
        }
        const mine = own?.scheduled.find((j) => j.id === id);
        if (mine) return pendingOf(mine);
        const j = this.jobs?.get(id) ?? null;
        return j && cancel(j);
      },
      list: (o: ListScheduledOptions = {}) => {
        if (o.state !== undefined && !SCHEDULED_STATE_KINDS.includes(o.state)) {
          throw new EmberError("ValidationError", `scheduler.list(): state must be one of ${SCHEDULED_STATE_KINDS.join(", ")}`);
        }
        const limit = o.limit ?? LIST_SCHEDULED_DEFAULT;
        if (!Number.isInteger(limit) || limit < 1 || limit > LIST_SCHEDULED_MAX) throw new EmberError("ValidationError", `scheduler.list(): limit must be an integer in 1..${LIST_SCHEDULED_MAX}`);
        touched?.add(JOBS_TABLE);
        if (readSet) {
          const { lo, hi } = rangeFor([]);
          readSet.push({ table: JOBS_TABLE, index: "by_creation_time", lo, hi, kind: "db" });
        }
        // A pending row this mutation cancelled is `canceled` here, as `get` says: it leaves the pending answer (the
        // page asks for that many more rows) and joins the canceled one, though `_jobs` still holds it as pending.
        const cancelled = own?.cancelled.length ? own.cancelled : null;
        const pageSize = o.state === "pending" && cancelled ? Math.min(LIST_SCHEDULED_MAX, limit + cancelled.length) : limit;
        let out = (this.jobs?.list({ ...(o.state ? { state: o.state } : {}), limit: pageSize }) ?? []).map(cancel);
        if (cancelled && o.state === "canceled") {
          const seen = new Set(out.map((j) => j.id));
          for (const id of cancelled) {
            if (seen.has(id)) continue;
            const j = this.jobs?.get(id);
            if (j) out.push(cancel(j));
          }
        }
        if (o.state) out = out.filter((j) => j.state.kind === o.state);
        if (own && (!o.state || o.state === "pending")) out.push(...own.scheduled.map(pendingOf));
        return out.slice(0, limit);
      },
    };
  }

  private authOf(ctx: AuthCtx | undefined, track?: { read: boolean }) {
    return authApi(ctx?.identity ?? null, track);
  }

  // ------------------------------------------------------------------------------------------ functions

  runQuery(name: FnArg, args: unknown = {}, ctx: AuthCtx = ANON, opts?: RunQueryOptions): QueryResult {
    this.ensureMigrated();
    const { name: fnName, fn } = this.resolve(name, "query");
    const readSet: ReadSet = opts?.readSet ?? [];
    const tx = this.tx(readSet, this.limitsOf(fn));
    const phase = opts?.phase;
    if (phase && !gated(fn)) throw new EmberError("InvalidFunction", `${fnName} has no authorize`);
    const memo = opts?.nested;
    const value = this.query(fnName, fn, args, { tx, now: this.now(), auth: ctx, touched: opts?.touched, depth: 0, track: opts?.identity, profile: opts?.profile, memo }, phase);
    // A run that did not read the identity serves the nested calls of the runs after it (the same list for everyone).
    // Only for functions some query calls with ctx.runQuery (a copy of every result would be wasted otherwise).
    if (memo && this.nestedNames.has(fnName) && opts?.identity && !opts.identity.read && phase !== "authorize" && (phase === "handler" || !gated(fn))) {
      memo.set(NestedQueryMemo.key(fnName, args), value, readSet, opts.touched ?? []);
    }
    return { value, readSet, usage: tx.usage };
  }

  /** Runs a query handler on a (possibly shared) transaction: top-level, or nested in a query / mutation. */
  private query(
    fnName: string,
    fn: AnyRegisteredFunction,
    args: unknown,
    st: {
      tx: ReturnType<EngineImpl["tx"]>;
      now: number;
      auth: AuthCtx | undefined;
      touched: Set<string> | undefined;
      depth: number;
      track?: { read: boolean } | undefined;
      profile?: QueryProfile | undefined;
      memo?: NestedQueryMemo | undefined;
    },
    phase?: "authorize" | "handler",
  ): unknown {
    args = withDefaults(fn.args, args ?? {});
    this.checkArgs(fnName, fn.args, args);
    // The claim of a `fromAuth` shard is the caller's: checked with `authorize`, not in the shared handler phase.
    checkShard(fnName, fn.shard, this.shardName(), args, st.auth, { claims: phase !== "handler" });
    if (phase === "authorize" && !fn.authorize) return undefined;
    const scope = this.scopeOf(fnName);
    const { db } = this.reader(st.tx, st.touched, scope, st.profile);
    let fileStore: FileStore | undefined;
    const storage = this.storageReader(() => (fileStore ??= new FileStore(st.tx.exec, this.storageOpts)), st.now);
    const runQuery = (ref: unknown, a?: unknown) => {
      if (st.depth >= MAX_CALL_DEPTH) throw new EmberError("InvalidFunction", `Too many nested calls (limit ${MAX_CALL_DEPTH})`);
      const target = this.resolveCall(scope, ref, "query");
      this.nestedNames.add(target.name);
      const memo = st.memo;
      if (!memo) return this.query(target.name, target.fn, a ?? {}, { ...st, depth: st.depth + 1 });
      return this.nestedQuery(target.name, target.fn, a ?? {}, st, memo);
    };
    const scheduler = this.schedulerReader(st.tx.readSet, st.touched);
    const c: Record<string, unknown> = { db, auth: this.authOf(st.auth, st.track), now: st.now, storage, scheduler, runQuery, fail: failApi(fn) };
    const component = this.componentInfo(scope);
    if (component) c.component = component;
    // `authorize` first (nested calls run it too): the caller's access, then the handler (PLAN §4, shared results).
    if (fn.authorize && phase !== "handler") {
      const ok = fn.authorize(c, args ?? {});
      if (isThenable(ok)) {
        Promise.resolve(ok).catch(() => {});
        throw new EmberError("AsyncHandler", `Query ${fnName} has an async authorize: it must be synchronous`);
      }
      if (phase === "authorize") return undefined;
    }
    const value = fn.handler(c, args ?? {});
    if (isThenable(value)) {
      Promise.resolve(value).catch(() => {});
      throw new EmberError("AsyncHandler", `Query ${fnName} returned a Promise: query handlers must be synchronous`);
    }
    this.checkReturns(fnName, fn.returns, value);
    return value;
  }

  /**
   * A nested `ctx.runQuery` with a memo: its `authorize` runs for this caller (its reads are the caller's); its handler
   * is reused from the memo when an earlier run did not read the identity (a copy of the value, its read set and
   * tables added to the caller's), else run with its own identity tracking and stored when it did not read it.
   */
  /** Functions some query has called with `ctx.runQuery` (their top-level results seed the memo too). */
  private readonly nestedNames = new Set<string>();

  private nestedQuery(name: string, fn: AnyRegisteredFunction, args: unknown, st: Parameters<EngineImpl["query"]>[3], memo: NestedQueryMemo): unknown {
    const inner = { ...st, depth: st.depth + 1 };
    if (gated(fn)) this.query(name, fn, args, inner, "authorize");
    const key = NestedQueryMemo.key(name, args);
    const hit = memo.get(key);
    if (hit) {
      memo.hits++;
      if (st.tx.readSet) for (const e of hit.readSet) st.tx.readSet.push(e);
      if (st.touched) for (const t of hit.touched) st.touched.add(t);
      return copyValue(hit.value);
    }
    memo.misses++;
    const track = { read: false };
    const touched = new Set<string>();
    const from = st.tx.readSet ? st.tx.readSet.length : 0;
    let value: unknown;
    try {
      value = this.query(name, fn, args, { ...inner, track, touched }, gated(fn) ? "handler" : undefined);
    } finally {
      // What the nested run read is the caller's too.
      if (track.read && st.track) st.track.read = true;
      if (st.touched) for (const t of touched) st.touched.add(t);
    }
    if (!track.read && st.tx.readSet) memo.set(key, value, st.tx.readSet.slice(from), touched);
    return value;
  }

  runMutation(name: FnArg, args: unknown = {}, ctx: AuthCtx = ANON): MutationResult {
    this.ensureMigrated();
    const { name: fnName, fn } = this.resolve(name, "mutation");
    return this.driver.transaction(() => this.mutate(fnName, fn, args, ctx));
  }

  runMutationBatch(items: MutationBatchItem[], opts: MutationBatchOptions = {}): MutationBatchResult[] {
    this.ensureMigrated();
    return this.driver.transaction(() => {
      // Most batches have no failing item: run them all under one savepoint, not one each (map #6). If one fails,
      // that savepoint undoes the whole batch and it runs again with a savepoint per item, so a failing item is
      // undone alone exactly as before (the first pass leaves nothing behind: its writes and results are dropped).
      if (items.length > 1 && !opts.savepointEach && !opts.afterEach) {
        const whole = this.batchWhole(items);
        if (whole) return whole;
      }
      return items.map((item, i): MutationBatchResult => {
        let r: MutationBatchResult;
        try {
          const { name, fn } = this.resolve(item.name, "mutation");
          r = { ok: true, ...this.driver.transaction(() => this.mutate(name, fn, item.args, item.ctx)) };
        } catch (e) {
          r = { ok: false, error: errorInfo(e) };
        }
        opts.afterEach?.(r, i);
        return r;
      });
    });
  }

  /** Every item of the batch in one savepoint; null (and nothing written) when any item throws. */
  private batchWhole(items: MutationBatchItem[]): MutationBatchResult[] | null {
    try {
      return this.driver.transaction(() =>
        items.map((item): MutationBatchResult => {
          try {
            const { name, fn } = this.resolve(item.name, "mutation");
            return { ok: true, ...this.mutate(name, fn, item.args, item.ctx) };
          } catch (e) {
            throw new BatchItemFailed(e);
          }
        }),
      );
    } catch (e) {
      if (e instanceof BatchItemFailed) return null;
      throw e;
    }
  }

  private mutate(fnName: string, fn: AnyRegisteredFunction, args: unknown, ctx: AuthCtx | undefined): MutationResult {
    const st: MutationState = {
      tx: this.tx(null, this.limitsOf(fn)),
      now: this.now(),
      random: seededRandom(Math.floor(this.random() * 2 ** 32)),
      changes: new ChangeMap(),
      scheduled: [],
      cancelled: [],
      auth: ctx,
      depth: 0,
      files: { touched: false },
      trig: this.triggers.size ? { queue: [], draining: false, runs: 0, ctx: null } : undefined,
    };
    const value = this.mutateIn(fnName, fn, args, st);
    // A row inserted and deleted by the same mutation is no change at all (nor is an aggregate that came back).
    const out = [...st.changes.values()].filter(
      (c) => (c.before || c.after) && (this.tables.has(c.table) || !c.before || !c.after || stringifyValue(c.before) !== stringifyValue(c.after)),
    );
    return { value, changes: out, scheduled: st.scheduled, cancelled: st.cancelled, files: st.files.touched, usage: st.tx.usage };
  }

  /** Runs one mutation handler on the shared state (top-level or nested through `ctx.runMutation`). */
  private mutateIn(fnName: string, fn: AnyRegisteredFunction, args: unknown, st: MutationState): unknown {
    args = withDefaults(fn.args, args ?? {});
    this.checkArgs(fnName, fn.args, args);
    checkShard(fnName, fn.shard, this.shardName(), args, st.auth);
    const scope = this.scopeOf(fnName);
    // The replication applier (replica.ts) alone may write replica tables; its triggers' ctx may not.
    const c = this.mutationCtx(scope, st, isReplicaApplier(fn));
    c.fail = failApi(fn);
    const value = fn.handler(c, args ?? {});
    if (isThenable(value)) {
      Promise.resolve(value).catch(() => {});
      throw new EmberError("AsyncHandler", `Mutation ${fnName} returned a Promise: mutation handlers must be synchronous`);
    }
    this.checkReturns(fnName, fn.returns, value);
    return value;
  }

  /**
   * Runs `fn` in a savepoint (nested `ctx.runMutation`, `ctx.sql.transaction`, a write with triggers): when it throws,
   * the savepoint rolls back and `st` is put back as it was (changes, jobs, the read cache, the trigger queue).
   * Changes are undone from their journal (`ChangeMap`), so a savepoint costs O(what it changed), not O(changes).
   */
  private savepoint<R>(st: MutationState, fn: () => R): R {
    const changes = st.changes as ChangeMap;
    const mark = changes.begin();
    const scheduled = st.scheduled.length ? [...st.scheduled] : [];
    const cancelled = st.cancelled.length ? [...st.cancelled] : [];
    const queued = st.trig?.queue.length ?? 0;
    try {
      return this.driver.transaction(fn);
    } catch (e) {
      // The savepoint undid the writes: rows read after writing them are stale.
      st.tx.rows?.clear();
      changes.rollback(mark);
      st.scheduled.splice(0, st.scheduled.length, ...scheduled);
      st.cancelled.splice(0, st.cancelled.length, ...cancelled);
      if (st.trig && st.trig.queue.length > queued) st.trig.queue.length = queued;
      throw e;
    } finally {
      changes.end();
    }
  }

  /** The trigger side of an app-scope writer: enqueue each row write, drain before the outermost write returns. */
  private triggerHooks(st: MutationState): TriggerHooks | undefined {
    const trig = st.trig;
    if (!trig) return undefined;
    return {
      has: (table) => this.triggers.has(table),
      enqueue: (table, change) => {
        for (const fn of this.triggers.get(table)!) trig.queue.push({ fn, change });
      },
      // Every write with triggers gets its savepoint, also inside a trigger (a trigger catching its own write's error
      // gets that write and what it enqueued undone). Inside a trigger the loop already running drains what this
      // write enqueues (FIFO, no interleaving); the outermost write drains before it returns.
      write: (op) =>
        this.savepoint(st, () => {
          const r = op();
          if (!trig.draining) this.drainTriggers(st, trig);
          return r;
        }),
    };
  }

  private drainTriggers(st: MutationState, trig: TriggerState): void {
    if (!trig.queue.length) return;
    trig.draining = true;
    try {
      // The queue grows while it drains: writes made by a trigger fire theirs after the ones already queued.
      for (let i = 0; i < trig.queue.length; i++) {
        if (++trig.runs > st.tx.limits.triggerRuns) {
          throw new EmberError("TriggerLoop", `Too many trigger runs in one mutation (limit ${st.tx.limits.triggerRuns}): a trigger's writes keep firing triggers`);
        }
        const { fn, change } = trig.queue[i]!;
        // App scope, the mutation's transaction, identity, clock and random; one level deeper for nested calls.
        trig.ctx ??= this.mutationCtx(this.scopes.root, { ...st, depth: st.depth + 1 });
        const r = fn(trig.ctx, change);
        if (isThenable(r)) {
          Promise.resolve(r).catch(() => {});
          throw new EmberError("AsyncHandler", `A trigger of ${this.tableOfId(String(change.id)) ?? "a table"} returned a Promise: triggers must be synchronous`);
        }
      }
    } finally {
      trig.draining = false;
      trig.queue.length = 0;
    }
  }

  /** The ctx of a mutation handler (or of a trigger) running in `scope` on the shared state `st`. */
  private mutationCtx(scope: Scope, st: MutationState, applier = false): Record<string, unknown> {
    const { tx, now, random, changes, scheduled, cancelled } = st;
    const filesExec: Tx["exec"] = (sql, ...params) => {
      st.files.touched = true;
      return tx.exec(sql, ...params);
    };
    // Components never reach the app's tables, and only app tables have triggers (replica tables too: their changes
    // fire the app's triggers when the applier writes them).
    const db = this.writer(tx, now, random, changes, scope, filesExec, scope === this.scopes.root ? this.triggerHooks(st) : undefined, applier);
    let fileStore: FileStore | undefined;
    const files = () => (fileStore ??= new FileStore(filesExec, this.storageOpts));
    const storage: StorageWriter = {
      ...this.storageReader(files, now),
      generateUploadUrl: (o) => files().generateUploadUrl(o ?? {}, now),
      delete: (id) => files().delete(id, now),
    };
    const schedule = (runAt: number, ref: unknown, jobArgs: unknown): string => {
      // Names resolve relative to the scheduling scope; the job stores the absolute name (and so runs in its scope).
      const r = resolveReference(scope.path, ref as AnyFunctionReference);
      const target = r.name;
      let f: AnyRegisteredFunction | RegisteredHttpAction;
      try {
        f = checkAccess(this.functions, r);
      } catch {
        throw new EmberError("FunctionNotFound", `Cannot schedule ${target}: function not found`);
      }
      if (f.type !== "mutation" && f.type !== "action") throw new EmberError("InvalidFunction", `Cannot schedule ${target}: only mutations and actions can be scheduled`);
      this.checkArgs(target, f.args, jobArgs ?? {});
      if (!Number.isFinite(runAt)) throw new EmberError("ValidationError", "Scheduled time must be a finite number");
      const id = makeId("job", now, random);
      scheduled.push({ id, fn: target, args: jobArgs ?? {}, runAt, kind: f.type });
      return id;
    };
    const scheduler = {
      runAfter: (delayMs: number, ref: unknown, jobArgs?: unknown) => schedule(now + Math.max(0, delayMs), ref, jobArgs),
      runAt: (ts: number | Date, ref: unknown, jobArgs?: unknown) => schedule(ts instanceof Date ? ts.getTime() : ts, ref, jobArgs),
      cancel: (id: string) => {
        if (typeof id !== "string" || !id) throw new EmberError("ValidationError", "scheduler.cancel() needs a job id");
        const i = scheduled.findIndex((j) => j.id === id);
        if (i >= 0) scheduled.splice(i, 1);
        else if (!cancelled.includes(id)) cancelled.push(id);
      },
      ...this.schedulerReader(null, undefined, { scheduled, cancelled, now }),
    };
    const nested = () => {
      if (st.depth >= MAX_CALL_DEPTH) throw new EmberError("InvalidFunction", `Too many nested calls (limit ${MAX_CALL_DEPTH})`);
    };
    const runQuery = (ref: unknown, a?: unknown) => {
      nested();
      const target = this.resolveCall(scope, ref, "query");
      return this.query(target.name, target.fn, a ?? {}, { tx, now, auth: st.auth, touched: undefined, depth: st.depth + 1 });
    };
    // Same transaction, inside a savepoint: a failing callee is undone alone (and the caller may catch).
    const runMutation = (ref: unknown, a?: unknown) => {
      nested();
      const target = this.resolveCall(scope, ref, "mutation");
      return this.savepoint(st, () => this.mutateIn(target.name, target.fn, a ?? {}, { ...st, depth: st.depth + 1 }));
    };
    const sql = this.privateSqlCtx(st);
    const c: Record<string, unknown> = { db, auth: this.authOf(st.auth), now, random, scheduler, storage, runQuery, runMutation, sql };
    const component = this.componentInfo(scope);
    if (component) c.component = component;
    if (applier) (c as Record<symbol, unknown>)[REPLICA_SQL] = (statement: string, ...params: SqlValue[]) => tx.exec(statement, ...params);
    return c;
  }

  /** `ctx.sql`: the app's private tables, in this transaction (`SchemaOptions.privateSql`). */
  private privateSqlCtx(st: MutationState): PrivateSqlCtx {
    // Without private tables both calls refuse, whatever the state: one object for every call.
    if (!this.privateSql) return NO_PRIVATE_SQL;
    const { tx } = st;
    // The verdict depends on the statement text alone (the tables are fixed): a mutation that runs the same
    // statements every time tokenizes each once per engine.
    const refused = (statement: string): string | undefined => {
      const cache = this.refusals;
      if (cache.has(statement)) return cache.get(statement)!.name;
      const name = privateSqlRefusal(statement, this.privateSql!.tables, (this.tableNames ??= [...this.tables.keys()]));
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(statement, { name });
      return name;
    };
    return {
      exec: (statement, ...params) => {
        if (!this.privateSql) throw new EmberError("PrivateSql", "ctx.sql needs defineSchema({ privateSql })");
        const name = refused(statement);
        if (name !== undefined) throw new EmberError("PrivateSql", `ctx.sql refused ${name}: only one statement over the app's private tables`);
        return tx.exec(statement, ...params);
      },
      transaction: (fn) => {
        if (!this.privateSql) throw new EmberError("PrivateSql", "ctx.sql needs defineSchema({ privateSql })");
        return this.savepoint(st, fn);
      },
    };
  }

  // ------------------------------------------------------------------------------------------ reactivity

  matches(readSet: ReadSet, changes: RowChange[]): boolean {
    const helpers: MatchHelpers = { field: (doc, path) => fieldOf(doc, path) };
    for (const change of changes) {
      const keyCache = new Map<string, [Uint8Array | null, Uint8Array | null]>();
      for (const entry of readSet) {
        if (entry.table !== change.table) continue;
        if (entry.kind === "db") {
          const fields = readSetFields(this.manifest, entry.table, entry.index);
          if (!fields) return true;
          let keys = keyCache.get(entry.index);
          if (!keys) {
            keys = [change.before && docKey(change.before, fields), change.after && docKey(change.after, fields)];
            keyCache.set(entry.index, keys);
          }
          // Before in range: the row may leave (or change inside) the result; after in range: it may enter.
          const [kb, ka] = keys;
          if (kb && inKeyRange(kb, entry.lo, entry.hi) && passes(entry.filter, change.before!)) return true;
          if (ka && inKeyRange(ka, entry.lo, entry.hi) && passes(entry.filter, change.after!)) return true;
        } else {
          if (!this.tables.has(entry.table)) return true;
          const kind = this.kinds.get(entry.kind);
          if (!kind?.matchesChange || kind.matchesChange(entry, change, helpers)) return true;
        }
      }
    }
    return false;
  }
}

/**
 * `ctx.db.sql` inside a component: the statement names logical tables; each one becomes a CTE over its physical
 * table (`WITH "buckets" AS NOT MATERIALIZED (SELECT * FROM "rl$buckets") ...`), merged with the statement's own
 * WITH clause.
 */
function scopedSql(sql: string, logicalTables: string[], scope: Scope): string {
  if (!logicalTables.length) return sql;
  const ctes = logicalTables.map((l) => `"${l}" AS NOT MATERIALIZED (SELECT * FROM "${scope.tables.get(l)!.replace(/"/g, '""')}")`).join(", ");
  const m = /^\s*WITH(\s+RECURSIVE)?\s/i.exec(sql);
  if (m) return `WITH${m[1] ? " RECURSIVE" : ""} ${ctes}, ${sql.slice(m[0].length)}`;
  return `WITH ${ctes} ${sql}`;
}

/**
 * One pass over `statement`, following SQLite's quoting: string literals ('...', with '' inside) become numbered
 * placeholders `'#n'` (their text in `literals`), comments (`--` to the end of the line, and block comments) become a
 * space, and quoted identifiers ("...", `...`, [...]) are kept as they are. A `--` or `/*` inside quotes is text, and
 * quotes inside comments are not quotes. An unterminated quote or comment runs to the end, as SQLite reads it.
 */
export function scanSqlText(statement: string): { skeleton: string; literals: string[] } {
  const literals: string[] = [];
  let out = "";
  let i = 0;
  const n = statement.length;
  while (i < n) {
    const c = statement[i]!;
    const next = statement[i + 1];
    if (c === "-" && next === "-") {
      const end = statement.indexOf("\n", i);
      i = end === -1 ? n : end;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = statement.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
    } else if (c === "'") {
      let j = i + 1;
      let text = "";
      while (j < n) {
        if (statement[j] === "'") {
          if (statement[j + 1] === "'") {
            text += "'";
            j += 2;
            continue;
          }
          break;
        }
        text += statement[j];
        j++;
      }
      out += `'#${literals.length}'`;
      literals.push(text);
      i = j + 1;
    } else if (c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      while (j < n) {
        if (statement[j] === close) {
          if (close !== "]" && statement[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += statement.slice(i, Math.min(j + 1, n));
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return { skeleton: out, literals };
}

/**
 * Why `ctx.sql` refuses `statement`, or undefined. An allowlist: every table the statement reads or writes (after
 * FROM, JOIN, INTO, UPDATE, TABLE or an index's ON) must be one of the app's private `tables` (or a CTE the statement
 * defines), compared without case as SQLite does. One statement only (no `;`), no comma joins (use JOIN), and nothing
 * that reaches past the app's tables: SQLite's own (`sqlite_*`), pragmas, ATTACH, Ember's (`_*`), components' (`$`).
 */
export function privateSqlRefusal(statement: string, tables: readonly string[], schemaTables: readonly string[] = []): string | undefined {
  const { skeleton, literals } = scanSqlText(statement);
  // SQLite takes a single-quoted string as a table name where it expects one (`from 'notes'`, an index's `on 'x'`).
  const quoted =
    /\b(?:from|join|into|update|table)\s*(?:only\s+)?'#(\d+)'/i.exec(skeleton) ??
    /\bindex\b[\s\S]*?\bon\s+'#(\d+)'/i.exec(skeleton);
  if (quoted) return `'${literals[Number(quoted[1])]}'`;
  if (skeleton.replace(/;\s*$/, "").includes(";")) return "a second statement";
  if (/\b(pragma|attach|detach|vacuum)\b/i.test(skeleton)) return "a pragma or ATTACH";
  if (/\bsqlite_|\bpragma_|\$/i.test(skeleton)) return "SQLite's own tables";
  const allowed = new Set(tables.map((t) => t.toLowerCase()));
  // CTE names the statement defines (`with x as (...), y as (...)`).
  for (const m of skeleton.matchAll(/(?:\bwith\s+(?:recursive\s+)?|,\s*)("?)([A-Za-z_][A-Za-z0-9_]*)\1\s*(?:\([^)]*\)\s*)?as\s*\(/gi)) {
    const cte = m[2]!.toLowerCase();
    // A CTE named like a schema table (or an Ember internal) would let the allowlist pass a name SQLite may resolve
    // to the real table elsewhere in the statement.
    if (cte.startsWith("_") || schemaTables.some((t) => t.toLowerCase() === cte)) return m[2];
    allowed.add(cte);
  }
  // No DDL here (create, drop, alter, triggers, reindex): the schema's `privateSql.ddl` is checked and run by
  // `migrate()`; at run time a statement only reads and writes rows.
  if (/\b(create|drop|alter|reindex|trigger)\b/i.test(skeleton)) return "DDL";
  // Schema-qualified names (`main.notes`, `temp.x`) could reach any table whatever the name after the dot.
  if (/\b(main|temp)\s*\./i.test(skeleton)) return "a qualified name";
  const ident = `(?:"((?:[^"]|"")+)"|\\[([^\\]]+)\\]|\`([^\`]+)\`|([A-Za-z_][A-Za-z0-9_]*))`;
  const target = new RegExp(`\\b(?:from|join|into|update|table)\\s*(\\(\\s*)?(?:only\\s+)?${ident}`, "gi");
  for (const m of skeleton.matchAll(target)) {
    const name = (m[2] ?? m[3] ?? m[4] ?? m[5]!).replace(/""/g, '"');
    const before = skeleton.slice(0, m.index);
    const after = skeleton.slice(m.index! + m[0].length);
    // `on conflict (...) do update set ...`: an upsert's own clause, not another table.
    if (/^update/i.test(m[0]) && /\bdo\s+$/i.test(before)) continue;
    // `from (select ...)`: a subquery, whose own FROM is checked in turn. Any other parenthesis (`from (ledger)`,
    // a parenthesized join) names a table this check would not see whole: refused.
    if (m[1] !== undefined) {
      if (/^(select|with|values)$/i.test(name)) continue;
      return "a parenthesized table";
    }
    // `x.y` after FROM: a qualified name, whatever `x` is.
    if (/^\s*\./.test(after)) return "a qualified name";
    if (name.startsWith("_") || !allowed.has(name.toLowerCase())) return name;
  }
  // A backstop for whatever shape the checks above miss (comma joins after a subquery, nesting): a schema table named
  // anywhere in the statement, as a bare or quoted identifier and in any case, is refused. Nothing else can be read:
  // SQLite knows no table but the schema's, Ember's (`_*`, `$`), its own (`sqlite_*`) and the private ones, and no DDL
  // gets this far. (So a private column may not share a schema table's name.)
  const schema = new Set(schemaTables.map((t) => t.toLowerCase()));
  for (const m of skeleton.matchAll(/"((?:[^"]|"")+)"|\[([^\]]+)\]|`([^`]+)`|\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const word = (m[1] ?? m[2] ?? m[3] ?? m[4]!).replace(/""/g, '"').toLowerCase();
    // Ember's own tables all start with "_" (`_jobs`, `_ember_*`, files): refused wherever they are named.
    if (schema.has(word) || word.startsWith("_")) return word;
  }
  // SQLite also takes a single-quoted string as a table name wherever it expects one (`from ledger, 'notes'`): a
  // literal whose whole text is a schema table's name is refused too (a value that is exactly a table name is not
  // worth the hole).
  for (const literal of literals) {
    const text = literal.trim().toLowerCase();
    if (schema.has(text) || text.startsWith("_") || text.startsWith("sqlite_")) return `'${literal}'`;
  }
  // `from a, b`: the second table would go unchecked.
  if (/\bfrom\s+[^\s(,]+(?:\s+(?:as\s+)?[A-Za-z_][A-Za-z0-9_]*)?\s*,/i.test(skeleton)) return "a comma join";
  return undefined;
}

