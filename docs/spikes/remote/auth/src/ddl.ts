/**
 * Turn Better Auth's merged schema (core + plugins + user additionalFields)
 * into SQLite DDL for a Durable Object.
 *
 * This is the piece our CLI would run at codegen time: it only needs the
 * BetterAuthOptions object (no database), via `getAuthTablesWithResolvedIndexes`.
 */
import type { BetterAuthOptions } from "better-auth";
import type { BetterAuthDBSchema, DBFieldAttribute } from "@better-auth/core/db";
import { getAuthTablesWithResolvedIndexes } from "@better-auth/core/db/internal";

export type ColumnSpec = {
  name: string;
  sqlType: "TEXT" | "INTEGER" | "REAL";
  notNull: boolean;
  unique: boolean;
  primaryKey?: boolean;
  references?: { table: string; column: string; onDelete: string };
};
export type TableSpec = {
  key: string; // logical Better Auth model key (e.g. "user", "member")
  name: string; // physical table name
  columns: ColumnSpec[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
};

export const usesNumericIds = (options: BetterAuthOptions) =>
  options.advanced?.database?.generateId === "serial" ||
  // deprecated alias kept by Better Auth
  (options.advanced?.database as any)?.useNumberId === true;

const sqlTypeFor = (field: DBFieldAttribute): ColumnSpec["sqlType"] => {
  const t = field.type;
  if (t === "number") return "INTEGER"; // SQLite INTEGER affinity holds floats too
  if (t === "boolean") return "INTEGER"; // 0/1 (adapter config supportsBooleans:false)
  // string, date (ISO string, supportsDates:false), json, string[], number[], enum arrays
  return "TEXT";
};

export function tableSpecs(options: BetterAuthOptions): TableSpec[] {
  const { tables, indexesByTable } = getAuthTablesWithResolvedIndexes(options);
  const numericIds = usesNumericIds(options);
  const specs: TableSpec[] = [];
  const ordered = Object.entries(tables as BetterAuthDBSchema).sort(
    ([, a], [, b]) => (a.order ?? Infinity) - (b.order ?? Infinity),
  );
  for (const [key, table] of ordered) {
    if (table.disableMigrations) continue;
    const columns: ColumnSpec[] = [
      {
        name: "id",
        sqlType: numericIds ? "INTEGER" : "TEXT",
        notNull: true,
        unique: false,
        primaryKey: true,
      },
    ];
    const indexes: TableSpec["indexes"] = [];
    for (const [fieldKey, field] of Object.entries(table.fields)) {
      const name = field.fieldName ?? fieldKey;
      if (name === "id") continue;
      let sqlType = sqlTypeFor(field);
      let references: ColumnSpec["references"];
      if (field.references) {
        const target = tables[field.references.model];
        const targetField = field.references.field;
        references = {
          table: target?.modelName ?? field.references.model,
          column: target?.fields[targetField]?.fieldName ?? targetField,
          onDelete: field.references.onDelete ?? "cascade",
        };
        if (targetField === "id" && numericIds) sqlType = "INTEGER";
      }
      columns.push({
        name,
        sqlType,
        notNull: field.required !== false,
        unique: field.unique === true,
        references,
      });
      if (field.index && !field.unique) {
        indexes.push({ name: `${table.modelName}_${name}_idx`, columns: [name], unique: false });
      }
    }
    for (const idx of indexesByTable.get(key) ?? []) {
      indexes.push({ name: idx.name, columns: [...idx.columns], unique: idx.unique === true });
    }
    specs.push({ key, name: table.modelName, columns, indexes });
  }
  return specs;
}

const q = (ident: string) => `"${ident.replaceAll('"', '""')}"`;

export function columnDDL(c: ColumnSpec, { withReferences = true } = {}) {
  let s = `${q(c.name)} ${c.sqlType}`;
  if (c.primaryKey) s += " PRIMARY KEY";
  if (c.notNull && !c.primaryKey) s += " NOT NULL";
  if (c.unique) s += " UNIQUE";
  if (withReferences && c.references) {
    s += ` REFERENCES ${q(c.references.table)}(${q(c.references.column)}) ON DELETE ${c.references.onDelete.toUpperCase()}`;
  }
  return s;
}

export function createTableDDL(t: TableSpec, opts?: { withReferences?: boolean }) {
  const cols = t.columns.map((c) => "  " + columnDDL(c, opts)).join(",\n");
  return [
    `CREATE TABLE IF NOT EXISTS ${q(t.name)} (\n${cols}\n)`,
    ...t.indexes.map(
      (i) =>
        `CREATE ${i.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${q(i.name)} ON ${q(t.name)} (${i.columns.map(q).join(", ")})`,
    ),
  ];
}

export function schemaDDL(options: BetterAuthOptions, opts?: { withReferences?: boolean }) {
  return tableSpecs(options).flatMap((t) => createTableDDL(t, opts));
}

const fkSignature = (rows: Record<string, unknown>[]) =>
  rows
    .map((r) => `${r.from}>${r.table}.${r.to}`)
    .sort()
    .join(",");

/** Minimal surface of DO `ctx.storage.sql` that we use. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): {
    toArray(): Record<string, unknown>[];
    readonly rowsWritten: number;
  };
}

/**
 * Bring the DO database in line with the schema.
 * - additive changes (new table / nullable column / index) are applied in place
 * - anything else (type change, renamed/removed NOT NULL column, id type
 *   change) requires `destructive: true` (dev/test only), which rebuilds the
 *   table. Production would instead get a generated, reviewed migration.
 */
export function migrate(
  sql: SqlLike,
  options: BetterAuthOptions,
  { destructive = false, withReferences = true } = {},
) {
  const applied: string[] = [];
  const run = (s: string) => {
    sql.exec(s);
    applied.push(s);
  };
  for (const t of tableSpecs(options)) {
    const existing = sql.exec(`PRAGMA table_info(${q(t.name)})`).toArray() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    if (existing.length === 0) {
      createTableDDL(t, { withReferences }).forEach(run);
      continue;
    }
    const byName = new Map(existing.map((c) => [c.name, c]));
    const wanted = new Map(t.columns.map((c) => [c.name, c]));
    const incompatible =
      t.columns.some((c) => {
        const e = byName.get(c.name);
        return e && (e.type.toUpperCase() !== c.sqlType || Boolean(e.notnull || e.pk) !== (c.notNull || !!c.primaryKey));
      }) ||
      existing.some((e) => !wanted.has(e.name) && e.notnull) ||
      t.columns.some((c) => !byName.has(c.name) && (c.notNull || c.unique)) ||
      fkSignature(sql.exec(`PRAGMA foreign_key_list(${q(t.name)})`).toArray()) !==
        (withReferences
          ? t.columns
              .filter((c) => c.references)
              .map((c) => `${c.name}>${c.references!.table}.${c.references!.column}`)
              .sort()
              .join(",")
          : "");
    if (incompatible) {
      if (!destructive) throw new Error(`Schema change on ${t.name} needs a manual migration`);
      run(`DROP TABLE ${q(t.name)}`);
      createTableDDL(t, { withReferences }).forEach(run);
      continue;
    }
    for (const c of t.columns) {
      if (!byName.has(c.name)) run(`ALTER TABLE ${q(t.name)} ADD COLUMN ${columnDDL(c, { withReferences })}`);
    }
    createTableDDL(t, { withReferences }).slice(1).forEach(run);
  }
  return applied;
}
