// Replica tables (contracts.md "Replicação entre shards"): read-only copies, in a shard, of rows owned by another
// Durable Object (the source: the Auth DO for `auth:*`, later `global:main` for `.replicated()` tables). The source
// keeps an outbox written in the same transaction as its own write and delivers it, in order per target shard, to the
// internal mutation `_ember:replicaApply` (`replicaApplyFunction`). The applier is the only writer of these tables: any
// other write is refused (`ReadOnlyTable`), so user code reads them like any table (`ctx.db.query("auth:member")`,
// indexes, reactivity: applied rows are ordinary `RowChange`s) and never drifts from the source.
//
// Each replica document keeps the source's id in the field `id` (indexed `by_source_id`); `_id` is a local Ember id of
// that shard, stable while the row exists there (updates and resyncs keep it), and `_creationTime` is when the row first
// reached the shard. Exactly-once effect: the shard keeps, per source, the highest outbox `seq` applied
// (`_ember_replicas`); a batch at or below it is skipped, and a batch whose `prev` (the last seq the source delivered to
// this shard) is above it reveals a gap (data lost here, e.g. a restore): the shard asks for a resync.

import { v, type FieldShape, type ObjectShape, type Shape } from "@freecorps/ember-values";
import { EmberError } from "./errors.ts";
import { internalMutationGeneric } from "./functions.ts";
import { manifestHash, type GenericShards, type GenericTables, type SchemaDefinition, type SchemaManifest, type TableManifest } from "./schema.ts";
import type { IndexSpec } from "./types.ts";

/** Field types a replica carries (Better Auth's, with dates as ms since epoch). */
export type ReplicaFieldType = "string" | "number" | "boolean" | "date" | "json" | "string[]" | "number[]" | { enum: string[] };

export interface ReplicaFieldSpec {
  name: string;
  type: ReplicaFieldType;
  optional: boolean;
}

/** A replica table as the source describes it (JSON: the CLI embeds it in the Worker entry). */
export interface ReplicaTableSpec {
  /** Table name in every shard, also what app code queries: `auth:member`. */
  name: string;
  /** Who writes it (`"auth"`): the key of the shard's high-water mark. */
  source: string;
  /** Type of the source id (`id` field). */
  idType: "string" | "number";
  /** Replicated fields (never the source's hidden ones), without `id`. */
  fields: ReplicaFieldSpec[];
  /** Extra db indexes (`by_source_id` on `id` is always there). */
  indexes?: Array<{ name: string; fields: string[] }>;
}

/** The index on the source id every replica table has. */
export const REPLICA_ID_INDEX = "by_source_id";
/** Per-source state of a shard: the highest seq applied, and the resync in progress. */
export const REPLICA_STATE_TABLE = "_ember_replicas";
export const REPLICA_STATE_DDL = `CREATE TABLE IF NOT EXISTS "${REPLICA_STATE_TABLE}" ("source" TEXT PRIMARY KEY, "seq" INTEGER NOT NULL, "at" REAL NOT NULL, "snapshot" TEXT) STRICT`;
/**
 * Source ids a resync has written so far (the end of the resync deletes the rows it did not see). `sid` keeps the id's
 * own type (ANY): a numeric id compares with the replica's numeric column (5 = 5.0), never as text ('5.0' != '5').
 */
export const REPLICA_SEEN_TABLE = "_ember_replicas_seen";
export const REPLICA_SEEN_DDL = `CREATE TABLE IF NOT EXISTS "${REPLICA_SEEN_TABLE}" ("source" TEXT NOT NULL, "tbl" TEXT NOT NULL, "sid" ANY NOT NULL, PRIMARY KEY ("source", "tbl", "sid")) STRICT`;

const TABLE_NAME = /^[a-z][A-Za-z0-9_]*:[A-Za-z][A-Za-z0-9_]*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function shapeOf(t: ReplicaFieldType): Shape {
  if (typeof t === "object") {
    const members = t.enum.map((value): Shape => ({ kind: "literal", value }));
    return members.length === 1 ? members[0]! : members.length ? { kind: "union", members } : { kind: "string" };
  }
  switch (t) {
    case "string":
      return { kind: "string" };
    case "number":
    case "date":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "string[]":
      return { kind: "array", item: { kind: "string" } };
    case "number[]":
      return { kind: "array", item: { kind: "number" } };
    default:
      return { kind: "any" };
  }
}

/** The manifest entry of a replica table (document shape, indexes, `replica`). */
export function replicaTableManifest(spec: ReplicaTableSpec): TableManifest {
  if (!TABLE_NAME.test(spec.name)) throw new Error(`Replica table ${JSON.stringify(spec.name)}: use <source>:<table> ([a-z][A-Za-z0-9_]*:[A-Za-z][A-Za-z0-9_]*)`);
  const fields: Record<string, FieldShape> = { id: { shape: { kind: spec.idType === "number" ? "number" : "string" }, optional: false } };
  for (const f of spec.fields) {
    if (!FIELD_NAME.test(f.name) || f.name === "id") throw new Error(`Replica table ${spec.name}: invalid field name ${JSON.stringify(f.name)}`);
    fields[f.name] = { shape: shapeOf(f.type), optional: f.optional };
  }
  const document: ObjectShape = { kind: "object", fields };
  const indexes: IndexSpec[] = [{ kind: "db", name: REPLICA_ID_INDEX, fields: ["id"] }];
  for (const i of spec.indexes ?? []) {
    if (i.name === REPLICA_ID_INDEX || indexes.some((x) => x.name === i.name)) throw new Error(`Replica table ${spec.name}: duplicate index ${i.name}`);
    for (const f of i.fields) if (!(f in fields)) throw new Error(`Replica table ${spec.name}: index ${i.name} uses unknown field ${f}`);
    indexes.push({ kind: "db", name: i.name, fields: [...i.fields] });
  }
  // The table name is also the id prefix: `auth:member_01J...` (a colon never appears in an app prefix).
  return { idPrefix: spec.name, document, indexes, replica: { source: spec.source } };
}

/**
 * The schema with the replica tables added to its manifest (every shard gets them; only the sources' targets fill
 * them). Without specs, the schema itself (same manifest, same hash).
 */
export function withReplicas<S extends SchemaDefinition<GenericTables, GenericShards>>(schema: S, specs: readonly ReplicaTableSpec[] | undefined): S {
  if (!specs?.length) return schema;
  const base = schema.manifest;
  const tables: Record<string, TableManifest> = { ...base.tables };
  for (const spec of specs) {
    if (tables[spec.name]) throw new Error(`Replica table ${spec.name} is declared twice (or collides with a table)`);
    tables[spec.name] = replicaTableManifest(spec);
  }
  const { hash: _h, version: _v, ...rest } = base;
  const body: Omit<SchemaManifest, "hash" | "version"> = { ...rest, tables };
  const hash = manifestHash(body);
  const manifest: SchemaManifest = Object.freeze({ version: hash, hash, ...body });
  const out = Object.create(Object.getPrototypeOf(schema) as object) as S;
  Object.assign(out, schema, { manifest });
  return out;
}

/** Replica tables of `source` in a manifest. */
export function replicaTablesOf(m: Pick<SchemaManifest, "tables">, source?: string): string[] {
  return Object.entries(m.tables)
    .filter(([, t]) => t.replica && (source === undefined || t.replica.source === source))
    .map(([name]) => name);
}

// ------------------------------------------------------------------------------------------------ apply

/** One change of one row, as the source's outbox holds it. `doc`: the replicated fields (absent = null/undefined). */
export type ReplicaRow = { seq: number; table: string; id: string | number; op: "upsert" | "delete"; doc?: Record<string, unknown> };
/** One row of a resync (the row as the source holds it now). */
export type ReplicaSnapshotRow = { table: string; id: string | number; doc: Record<string, unknown> };

export type ReplicaApplyArgs =
  /** Deltas in seq order. `prev`: the last seq the source delivered to this shard before these (0 = none). */
  | { source: string; prev: number; rows: ReplicaRow[] }
  /**
   * A page of a resync (`id` names it). `first` clears what an interrupted one left; `end` (with `cut`, the source's
   * last seq when it read the rows) deletes the rows no page carried and sets the high-water mark to `cut`.
   */
  | { source: string; snapshot: { id: string; first?: boolean; rows: ReplicaSnapshotRow[]; end?: { cut: number } } };

export type ReplicaApplyResult = { seq: number; applied: number; skipped: number; resync?: true };

/** The internal SQL of the applier (system tables only). */
type RawExec = (sql: string, ...params: Array<string | number | null>) => Array<Record<string, unknown>>;
type ReplicaDb = {
  insert(t: string, d: Record<string, unknown>): string;
  replace(id: string, d: Record<string, unknown>): void;
  delete(id: string): void;
  query(t: string): { withIndex(i: string, f: (q: { eq(f: string, x: unknown): unknown }) => unknown): { first(): { _id: string } | null } };
};

/** The applier functions `replicaApplyFunction` made (registered functions are frozen: no flag on them). */
const APPLIERS = new WeakSet<object>();

/** @internal The engine gives the applier (and only it) a writer that may write replica tables, plus `ctx[REPLICA_SQL]`. */
export const isReplicaApplier = (fn: unknown): boolean => typeof fn === "object" && fn !== null && APPLIERS.has(fn);
/** @internal */
export const REPLICA_SQL = Symbol("ember.replicaSql");

function cleanDoc(m: TableManifest, id: string | number, doc: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { id };
  for (const f of Object.keys(m.document.fields)) {
    if (f === "id") continue;
    const x = doc?.[f];
    if (x !== undefined && x !== null) out[f] = x;
  }
  return out;
}

function applyArgs(ctx: Record<string | symbol, unknown>, args: ReplicaApplyArgs, manifest: SchemaManifest): ReplicaApplyResult {
  const db = ctx.db as ReplicaDb;
  const exec = ctx[REPLICA_SQL] as RawExec;
  const source = args.source;
  if (typeof source !== "string" || !source) throw new EmberError("ValidationError", "replicaApply: source is required");
  exec(REPLICA_STATE_DDL);
  const state = exec(`SELECT "seq", "snapshot" FROM "${REPLICA_STATE_TABLE}" WHERE "source" = ?`, source)[0];
  const hwm = state ? Number(state.seq) : null;
  const tableOf = (name: string): TableManifest => {
    const t = manifest.tables[name];
    if (!t?.replica || t.replica.source !== source) throw new EmberError("ValidationError", `replicaApply: ${name} is not a replica table of ${source}`);
    return t;
  };
  const find = (table: string, id: string | number) => db.query(table).withIndex(REPLICA_ID_INDEX, (q) => q.eq("id", id)).first();
  const upsert = (table: string, id: string | number, doc: Record<string, unknown> | undefined) => {
    const clean = cleanDoc(tableOf(table), id, doc);
    const cur = find(table, id);
    if (cur) db.replace(cur._id, clean);
    else db.insert(table, clean);
  };
  const remove = (table: string, id: string | number) => {
    tableOf(table);
    const cur = find(table, id);
    if (cur) db.delete(cur._id);
  };
  const setState = (seq: number, snapshot: string | null) =>
    exec(
      `INSERT INTO "${REPLICA_STATE_TABLE}" ("source", "seq", "at", "snapshot") VALUES (?, ?, ?, ?) ON CONFLICT ("source") DO UPDATE SET "seq" = excluded."seq", "at" = excluded."at", "snapshot" = excluded."snapshot"`,
      source, seq, ctx.now as number, snapshot,
    );

  if ("snapshot" in args && args.snapshot !== undefined) {
    const s = args.snapshot;
    if (!s || typeof s.id !== "string" || !Array.isArray(s.rows)) throw new EmberError("ValidationError", "replicaApply: snapshot needs { id, rows }");
    exec(REPLICA_SEEN_DDL);
    if (s.first || (state && state.snapshot !== s.id)) exec(`DELETE FROM "${REPLICA_SEEN_TABLE}" WHERE "source" = ?`, source);
    for (const r of s.rows) {
      upsert(r.table, r.id, r.doc);
      exec(`INSERT OR IGNORE INTO "${REPLICA_SEEN_TABLE}" ("source", "tbl", "sid") VALUES (?, ?, ?)`, source, r.table, r.id);
    }
    if (!s.end) {
      // Deltas wait for the end (the source sends nothing else to this shard meanwhile); remember which resync this is.
      setState(hwm ?? 0, s.id);
      return { seq: hwm ?? 0, applied: s.rows.length, skipped: 0 };
    }
    // Rows of this source that no page carried are gone at the source.
    let removed = 0;
    for (const table of replicaTablesOf(manifest, source)) {
      const stale = exec(
        `SELECT "_id" FROM "${table.replaceAll('"', '""')}" WHERE "id" NOT IN (SELECT "sid" FROM "${REPLICA_SEEN_TABLE}" WHERE "source" = ? AND "tbl" = ?)`,
        source, table,
      );
      for (const row of stale) {
        db.delete(String(row._id));
        removed++;
      }
    }
    exec(`DELETE FROM "${REPLICA_SEEN_TABLE}" WHERE "source" = ?`, source);
    const cut = Number(s.end.cut);
    if (!Number.isSafeInteger(cut) || cut < 0) throw new EmberError("ValidationError", "replicaApply: snapshot.end.cut must be a seq");
    setState(cut, null);
    return { seq: cut, applied: s.rows.length + removed, skipped: 0 };
  }

  const { prev, rows } = args as Extract<ReplicaApplyArgs, { rows: ReplicaRow[] }>;
  if (!Array.isArray(rows) || typeof prev !== "number") throw new EmberError("ValidationError", "replicaApply: deltas need { prev, rows }");
  // A gap: the source delivered rows here that this shard no longer has (or never had, then lost its state).
  if ((hwm ?? 0) < prev || (state && state.snapshot !== null)) return { seq: hwm ?? 0, applied: 0, skipped: rows.length, resync: true };
  let seq = hwm ?? 0;
  let applied = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.seq <= seq) {
      skipped++;
      continue;
    }
    if (r.op === "delete") remove(r.table, r.id);
    else if (r.op === "upsert") upsert(r.table, r.id, r.doc);
    else throw new EmberError("ValidationError", `replicaApply: unknown op ${JSON.stringify(r.op)}`);
    seq = r.seq;
    applied++;
  }
  if (applied || !state) setState(seq, null);
  return { seq, applied, skipped };
}

/**
 * `_ember:replicaApply` (the runtime registers it): applies a source's deltas or a page of its resync. Internal: only
 * the Worker's own code (the source's drain, the admin endpoints, `@freecorps/ember-testing`) calls it.
 */
export function replicaApplyFunction(manifest: () => SchemaManifest) {
  const fn = internalMutationGeneric({
    args: { source: v.string(), prev: v.optional(v.number()), rows: v.optional(v.array(v.any())), snapshot: v.optional(v.any()) },
    handler: (ctx, args) => applyArgs(ctx as unknown as Record<string | symbol, unknown>, args as unknown as ReplicaApplyArgs, manifest()),
  });
  APPLIERS.add(fn);
  return fn;
}
