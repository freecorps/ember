// Data editing for the Ember Dashboard (docs/design/contracts.md "Dashboard"). Writes go through the engine, never
// raw SQL: each one is an internal mutation of the module `_ember`, added to the app's functions by
// createEmberWorker. So a dashboard edit is validated against the schema, maintains every index (plugins included),
// is group-committed, lands in the change log and reaches subscribers like any other mutation. Reads with an index
// (filter + order) are an internal query. Only the app's own tables: internal tables (`_jobs`, `_files`, ...) and
// component tables (`<path>$<table>`) are refused, so they stay read-only through `GET /api/_ember/data`.
//
// The functions are internal (`internalQuery` / `internalMutation`): clients cannot call them; the Worker calls them
// on the shard with `internal = true` after checking the admin token.

import { internalMutation, internalQuery, layoutOf, v, EmberError, type SchemaManifest } from "@freecorps/ember-server";
import { encodeKey } from "@freecorps/ember-values";

/** Module name of the admin functions (`_ember:dataList`, ...). Reserved: an app module cannot be called `_ember`. */
export const ADMIN_MODULE = "_ember";

export const DATA_LIST_MAX = 200;

function userTable(manifest: () => SchemaManifest, table: string): void {
  if (table.startsWith("_") || table.includes("$")) throw new EmberError("Forbidden", `${table} is internal: read-only from the dashboard`);
  if (!manifest().tables[table]) throw new EmberError("NotFound", `unknown table ${JSON.stringify(table)}`);
}

const objectOf = (x: unknown, what: string): Record<string, unknown> => {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new EmberError("ValidationError", `${what} must be an object`);
  return x as Record<string, unknown>;
};

/** System fields are the engine's: a document from the dashboard never sets them. */
function withoutSystem(doc: Record<string, unknown>): Record<string, unknown> {
  const { _id: _i, _creationTime: _c, ...rest } = doc;
  return rest;
}

/** The `_ember` module, bound to the composed schema. */
export function adminDataFunctions(manifest: () => SchemaManifest) {
  return {
    /**
     * A page of `table`, optionally through an index (equality on a prefix of its fields, then at most one lower and one
     * upper bound on the next field: `range` = `{ gt|gte?, lt|lte? }`), in either order. `id`: that one document (a
     * direct get; `[]` when it is not one of the table's). `search` + `index` (a searchIndex): full-text search, bm25
     * order, one page of up to `limit` (FTS5 has no cursor).
     */
    dataList: internalQuery({
      args: {
        table: v.string(),
        index: v.optional(v.string()),
        eq: v.optional(v.array(v.any())),
        range: v.optional(v.any()),
        id: v.optional(v.string()),
        search: v.optional(v.string()),
        order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
        cursor: v.optional(v.union(v.string(), v.null())),
        limit: v.optional(v.number()),
      },
      handler: (ctx, a) => {
        userTable(manifest, a.table);
        const numItems = Math.max(1, Math.min(DATA_LIST_MAX, Math.floor(a.limit ?? 50)));
        type Bounds = { eq(f: string, x: unknown): Bounds; gt(f: string, x: unknown): Bounds; gte(f: string, x: unknown): Bounds; lt(f: string, x: unknown): Bounds; lte(f: string, x: unknown): Bounds };
        type Ordered = { order(o: "asc" | "desc"): { paginate(p: { numItems: number; cursor: string | null }): unknown } };
        const db = ctx.db as unknown as {
          normalizeId(t: string, id: string): string | null;
          get(id: string): unknown;
          query(t: string): Ordered & {
            withIndex(i: string, b?: (q: Bounds) => unknown): Ordered;
            withSearchIndex(i: string, b: (q: { search(f: string, text: string): unknown }) => unknown): { take(n: number): unknown[] };
          };
        };
        const one = (page: unknown[]) => ({ page, isDone: true, continueCursor: "" });
        if (a.id !== undefined) {
          const id = db.normalizeId(a.table, a.id);
          const doc = id ? db.get(id) : null;
          return one(doc ? [doc] : []);
        }
        const table = manifest().tables[a.table]!;
        if (a.search !== undefined) {
          const spec = table.indexes.find((i) => i.name === a.index && i.kind === "search");
          if (!spec) throw new EmberError("NotFound", `no search index ${a.table}.${a.index ?? "(none)"}`);
          if (a.search.length > 1000) throw new EmberError("ValidationError", "search: at most 1000 characters");
          const field = (spec.config as { searchField?: string } | undefined)?.searchField ?? spec.fields[0]!;
          return one(db.query(a.table).withSearchIndex(spec.name, (b) => b.search(field, a.search!)).take(numItems));
        }
        const q = db.query(a.table);
        const order = a.order ?? "asc";
        const page = { numItems, cursor: a.cursor ?? null };
        const range = a.range === undefined || a.range === null ? null : objectOf(a.range, "range");
        if (range) {
          for (const k of Object.keys(range)) if (!["gt", "gte", "lt", "lte"].includes(k)) throw new EmberError("ValidationError", `range: unknown bound ${JSON.stringify(k)} (gt, gte, lt, lte)`);
          if ("gt" in range && "gte" in range) throw new EmberError("ValidationError", "range: gt or gte, not both");
          if ("lt" in range && "lte" in range) throw new EmberError("ValidationError", "range: lt or lte, not both");
          // A bound is an index key: what the values key encoding cannot hold is refused here, by name.
          for (const [k, x] of Object.entries(range)) {
            try {
              encodeKey([x]);
            } catch (e) {
              throw new EmberError("ValidationError", `range.${k}: not an index value (${(e as Error).message})`);
            }
          }
        }
        if ((!a.index || a.index === "by_creation_time") && !range) return q.order(order).paginate(page);
        const fields = !a.index || a.index === "by_creation_time" ? [] : table.indexes.find((i) => i.name === a.index && i.kind === "db")?.fields;
        if (!fields) throw new EmberError("NotFound", `no database index ${a.table}.${a.index}`);
        const eq = a.eq ?? [];
        if (eq.length > fields.length) throw new EmberError("ValidationError", `${a.index} has ${fields.length} field(s)`);
        // The field after the prefix: the next index field, else `_creationTime` (every index ends with it).
        const next = [...fields, "_creationTime"][eq.length]!;
        return q
          .withIndex(a.index || "by_creation_time", (b) => {
            let x = b;
            eq.forEach((value, i) => (x = x.eq(fields[i]!, value)));
            if (range) {
              if ("gt" in range) x = x.gt(next, range.gt);
              else if ("gte" in range) x = x.gte(next, range.gte);
              if ("lt" in range) x = x.lt(next, range.lt);
              else if ("lte" in range) x = x.lte(next, range.lte);
            }
            return x;
          })
          .order(order)
          .paginate(page);
      },
    }),
    dataInsert: internalMutation({
      args: { table: v.string(), doc: v.any() },
      handler: (ctx, a) => {
        userTable(manifest, a.table);
        return (ctx.db as unknown as { insert(t: string, d: unknown): string }).insert(a.table, withoutSystem(objectOf(a.doc, "doc")));
      },
    }),
    dataPatch: internalMutation({
      args: { table: v.string(), id: v.string(), fields: v.any() },
      handler: (ctx, a) => {
        userTable(manifest, a.table);
        const db = ctx.db as unknown as { normalizeId(t: string, id: string): string | null; get(id: string): unknown; patch(id: string, f: unknown): void };
        const id = db.normalizeId(a.table, a.id);
        if (!id || !db.get(id)) throw new EmberError("NotFound", `${a.id} is not a document of ${a.table}`);
        db.patch(id, withoutSystem(objectOf(a.fields, "fields")));
        return db.get(id);
      },
    }),
    dataReplace: internalMutation({
      args: { table: v.string(), id: v.string(), doc: v.any() },
      handler: (ctx, a) => {
        userTable(manifest, a.table);
        const db = ctx.db as unknown as { normalizeId(t: string, id: string): string | null; get(id: string): unknown; replace(id: string, d: unknown): void };
        const id = db.normalizeId(a.table, a.id);
        if (!id || !db.get(id)) throw new EmberError("NotFound", `${a.id} is not a document of ${a.table}`);
        db.replace(id, withoutSystem(objectOf(a.doc, "doc")));
        return db.get(id);
      },
    }),
    /** Schedules `fn` now (a job: re-run a failed one, run a cron now); returns the new job id. */
    jobRun: internalMutation({
      args: { fn: v.string(), args: v.optional(v.any()) },
      handler: (ctx, a) => {
        if (a.fn.startsWith(`${ADMIN_MODULE}:`)) throw new EmberError("Forbidden", `${a.fn} is the dashboard's own`);
        const args = a.args === undefined || a.args === null ? {} : objectOf(a.args, "args");
        return (ctx.scheduler as unknown as { runAfter(ms: number, fn: string, args: unknown): string }).runAfter(0, a.fn, args);
      },
    }),
    /** Cancels a pending job (`ctx.scheduler.cancel`): it never runs; one already running is not interrupted. */
    jobCancel: internalMutation({
      args: { id: v.string() },
      handler: (ctx, a) => {
        (ctx.scheduler as unknown as { cancel(id: string): unknown }).cancel(a.id);
        return { cancelled: a.id };
      },
    }),
    dataDelete: internalMutation({
      args: { table: v.string(), ids: v.array(v.string()) },
      handler: (ctx, a) => {
        userTable(manifest, a.table);
        if (a.ids.length > 100) throw new EmberError("ValidationError", "at most 100 documents per call");
        const db = ctx.db as unknown as { normalizeId(t: string, id: string): string | null; get(id: string): unknown; delete(id: string): void };
        // All or nothing: every id must be a live document of the table before any is deleted.
        // Deduplicated: a repeated id is one document (deleting it twice would fail the second time).
        const ids = [...new Set(a.ids)].map((raw) => {
          const id = db.normalizeId(a.table, raw);
          if (!id || !db.get(id)) throw new EmberError("NotFound", `${raw} is not a document of ${a.table}`);
          return id;
        });
        for (const id of ids) db.delete(id);
        return { deleted: ids.length };
      },
    }),
  };
}

/**
 * What `GET /api/_ember/schema` returns: the app's tables (document shape, indexes, `.replicated()`, the SQLite columns
 * the SQL Explorer completes), the component tables and the internal tables of the manifest.
 */
export function schemaSummary(manifest: SchemaManifest) {
  const tables = Object.entries(manifest.tables)
    .filter(([name]) => !name.startsWith("_") && !name.includes("$"))
    .map(([name, t]) => ({
      name,
      document: t.document,
      indexes: t.indexes.map((i) => {
        const c = i.kind === "search" ? (i.config as { searchField?: string; filterFields?: string[] } | undefined) : undefined;
        return { name: i.name, kind: i.kind, fields: i.fields, ...(i.sparse ? { sparse: true } : {}), ...(c?.searchField ? { searchField: c.searchField, filterFields: c.filterFields ?? [] } : {}) };
      }),
      shard: t.shard ?? null,
      ...(t.replicated ? { replicated: { to: t.replicated.to ?? null } } : {}),
      sql: { table: name, columns: sqlColumns(name, t) },
    }));
  const components = Object.keys(manifest.tables).filter((n) => n.includes("$"));
  const internal = Object.keys(manifest.tables).filter((n) => n.startsWith("_"));
  return { version: manifest.version, tables, componentTables: components, internalTables: internal };
}

/** The table's SQLite columns (layout.ts): system columns, one per typed top-level field, `_json`, the index keys. */
function sqlColumns(name: string, t: SchemaManifest["tables"][string]): string[] {
  const layout = layoutOf(name, t.document);
  return ["_rowid", "_id", "_creationTime", ...layout.columns.map((c) => c.field), "_json", ...t.indexes.filter((i) => i.kind === "db").map((i) => `_k_${i.name}`)];
}
