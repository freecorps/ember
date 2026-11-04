// The runtime: one shard's database (a Durable Object's SQLite in production), function execution, read-set
// recording for queries and change capture for mutations.

import { applyPlan, decodeColumn, layoutOf, planMigration, type Column, type Plan } from "./ddl";
import { compareValues, decodeId, encodeId, inRange, keyOf, keyPart } from "./keys";
import { indexKind, registeredIndexKinds, type IndexKindPlugin, type SchemaDefinition, type SchemaJson, type TableLayout } from "./schema";
import type { RegisteredFunction } from "./server";
import { q, type Sql } from "./sqlite";
import type { Bound, Doc, FilterExpr, ReadSetEntry, RowChange } from "./types";
import { fromJson, isPlainObject, toJson, validate, type FieldShape, type Shape } from "./values";

type TableRuntime = {
  name: string;
  number: number;
  shape: Shape & { kind: "object" };
  layout: TableLayout & { columns: Column[] };
  columnSet: Set<string>;
  indexFields: Map<string, string[]>; // db + system indexes -> full key fields incl. tiebreakers
};

export class Engine {
  readonly tables = new Map<string, TableRuntime>();
  private readonly byNumber = new Map<number, string>();
  private lastCreationTime = 0;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly sql: Sql,
    readonly schema: SchemaJson,
  ) {
    const numbers = new Map(
      sql.all<{ name: string; number: bigint }>(`SELECT name, number FROM "_cfx_tables"`).map((r) => [r.name, Number(r.number)]),
    );
    for (const [name, def] of Object.entries(schema.tables)) {
      const shape = def.documentShape as Shape & { kind: "object" };
      const layout = layoutOf(name, shape);
      const indexFields = new Map<string, string[]>([
        ["by_id", ["_id"]],
        ["by_creation_time", ["_creationTime", "_id"]],
      ]);
      for (const i of def.indexes) if (i.kind === "db") indexFields.set(i.name, [...i.fields, "_creationTime", "_id"]);
      const number = numbers.get(name)!;
      this.tables.set(name, { name, number, shape, layout, columnSet: new Set(layout.columns.map((c) => c.field)), indexFields });
      this.byNumber.set(number, name);
    }
  }

  /** Plans and applies the schema (refusing unsafe changes), then opens the engine. Like a Convex push. */
  static push(sql: Sql, schema: SchemaDefinition<any> | SchemaJson): { engine: Engine; plan: Plan } {
    const json = "export" in schema && typeof schema.export === "function" ? schema.export() : (schema as SchemaJson);
    const tableOfId = (id: string) => {
      try {
        const n = decodeId(id);
        return sql.all<{ name: string }>(`SELECT name FROM "_cfx_tables" WHERE number = ?`, n ?? -1)[0]?.name;
      } catch {
        return undefined;
      }
    };
    const plan = planMigration(sql, json, tableOfId);
    applyPlan(sql, plan, json);
    return { engine: new Engine(sql, json), plan };
  }

  tableOfId = (id: string): string | undefined => {
    const n = decodeId(id);
    return n === undefined ? undefined : this.byNumber.get(n);
  };

  table(name: string): TableRuntime {
    const t = this.tables.get(name);
    if (!t) throw new Error(`Unknown table ${name}`);
    return t;
  }

  // ------------------------------------------------------------------------------------------- row codec

  decode(t: TableRuntime, row: Record<string, unknown>): Doc {
    const rest = fromJson(String(row._rest ?? "{}"));
    const doc: Record<string, unknown> = { _id: row._id, _creationTime: Number(row._creationTime) };
    for (const [field, f] of Object.entries(t.shape.fields)) {
      if (t.columnSet.has(field)) {
        const x = row[field];
        if (x === null || x === undefined) {
          if (!f.optional) doc[field] = null; // required + nullable
        } else doc[field] = decodeColumn(f.shape, x);
      } else if (rest[field] !== undefined) doc[field] = rest[field];
    }
    return doc as Doc;
  }

  private encode(t: TableRuntime, doc: Record<string, unknown>): { cols: string[]; vals: unknown[] } {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const rest: Record<string, unknown> = {};
    for (const c of t.layout.columns) {
      const x = doc[c.field];
      cols.push(c.field);
      vals.push(x === undefined ? null : typeof x === "boolean" ? (x ? 1 : 0) : x);
    }
    for (const [k, x] of Object.entries(doc)) {
      if (k === "_id" || k === "_creationTime" || t.columnSet.has(k) || x === undefined) continue;
      rest[k] = x;
    }
    cols.push("_rest");
    vals.push(toJson(rest));
    return { cols, vals };
  }

  private check(t: TableRuntime, value: Record<string, unknown>) {
    for (const k of Object.keys(value)) if (k.startsWith("_")) throw new Error(`System field ${k} cannot be written`);
    if (!this.schema.schemaValidation) return;
    const issues = validate(t.shape, value, this.tableOfId);
    if (issues.length) throw new Error(`Document for ${t.name} is invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }

  private rawGet(id: string): { t: TableRuntime; doc: Doc } | undefined {
    const tableName = this.tableOfId(id);
    if (!tableName) return undefined;
    const t = this.table(tableName);
    const row = this.sql.all(`SELECT * FROM ${q(t.name)} WHERE "_id" = ?`, id)[0];
    return row ? { t, doc: this.decode(t, row) } : undefined;
  }

  // ------------------------------------------------------------------------------------------- db objects

  reader(readSet: ReadSetEntry[]) {
    const engine = this;
    return {
      async get(id: string) {
        const table = engine.tableOfId(id);
        if (!table) return null;
        readSet.push({ kind: "range", table, index: "by_id", fields: ["_id"], lower: { key: [id], inclusive: true }, upper: { key: [id], inclusive: true } });
        return engine.rawGet(id)?.doc ?? null;
      },
      query(table: string) {
        return new QueryImpl(engine, engine.table(table), readSet);
      },
    };
  }

  writer(changes: Map<string, RowChange>) {
    const engine = this;
    const record = (table: string, id: string, before: Doc | undefined, after: Doc | undefined) => {
      const prev = changes.get(id);
      changes.set(id, { table, id, before: prev ? prev.before : before, after });
    };
    const write = (t: TableRuntime, doc: Doc, kind: "insert" | "update") => {
      const { cols, vals } = engine.encode(t, doc);
      if (kind === "insert") {
        engine.sql.run(
          `INSERT INTO ${q(t.name)} ("_id", "_creationTime", ${cols.map(q).join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})`,
          doc._id, doc._creationTime, ...vals,
        );
      } else {
        engine.sql.run(`UPDATE ${q(t.name)} SET ${cols.map((c) => `${q(c)} = ?`).join(", ")} WHERE "_id" = ?`, ...vals, doc._id);
      }
    };
    return {
      ...this.reader([]),
      async insert(table: string, value: Record<string, unknown>) {
        const t = engine.table(table);
        engine.check(t, value);
        const now = Math.max(Date.now(), engine.lastCreationTime + 0.001);
        engine.lastCreationTime = now;
        const doc = { ...stripUndefined(value), _id: encodeId(t.number), _creationTime: now } as Doc;
        write(t, doc, "insert");
        record(t.name, doc._id, undefined, engine.rawGet(doc._id)!.doc);
        return doc._id;
      },
      async patch(id: string, value: Record<string, unknown>) {
        const cur = engine.rawGet(id);
        if (!cur) throw new Error(`Document ${id} not found`);
        const { _id, _creationTime, ...fields } = cur.doc;
        const next = stripUndefined({ ...fields, ...value }, value);
        engine.check(cur.t, next);
        write(cur.t, { ...next, _id, _creationTime } as Doc, "update");
        record(cur.t.name, id, cur.doc, engine.rawGet(id)!.doc);
      },
      async replace(id: string, value: Record<string, unknown>) {
        const cur = engine.rawGet(id);
        if (!cur) throw new Error(`Document ${id} not found`);
        engine.check(cur.t, value);
        write(cur.t, { ...stripUndefined(value), _id: id, _creationTime: cur.doc._creationTime } as Doc, "update");
        record(cur.t.name, id, cur.doc, engine.rawGet(id)!.doc);
      },
      async delete(id: string) {
        const cur = engine.rawGet(id);
        if (!cur) throw new Error(`Document ${id} not found`);
        engine.sql.run(`DELETE FROM ${q(cur.t.name)} WHERE "_id" = ?`, id);
        record(cur.t.name, id, cur.doc, undefined);
      },
    };
  }

  // ------------------------------------------------------------------------------------------- functions

  private checkArgs(fn: RegisteredFunction<any, any, any, any>, args: unknown) {
    const issues = validate(fn.args, args ?? {}, this.tableOfId);
    if (issues.length) throw new Error(`Invalid arguments: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }

  async runQuery(fn: RegisteredFunction<"query", any, any, any>, args: unknown = {}): Promise<{ value: unknown; readSet: ReadSetEntry[] }> {
    if (fn.type !== "query") throw new Error("Not a query");
    this.checkArgs(fn, args);
    const readSet: ReadSetEntry[] = [];
    const value = await fn.handler({ db: this.reader(readSet) }, args);
    return { value, readSet };
  }

  /**
   * Runs a mutation atomically and returns the rows it changed. Mutations are serialised (a DO runs one at a
   * time anyway), so no OCC is needed: nothing else can write between its reads and its commit.
   */
  runMutation(fn: RegisteredFunction<"mutation", any, any, any>, args: unknown = {}): Promise<{ value: unknown; changes: RowChange[] }> {
    const run = async () => {
      if (fn.type !== "mutation") throw new Error("Not a mutation");
      this.checkArgs(fn, args);
      const changes = new Map<string, RowChange>();
      this.sql.run("SAVEPOINT mutation");
      try {
        const value = await fn.handler({ db: this.writer(changes) }, args);
        this.sql.run("RELEASE mutation");
        // A row inserted and deleted in the same mutation is no change at all.
        return { value, changes: [...changes.values()].filter((c) => c.before || c.after) };
      } catch (e) {
        this.sql.run("ROLLBACK TO mutation");
        this.sql.run("RELEASE mutation");
        throw e;
      }
    };
    const result = this.mutationQueue.then(run, run);
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }
}

function stripUndefined(doc: Record<string, unknown>, patch?: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(doc)) if (x !== undefined && !(patch && k in patch && patch[k] === undefined)) out[k] = x;
  return out;
}

// --------------------------------------------------------------------------------------------- queries

type RangeOp = { op: "eq" | "gt" | "gte" | "lt" | "lte"; field: string; value: unknown };

class QueryImpl {
  private index = "by_creation_time";
  private fields: string[];
  private lower: Bound | null = null;
  private upper: Bound | null = null;
  private direction: "asc" | "desc" = "asc";
  private filters: FilterExpr[] = [];
  private plugin: { plugin: IndexKindPlugin; name: string; arg: unknown } | undefined;
  private consumed = false;

  constructor(
    private readonly engine: Engine,
    private readonly t: TableRuntime,
    private readonly readSet: ReadSetEntry[],
  ) {
    this.fields = t.indexFields.get("by_creation_time")!;
    for (const plugin of registeredIndexKinds()) {
      if (plugin.queryMethod) (this as any)[plugin.queryMethod] = (name: string, arg: unknown) => this.withPlugin(plugin, name, arg);
    }
  }

  fullTableScan() {
    return this;
  }

  withIndex(name: string, build?: (q: any) => unknown) {
    const fields = this.t.indexFields.get(name);
    if (!fields) throw new Error(`Index ${this.t.name}.${name} not found`);
    this.index = name;
    this.fields = fields;
    const ops: RangeOp[] = [];
    const b: any = new Proxy({}, {
      get: (_, op: string) => (field: string, value: unknown) => {
        ops.push({ op: op as RangeOp["op"], field, value });
        return b;
      },
    });
    build?.(b);
    const eqs: unknown[] = [];
    let i = 0;
    let lo: RangeOp | undefined;
    let hi: RangeOp | undefined;
    for (const o of ops) {
      if (o.op === "eq") {
        if (lo || hi || o.field !== fields[i]) throw new Error(`withIndex(${name}): eq(${o.field}) out of order`);
        eqs.push(normKey(o.value));
        i++;
      } else if (o.field !== fields[i]) throw new Error(`withIndex(${name}): ${o.op}(${o.field}) must be on ${fields[i]}`);
      else if (o.op === "gt" || o.op === "gte") lo = o;
      else hi = o;
    }
    this.lower = lo ? { key: [...eqs, normKey(lo.value)], inclusive: lo.op === "gte" } : eqs.length ? { key: eqs, inclusive: true } : null;
    this.upper = hi ? { key: [...eqs, normKey(hi.value)], inclusive: hi.op === "lte" } : eqs.length ? { key: eqs, inclusive: true } : null;
    return this;
  }

  private withPlugin(plugin: IndexKindPlugin, name: string, arg: unknown) {
    const spec = this.engine.schema.tables[this.t.name]!.indexes.find((i) => i.name === name && i.kind === plugin.kind);
    if (!spec) throw new Error(`${plugin.kind} index ${this.t.name}.${name} not found`);
    this.plugin = { plugin, name, arg };
    return this;
  }

  order(direction: "asc" | "desc") {
    if (this.plugin) throw new Error("Results of a plugin index come in its own order");
    this.direction = direction;
    return this;
  }

  filter(predicate: (q: any) => unknown) {
    this.filters.push(toExpr(predicate(filterBuilder)));
    return this;
  }

  async take(n: number) {
    return this.run({ limit: n }).docs;
  }
  async collect() {
    return this.run({}).docs;
  }
  async first() {
    return this.run({ limit: 1 }).docs[0] ?? null;
  }
  async unique() {
    const docs = this.run({ limit: 2 }).docs;
    if (docs.length > 1) throw new Error(`unique() found more than one document in ${this.t.name}`);
    return docs[0] ?? null;
  }
  async paginate(opts: { numItems: number; cursor: string | null; endCursor?: string | null }) {
    const after = opts.cursor ? decodeCursor(opts.cursor) : undefined;
    if (after === END) return { page: [], isDone: true, continueCursor: END };
    const end = opts.endCursor ? decodeCursor(opts.endCursor) : undefined;
    const { docs, stoppedAt } = this.run({
      limit: end ? undefined : opts.numItems,
      after: after as unknown[] | undefined,
      until: end === END ? undefined : (end as unknown[] | undefined),
    });
    if (end) return { page: docs, isDone: end === END, continueCursor: opts.endCursor! };
    return stoppedAt
      ? { page: docs, isDone: false, continueCursor: encodeCursor(stoppedAt) }
      : { page: docs, isDone: true, continueCursor: END };
  }

  /**
   * Scans the index range in order, applies filters in JS (one semantics for execution and invalidation), stops
   * after `limit` matches, and records the range actually covered: up to the last row examined when it stopped
   * early, the whole range otherwise.
   */
  private run(opts: { limit?: number; after?: unknown[]; until?: unknown[] }): { docs: Doc[]; stoppedAt?: unknown[] } {
    if (this.consumed) throw new Error("A query can only be run once");
    this.consumed = true;
    const filterOk = (d: Doc) => this.filters.every((f) => truthy(evalExpr(f, d)));

    if (this.plugin) {
      const { plugin, name, arg } = this.plugin;
      const spec = this.engine.schema.tables[this.t.name]!.indexes.find((i) => i.name === name)!;
      const env = { sql: this.engine.sql, layout: this.t.layout, decode: (row: Record<string, unknown>) => this.engine.decode(this.t, row) };
      const { docs, readSetData } = plugin.execute!(env, spec, arg);
      this.readSet.push({ kind: "plugin", table: this.t.name, index: name, indexKind: plugin.kind, data: readSetData });
      const out = docs.filter(filterOk);
      return { docs: opts.limit === undefined ? out : out.slice(0, opts.limit) };
    }

    const asc = this.direction === "asc";
    let lower = this.lower;
    let upper = this.upper;
    if (opts.after) asc ? (lower = { key: opts.after, inclusive: false }) : (upper = { key: opts.after, inclusive: false });
    if (opts.until) asc ? (upper = { key: opts.until, inclusive: true }) : (lower = { key: opts.until, inclusive: true });

    const exprs = this.fields.map((f) => this.t.layout.expr(f));
    const params: unknown[] = [];
    const where = [rangeSql(exprs, lower, upper, params)];
    const dir = asc ? "ASC" : "DESC";
    const indexed = this.index === "by_id" ? "" : ` INDEXED BY ${q(`${this.t.name}__${this.index}`)}`;
    const sql = `SELECT * FROM ${q(this.t.name)}${indexed} WHERE ${where.join(" AND ")} ORDER BY ${exprs.map((e) => `${e} ${dir}`).join(", ")}`;

    const docs: Doc[] = [];
    let stoppedAt: unknown[] | undefined;
    if (opts.limit !== 0) {
      for (const row of this.engine.sql.iterate(sql, ...params)) {
        const doc = this.engine.decode(this.t, row);
        if (!filterOk(doc)) continue;
        docs.push(doc);
        if (opts.limit !== undefined && docs.length >= opts.limit) {
          stoppedAt = keyOf(doc, this.fields);
          break;
        }
      }
    } else stoppedAt = asc ? (lower?.key ?? []) : (upper?.key ?? []); // nothing read: an empty range
    // Read set: the covered part of the range.
    let rsLower = lower;
    let rsUpper = upper;
    if (stoppedAt) asc ? (rsUpper = { key: stoppedAt, inclusive: true }) : (rsLower = { key: stoppedAt, inclusive: true });
    this.readSet.push({
      kind: "range", table: this.t.name, index: this.index, fields: this.fields, lower: rsLower, upper: rsUpper,
      ...(this.filters.length ? { filter: this.filters } : {}),
    });
    return { docs, stoppedAt };
  }
}

const normKey = (x: unknown) => keyPart({ x }, "x");

// SQL for a key range with SQLite's ordering (NULL first) made explicit, since `x < ?` is NULL for NULL x.
function cmpSql(e: string, op: ">" | ">=" | "<" | "<=", value: unknown, params: unknown[]): string {
  if (value === null) return op === ">" ? `${e} IS NOT NULL` : op === ">=" ? "1" : op === "<" ? "0" : `${e} IS NULL`;
  params.push(value);
  return op === ">" || op === ">=" ? `${e} ${op} ?` : `(${e} IS NULL OR ${e} ${op} ?)`;
}

function tupleSql(exprs: string[], key: unknown[], op: ">" | ">=" | "<" | "<=", params: unknown[]): string {
  const strict = op === ">=" ? ">" : op === "<=" ? "<" : op;
  const ors: string[] = [];
  for (let i = 0; i < key.length; i++) {
    const conj: string[] = [];
    for (let j = 0; j < i; j++) {
      params.push(key[j]);
      conj.push(`${exprs[j]} IS ?`);
    }
    conj.push(cmpSql(exprs[i]!, i === key.length - 1 ? op : strict, key[i], params));
    ors.push(conj.join(" AND "));
  }
  return ors.length ? `(${ors.join(" OR ")})` : "1";
}

function rangeSql(exprs: string[], lower: Bound | null, upper: Bound | null, params: unknown[]): string {
  // Shared equality prefix as plain `IS ?` terms so SQLite seeks the index on it.
  const parts: string[] = [];
  let p = 0;
  if (lower && upper) {
    while (p < lower.key.length && p < upper.key.length && compareValues(lower.key[p], upper.key[p]) === 0) {
      if (p === lower.key.length - 1 && !lower.inclusive) break;
      if (p === upper.key.length - 1 && !upper.inclusive) break;
      params.push(lower.key[p]);
      parts.push(`${exprs[p]} IS ?`);
      p++;
    }
  }
  const rest = exprs.slice(p);
  if (lower && lower.key.length > p) parts.push(tupleSql(rest, lower.key.slice(p), lower.inclusive ? ">=" : ">", params));
  if (upper && upper.key.length > p) parts.push(tupleSql(rest, upper.key.slice(p), upper.inclusive ? "<=" : "<", params));
  return parts.length ? parts.join(" AND ") : "1";
}

// ------------------------------------------------------------------------------------------ cursors

const END = "_end";
const encodeCursor = (key: unknown[]) => Buffer.from(toJson(key)).toString("base64url");
const decodeCursor = (c: string): unknown[] | typeof END => (c === END ? END : fromJson(Buffer.from(c, "base64url").toString()));

// ------------------------------------------------------------------------------------------ filters

const isExpr = (x: unknown): x is FilterExpr => isPlainObject(x) && ("field" in x || "op" in x || "literal" in x) && (x as any).__expr === true;
const toExpr = (x: unknown): FilterExpr => (isExpr(x) ? stripTag(x) : { literal: x });
const stripTag = (x: any): FilterExpr => {
  const { __expr, ...rest } = x;
  return rest;
};
const node = (e: FilterExpr) => ({ ...e, __expr: true });
const filterBuilder = {
  field: (path: string) => node({ field: path }),
  ...Object.fromEntries(
    (["eq", "neq", "lt", "lte", "gt", "gte", "and", "or", "not"] as const).map((op) => [
      op,
      (...args: unknown[]) => node({ op, args: args.map(toExpr) }),
    ]),
  ),
};

/** Convex value order for filter comparisons: undefined < null < bigint < number < boolean < string < array < object. */
function convexCompare(a: unknown, b: unknown): number {
  const r = (x: unknown) =>
    x === undefined ? 0 : x === null ? 1 : typeof x === "bigint" ? 2 : typeof x === "number" ? 3 : typeof x === "boolean" ? 4 : typeof x === "string" ? 5 : Array.isArray(x) ? 6 : 7;
  const ra = r(a);
  const rb = r(b);
  if (ra !== rb) return ra - rb;
  if (ra === 5) return compareValues(a, b);
  if (ra >= 6) return compareValues(toJson(a), toJson(b));
  return (a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0;
}

export function evalExpr(e: FilterExpr, doc: Record<string, unknown>): unknown {
  if ("field" in e) {
    let cur: unknown = doc;
    for (const p of e.field.split(".")) cur = isPlainObject(cur) ? cur[p] : undefined;
    return cur;
  }
  if ("literal" in e) return e.literal;
  const a = e.args.map((x) => evalExpr(x, doc));
  switch (e.op) {
    case "eq": return convexCompare(a[0], a[1]) === 0;
    case "neq": return convexCompare(a[0], a[1]) !== 0;
    case "lt": return convexCompare(a[0], a[1]) < 0;
    case "lte": return convexCompare(a[0], a[1]) <= 0;
    case "gt": return convexCompare(a[0], a[1]) > 0;
    case "gte": return convexCompare(a[0], a[1]) >= 0;
    case "and": return a.every(truthy);
    case "or": return a.some(truthy);
    case "not": return !truthy(a[0]);
  }
}
const truthy = (x: unknown) => x === true;

// ------------------------------------------------------------------------------------------ overlap

/** Whether `change` may alter a result whose execution recorded `entry`. Must never say no wrongly. */
export function overlaps(entry: ReadSetEntry, change: RowChange): boolean {
  if (entry.table !== change.table) return false;
  if (entry.kind === "table") return true;
  if (entry.kind === "plugin") {
    const plugin = indexKind(entry.indexKind);
    return plugin.overlaps ? plugin.overlaps(entry, change, keyPart) : true;
  }
  const hit = (doc: Doc | undefined) =>
    doc !== undefined &&
    inRange(keyOf(doc, entry.fields), entry.lower, entry.upper) &&
    (entry.filter ?? []).every((f) => truthy(evalExpr(f, doc)));
  // before in range: it may leave (or change inside) the result; after in range: it may enter / change.
  return hit(change.before) || hit(change.after);
}
