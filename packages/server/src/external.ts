// External index kinds (PLAN §6): indexes that live outside the shard's SQLite — Vectorize (`.vectorIndex()`) and
// AI Search (`.aiSearchIndex()`). They are written through a per-shard outbox and queried only from actions.
//
// Outbox (`_ember_ext_outbox`, one row per (table, index, document)):
// - The engine upserts a row in the mutation's own transaction whenever a write changes one of the index's fields
//   (insert, delete, or a patch/replace touching them). Rows coalesce: ten edits to a document before it is
//   delivered are one row. `seq` is a fresh random token per write.
// - Staged backfill (a new or changed index on a table with data) inserts one row per existing document, through
//   the generic `backfill` statement of the kind; live writes skip rows in the backfill window like aggregates do.
// - The runtime delivers rows (Queue → consumer, or in-process without a queue). A claim marks rows in flight with
//   a fresh random *claim token* (`sent = claim`) carried in the message. The consumer reads the *current*
//   document state when it runs (`outboxFetch`, which also says whether the message's claim is still the row's
//   current one), writes it to the service, and acknowledges (`outboxAck`) the `seq` it read under its claim.
// - Rows never acknowledged are re-sent after `resendMs` under a new claim, so two deliveries of one document can
//   overlap (the first one only slow, not dead). An external write cannot be made conditional, so the ack fences:
//     current claim, same seq          → done (row deleted): nothing changed since the fetch, and no other delivery
//                                        wrote after this one (it would have to be claimed after this ack).
//     current claim, seq changed       → pending again (a write since the fetch): re-delivered with the new state.
//     claim superseded                 → this write may have landed after a newer delivery's: the row gets a fresh
//                                        seq (attempts kept; a parked row stays parked), so the newer delivery's
//                                        own ack sends it again.
//     row gone                         → (a newer delivery was acknowledged) re-enqueued like a document write, so
//                                        a delivery claimed after this ack rewrites the latest state.
//   A delivery whose claim is already superseded when it fetches skips the document (no write, no ack).
//   Invariant: the last write to the service for a document is always followed by a delivery of its newest state.
//   After `maxAttempts` sends a row is parked (`sent = -1`) until the document changes again.
//
// The kind's `external.document(spec, doc)` turns a document into what the service stores (vector values or text
// to embed, AI Search text, filter metadata); null means "not indexable" (field missing) and deletes it remotely.

import { compareValues, type JSONValue } from "@freecorps/ember-values";
import { lit, q, type SqlDriver, type SqlRow, type SqlValue } from "./driver.ts";
import { readStorage, selectById, type TableStorage } from "./storage.ts";
import type { IndexKind } from "./indexKinds.ts";
import { decodeRow, fieldOf, layoutOf, type Layout } from "./layout.ts";
import type { SchemaManifest } from "./schema.ts";
import type { Doc, IndexSpec, TableLayout } from "./types.ts";

export const OUTBOX_TABLE = "_ember_ext_outbox";

export const OUTBOX_DDL = [
  `CREATE TABLE IF NOT EXISTS "${OUTBOX_TABLE}" ("tbl" TEXT NOT NULL, "idx" TEXT NOT NULL, "doc_id" TEXT NOT NULL, "seq" INTEGER NOT NULL, "sent" INTEGER NOT NULL DEFAULT 0, "sent_at" INTEGER NOT NULL DEFAULT 0, "attempts" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("tbl", "idx", "doc_id")) STRICT, WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS "${OUTBOX_TABLE}_sent" ON "${OUTBOX_TABLE}" ("sent", "sent_at")`,
];

/** Metadata values the external services can filter on. */
export type MetadataValue = string | number | boolean;

/** What an external index stores for one document. */
export interface ExternalDocument {
  /** Vector values (vectorIndex without `embed`). */
  values?: number[];
  /** Text to embed (vectorIndex with `embed`) or to index (aiSearchIndex). */
  text?: string;
  /** Filter fields (absent fields are omitted). */
  metadata: Record<string, MetadataValue>;
}

export interface ExternalIndexSupport {
  /** The service the runtime routes the index to, e.g. "vectorize" or "aiSearch". */
  service: string;
  /** Document fields whose change re-indexes the document (paths). */
  fields(spec: IndexSpec): string[];
  /** The stored form of a document, or null when it cannot be indexed (it is then deleted remotely). */
  document(spec: IndexSpec, doc: Doc): ExternalDocument | null;
}

/** An index kind whose data lives outside SQLite (queried from actions only). */
export type ExternalIndexKind = IndexKind & { external: ExternalIndexSupport };

export const isExternalKind = (k: IndexKind | undefined): k is ExternalIndexKind =>
  !!k && typeof (k as { external?: unknown }).external === "object" && (k as { external?: unknown }).external !== null;

/** External indexes of a manifest: `{ table, spec, kind }` (stable order). */
export function externalIndexes(m: SchemaManifest, kinds: ReadonlyMap<string, IndexKind>): Array<{ table: string; spec: IndexSpec; kind: ExternalIndexKind }> {
  const out: Array<{ table: string; spec: IndexSpec; kind: ExternalIndexKind }> = [];
  for (const [table, t] of Object.entries(m.tables)) {
    for (const spec of t.indexes) {
      const kind = kinds.get(spec.kind);
      if (isExternalKind(kind)) out.push({ table, spec, kind });
    }
  }
  return out;
}

/**
 * A write to a row already in the outbox: new seq, attempts reset, and a parked row (sent < 0) revived as pending
 * with `sent_at` = 0, like a released or freshly enqueued one. Every pending row then sits at (sent = 0, sent_at = 0),
 * where `outboxAck`'s count seeks by (tbl, idx); a row in flight keeps its claim and its sent_at.
 */
const ENQUEUE_CONFLICT =
  `ON CONFLICT ("tbl", "idx", "doc_id") DO UPDATE SET "seq" = excluded."seq", "attempts" = 0, ` +
  `"sent" = CASE WHEN "sent" < 0 THEN 0 ELSE "sent" END, "sent_at" = CASE WHEN "sent" < 0 THEN 0 ELSE "sent_at" END`;

/** The `backfill` statement of every external kind: one outbox row per document in the window. */
export function externalBackfill(layout: TableLayout, spec: IndexSpec): string {
  return (
    `INSERT INTO "${OUTBOX_TABLE}" ("tbl", "idx", "doc_id", "seq") SELECT ${lit(layout.table)}, ${lit(spec.name)}, "_id", ((random() & 9007199254740990) + 1) ` +
    `FROM ${q(layout.table)} WHERE "_rowid" > ?1 AND "_rowid" <= ?2 ${ENQUEUE_CONFLICT}`
  );
}
const ENQUEUE_SQL = `INSERT INTO "${OUTBOX_TABLE}" ("tbl", "idx", "doc_id", "seq") VALUES (?, ?, ?, ((random() & 9007199254740990) + 1)) ${ENQUEUE_CONFLICT}`;

/** True when a write from `before` to `after` must re-index the document for an index over `fields`. */
export function externalChanged(fields: string[], before: Doc | null, after: Doc | null): boolean {
  if (!before || !after) return before !== after;
  return fields.some((f) => compareValues(fieldOf(before, f), fieldOf(after, f)) !== 0);
}

/** Drops every outbox row of an index that no longer exists (removed or renamed): nothing can deliver them. */
export function outboxForget(driver: SqlDriver, table: string, index: string): void {
  driver.exec(`DELETE FROM "${OUTBOX_TABLE}" WHERE "tbl" = ? AND "idx" = ?`, table, index);
}

/** Engine hook: records a write in the outbox (same transaction). */
export function outboxEnqueue(exec: (sql: string, ...p: SqlValue[]) => unknown, table: string, index: string, docId: string): void {
  exec(ENQUEUE_SQL, table, index, docId);
}

// ------------------------------------------------------------------------------------------------ delivery

export interface OutboxBatch {
  table: string;
  index: string;
  ids: string[];
  /** Claim token of the rows (fencing): pass it to `outboxFetch` / `outboxAck`. */
  claim: number;
}

export interface OutboxOptions {
  /** Re-send an unacknowledged row after this long (default 10 min). */
  resendMs?: number;
  /** Park a row after this many sends without an ack (default 10). */
  maxAttempts?: number;
  /** Documents per message (default 50). */
  batchSize?: number;
  /** Rows claimed per call (default 500). */
  limit?: number;
}

export const OUTBOX_DEFAULTS = { resendMs: 10 * 60_000, maxAttempts: 10, batchSize: 50, limit: 500 } as const;

/**
 * Bound parameters per statement of the batched outbox writes (`doc_id IN (…)` lists): under the 100 a Durable
 * Object's SQLite accepts, with room for the fixed ones.
 */
export const OUTBOX_MAX_PARAMS = 90;

/** `outboxAck` counts pending rows of the index up to this (its caller only tests > 0). */
export const OUTBOX_PENDING_CAP = 100;

/**
 * Drivers whose database is known to hold the outbox. It is created with the system tables by every migration
 * (`SYSTEM_DDL`) and a shard never drops it, so a table seen once stays (a point-in-time restore restarts the object,
 * with a new driver). Until then — a fresh object whose first migration was refused — every call checks
 * sqlite_master. Should it go anyway (a local database wiped, `wipeLocalDatabase`), the first statement fails, the
 * driver is forgotten and the call answers as without an outbox (`ifOutbox`).
 */
const outboxSeen = new WeakSet<SqlDriver>();

function hasOutbox(driver: SqlDriver): boolean {
  if (outboxSeen.has(driver)) return true;
  const found = driver.exec(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '${OUTBOX_TABLE}'`).rows.length > 0;
  if (found) outboxSeen.add(driver);
  return found;
}

const NO_OUTBOX = new RegExp(`no such table: (?:main\\.)?"?${OUTBOX_TABLE}\\b`, "i");

/** `run()` when the outbox exists, else `none`. `run` must read the outbox first (a missing table fails before any write). */
function ifOutbox<R>(driver: SqlDriver, none: R, run: () => R): R {
  if (!hasOutbox(driver)) return none;
  try {
    return run();
  } catch (e) {
    if (!NO_OUTBOX.test(String((e as Error | null)?.message ?? e))) throw e;
    outboxSeen.delete(driver);
    if (hasOutbox(driver)) throw e;
    return none;
  }
}

/** `?, ?, …` (n placeholders). */
const marks = (n: number) => (n === 1 ? "?" : `?${", ?".repeat(n - 1)}`);

/** Runs `run(chunk)` over `items` in chunks that keep a statement with `fixed` other parameters within the limit. */
function inChunks<T>(items: readonly T[], perItem: number, fixed: number, run: (chunk: T[]) => void): void {
  const size = Math.max(1, Math.floor((OUTBOX_MAX_PARAMS - fixed) / perItem));
  for (let i = 0; i < items.length; i += size) run(items.slice(i, i + size));
}

/** `sql(marks)` over `ids` of one (table, index), chunked: `… "tbl" = ? AND "idx" = ? AND "doc_id" IN (<marks>) …`. */
function execIds(driver: SqlDriver, ids: readonly string[], before: SqlValue[], sql: (m: string) => string, after: SqlValue[] = []): SqlRow[] {
  const out: SqlRow[] = [];
  inChunks(ids, 1, before.length + after.length, (chunk) => {
    for (const r of driver.exec(sql(marks(chunk.length)), ...before, ...chunk, ...after).rows) out.push(r);
  });
  return out;
}

const KEY = `"tbl" = ? AND "idx" = ? AND "doc_id" IN`;

/**
 * Claims deliverable rows (pending, or in flight for longer than `resendMs`) and marks them in flight. Rows of
 * indexes no longer in the manifest are dropped. Returns batches of at most `batchSize` ids per (table, index), plus
 * the rows parked now (too many attempts). Call inside a transaction.
 *
 * One read of the rows, then one write per (table, index) and outcome per `OUTBOX_MAX_PARAMS` ids (not one per row).
 */
export function outboxClaim(
  driver: SqlDriver,
  m: SchemaManifest,
  kinds: ReadonlyMap<string, IndexKind>,
  now: number,
  o: OutboxOptions = {},
): { batches: OutboxBatch[]; parked: Array<{ table: string; index: string; id: string }> } {
  const { resendMs, maxAttempts, batchSize, limit } = { ...OUTBOX_DEFAULTS, ...o };
  const rows = ifOutbox(driver, [] as SqlRow[], () => driver.exec(
    `SELECT "tbl", "idx", "doc_id", "attempts" FROM "${OUTBOX_TABLE}" WHERE "sent" = 0 OR ("sent" > 0 AND "sent_at" <= ?) ORDER BY "sent_at", "tbl", "idx" LIMIT ?`,
    now - resendMs,
    limit,
  ).rows);
  if (!rows.length) return { batches: [], parked: [] };
  const known = new Set(externalIndexes(m, kinds).map((x) => `${x.table}\u0000${x.spec.name}`));
  // Per (table, index), in the order read: ids to drop, to park and to claim.
  const groups = new Map<string, { table: string; index: string; drop: string[]; park: string[]; claim: string[] }>();
  const parked: Array<{ table: string; index: string; id: string }> = [];
  for (const r of rows) {
    const table = String(r.tbl);
    const index = String(r.idx);
    const id = String(r.doc_id);
    const key = `${table}\u0000${index}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { table, index, drop: [], park: [], claim: [] }));
    if (!known.has(key)) g.drop.push(id);
    else if (Number(r.attempts) >= maxAttempts) {
      g.park.push(id);
      parked.push({ table, index, id });
    } else g.claim.push(id);
  }
  const claimed = [...groups.values()].some((g) => g.claim.length > 0);
  const claim = claimed ? Number(driver.exec(`SELECT ((random() & 9007199254740990) + 1) AS c`).rows[0]!.c) : 0;
  const batches: OutboxBatch[] = [];
  for (const g of groups.values()) {
    const k: SqlValue[] = [g.table, g.index];
    execIds(driver, g.drop, k, (ms) => `DELETE FROM "${OUTBOX_TABLE}" WHERE ${KEY} (${ms})`);
    execIds(driver, g.park, k, (ms) => `UPDATE "${OUTBOX_TABLE}" SET "sent" = -1 WHERE ${KEY} (${ms})`);
    execIds(driver, g.claim, [claim, now, ...k], (ms) => `UPDATE "${OUTBOX_TABLE}" SET "sent" = ?, "sent_at" = ?, "attempts" = "attempts" + 1 WHERE ${KEY} (${ms})`);
    for (let i = 0; i < g.claim.length; i += batchSize) batches.push({ table: g.table, index: g.index, ids: g.claim.slice(i, i + batchSize), claim });
  }
  return { batches, parked };
}

/** Gives claimed rows back (delivery failed before reaching the queue). */
export function outboxRelease(driver: SqlDriver, batch: OutboxBatch): void {
  execIds(driver, batch.ids, [batch.table, batch.index], (ms) => `UPDATE "${OUTBOX_TABLE}" SET "sent" = 0, "sent_at" = 0 WHERE ${KEY} (${ms}) AND "sent" > 0`);
}

/** Delivery failed before reaching the queue: keep the rows in flight but re-send them at `retryAt`. */
export function outboxDefer(driver: SqlDriver, batch: OutboxBatch, retryAt: number, resendMs: number = OUTBOX_DEFAULTS.resendMs): void {
  execIds(driver, batch.ids, [retryAt - resendMs, batch.table, batch.index], (ms) => `UPDATE "${OUTBOX_TABLE}" SET "sent_at" = ? WHERE ${KEY} (${ms}) AND "sent" > 0`);
}

export interface FetchedItem {
  id: string;
  /** The outbox seq read with this state (pass it back to `outboxAck`); null when the row is gone (nothing to ack). */
  seq: number | null;
  /** Current stored form; null = delete remotely (document gone or not indexable). */
  doc: ExternalDocument | null;
  /**
   * False when the delivery's claim is no longer the row's (re-sent meanwhile, or already acknowledged): the
   * consumer skips the document — a newer delivery owns it — and does not acknowledge it.
   */
  current: boolean;
}

/**
 * Current state of `ids` for an external index under `claim` (the consumer calls this when it runs). The outbox rows
 * are read first, in one statement per `OUTBOX_MAX_PARAMS` ids; only documents still under this claim are read.
 */
export function outboxFetch(
  driver: SqlDriver,
  m: SchemaManifest,
  kinds: ReadonlyMap<string, IndexKind>,
  table: string,
  index: string,
  ids: string[],
  claim: number | null | undefined,
): { spec: IndexSpec; items: FetchedItem[] } {
  const t = m.tables[table];
  const spec = t?.indexes.find((i) => i.name === index);
  const kind = spec && kinds.get(spec.kind);
  if (!t || !spec || !isExternalKind(kind)) throw Object.assign(new Error(`Unknown external index ${table}.${index}`), { code: "IndexNotFound" });
  const rows = readOutboxRows(driver, table, index, ids);
  const exec = (sql: string, ...p: SqlValue[]) => driver.exec(sql, ...p).rows;
  let read: { layout: Layout; storage: TableStorage } | undefined;
  const items: FetchedItem[] = [];
  for (const id of ids) {
    const ob = rows.get(id);
    const current = !!ob && claim != null && ob.sent === claim;
    let doc: ExternalDocument | null = null;
    if (current) {
      read ??= { layout: layoutOf(table, t.document), storage: readStorage(exec, table) };
      const row = selectById(exec, table, read.storage, id);
      if (row) {
        try {
          doc = kind.external.document(spec, decodeRow(read.layout, row));
        } catch {
          doc = null;
        }
      }
    }
    items.push({ id, seq: ob ? ob.seq : null, doc, current });
  }
  return { spec, items };
}

/** The outbox rows of `ids` (absent = no row), chunked. */
function readOutboxRows(driver: SqlDriver, table: string, index: string, ids: readonly string[]): Map<string, { seq: number; sent: number }> {
  const out = new Map<string, { seq: number; sent: number }>();
  const unique = [...new Set(ids)];
  for (const r of execIds(driver, unique, [table, index], (ms) => `SELECT "doc_id", "seq", "sent" FROM "${OUTBOX_TABLE}" WHERE ${KEY} (${ms})`)) {
    out.set(String(r.doc_id), { seq: Number(r.seq), sent: Number(r.sent) });
  }
  return out;
}

/**
 * Acknowledges states written to the service under `claim` (see the fencing rules at the top): a row still at this
 * claim and seq is done (deleted); a row still at this claim but written since is pending again; a row whose claim
 * was superseded (or that is gone) is re-enqueued, because this write may have overwritten a newer one. Returns how
 * many rows are pending for this index, counted up to `OUTBOX_PENDING_CAP` (the caller only needs to know if any).
 *
 * Batched: the common case (every row still at this claim and seq) is one DELETE per `OUTBOX_MAX_PARAMS` parameters;
 * the others take one read and one write per outcome. An id acknowledged twice in one call is handled as two calls
 * in a row (the second sees the first one's effect), as the per-row loop did.
 */
export function outboxAck(driver: SqlDriver, table: string, index: string, acks: Array<{ id: string; seq: number | null }>, claim: number | null | undefined): number {
  let rest = acks;
  while (rest.length) {
    const seen = new Set<string>();
    const round: Array<{ id: string; seq: number | null }> = [];
    const later: Array<{ id: string; seq: number | null }> = [];
    for (const a of rest) {
      if (seen.has(a.id)) later.push(a);
      else {
        seen.add(a.id);
        round.push(a);
      }
    }
    ackRound(driver, table, index, round, claim);
    rest = later;
  }
  // Pending rows of this index: a seek on the `sent` index, whose entries end with the primary key (WITHOUT ROWID), so
  // (sent = 0, sent_at = 0, tbl, idx) reads only this index's rows, at most OUTBOX_PENDING_CAP. Every pending row has
  // sent_at = 0 (ENQUEUE_CONFLICT); the two other ranges only hold parked rows revived by an older version (they kept
  // their old sent_at, and leave the range at their next claim). Those seeks bind only `sent_at`, so they read such
  // rows of every index (the LIMIT caps matches, not rows read): empty in steady state, bounded by that legacy backlog.
  const pending = (cmp: string) =>
    `(SELECT count(*) FROM (SELECT 1 FROM "${OUTBOX_TABLE}" INDEXED BY "${OUTBOX_TABLE}_sent" WHERE "sent" = 0 AND "sent_at" ${cmp} AND "tbl" = ?1 AND "idx" = ?2 LIMIT ?3))`;
  const n = driver.exec(`SELECT ${pending("= 0")} + ${pending("> 0")} + ${pending("< 0")} AS n`, table, index, OUTBOX_PENDING_CAP).rows[0]!.n;
  return Math.min(Number(n), OUTBOX_PENDING_CAP);
}

/** One `outboxAck` pass over distinct ids. */
function ackRound(driver: SqlDriver, table: string, index: string, acks: Array<{ id: string; seq: number | null }>, claim: number | null | undefined): void {
  const k: SqlValue[] = [table, index];
  // The common case first: rows still this claim's at the seq delivered, deleted by (doc_id, seq) pairs.
  const done = new Set<string>();
  if (claim != null) {
    const withSeq = acks.filter((a) => a.seq !== null);
    inChunks(withSeq, 2, 3, (chunk) => {
      const pairs = chunk.map(() => "(?, ?)").join(", ");
      const params = chunk.flatMap((a) => [a.id, a.seq as number]);
      const gone = driver.exec(`DELETE FROM "${OUTBOX_TABLE}" WHERE "tbl" = ? AND "idx" = ? AND "sent" = ? AND ("doc_id", "seq") IN (VALUES ${pairs}) RETURNING "doc_id"`, ...k, claim, ...params).rows;
      for (const r of gone) done.add(String(r.doc_id));
    });
  }
  const left = acks.filter((a) => !done.has(a.id));
  if (!left.length) return;
  const rows = readOutboxRows(driver, table, index, left.map((a) => a.id));
  const remove: string[] = [];
  const again: string[] = [];
  const bump: string[] = [];
  const enqueue: string[] = [];
  for (const a of left) {
    const row = rows.get(a.id);
    const mine = !!row && claim != null && row.sent === claim;
    if (mine && a.seq !== null && row!.seq === a.seq) remove.push(a.id);
    else if (mine) again.push(a.id); // written since the fetch: pending again, re-delivered with the new state
    else if (row) bump.push(a.id);
    else enqueue.push(a.id); // already delivered and dropped: deliver the newest state once more
  }
  execIds(driver, remove, k, (ms) => `DELETE FROM "${OUTBOX_TABLE}" WHERE ${KEY} (${ms})`);
  execIds(driver, again, k, (ms) => `UPDATE "${OUTBOX_TABLE}" SET "sent" = 0, "sent_at" = 0 WHERE ${KEY} (${ms})`);
  // Superseded while this write was in flight: bump the seq so the newer delivery's own ack sends the row again.
  // Attempts are kept and a parked row stays parked (a later document write revives it), so a document that keeps
  // failing cannot be revived forever by stale acks. random() is evaluated per row.
  execIds(driver, bump, k, (ms) => `UPDATE "${OUTBOX_TABLE}" SET "seq" = ((random() & 9007199254740990) + 1) WHERE ${KEY} (${ms}) AND "sent" >= 0`);
  inChunks(enqueue, 1, 2, (chunk) => {
    const values = chunk.map((_, i) => `(?1, ?2, ?${i + 3}, ((random() & 9007199254740990) + 1))`).join(", ");
    driver.exec(`INSERT INTO "${OUTBOX_TABLE}" ("tbl", "idx", "doc_id", "seq") VALUES ${values} ${ENQUEUE_CONFLICT}`, ...k, ...chunk);
  });
}

/**
 * When the outbox next needs attention: `now` (pending rows), the earliest re-send, or null (empty / all parked).
 * `now` is only returned as is, never added to: the shard reads this at 0 and caches it (`armAlarm`).
 */
export function outboxNextAt(driver: SqlDriver, now: number, resendMs: number = OUTBOX_DEFAULTS.resendMs): number | null {
  const r = ifOutbox(driver, null, () =>
    driver.exec(`SELECT (SELECT 1 FROM "${OUTBOX_TABLE}" WHERE "sent" = 0 LIMIT 1) AS pending, (SELECT min("sent_at") FROM "${OUTBOX_TABLE}" WHERE "sent" > 0) AS inflight`).rows[0]!,
  );
  if (!r) return null;
  if (r.pending !== null) return now;
  return r.inflight === null ? null : Number(r.inflight) + resendMs;
}

export interface OutboxStats {
  pending: number;
  inFlight: number;
  parked: number;
}

export function outboxStats(driver: SqlDriver): OutboxStats {
  const r = ifOutbox(driver, null, () =>
    driver.exec(`SELECT coalesce(sum("sent" = 0), 0) AS p, coalesce(sum("sent" > 0), 0) AS f, coalesce(sum("sent" < 0), 0) AS d FROM "${OUTBOX_TABLE}"`).rows[0]!,
  );
  if (!r) return { pending: 0, inFlight: 0, parked: 0 };
  return { pending: Number(r.p), inFlight: Number(r.f), parked: Number(r.d) };
}

// ------------------------------------------------------------------------------------------------ filters

/** Vectorize / AI Search filter operators (a subset both services support). */
export type FilterOp<T> = { $eq?: T; $ne?: T; $in?: T[]; $nin?: T[]; $lt?: T; $lte?: T; $gt?: T; $gte?: T };
export type MetadataFilter = Record<string, MetadataValue | FilterOp<MetadataValue>>;

const OPS = new Set(["$eq", "$ne", "$in", "$nin", "$lt", "$lte", "$gt", "$gte"]);

/** Validates a filter against an index's filter fields; returns it with field paths mapped to metadata keys. */
export function normalizeFilter(filter: unknown, allowed: Record<string, string>, where: string): MetadataFilter | undefined {
  if (filter === undefined || filter === null) return undefined;
  if (typeof filter !== "object" || Array.isArray(filter)) throw new Error(`${where}: filter must be an object { field: value | { $op: value } }`);
  const out: MetadataFilter = {};
  for (const [field, cond] of Object.entries(filter as Record<string, unknown>)) {
    const key = allowed[field];
    if (!key) throw new Error(`${where}: ${field} is not a filter field (filterFields: ${Object.keys(allowed).join(", ") || "none"})`);
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, x] of Object.entries(cond)) {
        if (!OPS.has(op)) throw new Error(`${where}: unknown operator ${op} (use ${[...OPS].join(", ")})`);
        if ((op === "$in" || op === "$nin") !== Array.isArray(x)) throw new Error(`${where}: ${op} needs ${op === "$in" || op === "$nin" ? "an array" : "a value"}`);
        for (const v of Array.isArray(x) ? x : [x]) checkScalar(v, `${where}: ${field}.${op}`);
      }
      out[key] = cond as FilterOp<MetadataValue>;
    } else {
      checkScalar(cond, `${where}: ${field}`);
      out[key] = cond as MetadataValue;
    }
  }
  return out;
}

function checkScalar(v: unknown, where: string) {
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") throw new Error(`${where}: filter values must be strings, numbers or booleans`);
}

/** Evaluates a (normalized) filter on stored metadata (the local fallback; same semantics as Vectorize). */
export function matchesFilter(meta: Record<string, MetadataValue>, filter: MetadataFilter | undefined): boolean {
  if (!filter) return true;
  for (const [key, cond] of Object.entries(filter)) {
    const x = meta[key];
    const c = cond !== null && typeof cond === "object" ? (cond as FilterOp<MetadataValue>) : { $eq: cond as MetadataValue };
    const cmp = (y: MetadataValue) => (x === undefined ? NaN : typeof x === typeof y ? (x < y ? -1 : x > y ? 1 : 0) : NaN);
    if (c.$eq !== undefined && cmp(c.$eq) !== 0) return false;
    if (c.$ne !== undefined && cmp(c.$ne) === 0) return false;
    if (c.$in !== undefined && !c.$in.some((y) => cmp(y) === 0)) return false;
    if (c.$nin !== undefined && c.$nin.some((y) => cmp(y) === 0)) return false;
    if (c.$lt !== undefined && !(cmp(c.$lt) < 0)) return false;
    if (c.$lte !== undefined && !(cmp(c.$lte) <= 0)) return false;
    if (c.$gt !== undefined && !(cmp(c.$gt) > 0)) return false;
    if (c.$gte !== undefined && !(cmp(c.$gte) >= 0)) return false;
  }
  return true;
}

/** Metadata of the filter fields of a document (missing / non-scalar values are omitted). */
export function metadataOf(doc: Doc, fields: string[], key: (field: string) => string = (f) => f): Record<string, MetadataValue> {
  const out: Record<string, MetadataValue> = {};
  for (const f of fields) {
    const x = fieldOf(doc, f);
    if (typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))) out[key(f)] = x;
    else if (typeof x === "bigint") out[key(f)] = Number(x);
  }
  return out;
}

export type { JSONValue, SqlRow };
