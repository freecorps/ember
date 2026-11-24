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
} from "@freecorps/ember-values";
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

/** What maintaining one aggregate needs, worked out once per spec (not per document change). */
type Plan = {
  name: string;
  mmTable: string;
  /** Fields with a min/max multiset (index = field number in the mm key) and their `encodeKey([fi])`. */
  mm: string[];
  mmPrefix: Uint8Array[];
  /** Sum fields then min/max fields: the fields whose values a document contributes. */
  contribution: string[];
  countOnly: boolean;
  int64Sums: ReadonlySet<string>;
};

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

  private plans = new Map<AggregateSpec, Plan>();
  private plan(spec: AggregateSpec): Plan {
    let p = this.plans.get(spec);
    if (!p) {
      const name = aggregateTable(this.table, spec.name);
      const mm = mmFields(spec);
      p = {
        name,
        mmTable: q(`${name}__mm`),
        mm,
        mmPrefix: mm.map((_, fi) => encodeKey([fi])),
        contribution: [...spec.config.sum, ...mm],
        countOnly: !spec.config.sum.length && !mm.length,
        int64Sums: new Set(spec.config.sum.filter((f) => sumIsInt64(this.document, f))),
      };
      this.plans.set(spec, p);
    }
    return p;
  }

  /** Moves one document's contribution from `before` to `after` in `spec`. */
  apply(spec: AggregateSpec, before: Doc | null, after: Doc | null): void {
    const plan = this.plan(spec);
    // A patch that leaves the group (same primitives: same key bytes) and the contributed values alone: nothing to
    // encode, read or write. Non-primitive group values go through the key comparison below.
    if (before && after && spec.fields.every((f) => Object.is(fieldOf(before, f), fieldOf(after, f))) && sameContribution(plan, before, after)) return;
    const kb = before && encodeKey(spec.fields.map((f) => fieldOf(before, f)));
    const ka = after && encodeKey(spec.fields.map((f) => fieldOf(after, f)));
    if (kb && ka && compareBytes(kb, ka) === 0) {
      if (sameContribution(plan, before!, after!)) return;
      // Same group, other values: one read, the deltas, one write (not a remove and an add of the whole document).
      if (this.move(spec, plan, kb, before!, after!)) return;
    }
    if (kb) this.add(spec, plan, kb, before!, -1);
    if (ka) this.add(spec, plan, ka, after!, 1);
  }

  /**
   * Adds `docs` (none of them counted yet) to `spec`, as `apply(spec, null, doc)` for each in order would, but with
   * one read and one write per group touched (and one write per distinct min/max value) instead of per document:
   * the backfill of a staged aggregate. Sums are added in document order, so the result is the same to the bit.
   */
  addAll(spec: AggregateSpec, docs: readonly Doc[]): void {
    if (!docs.length) return;
    const plan = this.plan(spec);
    const groups = new Map<string, { key: Uint8Array; docs: Doc[] }>();
    for (const doc of docs) {
      const key = encodeKey(spec.fields.map((f) => fieldOf(doc, f)));
      const id = latin1(key);
      const g = groups.get(id);
      if (g) g.docs.push(doc);
      else groups.set(id, { key, docs: [doc] });
    }
    const { name } = plan;
    for (const g of groups.values()) {
      const n = g.docs.length;
      if (plan.countOnly) {
        const row = this.exec(
          `INSERT INTO ${q(name)} ("key", "count", "v") VALUES (?, ?, ?) ON CONFLICT ("key") DO UPDATE SET "count" = "count" + excluded."count" RETURNING "count", "v"`,
          g.key,
          n,
          EMPTY_V,
        )[0]!;
        const after = decodeRow(row);
        this.onChange?.(spec, g.key, after.count > n ? { ...after, count: after.count - n } : null, after);
        continue;
      }
      const cur = this.read(spec, g.key);
      const next: AggregateValue = cur ? structuredCloneValue(cur) : emptyAggregate(spec, plan.int64Sums);
      next.count += n;
      // Multiset entries per distinct (field, value) of the group, counted, then one upsert each.
      const mm = new Map<string, { k: Uint8Array; n: number }>();
      for (const doc of g.docs) {
        addSums(spec.config.sum, next, doc, 1);
        plan.mm.forEach((f, fi) => {
          const x = fieldOf(doc, f);
          if (x === undefined || x === null) return;
          const k = concatBytes(concatBytes(plan.mmPrefix[fi]!, g.key), encodeKey([x]));
          const id = latin1(k);
          const e = mm.get(id);
          if (e) e.n++;
          else mm.set(id, { k, n: 1 });
          if (f in next.min && (next.min[f] === null || compareValues(x, next.min[f]) < 0)) next.min[f] = x;
          if (f in next.max && (next.max[f] === null || compareValues(x, next.max[f]) > 0)) next.max[f] = x;
        });
      }
      for (const e of mm.values()) {
        this.exec(`INSERT INTO ${plan.mmTable} ("key", "n") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "n" = "n" + excluded."n"`, e.k, e.n);
      }
      this.write(spec, name, g.key, cur, next);
    }
  }

  read(spec: AggregateSpec, key: Uint8Array): AggregateValue | null {
    const row = this.exec(`SELECT "count", "v" FROM ${q(aggregateTable(this.table, spec.name))} WHERE "key" = ?`, key)[0];
    return row ? decodeRow(row) : null;
  }

  /**
   * `before` -> `after` within the group `key` (count unchanged). False when the group row is missing, or holds
   * only this document while one of its sums changes.
   */
  private move(spec: AggregateSpec, plan: Plan, key: Uint8Array, before: Doc, after: Doc): boolean {
    // What changed, before any SQL: unchanged fields cost neither a delta nor a multiset step.
    const sums = spec.config.sum.filter((f) => !sameValue(fieldOf(before, f), fieldOf(after, f)));
    const mm: number[] = [];
    plan.mm.forEach((f, fi) => {
      if (!sameValue(fieldOf(before, f), fieldOf(after, f))) mm.push(fi);
    });
    const cur = this.read(spec, key);
    // The group's only document, with a sum changing: rebuilt from empty (a delta would keep a number sum where the
    // new value is an int64, for a `number | int64` field).
    if (!cur || (cur.count === 1 && sums.length)) return false;
    const next = structuredCloneValue(cur);
    addSums(sums, next, before, -1);
    addSums(sums, next, after, 1);
    for (const fi of mm) {
      const f = plan.mm[fi]!;
      this.mmStep(plan, key, next, f, fi, fieldOf(before, f), -1);
      this.mmStep(plan, key, next, f, fi, fieldOf(after, f), 1);
    }
    this.write(spec, plan.name, key, cur, next);
    return true;
  }

  private add(spec: AggregateSpec, plan: Plan, key: Uint8Array, doc: Doc, sign: 1 | -1): void {
    const { name } = plan;
    if (plan.countOnly) {
      // A count-only aggregate: one statement that says what the group was (no read first).
      if (sign > 0) {
        const row = this.exec(
          `INSERT INTO ${q(name)} ("key", "count", "v") VALUES (?, 1, ?) ON CONFLICT ("key") DO UPDATE SET "count" = "count" + 1 RETURNING "count", "v"`,
          key,
          EMPTY_V,
        )[0]!;
        const after = decodeRow(row);
        this.onChange?.(spec, key, after.count > 1 ? { ...after, count: after.count - 1 } : null, after);
        return;
      }
      // Out of a group with others left: one UPDATE. The group's last document: the UPDATE matches nothing (no
      // write), the row is deleted. Either way one written row, as the read + write it replaces.
      const left = this.exec(`UPDATE ${q(name)} SET "count" = "count" - 1 WHERE "key" = ? AND "count" > 1 RETURNING "count", "v"`, key)[0];
      if (left) {
        const after = decodeRow(left);
        this.onChange?.(spec, key, { ...after, count: after.count + 1 }, after);
        return;
      }
      const gone = this.exec(`DELETE FROM ${q(name)} WHERE "key" = ? RETURNING "count", "v"`, key)[0];
      this.onChange?.(spec, key, gone ? decodeRow(gone) : null, null);
      return;
    }
    const cur = this.read(spec, key);
    const next: AggregateValue = cur ? structuredCloneValue(cur) : emptyAggregate(spec, plan.int64Sums);
    next.count += sign;
    addSums(spec.config.sum, next, doc, sign);
    plan.mm.forEach((f, fi) => this.mmStep(plan, key, next, f, fi, fieldOf(doc, f), sign));
    this.write(spec, name, key, cur, next);
  }

  /** One value in or out of a field's min/max multiset, and `next`'s min/max after it. */
  private mmStep(plan: Plan, key: Uint8Array, next: AggregateValue, f: string, fi: number, x: unknown, sign: 1 | -1): void {
    if (x === undefined || x === null) return;
    // encodeKey of a tuple is its elements' encodings back to back: [fi, ...group] is encodeKey([fi]) ++ key.
    const prefix = concatBytes(plan.mmPrefix[fi]!, key);
    const k = concatBytes(prefix, encodeKey([x]));
    const { mmTable } = plan;
    if (sign > 0) {
      this.exec(`INSERT INTO ${mmTable} ("key", "n") VALUES (?, 1) ON CONFLICT ("key") DO UPDATE SET "n" = "n" + 1`, k);
      if (f in next.min && (next.min[f] === null || compareValues(x, next.min[f]) < 0)) next.min[f] = x;
      if (f in next.max && (next.max[f] === null || compareValues(x, next.max[f]) > 0)) next.max[f] = x;
      return;
    }
    const left = this.exec(`UPDATE ${mmTable} SET "n" = "n" - 1 WHERE "key" = ? RETURNING "n"`, k)[0];
    // Other copies of `x` are left: min/max stay as they are (no seek).
    if (left && Number(left.n) > 0) return;
    if (left) this.exec(`DELETE FROM ${mmTable} WHERE "key" = ?`, k);
    const seek = (dir: "ASC" | "DESC"): unknown => {
      const r = this.exec(`SELECT "key" FROM ${mmTable} WHERE "key" > ? AND "key" < ? ORDER BY "key" ${dir} LIMIT 1`, prefix, concatBytes(prefix, Uint8Array.of(0xff)))[0];
      if (!r) return null;
      const parts = decodeKey(asBytes(r.key));
      return parts[parts.length - 1];
    };
    if (f in next.min && next.min[f] !== null && compareValues(x, next.min[f]) === 0) next.min[f] = seek("ASC");
    if (f in next.max && next.max[f] !== null && compareValues(x, next.max[f]) === 0) next.max[f] = seek("DESC");
  }

  private write(spec: AggregateSpec, name: string, key: Uint8Array, cur: AggregateValue | null, next: AggregateValue): void {
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

/** `v` of a count-only group (no sum, min or max). */
const EMPTY_V = encodeJson({ sum: {}, min: {}, max: {} });

/** A document's sums of `fields` in or out of `next` (in place). */
function addSums(fields: readonly string[], next: AggregateValue, doc: Doc, sign: 1 | -1): void {
  for (const f of fields) {
    const x = fieldOf(doc, f);
    const s = next.sum[f] ?? 0;
    if (typeof x === "bigint") next.sum[f] = typeof s === "bigint" ? s + BigInt(sign) * x : Number(s) + sign * Number(x);
    else if (typeof x === "number") next.sum[f] = typeof s === "bigint" && Number.isInteger(x) ? s + BigInt(sign * x) : Number(s) + sign * x;
  }
}

/** Fields with a min/max multiset (index = field number in the mm key). */
const mmFields = (spec: AggregateSpec): string[] => [...new Set([...spec.config.min, ...spec.config.max])];

/** Equal as an aggregate sees them (an absent value equals only another absent one). */
const sameValue = (x: unknown, y: unknown): boolean => x === y || (x !== undefined && y !== undefined && compareValues(x, y) === 0);

function sameContribution(plan: Plan, a: Doc, b: Doc): boolean {
  for (const f of plan.contribution) if (!sameValue(fieldOf(a, f), fieldOf(b, f))) return false;
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

/** Bytes as a string (one char per byte): a Map key for an encoded group or multiset key. */
const latin1 = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, i + 4096));
  return s;
};
