// Cross-shard replication, source side (contracts.md "Replicação entre shards"). A source Durable Object (the Auth DO
// for `auth:*` tables; later `global:main` for `.replicated()` tables and projections) writes one outbox row per change
// and target shard **in the same transaction** as its own write (`enqueueReplica`). Its alarm (`drainReplication`)
// delivers them to `_ember:replicaApply` on each target shard:
//
// - in seq order per target (one delivery in flight per target; a failing target waits with backoff, the others go on);
// - at least once over the wire, exactly once in effect (the target keeps a high-water mark per source and skips what
//   it has already applied);
// - with gap detection: every batch says the last seq the source delivered to that target (`prev`); a target whose
//   mark is lower lost data (a restore, a rebuilt replica table) and answers `resync`;
// - with resyncs (`requestSnapshot`: bootstrap of a new target, gap, admin endpoint): the source reads every row the
//   target should hold, with `cut` = the last seq it had assigned, and sends them in pages; the target replaces its rows
//   and sets its mark to `cut`, so the deltas already queued up to `cut` become no-ops and the later ones apply on top.
//   Snapshot + deltas converge because each delta carries the row as it was when the delta was written (or later).
//
// A batch that keeps failing (`maxAttempts`) is parked (`dead = 1`, kept for inspection) and the target is resynced; a
// resync that keeps failing parks the target until an admin resync (`POST /api/_ember/replicas/resync`).

import type { ReplicaApplyArgs, ReplicaApplyResult, ReplicaSnapshotRow } from "@freecorps/ember-server";
import { getEmberConfig, isValidShardName, type EmberEnv } from "./config.ts";
import type { Shard } from "./shard.ts";
import { shardStub } from "./stubs.ts";

/** The internal mutation every shard has (createEmberWorker registers it). */
export const REPLICA_APPLY_FN = "_ember:replicaApply";
export const REPLICATION_TABLE = "_ember_replication";
export const REPLICATION_TARGETS = "_ember_replication_targets";

export const REPLICATION_DDL = [
  `CREATE TABLE IF NOT EXISTS ${REPLICATION_TABLE} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, tbl TEXT NOT NULL, sid TEXT NOT NULL, op TEXT NOT NULL,
    doc TEXT, created_at INTEGER NOT NULL, dead INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ${REPLICATION_TABLE}_by_target ON ${REPLICATION_TABLE} (target, dead, seq)`,
  `CREATE TABLE IF NOT EXISTS ${REPLICATION_TARGETS} (
    target TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0, snapshot INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, dead INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, delivered_at INTEGER)`,
];

/** One change for one target, as the source records it. `doc`: the replicated fields (upserts). */
export type ReplicaChange = { target: string; table: string; id: string | number; op: "upsert" | "delete"; doc?: Record<string, unknown> };

export interface ReplicationOptions {
  /** Name of the source (the targets' high-water mark key): `"auth"`. */
  source: string;
  /** Every row `target` should hold now, read synchronously from the source's own SQLite (a resync). */
  snapshot(sql: SqlStorage, target: string): ReplicaSnapshotRow[];
  /** Attempts before a batch (or a resync) is parked. Default 10. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Rows per delivery. Default 100. */
  batch?: number;
  /** Rows per resync page. Default 200. */
  pageSize?: number;
  /** Targets served per drain turn. Default 50 (the rest: next turn, right away). */
  targetsPerTurn?: number;
  /** Deliveries in flight at once (one per target). Default 8. */
  concurrency?: number;
  /** Test hook: what delivers one call (default: the target shard's `mutation` RPC). */
  deliver?: (env: EmberEnv, target: string, args: ReplicaApplyArgs) => Promise<ReplicaApplyResult>;
}

export type ReplicationTargetRow = {
  target: string;
  last_seq: number;
  snapshot: number;
  attempts: number;
  next_at: number;
  dead: number;
  last_error: string | null;
  delivered_at: number | null;
  pending: number;
};

export function ensureReplicationTables(sql: SqlStorage): void {
  for (const s of REPLICATION_DDL) sql.exec(s);
}

/** Records changes for delivery. Call inside the transaction of the source write it reflects. */
export function enqueueReplica(sql: SqlStorage, changes: readonly ReplicaChange[], now = Date.now()): number {
  let n = 0;
  for (const c of changes) {
    if (!isValidShardName(c.target)) {
      console.error(`ember: replication skipped a change for invalid shard ${JSON.stringify(c.target)}`);
      continue;
    }
    sql.exec(
      `INSERT INTO ${REPLICATION_TABLE} (target, tbl, sid, op, doc, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      c.target, c.table, JSON.stringify(c.id), c.op, c.op === "upsert" ? JSON.stringify(c.doc ?? {}) : null, now,
    );
    sql.exec(`INSERT INTO ${REPLICATION_TARGETS} (target, next_at) VALUES (?, ?) ON CONFLICT (target) DO NOTHING`, c.target, now);
    n++;
  }
  return n;
}

/** Asks for a full resync of `target` (bootstrap, gap, admin). Clears a parked target. */
export function requestSnapshot(sql: SqlStorage, target: string, now = Date.now()): void {
  sql.exec(
    `INSERT INTO ${REPLICATION_TARGETS} (target, snapshot, next_at) VALUES (?, 1, ?)
     ON CONFLICT (target) DO UPDATE SET snapshot = 1, dead = 0, attempts = 0, next_at = excluded.next_at, last_error = NULL`,
    target, now,
  );
}

/** The last seq the source assigned (deleted rows included): a resync's cut. */
function currentSeq(sql: SqlStorage): number {
  const r = sql.exec(`SELECT seq FROM sqlite_sequence WHERE name = '${REPLICATION_TABLE}'`).toArray()[0];
  return r ? Number(r.seq) : 0;
}

/** When the drain should run next (null: nothing to deliver). */
export function nextReplicationAt(sql: SqlStorage): number | null {
  const r = sql
    .exec(
      `SELECT MIN(next_at) AS at FROM ${REPLICATION_TARGETS} t WHERE dead = 0 AND (snapshot = 1 OR EXISTS (SELECT 1 FROM ${REPLICATION_TABLE} r WHERE r.target = t.target AND r.dead = 0))`,
    )
    .toArray()[0];
  return r && r.at !== null ? Number(r.at) : null;
}

/** Targets with their state (pending rows), for inspection. */
export function replicationTargets(sql: SqlStorage, o: { target?: string; limit?: number } = {}): ReplicationTargetRow[] {
  const where = o.target !== undefined ? "WHERE t.target = ?" : "";
  const params = o.target !== undefined ? [o.target] : [];
  return sql
    .exec(
      `SELECT t.*, (SELECT COUNT(*) FROM ${REPLICATION_TABLE} r WHERE r.target = t.target AND r.dead = 0) AS pending FROM ${REPLICATION_TARGETS} t ${where} ORDER BY t.dead DESC, t.attempts DESC, t.target LIMIT ?`,
      ...params, o.limit ?? 100,
    )
    .toArray() as unknown as ReplicationTargetRow[];
}

export interface ReplicationDrain {
  delivered: number;
  snapshots: number;
  failed: number;
  /** When to run again (null: nothing left). */
  next: number | null;
}

export async function drainReplication(storage: DurableObjectStorage, env: EmberEnv, opts: ReplicationOptions): Promise<ReplicationDrain> {
  const sql = storage.sql;
  ensureReplicationTables(sql);
  const maxAttempts = opts.maxAttempts ?? 10;
  const base = opts.backoffBaseMs ?? 1_000;
  const cap = opts.backoffMaxMs ?? 5 * 60_000;
  const batch = opts.batch ?? 100;
  const pageSize = opts.pageSize ?? 200;
  const deliver =
    opts.deliver ??
    (async (e: EmberEnv, target: string, args: ReplicaApplyArgs): Promise<ReplicaApplyResult> => {
      const stub = shardStub(e, getEmberConfig().schema.manifest, target) as unknown as Shard;
      const out = await stub.mutation(target, REPLICA_APPLY_FN, args, null, true);
      if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
      return out.value as ReplicaApplyResult;
    });
  const now = Date.now();
  const due = sql
    .exec(
      `SELECT target, last_seq, snapshot, attempts FROM ${REPLICATION_TARGETS} t WHERE dead = 0 AND next_at <= ? AND (snapshot = 1 OR EXISTS (SELECT 1 FROM ${REPLICATION_TABLE} r WHERE r.target = t.target AND r.dead = 0)) ORDER BY next_at LIMIT ?`,
      now, opts.targetsPerTurn ?? 50,
    )
    .toArray() as Array<{ target: string; last_seq: number; snapshot: number; attempts: number }>;
  const out: ReplicationDrain = { delivered: 0, snapshots: 0, failed: 0, next: null };

  const fail = (t: { target: string; snapshot: number; attempts: number }, err: string, seqs: number[]) => {
    out.failed++;
    const attempts = t.attempts + 1;
    if (attempts < maxAttempts) {
      sql.exec(`UPDATE ${REPLICATION_TARGETS} SET attempts = ?, next_at = ?, last_error = ? WHERE target = ?`, attempts, Date.now() + Math.min(cap, base * 2 ** (attempts - 1)), err, t.target);
      return;
    }
    if (t.snapshot) {
      console.error(`ember: replication resync of ${t.target} (${opts.source}) failed ${attempts} times, parked: ${err}`);
      sql.exec(`UPDATE ${REPLICATION_TARGETS} SET attempts = ?, dead = 1, last_error = ? WHERE target = ?`, attempts, err, t.target);
      return;
    }
    // A batch the target keeps refusing: park it and rebuild the target from the source's current state instead.
    console.error(`ember: replication rows ${seqs[0]}..${seqs[seqs.length - 1]} → ${t.target} (${opts.source}) failed ${attempts} times, parked; resyncing the target: ${err}`);
    storage.transactionSync(() => {
      for (const s of seqs) sql.exec(`UPDATE ${REPLICATION_TABLE} SET dead = 1 WHERE seq = ?`, s);
      sql.exec(`UPDATE ${REPLICATION_TARGETS} SET attempts = 0, snapshot = 1, next_at = ?, last_error = ? WHERE target = ?`, Date.now(), err, t.target);
    });
  };

  const snapshot = async (t: { target: string; snapshot: number; attempts: number }) => {
    // Read and cut in one synchronous step: no source write can land between the rows and `cut`.
    const cut = currentSeq(sql);
    const rows = opts.snapshot(sql, t.target);
    const id = crypto.randomUUID();
    for (let i = 0; i === 0 || i < rows.length; i += pageSize) {
      const page = rows.slice(i, i + pageSize);
      const last = i + pageSize >= rows.length;
      await deliver(env, t.target, { source: opts.source, snapshot: { id, ...(i === 0 ? { first: true } : {}), rows: page, ...(last ? { end: { cut } } : {}) } });
    }
    storage.transactionSync(() => {
      sql.exec(`DELETE FROM ${REPLICATION_TABLE} WHERE target = ? AND seq <= ? AND dead = 0`, t.target, cut);
      sql.exec(
        `UPDATE ${REPLICATION_TARGETS} SET snapshot = 0, last_seq = MAX(last_seq, ?), attempts = 0, last_error = NULL, delivered_at = ? WHERE target = ?`,
        cut, Date.now(), t.target,
      );
    });
    out.snapshots++;
  };

  const serve = async (t: { target: string; last_seq: number; snapshot: number; attempts: number }) => {
    if (t.snapshot) {
      try {
        await snapshot(t);
      } catch (e) {
        fail(t, e instanceof Error ? e.message : String(e), []);
        return;
      }
      t = { ...t, snapshot: 0, attempts: 0, last_seq: Number(sql.exec(`SELECT last_seq FROM ${REPLICATION_TARGETS} WHERE target = ?`, t.target).toArray()[0]?.last_seq ?? 0) };
    }
    // A few batches per turn and target; whatever is left goes next turn (the alarm comes back at once).
    for (let round = 0; round < 10; round++) {
      const rows = sql
        .exec(`SELECT seq, tbl, sid, op, doc FROM ${REPLICATION_TABLE} WHERE target = ? AND dead = 0 ORDER BY seq LIMIT ?`, t.target, batch)
        .toArray();
      if (!rows.length) return;
      const seqs = rows.map((r) => Number(r.seq));
      let res: ReplicaApplyResult;
      try {
        res = await deliver(env, t.target, {
          source: opts.source,
          prev: t.last_seq,
          rows: rows.map((r) => ({
            seq: Number(r.seq),
            table: String(r.tbl),
            id: JSON.parse(String(r.sid)) as string | number,
            op: r.op === "delete" ? ("delete" as const) : ("upsert" as const),
            ...(typeof r.doc === "string" ? { doc: JSON.parse(r.doc) as Record<string, unknown> } : {}),
          })),
        });
      } catch (e) {
        fail(t, e instanceof Error ? e.message : String(e), seqs);
        return;
      }
      if (res.resync) {
        console.error(`ember: replication target ${t.target} (${opts.source}) is behind the source (seq ${res.seq} < ${t.last_seq}): resyncing it`);
        requestSnapshot(sql, t.target);
        return;
      }
      const last = seqs[seqs.length - 1]!;
      storage.transactionSync(() => {
        sql.exec(`DELETE FROM ${REPLICATION_TABLE} WHERE target = ? AND seq <= ? AND dead = 0`, t.target, last);
        sql.exec(`UPDATE ${REPLICATION_TARGETS} SET last_seq = ?, attempts = 0, last_error = NULL, delivered_at = ? WHERE target = ?`, last, Date.now(), t.target);
      });
      out.delivered += rows.length;
      t = { ...t, last_seq: last, attempts: 0 };
      if (rows.length < batch) return;
    }
  };

  const queue = [...due];
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 8, queue.length) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) await serve(t);
  });
  await Promise.all(workers);
  out.next = nextReplicationAt(sql);
  return out;
}
