// The engine (contracts.md): one shard's database over a SqlDriver. Runs queries (recording read sets) and
// mutations (capturing row changes and scheduled jobs), group-commits batches, migrates the schema, and decides
// whether a commit's changes can affect a recorded read set.

import { inKeyRange, rangeFor, stringifyValue, valueSize, validate, type ObjectShape, type Shape } from "@freecorps/ember-values";
import { AggregateMaintainer, aggregateDoc, aggregateReader, aggregatesOf, aggregateTable, type AggregateSpec } from "./aggregate.ts";
import { q, type SqlDriver, type SqlRow, type SqlValue } from "./driver.ts";
import { dbIndexesOf, docKey, indexFields, readSetFields } from "./ddl.ts";
import { EmberError, errorInfo } from "./errors.ts";
import { collectFiles, FILES_DDL, FileStore, shapeHasFiles, type FileStoreOptions, type StorageReader, type StorageWriter } from "./files.ts";
import { passes } from "./filter.ts";
import {
  flattenFunctions,
  getFunctionName,
  type AnyFunctionReference,
  type AnyRegisteredFunction,
  type FunctionType,
  type RegisteredHttpAction,
  type Visibility,
} from "./functions.ts";
import { makeId, parseId, seededRandom } from "./ids.ts";
import type { IndexKind, MatchHelpers } from "./indexKinds.ts";
import { decodeRow, encodeFields, fieldOf, keyColumn, layoutOf, type Layout } from "./layout.ts";
import {
  applyMigration,
  backfillStep,
  planMigration,
  stagedIndexes,
  storedVersion,
  type BackfillProgress,
  type MigrationPlan,
  type MigrationReport,
} from "./migrate.ts";
import { QueryImpl, type QueryEnv, type TableRuntime } from "./query.ts";
import type { SchemaDefinition, SchemaManifest } from "./schema.ts";
import { makeSqlReader } from "./sqlQuery.ts";
import type { AuthCtx, Doc, Job, ReadSet, RowChange } from "./types.ts";

export type Limits = {
  /** Rows read per transaction (query or mutation). */
  rowsRead: number;
  /** Rows written per mutation. */
  rowsWritten: number;
  /** Bytes per document (approximate encoded size). */
  documentSize: number;
};
export const DEFAULT_LIMITS: Limits = { rowsRead: 16_384, rowsWritten: 8_192, documentSize: 2 * 1024 * 1024 };

export interface CreateEngineOptions {
  schema: SchemaDefinition<any, any>;
  /** `{ "dir/mod:fn": fn }` or modules `{ "dir/mod": { fn } }`. */
  functions?: unknown;
  driver: SqlDriver;
  now?: () => number;
  random?: () => number;
  limits?: Partial<Limits>;
  /**
   * Files (`ctx.storage`, `_files` refcounts). The runtime passes the shard name and a URL signer (R2 S3 presign or
   * the Worker proxy); without a signer, `getUrl`/`generateUploadUrl` throw StorageError but refcounts still work.
   */
  storage?: Partial<FileStoreOptions>;
}

export type QueryResult = { value: unknown; readSet: ReadSet };
/** `cancelled`: ids of jobs scheduled by earlier mutations that `ctx.scheduler.cancel(id)` cancelled (the runtime
 * deletes them from `_jobs` in the same transaction). Jobs scheduled and cancelled by the same mutation are just
 * dropped from `scheduled`. */
export type MutationResult = { value: unknown; changes: RowChange[]; scheduled: Job[]; cancelled: string[] };
/** `touched`: filled with every table the query opened (db.query / db.get), even when it throws. */
export type RunQueryOptions = { touched?: Set<string> };
export type MutationBatchItem = { name: string; args: unknown; ctx: AuthCtx };
export type MutationBatchResult = ({ ok: true } & MutationResult) | { ok: false; error: { code: string; message: string } };
/** `sensitive`: the caller's session must be re-checked in the Auth DO (mutations and actions). */
export type FunctionInfo = { type: FunctionType | "httpAction"; visibility: Visibility; sensitive?: true };

type FnArg = string | AnyFunctionReference | AnyRegisteredFunction;

export interface Engine {
  readonly manifest: SchemaManifest;
  /** Idempotent. Plans and applies the schema (throws MigrationRefused), using `_ember_meta`. */
  migrate(): MigrationReport;
  /** Dry run of `migrate()`. */
  planMigration(): MigrationPlan;
  /** Fills up to `limit` rows of a staged index (call until `done`). */
  backfillStep(limit?: number): BackfillProgress;
  runQuery(name: FnArg, args?: unknown, ctx?: AuthCtx, opts?: RunQueryOptions): QueryResult;
  runMutation(name: FnArg, args?: unknown, ctx?: AuthCtx): MutationResult;
  /** Group commit: one transaction, one savepoint per item; a failing item is rolled back alone. Never throws per item. */
  runMutationBatch(items: MutationBatchItem[]): MutationBatchResult[];
  /** Whether any of `changes` may affect a result that recorded `readSet` (no false negatives). */
  matches(readSet: ReadSet, changes: RowChange[]): boolean;
  /** The table an id belongs to, or undefined. */
  tableOfId(id: string): string | undefined;
  functionInfo(name: string): FunctionInfo | undefined;
}

export function createEngine(options: CreateEngineOptions): Engine {
  return new EngineImpl(options);
}

const isThenable = (x: unknown): x is PromiseLike<unknown> =>
  (typeof x === "object" || typeof x === "function") && x !== null && typeof (x as any).then === "function";

const ANON: AuthCtx = { identity: null };

class EngineImpl implements Engine {
  readonly manifest: SchemaManifest;
  private readonly kinds: ReadonlyMap<string, IndexKind>;
  private readonly driver: SqlDriver;
  private readonly functions: Map<string, AnyRegisteredFunction | RegisteredHttpAction>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly limits: Limits;
  private readonly tables = new Map<
    string,
    TableRuntime & { keyIndexes: Array<{ name: string; fields: string[] }>; hasFiles: boolean; aggregates: AggregateSpec[] }
  >();
  private readonly storageOpts: FileStoreOptions;
  private readonly prefixes = new Map<string, string>();
  /** `${table}\0${index}` -> backfill window: rows `(cursor, until]` are not indexed / aggregated yet. */
  private staged = new Map<string, { cursor: number; until: number }>();
  private migrated = false;
  private lastCreationTime = 0;

  constructor(o: CreateEngineOptions) {
    this.manifest = o.schema.manifest;
    this.kinds = o.schema.indexKinds;
    this.driver = o.driver;
    this.functions = flattenFunctions(o.functions ?? {});
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.storageOpts = { shard: () => null, ...o.storage };
    for (const [name, t] of Object.entries(this.manifest.tables)) {
      const layout: Layout = layoutOf(name, t.document);
      this.tables.set(name, {
        name,
        manifest: t,
        layout,
        decode: (row: SqlRow) => decodeRow(layout, row),
        keyIndexes: dbIndexesOf(t).map((i) => ({ name: i.name, fields: indexFields(t, i.name)! })),
        hasFiles: shapeHasFiles(t.document),
        aggregates: aggregatesOf(t),
      });
      this.prefixes.set(t.idPrefix, name);
    }
  }

  // ------------------------------------------------------------------------------------------ schema

  migrate(): MigrationReport {
    for (const sql of FILES_DDL) this.driver.exec(sql);
    const from = storedVersion(this.driver);
    let report: MigrationReport;
    if (from === this.manifest.version) {
      report = { changed: false, fromVersion: from, toVersion: this.manifest.version, steps: [], staged: stagedIndexes(this.driver) };
    } else {
      report = applyMigration(this.driver, planMigration(this.driver, this.manifest, this.kinds), this.manifest);
    }
    this.migrated = true;
    this.refreshStaged();
    return report;
  }

  planMigration(): MigrationPlan {
    return planMigration(this.driver, this.manifest, this.kinds);
  }

  backfillStep(limit = 500): BackfillProgress {
    this.ensureMigrated();
    const progress = backfillStep(this.driver, this.manifest, this.kinds, limit);
    this.refreshStaged();
    return progress;
  }

  private refreshStaged() {
    const has = stagedIndexes(this.driver).length > 0;
    this.staged = new Map(
      has
        ? this.driver
            .exec(`SELECT "tbl", "name", "cursor", "until" FROM "_ember_indexes"`)
            .rows.map((r) => [`${r.tbl}\u0000${r.name}`, { cursor: Number(r.cursor), until: Number(r.until) }] as const)
        : [],
    );
  }

  private ensureMigrated() {
    if (!this.migrated) this.migrate();
  }

  tableOfId(id: string): string | undefined {
    const p = parseId(id);
    return p ? this.prefixes.get(p.prefix) : undefined;
  }

  functionInfo(name: string): FunctionInfo | undefined {
    const f = this.functions.get(name);
    if (!f) return undefined;
    if (f.type === "httpAction") return { type: f.type, visibility: "public" };
    return f.sensitive ? { type: f.type, visibility: f.visibility, sensitive: true } : { type: f.type, visibility: f.visibility };
  }

  private table(name: string) {
    const t = this.tables.get(name);
    if (!t) throw new EmberError("ValidationError", `Unknown table ${JSON.stringify(name)}`);
    return t;
  }

  private resolve(fn: FnArg, type: "query" | "mutation"): { name: string; fn: AnyRegisteredFunction } {
    if (typeof fn === "object" && fn !== null && "handler" in fn) {
      if (fn.type !== type) throw new EmberError("InvalidFunction", `Expected a ${type}, got a ${fn.type}`);
      return { name: "(inline)", fn };
    }
    const name = getFunctionName(fn as string | AnyFunctionReference);
    const f = this.functions.get(name);
    if (!f) throw new EmberError("FunctionNotFound", `Function ${name} not found`);
    if (f.type !== type) throw new EmberError("InvalidFunction", `${name} is a ${f.type}, not a ${type}`);
    return { name, fn: f };
  }

  private checkArgs(name: string, shape: ObjectShape, args: unknown) {
    const r = validate(shape, args ?? {}, { tableOfId: (id) => this.tableOfId(id) });
    if (!r.ok) throw new EmberError("ValidationError", `Invalid arguments for ${name}: ${r.path}: ${r.message}`, { path: r.path });
  }

  private checkReturns(name: string, shape: Shape | undefined, value: unknown) {
    if (!shape) return;
    const r = validate(shape, value, { tableOfId: (id) => this.tableOfId(id) });
    if (!r.ok) throw new EmberError("ValidationError", `Invalid return value of ${name}: ${r.path}: ${r.message}`, { path: r.path });
  }

  // ------------------------------------------------------------------------------------------ transactions

  private tx(readSet: ReadSet | null) {
    let rowsRead = 0;
    let rowsWritten = 0;
    const { driver, limits } = this;
    const exec = (sql: string, ...params: SqlValue[]): SqlRow[] => {
      const r = driver.exec(sql, ...params);
      rowsRead += r.rowsRead;
      rowsWritten += r.rowsWritten;
      if (rowsRead > limits.rowsRead) throw new EmberError("TooManyReads", `Too many rows read in one transaction (limit ${limits.rowsRead})`);
      if (rowsWritten > limits.rowsWritten) throw new EmberError("TooManyWrites", `Too many rows written in one transaction (limit ${limits.rowsWritten})`);
      return r.rows;
    };
    return { exec, readSet };
  }

  private reader(tx: { exec: QueryEnv["exec"]; readSet: ReadSet | null }, touched?: Set<string>) {
    const getRaw = (id: string): { t: ReturnType<EngineImpl["table"]>; row: SqlRow; doc: Doc } | null => {
      const table = this.tableOfId(id);
      if (!table) return null;
      const t = this.table(table);
      const row = tx.exec(`SELECT * FROM ${q(table)} WHERE "_id" = ?`, id)[0];
      return row ? { t, row, doc: t.decode(row) } : null;
    };
    const getById = (id: string): Doc | null => {
      if (typeof id !== "string") throw new EmberError("ValidationError", "db.get() needs an id string");
      const table = this.tableOfId(id);
      if (!table) return null;
      touched?.add(table);
      if (tx.readSet) {
        const k = docKey({ _id: id } as Doc, ["_id"]);
        tx.readSet.push({ table, index: "by_id", lo: k, hi: Uint8Array.from([...k, 0]), kind: "db" });
      }
      return getRaw(id)?.doc ?? null;
    };
    const env: QueryEnv = {
      exec: tx.exec,
      readSet: tx.readSet,
      table: (name) => this.table(name),
      isStaged: (table, index) => this.staged.has(`${table}\u0000${index}`),
      kinds: this.kinds,
      getById,
    };
    const db = {
      get: getById,
      query: (table: string) => {
        touched?.add(table);
        return new QueryImpl(env, this.table(table));
      },
      normalizeId: (table: string, id: string) => (this.tableOfId(id) === table ? id : null),
      aggregate: (table: string, name: string) => {
        const t = this.table(table);
        const spec = t.aggregates.find((a) => a.name === name);
        if (!spec) throw new EmberError("QueryError", `Aggregate ${table}.${name} not found`);
        if (this.staged.has(`${table}\u0000${name}`)) {
          throw new EmberError("IndexNotReady", `Aggregate ${table}.${name} is still backfilling and cannot be read yet`);
        }
        touched?.add(aggregateTable(table, name));
        return aggregateReader({ exec: tx.exec, readSet: tx.readSet, table, spec, document: t.manifest.document });
      },
      // Read-only SQL; reactivity is table-level: the full key range of every table it references.
      sql: makeSqlReader(
        (c) => {
          const { lo, hi } = rangeFor([]);
          for (const table of c.tables) {
            touched?.add(table);
            tx.readSet?.push({ table, index: "by_creation_time", lo, hi, kind: "db" });
          }
          return tx.exec(c.sql, ...c.params);
        },
        this.tables.keys(),
        (id) => this.tableOfId(id),
      ),
    };
    return { db, getRaw };
  }

  private writer(tx: { exec: QueryEnv["exec"]; readSet: ReadSet | null }, now: number, random: () => number, changes: Map<string, RowChange>) {
    const { db, getRaw } = this.reader(tx);
    const files = new FileStore(tx.exec, this.storageOpts);
    const maintainers = new Map<string, AggregateMaintainer>();
    const maintainer = (t: ReturnType<EngineImpl["table"]>) => {
      let m = maintainers.get(t.name);
      if (!m) {
        m = new AggregateMaintainer(tx.exec, t.name, t.manifest.document, (spec, key, b, a) => {
          const pseudo = aggregateTable(t.name, spec.name);
          const after = a && aggregateDoc(spec, key, a);
          const before = b && aggregateDoc(spec, key, b);
          const id = (after ?? before)!._id;
          const prev = changes.get(`${pseudo}:${id}`);
          changes.set(`${pseudo}:${id}`, { table: pseudo, id, before: prev ? prev.before : before, after });
        });
        maintainers.set(t.name, m);
      }
      return m;
    };
    const record = (table: string, id: string, before: Doc | null, after: Doc | null, rowid: number) => {
      const prev = changes.get(id);
      changes.set(id, { table, id, before: prev ? prev.before : before, after });
      // Aggregates move in the same transaction too, except for rows a staged backfill has not reached yet.
      const ta = this.tables.get(table);
      if (ta?.aggregates.length) {
        for (const spec of ta.aggregates) {
          const w = this.staged.get(`${table}\u0000${spec.name}`);
          if (w && rowid > w.cursor && rowid <= w.until) continue;
          maintainer(ta).apply(spec, before, after);
        }
      }
      // File refcounts move in the same transaction as the document (PLAN §7).
      const t = this.tables.get(table);
      if (t?.hasFiles) {
        const deltas = new Map<string, number>();
        if (before) for (const f of collectFiles(t.manifest.document, before)) deltas.set(f, (deltas.get(f) ?? 0) - 1);
        if (after) for (const f of collectFiles(t.manifest.document, after)) deltas.set(f, (deltas.get(f) ?? 0) + 1);
        files.adjust(deltas, now);
      }
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
    const checkDoc = (t: ReturnType<EngineImpl["table"]>, fields: Record<string, unknown>) => {
      if (this.manifest.schemaValidation) {
        const r = validate(t.manifest.document, fields, { tableOfId: (id) => this.tableOfId(id) });
        if (!r.ok) throw new EmberError("ValidationError", `Document for ${t.name} is invalid: ${r.path}: ${r.message}`, { path: r.path });
      }
      const size = valueSize(fields);
      if (size > this.limits.documentSize) {
        throw new EmberError("DocumentTooLarge", `Document for ${t.name} is ${size} bytes (limit ${this.limits.documentSize})`);
      }
    };
    const normalize = (t: ReturnType<EngineImpl["table"]>, id: string, ct: number, fields: Record<string, unknown>): Doc => {
      const doc: Record<string, unknown> = { _id: id, _creationTime: ct };
      for (const f of t.layout.fieldOrder) if (fields[f] !== undefined) doc[f] = fields[f];
      return doc as Doc;
    };
    const rowValues = (t: ReturnType<EngineImpl["table"]>, doc: Doc): Array<[string, SqlValue]> => {
      const cols = encodeFields(t.layout, doc);
      const out: Array<[string, SqlValue]> = Object.entries(cols);
      for (const i of t.keyIndexes) out.push([keyColumn(i.name), docKey(doc, i.fields)]);
      return out;
    };
    // DO SQLite allows 100 bound parameters per statement: write wide rows in chunks.
    const CHUNK = 90;
    const update = (table: string, rowid: number, values: Array<[string, SqlValue]>) => {
      for (let i = 0; i < values.length; i += CHUNK) {
        const part = values.slice(i, i + CHUNK);
        tx.exec(`UPDATE ${q(table)} SET ${part.map(([c]) => `${q(c)} = ?`).join(", ")} WHERE "_rowid" = ?`, ...part.map(([, x]) => x), rowid);
      }
    };
    const write = {
      ...db,
      insert: (table: string, value: unknown): string => {
        const t = this.table(table);
        const fields = checkFields(value);
        checkDoc(t, fields);
        const ct = (this.lastCreationTime = Math.max(now, this.lastCreationTime + 0.001));
        const id = makeId(t.manifest.idPrefix, ct, random);
        const doc = normalize(t, id, ct, fields);
        const values: Array<[string, SqlValue]> = [["_id", id], ["_creationTime", ct], ...rowValues(t, doc)];
        const first = values.slice(0, CHUNK);
        const inserted = tx.exec(
          `INSERT INTO ${q(table)} (${first.map(([c]) => q(c)).join(", ")}) VALUES (${first.map(() => "?").join(", ")}) RETURNING "_rowid"`,
          ...first.map(([, x]) => x),
        );
        const rowid = Number(inserted[0]!._rowid);
        if (values.length > CHUNK) update(table, rowid, values.slice(CHUNK));
        record(table, id, null, doc, rowid);
        return id;
      },
      patch: (id: string, value: unknown) => {
        const cur = getRaw(id);
        if (!cur) throw new EmberError("NotFound", `Document ${id} not found`);
        const { _id, _creationTime, ...old } = cur.doc;
        const partial = checkFields(value, cur.doc);
        const fields: Record<string, unknown> = { ...old };
        for (const [k, x] of Object.entries(partial)) {
          if (x === undefined) delete fields[k];
          else fields[k] = x;
        }
        checkDoc(cur.t, fields);
        const doc = normalize(cur.t, _id, _creationTime, fields);
        update(cur.t.name, Number(cur.row._rowid), rowValues(cur.t, doc));
        record(cur.t.name, id, cur.doc, doc, Number(cur.row._rowid));
      },
      replace: (id: string, value: unknown) => {
        const cur = getRaw(id);
        if (!cur) throw new EmberError("NotFound", `Document ${id} not found`);
        const fields = Object.fromEntries(Object.entries(checkFields(value, cur.doc)).filter(([, x]) => x !== undefined));
        checkDoc(cur.t, fields);
        const doc = normalize(cur.t, cur.doc._id, cur.doc._creationTime, fields);
        update(cur.t.name, Number(cur.row._rowid), rowValues(cur.t, doc));
        record(cur.t.name, id, cur.doc, doc, Number(cur.row._rowid));
      },
      delete: (id: string) => {
        const cur = getRaw(id);
        if (!cur) throw new EmberError("NotFound", `Document ${id} not found`);
        tx.exec(`DELETE FROM ${q(cur.t.name)} WHERE "_rowid" = ?`, Number(cur.row._rowid));
        record(cur.t.name, id, cur.doc, null, Number(cur.row._rowid));
      },
      /**
       * Adds `delta` to a numeric (number or int64) top-level field, read and written by the engine in this
       * transaction: no read of the document in user code. A missing field counts as 0. Returns the new value.
       */
      increment: (id: string, field: string, delta: number | bigint): number | bigint => {
        if (typeof field !== "string" || !field || field.startsWith("_") || field.includes(".")) {
          throw new EmberError("ValidationError", "increment() needs a top-level, non-system field name");
        }
        if (typeof delta === "number" ? !Number.isFinite(delta) : typeof delta !== "bigint") {
          throw new EmberError("ValidationError", "increment() needs a finite number or a bigint delta");
        }
        const cur = getRaw(id);
        if (!cur) throw new EmberError("NotFound", `Document ${id} not found`);
        const x = cur.doc[field];
        let next: number | bigint;
        if (typeof delta === "bigint") {
          if (x !== undefined && typeof x !== "bigint") throw new EmberError("ValidationError", `increment(): ${field} is not an int64`);
          next = (x ?? 0n) + delta;
        } else {
          if (x !== undefined && typeof x !== "number") throw new EmberError("ValidationError", `increment(): ${field} is not a number`);
          next = ((x as number | undefined) ?? 0) + delta;
        }
        write.patch(id, { [field]: next });
        return next;
      },
    };
    return write;
  }

  private storageReader(files: FileStore, now: number): StorageReader {
    return {
      getUrl: (id, o) => files.getUrl(id, o ?? {}, now),
      getMetadata: (id) => files.getMetadata(id),
    };
  }

  private authOf(ctx: AuthCtx | undefined) {
    const identity = ctx?.identity ?? null;
    return { getUserIdentity: () => identity };
  }

  // ------------------------------------------------------------------------------------------ functions

  runQuery(name: FnArg, args: unknown = {}, ctx: AuthCtx = ANON, opts?: RunQueryOptions): QueryResult {
    this.ensureMigrated();
    const { name: fnName, fn } = this.resolve(name, "query");
    this.checkArgs(fnName, fn.args, args);
    const readSet: ReadSet = [];
    const tx = this.tx(readSet);
    const { db } = this.reader(tx, opts?.touched);
    const now = this.now();
    const storage = this.storageReader(new FileStore(tx.exec, this.storageOpts), now);
    const value = fn.handler({ db, auth: this.authOf(ctx), now, storage }, args ?? {});
    if (isThenable(value)) {
      Promise.resolve(value).catch(() => {});
      throw new EmberError("AsyncHandler", `Query ${fnName} returned a Promise: query handlers must be synchronous`);
    }
    this.checkReturns(fnName, fn.returns, value);
    return { value, readSet };
  }

  runMutation(name: FnArg, args: unknown = {}, ctx: AuthCtx = ANON): MutationResult {
    this.ensureMigrated();
    const { name: fnName, fn } = this.resolve(name, "mutation");
    return this.driver.transaction(() => this.mutate(fnName, fn, args, ctx));
  }

  runMutationBatch(items: MutationBatchItem[]): MutationBatchResult[] {
    this.ensureMigrated();
    return this.driver.transaction(() =>
      items.map((item): MutationBatchResult => {
        try {
          const { name, fn } = this.resolve(item.name, "mutation");
          return { ok: true, ...this.driver.transaction(() => this.mutate(name, fn, item.args, item.ctx)) };
        } catch (e) {
          const { code, message } = errorInfo(e);
          return { ok: false, error: { code, message } };
        }
      }),
    );
  }

  private mutate(fnName: string, fn: AnyRegisteredFunction, args: unknown, ctx: AuthCtx | undefined): MutationResult {
    this.checkArgs(fnName, fn.args, args);
    const now = this.now();
    const random = seededRandom(Math.floor(this.random() * 2 ** 32));
    const changes = new Map<string, RowChange>();
    const scheduled: Job[] = [];
    const cancelled: string[] = [];
    const tx = this.tx(null);
    const db = this.writer(tx, now, random, changes);
    const files = new FileStore(tx.exec, this.storageOpts);
    const storage: StorageWriter = {
      ...this.storageReader(files, now),
      generateUploadUrl: (o) => files.generateUploadUrl(o ?? {}, now),
      delete: (id) => files.delete(id, now),
    };
    const schedule = (runAt: number, ref: unknown, jobArgs: unknown): string => {
      const target = getFunctionName(ref as string | AnyFunctionReference);
      const f = this.functions.get(target);
      if (!f) throw new EmberError("FunctionNotFound", `Cannot schedule ${target}: function not found`);
      if (f.type !== "mutation" && f.type !== "action") throw new EmberError("InvalidFunction", `Cannot schedule ${target}: only mutations and actions can be scheduled`);
      this.checkArgs(target, f.args, jobArgs ?? {});
      if (!Number.isFinite(runAt)) throw new EmberError("ValidationError", "Scheduled time must be a finite number");
      const id = makeId("job", now, random);
      scheduled.push({ id, fn: target, args: jobArgs ?? {}, runAt, kind: f.type });
      return id;
    };
    const scheduler = {
      runAfter: (delayMs: number, ref: unknown, jobArgs?: unknown) => schedule(now + Math.max(0, delayMs), ref, jobArgs),
      runAt: (ts: number | Date, ref: unknown, jobArgs?: unknown) => schedule(ts instanceof Date ? ts.getTime() : ts, ref, jobArgs),
      cancel: (id: string) => {
        if (typeof id !== "string" || !id) throw new EmberError("ValidationError", "scheduler.cancel() needs a job id");
        const i = scheduled.findIndex((j) => j.id === id);
        if (i >= 0) scheduled.splice(i, 1);
        else if (!cancelled.includes(id)) cancelled.push(id);
      },
    };
    const value = fn.handler({ db, auth: this.authOf(ctx), now, random, scheduler, storage }, args ?? {});
    if (isThenable(value)) {
      Promise.resolve(value).catch(() => {});
      throw new EmberError("AsyncHandler", `Mutation ${fnName} returned a Promise: mutation handlers must be synchronous`);
    }
    this.checkReturns(fnName, fn.returns, value);
    // A row inserted and deleted by the same mutation is no change at all (nor is an aggregate that came back).
    const out = [...changes.values()].filter(
      (c) => (c.before || c.after) && (this.tables.has(c.table) || !c.before || !c.after || stringifyValue(c.before) !== stringifyValue(c.after)),
    );
    return { value, changes: out, scheduled, cancelled };
  }

  // ------------------------------------------------------------------------------------------ reactivity

  matches(readSet: ReadSet, changes: RowChange[]): boolean {
    const helpers: MatchHelpers = { field: (doc, path) => fieldOf(doc, path) };
    for (const change of changes) {
      const keyCache = new Map<string, [Uint8Array | null, Uint8Array | null]>();
      for (const entry of readSet) {
        if (entry.table !== change.table) continue;
        if (entry.kind === "db") {
          const fields = readSetFields(this.manifest, entry.table, entry.index);
          if (!fields) return true;
          let keys = keyCache.get(entry.index);
          if (!keys) {
            keys = [change.before && docKey(change.before, fields), change.after && docKey(change.after, fields)];
            keyCache.set(entry.index, keys);
          }
          // Before in range: the row may leave (or change inside) the result; after in range: it may enter.
          const [kb, ka] = keys;
          if (kb && inKeyRange(kb, entry.lo, entry.hi) && passes(entry.filter, change.before!)) return true;
          if (ka && inKeyRange(ka, entry.lo, entry.hi) && passes(entry.filter, change.after!)) return true;
        } else {
          if (!this.tables.has(entry.table)) return true;
          const kind = this.kinds.get(entry.kind);
          if (!kind?.matchesChange || kind.matchesChange(entry, change, helpers)) return true;
        }
      }
    }
    return false;
  }
}
