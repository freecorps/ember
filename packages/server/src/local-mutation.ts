// Mutations run on the client (PLAN §10 "Fica para depois", Brigade RFC 0016 gap G5). The same `mutation(...)`
// handler the server registers runs over a writable overlay of a local replica, so a client gets an optimistic
// result without a hand-written update per query: the overlay's documents are what local queries then read.
//
// - `overlayReader(base, schema)` is a `LocalReader` with writes on top: `put`/`remove` per document; `scan` merges
//   the overlay into the base's index ranges with the server's key encoding, so `QueryImpl` sees one consistent set.
// - `runLocalMutation` runs a handler over an overlay: `ctx.db` reads see its own writes; `insert`/`patch`/`replace`/
//   `delete`/`increment` validate like the engine (system fields, the table's document shape); `ctx.scheduler`
//   records jobs without running them (the server runs its own); `ctx.random` is seeded. `ctx.storage`,
//   `ctx.runQuery` and `ctx.runMutation` throw `OfflineUnsupported`. Ids of inserted documents are local: the
//   server makes its own, and its confirmed result replaces the optimistic one.

import { compareBytes, validate, withDefaults } from "@freecorps/ember-values";
import { docKey, readSetFields } from "./ddl.ts";
import { EmberError } from "./errors.ts";
import { authApi, failApi, isRegisteredFunction, type AnyRegisteredFunction } from "./functions.ts";
import { makeId, seededRandom } from "./ids.ts";
import { decodeRow, layoutOf } from "./layout.ts";
import { localTableOfId, OFFLINE_UNSUPPORTED, type LocalReader, type LocalRowChange, type LocalSchema } from "./local.ts";
import { QueryImpl, type QueryEnv, type ScannedRow, type TableRuntime } from "./query.ts";
import type { Doc, Identity, ReadSet } from "./types.ts";

const unsupported = (what: string) => new EmberError(OFFLINE_UNSUPPORTED, `${what} is not available in mutations run on the client`);

/** A `LocalReader` with document writes on top (`null` = deleted here). */
export interface OverlayReader extends LocalReader {
  put(table: string, doc: Doc): void;
  remove(table: string, id: string): void;
  /** The documents this overlay changed, as `{ table, id, before, after }`, in write order (one per document). */
  changes(): LocalRowChange[];
}

export function overlayReader(base: LocalReader, schema: LocalSchema): OverlayReader {
  const m = schema.manifest;
  // table → id → doc (null: deleted)
  const writes = new Map<string, Map<string, Doc | null>>();
  const before = new Map<string, { table: string; id: string; before: Doc | null }>();
  const own = (table: string) => {
    let t = writes.get(table);
    if (!t) writes.set(table, (t = new Map()));
    return t;
  };
  const get = (table: string, id: string): Doc | null => {
    const w = writes.get(table);
    if (w?.has(id)) return w.get(id) ?? null;
    return base.get(table, id);
  };
  const remember = (table: string, id: string) => {
    const k = `${table}\u0000${id}`;
    if (!before.has(k)) before.set(k, { table, id, before: get(table, id) });
  };
  return {
    get,
    put(table, doc) {
      remember(table, doc._id as string);
      own(table).set(doc._id as string, doc);
    },
    remove(table, id) {
      remember(table, id);
      own(table).set(id, null);
    },
    changes() {
      return [...before.values()].map((b) => ({ table: b.table, id: b.id, before: b.before, after: get(b.table, b.id) }));
    },
    scan(table, index, lo, hi, asc, limit) {
      const w = writes.get(table);
      if (!w?.size) return base.scan(table, index, lo, hi, asc, limit);
      const fields = readSetFields(m, table, index);
      if (!fields) throw new EmberError("ValidationError", `Unknown index ${table}.${index}`);
      // The base's rows of this range, minus those the overlay rewrote; then the overlay's own, keyed the same way.
      const rows: ScannedRow[] = base.scan(table, index, lo, hi, asc, limit + w.size).filter((r) => !w.has(r.doc._id as string));
      for (const doc of w.values()) {
        if (!doc) continue;
        const key = docKey(doc, fields);
        if (compareBytes(key, lo) >= 0 && compareBytes(key, hi) < 0) rows.push({ key, doc });
      }
      // Key order (ties by id, as the index's own order would place equal keys), then the direction asked.
      rows.sort((x, y) => compareBytes(x.key, y.key) || (String(x.doc._id) < String(y.doc._id) ? -1 : String(x.doc._id) > String(y.doc._id) ? 1 : 0));
      if (!asc) rows.reverse();
      return rows.slice(0, limit);
    },
    ...(base.pluginQuery ? { pluginQuery: base.pluginQuery.bind(base) } : {}),
  };
}

export type LocalMutationOptions = {
  schema: LocalSchema;
  /** The overlay the mutation writes into (`overlayReader(replica, schema)`). */
  reader: OverlayReader;
  identity?: Identity | null;
  now?: number;
  /** `ctx.random` (default: seeded from `seed`). */
  random?: () => number;
  /** Seed of the default `ctx.random` (the same seed replays the same values). */
  seed?: number;
  rowsRead?: number;
};

/** A locally runnable mutation: a public `mutation(...)` definition. */
export function assertLocalMutation(name: string, fn: unknown): asserts fn is AnyRegisteredFunction {
  if (!isRegisteredFunction(fn) || fn.type !== "mutation") throw new EmberError("InvalidFunction", `${name}: only mutation() definitions can run on the client`);
  if ((fn as AnyRegisteredFunction).visibility !== "public") throw new EmberError("InvalidFunction", `${name}: internal mutations cannot run on the client`);
}

/**
 * Runs a registered mutation handler over an overlay of a replica. Synchronous; throws like `engine.runMutation`
 * (a throw leaves the overlay as it was: writes go to a private layer first). Returns the handler's value and the
 * documents it changed.
 */
export function runLocalMutation(fn: AnyRegisteredFunction, args: unknown, o: LocalMutationOptions): { value: unknown; changes: LocalRowChange[]; jobs: Array<{ id: string; fn: string; args: unknown; runAt: number }> } {
  assertLocalMutation("(local)", fn);
  const m = o.schema.manifest;
  const tableOfId = (id: string) => localTableOfId(m, id);
  const a = withDefaults(fn.args, args ?? {});
  const ra = validate(fn.args, a, { tableOfId });
  if (!ra.ok) throw new EmberError("ValidationError", `Invalid arguments: ${ra.path}: ${ra.message}`, { path: ra.path, issues: [{ path: ra.path, message: ra.message }] });
  const now = o.now ?? Date.now();
  const random = o.random ?? seededRandom(o.seed ?? Math.floor(now));
  // Writes go to a private layer over the caller's overlay; only a handler that returns commits them.
  const layer = overlayReader(o.reader, o.schema);
  const limit = o.rowsRead ?? 16_384;
  let read = 0;
  const count = (n: number) => {
    read += n;
    if (read > limit) throw new EmberError("TooManyReads", `Too many rows read in one transaction (limit ${limit})`);
  };
  const runtimes = new Map<string, TableRuntime>();
  const table = (name: string): TableRuntime => {
    let t = runtimes.get(name);
    if (!t) {
      const tm = m.tables[name];
      if (!tm) throw new EmberError("ValidationError", `Unknown table ${JSON.stringify(name)}`);
      const layout = layoutOf(name, tm.document);
      t = { name, manifest: tm, layout, decode: (row) => decodeRow(layout, row) };
      runtimes.set(name, t);
    }
    return t;
  };
  const readSet: ReadSet = [];
  const getById = (id: string): Doc | null => {
    if (typeof id !== "string") throw new EmberError("ValidationError", "db.get() needs an id string");
    const t = tableOfId(id);
    if (!t) return null;
    const doc = layer.get(t, id);
    count(doc ? 1 : 0);
    return doc;
  };
  const env: QueryEnv = {
    scan: (t, index, lo, hi, asc, n) => {
      const rows = layer.scan(t.name, index, lo, hi, asc, n);
      count(rows.length);
      return rows;
    },
    pluginQuery: (kind, t, spec, arg) => {
      if (!layer.pluginQuery) throw unsupported(`${kind.kind} index ${t.name}.${spec.name}`);
      const out = layer.pluginQuery(t.name, kind, spec, arg);
      count(out.docs.length);
      return out;
    },
    table,
    readSet,
    isStaged: () => false,
    kinds: o.schema.indexKinds,
    getById,
  };
  const checkFields = (value: unknown, current?: Doc): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EmberError("ValidationError", "Expected a document object");
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value)) {
      if (k.startsWith("_")) {
        if (current && (k === "_id" || k === "_creationTime") && (x === undefined || x === current[k])) continue;
        throw new EmberError("ValidationError", `System field ${k} cannot be written`);
      }
      out[k] = x;
    }
    return out;
  };
  const checkDoc = (name: string, fields: Record<string, unknown>) => {
    if (!m.schemaValidation) return;
    const r = validate(table(name).manifest.document, fields, { tableOfId });
    if (!r.ok) throw new EmberError("ValidationError", `Document for ${name} is invalid: ${r.path}: ${r.message}`, { path: r.path });
  };
  const normalize = (name: string, id: string, ct: number, fields: Record<string, unknown>): Doc => {
    const doc: Record<string, unknown> = { _id: id, _creationTime: ct };
    for (const f of table(name).layout.fieldOrder) if (fields[f] !== undefined) doc[f] = fields[f];
    return doc as Doc;
  };
  const current = (id: string): { table: string; doc: Doc } => {
    const t = typeof id === "string" ? tableOfId(id) : undefined;
    const doc = t ? layer.get(t, id) : null;
    if (!t || !doc) throw new EmberError("NotFound", `Document ${id} not found`);
    return { table: t, doc };
  };
  let lastCreationTime = 0;
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
    insert: (name: string, value: unknown): string => {
      const fields = checkFields(value);
      checkDoc(name, fields);
      const ct = (lastCreationTime = Math.max(now, lastCreationTime + 0.001));
      const id = makeId(table(name).manifest.idPrefix, ct, random);
      layer.put(name, normalize(name, id, ct, fields));
      return id;
    },
    patch: (id: string, value: unknown) => {
      const cur = current(id);
      const { _id, _creationTime, ...old } = cur.doc;
      const fields: Record<string, unknown> = { ...old };
      for (const [k, x] of Object.entries(checkFields(value, cur.doc))) {
        if (x === undefined) delete fields[k];
        else fields[k] = x;
      }
      checkDoc(cur.table, fields);
      layer.put(cur.table, normalize(cur.table, _id as string, _creationTime as number, fields));
    },
    replace: (id: string, value: unknown) => {
      const cur = current(id);
      const fields = Object.fromEntries(Object.entries(checkFields(value, cur.doc)).filter(([, x]) => x !== undefined));
      checkDoc(cur.table, fields);
      layer.put(cur.table, normalize(cur.table, cur.doc._id as string, cur.doc._creationTime as number, fields));
    },
    delete: (id: string) => {
      const cur = current(id);
      layer.remove(cur.table, id);
    },
    increment: (id: string, field: string, delta: number | bigint): number | bigint => {
      if (typeof field !== "string" || !field || field.startsWith("_") || field.includes(".")) {
        throw new EmberError("ValidationError", "increment() needs a top-level, non-system field name");
      }
      if (typeof delta === "number" ? !Number.isFinite(delta) : typeof delta !== "bigint") {
        throw new EmberError("ValidationError", "increment() needs a finite number or a bigint delta");
      }
      const x = current(id).doc[field];
      let next: number | bigint;
      if (typeof delta === "bigint") {
        if (x !== undefined && typeof x !== "bigint") throw new EmberError("ValidationError", `increment(): ${field} is not an int64`);
        next = ((x as bigint | undefined) ?? 0n) + delta;
      } else {
        if (x !== undefined && typeof x !== "number") throw new EmberError("ValidationError", `increment(): ${field} is not a number`);
        next = ((x as number | undefined) ?? 0) + delta;
      }
      db.patch(id, { [field]: next });
      return next;
    },
  };
  const jobs: Array<{ id: string; fn: string; args: unknown; runAt: number }> = [];
  const nameOf = (ref: unknown): string => (typeof ref === "string" ? ref : String((ref as { _name?: unknown })?._name ?? (ref as { name?: unknown })?.name ?? "(function)"));
  const finite = (t: number) => {
    if (typeof t !== "number" || !Number.isFinite(t)) throw new EmberError("ValidationError", "Scheduled time must be a finite number");
    return t;
  };
  // Like the engine: a delay under 0 is now, the time must be finite, cancel drops a job of this mutation.
  const scheduler = {
    runAfter: (delayMs: number, ref: unknown, jobArgs?: unknown) => {
      const id = makeId("job", now, random);
      jobs.push({ id, fn: nameOf(ref), args: jobArgs ?? {}, runAt: now + Math.max(0, finite(delayMs)) });
      return id;
    },
    runAt: (at: number | Date, ref: unknown, jobArgs?: unknown) => {
      const id = makeId("job", now, random);
      jobs.push({ id, fn: nameOf(ref), args: jobArgs ?? {}, runAt: finite(typeof at === "number" ? at : at.getTime()) });
      return id;
    },
    cancel: (id: string) => {
      const i = jobs.findIndex((j) => j.id === id);
      if (i >= 0) jobs.splice(i, 1);
    },
  };
  const storage = new Proxy(
    {},
    {
      get: () => () => {
        throw unsupported("ctx.storage");
      },
    },
  );
  const identity = o.identity ?? null;
  const call = (what: string) => () => {
    throw unsupported(what);
  };
  const value = fn.handler({ db, auth: authApi(identity), fail: failApi(fn), now, random, scheduler, storage, runQuery: call("ctx.runQuery"), runMutation: call("ctx.runMutation") }, a);
  if (value && typeof (value as PromiseLike<unknown>).then === "function") {
    Promise.resolve(value).catch(() => {});
    throw new EmberError("AsyncHandler", "mutation handlers must be synchronous");
  }
  // The handler returned: its writes join the caller's overlay.
  const changes = layer.changes();
  for (const c of changes) {
    if (c.after) o.reader.put(c.table, c.after);
    else o.reader.remove(c.table, c.id);
  }
  return { value, changes, jobs };
}

