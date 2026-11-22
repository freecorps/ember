// The replication outbox (replication.ts) on a plain SQLite DO, with a fake delivery: per-target order, backoff of one
// target without holding the others, parking of a batch that keeps failing (then a resync), gap → resync, snapshot cut.
// End to end with the real Auth DO and real shards: examples/files-auth-jobs/test/orgs.test.ts.
import { env, runInDurableObject } from "cloudflare:test";
import type { ReplicaApplyArgs, ReplicaApplyResult } from "@freecorps/ember-server";
import { describe, expect, it } from "vitest";
import { drainReplication, enqueueReplica, ensureReplicationTables, nextReplicationAt, replicationTargets, requestSnapshot, type ReplicationOptions } from "../src/index.ts";
import { probes } from "./worker.ts";

const box = () => env.OUTBOX.get(env.OUTBOX.idFromName(`replication-${crypto.randomUUID()}`));

/** A target that applies like `_ember:replicaApply` (high-water mark, gap check), in memory. */
function fakeTargets() {
  const state = new Map<string, { seq: number; rows: Map<string, unknown> }>();
  const calls: Array<{ target: string; args: ReplicaApplyArgs }> = [];
  const failing = new Set<string>();
  const deliver = async (_e: unknown, target: string, args: ReplicaApplyArgs): Promise<ReplicaApplyResult> => {
    calls.push({ target, args });
    if (failing.has(target)) throw new Error(`${target} is down`);
    const s = state.get(target) ?? { seq: 0, rows: new Map() };
    state.set(target, s);
    if ("snapshot" in args && args.snapshot) {
      if (args.snapshot.first) s.rows.clear();
      for (const r of args.snapshot.rows) s.rows.set(`${r.table}/${r.id}`, r.doc);
      if (args.snapshot.end) s.seq = args.snapshot.end.cut;
      return { seq: s.seq, applied: args.snapshot.rows.length, skipped: 0 };
    }
    const d = args as Extract<ReplicaApplyArgs, { rows: unknown[] }>;
    if (s.seq < d.prev) return { seq: s.seq, applied: 0, skipped: d.rows.length, resync: true };
    let applied = 0;
    for (const r of d.rows) {
      if (r.seq <= s.seq) continue;
      if (r.op === "delete") s.rows.delete(`${r.table}/${r.id}`);
      else s.rows.set(`${r.table}/${r.id}`, r.doc);
      s.seq = r.seq;
      applied++;
    }
    return { seq: s.seq, applied, skipped: d.rows.length - applied };
  };
  return { state, calls, failing, deliver };
}

const opts = (t: ReturnType<typeof fakeTargets>, snapshot: ReplicationOptions["snapshot"] = () => []): ReplicationOptions => ({
  source: "test",
  snapshot,
  deliver: t.deliver as NonNullable<ReplicationOptions["deliver"]>,
  maxAttempts: 2,
  backoffBaseMs: 10_000,
  batch: 2,
});

describe("replication outbox", () => {
  it("the drain creates its tables once per storage, not every turn", async () => {
    const t = fakeTargets();
    await runInDurableObject(box(), async (_i, state) => {
      const ddl: string[] = [];
      const real = state.storage.sql;
      const sql = { exec: (q: string, ...b: unknown[]) => (/^\s*CREATE /i.test(q) && ddl.push(q), real.exec(q, ...(b as []))) } as unknown as SqlStorage;
      const storage = { sql, transactionSync: <T>(f: () => T) => state.storage.transactionSync(f) } as unknown as DurableObjectStorage;
      await drainReplication(storage, env as never, opts(t));
      const first = ddl.length;
      expect(first).toBeGreaterThan(0);
      enqueueReplica(real, [{ target: "org:a", table: "auth:member", id: "m1", op: "upsert", doc: { role: "member" } }]);
      expect(await drainReplication(storage, env as never, opts(t))).toMatchObject({ delivered: 1 });
      await drainReplication(storage, env as never, opts(t));
      expect(ddl).toHaveLength(first);
    });
  });

  it("delivers in seq order per target, in batches, and deletes what was applied", async () => {
    const t = fakeTargets();
    await runInDurableObject(box(), async (_i, state) => {
      const sql = state.storage.sql;
      ensureReplicationTables(sql);
      enqueueReplica(sql, [
        { target: "org:a", table: "auth:member", id: "m1", op: "upsert", doc: { role: "member" } },
        { target: "org:b", table: "auth:member", id: "m2", op: "upsert", doc: { role: "owner" } },
        { target: "org:a", table: "auth:member", id: "m1", op: "upsert", doc: { role: "admin" } },
        { target: "org:a", table: "auth:member", id: "m3", op: "upsert", doc: { role: "member" } },
        { target: "org:a", table: "auth:member", id: "m3", op: "delete" },
        { target: "bad name", table: "auth:member", id: "x", op: "delete" },
      ]);
      const r = await drainReplication(state.storage, env as never, opts(t));
      expect(r).toMatchObject({ delivered: 5, failed: 0, next: null });
      expect([...t.state.get("org:a")!.rows]).toEqual([["auth:member/m1", { role: "admin" }]]);
      // org:a got 2 + 2 rows: each batch says what was delivered before it.
      const a = t.calls.filter((c) => c.target === "org:a").map((c) => (c.args as { prev: number; rows: Array<{ seq: number }> }));
      expect(a.map((x) => [x.prev, x.rows.map((r) => r.seq)])).toEqual([[0, [1, 3]], [3, [4, 5]]]);
      expect(replicationTargets(sql).map((x) => [x.target, x.last_seq, x.pending])).toEqual([["org:a", 5, 0], ["org:b", 2, 0]]);
    });
  });

  it("a failing target backs off without holding the others; after maxAttempts its batch is parked and the target resynced", async () => {
    const t = fakeTargets();
    t.failing.add("org:down");
    await runInDurableObject(box(), async (_i, state) => {
      const sql = state.storage.sql;
      ensureReplicationTables(sql);
      enqueueReplica(sql, [
        { target: "org:down", table: "auth:member", id: "m1", op: "upsert", doc: { role: "member" } },
        { target: "org:up", table: "auth:member", id: "m2", op: "upsert", doc: { role: "member" } },
      ]);
      const first = await drainReplication(state.storage, env as never, opts(t, () => [{ table: "auth:member", id: "m1", doc: { role: "now" } }]));
      expect(first).toMatchObject({ delivered: 1, failed: 1 });
      expect(t.state.get("org:up")!.seq).toBe(2);
      const [down] = replicationTargets(sql, { target: "org:down" });
      expect(down).toMatchObject({ attempts: 1, pending: 1, last_error: "org:down is down" });
      expect(first.next).toBe(down!.next_at);
      // Due again (the backoff passed): the second failure parks the row and asks for a resync.
      sql.exec(`UPDATE _ember_replication_targets SET next_at = 0`);
      await drainReplication(state.storage, env as never, opts(t));
      expect(replicationTargets(sql, { target: "org:down" })[0]).toMatchObject({ snapshot: 1, attempts: 0, pending: 0 });
      expect(sql.exec(`SELECT dead FROM _ember_replication WHERE target = 'org:down'`).toArray()).toEqual([{ dead: 1 }]);
      // The target is back: the resync carries the current rows, cut at the source's last seq.
      t.failing.delete("org:down");
      await drainReplication(state.storage, env as never, opts(t, () => [{ table: "auth:member", id: "m1", doc: { role: "now" } }]));
      expect(t.state.get("org:down")).toEqual({ seq: 2, rows: new Map([["auth:member/m1", { role: "now" }]]) });
      expect(replicationTargets(sql, { target: "org:down" })[0]).toMatchObject({ snapshot: 0, last_seq: 2, dead: 0 });
      expect(nextReplicationAt(sql)).toBeNull();
    });
  });

  it("a target that answers resync (gap) gets a snapshot; deltas up to its cut are dropped, later ones apply", async () => {
    const t = fakeTargets();
    await runInDurableObject(box(), async (_i, state) => {
      const sql = state.storage.sql;
      ensureReplicationTables(sql);
      enqueueReplica(sql, [{ target: "org:a", table: "auth:member", id: "m1", op: "upsert", doc: { v: 1 } }]);
      await drainReplication(state.storage, env as never, opts(t));
      // The target loses everything (a restore): the next delivery (prev 1 > its mark 0) reveals it.
      t.state.delete("org:a");
      enqueueReplica(sql, [{ target: "org:a", table: "auth:member", id: "m2", op: "upsert", doc: { v: 2 } }]);
      let current = [{ table: "auth:member", id: "m1", doc: { v: 1 } }, { table: "auth:member", id: "m2", doc: { v: 2 } }];
      const r = await drainReplication(state.storage, env as never, opts(t, () => current));
      expect(r.next).not.toBeNull();
      expect(replicationTargets(sql, { target: "org:a" })[0]).toMatchObject({ snapshot: 1 });
      // A write lands before the resync runs: it is in the snapshot (current state) and its delta is at or below the cut.
      current = [...current, { table: "auth:member", id: "m3", doc: { v: 3 } }];
      enqueueReplica(sql, [{ target: "org:a", table: "auth:member", id: "m3", op: "upsert", doc: { v: 3 } }]);
      await drainReplication(state.storage, env as never, opts(t, () => current));
      expect(t.state.get("org:a")!.seq).toBe(3);
      expect([...t.state.get("org:a")!.rows.keys()].sort()).toEqual(["auth:member/m1", "auth:member/m2", "auth:member/m3"]);
      expect(replicationTargets(sql, { target: "org:a" })[0]).toMatchObject({ pending: 0, last_seq: 3 });
      // A later write applies on top.
      enqueueReplica(sql, [{ target: "org:a", table: "auth:member", id: "m1", op: "delete" }]);
      await drainReplication(state.storage, env as never, opts(t, () => current));
      expect([...t.state.get("org:a")!.rows.keys()].sort()).toEqual(["auth:member/m2", "auth:member/m3"]);
      // Admin resync of a parked target clears it.
      sql.exec(`UPDATE _ember_replication_targets SET dead = 1`);
      requestSnapshot(sql, "org:a");
      expect(replicationTargets(sql, { target: "org:a" })[0]).toMatchObject({ dead: 0, snapshot: 1 });
    });
  });
});

/** A plain DO wrapped like the Auth DO, replicating `organization`/`member` (test/worker.ts `ReplicaBox`). */
const replicaBox = () => env.REPLICA_BOX.get(env.REPLICA_BOX.idFromName(`replica-${crypto.randomUUID()}`));
const JOURNAL = `CREATE TABLE IF NOT EXISTS _ember_replica_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, row_id NOT NULL, event TEXT NOT NULL, org, user_id, at INTEGER NOT NULL)`;

describe("auth replication: journal conversion", () => {
  it("a conversion that keeps failing backs off exponentially (capped) instead of re-arming the alarm right away", async () => {
    await runInDurableObject(replicaBox(), async (box, state) => {
      const sql = state.storage.sql;
      // The journal has a row, but the tables the reader needs are missing: bootstrap and conversion throw.
      sql.exec(JOURNAL);
      sql.exec(`INSERT INTO _ember_replica_journal (model, row_id, event, org, at) VALUES ('member', 'm1', 'upsert', 'o1', 0)`);
      const due = async () => ((await state.storage.getAlarm()) ?? 0) - Date.now();
      const expire = () => {
        const v = JSON.parse(sql.exec(`SELECT value FROM _ember_replication_meta WHERE key = 'auth_convert'`).one().value as string);
        sql.exec(`UPDATE _ember_replication_meta SET value = ? WHERE key = 'auth_convert'`, JSON.stringify({ ...v, retryAt: 0 }));
      };
      await state.storage.deleteAlarm();
      await box.alarm();
      let s = await box.replicaStatus();
      expect(s).toMatchObject({ journal: 1, convert: { failures: 1, error: expect.stringMatching(/no such table/) } });
      expect(await due()).toBeGreaterThan(500);
      expect(await due()).toBeLessThanOrEqual(1_000);
      // Woken early (a request, another alarm): no retry before the backoff ends, and the alarm stays there.
      await box.alarm();
      expect((await box.replicaStatus()).convert?.failures).toBe(1);
      expect(await due()).toBeGreaterThan(500);
      // Each failure doubles the wait, up to backoffMaxMs (4 s here).
      for (const [failures, max] of [[2, 2_000], [3, 4_000], [4, 4_000]] as const) {
        expire();
        await state.storage.deleteAlarm();
        await box.alarm();
        s = await box.replicaStatus();
        expect(s.convert?.failures).toBe(failures);
        expect(await due()).toBeGreaterThan(max - 500);
        expect(await due()).toBeLessThanOrEqual(max);
      }
      // Fixed (the tables exist): the next try converts, clears the failure and delivers.
      sql.exec(`CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT)`);
      sql.exec(`CREATE TABLE member (id TEXT PRIMARY KEY, organizationId TEXT, role TEXT)`);
      sql.exec(`INSERT INTO organization VALUES ('o1', 'Acme')`);
      sql.exec(`INSERT INTO member VALUES ('m1', 'o1', 'owner')`);
      expire();
      probes.replicaDeliveries.length = 0;
      await box.alarm();
      for (let i = 0; i < 5 && (await state.storage.getAlarm()) !== null; i++) await box.alarm();
      s = await box.replicaStatus();
      expect(s).toMatchObject({ journal: 0, convert: null });
      expect(probes.replicaDeliveries.some((d) => d.target === "org:o1")).toBe(true);
    });
  });

  it("a `resync` journal row (replication turned on again) resyncs every organization, even with the same spec", async () => {
    await runInDurableObject(replicaBox(), async (box, state) => {
      const sql = state.storage.sql;
      sql.exec(JOURNAL);
      sql.exec(`CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT)`);
      sql.exec(`CREATE TABLE member (id TEXT PRIMARY KEY, organizationId TEXT, role TEXT)`);
      sql.exec(`INSERT INTO organization VALUES ('o1', 'Acme'), ('o2', 'Beta')`);
      sql.exec(`INSERT INTO member VALUES ('m1', 'o1', 'owner'), ('m2', 'o2', 'owner')`);
      // Bootstrapped before with this very spec: the fingerprint alone would not resync anything.
      sql.exec(`CREATE TABLE IF NOT EXISTS _ember_replication_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      sql.exec(`INSERT INTO _ember_replication_meta VALUES ('auth', 'v1')`);
      await box.alarm();
      expect((await box.replicaStatus()).targets).toEqual([]);
      // What the Auth DO's first boot with replication on again journals (replicaJournalDDL of @freecorps/ember-auth).
      sql.exec(`INSERT INTO _ember_replica_journal (model, row_id, event, at) VALUES ('*', '*', 'resync', 0)`);
      probes.replicaDeliveries.length = 0;
      for (let i = 0; i < 5 && (i === 0 || (await state.storage.getAlarm()) !== null); i++) await box.alarm();
      const snapshots = probes.replicaDeliveries.filter((d) => "snapshot" in d.args && d.args.snapshot);
      expect([...new Set(snapshots.map((d) => d.target))].sort()).toEqual(["org:o1", "org:o2"]);
      const o1 = snapshots.filter((d) => d.target === "org:o1").flatMap((d) => (d.args as { snapshot: { rows: Array<{ table: string; id: unknown }> } }).snapshot.rows.map((r) => `${r.table}/${r.id}`));
      expect(o1.sort()).toEqual(["auth:member/m1", "auth:organization/o1"]);
      expect(await box.replicaStatus()).toMatchObject({ journal: 0, convert: null });
    });
  });
});
