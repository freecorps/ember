// External index kinds (PLAN §6): indexes that live outside the shard's SQLite — Vectorize (`.vectorIndex()`) and
// AI Search (`.aiSearchIndex()`). They are written through a per-shard outbox and queried only from actions.
//
// Outbox (`_ember_ext_outbox`, one row per (table, index, document)):
// - The engine upserts a row in the mutation's own transaction whenever a write changes one of the index's fields
//   (insert, delete, or a patch/replace touching them). Rows coalesce: ten edits to a document before it is
//   delivered are one row. `seq` is a fresh random token per write.
// - Staged backfill (a new or changed index on a table with data) inserts one row per existing document, through
//   the generic `backfill` statement of the kind; live writes skip rows in the backfill window like aggregates do.
// - The runtime delivers rows (Queue → consumer, or in-process without a queue): `sent = seq` marks a row in
//   flight (at most one delivery per document at a time, so the external index never sees an older state after a
//   newer one). The consumer reads the *current* document state when it runs (`outboxFetch`) and acknowledges the
//   `seq` it read (`outboxAck`): if the row still has that seq it is deleted, otherwise (written meanwhile) it goes
//   back to pending and is delivered again. In-flight rows that are never acknowledged are re-sent after
//   `resendMs`; after `maxAttempts` sends a row is parked (`sent = -1`) until the document changes again.
//
// The kind's `external.document(spec, doc)` turns a document into what the service stores (vector values or text
// to embed, AI Search text, filter metadata); null means "not indexable" (field missing) and deletes it remotely.

import { compareValues, type JSONValue } from "@freecorps/ember-values";
import { lit, q, type SqlDriver, type SqlRow, type SqlValue } from "./driver.ts";
import type { IndexKind } from "./indexKinds.ts";
import { decodeRow, fieldOf, layoutOf } from "./layout.ts";
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

/** The `backfill` statement of every external kind: one outbox row per document in the window. */
export function externalBackfill(layout: TableLayout, spec: IndexSpec): string {
  return (
    `INSERT INTO "${OUTBOX_TABLE}" ("tbl", "idx", "doc_id", "seq") SELECT ${lit(layout.table)}, ${lit(spec.name)}, "_id", (abs(random()) % 9007199254740991) ` +
    `FROM ${q(layout.table)} WHERE "_rowid" > ?1 AND "_rowid" <= ?2 ` +
    `ON CONFLICT ("tbl", "idx", "doc_id") DO UPDATE SET "seq" = excluded."seq", "attempts" = 0, "sent" = CASE WHEN "sent" < 0 THEN 0 ELSE "sent" END`
  );
}

const ENQUEUE_SQL =
  `INSERT INTO "${OUTBOX_TABLE}" ("tbl", "idx", "doc_id", "seq") VALUES (?, ?, ?, (abs(random()) % 9007199254740991)) ` +
  `ON CONFLICT ("tbl", "idx", "doc_id") DO UPDATE SET "seq" = excluded."seq", "attempts" = 0, "sent" = CASE WHEN "sent" < 0 THEN 0 ELSE "sent" END`;

/** True when a write from `before` to `after` must re-index the document for an index over `fields`. */
export function externalChanged(fields: string[], before: Doc | null, after: Doc | null): boolean {
  if (!before || !after) return before !== after;
  return fields.some((f) => compareValues(fieldOf(before, f), fieldOf(after, f)) !== 0);
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

const hasOutbox = (driver: SqlDriver) =>
  driver.exec(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '${OUTBOX_TABLE}'`).rows.length > 0;

/**
 * Claims deliverable rows (pending, or in flight for longer than `resendMs`) and marks them in flight. Rows of
 * indexes no longer in the manifest are dropped. Returns batches of at most `batchSize` ids per (table, index), plus
 * the rows parked now (too many attempts). Call inside a transaction.
 */
export function outboxClaim(
  driver: SqlDriver,
  m: SchemaManifest,
  kinds: ReadonlyMap<string, IndexKind>,
  now: number,
  o: OutboxOptions = {},
): { batches: OutboxBatch[]; parked: Array<{ table: string; index: string; id: string }> } {
  const { resendMs, maxAttempts, batchSize, limit } = { ...OUTBOX_DEFAULTS, ...o };
  if (!hasOutbox(driver)) return { batches: [], parked: [] };
  const known = new Set(externalIndexes(m, kinds).map((x) => `${x.table}\u0000${x.spec.name}`));
  const rows = driver.exec(
    `SELECT "tbl", "idx", "doc_id", "attempts" FROM "${OUTBOX_TABLE}" WHERE "sent" = 0 OR ("sent" > 0 AND "sent_at" <= ?) ORDER BY "sent_at", "tbl", "idx" LIMIT ?`,
    now - resendMs,
    limit,
  ).rows;
  const groups = new Map<string, { table: string; index: string; ids: string[] }>();
  const parked: Array<{ table: string; index: string; id: string }> = [];
  for (const r of rows) {
    const table = String(r.tbl);
    const index = String(r.idx);
    const id = String(r.doc_id);
    if (!known.has(`${table}\u0000${index}`)) {
      driver.exec(`DELETE FROM "${OUTBOX_TABLE}" WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, table, index, id);
      continue;
    }
    if (Number(r.attempts) >= maxAttempts) {
      driver.exec(`UPDATE "${OUTBOX_TABLE}" SET "sent" = -1 WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, table, index, id);
      parked.push({ table, index, id });
      continue;
    }
    driver.exec(
      `UPDATE "${OUTBOX_TABLE}" SET "sent" = "seq", "sent_at" = ?, "attempts" = "attempts" + 1 WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`,
      now,
      table,
      index,
      id,
    );
    const key = `${table}\u0000${index}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { table, index, ids: [] }));
    g.ids.push(id);
  }
  const batches: OutboxBatch[] = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += batchSize) batches.push({ table: g.table, index: g.index, ids: g.ids.slice(i, i + batchSize) });
  }
  return { batches, parked };
}

/** Gives claimed rows back (delivery failed before reaching the queue). */
export function outboxRelease(driver: SqlDriver, batch: OutboxBatch): void {
  for (const id of batch.ids) {
    driver.exec(`UPDATE "${OUTBOX_TABLE}" SET "sent" = 0, "sent_at" = 0 WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ? AND "sent" > 0`, batch.table, batch.index, id);
  }
}

export interface FetchedItem {
  id: string;
  /** The outbox seq read with this state (pass it back to `outboxAck`); null when the row is gone (nothing to ack). */
  seq: number | null;
  /** Current stored form; null = delete remotely (document gone or not indexable). */
  doc: ExternalDocument | null;
}

/** Current state of `ids` for an external index (the consumer calls this when it runs). */
export function outboxFetch(
  driver: SqlDriver,
  m: SchemaManifest,
  kinds: ReadonlyMap<string, IndexKind>,
  table: string,
  index: string,
  ids: string[],
): { spec: IndexSpec; items: FetchedItem[] } {
  const t = m.tables[table];
  const spec = t?.indexes.find((i) => i.name === index);
  const kind = spec && kinds.get(spec.kind);
  if (!t || !spec || !isExternalKind(kind)) throw Object.assign(new Error(`Unknown external index ${table}.${index}`), { code: "IndexNotFound" });
  const layout = layoutOf(table, t.document);
  const items: FetchedItem[] = [];
  for (const id of ids) {
    const row = driver.exec(`SELECT * FROM ${q(table)} WHERE "_id" = ?`, id).rows[0];
    const ob = driver.exec(`SELECT "seq" FROM "${OUTBOX_TABLE}" WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, table, index, id).rows[0];
    let doc: ExternalDocument | null = null;
    if (row) {
      try {
        doc = kind.external.document(spec, decodeRow(layout, row));
      } catch {
        doc = null;
      }
    }
    items.push({ id, seq: ob ? Number(ob.seq) : null, doc });
  }
  return { spec, items };
}

/**
 * Acknowledges delivered states: a row whose seq is still the acknowledged one is done (deleted); a row written
 * since goes back to pending. Returns how many rows are still pending for this index.
 */
export function outboxAck(driver: SqlDriver, table: string, index: string, acks: Array<{ id: string; seq: number | null }>): number {
  for (const a of acks) {
    if (a.seq === null) continue;
    driver.exec(`DELETE FROM "${OUTBOX_TABLE}" WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ? AND "seq" = ?`, table, index, a.id, a.seq);
    driver.exec(`UPDATE "${OUTBOX_TABLE}" SET "sent" = 0, "sent_at" = 0 WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ? AND "sent" != 0`, table, index, a.id);
  }
  return Number(driver.exec(`SELECT count(*) AS n FROM "${OUTBOX_TABLE}" WHERE "tbl" = ? AND "idx" = ? AND "sent" = 0`, table, index).rows[0]!.n);
}

/** When the outbox next needs attention: now (pending rows), the earliest re-send, or null (empty / all parked). */
export function outboxNextAt(driver: SqlDriver, now: number, resendMs: number = OUTBOX_DEFAULTS.resendMs): number | null {
  if (!hasOutbox(driver)) return null;
  const r = driver.exec(
    `SELECT (SELECT 1 FROM "${OUTBOX_TABLE}" WHERE "sent" = 0 LIMIT 1) AS pending, (SELECT min("sent_at") FROM "${OUTBOX_TABLE}" WHERE "sent" > 0) AS inflight`,
  ).rows[0]!;
  if (r.pending !== null) return now;
  return r.inflight === null ? null : Number(r.inflight) + resendMs;
}

export interface OutboxStats {
  pending: number;
  inFlight: number;
  parked: number;
}

export function outboxStats(driver: SqlDriver): OutboxStats {
  if (!hasOutbox(driver)) return { pending: 0, inFlight: 0, parked: 0 };
  const r = driver.exec(
    `SELECT coalesce(sum("sent" = 0), 0) AS p, coalesce(sum("sent" > 0), 0) AS f, coalesce(sum("sent" < 0), 0) AS d FROM "${OUTBOX_TABLE}"`,
  ).rows[0]!;
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
