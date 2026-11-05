/**
 * Better Auth merged schema (core + plugins + additionalFields) → SQLite DDL for the `Auth` DO,
 * plus an additive migrator.
 *
 * Pure: needs only the options object (`getAuthTablesWithResolvedIndexes`, an internal Better Auth
 * entry point, hence the pinned minor version).
 */
import type { BetterAuthOptions } from "better-auth";
import type { BetterAuthDBSchema, DBFieldAttribute } from "@better-auth/core/db";
import { getAuthTablesWithResolvedIndexes } from "@better-auth/core/db/internal";

export type ColumnSpec = {
  name: string;
  /** Better Auth field key (before `fieldName` renames). */
  field: string;
  sqlType: "TEXT" | "INTEGER" | "REAL";
  /** Better Auth field type (`date`, `boolean`, `string`, ...); absent for `id`. */
  kind?: string;
  notNull: boolean;
  unique: boolean;
  primaryKey?: boolean;
  /** Literal default usable in `ALTER TABLE ADD COLUMN ... DEFAULT` (functions are not). */
  defaultLiteral?: string | number;
  references?: { table: string; column: string; onDelete: string };
};
export type TableSpec = {
  /** Logical Better Auth model key (e.g. "user", "member"). */
  key: string;
  /** Physical table name (`modelName`). */
  name: string;
  columns: ColumnSpec[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
};

export const usesNumericIds = (options: BetterAuthOptions) =>
  options.advanced?.database?.generateId === "serial" ||
  (options.advanced?.database as { useNumberId?: boolean } | undefined)?.useNumberId === true;

const sqlTypeFor = (field: DBFieldAttribute): ColumnSpec["sqlType"] => {
  if (field.type === "number") return "INTEGER"; // INTEGER affinity stores floats too
  if (field.type === "boolean") return "INTEGER"; // 0/1 (adapter: supportsBooleans false)
  return "TEXT"; // string, date (ISO), json, arrays, enums
};

const literalDefault = (field: DBFieldAttribute): string | number | undefined => {
  const d = field.defaultValue;
  if (typeof d === "boolean") return d ? 1 : 0;
  if (typeof d === "number") return d;
  if (typeof d === "string") return d;
  return undefined;
};

export function tableSpecs(options: BetterAuthOptions): TableSpec[] {
  const { tables, indexesByTable } = getAuthTablesWithResolvedIndexes(options);
  const numericIds = usesNumericIds(options);
  const specs: TableSpec[] = [];
  const ordered = Object.entries(tables as BetterAuthDBSchema).sort(
    ([, a], [, b]) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
  );
  for (const [key, table] of ordered) {
    if (table.disableMigrations) continue;
    const columns: ColumnSpec[] = [
      { name: "id", field: "id", sqlType: numericIds ? "INTEGER" : "TEXT", notNull: true, unique: false, primaryKey: true },
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
      const col: ColumnSpec = { name, field: fieldKey, sqlType, kind: String(field.type), notNull: field.required !== false, unique: field.unique === true };
      const def = literalDefault(field);
      if (def !== undefined) col.defaultLiteral = def;
      if (references) col.references = references;
      columns.push(col);
      if (field.index && !field.unique) indexes.push({ name: `${table.modelName}_${name}_idx`, columns: [name], unique: false });
    }
    for (const idx of indexesByTable.get(key) ?? []) {
      indexes.push({ name: idx.name, columns: [...idx.columns], unique: idx.unique === true });
    }
    specs.push({ key, name: table.modelName, columns, indexes });
  }
  return specs;
}

const q = (ident: string) => `"${ident.replaceAll('"', '""')}"`;
const lit = (v: string | number) => (typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`);

export type DDLOptions = { withReferences?: boolean };

export function columnDDL(c: ColumnSpec, { withReferences = true }: DDLOptions = {}) {
  let s = `${q(c.name)} ${c.sqlType}`;
  if (c.primaryKey) s += " PRIMARY KEY";
  if (c.notNull && !c.primaryKey) s += " NOT NULL";
  if (c.unique) s += " UNIQUE";
  if (withReferences && c.references) {
    s += ` REFERENCES ${q(c.references.table)}(${q(c.references.column)}) ON DELETE ${c.references.onDelete.toUpperCase()}`;
  }
  return s;
}

const indexDDL = (t: TableSpec) =>
  t.indexes.map(
    (i) => `CREATE ${i.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${q(i.name)} ON ${q(t.name)} (${i.columns.map(q).join(", ")})`,
  );

export function createTableDDL(t: TableSpec, opts?: DDLOptions) {
  const cols = t.columns.map((c) => "  " + columnDDL(c, opts)).join(",\n");
  return [`CREATE TABLE IF NOT EXISTS ${q(t.name)} (\n${cols}\n)`, ...indexDDL(t)];
}

/** Full DDL for a fresh `Auth` DO (also what the CLI writes as the baseline migration). */
export function schemaDDL(options: BetterAuthOptions, opts?: DDLOptions) {
  return tableSpecs(options).flatMap((t) => createTableDDL(t, opts));
}

/** Minimal surface of DO `ctx.storage.sql`. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export class AuthMigrationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Auth schema change needs a manual migration:\n- ${problems.join("\n- ")}`);
    this.name = "AuthMigrationError";
  }
}

export type MigrateOptions = DDLOptions & {
  /** Drop and recreate incompatible tables (tests / adapter conformance only). */
  destructive?: boolean;
};

type ColInfo = { name: string; type: string; notnull: number; pk: number };

/**
 * Plan the changes needed to bring `sql` to `options`' schema. Additive changes are returned as
 * statements; anything destructive or unsafe is reported in `problems`:
 * - column type change, or an existing NOT NULL column the schema no longer has / made optional;
 * - a new required column without a literal default on a table that already has rows;
 * - a changed foreign key.
 * Columns the schema dropped are kept (nullable leftovers are harmless). Columns added later are
 * always nullable in SQLite (ALTER TABLE cannot add NOT NULL without a default); Better Auth still
 * enforces `required` on writes. UNIQUE on an added column becomes a unique index.
 */
export function planMigration(sql: SqlLike, options: BetterAuthOptions, { withReferences = true }: DDLOptions = {}) {
  const statements: string[] = [];
  const problems: string[] = [];
  const rebuild: TableSpec[] = [];
  for (const t of tableSpecs(options)) {
    const existing = sql.exec(`PRAGMA table_info(${q(t.name)})`).toArray() as unknown as ColInfo[];
    if (existing.length === 0) {
      statements.push(...createTableDDL(t, { withReferences }));
      continue;
    }
    const tableProblems: string[] = [];
    const byName = new Map(existing.map((c) => [c.name, c]));
    const wanted = new Map(t.columns.map((c) => [c.name, c]));
    for (const c of t.columns) {
      const e = byName.get(c.name);
      if (!e) continue;
      if (e.type.toUpperCase() !== c.sqlType) tableProblems.push(`${t.name}.${c.name}: type ${e.type} -> ${c.sqlType}`);
      if (e.notnull && !c.notNull && !c.primaryKey) tableProblems.push(`${t.name}.${c.name}: NOT NULL column became optional`);
      if (Boolean(e.pk) !== Boolean(c.primaryKey)) tableProblems.push(`${t.name}.${c.name}: primary key changed`);
    }
    for (const e of existing) {
      if (!wanted.has(e.name) && e.notnull && !e.pk) tableProblems.push(`${t.name}.${e.name}: NOT NULL column removed from the schema`);
    }
    const wantFk = withReferences
      ? t.columns
          .filter((c) => c.references && byName.has(c.name))
          .map((c) => `${c.name}>${c.references!.table}.${c.references!.column}`)
          .sort()
          .join(",")
      : "";
    const haveFk = (sql.exec(`PRAGMA foreign_key_list(${q(t.name)})`).toArray() as { from: string; table: string; to: string }[])
      .map((r) => `${r.from}>${r.table}.${r.to}`)
      .sort()
      .join(",");
    if (wantFk !== haveFk) tableProblems.push(`${t.name}: foreign keys changed (${haveFk || "none"} -> ${wantFk || "none"})`);

    const added = t.columns.filter((c) => !byName.has(c.name));
    let hasRows: boolean | undefined;
    for (const c of added) {
      if (c.notNull && c.defaultLiteral === undefined) {
        hasRows ??= sql.exec(`SELECT 1 FROM ${q(t.name)} LIMIT 1`).toArray().length > 0;
        if (hasRows) tableProblems.push(`${t.name}.${c.name}: new required column without a default on a non-empty table`);
      }
    }
    if (tableProblems.length) {
      problems.push(...tableProblems);
      rebuild.push(t);
      continue;
    }
    for (const c of added) {
      let s = `ALTER TABLE ${q(t.name)} ADD COLUMN ${q(c.name)} ${c.sqlType}`;
      if (c.defaultLiteral !== undefined) s += ` DEFAULT ${lit(c.defaultLiteral)}`;
      if (withReferences && c.references) {
        s += ` REFERENCES ${q(c.references.table)}(${q(c.references.column)}) ON DELETE ${c.references.onDelete.toUpperCase()}`;
      }
      statements.push(s);
      if (c.unique) {
        statements.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(`${t.name}_${c.name}_unique`)} ON ${q(t.name)} (${q(c.name)})`);
      }
    }
    statements.push(...indexDDL(t));
  }
  return { statements, problems, rebuild };
}

/**
 * Apply the additive plan. Throws `AuthMigrationError` (and changes nothing) when the plan has
 * problems, unless `destructive` is set, which drops and recreates the offending tables.
 */
export function migrate(sql: SqlLike, options: BetterAuthOptions, { destructive = false, withReferences = true }: MigrateOptions = {}) {
  const plan = planMigration(sql, options, { withReferences });
  if (plan.problems.length && !destructive) throw new AuthMigrationError(plan.problems);
  const applied: string[] = [];
  const run = (s: string) => {
    sql.exec(s);
    applied.push(s);
  };
  for (const t of plan.rebuild) {
    run(`DROP TABLE IF EXISTS ${q(t.name)}`);
    createTableDDL(t, { withReferences }).forEach(run);
  }
  plan.statements.forEach(run);
  return applied;
}

/** Stable fingerprint of the schema, so the DO can skip PRAGMA introspection on every boot. */
export async function schemaFingerprint(options: BetterAuthOptions, opts?: DDLOptions): Promise<string> {
  const text = schemaDDL(options, opts).join(";\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Table written by the user-table triggers; read by the runtime's auth outbox (`USER_JOURNAL_TABLE`). */
export const USER_JOURNAL_TABLE = "_ember_user_journal";

/**
 * Profile-sync crash gap (PLAN §9): triggers journal every insert/update/delete of the user table in the same
 * transaction as the write, so a change whose `databaseHooks.*.after` never ran (the DO died in between) is still
 * known and recovered by the outbox alarm. Idempotent (IF NOT EXISTS).
 */
export function userJournalDDL(options: BetterAuthOptions): string[] {
  const user = tableSpecs(options).find((t) => t.key === "user");
  if (!user) return [];
  const t = q(user.name);
  const now = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
  // A delete keeps the old row (the user is gone when the alarm recovers it), shaped like the hook's argument:
  // field keys, dates as ms, booleans as JSON booleans. json_object takes at most 63 pairs.
  const value = (c: ColumnSpec) => {
    const col = `OLD.${q(c.name)}`;
    if (c.kind === "date") return `CAST((julianday(${col}) - 2440587.5) * 86400000 AS INTEGER)`;
    if (c.kind === "boolean") return `CASE WHEN ${col} IS NULL THEN NULL WHEN ${col} THEN json('true') ELSE json('false') END`;
    return col;
  };
  const old = `json_object(${user.columns.slice(0, 63).map((c) => `'${c.field.replaceAll("'", "''")}', ${value(c)}`).join(", ")})`;
  const insert = (event: string, row: "NEW" | "OLD", data: string) =>
    `INSERT INTO "${USER_JOURNAL_TABLE}" (user_id, event, at, data) VALUES (${row}.id, '${event}', ${now}, ${data})`;
  return [
    `CREATE TABLE IF NOT EXISTS "${USER_JOURNAL_TABLE}" (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL, data TEXT)`,
    `CREATE TRIGGER IF NOT EXISTS "${USER_JOURNAL_TABLE}_create" AFTER INSERT ON ${t} BEGIN ${insert("create", "NEW", "NULL")}; END`,
    `CREATE TRIGGER IF NOT EXISTS "${USER_JOURNAL_TABLE}_update" AFTER UPDATE ON ${t} BEGIN ${insert("update", "NEW", "NULL")}; END`,
    `CREATE TRIGGER IF NOT EXISTS "${USER_JOURNAL_TABLE}_delete" AFTER DELETE ON ${t} BEGIN ${insert("delete", "OLD", old)}; END`,
  ];
}
