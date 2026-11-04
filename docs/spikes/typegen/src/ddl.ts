// Schema -> SQLite DDL, introspection, and schema diff -> migration plan.
//
// Layout of a user table `t` (STRICT, so SQLite enforces column types too):
//   _rowid INTEGER PRIMARY KEY  -- explicit, so VACUUM never renumbers it (FTS5 / plugin side tables key on it)
//   _id TEXT NOT NULL UNIQUE, _creationTime REAL NOT NULL,
//   one typed column per top-level scalar field (TEXT / REAL / INTEGER), nullable,
//   _rest TEXT NOT NULL DEFAULT '{}'  -- JSON of every other field (nested, arrays, unions of mixed types,
//                                       optional+nullable scalars, where NULL could not tell undefined from null)
// Every owned object (b-tree index, FTS5 table, trigger, plugin side table) is named `t__<something>` and is
// diffed against sqlite_master by its exact SQL text, so any index-kind plugin gets migrations for free.

import { indexKind, type IndexSpec, type OwnedObject, type SchemaJson, type TableLayout } from "./schema";
import { lit, q, type Sql } from "./sqlite";
import { validate, fromJson, type FieldShape, type Shape } from "./values";

export type ColumnType = "TEXT" | "REAL" | "INTEGER";
export type Column = { field: string; type: ColumnType };

// ------------------------------------------------------------------------------------------------ layout

function scalarType(shape: Shape): ColumnType | "null" | undefined {
  switch (shape.kind) {
    case "string":
    case "id":
      return "TEXT";
    case "float64":
      return "REAL";
    case "int64":
    case "boolean":
      return "INTEGER";
    case "null":
      return "null";
    case "literal":
      return typeof shape.value === "string" ? "TEXT" : typeof shape.value === "boolean" ? "INTEGER" : "REAL";
    default:
      return undefined;
  }
}

/** The column for a top-level field, or undefined if it lives in `_rest`. */
export function columnFor(field: FieldShape): ColumnType | undefined {
  const members = field.shape.kind === "union" ? field.shape.members : [field.shape];
  const types = new Set(members.map(scalarType));
  if (types.has(undefined)) return undefined;
  const nullable = types.delete("null");
  if (types.size !== 1) return undefined;
  if (nullable && field.optional) return undefined; // NULL would be ambiguous: undefined vs null
  return [...types][0] as ColumnType;
}

export function columnsOf(documentShape: Shape): Column[] {
  if (documentShape.kind !== "object") throw new Error("Table validator must be v.object");
  return Object.entries(documentShape.fields).flatMap(([field, f]) => {
    const type = columnFor(f);
    return type ? [{ field, type }] : [];
  });
}

export function layoutOf(table: string, documentShape: Shape): TableLayout & { columns: Column[] } {
  const columns = columnsOf(documentShape);
  const colSet = new Set(columns.map((c) => c.field));
  return {
    table,
    columns,
    expr(path, rowRef) {
      const p = rowRef ? `${rowRef}.` : "";
      if (path === "_id" || path === "_creationTime" || colSet.has(path)) return `${p}${q(path)}`;
      return `json_extract(${p}"_rest", ${lit("$." + path.split(".").map((s) => `"${s}"`).join("."))})`;
    },
  };
}

// ------------------------------------------------------------------------------------------------ compile

export const META_DDL = [
  `CREATE TABLE IF NOT EXISTS "_cfx_tables" (name TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE) STRICT`,
  `CREATE TABLE IF NOT EXISTS "_cfx_schema" (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL) STRICT`,
];

export function createTableSql(table: string, documentShape: Shape): string {
  const cols = columnsOf(documentShape).map((c) => `${q(c.field)} ${c.type}`);
  return [
    `CREATE TABLE ${q(table)} (`,
    [`"_rowid" INTEGER PRIMARY KEY`, `"_id" TEXT NOT NULL UNIQUE`, `"_creationTime" REAL NOT NULL`, ...cols, `"_rest" TEXT NOT NULL DEFAULT '{}'`].join(", "),
    `) STRICT`,
  ].join("");
}

/** The built-in kind: a b-tree over (fields..., _creationTime, _id), so ties order like Convex. */
export function dbIndexSql(layout: TableLayout, name: string, fields: string[]): OwnedObject {
  const objName = `${layout.table}__${name}`;
  const cols = [...fields, "_creationTime", "_id"].map((f) => layout.expr(f));
  return { type: "index", name: objName, sql: `CREATE INDEX ${q(objName)} ON ${q(layout.table)} (${cols.join(", ")})` };
}

export function ownedObjects(table: string, documentShape: Shape, indexes: IndexSpec[]): OwnedObject[] {
  const layout = layoutOf(table, documentShape);
  const out: OwnedObject[] = [dbIndexSql(layout, "by_creation_time", [])];
  for (const spec of indexes) {
    if (spec.kind === "db") out.push(dbIndexSql(layout, spec.name, spec.fields));
    else {
      for (const obj of indexKind(spec.kind).ddl(layout, spec)) {
        if (!obj.name.startsWith(`${table}__`)) throw new Error(`Plugin object ${obj.name} must start with ${table}__`);
        out.push(obj);
      }
    }
  }
  return out;
}

/** Full DDL for an empty database (what `compileSchema` hands a fresh shard). */
export function compileSchema(schema: SchemaJson): string[] {
  return [
    ...META_DDL,
    ...Object.entries(schema.tables).flatMap(([t, def]) => [
      createTableSql(t, def.documentShape),
      ...ownedObjects(t, def.documentShape, def.indexes).map((o) => o.sql),
    ]),
  ];
}

// ------------------------------------------------------------------------------------------------ introspect

export type Introspected = {
  tables: Map<string, { columns: Map<string, string>; objects: Map<string, OwnedObject>; rows: number }>;
  storedSchema: SchemaJson | undefined;
};

export function introspect(sql: Sql): Introspected {
  const master = sql.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    `SELECT type, name, tbl_name, sql FROM sqlite_master`,
  );
  const virtual = master.filter((m) => m.type === "table" && m.sql?.startsWith("CREATE VIRTUAL TABLE")).map((m) => m.name);
  const isShadow = (name: string) => virtual.some((vt) => name.startsWith(vt + "_"));
  const tables: Introspected["tables"] = new Map();
  for (const m of master) {
    if (m.type !== "table" || m.name.startsWith("_") || m.name.startsWith("sqlite_") || m.name.includes("__")) continue;
    const columns = new Map(
      sql.all<{ name: string; type: string }>(`PRAGMA table_info(${q(m.name)})`).map((c) => [c.name, c.type]),
    );
    const rows = Number(sql.all<{ n: bigint }>(`SELECT count(*) AS n FROM ${q(m.name)}`)[0]!.n);
    tables.set(m.name, { columns, objects: new Map(), rows });
  }
  for (const m of master) {
    if (!m.sql || !m.name.includes("__") || isShadow(m.name)) continue;
    const owner = tables.get(m.name.slice(0, m.name.indexOf("__")));
    if (owner) owner.objects.set(m.name, { type: m.type as OwnedObject["type"], name: m.name, sql: m.sql });
  }
  const hasMeta = master.some((m) => m.name === "_cfx_schema");
  const stored = hasMeta ? sql.all<{ json: string }>(`SELECT json FROM "_cfx_schema" WHERE id = 1`)[0] : undefined;
  return { tables, storedSchema: stored ? JSON.parse(stored.json) : undefined };
}

// ------------------------------------------------------------------------------------------------ plan

/** safe: metadata only. backfill: builds from existing rows. validate: scans rows. breaking: refused. */
export type Risk = "safe" | "backfill" | "validate" | "breaking";

export type Step =
  | { op: "createTable"; table: string; risk: Risk; sql: string[] }
  | { op: "rebuildTable"; table: string; risk: Risk; reason: string; sql: string[] }
  | { op: "addColumn"; table: string; field: string; risk: Risk; sql: string[] }
  | { op: "moveField"; table: string; field: string; risk: Risk; reason: string; sql: string[] }
  | { op: "dropColumn"; table: string; field: string; risk: Risk; sql: string[] }
  | { op: "noop"; table: string; field: string; risk: Risk; reason: string }
  | { op: "createObject"; table: string; name: string; risk: Risk; sql: string[] }
  | { op: "dropObject"; table: string; name: string; risk: Risk; sql: string[] }
  | { op: "validateData"; table: string; risk: Risk; checked: number }
  | { op: "keepOrphanTable"; table: string; risk: Risk; reason: string }
  | { op: "fail"; table: string; risk: Risk; reason: string };

export type Plan = { steps: Step[]; ok: boolean };

/**
 * Diffs `next` against what the database holds (introspection + the stored schema JSON) and returns the steps
 * to get there. Existing documents are checked against the new validators when the shape changed (Convex's
 * schemaValidation on push); a step that cannot be done without a data migration becomes `fail`.
 */
export function planMigration(sql: Sql, next: SchemaJson, tableOfId?: (id: string) => string | undefined): Plan {
  const cur = introspect(sql);
  const steps: Step[] = [];
  for (const [table, def] of Object.entries(next.tables)) {
    const have = cur.tables.get(table);
    const wantObjects = ownedObjects(table, def.documentShape, def.indexes);
    const layout = layoutOf(table, def.documentShape);
    if (!have) {
      steps.push({ op: "createTable", table, risk: "safe", sql: [createTableSql(table, def.documentShape)] });
      for (const o of wantObjects) steps.push({ op: "createObject", table, name: o.name, risk: "safe", sql: [o.sql] });
      continue;
    }
    const prevShape = cur.storedSchema?.tables[table]?.documentShape;
    const want = new Map(layout.columns.map((c) => [c.field, c.type]));
    const tableSteps: Step[] = [];
    let needsRebuild: string | undefined;

    // Physical columns.
    for (const [field, type] of want) {
      const actual = have.columns.get(field);
      if (actual === undefined) {
        const wasInRest = prevShape?.kind === "object" && prevShape.fields[field] !== undefined;
        if (wasInRest && have.rows > 0) {
          tableSteps.push({
            op: "moveField", table, field, risk: "backfill",
            reason: `field ${field} moves from _rest JSON to a ${type} column`,
            sql: [
              `ALTER TABLE ${q(table)} ADD COLUMN ${q(field)} ${type}`,
              `UPDATE ${q(table)} SET ${q(field)} = json_extract("_rest", ${lit("$." + field)}), "_rest" = json_remove("_rest", ${lit("$." + field)})`,
            ],
          });
        } else {
          tableSteps.push({ op: "addColumn", table, field, risk: "safe", sql: [`ALTER TABLE ${q(table)} ADD COLUMN ${q(field)} ${type}`] });
        }
      } else if (actual !== type) {
        if (have.rows === 0) needsRebuild = `column ${field} changes type ${actual} -> ${type} (table is empty)`;
        else tableSteps.push({ op: "fail", table, risk: "breaking", reason: `column ${field} changes type ${actual} -> ${type} on ${have.rows} rows: needs a data migration` });
      }
    }
    for (const [field] of have.columns) {
      if (field === "_rowid" || field === "_id" || field === "_creationTime" || field === "_rest" || want.has(field)) continue;
      const nonNull = Number(sql.all<{ n: bigint }>(`SELECT count(*) AS n FROM ${q(table)} WHERE ${q(field)} IS NOT NULL`)[0]!.n);
      const stillInSchema = def.documentShape.kind === "object" && def.documentShape.fields[field] !== undefined;
      if (nonNull > 0 && stillInSchema) {
        tableSteps.push({
          op: "moveField", table, field, risk: "backfill", reason: `field ${field} moves from its column to _rest JSON`,
          sql: [
            `UPDATE ${q(table)} SET "_rest" = json_set("_rest", ${lit("$." + field)}, ${q(field)}) WHERE ${q(field)} IS NOT NULL`,
            `ALTER TABLE ${q(table)} DROP COLUMN ${q(field)}`,
          ],
        });
      } else if (nonNull > 0) {
        tableSteps.push({ op: "fail", table, risk: "breaking", reason: `field ${field} was removed but ${nonNull} rows still have it` });
      } else {
        tableSteps.push({ op: "dropColumn", table, field, risk: "safe", sql: [`ALTER TABLE ${q(table)} DROP COLUMN ${q(field)}`] });
      }
    }
    // Fields added as optional that live in _rest need nothing at all.
    if (prevShape?.kind === "object" && def.documentShape.kind === "object") {
      for (const [field, f] of Object.entries(def.documentShape.fields)) {
        if (!prevShape.fields[field] && !want.has(field)) {
          steps.push({ op: "noop", table, field, risk: "safe", reason: `new ${f.optional ? "optional " : ""}field ${field} lives in _rest` });
        }
      }
    }

    // Logical: existing documents against the new validator.
    if (have.rows > 0 && next.schemaValidation && JSON.stringify(prevShape) !== JSON.stringify(def.documentShape)) {
      const bad = firstInvalid(sql, table, def.documentShape, have.columns, tableOfId);
      if (bad) tableSteps.push({ op: "fail", table, risk: "breaking", reason: `document ${bad.id} does not match the new schema: ${bad.message}` });
      else tableSteps.push({ op: "validateData", table, risk: "validate", checked: have.rows });
    }

    if (needsRebuild) {
      steps.push({
        op: "rebuildTable", table, risk: "safe", reason: needsRebuild,
        sql: [`DROP TABLE ${q(table)}`, createTableSql(table, def.documentShape), ...wantObjects.map((o) => o.sql)],
      });
      continue;
    }

    // Owned objects: drop changed/removed first (so dropped columns are not indexed), create after.
    const wantByName = new Map(wantObjects.map((o) => [o.name, o]));
    for (const [name, o] of have.objects) {
      const w = wantByName.get(name);
      if (!w || norm(w.sql) !== norm(o.sql)) {
        steps.push({ op: "dropObject", table, name, risk: "safe", sql: [`DROP ${o.type.toUpperCase()} IF EXISTS ${q(name)}`] });
      }
    }
    steps.push(...tableSteps);
    for (const o of wantObjects) {
      const h = have.objects.get(o.name);
      if (h && norm(h.sql) === norm(o.sql)) continue;
      const spec =
        def.indexes.find((i) => `${table}__${i.name}` === o.name) ??
        def.indexes.find((i) => o.name.startsWith(`${table}__${i.name}__`));
      const backfill = spec && spec.kind !== "db" ? (indexKind(spec.kind).backfill?.(layout, spec) ?? []) : [];
      const isRoot = !spec || spec.kind === "db" || o.name === `${table}__${spec.name}`;
      steps.push({
        op: "createObject", table, name: o.name, risk: have.rows > 0 ? "backfill" : "safe",
        sql: [o.sql, ...(isRoot && have.rows > 0 ? backfill : [])],
      });
    }
  }
  for (const [table, t] of cur.tables) {
    if (!(table in next.tables)) {
      steps.push({ op: "keepOrphanTable", table, risk: "safe", reason: `table not in schema; kept (${t.rows} rows), untyped` });
    }
  }
  return { steps, ok: !steps.some((s) => s.op === "fail") };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function firstInvalid(
  sql: Sql, table: string, shape: Shape, columns: Map<string, string>,
  tableOfId?: (id: string) => string | undefined,
): { id: string; message: string } | undefined {
  // Spike: one synchronous scan. Production: background, chunked across alarms (Convex: "inProgress").
  const fields = shape.kind === "object" ? shape.fields : {};
  for (const row of sql.all<Record<string, unknown>>(`SELECT * FROM ${q(table)}`)) {
    const doc: Record<string, unknown> = fromJson(String(row._rest));
    for (const [c] of columns) {
      if (c === "_rowid" || c === "_id" || c === "_creationTime" || c === "_rest" || row[c] === null || row[c] === undefined) continue;
      doc[c] = decodeColumn(fields[c]?.shape, row[c]);
    }
    const issues = validate(shape, doc, tableOfId);
    if (issues.length) return { id: String(row._id), message: `${issues[0]!.path}: ${issues[0]!.message}` };
  }
  return undefined;
}

/** SQLite column value -> document value, by the field's shape. */
export function decodeColumn(shape: Shape | undefined, x: unknown): unknown {
  if (x === null || x === undefined) return x;
  const kinds = shape ? (shape.kind === "union" ? shape.members : [shape]) : [];
  const isBool = kinds.some((s) => s.kind === "boolean" || (s.kind === "literal" && typeof s.value === "boolean"));
  const isInt64 = kinds.some((s) => s.kind === "int64");
  if (isBool) return x === 1n || x === 1;
  if (isInt64) return BigInt(x as any);
  if (typeof x === "bigint") return Number(x); // REAL column holding an integral value with safeIntegers
  return x;
}

export function applyPlan(sql: Sql, plan: Plan, next: SchemaJson): void {
  if (!plan.ok) {
    const reasons = plan.steps.filter((s) => s.op === "fail").map((s) => (s as { reason: string }).reason);
    throw new Error(`Schema push refused:\n  ${reasons.join("\n  ")}`);
  }
  sql.transaction(() => {
    for (const ddl of META_DDL) sql.run(ddl);
    for (const step of plan.steps) if ("sql" in step) for (const s of step.sql) sql.run(s);
    for (const table of Object.keys(next.tables)) {
      sql.run(`INSERT OR IGNORE INTO "_cfx_tables" (name, number) VALUES (?, (SELECT coalesce(max(number), 0) + 1 FROM "_cfx_tables"))`, table);
    }
    sql.run(`INSERT INTO "_cfx_schema" (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json`, JSON.stringify(next));
  });
}
