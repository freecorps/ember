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
import { keyColumn, type Layout } from "./layout.ts";
import type { TableInfo, TableManifest } from "./schema.ts";
import type { Doc, FilterExpr, ReadSet } from "./types.ts";

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
export interface UpperBoundBuilder<D, F extends string> extends IndexRange {
  lt(field: F, value: FieldTypeFromPath<D, F>): IndexRange;
  lte(field: F, value: FieldTypeFromPath<D, F>): IndexRange;
}
export interface LowerBoundBuilder<D, F extends string> extends UpperBoundBuilder<D, F> {
  gt(field: F, value: FieldTypeFromPath<D, F>): UpperBoundBuilder<D, F>;
  gte(field: F, value: FieldTypeFromPath<D, F>): UpperBoundBuilder<D, F>;
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
}

/** What a query needs from the running transaction. */
export interface QueryEnv {
  /** Runs SQL, counted against the transaction's limits. */
  exec(sql: string, ...params: SqlValue[]): SqlRow[];
  table(name: string): TableRuntime;
  /** Where reads are recorded (queries); null in mutations. */
  readSet: ReadSet | null;
  isStaged(table: string, index: string): boolean;
  kinds: ReadonlyMap<string, IndexKind>;
  getById(id: string): Doc | null;
}

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
const asBytes = (x: unknown): Uint8Array =>
  x instanceof Uint8Array ? x : x instanceof ArrayBuffer ? new Uint8Array(x) : (() => { throw new Error("Index key column is not a BLOB"); })();
const maxBytes = (a: Uint8Array, b: Uint8Array) => (compareBytes(a, b) >= 0 ? a : b);
const minBytes = (a: Uint8Array, b: Uint8Array) => (compareBytes(a, b) <= 0 ? a : b);

type RangeOp = { op: "eq" | "gt" | "gte" | "lt" | "lte"; field: string; value: unknown };

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
    for (const kind of env.kinds.values()) {
      if (kind.queryMethod) (this as any)[kind.queryMethod] = (name: string, arg: unknown) => this.withPlugin(kind, name, arg);
    }
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
    const ops: RangeOp[] = [];
    const b: any = {};
    for (const op of ["eq", "gt", "gte", "lt", "lte"] as const) {
      b[op] = (field: string, value: unknown) => {
        ops.push({ op, field, value });
        return b;
      };
    }
    build?.(b);
    this.index = name;
    let i = 0;
    for (const o of ops) {
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
    return this.run(Infinity).docs;
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
    const { docs, keys } = this.run(opts.numItems + 1, after);
    if (docs.length > opts.numItems) {
      return { page: docs.slice(0, opts.numItems), isDone: false, continueCursor: encodeCursor(keys[opts.numItems - 1] ?? keys[0]!) };
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
  private run(want: number, after?: Uint8Array, until?: Uint8Array): { docs: Doc[]; keys: Uint8Array[] } {
    this.consume();
    const filter = andAll(this.filters);
    const { env, t } = this;

    if (this.plugin) {
      const { kind, name, arg } = this.plugin;
      const spec = t.manifest.indexes.find((i) => i.name === name)!;
      if (!kind.query) throw new EmberError("QueryError", `Index kind ${kind.kind} cannot be queried in a query/mutation`);
      const out = kind.query({ layout: t.layout, spec, exec: env.exec, decode: t.decode }, arg);
      env.readSet?.push({ table: t.name, index: name, lo: EMPTY, hi: EMPTY, kind: kind.kind, ...(out.data === undefined ? {} : { data: out.data }) });
      const docs = out.docs.filter((d) => passes(filter, d));
      return { docs: want === Infinity ? docs : docs.slice(0, want), keys: [] };
    }

    let { lo, hi } = rangeFor(this.eqs, this.lower, this.upper);
    if (this.index === "by_id") {
      // A point read (`_id` is the whole key).
      const doc = env.getById(String(this.eqs[0]));
      const docs = doc && doc._id === this.eqs[0] && passes(filter, doc) && want > 0 ? [doc] : [];
      return { docs, keys: docs.map(() => lo) };
    }
    const asc = this.direction === "asc";
    if (after) asc ? (lo = maxBytes(lo, keySuccessor(after))) : (hi = minBytes(hi, after));
    if (until) asc ? (hi = minBytes(hi, keySuccessor(until))) : (lo = maxBytes(lo, until));

    const docs: Doc[] = [];
    const keys: Uint8Array[] = [];
    let stoppedAt: Uint8Array | undefined;
    if (want === 0) stoppedAt = asc ? lo : hi;
    let curLo = lo;
    let curHi = hi;
    const col = q(keyColumn(this.index));
    const sql = `SELECT * FROM ${q(t.name)} INDEXED BY ${q(`${t.name}__${this.index}`)} WHERE ${col} >= ? AND ${col} < ? ORDER BY ${col} ${asc ? "ASC" : "DESC"} LIMIT ?`;
    while (!stoppedAt && compareBytes(curLo, curHi) < 0) {
      const batch = filter ? 128 : Math.min(want - docs.length, 1024);
      const rows = env.exec(sql, curLo, curHi, batch);
      let last: Uint8Array | undefined;
      for (const row of rows) {
        const key = asBytes(row[keyColumn(this.index)]);
        last = key;
        const doc = t.decode(row);
        if (!passes(filter, doc)) continue;
        docs.push(doc);
        keys.push(key);
        if (docs.length >= want) {
          stoppedAt = key;
          break;
        }
      }
      if (stoppedAt || rows.length < batch || !last) break;
      if (asc) curLo = keySuccessor(last);
      else curHi = last;
    }
    if (env.readSet) {
      let rlo = lo;
      let rhi = hi;
      if (stoppedAt) asc ? (rhi = keySuccessor(stoppedAt)) : (rlo = stoppedAt);
      env.readSet.push({ table: t.name, index: this.index, lo: rlo, hi: rhi, kind: "db", ...(filter ? { filter } : {}) });
    }
    return { docs, keys };
  }
}
