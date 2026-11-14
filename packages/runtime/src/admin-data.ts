// Data editing for the Ember Dashboard (docs/design/contracts.md "Dashboard"). Writes go through the engine, never
// raw SQL: each one is an internal mutation of the module `_ember`, added to the app's functions by
// createEmberWorker. So a dashboard edit is validated against the schema, maintains every index (plugins included),
// is group-committed, lands in the change log and reaches subscribers like any other mutation. Reads with an index
// (filter + order) are an internal query. Only the app's own tables: internal tables (`_jobs`, `_files`, ...) and
// component tables (`<path>$<table>`) are refused, so they stay read-only through `GET /api/_ember/data`.
//
// The functions are internal (`internalQuery` / `internalMutation`): clients cannot call them; the Worker calls them
// on the shard with `internal = true` after checking the admin token.

import { internalMutation, internalQuery, v, EmberError, type SchemaManifest } from "@freecorps/ember-server";

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
    /** A page of `table`, optionally through an index (equality on a prefix of its fields), in either order. */
    dataList: internalQuery({
      args: {
        table: v.string(),
        index: v.optional(v.string()),
        eq: v.optional(v.array(v.any())),
        order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
        cursor: v.optional(v.union(v.string(), v.null())),
        limit: v.optional(v.number()),
      },
      handler: (ctx, a) => {
        userTable(manifest, a.table);
        const numItems = Math.max(1, Math.min(DATA_LIST_MAX, Math.floor(a.limit ?? 50)));
        const db = ctx.db as unknown as {
          query(t: string): {
            withIndex(i: string, b?: (q: { eq(f: string, x: unknown): unknown }) => unknown): { order(o: "asc" | "desc"): { paginate(p: { numItems: number; cursor: string | null }): unknown } };
            order(o: "asc" | "desc"): { paginate(p: { numItems: number; cursor: string | null }): unknown };
          };
        };
        const q = db.query(a.table);
        const order = a.order ?? "asc";
        const page = { numItems, cursor: a.cursor ?? null };
        if (!a.index || a.index === "by_creation_time") return q.order(order).paginate(page);
        const spec = manifest().tables[a.table]!.indexes.find((i) => i.name === a.index);
        if (!spec || spec.kind !== "db") throw new EmberError("NotFound", `no database index ${a.table}.${a.index}`);
        const eq = a.eq ?? [];
        if (eq.length > spec.fields.length) throw new EmberError("ValidationError", `${a.index} has ${spec.fields.length} field(s)`);
        return q
          .withIndex(a.index, (b) => {
            let x: unknown = b;
            eq.forEach((value, i) => (x = (x as { eq(f: string, v: unknown): unknown }).eq(spec.fields[i]!, value)));
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

/** What `GET /api/_ember/schema` returns: the app's tables (document shape, indexes) and the internal tables. */
export function schemaSummary(manifest: SchemaManifest) {
  const tables = Object.entries(manifest.tables)
    .filter(([name]) => !name.startsWith("_") && !name.includes("$"))
    .map(([name, t]) => ({ name, document: t.document, indexes: t.indexes.map((i) => ({ name: i.name, kind: i.kind, fields: i.fields })), shard: t.shard ?? null }));
  const components = Object.keys(manifest.tables).filter((n) => n.includes("$"));
  return { version: manifest.version, tables, componentTables: components };
}
