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
//   any other type change                  rebuildTable if empty, refused otherwise
//   removed field                          dropColumn/noop if no row has it, refused otherwise
//   new / changed index                    createIndex (staged + backfill if the table has data)
//   removed index                          dropIndex
//   removed table                          keepTable (data kept)

import { columnSpecFor, type FieldShape } from "@freecorps/ember-values";
import { lit, q, type SqlDriver, type SqlRow, type SqlValue } from "./driver.ts";
import { createTableDdl, createTableSql, dbIndexesOf, docKey, indexFields, ownedObjects, SYSTEM_DDL } from "./ddl.ts";
import { AGGREGATE_KIND, AggregateMaintainer, type AggregateSpec } from "./aggregate.ts";
import { EmberError } from "./errors.ts";
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
};

// ------------------------------------------------------------------------------------------------ introspection

type IntrospectedTable = {
  /** Column name -> declared type (system and key columns included). */
  columns: Map<string, string>;
  /** Owned objects by name. */
  objects: Map<string, OwnedObject>;
  hasData: boolean;
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
    tables.set(m.name, { columns, objects: new Map(), hasData });
  }
  for (const m of master) {
    if (!m.sql || internal(m.name) || isShadow(m.name)) continue;
    const i = m.name.indexOf("__");
    if (i <= 0) continue;
    const owner = tables.get(m.name.slice(0, i));
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
const ownerIndex = (table: string, objectName: string) => objectName.slice(table.length + 2).split("__")[0]!;

function layoutKey(f: FieldShape): string {
  const c = columnSpecFor(f);
  return c ? `${c.cls}:${c.nullable}` : "json";
}

export function planMigration(driver: SqlDriver, next: SchemaManifest, kinds: ReadonlyMap<string, IndexKind>): MigrationPlan {
  const cur = introspect(driver);
  const steps: MigrationStep[] = [];
  for (const [table, t] of Object.entries(next.tables)) {
    const have = cur.tables.get(table);
    if (!have) {
      steps.push({ op: "createTable", table, sql: createTableDdl(table, t, kinds) });
      continue;
    }
    steps.push(...planTable(driver, table, t, have, cur.stored?.tables[table], kinds));
  }
  for (const [table] of cur.tables) {
    if (!(table in next.tables)) steps.push({ op: "keepTable", table, reason: "table removed from the schema; its data is kept" });
  }
  return { fromVersion: cur.stored?.version ?? null, toVersion: next.version, steps, ok: !steps.some((s) => s.op === "refuse") };
}

function planTable(
  driver: SqlDriver,
  table: string,
  t: TableManifest,
  have: IntrospectedTable,
  prev: TableManifest | undefined,
  kinds: ReadonlyMap<string, IndexKind>,
): MigrationStep[] {
  const layout = layoutOf(table, t.document);
  const refuse: MigrationStep[] = [];
  const columnSteps: MigrationStep[] = [];
  const notes: MigrationStep[] = [];
  let rebuild: string | undefined;
  const typeChange = (field: string, reason: string) => {
    if (have.hasData) refuse.push({ op: "refuse", table, field, reason: `${reason}; the table has data, so this needs an explicit data migration` });
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
        refuse.push({ op: "refuse", table, field, reason: `new required field ${field}; existing documents do not have it` });
        continue;
      }
    } else if (pf && !same(pf, f)) {
      const relaxOnly = same(pf.shape, f.shape) && !pf.optional && f.optional && layoutKey(pf) === layoutKey(f);
      if (relaxOnly) notes.push({ op: "noop", table, field, reason: `${field} becomes optional` });
      else typeChange(field, `field ${field} changes type`);
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
    return [{ op: "rebuildTable", table, reason: rebuild, sql: [...dropOwned, `DROP TABLE ${q(table)}`, ...createTableDdl(table, t, kinds)] }];
  }

  // Indexes: compare each wanted index with what exists (objects by SQL text, key column, stored spec).
  const dropSteps: MigrationStep[] = [];
  const createSteps: MigrationStep[] = [];
  const wanted = ownedObjects(table, t, kinds, layout);
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

export { createTableSql };
