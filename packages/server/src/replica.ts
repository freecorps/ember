// Replica tables (contracts.md "Replicação entre shards"): read-only copies, in a shard, of rows owned by another
// Durable Object (the source: the Auth DO for `auth:*`, later `global:main` for `.replicated()` tables). The source
// keeps an outbox written in the same transaction as its own write and delivers it, in order per target shard, to the
// internal mutation `_ember:replicaApply` (`replicaApplyFunction`). The applier is the only writer of these tables: any
// other write is refused (`ReadOnlyTable`), so user code reads them like any table (`ctx.db.query("auth:member")`,
// indexes, reactivity: applied rows are ordinary `RowChange`s) and never drifts from the source.
//
// Each replica document keeps the source's id in the field `id` (indexed `by_source_id`); `_id` is a local Ember id of
// that shard, stable while the row exists there (updates and resyncs keep it), and `_creationTime` is when the row first
// reached the shard. `.replicated()` tables (PLAN §22 L5) are the other kind: an app table whose source is `global:main`,
// copied with the same `_id` and `_creationTime` (the applier inserts them as they are; these tables use classic
// storage, whose `_id` index takes any id), so `v.id("fxRates")` stored in a tenant row resolves in every shard. Exactly-once effect: the shard keeps, per source, the highest outbox `seq` applied
// (`_ember_replicas`); a batch at or below it is skipped, and a batch whose `prev` (the last seq the source delivered to
// this shard) is above it reveals a gap (data lost here, e.g. a restore): the shard asks for a resync.

import { toJSONValue, v, type FieldShape, type ObjectShape, type Shape } from "@freecorps/ember-values";
import { EmberError } from "./errors.ts";
import { internalMutationGeneric } from "./functions.ts";
import { decodeRow, keyColumn, layoutOf } from "./layout.ts";
import { canonicalJson, manifestHash, type GenericShards, type GenericTables, type SchemaDefinition, type SchemaManifest, type TableManifest } from "./schema.ts";
import { sha256Hex } from "./sha256.ts";
import { isCompactSql } from "./storage.ts";
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

/** Replica tables of `source` in a manifest (and, for `global:main`, its `.replicated()` tables). */
export function replicaTablesOf(m: Pick<SchemaManifest, "tables">, source?: string): string[] {
  return Object.entries(m.tables)
    .filter(([, t]) => (t.replica && (source === undefined || t.replica.source === source)) || (t.replicated && source === REPLICATED_SOURCE))
    .map(([name]) => name);
}

// ------------------------------------------------------------------------------------------------ .replicated()

/** The shard that owns (and alone writes) every `.replicated()` table; also its source name in `_ember_replicas`. */
export const REPLICATED_SOURCE = "global:main";

/** The kind of a shard name (`org:acme` → `org`). */
export const shardKindOf = (shard: string): string => {
  const i = shard.indexOf(":");
  return i < 0 ? shard : shard.slice(0, i);
};

/** Whether shards of `kind` receive table `t` (`.replicated({ to })`; the source's own kind never does). */
export function receivesReplicated(t: Pick<TableManifest, "replicated">, kind: string): boolean {
  return !!t.replicated && kind !== "global" && (!t.replicated.to || t.replicated.to.includes(kind));
}

/** `.replicated()` tables of a manifest; with `kind`, only those shards of that kind receive. */
export function replicatedTablesOf(m: Pick<SchemaManifest, "tables">, kind?: string): string[] {
  return Object.entries(m.tables)
    .filter(([, t]) => t.replicated && (kind === undefined || receivesReplicated(t, kind)))
    .map(([name]) => name);
}

/** Shard kinds that receive at least one `.replicated()` table (`"*"`: some table goes to every kind). */
export function replicatedKinds(m: Pick<SchemaManifest, "tables" | "shards">): Set<string> {
  const out = new Set<string>();
  for (const t of Object.values(m.tables)) {
    if (!t.replicated) continue;
    for (const k of t.replicated.to ?? ["*"]) out.add(k);
  }
  return out;
}

/** Whether shards of `kind` receive any `.replicated()` table. */
export function kindReceivesReplicated(m: Pick<SchemaManifest, "tables">, kind: string): boolean {
  return kind !== "global" && Object.values(m.tables).some((t) => receivesReplicated(t, kind));
}

/**
 * Hash of the `.replicated()` tables (shape, indexes, targets). When it changes (a deploy), the source resyncs every
 * target: a replica rebuilt by its migration must not wait for the next write to be filled again.
 */
export function replicatedVersion(m: Pick<SchemaManifest, "tables">): string {
  const tables = Object.fromEntries(Object.entries(m.tables).filter(([, t]) => t.replicated));
  return sha256Hex(canonicalJson(toJSONValue(tables)));
}

/** Every row of the `.replicated()` tables shards of `kind` receive, as a resync sends them (oldest first). */
export function replicatedSnapshot(exec: (sql: string, ...params: Array<string | number | null>) => Array<Record<string, unknown>>, m: Pick<SchemaManifest, "tables">, kind: string): ReplicaSnapshotRow[] {
  const out: ReplicaSnapshotRow[] = [];
  for (const table of replicatedTablesOf(m, kind)) {
    const layout = layoutOf(table, m.tables[table]!.document);
    const ddl = exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table)[0]?.sql;
    if (typeof ddl !== "string") continue;
    // Creation order from an index, not a sort: compact storage's rowid is the creation time (µs); a classic table
    // walks its by_creation_time key ([_creationTime, _id]). Data columns only (no `_k_*` index BLOBs).
    const order = isCompactSql(ddl) ? `"_rowid"` : `"${keyColumn("by_creation_time")}", "_rowid"`;
    const cols = layout.dataColumns.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ");
    for (const row of exec(`SELECT ${cols} FROM "${table.replaceAll('"', '""')}" ORDER BY ${order}`)) {
      const doc = decodeRow(layout, row as never) as Record<string, unknown>;
      out.push({ table, id: String(doc._id), doc });
    }
  }
  return out;
}

/** How far a shard's copy of a replicated (or replica) table is (`ctx.db.replicaStatus(table)`). */
export type ReplicaStatus = {
  /**
   * `source`: this shard writes the table (`global:main`); `off`: shards of this kind do not receive it
   * (`.replicated({ to })`); `pending`: nothing arrived yet (a new shard waiting for its first copy: reads see an empty
   * table); `syncing`: a full copy is arriving (reads may see part of it); `ready`: deltas apply as they come.
   */
  state: "source" | "off" | "pending" | "syncing" | "ready";
  /** The source's last change applied here (its outbox seq; 0 before any). */
  seq: number;
  /** When this shard last applied something from the source (ms), null before that. */
  updatedAt: number | null;
};

/** @internal Reads `_ember_replicas` for `source` (no row: pending). */
export function readReplicaStatus(exec: (sql: string, ...params: Array<string | number | null>) => Array<Record<string, unknown>>, source: string): ReplicaStatus {
  const r = missingTableIsEmpty(() => exec(`SELECT "seq", "at", "snapshot" FROM "${REPLICA_STATE_TABLE}" WHERE "source" = ?`, source))?.[0];
  if (!r) return { state: "pending", seq: 0, updatedAt: null };
  return { state: r.snapshot !== null && r.snapshot !== undefined ? "syncing" : "ready", seq: Number(r.seq), updatedAt: Number(r.at) };
}

/**
 * `read()`, or null when the table it reads does not exist (yet): one statement instead of a sqlite_master probe or
 * a `CREATE TABLE IF NOT EXISTS` first. SQLite fails such a statement when preparing it, which leaves the enclosing
 * transaction as it was.
 */
function missingTableIsEmpty<R>(read: () => R[]): R[] | null {
  try {
    return read();
  } catch (e) {
    if (/no such table/i.test(String((e as Error | null)?.message ?? e))) return null;
    throw e;
  }
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
  get(id: string): Record<string, unknown> | null;
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
/** @internal The applier's insert that keeps the source's `_id` and `_creationTime` (`.replicated()` tables). */
export const REPLICA_INSERT = Symbol("ember.replicaInsert");

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
  // The state table exists from the first apply on (or the first rebuild that resets a source): created only then.
  const stateRows = missingTableIsEmpty(() => exec(`SELECT "seq", "snapshot" FROM "${REPLICA_STATE_TABLE}" WHERE "source" = ?`, source));
  let stateTable = stateRows !== null;
  const state = stateRows?.[0];
  const hwm = state ? Number(state.seq) : null;
  const tableOf = (name: string): TableManifest => {
    const t = manifest.tables[name];
    const ok = t && ((t.replica && t.replica.source === source) || (t.replicated && source === REPLICATED_SOURCE));
    if (!ok) throw new EmberError("ValidationError", `replicaApply: ${name} is not a replica table of ${source}`);
    return t;
  };
  const insertAs = (ctx.db as Record<symbol, unknown>)[REPLICA_INSERT] as (table: string, id: string, creationTime: number, doc: Record<string, unknown>) => void;
  const find = (table: string, id: string | number) => db.query(table).withIndex(REPLICA_ID_INDEX, (q) => q.eq("id", id)).first();
  const upsert = (table: string, id: string | number, doc: Record<string, unknown> | undefined) => {
    const t = tableOf(table);
    if (t.replicated) {
      // Same `_id` and `_creationTime` as in the source: tenant rows may hold the id (`v.id(table)`).
      const { _id: _i, _creationTime, ...fields } = doc ?? {};
      const sid = String(id);
      if (db.get(sid)) db.replace(sid, fields);
      else insertAs(table, sid, typeof _creationTime === "number" ? _creationTime : (ctx.now as number), fields);
      return;
    }
    const clean = cleanDoc(t, id, doc);
    const cur = find(table, id);
    if (cur) db.replace(cur._id, clean);
    else db.insert(table, clean);
  };
  const remove = (table: string, id: string | number) => {
    if (tableOf(table).replicated) {
      if (db.get(String(id))) db.delete(String(id));
      return;
    }
    const cur = find(table, id);
    if (cur) db.delete(cur._id);
  };
  const setState = (seq: number, snapshot: string | null) => {
    if (!stateTable) {
      exec(REPLICA_STATE_DDL);
      stateTable = true;
    }
    exec(
      `INSERT INTO "${REPLICA_STATE_TABLE}" ("source", "seq", "at", "snapshot") VALUES (?, ?, ?, ?) ON CONFLICT ("source") DO UPDATE SET "seq" = excluded."seq", "at" = excluded."at", "snapshot" = excluded."snapshot"`,
      source, seq, ctx.now as number, snapshot,
    );
  };

  if ("snapshot" in args && args.snapshot !== undefined) {
    const s = args.snapshot;
    if (!s || typeof s.id !== "string" || !Array.isArray(s.rows)) throw new EmberError("ValidationError", "replicaApply: snapshot needs { id, rows }");
    // The whole resync in one page (`first` and `end`: a source with at most a page of rows): the page itself says
    // which rows the source has, so nothing is kept in `_ember_replicas_seen` between pages. A multi-page resync
    // records every id it writes, and its end deletes the rows no page carried.
    const single = !!s.first && !!s.end;
    if (!single) {
      exec(REPLICA_SEEN_DDL);
      if (s.first || (state && state.snapshot !== s.id)) exec(`DELETE FROM "${REPLICA_SEEN_TABLE}" WHERE "source" = ?`, source);
    } else if (state && state.snapshot !== null && state.snapshot !== undefined) {
      // An earlier resync was interrupted mid-way: its ids are dropped as a new first page would.
      missingTableIsEmpty(() => exec(`DELETE FROM "${REPLICA_SEEN_TABLE}" WHERE "source" = ?`, source));
    }
    for (const r of s.rows) {
      upsert(r.table, r.id, r.doc);
      if (!single) exec(`INSERT OR IGNORE INTO "${REPLICA_SEEN_TABLE}" ("source", "tbl", "sid") VALUES (?, ?, ?)`, source, r.table, r.id);
    }
    if (!s.end) {
      // Deltas wait for the end (the source sends nothing else to this shard meanwhile); remember which resync this is.
      setState(hwm ?? 0, s.id);
      return { seq: hwm ?? 0, applied: s.rows.length, skipped: 0 };
    }
    // Rows of this source that no page carried are gone at the source.
    let removed = 0;
    for (const table of replicaTablesOf(manifest, source)) {
      // `.replicated()` tables: the source id is the `_id`.
      const replicated = !!manifest.tables[table]!.replicated;
      const key = replicated ? `"_id"` : `"id"`;
      const name = `"${table.replaceAll('"', '""')}"`;
      let stale: Array<Record<string, unknown>>;
      if (single) {
        // The ids compare as the stored columns do: `_id` as text, a replica's `id` as the value its type
        // validated on upsert (every id of the page went through it above).
        const carried = new Set<unknown>();
        for (const r of s.rows) if (r.table === table) carried.add(replicated ? String(r.id) : r.id);
        stale = exec(`SELECT "_id", ${key} AS "sid" FROM ${name}`).filter((row) => !carried.has(replicated ? String(row.sid) : row.sid));
      } else {
        stale = exec(`SELECT "_id" FROM ${name} WHERE ${key} NOT IN (SELECT "sid" FROM "${REPLICA_SEEN_TABLE}" WHERE "source" = ? AND "tbl" = ?)`, source, table);
      }
      for (const row of stale) {
        db.delete(String(row._id));
        removed++;
      }
    }
    if (!single) exec(`DELETE FROM "${REPLICA_SEEN_TABLE}" WHERE "source" = ?`, source);
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

// ------------------------------------------------------------------------------------------------ cost (L5)

/**
 * The cost model of `.replicated()` tables: each write in global:main is one log row there, then one delivery per
 * target shard (batched per target: up to 100 rows per call), and one applied write per target. `ember dev` warns from
 * `REPLICATED_DEV_WRITES_PER_MINUTE` writes in a minute (or that many deliveries × targets), `ember deploy` prints the
 * targets each table has in the catalog.
 */
export const REPLICATED_DEV_WRITES_PER_MINUTE = 30;
export const REPLICATED_DEV_DELIVERIES_PER_MINUTE = 1_000;
/** Above this many target shards, `ember deploy` warns instead of noting. */
export const REPLICATED_MANY_TARGETS = 10_000;

/** Target shards of each `.replicated()` table, from catalog counts per kind (`global` is the source, never a target). */
export function replicatedTargets(m: Pick<SchemaManifest, "tables">, shardsByKind: Record<string, number>): Array<{ table: string; to: string[] | null; targets: number }> {
  return replicatedTablesOf(m).map((table) => {
    const t = m.tables[table]!;
    const targets = Object.entries(shardsByKind).reduce((n, [kind, count]) => n + (receivesReplicated(t, kind) ? count : 0), 0);
    return { table, to: t.replicated?.to ? [...t.replicated.to] : null, targets };
  });
}

/** What `ember deploy` prints about the replicated tables (`warning`: very many targets). */
export function replicatedDeployNotes(m: Pick<SchemaManifest, "tables">, shardsByKind: Record<string, number>): Array<{ warning: boolean; text: string }> {
  return replicatedTargets(m, shardsByKind).map(({ table, to, targets }) => {
    const where = to ? `the ${to.map((k) => `"${k}"`).join(", ")} shards` : "every shard";
    const many = targets >= REPLICATED_MANY_TARGETS;
    return {
      warning: many,
      text: `${table} is .replicated() to ${where}: ${targets} target shard${targets === 1 ? "" : "s"} in the catalog, so each write in ${REPLICATED_SOURCE} costs ${targets} deliveries${many ? " (keep its writes rare: batch them, or split the data)" : ""}`,
    };
  });
}

/** `ember dev`: the advice for a replicated table written `writes` times in the last minute, with `targets` targets. */
export function replicatedWriteAdvice(table: string, writes: number, targets: number): string | null {
  const deliveries = writes * Math.max(1, targets);
  if (writes < REPLICATED_DEV_WRITES_PER_MINUTE && deliveries < REPLICATED_DEV_DELIVERIES_PER_MINUTE) return null;
  return (
    `${table} is .replicated(): ${writes} writes in the last minute × ${targets} target shard${targets === 1 ? "" : "s"} here = ${deliveries} deliveries; ` +
    `in production every write costs one delivery per target shard (writes × shards). Replicated tables are for data written rarely (rates, catalogs, announcements): batch the updates, or keep fast-changing data in an ordinary table and read it with an action.`
  );
}
