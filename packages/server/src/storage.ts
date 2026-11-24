// Table storage: classic or compact (see the comment below). No imports from ddl.ts / external.ts (they use this).

import { q, type SqlRow, type SqlValue } from "./driver.ts";
import { idMicros } from "./ids.ts";

/**
 * Compact storage (the server's; local replicas stay classic). A document is ONE row written: `_rowid` is its
 * `_creationTime` in microseconds (unique per table, increasing), so `by_creation_time` is a primary-key range (its key
 * column is kept, unindexed, as the exact filter), and the id carries the rowid (ids.ts `makeIdMicros`), so `db.get`
 * is a primary-key read with no `_id` index. Tables converted from classic storage keep their older ids readable
 * through `<table>__by_id`, a unique index on `_id` that only holds rows marked `_legacy` (new rows write nothing to it).
 *
 * Compact format 3 (`v3`): the same, without the `_k_by_creation_time` column. A row's `by_creation_time` key
 * (`[_creationTime, _id]`) is computed from those two columns when a scan needs it (query.ts `creationScan`), and the
 * scan's bounds are filtered exactly on it. Format 2 tables (with the column) keep working as they are. The table's
 * CREATE TABLE text tells them apart (the column is there or not), so nothing else records which tables are v3.
 */
export type TableStorage = { compact: boolean; legacy: boolean; v3: boolean };
export const CLASSIC_STORAGE: TableStorage = { compact: false, legacy: false, v3: false };
/**
 * `_ember_meta.storage`, compared as numbers (engine.ts `storageAhead`). "2": every classic table that can be compact
 * was converted (`migrate()` `compactTables`). "3": the same, and the shard has compact format 3 tables, written in the
 * transaction that creates the first one: a runtime that knows only "2" refuses the shard (`StorageFormatTooNew`)
 * instead of reading or writing a column that is not there. A shard that never had a format 3 table keeps "2", so
 * rolling the runtime back is refused only where it would break. A high-water mark: nothing lowers "3" (not `toClassic`
 * of the last format 3 table, not a rebuild as classic), so such a shard keeps refusing a runtime that knows only "2".
 */
export const STORAGE_FORMAT_CONVERTED = "2";
export const STORAGE_FORMAT_V3 = "3";
/** The highest `_ember_meta.storage` this runtime reads. */
export const STORAGE_FORMAT_SUPPORTED = STORAGE_FORMAT_V3;
/** The marker says the classic -> compact conversion is done (format 2 or 3). */
export const storageConverted = (stored: string | undefined): boolean => stored === STORAGE_FORMAT_CONVERTED || stored === STORAGE_FORMAT_V3;

/** The partial `_id` index of a table converted to compact storage (rows written before the conversion). */
export const legacyIdIndex = (table: string): string => `${table}__by_id`;
const CLASSIC_ID = /"_id"\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i;
/** Whether a user table's CREATE TABLE text is compact storage. */
export const isCompactSql = (sql: string): boolean => !CLASSIC_ID.test(sql);
const CREATION_KEY = /"_k_by_creation_time"\s+BLOB/i;
/** Whether a user table's CREATE TABLE text is compact storage format 3 (compact, no `_k_by_creation_time` column). */
export const isCompactV3Sql = (sql: string): boolean => isCompactSql(sql) && !CREATION_KEY.test(sql);
/** The storage a user table's CREATE TABLE text describes (`legacy`: whether its `<table>__by_id` index exists). */
export const storageOfSql = (sql: string, legacy: boolean): TableStorage =>
  isCompactSql(sql) ? { compact: true, legacy, v3: isCompactV3Sql(sql) } : CLASSIC_STORAGE;

/** The SQL of the legacy-id index (compact tables converted from classic ones). */
export const legacyIdIndexSql = (table: string): string =>
  `CREATE UNIQUE INDEX ${q(legacyIdIndex(table))} ON ${q(table)} ("_id") WHERE "_legacy" IS NOT NULL`;

/** Storage of an existing user table (one sqlite_master read). */
export function readStorage(exec: (sql: string, ...params: SqlValue[]) => SqlRow[], table: string): TableStorage {
  const rows = exec(`SELECT name, sql FROM sqlite_master WHERE (type = 'table' AND name = ?) OR (type = 'index' AND name = ?)`, table, legacyIdIndex(table));
  const sql = rows.find((r) => r.name === table)?.sql;
  if (typeof sql !== "string") return CLASSIC_STORAGE;
  return storageOfSql(sql, rows.some((r) => r.name === legacyIdIndex(table)));
}

/**
 * The row of document `id` in `table` (classic: the `_id` index; compact: a rowid read, then the legacy index).
 * `columns`: the select list (default every column; a read that only decodes the document passes its data columns,
 * so the `_k_*` index BLOBs are not copied out).
 */
export function selectById(exec: (sql: string, ...params: SqlValue[]) => SqlRow[], table: string, storage: TableStorage, id: string, columns = "*"): SqlRow | undefined {
  if (!storage.compact) return exec(`SELECT ${columns} FROM ${q(table)} WHERE "_id" = ?`, id)[0];
  const micros = idMicros(id);
  if (micros !== undefined) {
    const row = exec(`SELECT ${columns} FROM ${q(table)} WHERE "_rowid" = ? AND "_id" = ?`, micros, id)[0];
    if (row) return row;
  }
  if (!storage.legacy) return undefined;
  return exec(`SELECT ${columns} FROM ${q(table)} INDEXED BY ${q(legacyIdIndex(table))} WHERE "_id" = ? AND "_legacy" IS NOT NULL`, id)[0];
}

/**
 * The rows of documents `ids` in `table`, by id (absent = no such document): `selectById` for many ids, in one
 * statement per `chunk` ids (classic: the `_id` index; compact: rowid reads, then the legacy index for the ids left).
 * `columns` must include `"_id"`.
 */
export function selectByIds(
  exec: (sql: string, ...params: SqlValue[]) => SqlRow[],
  table: string,
  storage: TableStorage,
  ids: readonly string[],
  columns = "*",
  chunk = 90,
): Map<string, SqlRow> {
  const out = new Map<string, SqlRow>();
  const want = new Set(ids);
  const read = (sql: (marks: string) => string, values: SqlValue[]) => {
    for (let i = 0; i < values.length; i += chunk) {
      const part = values.slice(i, i + chunk);
      for (const r of exec(sql(part.map(() => "?").join(", ")), ...part)) {
        const id = r._id as string;
        if (want.has(id)) out.set(id, r);
      }
    }
  };
  if (!storage.compact) {
    read((m) => `SELECT ${columns} FROM ${q(table)} WHERE "_id" IN (${m})`, [...want]);
    return out;
  }
  const micros = [...new Set([...want].map(idMicros).filter((x): x is number => x !== undefined))];
  read((m) => `SELECT ${columns} FROM ${q(table)} WHERE "_rowid" IN (${m})`, micros);
  if (storage.legacy) {
    const left = [...want].filter((id) => !out.has(id));
    read((m) => `SELECT ${columns} FROM ${q(table)} INDEXED BY ${q(legacyIdIndex(table))} WHERE "_id" IN (${m}) AND "_legacy" IS NOT NULL`, left);
  }
  return out;
}
