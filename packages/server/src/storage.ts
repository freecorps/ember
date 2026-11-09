// Table storage: classic or compact (see the comment below). No imports from ddl.ts / external.ts (they use this).

import { q, type SqlRow, type SqlValue } from "./driver.ts";
import { idMicros } from "./ids.ts";

/**
 * Compact storage (the server's; local replicas stay classic). A document is ONE row written: `_rowid` is its
 * `_creationTime` in microseconds (unique per table, increasing), so `by_creation_time` is a primary-key range (its key
 * column is kept, unindexed, as the exact filter), and the id carries the rowid (ids.ts `makeIdMicros`), so `db.get`
 * is a primary-key read with no `_id` index. Tables converted from classic storage keep their older ids readable
 * through `<table>__by_id`, a unique index on `_id` that only holds rows marked `_legacy` (new rows write nothing to it).
 */
export type TableStorage = { compact: boolean; legacy: boolean };
export const CLASSIC_STORAGE: TableStorage = { compact: false, legacy: false };
/** The partial `_id` index of a table converted to compact storage (rows written before the conversion). */
export const legacyIdIndex = (table: string): string => `${table}__by_id`;
const CLASSIC_ID = /"_id"\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i;
/** Whether a user table's CREATE TABLE text is compact storage. */
export const isCompactSql = (sql: string): boolean => !CLASSIC_ID.test(sql);

/** The SQL of the legacy-id index (compact tables converted from classic ones). */
export const legacyIdIndexSql = (table: string): string =>
  `CREATE UNIQUE INDEX ${q(legacyIdIndex(table))} ON ${q(table)} ("_id") WHERE "_legacy" IS NOT NULL`;

/** Storage of an existing user table (one sqlite_master read). */
export function readStorage(exec: (sql: string, ...params: SqlValue[]) => SqlRow[], table: string): TableStorage {
  const rows = exec(`SELECT name, sql FROM sqlite_master WHERE (type = 'table' AND name = ?) OR (type = 'index' AND name = ?)`, table, legacyIdIndex(table));
  const sql = rows.find((r) => r.name === table)?.sql;
  if (typeof sql !== "string" || !isCompactSql(sql)) return CLASSIC_STORAGE;
  return { compact: true, legacy: rows.some((r) => r.name === legacyIdIndex(table)) };
}

/** The row of document `id` in `table` (classic: the `_id` index; compact: a rowid read, then the legacy index). */
export function selectById(exec: (sql: string, ...params: SqlValue[]) => SqlRow[], table: string, storage: TableStorage, id: string): SqlRow | undefined {
  if (!storage.compact) return exec(`SELECT * FROM ${q(table)} WHERE "_id" = ?`, id)[0];
  const micros = idMicros(id);
  if (micros !== undefined) {
    const row = exec(`SELECT * FROM ${q(table)} WHERE "_rowid" = ? AND "_id" = ?`, micros, id)[0];
    if (row) return row;
  }
  if (!storage.legacy) return undefined;
  return exec(`SELECT * FROM ${q(table)} INDEXED BY ${q(legacyIdIndex(table))} WHERE "_id" = ? AND "_legacy" IS NOT NULL`, id)[0];
}

