// `.replicated()` tables, source side (PLAN §22 L5, contracts.md "Tabelas replicadas"), and the shard catalog that
// `global:main` keeps (`ctx.shards`).
//
// - **Catalog** (`_ember_shard_directory`): every shard registers with `global:main` the first time it knows its name
//   (`Shard.registerShard`, one RPC per shard lifetime; retried from the hourly maintenance until it lands). It feeds
//   `ctx.shards.list/fanOut` and the replication targets.
// - **One log, a cursor per target.** A commit in `global:main` that changes a `.replicated()` table appends one row per
//   change to `_ember_bcast_log` in the same transaction (not one per target: a write costs O(1) here, the fan-out is
//   in the drain). Each target shard has a row in `_ember_bcast_targets`: `scan_seq` (how far the drain read the log
//   for it), `last_seq` (the last seq it delivered, the `prev` of the next batch: rows of tables the target's kind does
//   not receive are skipped without a call), backoff and parking as in replication.ts.
// - **Delivery** goes to the same `_ember:replicaApply` as the other sources (source name `global:main`): marks per
//   source in the target (exactly once in effect), gap → resync, snapshot pages cut at the log's last seq.
// - **Bootstrap:** a new target arrives with `snapshot = 1` (its registration); a deploy that changes the replicated
//   tables (`replicatedVersion`) resyncs every target, and so does a restore of `global:main` or of the target.
// - **GC:** log rows every live target has scanned are deleted at the end of each drain (targets waiting for a
//   snapshot or parked do not hold the log: the snapshot replaces what they missed).

import {
  REPLICATED_SOURCE,
  kindReceivesReplicated,
  receivesReplicated,
  replicatedSnapshot,
  replicatedTablesOf,
  replicatedVersion,
  shardKindOf,
  type ReplicaApplyArgs,
  type ReplicaApplyResult,
  type ReplicaRow,
  type RowChange,
  type SchemaManifest,
  type SqlDriver,
} from "@freecorps/ember-server";
import { isValidShardName } from "./config.ts";
import { parse, stringify } from "./wire.ts";

export const DIRECTORY_TABLE = "_ember_shard_directory";
export const BROADCAST_LOG = "_ember_bcast_log";
export const BROADCAST_TARGETS = "_ember_bcast_targets";
const BROADCAST_META = "_ember_bcast_meta";

export const BROADCAST_DDL = [
  `CREATE TABLE IF NOT EXISTS ${DIRECTORY_TABLE} (shard TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, registered_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ${DIRECTORY_TABLE}_by_kind ON ${DIRECTORY_TABLE} (kind, key)`,
  `CREATE TABLE IF NOT EXISTS ${BROADCAST_LOG} (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, sid TEXT NOT NULL, op TEXT NOT NULL, doc TEXT, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${BROADCAST_TARGETS} (
    target TEXT PRIMARY KEY, kind TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, scan_seq INTEGER NOT NULL DEFAULT 0,
    snapshot INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
    dead INTEGER NOT NULL DEFAULT 0, last_error TEXT, delivered_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS ${BROADCAST_META} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

type Db = Pick<SqlDriver, "exec" | "transaction">;
const rows = (db: Db, sql: string, ...params: Array<string | number | null>) => db.exec(sql, ...params).rows;

export function ensureBroadcastTables(db: Db): void {
  for (const s of BROADCAST_DDL) db.exec(s);
}

/** Drivers whose broadcast tables the drain already created (once per object, not every alarm turn). */
const drainReady = new WeakSet<Db>();

/** The `.replicated()` tables of a manifest, as a set (empty: nothing of this module runs). */
export const replicatedSet = (m: Pick<SchemaManifest, "tables">): ReadonlySet<string> => new Set(replicatedTablesOf(m));

/** Appends the commit's changes to `.replicated()` tables to the log. Call inside the commit's transaction. */
export function logReplicated(db: Db, tables: ReadonlySet<string>, changes: readonly RowChange[], now = Date.now()): number {
  let n = 0;
  for (const c of changes) {
    if (!tables.has(c.table)) continue;
    db.exec(`INSERT INTO ${BROADCAST_LOG} (tbl, sid, op, doc, at) VALUES (?, ?, ?, ?, ?)`, c.table, c.id, c.after ? "upsert" : "delete", c.after ? stringify(c.after) : null, now);
    n++;
  }
  return n;
}

/** The last seq the log assigned (deleted rows included): a resync's cut. */
function currentSeq(db: Db): number {
  const r = rows(db, `SELECT seq FROM sqlite_sequence WHERE name = '${BROADCAST_LOG}'`)[0];
  return r ? Number(r.seq) : 0;
}

/** Asks for a full copy to `target` (new target, gap, restore, admin). Clears a parked target. */
function requestSnapshot(db: Db, target: string, now: number): void {
  db.exec(
    `INSERT INTO ${BROADCAST_TARGETS} (target, kind, snapshot, next_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (target) DO UPDATE SET snapshot = 1, dead = 0, attempts = 0, next_at = excluded.next_at, last_error = NULL`,
    target, shardKindOf(target), now,
  );
}

/**
 * A shard announces itself (its first request, or `resync` after a restore). New in the catalog → `registered`; a kind
 * that receives `.replicated()` tables gets a full copy (`snapshot`) when it is new to the targets or asks for one.
 */
export function registerShard(db: Db, m: Pick<SchemaManifest, "tables">, shard: string, opts: { resync?: boolean } = {}, now = Date.now()): { registered: boolean; snapshot: boolean } {
  if (!isValidShardName(shard) || shard === REPLICATED_SOURCE) return { registered: false, snapshot: false };
  ensureBroadcastTables(db);
  return db.transaction(() => {
    const kind = shardKindOf(shard);
    const registered = rows(db, `INSERT INTO ${DIRECTORY_TABLE} (shard, kind, key, registered_at) VALUES (?, ?, ?, ?) ON CONFLICT (shard) DO NOTHING RETURNING shard`, shard, kind, shard.slice(kind.length + 1), now).length > 0;
    let snapshot = false;
    if (kindReceivesReplicated(m, kind)) {
      const known = rows(db, `SELECT 1 AS x FROM ${BROADCAST_TARGETS} WHERE target = ?`, shard).length > 0;
      if (!known || opts.resync) {
        requestSnapshot(db, shard, now);
        snapshot = true;
      }
    }
    return { registered, snapshot };
  });
}

/**
 * At `global:main`'s boot: when the replicated tables changed since the last boot (a deploy), every target of the new
 * set gets a resync, and targets whose kind receives nothing any more leave. Returns the targets asked to resync. With
 * no `.replicated()` table it forgets everything, so a later deploy that brings them back resyncs every target.
 */
export function syncBroadcastTargets(db: Db, m: Pick<SchemaManifest, "tables">, now = Date.now()): number {
  if (!replicatedTablesOf(m).length) {
    // Nothing replicated (any more): forget the version, the targets and the log, so turning tables on again — even
    // the very same ones — resyncs every target (writes made meanwhile were never logged). No tables: nothing to do.
    if (rows(db, `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, BROADCAST_META).length) {
      db.transaction(() => {
        for (const t of [BROADCAST_META, BROADCAST_TARGETS, BROADCAST_LOG]) db.exec(`DELETE FROM ${t}`);
      });
    }
    return 0;
  }
  ensureBroadcastTables(db);
  const version = replicatedVersion(m);
  if (rows(db, `SELECT v FROM ${BROADCAST_META} WHERE k = 'version'`)[0]?.v === version) return 0;
  return db.transaction(() => {
    let n = 0;
    for (const t of rows(db, `SELECT target, kind FROM ${BROADCAST_TARGETS}`)) {
      if (!kindReceivesReplicated(m, String(t.kind))) db.exec(`DELETE FROM ${BROADCAST_TARGETS} WHERE target = ?`, t.target as string);
    }
    for (const r of rows(db, `SELECT shard, kind FROM ${DIRECTORY_TABLE}`)) {
      if (!kindReceivesReplicated(m, String(r.kind))) continue;
      requestSnapshot(db, String(r.shard), now);
      n++;
    }
    db.exec(`INSERT INTO ${BROADCAST_META} (k, v) VALUES ('version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, version);
    return n;
  });
}

/** Every target of the catalog asks for a resync (`global:main` restored, admin `{ all: true }`). */
export function resyncAllTargets(db: Db, m: Pick<SchemaManifest, "tables">, now = Date.now()): number {
  ensureBroadcastTables(db);
  return db.transaction(() => {
    let n = 0;
    for (const r of rows(db, `SELECT shard, kind FROM ${DIRECTORY_TABLE}`)) {
      if (!kindReceivesReplicated(m, String(r.kind))) continue;
      requestSnapshot(db, String(r.shard), now);
      n++;
    }
    return n;
  });
}

/** One target asks for a resync (admin endpoint). False: its kind receives no replicated table. */
export function resyncTarget(db: Db, m: Pick<SchemaManifest, "tables">, shard: string, now = Date.now()): boolean {
  if (!isValidShardName(shard) || !kindReceivesReplicated(m, shardKindOf(shard))) return false;
  registerShard(db, m, shard, { resync: true }, now);
  return true;
}

const DUE = `dead = 0 AND (snapshot = 1 OR EXISTS (SELECT 1 FROM ${BROADCAST_LOG} l WHERE l.seq > t.scan_seq))`;

/** When the drain should run next (null: nothing to deliver). */
export function nextBroadcastAt(db: Db): number | null {
  const r = rows(db, `SELECT MIN(next_at) AS at FROM ${BROADCAST_TARGETS} t WHERE ${DUE}`)[0];
  return r && r.at !== null && r.at !== undefined ? Number(r.at) : null;
}

export type BroadcastTargetRow = {
  target: string;
  kind: string;
  last_seq: number;
  scan_seq: number;
  snapshot: number;
  attempts: number;
  next_at: number;
  dead: number;
  last_error: string | null;
  delivered_at: number | null;
  /** Log rows the drain has not read for this target yet (some may be of tables its kind does not receive). */
  pending: number;
};

/** The source's state for the admin endpoint (the shape of the other sources' `replicaStatus`). */
export function broadcastStatus(db: Db, o: { target?: string; limit?: number } = {}): { enabled: boolean; journal: number; seq: number; targets: BroadcastTargetRow[]; next: number | null } {
  ensureBroadcastTables(db);
  const where = o.target !== undefined ? "WHERE t.target = ?" : "";
  const params: Array<string | number> = o.target !== undefined ? [o.target] : [];
  const targets = rows(
    db,
    `SELECT t.*, (SELECT COUNT(*) FROM ${BROADCAST_LOG} l WHERE l.seq > t.scan_seq) AS pending FROM ${BROADCAST_TARGETS} t ${where} ORDER BY t.dead DESC, t.attempts DESC, t.target LIMIT ?`,
    ...params, o.limit ?? 100,
  ) as unknown as BroadcastTargetRow[];
  return { enabled: true, journal: 0, seq: currentSeq(db), targets, next: nextBroadcastAt(db) };
}

/** A page of the catalog: shards of `kind` in key order after `cursor`. */
export function listDirectory(db: Db, kind: string, o: { cursor?: string | null; limit?: number } = {}): { shards: Array<{ shard: string; kind: string; key: string; registeredAt: number }>; next: string | null } {
  ensureBroadcastTables(db);
  const limit = Math.max(1, Math.min(1000, Math.floor(o.limit ?? 100)));
  const page = rows(db, `SELECT shard, kind, key, registered_at FROM ${DIRECTORY_TABLE} WHERE kind = ? AND key > ? ORDER BY key LIMIT ?`, kind, o.cursor ?? "", limit + 1);
  const shards = page.slice(0, limit).map((r) => ({ shard: String(r.shard), kind: String(r.kind), key: String(r.key), registeredAt: Number(r.registered_at) }));
  return { shards, next: page.length > limit ? shards[shards.length - 1]!.key : null };
}

export interface BroadcastOptions {
  /** Delivers one call to `target` (the Shard wires its stub's `mutation` RPC). */
  deliver(target: string, args: ReplicaApplyArgs): Promise<ReplicaApplyResult>;
  /** Attempts before a failing target is resynced (deltas) or parked (a resync). Default 10. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Log rows read per call. Default 100. */
  batch?: number;
  /** Rows per resync page. Default 200. */
  pageSize?: number;
  /** Targets served per drain turn. Default 50 (the rest: next turn, right away). */
  targetsPerTurn?: number;
  /** Deliveries in flight at once (one per target). Default 8. */
  concurrency?: number;
}

export interface BroadcastDrain {
  delivered: number;
  snapshots: number;
  failed: number;
  /** Log rows deleted (every live target had read them). */
  collected: number;
  next: number | null;
}

type Target = { target: string; kind: string; last_seq: number; scan_seq: number; snapshot: number; attempts: number };

/** One drain turn (the source's alarm). Not reentrant: the caller runs one at a time. */
export async function drainBroadcast(db: Db, m: Pick<SchemaManifest, "tables">, opts: BroadcastOptions): Promise<BroadcastDrain> {
  // Async, so never inside a transaction that could roll the DDL back while it is remembered as done.
  if (!drainReady.has(db)) {
    ensureBroadcastTables(db);
    drainReady.add(db);
  }
  const maxAttempts = opts.maxAttempts ?? 10;
  const base = opts.backoffBaseMs ?? 1_000;
  const cap = opts.backoffMaxMs ?? 5 * 60_000;
  const batch = opts.batch ?? 100;
  const pageSize = opts.pageSize ?? 200;
  const out: BroadcastDrain = { delivered: 0, snapshots: 0, failed: 0, collected: 0, next: null };
  // Per-turn caches, shared by the targets served in this turn. Every commit that changes a `.replicated()` table
  // appends to the log in its transaction (`logReplicated`), so the log's last seq (`cut`) moving is exactly what
  // invalidates them: a snapshot of a kind read at the same cut has the same rows; a log page read from the same
  // `scan_seq` at the same cut has the same rows (GC only runs after the workers). A log row's doc never changes.
  const snapshots = new Map<string, { cut: number; rows: ReturnType<typeof replicatedSnapshot> }>();
  const pages = new Map<number, { cut: number; log: ReturnType<typeof rows> }>();
  const docs = new Map<number, Record<string, unknown>>();
  const due = rows(db, `SELECT target, kind, last_seq, scan_seq, snapshot, attempts FROM ${BROADCAST_TARGETS} t WHERE ${DUE} AND next_at <= ? ORDER BY next_at LIMIT ?`, Date.now(), opts.targetsPerTurn ?? 50) as unknown as Target[];

  const decodeDoc = (seq: number, json: string): Record<string, unknown> => {
    let doc = docs.get(seq);
    if (!doc) docs.set(seq, (doc = parse(json) as Record<string, unknown>));
    return doc;
  };

  const fail = (t: Target, err: string) => {
    out.failed++;
    const attempts = t.attempts + 1;
    if (attempts < maxAttempts) {
      db.exec(`UPDATE ${BROADCAST_TARGETS} SET attempts = ?, next_at = ?, last_error = ? WHERE target = ?`, attempts, Date.now() + Math.min(cap, base * 2 ** (attempts - 1)), err, t.target);
      return;
    }
    if (t.snapshot) {
      console.error(`ember: replicated tables: resync of ${t.target} failed ${attempts} times, parked: ${err}`);
      db.exec(`UPDATE ${BROADCAST_TARGETS} SET attempts = ?, dead = 1, last_error = ? WHERE target = ?`, attempts, err, t.target);
      return;
    }
    // Deltas the target keeps refusing: rebuild it from the source's current rows instead.
    console.error(`ember: replicated tables: deltas → ${t.target} failed ${attempts} times; resyncing it: ${err}`);
    db.exec(`UPDATE ${BROADCAST_TARGETS} SET attempts = 0, snapshot = 1, next_at = ?, last_error = ? WHERE target = ?`, Date.now(), err, t.target);
  };

  const snapshot = async (t: Target) => {
    // Read and cut in one synchronous step: no commit lands between the rows and `cut`.
    const cut = currentSeq(db);
    let cached = snapshots.get(t.kind);
    if (cached?.cut !== cut) {
      cached = { cut, rows: replicatedSnapshot((sql, ...p) => db.exec(sql, ...p).rows, m, t.kind) };
      snapshots.set(t.kind, cached);
    }
    const all = cached.rows;
    const id = crypto.randomUUID();
    for (let i = 0; i === 0 || i < all.length; i += pageSize) {
      const last = i + pageSize >= all.length;
      await opts.deliver(t.target, { source: REPLICATED_SOURCE, snapshot: { id, ...(i === 0 ? { first: true } : {}), rows: all.slice(i, i + pageSize), ...(last ? { end: { cut } } : {}) } });
    }
    db.exec(`UPDATE ${BROADCAST_TARGETS} SET snapshot = 0, last_seq = ?, scan_seq = ?, attempts = 0, last_error = NULL, delivered_at = ? WHERE target = ?`, cut, cut, Date.now(), t.target);
    out.snapshots++;
    return { ...t, snapshot: 0, attempts: 0, last_seq: cut, scan_seq: cut };
  };

  const serve = async (t: Target) => {
    if (t.snapshot) {
      try {
        t = await snapshot(t);
      } catch (e) {
        fail(t, e instanceof Error ? e.message : String(e));
        return;
      }
    }
    // A few batches per turn and target; the rest goes next turn (the alarm comes back at once).
    for (let round = 0; round < 10; round++) {
      const cut = currentSeq(db);
      let page = pages.get(t.scan_seq);
      if (page?.cut !== cut) {
        page = { cut, log: rows(db, `SELECT seq, tbl, sid, op, doc FROM ${BROADCAST_LOG} WHERE seq > ? ORDER BY seq LIMIT ?`, t.scan_seq, batch) };
        pages.set(t.scan_seq, page);
      }
      const log = page.log;
      if (!log.length) return;
      const scanned = Number(log[log.length - 1]!.seq);
      const send: ReplicaRow[] = [];
      for (const r of log) {
        const tm = m.tables[String(r.tbl)];
        // A table dropped from the schema, or one this kind does not receive: skipped, no call.
        if (!tm || !receivesReplicated(tm, t.kind)) continue;
        send.push({
          seq: Number(r.seq),
          table: String(r.tbl),
          id: String(r.sid),
          op: r.op === "delete" ? "delete" : "upsert",
          ...(typeof r.doc === "string" ? { doc: decodeDoc(Number(r.seq), r.doc) } : {}),
        });
      }
      if (!send.length) {
        db.exec(`UPDATE ${BROADCAST_TARGETS} SET scan_seq = ? WHERE target = ?`, scanned, t.target);
        t = { ...t, scan_seq: scanned };
        if (log.length < batch) return;
        continue;
      }
      let res: ReplicaApplyResult;
      try {
        res = await opts.deliver(t.target, { source: REPLICATED_SOURCE, prev: t.last_seq, rows: send });
      } catch (e) {
        fail(t, e instanceof Error ? e.message : String(e));
        return;
      }
      if (res.resync) {
        console.error(`ember: replicated tables: ${t.target} is behind the source (seq ${res.seq} < ${t.last_seq}): resyncing it`);
        requestSnapshot(db, t.target, Date.now());
        return;
      }
      const last = send[send.length - 1]!.seq;
      db.exec(`UPDATE ${BROADCAST_TARGETS} SET last_seq = ?, scan_seq = ?, attempts = 0, last_error = NULL, delivered_at = ? WHERE target = ?`, last, scanned, Date.now(), t.target);
      out.delivered += send.length;
      t = { ...t, last_seq: last, scan_seq: scanned, attempts: 0 };
      if (log.length < batch) return;
    }
  };

  const queue = [...due];
  const workers = Array.from({ length: Math.min(Math.max(1, opts.concurrency ?? 8), queue.length) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) await serve(t);
  });
  await Promise.all(workers);

  // GC: what every live, caught-up target has read (the others get a snapshot, which needs no log).
  const floor = rows(db, `SELECT MIN(scan_seq) AS s FROM ${BROADCAST_TARGETS} WHERE dead = 0 AND snapshot = 0`)[0]?.s;
  const upTo = floor === null || floor === undefined ? currentSeq(db) : Number(floor);
  out.collected = db.exec(`DELETE FROM ${BROADCAST_LOG} WHERE seq <= ?`, upTo).rowsWritten;
  out.next = nextBroadcastAt(db);
  return out;
}
