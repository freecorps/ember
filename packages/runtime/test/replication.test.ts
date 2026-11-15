// The replication outbox (replication.ts) on a plain SQLite DO, with a fake delivery: per-target order, backoff of one
// target without holding the others, parking of a batch that keeps failing (then a resync), gap → resync, snapshot cut.
// End to end with the real Auth DO and real shards: examples/files-auth-jobs/test/orgs.test.ts.
import { env, runInDurableObject } from "cloudflare:test";
import type { ReplicaApplyArgs, ReplicaApplyResult } from "@freecorps/ember-server";
import { describe, expect, it } from "vitest";
import { drainReplication, enqueueReplica, ensureReplicationTables, nextReplicationAt, replicationTargets, requestSnapshot, type ReplicationOptions } from "../src/index.ts";

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
