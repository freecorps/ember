// Raw import (PLAN §22 L4, contracts.md "Importar do Convex"): documents written as they came, ids and
// `_creationTime` included, into tables pinned to classic storage. Admin only (the runtime's import endpoint); it
// bypasses the per-transaction limits, triggers (L2) and rate limits, but validates every document against the
// schema. Derived state is rebuilt by `finish()`: aggregates and external indexes are re-staged (the alarm's backfill
// fills them), `_files` refcounts are recounted from the documents. Search (FTS5) follows each write through its
// SQLite triggers. Also: an order-independent hash of a table's documents (`ember import verify`).

import { encodeJsonStable, validate, valueSize, type ObjectShape } from "@freecorps/ember-values";
import { aggregatesOf, AGGREGATE_KIND } from "./aggregate.ts";
import { q, type SqlDriver, type SqlRow, type SqlValue } from "./driver.ts";
import { docKey, indexFields, ownedObjects, dbIndexesOf } from "./ddl.ts";
import { EmberError } from "./errors.ts";
import { isExternalKind, outboxEnqueue } from "./external.ts";
import { collectFiles, FILES_DDL, FILES_TABLE, fileKey, shapeHasFiles } from "./files.ts";
import { FOREIGN_IDS_META, mergeForeignIds, parseForeignIds, type ForeignIds } from "./foreignIds.ts";
import { parseId } from "./ids.ts";
import type { IndexKind } from "./indexKinds.ts";
import { decodeRow, encodeFields, keyColumn, layoutOf, type Layout } from "./layout.ts";
import { classicTables, toClassic } from "./migrate.ts";
import type { SchemaManifest } from "./schema.ts";
import { sha256 } from "./sha256.ts";
import type { Doc } from "./types.ts";

/** `_ember_meta` key: tables written by import batches since the last `finish()` (JSON array). */
const TOUCHED_META = "import_touched";
/** Largest JSON parameter of one bulk statement (DO SQLite caps a value at 2 MB). */
const BULK_JSON_MAX = 900_000;

export type ImportInvalid = { index: number; id: string | null; message: string };
export type ImportBatchResult = { written: number; invalid: ImportInvalid[] };
export type ImportFileRow = { id: string; sha256: string; size: number; contentType: string | null; createdAt: number };
export type ImportFinishResult = { staged: Array<{ table: string; index: string }>; refcounts: number | null };
export type ImportHashPage = { count: number; sum: string; next: number | null };
export type ImportExportPage = { docs: unknown[]; next: number | null };
export type ImportMeta = { foreignIds: ForeignIds | null; classicTables: string[]; tables: Array<{ name: string; rows: number }>; files: number };

export interface ImporterDeps {
  driver: SqlDriver;
  manifest: SchemaManifest;
  kinds: ReadonlyMap<string, IndexKind>;
  documentSize: number;
  shard: () => string | null | undefined;
  /** The engine's `tableOfId` (Ember prefixes, then the foreign map). */
  tableOfId: (id: string) => string | undefined;
  ensureMigrated: () => void;
  /** Re-reads storage, staged windows and the foreign map after a call changed them. */
  refresh: () => void;
}

// ------------------------------------------------------------------------------------------------ hashing

const MOD = 1n << 128n;

/** SHA-256 of a document's canonical JSON (`encodeJsonStable`: sorted keys, tagged bigint/bytes). */
export function docDigest(doc: Record<string, unknown>): Uint8Array {
  return sha256(new TextEncoder().encode(encodeJsonStable(doc)));
}

/**
 * Order-independent hash of a set of documents: the sum, mod 2^128, of the first 16 bytes of each digest (a sum, not
 * a XOR: two copies of a document do not cancel out). The shard and `ember import verify` compute the same one.
 */
export class DocSetHash {
  count = 0;
  private acc = 0n;
  add(doc: Record<string, unknown>): void {
    const d = docDigest(doc);
    let x = 0n;
    for (let i = 0; i < 16; i++) x = (x << 8n) | BigInt(d[i]!);
    this.acc = (this.acc + x) % MOD;
    this.count++;
  }
  /** Adds a partial hash (`{ count, sum }` of another page). */
  merge(p: { count: number; sum: string }): void {
    this.acc = (this.acc + BigInt(`0x${p.sum}`)) % MOD;
    this.count += p.count;
  }
  get sum(): string {
    return this.acc.toString(16).padStart(32, "0");
  }
}

/** What `ember import verify` hashes for a `_storage` entry (the shard: from `_files`). */
export const storageDigestDoc = (r: { id: string; sha256: string | null; size: number | null; contentType: string | null }) => ({
  _id: r.id,
  sha256: r.sha256,
  size: r.size,
  contentType: r.contentType,
});

// ------------------------------------------------------------------------------------------------ importer

/**
 * An imported document as the shard writes it, or why it is refused. The one check of the import: the shard runs it
 * on every document, `ember import convex --dry-run` and `ember import verify` on the documents they recompute.
 */
export function checkImportDoc(
  table: string,
  shape: ObjectShape,
  raw: unknown,
  o: { tableOfId: (id: string) => string | undefined; documentSize: number },
): Doc | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "expected a document object";
  const { _id: id, _creationTime: ct, ...rest } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !id) return "_id must be a string";
  const owner = o.tableOfId(id);
  if (owner !== table) {
    return parseId(id) || owner
      ? `_id ${id} is an id of ${owner ?? "another table"}, not ${table}`
      : `_id ${id} is not an Ember id nor a foreign id of an imported table (missing from the table-number map?)`;
  }
  if (typeof ct !== "number" || !Number.isFinite(ct) || ct < 0) return "_creationTime must be a finite number of ms";
  for (const k of Object.keys(rest)) if (k.startsWith("_")) return `system field ${k} cannot be imported`;
  const r = validate(shape, rest, { tableOfId: o.tableOfId });
  if (!r.ok) return `${r.path}: ${r.message}`;
  const size = valueSize(rest);
  if (size > o.documentSize) return `document is ${size} bytes (limit ${o.documentSize})`;
  const doc: Record<string, unknown> = { _id: id, _creationTime: ct };
  for (const f of Object.keys(shape.fields)) if (rest[f] !== undefined) doc[f] = rest[f];
  return doc as Doc;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export class Importer {
  constructor(private readonly d: ImporterDeps) {}

  private rows(sql: string, ...p: SqlValue[]): SqlRow[] {
    return this.d.driver.exec(sql, ...p).rows;
  }

  private meta(key: string): string | undefined {
    const v = this.rows(`SELECT value FROM "_ember_meta" WHERE key = ?`, key)[0]?.value;
    return typeof v === "string" ? v : undefined;
  }

  private setMeta(key: string, value: string): void {
    this.d.driver.exec(`INSERT INTO "_ember_meta" ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`, key, value);
  }

  private appTable(table: string) {
    const t = this.d.manifest.tables[table];
    if (!t || table.includes("$")) throw new EmberError("ValidationError", `Unknown table ${JSON.stringify(table)} (only app tables are imported)`);
    return t;
  }

  /** The foreign-id map of this shard. */
  foreignIds(): ForeignIds | undefined {
    this.d.ensureMigrated();
    return parseForeignIds(this.meta(FOREIGN_IDS_META));
  }

  /**
   * Prepares `tables` for documents with foreign ids: merges the table-number map (a number that names another table
   * already → `ImportConflict`) and converts each table to classic storage, pinned there. Idempotent.
   */
  begin(o: { foreignIds?: ForeignIds; tables: string[] }): { converted: string[] } {
    this.d.ensureMigrated();
    for (const t of o.tables) this.appTable(t);
    const converted = this.d.driver.transaction(() => {
      if (o.foreignIds) {
        const { merged, conflicts } = mergeForeignIds(parseForeignIds(this.meta(FOREIGN_IDS_META)), o.foreignIds);
        if (conflicts.length) throw new EmberError("ImportConflict", `This shard has foreign ids of another source: ${conflicts.join("; ")}`, { conflicts });
        for (const name of Object.values(merged.convex ?? {})) this.appTable(name);
        this.setMeta(FOREIGN_IDS_META, JSON.stringify(merged));
      }
      return o.tables.filter((t) => toClassic(this.d.driver, t, this.d.manifest.tables[t]!, this.d.kinds));
    });
    this.d.refresh();
    return { converted };
  }

  /**
   * Upserts documents into `table` (begun). Each one needs `_id` (an id of this table: Ember prefix or an imported
   * table number) and `_creationTime`; fields are validated against the schema. Invalid documents are reported and
   * skipped, unless `strict` (then nothing is written and `ValidationError` lists them).
   */
  documents(table: string, docs: unknown[], o: { strict?: boolean } = {}): ImportBatchResult {
    this.d.ensureMigrated();
    const t = this.appTable(table);
    if (!classicTables(this.d.driver).has(table)) throw new EmberError("ImportNotBegun", `Table ${table} was not prepared for import (call import begin first)`);
    const layout = layoutOf(table, t.document);
    const keys = dbIndexesOf(t).map((i) => ({ column: keyColumn(i.name), fields: indexFields(t, i.name)! }));
    const invalid: ImportInvalid[] = [];
    const good: Doc[] = [];
    docs.forEach((raw, index) => {
      const r = checkImportDoc(table, layout.document, raw, this.d);
      if (typeof r === "string") {
        const id = raw && typeof raw === "object" && typeof (raw as { _id?: unknown })._id === "string" ? ((raw as { _id: string })._id) : null;
        invalid.push({ index, id, message: r });
      } else good.push(r);
    });
    if (invalid.length && o.strict) {
      throw new EmberError("ValidationError", `${invalid.length} invalid document(s) for ${table}: ${invalid[0]!.message}`, { invalid: invalid.slice(0, 100) });
    }
    if (good.length) {
      this.d.driver.transaction(() => {
        this.upsert(table, layout, keys, good);
        this.touch(table);
      });
    }
    return { written: good.length, invalid };
  }

  /** Deletes documents by id (delta mode). Derived state follows at `finish()`. */
  delete(table: string, ids: string[]): { deleted: number } {
    this.d.ensureMigrated();
    const t = this.appTable(table);
    if (!classicTables(this.d.driver).has(table)) throw new EmberError("ImportNotBegun", `Table ${table} was not prepared for import (call import begin first)`);
    const list = ids.filter((x) => typeof x === "string");
    if (!list.length) return { deleted: 0 };
    return this.d.driver.transaction(() => {
      let deleted = 0;
      for (const chunk of jsonChunks(list.map((x) => JSON.stringify(x)))) {
        const r = this.rows(`DELETE FROM ${q(table)} WHERE "_id" IN (SELECT value FROM json_each(?)) RETURNING "_id"`, chunk);
        deleted += r.length;
        // External indexes (Vectorize, AI Search) drop a document their delivery no longer finds.
        for (const spec of t.indexes) if (isExternalKind(this.d.kinds.get(spec.kind))) for (const x of r) outboxEnqueue((s, ...p) => this.d.driver.exec(s, ...p), table, spec.name, String(x._id));
      }
      this.touch(table);
      return { deleted };
    });
  }

  /**
   * `_files` rows for imported storage entries, keeping the original storage id: ready, content at the shard's
   * content-addressed key (the bytes are put there by the caller). Refcounts are recounted by `finish()`; a row no
   * document references is kept (as in the source, until `ctx.storage.delete`), not collected.
   */
  files(rows: ImportFileRow[]): { written: number } {
    this.d.ensureMigrated();
    const shard = this.d.shard();
    if (!shard) throw new EmberError("StorageError", "import files: the shard name is unknown");
    for (const s of FILES_DDL) this.d.driver.exec(s);
    return this.d.driver.transaction(() => {
      let written = 0;
      for (const r of rows) {
        if (typeof r.id !== "string" || !r.id || !/^[0-9a-f]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.size) || r.size < 0) {
          throw new EmberError("ValidationError", `Invalid file row ${JSON.stringify(r.id)} (needs id, hex sha256, size)`);
        }
        const at = Math.floor(Number.isFinite(r.createdAt) ? r.createdAt : Date.now());
        const token = hex(crypto.getRandomValues(new Uint8Array(24)));
        this.d.driver.exec(
          `INSERT INTO ${q(FILES_TABLE)} ("id", "sha256", "size", "content_type", "refcount", "state", "key", "etag", "token", "multipart", "created_at", "updated_at", "zero_since") ` +
            `VALUES (?, ?, ?, ?, 0, 'ready', ?, NULL, ?, 0, ?, ?, NULL) ON CONFLICT ("id") DO UPDATE SET "sha256" = excluded."sha256", "size" = excluded."size", ` +
            `"content_type" = excluded."content_type", "state" = 'ready', "key" = excluded."key", "updated_at" = excluded."updated_at"`,
          r.id, r.sha256, r.size, r.contentType ?? null, fileKey(shard, r.sha256), token, at, Date.now(),
        );
        written++;
      }
      this.touch(FILES_TABLE);
      return { written };
    });
  }

  /**
   * After the batches: re-stages the aggregates and external indexes of the tables written since the last call (the
   * backfill refills them) and, when documents with files or `_files` rows changed, recounts every refcount.
   */
  finish(): ImportFinishResult {
    this.d.ensureMigrated();
    const touched = this.touched();
    const out = this.d.driver.transaction(() => {
      const staged: ImportFinishResult["staged"] = [];
      let files = touched.has(FILES_TABLE);
      for (const table of touched) {
        const t = this.d.manifest.tables[table];
        if (!t) continue;
        if (shapeHasFiles(t.document)) files = true;
        const layout = layoutOf(table, t.document);
        const until = Number(this.rows(`SELECT coalesce(max("_rowid"), 0) AS m FROM ${q(table)}`)[0]!.m);
        const aggs = new Set(aggregatesOf(t).map((a) => a.name));
        for (const { index, objects } of ownedObjects(table, t, this.d.kinds, layout, false)) {
          const external = isExternalKind(this.d.kinds.get(index.kind));
          if (!(index.kind === AGGREGATE_KIND && aggs.has(index.name)) && !external) continue;
          // Cleared and re-created: the backfill adds every row once.
          for (const o of [...objects].reverse()) this.d.driver.exec(`DROP ${o.type.toUpperCase()} IF EXISTS ${q(o.name)}`);
          for (const o of objects) this.d.driver.exec(o.sql);
          this.d.driver.exec(
            `INSERT INTO "_ember_indexes" ("tbl", "name", "kind", "cursor", "until") VALUES (?, ?, ?, 0, ?) ON CONFLICT ("tbl", "name") DO UPDATE SET "kind" = excluded."kind", "cursor" = 0, "until" = excluded."until"`,
            table, index.name, index.kind, until,
          );
          staged.push({ table, index: index.name });
        }
      }
      const refcounts = files ? this.recount() : null;
      this.d.driver.exec(`DELETE FROM "_ember_meta" WHERE key = ?`, TOUCHED_META);
      return { staged, refcounts };
    });
    this.d.refresh();
    return out;
  }

  /** One page (by `_rowid`) of the order-independent hash of `table`'s documents; `_storage`: the `_files` rows. */
  hash(table: string, after: number, limit = 1000): ImportHashPage {
    this.d.ensureMigrated();
    const h = new DocSetHash();
    const n = Math.max(1, Math.min(5000, Math.floor(limit)));
    if (table === "_storage") {
      for (const s of FILES_DDL) this.d.driver.exec(s);
      const rs = this.rows(`SELECT "rowid" AS r, "id", "sha256", "size", "content_type" FROM ${q(FILES_TABLE)} WHERE "rowid" > ? AND "state" = 'ready' ORDER BY "rowid" LIMIT ?`, after, n);
      for (const r of rs) h.add(storageDigestDoc({ id: String(r.id), sha256: (r.sha256 as string | null) ?? null, size: r.size === null ? null : Number(r.size), contentType: (r.content_type as string | null) ?? null }));
      return { count: h.count, sum: h.sum, next: rs.length === n ? Number(rs[rs.length - 1]!.r) : null };
    }
    const t = this.appTable(table);
    const layout = layoutOf(table, t.document);
    const rs = this.rows(`SELECT * FROM ${q(table)} WHERE "_rowid" > ? ORDER BY "_rowid" LIMIT ?`, after, n);
    for (const r of rs) h.add(decodeRow(layout, r));
    return { count: h.count, sum: h.sum, next: rs.length === n ? Number(rs[rs.length - 1]!._rowid) : null };
  }

  /** What `ember export` needs to know about the shard: the foreign-id map, pinned tables, row counts. */
  describe(): ImportMeta {
    this.d.ensureMigrated();
    for (const s of FILES_DDL) this.d.driver.exec(s);
    const have = new Set(this.rows(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => String(r.name)));
    const tables = Object.keys(this.d.manifest.tables)
      .filter((t) => !t.includes("$") && have.has(t))
      .sort()
      .map((name) => ({ name, rows: Number(this.rows(`SELECT count(*) AS n FROM ${q(name)}`)[0]!.n) }));
    const files = Number(this.rows(`SELECT count(*) AS n FROM ${q(FILES_TABLE)} WHERE "state" = 'ready'`)[0]!.n);
    return { foreignIds: parseForeignIds(this.meta(FOREIGN_IDS_META)) ?? null, classicTables: [...classicTables(this.d.driver)].sort(), tables, files };
  }

  /**
   * One page (by `_rowid`) of `table`'s documents as stored (`ember export`); `_storage`: the ready `_files` rows as
   * `{ id, sha256, size, contentType, createdAt }` (the shape `files()` takes back).
   */
  page(table: string, after: number, limit = 500): ImportExportPage {
    this.d.ensureMigrated();
    const n = Math.max(1, Math.min(2000, Math.floor(limit)));
    if (table === "_storage") {
      for (const s of FILES_DDL) this.d.driver.exec(s);
      const rs = this.rows(`SELECT "rowid" AS r, "id", "sha256", "size", "content_type", "created_at" FROM ${q(FILES_TABLE)} WHERE "rowid" > ? AND "state" = 'ready' ORDER BY "rowid" LIMIT ?`, after, n);
      const docs = rs.map((r) => ({ id: String(r.id), sha256: (r.sha256 as string | null) ?? null, size: r.size === null ? null : Number(r.size), contentType: (r.content_type as string | null) ?? null, createdAt: Number(r.created_at) }));
      return { docs, next: rs.length === n ? Number(rs[rs.length - 1]!.r) : null };
    }
    const t = this.appTable(table);
    const layout = layoutOf(table, t.document);
    const rs = this.rows(`SELECT * FROM ${q(table)} WHERE "_rowid" > ? ORDER BY "_rowid" LIMIT ?`, after, n);
    return { docs: rs.map((r) => decodeRow(layout, r)), next: rs.length === n ? Number(rs[rs.length - 1]!._rowid) : null };
  }

  // ---------------------------------------------------------------------------------------------- internals

  private touched(): Set<string> {
    try {
      const x = JSON.parse(this.meta(TOUCHED_META) ?? "[]") as unknown;
      return new Set(Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
    } catch {
      return new Set();
    }
  }

  private touch(table: string): void {
    const all = this.touched();
    if (all.has(table)) return;
    all.add(table);
    this.setMeta(TOUCHED_META, JSON.stringify([...all].sort()));
  }

  /** Bulk upsert through `json_each(?)` (one bound JSON array per statement), exact for floats (checked back). */
  private upsert(table: string, layout: Layout, keys: Array<{ column: string; fields: string[] }>, docs: Doc[]): void {
    const cols = ["_id", "_creationTime", ...layout.columns.map((c) => c.field), "_json", ...keys.map((k) => k.column)];
    const blob = new Set([...layout.columns.filter((c) => c.spec.sqlType === "BLOB").map((c) => c.field), ...keys.map((k) => k.column)]);
    const real = ["_creationTime", ...layout.columns.filter((c) => c.spec.sqlType === "REAL").map((c) => c.field)];
    const encoded = docs.map((doc) => {
      const f = encodeFields(layout, doc);
      const values: SqlValue[] = cols.map((c) => (c === "_id" ? doc._id : c === "_creationTime" ? doc._creationTime + 0 : c in f ? f[c]! : null));
      keys.forEach((k, i) => (values[cols.length - keys.length + i] = docKey(doc, k.fields)));
      // Non-finite numbers and -0 never reach a column (they escape to `_json`), so every value has a JSON form.
      return { values, json: JSON.stringify(values.map((x) => (x instanceof Uint8Array ? hex(x) : x))) };
    });
    const select = cols.map((c, i) => (blob.has(c) ? `unhex(json_extract(value, '$[${i}]'))` : `json_extract(value, '$[${i}]')`)).join(", ");
    const set = cols.filter((c) => c !== "_id").map((c) => `${q(c)} = excluded.${q(c)}`).join(", ");
    const bulk = `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) SELECT ${select} FROM json_each(?) WHERE true ON CONFLICT ("_id") DO UPDATE SET ${set}`;
    for (const chunk of jsonChunks(encoded.map((e) => e.json))) this.d.driver.exec(bulk, chunk);
    // Floats: SQLite parses the JSON text itself; a value that did not round-trip bit for bit is rewritten bound.
    const byId = new Map(encoded.map((e) => [e.values[0] as string, e.values]));
    for (const chunk of jsonChunks([...byId.keys()].map((x) => JSON.stringify(x)))) {
      const got = this.rows(`SELECT "_rowid", "_id", ${real.map(q).join(", ")} FROM ${q(table)} WHERE "_id" IN (SELECT value FROM json_each(?))`, chunk);
      for (const g of got) {
        const values = byId.get(String(g._id))!;
        const fix: Array<[string, SqlValue]> = [];
        for (const c of real) {
          const want = values[cols.indexOf(c)]!;
          if (want !== null && !Object.is(g[c], want)) fix.push([c, want]);
        }
        if (fix.length) this.d.driver.exec(`UPDATE ${q(table)} SET ${fix.map(([c]) => `${q(c)} = ?`).join(", ")} WHERE "_rowid" = ?`, ...fix.map(([, x]) => x), Number(g._rowid));
      }
    }
  }

  /** Every `_files` refcount from the documents of every table with file fields (the whole truth of the shard). */
  private recount(): number {
    const counts = new Map<string, number>();
    for (const [table, t] of Object.entries(this.d.manifest.tables)) {
      if (!shapeHasFiles(t.document)) continue;
      const exists = this.rows(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, table).length > 0;
      if (!exists) continue;
      const layout = layoutOf(table, t.document);
      let after = -Number.MAX_SAFE_INTEGER;
      for (;;) {
        const rs = this.rows(`SELECT * FROM ${q(table)} WHERE "_rowid" > ? ORDER BY "_rowid" LIMIT 1000`, after);
        for (const r of rs) for (const id of collectFiles(t.document, decodeRow(layout, r))) counts.set(id, (counts.get(id) ?? 0) + 1);
        if (rs.length < 1000) break;
        after = Number(rs[rs.length - 1]!._rowid);
      }
    }
    const now = Date.now();
    // Rows that lose every reference here start the GC grace period; imported rows never referenced stay kept.
    this.d.driver.exec(
      `UPDATE ${q(FILES_TABLE)} SET "zero_since" = CASE WHEN "refcount" > 0 THEN ? ELSE "zero_since" END, "refcount" = 0 WHERE "refcount" != 0`,
      now,
    );
    for (const chunk of jsonChunks([...counts].map(([id, n]) => JSON.stringify([id, n])))) {
      this.d.driver.exec(
        `UPDATE ${q(FILES_TABLE)} SET "refcount" = (SELECT json_extract(value, '$[1]') FROM json_each(?1) WHERE json_extract(value, '$[0]') = ${q(FILES_TABLE)}."id"), "zero_since" = NULL ` +
          `WHERE "id" IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))`,
        chunk,
      );
    }
    return counts.size;
  }
}

/** JSON array texts of at most ~BULK_JSON_MAX characters from already-encoded items. */
function* jsonChunks(items: string[]): Generator<string> {
  let cur: string[] = [];
  let size = 2;
  for (const x of items) {
    if (cur.length && size + x.length + 1 > BULK_JSON_MAX) {
      yield `[${cur.join(",")}]`;
      cur = [];
      size = 2;
    }
    cur.push(x);
    size += x.length + 1;
  }
  if (cur.length) yield `[${cur.join(",")}]`;
}
