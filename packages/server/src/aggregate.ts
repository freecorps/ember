// Materialized aggregates (PLAN §19): `defineTable(...).aggregate(name, { by, count, sum?, min?, max? })`.
//
// Stored as an index kind ("aggregate") so the migration planner creates, drops and stages them like any index:
//
//   "<table>__<name>"      ("key" BLOB PRIMARY KEY, "count" INTEGER, "v" TEXT)  WITHOUT ROWID
//                          key = encodeKey(group values), v = encodeJson({ sum, min, max })
//   "<table>__<name>__mm"  ("key" BLOB PRIMARY KEY, "n" INTEGER)               WITHOUT ROWID  (only with min/max)
//                          key = encodeKey([field#, ...group values]) ++ encodeKey([value]): a multiset of the
//                          values per (field, group), so removing the current min/max is one index seek
//
// The engine maintains both in the mutation's own transaction (one read + one write per touched group), so reads
// are a single primary-key lookup. Reactivity: every aggregate row that changes is reported as a RowChange of the
// pseudo-table "<table>__<name>" whose docs have `g0..gN` = group values; reads record `db` ranges over index
// "by_group" (fields `g0..gN`) of that pseudo-table.

import {
  compareBytes,
  compareValues,
  concatBytes,
  decodeKey,
  encodeJson,
  decodeJson,
  encodeKey,
  rangeFor,
  shapeAtPath,
  type LowerBound,
  type UpperBound,
  type JSONValue,
  type ObjectShape,
  type Shape,
} from "@ember/values";
import { q, type SqlRow, type SqlValue } from "./driver.ts";
import { EmberError } from "./errors.ts";
import type { IndexKind } from "./indexKinds.ts";
import { fieldOf } from "./layout.ts";
import type { SchemaManifest } from "./schema.ts";
import type { Doc, IndexSpec } from "./types.ts";

export const AGGREGATE_KIND = "aggregate";
export const AGGREGATE_INDEX = "by_group";

export type AggregateOptions = { by: string[]; count?: true; sum?: string[]; min?: string[]; max?: string[] };
export type AggregateConfig = { count: true; sum: string[]; min: string[]; max: string[] };
export type AggregateSpec = IndexSpec & { kind: "aggregate"; config: AggregateConfig };

/** One group's aggregate. `min`/`max` are null while the group has no (non-null) value of that field. */
export type AggregateValue = {
  count: number;
  sum: Record<string, number | bigint>;
  min: Record<string, unknown>;
  max: Record<string, unknown>;
};

export const aggregateTable = (table: string, name: string): string => `${table}__${name}`;

const isNumeric = (s: Shape): boolean =>
  s.kind === "number" || s.kind === "int64" || (s.kind === "union" && s.members.every((m) => m.kind === "null" || isNumeric(m)));
const isInt64 = (s: Shape): boolean => s.kind === "int64" || (s.kind === "union" && s.members.some((m) => m.kind === "int64"));

/** The built-in index kind behind `.aggregate()` (registered by every schema, like search). */
export const aggregateKind: IndexKind<AggregateOptions> = {
  kind: AGGREGATE_KIND,
  method: "aggregateIndex",
  parse(name, cfg, document) {
    if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.by)) throw new Error(`aggregate ${name}: needs { by: [fields] }`);
    if (cfg.by.length > 16) throw new Error(`aggregate ${name}: at most 16 group fields`);
    if (cfg.count !== undefined && cfg.count !== true) throw new Error(`aggregate ${name}: count must be true (it is always kept)`);
    const list = (k: "sum" | "min" | "max"): string[] => {
      const xs = cfg[k] ?? [];
      if (!Array.isArray(xs)) throw new Error(`aggregate ${name}: ${k} must be an array of fields`);
      if (new Set(xs).size !== xs.length) throw new Error(`aggregate ${name}: duplicate field in ${k}`);
      for (const f of xs) {
        const s = f === "_creationTime" ? ({ shape: { kind: "number" }, optional: false } as const) : shapeAtPath(document, f);
        if (!s) throw new Error(`aggregate ${name}: unknown field ${f} in ${k}`);
        if (k === "sum" && !isNumeric(s.shape)) throw new Error(`aggregate ${name}: sum field ${f} must be a number or int64`);
      }
      return [...xs];
    };
    if (new Set(cfg.by).size !== cfg.by.length) throw new Error(`aggregate ${name}: duplicate group field`);
    const config: AggregateConfig = { count: true, sum: list("sum"), min: list("min"), max: list("max") };
    return { kind: AGGREGATE_KIND, name, fields: [...cfg.by], config: config as unknown as JSONValue };
  },
  ddl(layout, spec) {
    const name = aggregateTable(layout.table, spec.name);
    const c = spec.config as unknown as AggregateConfig;
    const objects = [
      { type: "table" as const, name, sql: `CREATE TABLE ${q(name)} ("key" BLOB PRIMARY KEY, "count" INTEGER NOT NULL, "v" TEXT NOT NULL) STRICT, WITHOUT ROWID` },
    ];
    if (c.min.length || c.max.length) {
      objects.push({ type: "table", name: `${name}__mm`, sql: `CREATE TABLE ${q(`${name}__mm`)} ("key" BLOB PRIMARY KEY, "n" INTEGER NOT NULL) STRICT, WITHOUT ROWID` });
    }
    return objects;
  },
  // Aggregate reads never record entries of this kind (they use `db` ranges over the pseudo-table).
  matchesChange: () => true,
};

/** Aggregate specs of a table manifest. */
export const aggregatesOf = (t: { indexes: IndexSpec[] }): AggregateSpec[] =>
  t.indexes.filter((i): i is AggregateSpec => i.kind === AGGREGATE_KIND);

/** The (table, spec) behind an aggregate pseudo-table name, or undefined. */
export function aggregateOfTable(m: SchemaManifest, pseudo: string): { table: string; spec: AggregateSpec } | undefined {
  const i = pseudo.indexOf("__");
  if (i <= 0) return undefined;
  const table = pseudo.slice(0, i);
  const t = m.tables[table];
  const spec = t && aggregatesOf(t).find((a) => a.name === pseudo.slice(i + 2));
  return spec ? { table, spec } : undefined;
}

/** Fields of the `by_group` index of an aggregate pseudo-table (the docs reported in RowChanges carry them). */
export const groupFields = (spec: AggregateSpec): string[] => spec.fields.map((_, i) => `g${i}`);

/** Whether the aggregate's sum of `field` is an int64 (bigint) sum. */
export function sumIsInt64(document: ObjectShape, field: string): boolean {
  const s = shapeAtPath(document, field);
  return !!s && isInt64(s.shape);
}

export const emptyAggregate = (spec: AggregateSpec, int64Sums: ReadonlySet<string> = new Set()): AggregateValue => ({
  count: 0,
  sum: Object.fromEntries(spec.config.sum.map((f) => [f, int64Sums.has(f) ? 0n : 0])),
  min: Object.fromEntries(spec.config.min.map((f) => [f, null])),
  max: Object.fromEntries(spec.config.max.map((f) => [f, null])),
});

/** The pseudo-table doc of a group (what RowChanges carry). */
export function aggregateDoc(spec: AggregateSpec, key: Uint8Array, value: AggregateValue): Doc {
  const group = decodeKey(key);
  const doc: Record<string, unknown> = { _id: `agg_${hex(key)}`, _creationTime: 0 };
  spec.fields.forEach((_, i) => (doc[`g${i}`] = group[i]));
  doc.count = value.count;
  doc.sum = value.sum;
  doc.min = value.min;
  doc.max = value.max;
  return doc as Doc;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const asBytes = (x: unknown): Uint8Array => (x instanceof Uint8Array ? x : new Uint8Array(x as ArrayBuffer));

type Exec = (sql: string, ...params: SqlValue[]) => SqlRow[];

/**
 * Applies document changes to a table's aggregates. `onChange(spec, key, before, after)` is called with the
 * group's value before and after each step (null = the group row does not exist).
 */
export class AggregateMaintainer {
  constructor(
    private readonly exec: Exec,
    private readonly table: string,
    private readonly document: ObjectShape,
    private readonly onChange?: (spec: AggregateSpec, key: Uint8Array, before: AggregateValue | null, after: AggregateValue | null) => void,
  ) {}

  private int64Sums = new Map<string, Set<string>>();
  private int64Of(spec: AggregateSpec): Set<string> {
    let s = this.int64Sums.get(spec.name);
    if (!s) this.int64Sums.set(spec.name, (s = new Set(spec.config.sum.filter((f) => sumIsInt64(this.document, f)))));
    return s;
  }

  /** Moves one document's contribution from `before` to `after` in `spec`. */
  apply(spec: AggregateSpec, before: Doc | null, after: Doc | null): void {
    const kb = before && encodeKey(spec.fields.map((f) => fieldOf(before, f)));
    const ka = after && encodeKey(spec.fields.map((f) => fieldOf(after, f)));
    if (kb && ka && compareBytes(kb, ka) === 0 && sameContribution(spec, before!, after!)) return;
    if (kb) this.add(spec, kb, before!, -1);
    if (ka) this.add(spec, ka, after!, 1);
  }

  read(spec: AggregateSpec, key: Uint8Array): AggregateValue | null {
    const row = this.exec(`SELECT "count", "v" FROM ${q(aggregateTable(this.table, spec.name))} WHERE "key" = ?`, key)[0];
    return row ? decodeRow(row) : null;
  }

  private add(spec: AggregateSpec, key: Uint8Array, doc: Doc, sign: 1 | -1): void {
    const name = aggregateTable(this.table, spec.name);
    const cur = this.read(spec, key);
    const next: AggregateValue = cur ? structuredCloneValue(cur) : emptyAggregate(spec, this.int64Of(spec));
    next.count += sign;
    for (const f of spec.config.sum) {
      const x = fieldOf(doc, f);
      const s = next.sum[f] ?? 0;
      if (typeof x === "bigint") next.sum[f] = typeof s === "bigint" ? s + BigInt(sign) * x : Number(s) + sign * Number(x);
      else if (typeof x === "number") next.sum[f] = typeof s === "bigint" && Number.isInteger(x) ? s + BigInt(sign * x) : Number(s) + sign * x;
    }
    const mm = mmFields(spec);
    mm.forEach((f, fi) => {
      const x = fieldOf(doc, f);
      if (x === undefined || x === null) return;
      const prefix = encodeKey([fi, ...decodeKey(key)]);
      const k = concatBytes(prefix, encodeKey([x]));
      const mmTable = q(`${name}__mm`);
      if (sign > 0) {
        this.exec(`INSERT INTO ${mmTable} ("key", "n") VALUES (?, 1) ON CONFLICT ("key") DO UPDATE SET "n" = "n" + 1`, k);
        if (f in next.min && (next.min[f] === null || compareValues(x, next.min[f]) < 0)) next.min[f] = x;
        if (f in next.max && (next.max[f] === null || compareValues(x, next.max[f]) > 0)) next.max[f] = x;
      } else {
        const left = this.exec(`UPDATE ${mmTable} SET "n" = "n" - 1 WHERE "key" = ? RETURNING "n"`, k)[0];
        if (left && Number(left.n) <= 0) this.exec(`DELETE FROM ${mmTable} WHERE "key" = ?`, k);
        const seek = (dir: "ASC" | "DESC"): unknown => {
          const r = this.exec(`SELECT "key" FROM ${mmTable} WHERE "key" > ? AND "key" < ? ORDER BY "key" ${dir} LIMIT 1`, prefix, concatBytes(prefix, Uint8Array.of(0xff)))[0];
          if (!r) return null;
          const parts = decodeKey(asBytes(r.key));
          return parts[parts.length - 1];
        };
        if (f in next.min && next.min[f] !== null && compareValues(x, next.min[f]) === 0) next.min[f] = seek("ASC");
        if (f in next.max && next.max[f] !== null && compareValues(x, next.max[f]) === 0) next.max[f] = seek("DESC");
      }
    });
    if (next.count <= 0) {
      this.exec(`DELETE FROM ${q(name)} WHERE "key" = ?`, key);
      this.onChange?.(spec, key, cur, null);
    } else {
      this.exec(
        `INSERT INTO ${q(name)} ("key", "count", "v") VALUES (?, ?, ?) ON CONFLICT ("key") DO UPDATE SET "count" = excluded."count", "v" = excluded."v"`,
        key,
        next.count,
        encodeJson({ sum: next.sum, min: next.min, max: next.max }),
      );
      this.onChange?.(spec, key, cur, next);
    }
  }
}

/** Fields with a min/max multiset (index = field number in the mm key). */
const mmFields = (spec: AggregateSpec): string[] => [...new Set([...spec.config.min, ...spec.config.max])];

function sameContribution(spec: AggregateSpec, a: Doc, b: Doc): boolean {
  for (const f of [...spec.config.sum, ...mmFields(spec)]) {
    const x = fieldOf(a, f);
    const y = fieldOf(b, f);
    if (x === y) continue;
    if (x === undefined || y === undefined || compareValues(x, y) !== 0) return false;
  }
  return true;
}

const structuredCloneValue = (v: AggregateValue): AggregateValue => ({ count: v.count, sum: { ...v.sum }, min: { ...v.min }, max: { ...v.max } });

export function decodeRow(row: SqlRow): AggregateValue {
  const v = decodeJson(String(row.v)) as Omit<AggregateValue, "count">;
  return { count: Number(row.count), sum: v.sum ?? {}, min: v.min ?? {}, max: v.max ?? {} };
}

/** Rejects a group tuple of the wrong arity. */
export function checkGroup(spec: AggregateSpec, table: string, group: unknown): unknown[] {
  if (!Array.isArray(group) || group.length !== spec.fields.length) {
    throw new EmberError("QueryError", `aggregate ${table}.${spec.name}: get() needs [${spec.fields.join(", ")}] (${spec.fields.length} values)`);
  }
  return group;
}

// ------------------------------------------------------------------------------------------------ reads

export type AggregateRangeOptions = { order?: "asc" | "desc"; limit?: number };
export type AggregateRow = AggregateValue & { group: unknown[] };

export interface AggregateReadEnv {
  exec: Exec;
  /** Where reads are recorded (queries); null in mutations. */
  readSet: import("./types.ts").ReadSet | null;
  table: string;
  spec: AggregateSpec;
  document: ObjectShape;
}

type RangeOp = { op: "eq" | "gt" | "gte" | "lt" | "lte"; field: string; value: unknown };

/** `ctx.db.aggregate(table, name)`. */
export function aggregateReader(env: AggregateReadEnv) {
  const { exec, readSet, table, spec } = env;
  const pseudo = aggregateTable(table, spec.name);
  const int64 = new Set(spec.config.sum.filter((f) => sumIsInt64(env.document, f)));
  const record = (lo: Uint8Array, hi: Uint8Array) => readSet?.push({ table: pseudo, index: AGGREGATE_INDEX, lo, hi, kind: "db" });
  return {
    get(group: unknown[]): AggregateValue {
      const key = encodeKey(checkGroup(spec, table, group));
      record(key, concatBytes(key, Uint8Array.of(0)));
      const row = exec(`SELECT "count", "v" FROM ${q(pseudo)} WHERE "key" = ?`, key)[0];
      return row ? decodeRow(row) : emptyAggregate(spec, int64);
    },
    range(build?: (q: any) => unknown, opts: AggregateRangeOptions = {}): AggregateRow[] {
      const ops: RangeOp[] = [];
      const b: any = {};
      for (const op of ["eq", "gt", "gte", "lt", "lte"] as const) {
        b[op] = (field: string, value: unknown) => {
          ops.push({ op, field, value });
          return b;
        };
      }
      build?.(b);
      const eqs: unknown[] = [];
      let lower: LowerBound | undefined;
      let upper: UpperBound | undefined;
      let i = 0;
      for (const o of ops) {
        const expected = spec.fields[i];
        if (o.field !== expected) throw new EmberError("QueryError", `aggregate ${table}.${spec.name}: ${o.op}(${o.field}) must be on ${expected ?? "(no more fields)"}`);
        if (o.op === "eq") {
          if (lower || upper) throw new EmberError("QueryError", `aggregate ${table}.${spec.name}: eq() after a range bound`);
          eqs.push(o.value);
          i++;
        } else if (o.op === "gt" || o.op === "gte") {
          if (lower || upper) throw new EmberError("QueryError", `aggregate ${table}.${spec.name}: only one lower bound, before the upper bound`);
          lower = { op: o.op, value: o.value };
        } else {
          if (upper) throw new EmberError("QueryError", `aggregate ${table}.${spec.name}: only one upper bound`);
          upper = { op: o.op, value: o.value };
        }
      }
      const limit = opts.limit ?? Infinity;
      if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0)) throw new EmberError("QueryError", "range(): limit must be a non-negative integer");
      const asc = (opts.order ?? "asc") === "asc";
      const { lo, hi } = rangeFor(eqs, lower, upper);
      const rows =
        limit === 0
          ? []
          : exec(
              `SELECT "key", "count", "v" FROM ${q(pseudo)} WHERE "key" >= ? AND "key" < ? ORDER BY "key" ${asc ? "ASC" : "DESC"}${limit === Infinity ? "" : " LIMIT ?"}`,
              ...(limit === Infinity ? [lo, hi] : [lo, hi, limit]),
            );
      // Stopped at the limit: only up to the last group read is covered (like take(n)).
      let rlo = lo;
      let rhi = hi;
      if (limit === 0) asc ? (rhi = lo) : (rlo = hi);
      else if (rows.length === limit) {
        const last = asBytes(rows[rows.length - 1]!.key);
        asc ? (rhi = concatBytes(last, Uint8Array.of(0))) : (rlo = last);
      }
      record(rlo, rhi);
      return rows.map((r) => ({ group: decodeKey(asBytes(r.key)), ...decodeRow(r) }));
    },
  };
}
