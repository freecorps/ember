// ctx.db.query(table).withIndex(...).filter().order().take()/first()/unique()/collect()/paginate(), compiled to
// a range scan over the index's encoded key column:
//
//   SELECT * FROM t INDEXED BY "t__idx" WHERE "_k_idx" >= ? AND "_k_idx" < ? ORDER BY "_k_idx" ASC|DESC LIMIT ?
//
// Rows stream in batches (keyset continuation) so `.filter()` (evaluated in JS) can stop after n matches. Every
// read records the key range it actually covered: when it stopped early, only up to the last row examined.

import {
  bytesToBase64,
  base64ToBytes,
  compareBytes,
  encodeKey,
  keySuccessor,
  rangeFor,
  type LowerBound,
  type UpperBound,
} from "@freecorps/ember-values";
import { q, type SqlRow, type SqlValue } from "./driver.ts";
import { indexFields } from "./ddl.ts";
import { EmberError } from "./errors.ts";
import { andAll, filterBuilder, passes, toExpr } from "./filter.ts";
import type { IndexKind } from "./indexKinds.ts";
import { decodeValues, keyColumn, type Layout } from "./layout.ts";
import type { PushedFilter } from "./pushdown.ts";
import type { TableInfo, TableManifest } from "./schema.ts";
import type { Doc, FilterExpr, IndexSpec, ReadSet } from "./types.ts";

// ------------------------------------------------------------------------------------------------ types

type DocOf<TI extends TableInfo> = TI["document"];

/** Type of a (dotted) field path in a document; missing -> undefined. */
export type FieldTypeFromPath<D, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof D
    ? FieldTypeFromPath<NonNullable<D[H]>, R> | (undefined extends D[H] ? undefined : never)
    : undefined
  : P extends keyof D
    ? D[P]
    : undefined;

type Plus1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

export interface IndexRange {
  readonly __indexRange?: true;
}
/**
 * A bound on an index field. On an optional field, `undefined` (missing) and `null` sort before every other value
 * (key order: `undefined < null < int64 < number < ...`), so `gt("snoozedUntil", null)` means "has a value".
 */
export type BoundValue<D, F extends string> = FieldTypeFromPath<D, F> | (undefined extends FieldTypeFromPath<D, F> ? null | undefined : never);
export interface UpperBoundBuilder<D, F extends string> extends IndexRange {
  lt(field: F, value: BoundValue<D, F>): IndexRange;
  lte(field: F, value: BoundValue<D, F>): IndexRange;
}
export interface LowerBoundBuilder<D, F extends string> extends UpperBoundBuilder<D, F> {
  gt(field: F, value: BoundValue<D, F>): UpperBoundBuilder<D, F>;
  gte(field: F, value: BoundValue<D, F>): UpperBoundBuilder<D, F>;
}
/** `eq` walks the index fields in order; then at most one lower and one upper bound on the next field. */
export interface IndexRangeBuilder<D, Fs extends string[], N extends number = 0> extends LowerBoundBuilder<D, Fs[N] & string> {
  eq(
    field: Fs[N] & string,
    value: FieldTypeFromPath<D, Fs[N] & string>,
  ): number extends Fs["length"]
    ? IndexRangeBuilder<D, Fs, N>
    : Plus1[N] extends Fs["length"]
      ? IndexRange
      : IndexRangeBuilder<D, Fs, Plus1[N] & number>;
}

export interface Expression<T> {
  readonly __expr?: T;
}
export type ExprOrValue<T> = Expression<T> | T;
export interface FilterBuilder<TI extends TableInfo> {
  field<P extends TI["fieldPaths"]>(path: P): Expression<FieldTypeFromPath<DocOf<TI>, P>>;
  eq<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  neq<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  lt<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  lte<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  gt<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  gte<T>(l: ExprOrValue<T>, r: ExprOrValue<T>): Expression<boolean>;
  and(...e: ExprOrValue<boolean>[]): Expression<boolean>;
  or(...e: ExprOrValue<boolean>[]): Expression<boolean>;
  not(e: ExprOrValue<boolean>): Expression<boolean>;
}

export type PaginationOptions = { numItems: number; cursor: string | null; endCursor?: string | null };
export type PaginationResult<T> = { page: T[]; isDone: boolean; continueCursor: string };

export interface OrderedQuery<TI extends TableInfo> {
  filter(predicate: (q: FilterBuilder<TI>) => ExprOrValue<boolean>): this;
  take(n: number): DocOf<TI>[];
  collect(): DocOf<TI>[];
  first(): DocOf<TI> | null;
  /** The only document, or null; throws if there is more than one. */
  unique(): DocOf<TI> | null;
  paginate(opts: PaginationOptions): PaginationResult<DocOf<TI>>;
}
export interface Query<TI extends TableInfo> extends OrderedQuery<TI> {
  order(order: "asc" | "desc"): OrderedQuery<TI>;
}
/** Augment (same type parameter) to add a plugin's query method, e.g. `withSearchIndex`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IndexKindQueryMethods<TI extends TableInfo> {}
export interface QueryInitializer<TI extends TableInfo> extends Query<TI>, IndexKindQueryMethods<TI> {
  fullTableScan(): Query<TI>;
  withIndex<N extends keyof TI["indexes"] & string>(
    name: N,
    range?: (q: IndexRangeBuilder<DocOf<TI>, TI["indexes"][N]>) => IndexRange,
  ): Query<TI>;
}

// ------------------------------------------------------------------------------------------------ runtime

export interface TableRuntime {
  name: string;
  manifest: TableManifest;
  layout: Layout;
  decode(row: SqlRow): Doc;
  /** Compact storage (ddl.ts): `by_creation_time` is the primary key. Absent = classic. */
  compact?: boolean;
  /**
   * Compact format 3 (storage.ts, implies `compact`): no `_k_by_creation_time` column. A `by_creation_time` scan reads
   * `_rowid` and computes each row's key from `_creationTime` and `_id` (`creationScan`).
   */
  v3?: boolean;
}

/** A row read through an index: its encoded key and the decoded document. */
/**
 * `row`: the SQL row it was decoded from (the engine's scans), for a mutation's read cache. `match`: whether the row
 * passes the run's `.filter()`, when the env decided it (a filter pushed to SQLite); undefined: `passes` decides.
 */
export type ScannedRow = { key: Uint8Array; doc: Doc; row?: SqlRow | undefined; match?: boolean | undefined };

/**
 * What a query needs from the running transaction. The engine implements it over SQL (`sqlScan`); offline
 * clients implement it over local storage (SQLite, IndexedDB) with the same key encoding, so `QueryImpl` (range
 * computation, filters, order, pagination cursors, read sets) is one code path everywhere.
 */
export interface QueryEnv {
  /**
   * Rows of db index `index` whose key is in `[lo, hi)`, in key order (descending when `!asc`), at most `limit`.
   * Counted against the transaction's read limits. `filter`: the run's `.filter()` (the same object on every batch); an
   * env may decide it per row (`ScannedRow.match`) or ignore it. The rows are the same either way.
   */
  scan(t: TableRuntime, index: string, lo: Uint8Array, hi: Uint8Array, asc: boolean, limit: number, filter?: FilterExpr): ScannedRow[];
  /**
   * Runs a plugin index query (search, user kinds). `limit`: the query takes at most this many of the results and
   * runs no JS `.filter()` over them, so the kind may stop there (absent: it returns all it has, up to its own max).
   */
  pluginQuery(kind: IndexKind, t: TableRuntime, spec: IndexSpec, arg: unknown, limit?: number): { docs: Doc[]; data?: unknown };
  table(name: string): TableRuntime;
  /** Where reads are recorded (queries); null in mutations. */
  readSet: ReadSet | null;
  isStaged(table: string, index: string): boolean;
  kinds: ReadonlyMap<string, IndexKind>;
  getById(id: string): Doc | null;
  /** Counters of the run (`ember dev` feedback): absent when nobody asked. */
  profile?: QueryProfile;
}

/**
 * What a query run did, for `ember dev` (`runQuery(..., { profile })`): rows scanned, the rows `.filter()`
 * dropped, the largest `.collect()` (no limit), and `ctx.db.sql` calls (reactive per table).
 */
export interface QueryProfile {
  scanned: number;
  filteredOut: number;
  /** Rows of the largest `.collect()` of the run (0: none). */
  collectRows: number;
  sql: number;
}
export const newQueryProfile = (): QueryProfile => ({ scanned: 0, filteredOut: 0, collectRows: 0, sql: 0 });

export const END_CURSOR = "e";
const EMPTY = new Uint8Array(0);
const encodeCursor = (key: Uint8Array) => "k" + bytesToBase64(key, true);
function decodeCursor(c: string): Uint8Array {
  if (typeof c !== "string" || c[0] !== "k") throw new EmberError("InvalidCursor", "Invalid pagination cursor");
  try {
    return base64ToBytes(c.slice(1));
  } catch {
    throw new EmberError("InvalidCursor", "Invalid pagination cursor");
  }
}
export const asBytes = (x: unknown): Uint8Array =>
  x instanceof Uint8Array ? x : x instanceof ArrayBuffer ? new Uint8Array(x) : (() => { throw new Error("Index key column is not a BLOB"); })();
/** Rows of the `n`th batch of a filtered scan wanting `want` matches: 2×want (8..128), then 32, then 128. */
const filterBatch = (want: number, n: number): number => {
  const first = Math.min(128, Math.max(want * 2, 8));
  return n === 0 ? first : n === 1 ? Math.max(first, 32) : 128;
};
const maxBytes = (a: Uint8Array, b: Uint8Array) => (compareBytes(a, b) >= 0 ? a : b);
const minBytes = (a: Uint8Array, b: Uint8Array) => (compareBytes(a, b) <= 0 ? a : b);

type RangeOp = { op: "eq" | "gt" | "gte" | "lt" | "lte"; field: string; value: unknown };

/**
 * The `q` of `withIndex(name, q => ...)`: records the bounds in order (`withIndex` checks them against the index). One
 * object per call with its methods on the prototype, not five closures per call (they are called on `q`, chained).
 */
class RangeBuilder {
  readonly ops: RangeOp[] = [];
  eq(field: string, value: unknown): this {
    this.ops.push({ op: "eq", field, value });
    return this;
  }
  gt(field: string, value: unknown): this {
    this.ops.push({ op: "gt", field, value });
    return this;
  }
  gte(field: string, value: unknown): this {
    this.ops.push({ op: "gte", field, value });
    return this;
  }
  lt(field: string, value: unknown): this {
    this.ops.push({ op: "lt", field, value });
    return this;
  }
  lte(field: string, value: unknown): this {
    this.ops.push({ op: "lte", field, value });
    return this;
  }
}

export class QueryImpl {
  private index = "by_creation_time";
  private eqs: unknown[] = [];
  private lower: LowerBound | undefined;
  private upper: UpperBound | undefined;
  private direction: "asc" | "desc" = "asc";
  private filters: FilterExpr[] = [];
  private plugin: { kind: IndexKind; name: string; arg: unknown } | undefined;
  private consumed = false;

  constructor(
    private readonly env: QueryEnv,
    private readonly t: TableRuntime,
  ) {
    // The index kinds' query methods (`withSearchIndex`, ...) live on a prototype made once per set of kinds, not as
    // closures on every query: `new QueryImpl` hands out an instance of that subclass.
    if (new.target === QueryImpl) {
      const C = QueryImpl.classFor(env.kinds);
      if (C !== QueryImpl) return new C(env, t);
    }
  }

  /** A query over `t` (what `new QueryImpl(env, t)` gives, without building the discarded base instance). */
  static of(env: QueryEnv, t: TableRuntime): QueryImpl {
    return new (QueryImpl.classFor(env.kinds))(env, t);
  }

  private static readonly classes = new WeakMap<ReadonlyMap<string, IndexKind>, typeof QueryImpl>();

  /** QueryImpl, or a subclass with a method per kind's `queryMethod` (a later kind with the same name wins). */
  private static classFor(kinds: ReadonlyMap<string, IndexKind>): typeof QueryImpl {
    let C = QueryImpl.classes.get(kinds);
    if (C) return C;
    const withMethods = [...kinds.values()].filter((k) => k.queryMethod);
    if (!withMethods.length) C = QueryImpl;
    else {
      // A method named like an instance field (`index`, `filters`, ...) would be shadowed by it: those are set on each
      // instance after the fields, as the constructor used to set every one (found on the first instance).
      let own: IndexKind[] | undefined;
      C = class extends QueryImpl {
        constructor(env: QueryEnv, t: TableRuntime) {
          super(env, t);
          own ??= withMethods.filter((k) => Object.prototype.hasOwnProperty.call(this, k.queryMethod!));
          for (const kind of own) (this as unknown as Record<string, unknown>)[kind.queryMethod!] = (name: string, arg: unknown) => this.withPlugin(kind, name, arg);
        }
      };
      for (const kind of withMethods) {
        Object.defineProperty(C.prototype, kind.queryMethod!, {
          value: function (this: QueryImpl, name: string, arg: unknown) {
            return this.withPlugin(kind, name, arg);
          },
          writable: true,
          configurable: true,
        });
      }
    }
    QueryImpl.classes.set(kinds, C);
    return C;
  }

  fullTableScan(): this {
    return this;
  }

  withIndex(name: string, build?: (q: any) => unknown): this {
    if (this.plugin) throw new EmberError("QueryError", "withIndex() cannot follow a plugin index");
    const fields = indexFields(this.t.manifest, name);
    if (!fields) throw new EmberError("QueryError", `Index ${this.t.name}.${name} not found`);
    if (this.env.isStaged(this.t.name, name)) {
      throw new EmberError("IndexNotReady", `Index ${this.t.name}.${name} is still backfilling and cannot be queried yet`);
    }
    const b = new RangeBuilder();
    build?.(b);
    this.index = name;
    let i = 0;
    for (const o of b.ops) {
      const expected = fields[i];
      if (o.field !== expected) throw new EmberError("QueryError", `withIndex(${name}): ${o.op}(${o.field}) must be on ${expected ?? "(no more fields)"}`);
      if (o.op === "eq") {
        if (this.lower || this.upper) throw new EmberError("QueryError", `withIndex(${name}): eq() after a range bound`);
        this.eqs.push(o.value);
        i++;
      } else if (o.op === "gt" || o.op === "gte") {
        if (this.lower || this.upper) throw new EmberError("QueryError", `withIndex(${name}): only one lower bound, before the upper bound`);
        this.lower = { op: o.op, value: o.value };
      } else {
        if (this.upper) throw new EmberError("QueryError", `withIndex(${name}): only one upper bound`);
        this.upper = { op: o.op, value: o.value };
      }
    }
    if (name === "by_id" && (this.eqs.length !== 1 || this.lower || this.upper)) {
      throw new EmberError("QueryError", `withIndex(by_id) supports only q.eq("_id", id)`);
    }
    return this;
  }

  private withPlugin(kind: IndexKind, name: string, arg: unknown): this {
    const spec = this.t.manifest.indexes.find((i) => i.name === name && i.kind === kind.kind);
    if (!spec) throw new EmberError("QueryError", `${kind.kind} index ${this.t.name}.${name} not found`);
    if (this.env.isStaged(this.t.name, name)) throw new EmberError("IndexNotReady", `Index ${this.t.name}.${name} is still backfilling`);
    this.plugin = { kind, name, arg };
    return this;
  }

  order(direction: "asc" | "desc"): this {
    if (this.plugin) throw new EmberError("QueryError", "Results of a plugin index come in its own order");
    if (direction !== "asc" && direction !== "desc") throw new EmberError("QueryError", `order() takes "asc" or "desc"`);
    this.direction = direction;
    return this;
  }

  filter(predicate: (q: any) => unknown): this {
    this.filters.push(toExpr(predicate(filterBuilder)));
    return this;
  }

  take(n: number): Doc[] {
    if (!Number.isInteger(n) || n < 0) throw new EmberError("QueryError", "take(n) needs a non-negative integer");
    return this.run(n).docs;
  }
  collect(): Doc[] {
    const docs = this.run(Infinity).docs;
    const p = this.env.profile;
    if (p && docs.length > p.collectRows) p.collectRows = docs.length;
    return docs;
  }
  first(): Doc | null {
    return this.run(1).docs[0] ?? null;
  }
  unique(): Doc | null {
    const { docs } = this.run(2);
    if (docs.length > 1) throw new EmberError("QueryError", `unique() found more than one document in ${this.t.name}`);
    return docs[0] ?? null;
  }

  paginate(opts: PaginationOptions): PaginationResult<Doc> {
    if (!opts || !Number.isInteger(opts.numItems) || opts.numItems < 0) throw new EmberError("QueryError", "paginate() needs numItems >= 0");
    if (this.plugin) {
      // Plugin results are bounded (e.g. 1024 for search): one page, done.
      const { docs } = this.run(opts.numItems);
      return { page: docs, isDone: true, continueCursor: END_CURSOR };
    }
    if (opts.cursor === END_CURSOR) {
      this.consume();
      return { page: [], isDone: true, continueCursor: END_CURSOR };
    }
    const after = opts.cursor ? decodeCursor(opts.cursor) : undefined;
    const end = opts.endCursor && opts.endCursor !== END_CURSOR ? decodeCursor(opts.endCursor) : undefined;
    if (opts.endCursor) {
      const { docs } = this.run(Infinity, after, end);
      return { page: docs, isDone: opts.endCursor === END_CURSOR, continueCursor: opts.endCursor };
    }
    // Scan one past the page (peek) to know whether there is more.
    const { docs, keyAt } = this.run(opts.numItems + 1, after);
    if (docs.length > opts.numItems) {
      return { page: docs.slice(0, opts.numItems), isDone: false, continueCursor: encodeCursor(keyAt(opts.numItems - 1) ?? keyAt(0)!) };
    }
    return { page: docs, isDone: true, continueCursor: END_CURSOR };
  }

  private consume() {
    if (this.consumed) throw new EmberError("QueryError", "A query can only be run once");
    this.consumed = true;
  }

  /**
   * Scans the range in order, applies filters, stops after `want` matches, and records the covered range: up to
   * the last row examined when it stopped early, the whole range otherwise. `after`/`until` are pagination
   * cursors (exclusive / inclusive).
   */
  private run(want: number, after?: Uint8Array, until?: Uint8Array): { docs: Doc[]; keyAt: (i: number) => Uint8Array | undefined } {
    this.consume();
    const filter = andAll(this.filters);
    const { env, t } = this;

    if (this.plugin) {
      const { kind, name, arg } = this.plugin;
      const spec = t.manifest.indexes.find((i) => i.name === name)!;
      // No JS filter after it: the kind needs no more than `want` results (search asks FTS5 for just those).
      // `collect()` (want = Infinity) wants them all, which is the kind's own max anyway. The read set keeps the
      // limited run's `data`: rows past the limit still invalidate through `matchesChange` / `debounceTableWrites`.
      const out = !filter && want !== Infinity ? env.pluginQuery(kind, t, spec, arg, want) : env.pluginQuery(kind, t, spec, arg);
      env.readSet?.push({ table: t.name, index: name, lo: EMPTY, hi: EMPTY, kind: kind.kind, ...(out.data === undefined ? {} : { data: out.data }) });
      const docs = out.docs.filter((d) => passes(filter, d));
      return { docs: want === Infinity ? docs : docs.slice(0, want), keyAt: noKey };
    }

    let { lo, hi } = rangeFor(this.eqs, this.lower, this.upper);
    if (this.index === "by_id") {
      // A point read (`_id` is the whole key).
      const doc = env.getById(String(this.eqs[0]));
      const docs = doc && doc._id === this.eqs[0] && passes(filter, doc) && want > 0 ? [doc] : [];
      return { docs, keyAt: (i) => (i >= 0 && i < docs.length ? lo : undefined) };
    }
    const asc = this.direction === "asc";
    if (after) asc ? (lo = maxBytes(lo, keySuccessor(after))) : (hi = minBytes(hi, after));
    if (until) asc ? (hi = minBytes(hi, keySuccessor(until))) : (lo = maxBytes(lo, until));

    const docs: Doc[] = [];
    // The matching rows: their keys (a cursor needs one) are read only where used (compact format 3 computes them).
    const matched: ScannedRow[] = [];
    let stoppedAt: Uint8Array | undefined;
    if (want === 0) stoppedAt = asc ? lo : hi;
    let curLo = lo;
    let curHi = hi;
    let batches = 0;
    while (!stoppedAt && compareBytes(curLo, curHi) < 0) {
      // With a `.filter()` the rows needed are unknown: a first batch sized to the take (rows past the match are
      // billed reads), then larger ones while the filter keeps dropping rows. Without one, exactly what is left.
      const batch = filter ? filterBatch(want, batches++) : Math.min(want - docs.length, 1024);
      const rows = env.scan(t, this.index, curLo, curHi, asc, batch, filter);
      if (env.profile) env.profile.scanned += rows.length;
      let lastRow: ScannedRow | undefined;
      for (const row of rows) {
        lastRow = row;
        // A verdict from SQLite (pushdown.ts) is the one `passes` gives: a rejected row is never decoded.
        const m = row.match;
        if (m === false || (m === undefined && !passes(filter, row.doc))) {
          if (env.profile) env.profile.filteredOut++;
          continue;
        }
        docs.push(row.doc);
        matched.push(row);
        if (docs.length >= want) {
          stoppedAt = row.key;
          break;
        }
      }
      if (stoppedAt || rows.length < batch || !lastRow) break;
      const last = lastRow.key;
      if (asc) curLo = keySuccessor(last);
      else curHi = last;
    }
    if (env.readSet) {
      let rlo = lo;
      let rhi = hi;
      if (stoppedAt) asc ? (rhi = keySuccessor(stoppedAt)) : (rlo = stoppedAt);
      env.readSet.push({ table: t.name, index: this.index, lo: rlo, hi: rhi, kind: "db", ...(filter ? { filter } : {}) });
    }
    return { docs, keyAt: (i) => matched[i]?.key };
  }
}

const noKey = (): undefined => undefined;

// ------------------------------------------------------------------------------------------------ SQL backend

/** `SqlDriver.execRaw` through the transaction's counters: rows as arrays, in the statement's column order. */
export type RawExec = (sql: string, ...params: SqlValue[]) => SqlValue[][];

/**
 * `sqlScan` extras. `raw`: read a query's scan (`dataOnly: true`) as arrays, no object per row. `filter`: the run's
 * `.filter()` as pushed to SQLite (pushdown.ts): each row comes with its verdict (`ScannedRow.match`), and in a query
 * the rows it rejects come without their `_json` and text columns (never decoded).
 */
export type ScanOptions = { raw?: RawExec | undefined; filter?: PushedFilter | undefined };

/** At most this many bound values in a scan (DO SQLite allows 100 per statement): a wider filter stays in JS. */
const MAX_PARAMS = 100;

/** The SQL behind `QueryEnv.scan`: a range scan over the index's encoded key column (server and local SQLite). */
export function sqlScan(
  exec: (sql: string, ...params: SqlValue[]) => SqlRow[],
  t: TableRuntime,
  index: string,
  lo: Uint8Array,
  hi: Uint8Array,
  asc: boolean,
  limit: number,
  /**
   * true: only what the document needs (and the scanned key), no other `_k_*` BLOBs: a query's scan (no row cache).
   * "row": that and `_rowid`, the row handed out as `row` (a mutation's read cache: it writes by `_rowid` and compares
   * index keys from the documents, so it needs no `_k_*` BLOB either). false: every column (`SELECT *`).
   */
  dataOnly: boolean | "row" = false,
  opts?: ScanOptions,
): ScannedRow[] {
  const filter = dataOnly === false ? undefined : fitFilter(opts?.filter, 5);
  const raw = dataOnly === true ? opts?.raw : undefined;
  if (t.v3 && index === "by_creation_time") return creationScan(exec, t, lo, hi, asc, limit, dataOnly, filter, raw);
  const sql = scanSql(t, index, asc, dataOnly, filter);
  const range: SqlValue[] = t.compact && index === "by_creation_time" ? [rowidBound(lo, false), rowidBound(hi, true), lo, hi, limit] : [lo, hi, limit];
  const params = filter ? [...filter.params, ...range] : range;
  if (raw) {
    const rows = raw(sql, ...params);
    const n = t.layout.dataColumns.length;
    const out: ScannedRow[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const vals = rows[i]!;
      out[i] = new RawScannedRow(asBytes(vals[n]), t, vals, 0, filter ? verdict(vals[n + 1]) : undefined);
    }
    return out;
  }
  const kc = keyColumn(index);
  const rows = exec(sql, ...params);
  const out: ScannedRow[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    out[i] = new SqlScannedRow(asBytes(row[kc]), t, row, dataOnly === true ? undefined : row, filter ? verdict(row[VERDICT]) : undefined);
  }
  return out;
}

/** The column a pushed filter's verdict is read as (fields cannot start with "_"). */
const VERDICT = "_ember_m";

/** A verdict column's value: 1 passes, 0 does not, NULL is left to `passes`. */
const verdict = (x: SqlValue | undefined): boolean | undefined => (x === 1 ? true : x === 0 ? false : undefined);

/** The filter, if its values fit next to `others` bound values: else none (evaluated in JS). */
const fitFilter = (f: PushedFilter | undefined, others: number): PushedFilter | undefined => (f && f.params.length + others <= MAX_PARAMS ? f : undefined);

/**
 * A scan statement: `cols` (data columns, maybe after `_rowid`) and `tail`, then the verdict of `filter`, then `rest`
 * (`FROM ... LIMIT ?`). In a query (`hide`) the `_json` and TEXT/BLOB columns of a row the filter rejects come back
 * NULL: the scan is a co-routine (an outer `LIMIT -1`: SQLite does not flatten a subquery with a LIMIT into a query
 * with one), so the verdict is computed once per row and the outer select only reads it. Its `?` come first.
 */
function scanStatement(t: TableRuntime, cols: readonly string[], tail: readonly string[], filter: PushedFilter | undefined, hide: boolean, rest: string): string {
  const list = [...cols, ...tail].map(q).join(", ");
  if (!filter) return `SELECT ${list} ${rest}`;
  const inner = `SELECT ${list}, ${filter.sql} AS ${q(VERDICT)} ${rest}`;
  const heavy = hide ? new Set(cols.filter((c) => c === "_json" || HEAVY.has(t.layout.column(c)?.spec.cls ?? ""))) : undefined;
  if (!heavy?.size) return inner;
  const outer = [...cols.map((c) => (heavy.has(c) ? `CASE WHEN ${q(VERDICT)} IS 0 THEN NULL ELSE ${q(c)} END AS ${q(c)}` : q(c))), ...tail.map(q), q(VERDICT)];
  return `SELECT ${outer.join(", ")} FROM (${inner}) LIMIT -1`;
}

/** Column classes worth not handing to JS for a row a pushed filter rejects. */
const HEAVY = new Set(["text", "bytes", "int64"]);

/**
 * A scanned SQL row whose document is decoded on first use: a `.filter()` scan that stops at its n-th match never
 * decodes the rest of the batch. Decoded once (the same object on every read of `doc`). The key of a compact format 3
 * `by_creation_time` row (`creationScan`) is computed on first use too, from `_creationTime` and `_id`: a scan reads
 * only the last one (where it continues or stops) and a cursor's.
 */
class SqlScannedRow implements ScannedRow {
  private decoded: Doc | undefined;
  constructor(
    private k: Uint8Array | undefined,
    private readonly t: TableRuntime,
    private readonly raw: SqlRow,
    readonly row: SqlRow | undefined,
    readonly match: boolean | undefined,
  ) {}
  get key(): Uint8Array {
    return (this.k ??= creationKey(this.raw));
  }
  get doc(): Doc {
    return (this.decoded ??= this.t.decode(this.raw));
  }
}

/** `SqlScannedRow` over a row read as an array (`ScanOptions.raw`): `layout.dataColumns` from `base`. */
class RawScannedRow implements ScannedRow {
  private decoded: Doc | undefined;
  readonly row = undefined;
  constructor(
    private k: Uint8Array | undefined,
    private readonly t: TableRuntime,
    private readonly vals: SqlValue[],
    private readonly base: number,
    readonly match: boolean | undefined,
  ) {}
  get key(): Uint8Array {
    return (this.k ??= encodeKey([Number(this.vals[this.base + 1]), String(this.vals[this.base])]));
  }
  get doc(): Doc {
    return (this.decoded ??= decodeValues(this.t.layout, this.vals, this.base));
  }
}

/** The `by_creation_time` key of a row (`[_creationTime, _id]`), as the format 2 column holds it. */
const creationKey = (row: SqlRow): Uint8Array => encodeKey([Number(row._creationTime), String(row._id)]);

/** Scan statements per table runtime (index, direction, columns, pushed filter): built once, not per call. */
const scanSqlCache = new WeakMap<TableRuntime, Map<string, string>>();

/** Distinct statements kept per table (pushed filters vary by expression shape, never by value). */
const MAX_CACHED_SCANS = 256;

function cached(cache: WeakMap<TableRuntime, Map<string, string>>, t: TableRuntime, k: string, build: () => string): string {
  let byKey = cache.get(t);
  if (!byKey) cache.set(t, (byKey = new Map()));
  let plan = byKey.get(k);
  if (plan !== undefined) return plan;
  plan = build();
  if (byKey.size >= MAX_CACHED_SCANS) byKey.clear();
  byKey.set(k, plan);
  return plan;
}

function scanSql(t: TableRuntime, index: string, asc: boolean, dataOnly: boolean | "row", filter: PushedFilter | undefined): string {
  const k = `${index}\u0000${asc ? 1 : 0}${dataOnly === "row" ? 2 : dataOnly ? 1 : 0}${t.compact ? 1 : 0}${filter ? `\u0000${filter.sql}` : ""}`;
  return cached(scanSqlCache, t, k, () => {
    const kc = keyColumn(index);
    const col = q(kc);
    // `_rowid` is `_creationTime` in µs on compact storage: a primary-key range around the bounds, the key column the
    // exact filter.
    const rest =
      t.compact && index === "by_creation_time"
        ? `FROM ${q(t.name)} WHERE "_rowid" >= ? AND "_rowid" <= ? AND ${col} >= ? AND ${col} < ? ORDER BY "_rowid" ${asc ? "ASC" : "DESC"} LIMIT ?`
        : `FROM ${q(t.name)} INDEXED BY ${q(`${t.name}__${index}`)} WHERE ${col} >= ? AND ${col} < ? ORDER BY ${col} ${asc ? "ASC" : "DESC"} LIMIT ?`;
    if (!dataOnly) return `SELECT * ${rest}`;
    return scanStatement(t, dataOnly === "row" ? ["_rowid", ...t.layout.dataColumns] : t.layout.dataColumns, [kc], filter, dataOnly === true, rest);
  });
}

const MIN_ROWID = -Number.MAX_SAFE_INTEGER;
const MAX_ROWID = Number.MAX_SAFE_INTEGER;
const boundView = new DataView(new ArrayBuffer(8));

/**
 * A `_rowid` (µs) bound that contains every row whose `by_creation_time` key is past `key` (`upper`: before it),
 * widened by 2 µs: the key column filters exactly. Keys are `[_creationTime, _id]`; a bound that does not start with
 * a full number is before (or after) every number.
 */
function rowidBound(key: Uint8Array, upper: boolean): number {
  const tag = key[0];
  // Empty or a lower type tag: before every number. A higher tag (or 0xFF): after every number.
  if (tag === undefined || tag < 0x04) return MIN_ROWID;
  if (tag > 0x04) return MAX_ROWID;
  if (key.length < 9) return upper ? MAX_ROWID : MIN_ROWID;
  // Number encoding (values key.ts): sign-flipped IEEE 754 big-endian.
  const first = key[1]!;
  const negative = (first & 0x80) === 0;
  boundView.setUint8(0, negative ? first ^ 0xff : first ^ 0x80);
  for (let i = 1; i < 8; i++) boundView.setUint8(i, negative ? key[i + 1]! ^ 0xff : key[i + 1]!);
  const ms = boundView.getFloat64(0);
  if (Number.isNaN(ms)) return upper ? MAX_ROWID : MIN_ROWID;
  const us = upper ? Math.ceil(ms * 1000) + 2 : Math.floor(ms * 1000) - 2;
  return Math.min(MAX_ROWID, Math.max(MIN_ROWID, us));
}

/**
 * A `_creationTime` bound of a `by_creation_time` scan on compact format 3 (`creationScan`): a superset of the rows
 * whose key is past `key` (`upper`: before it), on the column, so SQL drops the rows of the `_rowid` window around the
 * bound that are out of range before its LIMIT counts them. `strict`: `>`/`<` instead of `>=`/`<=`, only where that
 * drops no row in range. `exact`: every row passing it is in range, so the bound costs no row the scan then skips.
 */
type CreationBound = { value: number; strict: boolean; exact: boolean };
const NO_LOWER: CreationBound = { value: -Number.MAX_VALUE, strict: false, exact: true };
const NO_UPPER: CreationBound = { value: Number.MAX_VALUE, strict: false, exact: true };

/**
 * For `creationScan`: a number `n` such that every row whose `_creationTime` is past it (`upper`: before it) has its
 * key past `key` (before it), whatever its `_id`: the key's first value when it is a full number (the row's key then
 * differs in that number already), ±Infinity when every number key is past it, NaN when no row can be told by its
 * number alone (a key before every number for an upper bound, a truncated or NaN one). -0 and +0 are two keys but no
 * number is strictly between them, so a row at zero is never told apart this way.
 */
function fastBound(key: Uint8Array, upper: boolean): number {
  const tag = key[0];
  if (tag === undefined) return upper ? NaN : -Infinity;
  if (tag < 0x04) return upper ? NaN : -Infinity;
  if (tag > 0x04) return upper ? Infinity : NaN;
  if (key.length < 9) return NaN;
  const first = key[1]!;
  const negative = (first & 0x80) === 0;
  boundView.setUint8(0, negative ? first ^ 0xff : first ^ 0x80);
  for (let i = 1; i < 8; i++) boundView.setUint8(i, negative ? key[i + 1]! ^ 0xff : key[i + 1]!);
  return boundView.getFloat64(0);
}

function creationBound(key: Uint8Array, upper: boolean): CreationBound {
  // Not a full number first (empty, another type, truncated): no bound on the column (`_rowid` and the key filter do
  // it); a key of a lower type tag is before every number (a lower bound, exact), a higher one after (an upper one).
  if (key[0] !== 0x04 || key.length < 9) return upper ? { ...NO_UPPER, exact: key[0] === undefined || key[0] > 0x04 } : { ...NO_LOWER, exact: key[0] === undefined || key[0] < 0x04 };
  const first = key[1]!;
  const negative = (first & 0x80) === 0;
  boundView.setUint8(0, negative ? first ^ 0xff : first ^ 0x80);
  for (let i = 1; i < 8; i++) boundView.setUint8(i, negative ? key[i + 1]! ^ 0xff : key[i + 1]!);
  const n = boundView.getFloat64(0);
  // NaN (only a forged cursor holds one; a negative NaN sorts before every number): no bound on the column.
  if (Number.isNaN(n)) return upper ? { ...NO_UPPER, exact: false } : { ...NO_LOWER, exact: false };
  // The rest after the number: nothing (`gte`/`lt` of a `_creationTime`), 0xFF (`gt`/`lte`), or more (an `_id`, a cursor).
  const rest = key.length === 9 ? "none" : key[9] === 0xff ? "ff" : "more";
  // ±Infinity are bound as the largest finite numbers (every stored `_creationTime` is finite), non-strict.
  const value = Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, n));
  const finite = value === n;
  // -0 and +0 are two keys (-0 first) but equal in SQL: never strict at zero.
  if (!upper) {
    // Keys >= [n]: `_creationTime` >= n. Keys >= [n] ++ 0xFF: > n. Keys >= [n, ...]: >= n, the rows at n checked by key.
    const strict = rest === "ff" && finite && n !== 0;
    return { value, strict, exact: finite && n !== 0 && (rest === "none" || strict) };
  }
  // Keys < [n]: `_creationTime` < n. Keys < [n] ++ 0xFF: <= n. Keys < [n, ...]: <= n, the rows at n checked by key.
  const strict = rest === "none" && finite && n !== 0;
  return { value, strict, exact: finite && n !== 0 && (rest === "ff" || strict) };
}

const creationSqlCache = new WeakMap<TableRuntime, Map<string, string>>();

function creationSql(t: TableRuntime, asc: boolean, dataOnly: boolean | "row", lo: CreationBound, hi: CreationBound, filter: PushedFilter | undefined): string {
  // "row" selects what `true` does (`_rowid` is there already), unless a pushed filter hides rejected rows' columns.
  const k = `${asc ? 1 : 0}${dataOnly ? 1 : 0}${lo.strict ? 1 : 0}${hi.strict ? 1 : 0}${filter ? `${dataOnly === true ? 1 : 0}\u0000${filter.sql}` : ""}`;
  return cached(creationSqlCache, t, k, () => {
    const rest =
      `FROM ${q(t.name)} WHERE "_rowid" >= ? AND "_rowid" <= ? ` +
      `AND "_creationTime" ${lo.strict ? ">" : ">="} ? AND "_creationTime" ${hi.strict ? "<" : "<="} ? ORDER BY "_rowid" ${asc ? "ASC" : "DESC"} LIMIT ?`;
    // `_rowid` (the loop below continues from the last one) and what the document needs: no `_k_*` BLOBs.
    return dataOnly ? scanStatement(t, ["_rowid", ...t.layout.dataColumns], [], filter, dataOnly === true, rest) : `SELECT * ${rest}`;
  });
}

/**
 * `by_creation_time` on compact format 3 (storage.ts): a primary-key range, as on format 2, with the key the format 2
 * column held (`[_creationTime, _id]`) computed per row and filtered exactly in `[lo, hi)`. The `_rowid` window is
 * widened (`rowidBound`) and the `_creationTime` bounds are a superset (`creationBound`), so a row the key filter skips
 * can only be one in the same `_creationTime` as a bound (a cursor's own row): the first statement asks for one more
 * row then, and the scan goes on from the last `_rowid` whenever skipped rows left it short, so the result is exact
 * however many rows a bound skips. With `raw`, rows are arrays: `_rowid`, then `layout.dataColumns`, then the verdict.
 */
function creationScan(
  exec: (sql: string, ...params: SqlValue[]) => SqlRow[],
  t: TableRuntime,
  lo: Uint8Array,
  hi: Uint8Array,
  asc: boolean,
  limit: number,
  dataOnly: boolean | "row",
  filter: PushedFilter | undefined,
  raw: RawExec | undefined,
): ScannedRow[] {
  const out: ScannedRow[] = [];
  if (!(limit > 0) || compareBytes(lo, hi) >= 0) return out;
  const cLo = creationBound(lo, false);
  const cHi = creationBound(hi, true);
  const sql = creationSql(t, asc, dataOnly, cLo, cHi, filter);
  const ahead = filter ? filter.params : [];
  const n = t.layout.dataColumns.length;
  let rLo = rowidBound(lo, false);
  let rHi = rowidBound(hi, true);
  let want = limit + ((asc ? cLo : cHi).exact ? 0 : 1);
  // A row strictly between these numbers is in range without its key: only rows at a bound's own number are encoded
  // and compared (their keys are kept, the others computed on use).
  const fLo = fastBound(lo, false);
  const fHi = fastBound(hi, true);
  for (;;) {
    let count: number;
    let last: number;
    if (raw) {
      const rows = raw(sql, ...ahead, rLo, rHi, cLo.value, cHi.value, want);
      count = rows.length;
      last = count ? Number(rows[count - 1]![0]) : 0;
      for (let i = 0; i < count; i++) {
        const vals = rows[i]!;
        const ct = Number(vals[2]);
        let key: Uint8Array | undefined;
        if (!(ct > fLo && ct < fHi)) {
          key = encodeKey([ct, String(vals[1])]);
          if (compareBytes(key, lo) < 0 || compareBytes(key, hi) >= 0) continue;
        }
        out.push(new RawScannedRow(key, t, vals, 1, filter ? verdict(vals[1 + n]) : undefined));
        if (out.length >= limit) return out;
      }
    } else {
      const rows = exec(sql, ...ahead, rLo, rHi, cLo.value, cHi.value, want);
      count = rows.length;
      last = count ? Number(rows[count - 1]!._rowid) : 0;
      for (let i = 0; i < count; i++) {
        const row = rows[i]!;
        const ct = Number(row._creationTime);
        let key: Uint8Array | undefined;
        if (!(ct > fLo && ct < fHi)) {
          key = creationKey(row);
          if (compareBytes(key, lo) < 0 || compareBytes(key, hi) >= 0) continue;
        }
        out.push(new SqlScannedRow(key, t, row, dataOnly === true ? undefined : row, filter ? verdict(row[VERDICT]) : undefined));
        if (out.length >= limit) return out;
      }
    }
    if (count < want) return out;
    if (asc) rLo = last + 1;
    else rHi = last - 1;
    if (rLo > rHi) return out;
    want = limit - out.length;
  }
}

/** The SQL behind `QueryEnv.pluginQuery`: the kind's own `query` (FTS5 for search). */
export function sqlPluginQuery(
  exec: (sql: string, ...params: SqlValue[]) => SqlRow[],
  kind: IndexKind,
  t: TableRuntime,
  spec: IndexSpec,
  arg: unknown,
  limit?: number,
): { docs: Doc[]; data?: unknown } {
  if (!kind.query) throw new EmberError("QueryError", `Index kind ${kind.kind} cannot be queried in a query/mutation`);
  return kind.query({ layout: t.layout, spec, exec, decode: t.decode, ...(limit === undefined ? {} : { limit }) }, arg);
}
