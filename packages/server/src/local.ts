// Offline / local query execution (PLAN §10 "Offline completo"). An offline client keeps a replica of the rows its
// queries returned (same documents, same encoded index keys) and runs *explicitly registered* queries against it
// with the same `QueryImpl` as the engine: same index ranges, filters, order, pagination cursors and read sets.
//
// - `runLocalQuery` runs one query handler over a `LocalReader` (sync). The reader is the storage seam:
//   `sqlLocalReader` (local SQLite: expo-sqlite, node:sqlite in tests) uses the server's SQL; the IndexedDB
//   adapter (in @freecorps/ember-offline) answers the same `scan(index, [lo, hi))` with an IDBKeyRange.
// - Only pure database reads run locally: `ctx.db.get/query/normalizeId` and plugin index queries the reader
//   supports (FTS5 search on SQLite, `jsSearch` elsewhere). `ctx.db.aggregate`, `ctx.db.sql` and `ctx.storage`
//   throw `OfflineUnsupported` (the replica has no aggregates, no `_files`, and a partial row set).
// - `prepareLocalDatabase` / `sqlReplicaWriter` give a local SQLite the server's DDL (tables, key columns, FTS5
//   with `unicode61 remove_diacritics 2`) and write replicated documents with the server's row codec.

import {
  compareValues,
  isPlainObject,
  validate,
  type ObjectShape,
} from "@freecorps/ember-values";
import { q, type SqlDriver, type SqlRow, type SqlValue } from "./driver.ts";
import { docKey, dbIndexesOf, indexFields } from "./ddl.ts";
import { EmberError } from "./errors.ts";
import { flattenFunctions, isRegisteredFunction, type AnyRegisteredFunction } from "./functions.ts";
import { parseId } from "./ids.ts";
import type { IndexKind } from "./indexKinds.ts";
import { decodeRow, encodeFields, fieldOf, keyColumn, layoutOf } from "./layout.ts";
import { applyMigration, backfillStep, planMigration, storedVersion } from "./migrate.ts";
import { QueryImpl, sqlPluginQuery, sqlScan, type QueryEnv, type ScannedRow, type TableRuntime } from "./query.ts";
import type { SchemaManifest } from "./schema.ts";
import { searchIndexKind, tokenize } from "./search.ts";
import { aggregateKind } from "./aggregate.ts";
import { vectorIndexKind } from "./vector.ts";
import { aiSearchIndexKind } from "./aiSearch.ts";
import { isExternalKind } from "./external.ts";
import type { Doc, Identity, IndexSpec, ReadSet } from "./types.ts";

/** What local execution needs from a schema (a `SchemaDefinition` satisfies it). */
export type LocalSchema = { manifest: SchemaManifest; indexKinds: ReadonlyMap<string, IndexKind> };

/**
 * A `LocalSchema` from a manifest JSON (`ember/_generated/manifest.json` → `.schema`), for clients that do not
 * import `ember/schema.ts`. Search and aggregates are built in; pass other index-kind plugins the schema uses.
 */
export function localSchema(manifest: SchemaManifest, indexKinds: IndexKind[] = []): LocalSchema {
  const kinds = new Map<string, IndexKind>();
  for (const k of [searchIndexKind as IndexKind, aggregateKind as IndexKind, vectorIndexKind as IndexKind, aiSearchIndexKind as IndexKind, ...indexKinds]) kinds.set(k.kind, k);
  return { manifest, indexKinds: kinds };
}

/**
 * Synchronous reads of one shard's replica. An async store (IndexedDB) serves reads from what it has fetched and
 * throws (or records a miss) for the rest; its caller fetches and re-runs the query (see @freecorps/ember-offline).
 */
export interface LocalReader {
  /** Rows of db index `index` with key in `[lo, hi)`, in key order (descending when `!asc`), at most `limit`. */
  scan(table: string, index: string, lo: Uint8Array, hi: Uint8Array, asc: boolean, limit: number): ScannedRow[];
  get(table: string, id: string): Doc | null;
  /** Plugin index queries (search). Omitted → `OfflineUnsupported`. */
  pluginQuery?(table: string, kind: IndexKind, spec: IndexSpec, arg: unknown): { docs: Doc[]; data?: unknown };
}

export type LocalQueryOptions = {
  schema: LocalSchema;
  reader: LocalReader;
  /** Who the query runs as (decoded from the last known token; not verified: the data is local anyway). */
  identity?: Identity | null;
  now?: number;
  /** Rows read per run (default 16 384, like the server). */
  rowsRead?: number;
};

export const OFFLINE_UNSUPPORTED = "OfflineUnsupported" as const;
const unsupported = (what: string) => new EmberError(OFFLINE_UNSUPPORTED, `${what} is not available in queries run offline`);

const tableRuntimes = new WeakMap<SchemaManifest, { tables: Map<string, TableRuntime>; prefixes: Map<string, string> }>();

function runtimesOf(m: SchemaManifest) {
  let r = tableRuntimes.get(m);
  if (!r) {
    const tables = new Map<string, TableRuntime>();
    const prefixes = new Map<string, string>();
    for (const [name, t] of Object.entries(m.tables)) {
      const layout = layoutOf(name, t.document);
      tables.set(name, { name, manifest: t, layout, decode: (row: SqlRow) => decodeRow(layout, row) });
      prefixes.set(t.idPrefix, name);
    }
    r = { tables, prefixes };
    tableRuntimes.set(m, r);
  }
  return r;
}

/** The table an id belongs to in this schema, or undefined. */
export function localTableOfId(m: SchemaManifest, id: unknown): string | undefined {
  const p = parseId(id);
  return p ? runtimesOf(m).prefixes.get(p.prefix) : undefined;
}

/**
 * A locally runnable query: a public `query(...)` definition (the same object the server registers). Mutations,
 * actions and internal functions are refused: only pure db-read queries run on the client.
 */
export function assertLocalQuery(name: string, fn: unknown): asserts fn is AnyRegisteredFunction {
  if (!isRegisteredFunction(fn) || fn.type !== "query") throw new EmberError("InvalidFunction", `${name}: only query() definitions can run offline`);
  if ((fn as AnyRegisteredFunction).visibility !== "public") throw new EmberError("InvalidFunction", `${name}: internal queries cannot run offline`);
}

/** `{ "mod:fn": query }` or modules `{ mod: { fn: query } }` → name → query, checked with `assertLocalQuery`. */
export function localQueryRegistry(queries: unknown): Map<string, AnyRegisteredFunction> {
  const out = new Map<string, AnyRegisteredFunction>();
  for (const [name, fn] of flattenFunctions(queries ?? {})) {
    assertLocalQuery(name, fn);
    out.set(name, fn);
  }
  return out;
}

/** Runs a registered query handler over a replica. Synchronous; throws like `engine.runQuery`. */
export function runLocalQuery(fn: AnyRegisteredFunction, args: unknown, o: LocalQueryOptions): { value: unknown; readSet: ReadSet } {
  assertLocalQuery("(local)", fn);
  const m = o.schema.manifest;
  const { tables } = runtimesOf(m);
  const tableOfId = (id: string) => localTableOfId(m, id);
  const a = args ?? {};
  const ra = validate(fn.args, a, { tableOfId });
  if (!ra.ok) throw new EmberError("ValidationError", `Invalid arguments: ${ra.path}: ${ra.message}`, { path: ra.path });

  const limit = o.rowsRead ?? 16_384;
  let read = 0;
  const count = (n: number) => {
    read += n;
    if (read > limit) throw new EmberError("TooManyReads", `Too many rows read in one transaction (limit ${limit})`);
  };
  const table = (name: string) => {
    const t = tables.get(name);
    if (!t) throw new EmberError("ValidationError", `Unknown table ${JSON.stringify(name)}`);
    return t;
  };
  const readSet: ReadSet = [];
  const getById = (id: string): Doc | null => {
    if (typeof id !== "string") throw new EmberError("ValidationError", "db.get() needs an id string");
    const t = tableOfId(id);
    if (!t) return null;
    const doc = o.reader.get(t, id);
    count(doc ? 1 : 0);
    return doc;
  };
  const env: QueryEnv = {
    scan: (t, index, lo, hi, asc, n) => {
      const rows = o.reader.scan(t.name, index, lo, hi, asc, n);
      count(rows.length);
      return rows;
    },
    pluginQuery: (kind, t, spec, arg) => {
      if (!o.reader.pluginQuery) throw unsupported(`${kind.kind} index ${t.name}.${spec.name}`);
      const out = o.reader.pluginQuery(t.name, kind, spec, arg);
      count(out.docs.length);
      return out;
    },
    table,
    readSet,
    isStaged: () => false,
    kinds: o.schema.indexKinds,
    getById,
  };
  const db = {
    get: getById,
    query: (name: string) => new QueryImpl(env, table(name)),
    normalizeId: (name: string, id: string) => (tableOfId(id) === name ? id : null),
    aggregate: () => {
      throw unsupported("ctx.db.aggregate");
    },
    sql: () => {
      throw unsupported("ctx.db.sql");
    },
  };
  const storage = {
    getUrl: () => {
      throw unsupported("ctx.storage");
    },
    getMetadata: () => {
      throw unsupported("ctx.storage");
    },
  };
  const identity = o.identity ?? null;
  const value = fn.handler({ db, auth: { getUserIdentity: () => identity }, now: o.now ?? Date.now(), storage }, a);
  if (value && typeof (value as PromiseLike<unknown>).then === "function") {
    Promise.resolve(value).catch(() => {});
    throw new EmberError("AsyncHandler", "query handlers must be synchronous");
  }
  if (fn.returns) {
    const rr = validate(fn.returns, value, { tableOfId });
    if (!rr.ok) throw new EmberError("ValidationError", `Invalid return value: ${rr.path}: ${rr.message}`, { path: rr.path });
  }
  return { value, readSet };
}

// ------------------------------------------------------------------------------------------------ replicated docs

/**
 * Complete documents of the schema found in a query result (arrays, `{page}`, nested objects): plain objects with
 * a string `_id` of a known table, a number `_creationTime`, and fields that validate against the table's document
 * shape (so projections and computed objects are skipped). These are what an offline store replicates.
 */
export function documentsIn(m: SchemaManifest, value: unknown, max = 100_000): Array<{ table: string; doc: Doc }> {
  const out: Array<{ table: string; doc: Doc }> = [];
  const seen = new Set<string>();
  const walk = (x: unknown, depth: number) => {
    if (out.length >= max || depth > 8) return;
    if (Array.isArray(x)) {
      for (const y of x) walk(y, depth + 1);
      return;
    }
    if (!isPlainObject(x)) return;
    const id = x._id;
    const table = typeof id === "string" && typeof x._creationTime === "number" ? localTableOfId(m, id) : undefined;
    if (table) {
      if (!seen.has(id as string) && isDocumentOf(m.tables[table]!.document, x)) {
        seen.add(id as string);
        out.push({ table, doc: x as Doc });
      }
      return;
    }
    for (const y of Object.values(x)) walk(y, depth + 1);
  };
  walk(value, 0);
  return out;
}

function isDocumentOf(shape: ObjectShape, x: Record<string, unknown>): boolean {
  const { _id, _creationTime, ...fields } = x;
  return validate(shape, fields).ok;
}

// ------------------------------------------------------------------------------------------------ local SQLite

/**
 * Brings a local SQLite to the schema with the server's planner and DDL (FTS5 included). A migration the planner
 * refuses (incompatible change with rows present) wipes the replica instead: it is a cache, the server resends it.
 * Staged indexes are backfilled right away. Returns whether the replica was reset.
 */
export function prepareLocalDatabase(driver: SqlDriver, schema0: LocalSchema): { reset: boolean } {
  // External indexes (Vectorize, AI Search) are server-side only: a replica never fills their outbox.
  const kinds = new Map<string, IndexKind>();
  for (const [k, kind] of schema0.indexKinds) {
    if (!isExternalKind(kind)) kinds.set(k, kind);
    else {
      const { backfill: _skip, ...rest } = kind;
      kinds.set(k, rest);
    }
  }
  const schema: LocalSchema = { manifest: schema0.manifest, indexKinds: kinds };
  let reset = false;
  if (storedVersion(driver) !== schema.manifest.version) {
    const plan = planMigration(driver, schema.manifest, schema.indexKinds);
    if (!plan.ok) {
      wipeLocalDatabase(driver);
      reset = true;
    }
    applyMigration(driver, plan.ok ? plan : planMigration(driver, schema.manifest, schema.indexKinds), schema.manifest);
  }
  while (!backfillStep(driver, schema.manifest, schema.indexKinds, 2000).done) {
    /* local backfill runs to completion */
  }
  return { reset };
}

/** Drops every table (virtual tables first; their shadow tables and triggers go with them). */
export function wipeLocalDatabase(driver: SqlDriver): void {
  driver.transaction(() => {
    const names = (where: string) =>
      driver.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND ${where}`).rows.map((r) => String(r.name));
    for (const n of names(`sql LIKE 'CREATE VIRTUAL TABLE%'`)) driver.exec(`DROP TABLE IF EXISTS ${q(n)}`);
    for (const n of names(`1`)) driver.exec(`DROP TABLE IF EXISTS ${q(n)}`);
  });
}

/** `LocalReader` over a local SQLite prepared with `prepareLocalDatabase`: the server's SQL (and FTS5). */
export function sqlLocalReader(driver: SqlDriver, schema: LocalSchema): LocalReader {
  const { tables } = runtimesOf(schema.manifest);
  const exec = (sql: string, ...params: SqlValue[]) => driver.exec(sql, ...params).rows;
  const t = (name: string) => tables.get(name)!;
  return {
    scan: (table, index, lo, hi, asc, limit) => sqlScan(exec, t(table), index, lo, hi, asc, limit),
    get: (table, id) => {
      const row = exec(`SELECT * FROM ${q(table)} WHERE "_id" = ?`, id)[0];
      return row ? t(table).decode(row) : null;
    },
    pluginQuery: (table, kind, spec, arg) => sqlPluginQuery(exec, kind, t(table), spec, arg),
  };
}

/**
 * Writes replicated documents into a local SQLite with the server's row codec and index keys (`_id` and
 * `_creationTime` kept as sent). FTS5 triggers follow the rows. Aggregates and file refcounts are not maintained.
 */
export function sqlReplicaWriter(driver: SqlDriver, schema: LocalSchema) {
  const { tables } = runtimesOf(schema.manifest);
  const keyed = new Map<string, Array<{ name: string; fields: string[] }>>();
  const keysOf = (name: string) => {
    let k = keyed.get(name);
    if (!k) {
      const tm = schema.manifest.tables[name]!;
      k = dbIndexesOf(tm).map((i) => ({ name: i.name, fields: indexFields(tm, i.name)! }));
      keyed.set(name, k);
    }
    return k;
  };
  const CHUNK = 90;
  return {
    upsert(table: string, doc: Doc): void {
      const t = tables.get(table);
      if (!t) throw new EmberError("ValidationError", `Unknown table ${JSON.stringify(table)}`);
      const values: Array<[string, SqlValue]> = [["_creationTime", doc._creationTime], ...Object.entries(encodeFields(t.layout, doc))];
      for (const i of keysOf(table)) values.push([keyColumn(i.name), docKey(doc, i.fields)]);
      const cur = driver.exec(`SELECT "_rowid" FROM ${q(table)} WHERE "_id" = ?`, doc._id).rows[0];
      let rowid: number;
      let rest = values;
      if (cur) rowid = Number(cur._rowid);
      else {
        const first = values.slice(0, CHUNK);
        const r = driver.exec(
          `INSERT INTO ${q(table)} ("_id", ${first.map(([c]) => q(c)).join(", ")}) VALUES (?, ${first.map(() => "?").join(", ")}) RETURNING "_rowid"`,
          doc._id,
          ...first.map(([, x]) => x),
        );
        rowid = Number(r.rows[0]!._rowid);
        rest = values.slice(CHUNK);
      }
      for (let i = 0; i < rest.length; i += CHUNK) {
        const part = rest.slice(i, i + CHUNK);
        driver.exec(`UPDATE ${q(table)} SET ${part.map(([c]) => `${q(c)} = ?`).join(", ")} WHERE "_rowid" = ?`, ...part.map(([, x]) => x), rowid);
      }
    },
    delete(table: string, id: string): void {
      if (!tables.has(table)) return;
      driver.exec(`DELETE FROM ${q(table)} WHERE "_id" = ?`, id);
    },
  };
}

// ------------------------------------------------------------------------------------------------ search without FTS5

type SearchConfig = { searchField: string; filterFields: string[]; tokenizer: "unicode61" | "trigram" };
const normalize = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * `withSearchIndex` over plain documents, for stores without FTS5 (IndexedDB). Same query surface and matching
 * as the FTS5 plugin (tokens like `unicode61 remove_diacritics 2`, OR of terms, last term as a prefix; or a
 * trigram substring), `.eq()` filters, at most 1024 results. Ranked by BM25 (k1 1.2, b 0.75) computed over
 * `docs`, so the order can differ from FTS5's when the replica holds only part of the table.
 */
export function jsSearch(docs: Doc[], spec: IndexSpec, build: (q: any) => unknown): { docs: Doc[]; data: unknown } {
  const { searchField, filterFields, tokenizer } = spec.config as unknown as SearchConfig;
  let text: string | undefined;
  const filters: Array<{ field: string; value: unknown }> = [];
  const b = {
    search(field: string, t: string) {
      if (field !== searchField) throw new Error(`search() must use ${searchField}`);
      if (typeof t !== "string") throw new Error("search() needs a string");
      text = t;
      return b;
    },
    eq(field: string, value: unknown) {
      if (!filterFields.includes(field)) throw new Error(`${field} is not a filter field of ${spec.name}`);
      filters.push({ field, value });
      return b;
    },
  };
  build(b);
  if (text === undefined) throw new Error(`withSearchIndex(${spec.name}): call q.search(...)`);
  const terms = tokenizer === "trigram" ? (text.trim().length >= 3 ? [text.trim()] : []) : [...new Set(tokenize(text))].slice(0, 16);
  const data = { searchField, tokenizer, terms, filters, resultIds: [] as string[] };
  if (!terms.length) return { docs: [], data };
  const pass = docs.filter((d) => filters.every((f) => compareValues(fieldOf(d, f.field), f.value) === 0));
  type Hit = { doc: Doc; tf: number[]; len: number };
  const hits: Hit[] = [];
  let totalLen = 0;
  for (const doc of pass) {
    const raw = fieldOf(doc, searchField);
    if (typeof raw !== "string") continue;
    if (tokenizer === "trigram") {
      const hay = normalize(raw);
      const needle = normalize(terms[0]!);
      let n = 0;
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
      totalLen += hay.length;
      if (n) hits.push({ doc, tf: [n], len: hay.length });
      continue;
    }
    const toks = tokenize(raw);
    totalLen += toks.length;
    const last = terms.length - 1;
    const tf = terms.map((t, i) => toks.filter((x) => (i === last ? x.startsWith(t) : x === t)).length);
    if (tf.some((n) => n > 0)) hits.push({ doc, tf, len: toks.length });
  }
  const n = pass.length || 1;
  const avg = totalLen / n || 1;
  const idf = terms.map((_, i) => {
    const df = hits.filter((h) => h.tf[i]! > 0).length;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  });
  const score = (h: Hit) => h.tf.reduce((s, f, i) => s + (idf[i]! * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * h.len) / avg)), 0);
  const ranked = hits
    .map((h) => ({ h, s: score(h) }))
    .sort((x, y) => y.s - x.s || x.h.doc._creationTime - y.h.doc._creationTime)
    .slice(0, 1024)
    .map((x) => x.h.doc);
  data.resultIds = ranked.map((d) => d._id);
  return { docs: ranked, data };
}
