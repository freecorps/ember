// Migration planner (PLAN §11): diff the wanted manifest against the database (sqlite_master +
// pragma_table_xinfo, plus the manifest stored in `_ember_meta` to know old field shapes), produce steps, apply
// them in one transaction. New indexes on tables with data are *staged*: created at once, kept current by every
// write, and filled by `backfillStep(limit)` in chunks; they cannot be queried until the backfill finishes.
//
//   new table                              createTable (indexes ready)
//   new optional field stored in _json     noop
//   new optional scalar field              addColumn
//   new required field                     addColumn/noop if the table is empty, refused otherwise
//   required -> optional (same layout)     noop
//   optional -> required (same layout)     noop if every document has the field, refused otherwise (with the count):
//                                          the two-step flow is optional + a data migration, then required
//   any other type change                  rebuildTable if empty, refused otherwise
//   removed field                          dropColumn/noop if no row has it, refused otherwise
//   new / changed index                    createIndex (staged + backfill if the table has data)
//   removed index                          dropIndex
//   removed table                          keepTable (data kept)

import { columnSpecFor, type FieldShape, type Shape, storageShape } from "@freecorps/ember-values";
import { lit, q, type SqlDriver, type SqlRow, type SqlValue } from "./driver.ts";
import {
  CLASSIC_STORAGE,
  createTableDdl,
  createTableSql,
  dbIndexesOf,
  docKey,
  indexFields,
  isCompactSql,
  legacyIdIndex,
  legacyIdIndexSql,
  ownedObjects,
  SYSTEM_DDL,
  type TableStorage,
} from "./ddl.ts";
import { AGGREGATE_KIND, AggregateMaintainer, type AggregateSpec } from "./aggregate.ts";
import { EmberError } from "./errors.ts";
import { REPLICA_STATE_DDL, REPLICA_STATE_TABLE, REPLICATED_SOURCE } from "./replica.ts";
import type { IndexKind } from "./indexKinds.ts";
import { decodeRow, keyColumn, layoutOf } from "./layout.ts";
import type { SchemaManifest, TableManifest } from "./schema.ts";
import type { IndexSpec, OwnedObject } from "./types.ts";

export type MigrationStep =
  | { op: "createTable"; table: string; sql: string[] }
  | { op: "rebuildTable"; table: string; reason: string; sql: string[] }
  | { op: "addColumn"; table: string; field: string; sql: string[] }
  | { op: "dropColumn"; table: string; field: string; sql: string[] }
  | { op: "noop"; table: string; field?: string; reason: string }
  | { op: "createIndex"; table: string; index: string; kind: string; staged: boolean; sql: string[] }
  | { op: "dropIndex"; table: string; index: string; sql: string[] }
  | { op: "keepTable"; table: string; reason: string }
  | { op: "refuse"; table: string; field?: string; reason: string };

export type MigrationPlan = { fromVersion: string | null; toVersion: string; steps: MigrationStep[]; ok: boolean };

export type MigrationReport = {
  /** true when DDL or metadata was written (first boot or schema change). */
  changed: boolean;
  fromVersion: string | null;
  toVersion: string;
  steps: MigrationStep[];
  /** Indexes still being backfilled (not queryable yet). */
  staged: Array<{ table: string; index: string; kind: string }>;
  /** Classic tables converted to compact storage (ddl.ts) by this call. */
  compacted?: string[];
};

// ------------------------------------------------------------------------------------------------ introspection

type IntrospectedTable = {
  /** Column name -> declared type (system and key columns included). */
  columns: Map<string, string>;
  /** Owned objects by name. */
  objects: Map<string, OwnedObject>;
  hasData: boolean;
  /** Compact or classic storage (ddl.ts). */
  storage: TableStorage;
};

export type Introspection = { tables: Map<string, IntrospectedTable>; stored: SchemaManifest | undefined };

const rows = (driver: SqlDriver, sql: string, ...params: SqlValue[]): SqlRow[] => driver.exec(sql, ...params).rows;

const FTS_SHADOW = ["_data", "_idx", "_content", "_docsize", "_config"];

export function introspect(driver: SqlDriver): Introspection {
  const master = rows(driver, `SELECT type, name, tbl_name, sql FROM sqlite_master`) as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
  const virtual = master.filter((m) => m.type === "table" && /^CREATE VIRTUAL TABLE/i.test(m.sql ?? "")).map((m) => m.name);
  const isShadow = (name: string) => virtual.some((vt) => FTS_SHADOW.some((s) => name === vt + s));
  const internal = (name: string) => name.startsWith("_") || name.startsWith("sqlite_");
  const tables = new Map<string, IntrospectedTable>();
  for (const m of master) {
    if (m.type !== "table" || internal(m.name) || m.name.includes("__") || isShadow(m.name) || virtual.includes(m.name)) continue;
    const columns = new Map(
      (rows(driver, `SELECT name, type FROM pragma_table_xinfo(?)`, m.name) as Array<{ name: string; type: string }>).map((c) => [c.name, c.type.toUpperCase()]),
    );
    const hasData = rows(driver, `SELECT 1 AS x FROM ${q(m.name)} LIMIT 1`).length > 0;
    const compact = isCompactSql(m.sql ?? "");
    tables.set(m.name, { columns, objects: new Map(), hasData, storage: compact ? { compact, legacy: false } : CLASSIC_STORAGE });
  }
  for (const m of master) {
    if (!m.sql || internal(m.name) || isShadow(m.name)) continue;
    const i = m.name.indexOf("__");
    if (i <= 0) continue;
    const owner = tables.get(m.name.slice(0, i));
    if (owner && m.name === legacyIdIndex(m.tbl_name) && owner.storage.compact) {
      // Managed by the compact conversion (compactTables), not by the schema's indexes.
      owner.storage = { compact: true, legacy: true };
      continue;
    }
    if (owner && (m.type === "index" || m.type === "trigger" || m.type === "table")) {
      owner.objects.set(m.name, { type: m.type, name: m.name, sql: m.sql });
    }
  }
  return { tables, stored: readStoredManifest(driver, master.some((m) => m.name === "_ember_meta")) };
}

function readStoredManifest(driver: SqlDriver, hasMeta: boolean): SchemaManifest | undefined {
  if (!hasMeta) return undefined;
  const row = rows(driver, `SELECT value FROM "_ember_meta" WHERE key = 'manifest'`)[0];
  return row ? (JSON.parse(String(row.value)) as SchemaManifest) : undefined;
}

export function storedVersion(driver: SqlDriver): string | null {
  const hasMeta = rows(driver, `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_ember_meta'`).length > 0;
  if (!hasMeta) return null;
  const row = rows(driver, `SELECT value FROM "_ember_meta" WHERE key = 'version'`)[0];
  return row ? String(row.value) : null;
}

// ------------------------------------------------------------------------------------------------ planning

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether every value `from` accepts, `to` accepts too: a widening needs no data migration (a new optional field in
 * an object, an array item or a record value widened, a new union member, a field becoming optional, anything to
 * `any`). Narrowings and different kinds are not.
 */
export function shapeAccepts(from: Shape, to: Shape): boolean {
  // Refinements (`.min()`, `.email()`, ...) and descriptions do not change storage: they apply to new writes only.
  from = storageShape(from);
  to = storageShape(to);
  if (same(from, to) || to.kind === "any") return true;
  if (from.kind === "union") return from.members.every((m) => shapeAccepts(m, to));
  if (to.kind === "union") return to.members.some((m) => shapeAccepts(from, m));
  if (from.kind !== to.kind) return false;
  switch (from.kind) {
    case "array":
      return shapeAccepts(from.item, (to as typeof from).item);
    case "record":
      return shapeAccepts(from.value, (to as typeof from).value);
    case "object": {
      const t = (to as typeof from).fields;
      // Own keys only: a field named like an Object.prototype member ("constructor") is a field like any other.
      for (const [k, f] of Object.entries(from.fields)) {
        const g = Object.hasOwn(t, k) ? t[k] : undefined;
        if (!g || (f.optional && !g.optional) || !shapeAccepts(f.shape, g.shape)) return false;
      }
      return Object.entries(t).every(([k, g]) => Object.hasOwn(from.fields, k) || g.optional);
    }
    default:
      return false; // same kind but not the same shape: another id table, another literal
  }
}
const ownerIndex = (table: string, objectName: string) => objectName.slice(table.length + 2).split("__")[0]!;

function layoutKey(f: FieldShape): string {
  const c = columnSpecFor(f);
  return c ? `${c.cls}:${c.nullable}` : "json";
}

export type PlanOptions = {
  /** New (and rebuilt) tables use compact storage (ddl.ts): the server engine's default; local replicas stay classic. */
  compact?: boolean;
  /** Tables kept classic whatever `compact` says (imported tables: `classicTables`). */
  classic?: ReadonlySet<string>;
  /**
   * The shard being migrated (null: not known yet, e.g. a shard that never served a request). A `.replicated()` table
   * is the source's own data in `global:main` (and where unknown: refused, never emptied) and a copy elsewhere.
   */
  shard?: string | null;
};

/** `_ember_meta` key: JSON array of the tables pinned to classic storage (an import put foreign ids in them). */
export const CLASSIC_TABLES_META = "classic_tables";

/** Tables pinned to classic storage (ids that do not carry a `_rowid`: imported tables). */
export function classicTables(driver: SqlDriver): Set<string> {
  const has = rows(driver, `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_ember_meta'`).length > 0;
  if (!has) return new Set();
  const raw = rows(driver, `SELECT value FROM "_ember_meta" WHERE key = ?`, CLASSIC_TABLES_META)[0]?.value;
  try {
    const list = typeof raw === "string" ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Pins `tables` to classic storage (kept by later migrations and never compacted). */
export function pinClassic(driver: SqlDriver, tables: Iterable<string>): void {
  for (const s of SYSTEM_DDL) driver.exec(s);
  const all = classicTables(driver);
  for (const t of tables) all.add(t);
  driver.exec(
    `INSERT INTO "_ember_meta" ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`,
    CLASSIC_TABLES_META,
    JSON.stringify([...all].sort()),
  );
}

export function planMigration(driver: SqlDriver, next: SchemaManifest, kinds: ReadonlyMap<string, IndexKind>, opts: PlanOptions = {}): MigrationPlan {
  const cur = introspect(driver);
  const steps: MigrationStep[] = [];
  for (const [table, t] of Object.entries(next.tables)) {
    const have = cur.tables.get(table);
    // Imported tables (foreign ids) and `.replicated()` tables (the source's ids in every shard) stay classic.
    const compact = (opts.compact ?? false) && !opts.classic?.has(table) && !t.replicated;
    if (!have) {
      steps.push({ op: "createTable", table, sql: createTableDdl(table, t, kinds, compact) });
      continue;
    }
    const copy = !!t.replicated && typeof opts.shard === "string" && opts.shard !== REPLICATED_SOURCE;
    steps.push(...planTable(driver, table, t, have, cur.stored?.tables[table], kinds, compact, copy));
  }
  for (const [table] of cur.tables) {
    if (!(table in next.tables)) steps.push({ op: "keepTable", table, reason: "table removed from the schema; its data is kept" });
  }
  return { fromVersion: cur.stored?.version ?? null, toVersion: next.version, steps, ok: !steps.some((s) => s.op === "refuse") };
}

const TWO_STEP = "deploy it as v.optional(...) first, fill it with a data migration (@freecorps/ember-migrations, `ember migrations run`), then make it required";

/**
 * Documents without `field`: 0 when every one has it. Column: NULL there and no escaped value in `_json` (NaN, ±Infinity
 * and -0 go to `_json`); JSON: no such key. Stops at the first one (LIMIT 1) before counting, so a table where every
 * document has the field costs one scan, and none is counted unless the migration is refused anyway.
 */
function countMissing(driver: SqlDriver, table: string, field: string, isColumn: boolean): number {
  const inJson = `json_type("_json", ${lit(`$."${field}"`)}) IS NULL`;
  const where = isColumn ? `${q(field)} IS NULL AND ${inJson}` : inJson;
  if (!rows(driver, `SELECT 1 AS x FROM ${q(table)} WHERE ${where} LIMIT 1`).length) return 0;
  return Number(rows(driver, `SELECT COUNT(*) AS n FROM ${q(table)} WHERE ${where}`)[0]!.n);
}

function planTable(
  driver: SqlDriver,
  table: string,
  t: TableManifest,
  have: IntrospectedTable,
  prev: TableManifest | undefined,
  kinds: ReadonlyMap<string, IndexKind>,
  compact: boolean,
  /** A `.replicated()` table in a shard that only holds a copy of it. */
  replicatedCopy = false,
): MigrationStep[] {
  const layout = layoutOf(table, t.document);
  const refuse: MigrationStep[] = [];
  const columnSteps: MigrationStep[] = [];
  const notes: MigrationStep[] = [];
  let rebuild: string | undefined;
  // A replica table holds copies: any change its rows cannot take is a rebuild (emptied), then a resync refills it.
  const replica = t.replica !== undefined || replicatedCopy;
  const source = t.replica?.source ?? REPLICATED_SOURCE;
  // A `.replicated()` table still in compact storage (it existed before `.replicated()`): rebuilt as classic where
  // that loses nothing (empty, or a copy); the source's own rows stay where they are (its ids are its own).
  if (t.replicated && have.storage.compact && (!have.hasData || replicatedCopy)) rebuild = "replicated tables use classic storage (copies keep the source's ids)";
  const typeChange = (field: string, reason: string) => {
    if (have.hasData && !replica) refuse.push({ op: "refuse", table, field, reason: `${reason}; the table has data, so this needs an explicit data migration` });
    else rebuild ??= reason;
  };

  if (prev && prev.idPrefix !== t.idPrefix) typeChange("_id", `id prefix changes ${prev.idPrefix} -> ${t.idPrefix}`);

  // Fields in the new schema.
  for (const [field, f] of Object.entries(t.document.fields)) {
    const pf = prev?.document.fields[field];
    const col = layout.column(field);
    const actual = have.columns.get(field);
    if (!pf && prev) {
      if (!f.optional && have.hasData) {
        if (replica) {
          rebuild ??= `new required field ${field} (replica: refilled by a resync)`;
          continue;
        }
        refuse.push({ op: "refuse", table, field, reason: `new required field ${field}; existing documents do not have it (${TWO_STEP})` });
        continue;
      }
    } else if (pf && !same(pf, f)) {
      const relaxOnly = same(pf.shape, f.shape) && !pf.optional && f.optional && layoutKey(pf) === layoutKey(f);
      // Widened in place (same storage): every stored value is still valid, nothing to move.
      const widened = !relaxOnly && (!pf.optional || f.optional) && layoutKey(pf) === layoutKey(f) && shapeAccepts(pf.shape, f.shape);
      // Made required in place (same storage, same or wider shape): fine once every document has the field.
      const required = !relaxOnly && !widened && pf.optional && !f.optional && layoutKey(pf) === layoutKey(f) && shapeAccepts(pf.shape, f.shape);
      if (relaxOnly) notes.push({ op: "noop", table, field, reason: `${field} becomes optional` });
      else if (widened) notes.push({ op: "noop", table, field, reason: `${field} is widened (stored values stay valid)` });
      else if (required) {
        const missing = have.hasData ? countMissing(driver, table, field, have.columns.has(field)) : 0;
        if (missing && replica) {
          // Copies: emptied and refilled by a resync, like any change a replica table cannot take.
          rebuild ??= `field ${field} becomes required (replica: refilled by a resync)`;
          continue;
        }
        if (missing) {
          refuse.push({ op: "refuse", table, field, reason: `field ${field} becomes required but ${missing} document(s) do not have it (${TWO_STEP})` });
          continue;
        }
        notes.push({ op: "noop", table, field, reason: `${field} becomes required (every document has it)` });
      } else typeChange(field, `field ${field} changes type`);
    }
    if (col) {
      if (actual === undefined) {
        // A field moving from _json into a column (e.g. no previous manifest) needs its data moved.
        if (pf && layoutKey(pf) !== layoutKey(f)) typeChange(field, `field ${field} moves from JSON to a column`);
        else columnSteps.push({ op: "addColumn", table, field, sql: [`ALTER TABLE ${q(table)} ADD COLUMN ${q(field)} ${col.spec.sqlType}`] });
      } else if (actual !== col.spec.sqlType) typeChange(field, `column ${field} changes type ${actual} -> ${col.spec.sqlType}`);
    } else {
      if (actual !== undefined) typeChange(field, `field ${field} moves from a column to JSON`);
      else if (!pf) notes.push({ op: "noop", table, field, reason: `new ${f.optional ? "optional " : ""}field ${field} is stored in _json` });
    }
  }

  // Fields that were removed.
  const removed = new Set<string>();
  for (const field of Object.keys(prev?.document.fields ?? {})) if (!(field in t.document.fields)) removed.add(field);
  for (const [c] of have.columns) {
    if (c.startsWith("_") || c in t.document.fields) continue;
    removed.add(c);
  }
  for (const field of removed) {
    const isColumn = have.columns.has(field);
    if (have.hasData) {
      const present = isColumn
        ? rows(driver, `SELECT 1 AS x FROM ${q(table)} WHERE ${q(field)} IS NOT NULL LIMIT 1`).length > 0
        : rows(driver, `SELECT 1 AS x FROM ${q(table)} WHERE json_type("_json", ${lit(`$."${field}"`)}) IS NOT NULL LIMIT 1`).length > 0;
      if (present) {
        if (replica) {
          rebuild ??= `field ${field} removed (replica: refilled by a resync)`;
          continue;
        }
        refuse.push({ op: "refuse", table, field, reason: `field ${field} was removed but documents still have it` });
        continue;
      }
    }
    if (isColumn) columnSteps.push({ op: "dropColumn", table, field, sql: [`ALTER TABLE ${q(table)} DROP COLUMN ${q(field)}`] });
    else notes.push({ op: "noop", table, field, reason: `field ${field} removed` });
  }

  if (refuse.length) return refuse;
  if (rebuild) {
    const dropOwned = [...have.objects.values()]
      .filter((o) => o.type === "table")
      .map((o) => `DROP TABLE IF EXISTS ${q(o.name)}`);
    // An emptied replica forgets how far its source got: the next delivery finds the gap and asks for a resync.
    const resync = replica && have.hasData ? [REPLICA_STATE_DDL, `DELETE FROM "${REPLICA_STATE_TABLE}" WHERE "source" = ${lit(source)}`] : [];
    return [{ op: "rebuildTable", table, reason: rebuild, sql: [...dropOwned, `DROP TABLE ${q(table)}`, ...createTableDdl(table, t, kinds, compact), ...resync] }];
  }

  // Indexes: compare each wanted index with what exists (objects by SQL text, key column, stored spec).
  const dropSteps: MigrationStep[] = [];
  const createSteps: MigrationStep[] = [];
  const wanted = ownedObjects(table, t, kinds, layout, have.storage.compact);
  const wantedNames = new Set(wanted.map((w) => w.index.name));
  const prevSpecs = new Map<string, IndexSpec>((prev ? [...dbIndexesOf(prev), ...prev.indexes.filter((i) => i.kind !== "db")] : []).map((i) => [i.name, i]));
  const existingByIndex = new Map<string, OwnedObject[]>();
  for (const o of have.objects.values()) {
    const idx = ownerIndex(table, o.name);
    existingByIndex.set(idx, [...(existingByIndex.get(idx) ?? []), o]);
  }
  const keyColumns = new Set([...have.columns.keys()].filter((c) => c.startsWith("_k_")).map((c) => c.slice(3)));

  const dropIndexSql = (index: string): string[] => {
    const objs = existingByIndex.get(index) ?? [];
    const order = { trigger: 0, index: 1, table: 2 } as const;
    const sql = [...objs].sort((a, b) => order[a.type] - order[b.type]).map((o) => `DROP ${o.type.toUpperCase()} IF EXISTS ${q(o.name)}`);
    if (keyColumns.has(index)) sql.push(`ALTER TABLE ${q(table)} DROP COLUMN ${q(keyColumn(index))}`);
    return sql;
  };

  for (const { index, objects } of wanted) {
    const existing = existingByIndex.get(index.name) ?? [];
    const objectsSame =
      existing.length === objects.length && objects.every((o) => existing.some((e) => e.name === o.name && norm(e.sql) === norm(o.sql)));
    const keyOk = index.kind !== "db" || keyColumns.has(index.name);
    const kindOf = index.kind === "db" ? undefined : kinds.get(index.kind);
    const ident = (x: IndexSpec | undefined) => (x && kindOf?.identity ? kindOf.identity(x) : x);
    const specSame = index.name === "by_creation_time" || (prev !== undefined && same(ident(prevSpecs.get(index.name)), ident(index)));
    if (objectsSame && keyOk && specSame) continue;
    const drop = dropIndexSql(index.name);
    if (drop.length) dropSteps.push({ op: "dropIndex", table, index: index.name, sql: drop });
    const kind = index.kind === "db" ? undefined : kinds.get(index.kind);
    const staged = have.hasData && (index.kind === "db" || index.kind === AGGREGATE_KIND || kind?.backfill !== undefined);
    const sql = [
      ...(index.kind === "db" ? [`ALTER TABLE ${q(table)} ADD COLUMN ${q(keyColumn(index.name))} BLOB`] : []),
      ...objects.map((o) => o.sql),
    ];
    createSteps.push({ op: "createIndex", table, index: index.name, kind: index.kind, staged, sql });
  }
  for (const idx of new Set([...existingByIndex.keys(), ...keyColumns])) {
    if (!wantedNames.has(idx)) dropSteps.push({ op: "dropIndex", table, index: idx, sql: dropIndexSql(idx) });
  }
  // Drops first (a column cannot be dropped while indexed), then columns, then creates.
  return [...dropSteps, ...columnSteps, ...notes, ...createSteps];
}

// ------------------------------------------------------------------------------------------------ apply

/** Applies a plan in one (nestable) transaction and records the manifest. Throws MigrationRefused. */
export function applyMigration(driver: SqlDriver, plan: MigrationPlan, next: SchemaManifest): MigrationReport {
  if (!plan.ok) {
    const reasons = plan.steps.filter((s): s is Extract<MigrationStep, { op: "refuse" }> => s.op === "refuse").map((s) => `${s.table}: ${s.reason}`);
    throw new EmberError("MigrationRefused", `Schema migration refused:\n  ${reasons.join("\n  ")}`, { steps: plan.steps });
  }
  driver.transaction(() => {
    for (const s of SYSTEM_DDL) driver.exec(s);
    for (const step of plan.steps) {
      if (step.op === "dropIndex" || step.op === "rebuildTable" || step.op === "createIndex") {
        if (step.op === "rebuildTable") driver.exec(`DELETE FROM "_ember_indexes" WHERE "tbl" = ?`, step.table);
        else driver.exec(`DELETE FROM "_ember_indexes" WHERE "tbl" = ? AND "name" = ?`, step.table, step.index);
      }
      if ("sql" in step) for (const s of step.sql) driver.exec(s);
      if (step.op === "createIndex" && step.staged) {
        const until = Number(rows(driver, `SELECT coalesce(max("_rowid"), 0) AS m FROM ${q(step.table)}`)[0]!.m);
        driver.exec(
          `INSERT INTO "_ember_indexes" ("tbl", "name", "kind", "cursor", "until") VALUES (?, ?, ?, 0, ?)`,
          step.table,
          step.index,
          step.kind,
          until,
        );
      }
    }
    const put = (key: string, value: string) =>
      driver.exec(`INSERT INTO "_ember_meta" ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`, key, value);
    put("manifest", JSON.stringify(next));
    put("version", next.version);
  });
  return { changed: true, fromVersion: plan.fromVersion, toVersion: next.version, steps: plan.steps, staged: stagedIndexes(driver) };
}

export function stagedIndexes(driver: SqlDriver): Array<{ table: string; index: string; kind: string }> {
  const has = rows(driver, `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_ember_indexes'`).length > 0;
  if (!has) return [];
  return rows(driver, `SELECT "tbl", "name", "kind" FROM "_ember_indexes" ORDER BY "tbl", "name"`).map((r) => ({
    table: String(r.tbl),
    index: String(r.name),
    kind: String(r.kind),
  }));
}

// ------------------------------------------------------------------------------------------------ backfill

export type BackfillProgress = {
  /** No staged index is left. */
  done: boolean;
  table?: string;
  index?: string;
  /** Rows processed in this step. */
  processed: number;
  /** This index finished (is now queryable). */
  indexReady?: boolean;
  /** Classic tables converted to compact storage once the last backfill finished (engine.backfillStep). */
  compacted?: string[];
};

/** Backfills up to `limit` rows of the first staged index, in one transaction. */
export function backfillStep(driver: SqlDriver, m: SchemaManifest, kinds: ReadonlyMap<string, IndexKind>, limit = 500): BackfillProgress {
  return driver.transaction(() => {
    const job = rows(driver, `SELECT "tbl", "name", "kind", "cursor", "until" FROM "_ember_indexes" ORDER BY "tbl", "name" LIMIT 1`)[0];
    if (!job) return { done: true, processed: 0 };
    const table = String(job.tbl);
    const index = String(job.name);
    const cursor = Number(job.cursor);
    const until = Number(job.until);
    const t = m.tables[table];
    const finish = () => driver.exec(`DELETE FROM "_ember_indexes" WHERE "tbl" = ? AND "name" = ?`, table, index);
    if (!t) {
      finish();
      return { done: stagedIndexes(driver).length === 0, table, index, processed: 0, indexReady: true };
    }
    const boundary = rows(
      driver,
      `SELECT max("_rowid") AS m, count(*) AS n FROM (SELECT "_rowid" FROM ${q(table)} WHERE "_rowid" > ? AND "_rowid" <= ? ORDER BY "_rowid" LIMIT ?)`,
      cursor,
      until,
      limit,
    )[0]!;
    const processed = Number(boundary.n);
    const end = boundary.m === null ? until : Number(boundary.m);
    if (processed > 0) {
      const layout = layoutOf(table, t.document);
      const spec = t.indexes.find((i) => i.name === index);
      if (String(job.kind) === "db") {
        const fields = indexFields(t, index)!;
        for (const row of rows(driver, `SELECT * FROM ${q(table)} WHERE "_rowid" > ? AND "_rowid" <= ?`, cursor, end)) {
          const doc = decodeRow(layout, row);
          driver.exec(`UPDATE ${q(table)} SET ${q(keyColumn(index))} = ? WHERE "_rowid" = ?`, docKey(doc, fields), row._rowid as number);
        }
      } else if (spec?.kind === AGGREGATE_KIND) {
        // Live writes skip rows in (cursor, until]; add each of them once here.
        const agg = new AggregateMaintainer((sql, ...p) => driver.exec(sql, ...p).rows, table, t.document);
        for (const row of rows(driver, `SELECT * FROM ${q(table)} WHERE "_rowid" > ? AND "_rowid" <= ?`, cursor, end)) {
          agg.apply(spec as AggregateSpec, null, decodeRow(layout, row));
        }
      } else if (spec) {
        const sql = kinds.get(spec.kind)?.backfill?.(layout, spec);
        if (sql) driver.exec(sql, cursor, end);
      }
    }
    const ready = end >= until || processed < limit;
    if (ready) finish();
    else driver.exec(`UPDATE "_ember_indexes" SET "cursor" = ? WHERE "tbl" = ? AND "name" = ?`, end, table, index);
    return { done: ready && stagedIndexes(driver).length === 0, table, index, processed, indexReady: ready };
  });
}

// ------------------------------------------------------------------------------------------------ compact storage

export type CompactReport = {
  /** Tables converted from classic to compact storage in this call. */
  converted: string[];
  /** Tables left classic, and why. */
  skipped: Array<{ table: string; reason: string }>;
  /** Some table could be converted by a later call (an index backfill was running). */
  pending: boolean;
};

/** Classic tables above this many rows stay classic (one conversion is one transaction). */
export const COMPACT_MAX_ROWS = 100_000;

const SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Converts the manifest's classic tables to compact storage (ddl.ts), each in the same transaction: rows keep their
 * ids and documents, `_rowid` becomes `_creationTime` in µs (two documents created in the same µs: the later one
 * moves 1 µs, its index keys with it), the old rows are marked `_legacy` for `<table>__by_id`, and every index is
 * rebuilt (aggregates are kept: they do not depend on rowids). Tables with a backfill in progress wait.
 */
export function compactTables(driver: SqlDriver, m: SchemaManifest, kinds: ReadonlyMap<string, IndexKind>, maxRows = COMPACT_MAX_ROWS): CompactReport {
  const report: CompactReport = { converted: [], skipped: [], pending: false };
  const cur = introspect(driver);
  const staged = new Set(stagedIndexes(driver).map((x) => x.table));
  const pinned = classicTables(driver);
  for (const [table, t] of Object.entries(m.tables)) {
    const have = cur.tables.get(table);
    // `.replicated()` tables stay classic (planMigration).
    if (!have || have.storage.compact || t.replicated) continue;
    if (pinned.has(table)) {
      // Foreign ids (an import) do not carry a `_rowid`, and the conversion may move `_creationTime` by 1 µs.
      report.skipped.push({ table, reason: "pinned to classic storage (imported ids)" });
      continue;
    }
    if (staged.has(table)) {
      report.skipped.push({ table, reason: "an index backfill is in progress" });
      report.pending = true;
      continue;
    }
    const n = Number(rows(driver, `SELECT count(*) AS n FROM ${q(table)}`)[0]!.n);
    if (n > maxRows) {
      report.skipped.push({ table, reason: `${n} rows (more than ${maxRows})` });
      continue;
    }
    // One transaction (a savepoint inside an outer one) per table: a failing conversion leaves the others done.
    try {
      const why = driver.transaction(() => convertTable(driver, table, t, have, kinds, n > 0));
      if (why) report.skipped.push({ table, reason: why });
      else report.converted.push(table);
    } catch (e) {
      // Not retried on every boot: the next schema change tries again (engine.migrate).
      report.skipped.push({ table, reason: `conversion failed: ${(e as Error).message}` });
    }
  }
  return report;
}

function convertTable(driver: SqlDriver, table: string, t: TableManifest, have: IntrospectedTable, kinds: ReadonlyMap<string, IndexKind>, hasData: boolean): string | undefined {
  const layout = layoutOf(table, t.document);
  const tmp = `${table}__compacting`;
  driver.exec(`DROP TABLE IF EXISTS ${q(tmp)}`);
  driver.exec(createTableSql(tmp, layout, t, true, hasData));
  const cols = (rows(driver, `SELECT name FROM pragma_table_xinfo(?)`, tmp) as Array<{ name: string }>).map((c) => c.name).filter((c) => c !== "_rowid" && c !== "_legacy");
  const extra = [...have.columns.keys()].filter((c) => c !== "_rowid" && !cols.includes(c));
  if (cols.some((c) => !have.columns.has(c)) || extra.length) {
    driver.exec(`DROP TABLE ${q(tmp)}`);
    return `columns differ from the schema (${extra.join(", ") || "missing columns"})`;
  }
  if (hasData) {
    const dup = Number(rows(driver, `SELECT count(*) - count(DISTINCT CAST(round("_creationTime" * 1000) AS INTEGER)) AS d FROM ${q(table)}`)[0]!.d);
    if (dup > 0) spreadCreationTimes(driver, table, t, layout);
    const list = cols.map(q).join(", ");
    driver.exec(`INSERT INTO ${q(tmp)} ("_rowid", "_legacy", ${list}) SELECT CAST(round("_creationTime" * 1000) AS INTEGER), 1, ${list} FROM ${q(table)}`);
  }
  const keep = new Set(t.indexes.filter((i) => i.kind === AGGREGATE_KIND).map((i) => i.name));
  const order = { trigger: 0, index: 1, table: 2 } as const;
  for (const o of [...have.objects.values()].sort((a, b) => order[a.type] - order[b.type])) {
    if (keep.has(ownerIndex(table, o.name)) || o.name === tmp) continue;
    driver.exec(`DROP ${o.type.toUpperCase()} IF EXISTS ${q(o.name)}`);
  }
  driver.exec(`DROP TABLE ${q(table)}`);
  driver.exec(`ALTER TABLE ${q(tmp)} RENAME TO ${q(table)}`);
  for (const { index, objects } of ownedObjects(table, t, kinds, layout, true)) {
    if (keep.has(index.name)) continue;
    for (const o of objects) driver.exec(o.sql);
    // Rowid-keyed objects (FTS5 external content) are refilled; kinds without local objects keep their state.
    const fill = index.kind === "db" || !objects.length ? undefined : kinds.get(index.kind)?.backfill?.(layout, index);
    if (fill && hasData) driver.exec(fill, -SAFE, SAFE);
  }
  if (hasData) driver.exec(legacyIdIndexSql(table));
  return undefined;
}

/**
 * Converts a compact table back to classic storage (an `_id` index and a `by_creation_time` index; ids that do not
 * carry the rowid can then live in it) and pins it there. Rows keep their `_rowid`, ids and documents; owned
 * objects are rebuilt (aggregates are kept). No-op for a table that is classic already. One transaction.
 */
export function toClassic(driver: SqlDriver, table: string, t: TableManifest, kinds: ReadonlyMap<string, IndexKind>): boolean {
  return driver.transaction(() => {
    pinClassic(driver, [table]);
    const have = introspect(driver).tables.get(table);
    if (!have || !have.storage.compact) return false;
    const layout = layoutOf(table, t.document);
    const tmp = `${table}__declassing`;
    driver.exec(`DROP TABLE IF EXISTS ${q(tmp)}`);
    driver.exec(createTableSql(tmp, layout, t, false));
    const cols = (rows(driver, `SELECT name FROM pragma_table_xinfo(?)`, tmp) as Array<{ name: string }>).map((c) => c.name);
    const shared = cols.filter((c) => have.columns.has(c));
    if (have.hasData) driver.exec(`INSERT INTO ${q(tmp)} (${shared.map(q).join(", ")}) SELECT ${shared.map(q).join(", ")} FROM ${q(table)}`);
    const keep = new Set(t.indexes.filter((i) => i.kind === AGGREGATE_KIND).map((i) => i.name));
    const order = { trigger: 0, index: 1, table: 2 } as const;
    for (const o of [...have.objects.values()].sort((a, b) => order[a.type] - order[b.type])) {
      if (keep.has(ownerIndex(table, o.name)) || o.name === tmp) continue;
      driver.exec(`DROP ${o.type.toUpperCase()} IF EXISTS ${q(o.name)}`);
    }
    driver.exec(`DROP INDEX IF EXISTS ${q(legacyIdIndex(table))}`);
    driver.exec(`DROP TABLE ${q(table)}`);
    driver.exec(`ALTER TABLE ${q(tmp)} RENAME TO ${q(table)}`);
    for (const { index, objects } of ownedObjects(table, t, kinds, layout, false)) {
      if (keep.has(index.name)) continue;
      for (const o of objects) driver.exec(o.sql);
      const fill = index.kind === "db" || !objects.length ? undefined : kinds.get(index.kind)?.backfill?.(layout, index);
      if (fill && have.hasData) driver.exec(fill, -SAFE, SAFE);
    }
    return true;
  });
}

/** Makes `_creationTime` unique at µs resolution, in key order: a document sharing its µs moves to the next free one. */
function spreadCreationTimes(driver: SqlDriver, table: string, t: TableManifest, layout: ReturnType<typeof layoutOf>): void {
  const indexes = dbIndexesOf(t).map((i) => ({ column: keyColumn(i.name), fields: indexFields(t, i.name)! }));
  let prev = -SAFE;
  // Only the creation times in key order; a whole document is read only when it has to move.
  for (const r of rows(driver, `SELECT "_rowid", "_creationTime" FROM ${q(table)} ORDER BY ${q(keyColumn("by_creation_time"))}`)) {
    const ct = Number(r._creationTime);
    let us = Math.round(ct * 1000);
    if (us <= prev) us = prev + 1;
    prev = us;
    if (us === Math.round(ct * 1000)) continue;
    const row = rows(driver, `SELECT * FROM ${q(table)} WHERE "_rowid" = ?`, Number(r._rowid))[0]!;
    const doc = { ...decodeRow(layout, row), _creationTime: us / 1000 };
    const sets: Array<[string, SqlValue]> = [["_creationTime", us / 1000], ...indexes.map((i): [string, SqlValue] => [i.column, docKey(doc, i.fields)])];
    for (let i = 0; i < sets.length; i += 90) {
      const part = sets.slice(i, i + 90);
      driver.exec(`UPDATE ${q(table)} SET ${part.map(([c]) => `${q(c)} = ?`).join(", ")} WHERE "_rowid" = ?`, ...part.map(([, x]) => x), Number(row._rowid));
    }
  }
}

export { createTableSql };
