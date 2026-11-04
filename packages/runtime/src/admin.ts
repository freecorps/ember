// Read-only data browser for `GET /api/_ember/data` (admin token; PLAN §11 `ember data`, §21 dashboard).
// Pages by `_rowid` (every Ember table has it); schema tables are decoded to documents, internal tables (`_jobs`,
// `_files`, ...) come back as raw rows. Index key BLOB columns are never returned.

import { decodeRow, layoutOf } from "@ember/server";
import type { SchemaManifest, SqlDriver, SqlValue } from "./engine-types.ts";

export const BROWSE_MAX_LIMIT = 200;
export const BROWSE_DEFAULT_LIMIT = 50;

/** Internal tables the browser may show (raw rows). */
export const BROWSABLE_INTERNAL = ["_jobs", "_files", "_ember_migrations", "_ember_bookmarks"] as const;

export interface TableInfo {
  name: string;
  rows: number;
  /** "schema" (decoded documents) or "internal" (raw rows). */
  kind: "schema" | "internal";
}

export type BrowseResult =
  | { ok: true; tables: TableInfo[] }
  | { ok: true; table: string; kind: "schema" | "internal"; rows: unknown[]; cursor: string | null; done: boolean }
  | { ok: false; error: { code: string; message: string } };

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

function existing(driver: SqlDriver): Set<string> {
  return new Set(driver.exec("SELECT name FROM sqlite_master WHERE type = 'table'").rows.map((r) => String(r.name)));
}

export function browse(driver: SqlDriver, manifest: SchemaManifest, table: string | null, cursor: string | null, limit = BROWSE_DEFAULT_LIMIT): BrowseResult {
  const have = existing(driver);
  if (table === null) {
    const tables: TableInfo[] = [];
    for (const name of Object.keys(manifest.tables).sort()) {
      if (!have.has(name)) continue;
      tables.push({ name, kind: "schema", rows: Number(driver.exec(`SELECT COUNT(*) AS n FROM ${q(name)}`).rows[0]?.n ?? 0) });
    }
    for (const name of BROWSABLE_INTERNAL) {
      if (have.has(name)) tables.push({ name, kind: "internal", rows: Number(driver.exec(`SELECT COUNT(*) AS n FROM ${q(name)}`).rows[0]?.n ?? 0) });
    }
    return { ok: true, tables };
  }
  const t = manifest.tables[table];
  const internal = (BROWSABLE_INTERNAL as readonly string[]).includes(table);
  if ((!t && !internal) || !have.has(table)) return { ok: false, error: { code: "not_found", message: `unknown table ${JSON.stringify(table)}` } };
  const n = Math.max(1, Math.min(BROWSE_MAX_LIMIT, Math.floor(limit) || BROWSE_DEFAULT_LIMIT));
  const after = cursor === null || cursor === "" ? 0 : Number(cursor);
  if (!Number.isSafeInteger(after) || after < 0) return { ok: false, error: { code: "bad_cursor", message: "invalid cursor" } };
  // `_rowid` on schema tables; SQLite's implicit rowid on the internal ones.
  const key = t ? "_rowid" : "rowid";
  const res = driver.exec(`SELECT ${key} AS __cursor, * FROM ${q(table)} WHERE ${key} > ? ORDER BY ${key} LIMIT ?`, after, n + 1);
  const page = res.rows.slice(0, n);
  const done = res.rows.length <= n;
  const layout = t ? layoutOf(table, t.document) : null;
  const rows = page.map((r) => {
    const { __cursor: _c, ...row } = r;
    if (layout) return decodeRow(layout, row as Record<string, SqlValue>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (!k.startsWith("_k_")) out[k] = v instanceof Uint8Array ? `<${v.byteLength} bytes>` : v;
    return out;
  });
  const last = page[page.length - 1];
  return { ok: true, table, kind: t ? "schema" : "internal", rows, cursor: done || !last ? null : String(last.__cursor), done };
}
