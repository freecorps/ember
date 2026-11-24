// `.replicated()` tables, source side (replicated.ts) on a plain SQLite DO with the real engine as the source and a
// fake delivery: one log row per change, per-target order and cursors, kinds outside `to` skipped without a call,
// bootstrap snapshot cut at the log, backoff of one target without holding the others, gap → resync, log GC, bounded
// concurrency, the catalog. End to end with real shards: examples/files-auth-jobs/test/replicated.test.ts.
import { env, runInDurableObject } from "cloudflare:test";
import { createEngine, defineSchema, defineShard, defineTable, mutationGeneric, v, type ReplicaApplyArgs, type ReplicaApplyResult, type RowChange } from "@freecorps/ember-server";
import { describe, expect, it } from "vitest";
import { DoSqlDriver, drainBroadcast, ensureBroadcastTables, listDirectory, logReplicated, nextBroadcastAt, registerShard, resyncAllTargets, syncBroadcastTargets, broadcastStatus, type BroadcastOptions } from "../src/index.ts";
import { replicatedSet } from "../src/replicated.ts";

const box = () => env.OUTBOX.get(env.OUTBOX.idFromName(`replicated-${crypto.randomUUID()}`));

const schema = defineSchema({
  tables: {
    fxRates: defineTable({ base: v.string(), rate: v.number() }).index("by_base", ["base"]).replicated(),
    plans: defineTable({ name: v.string() }).replicated({ to: ["org"] }),
  },
  shards: { org: defineShard({ key: v.string() }), room: defineShard({ key: v.string() }) },
});
const functions = {
  "w:put": mutationGeneric({ args: { table: v.string(), doc: v.any() }, handler: (ctx, a: { table: string; doc: unknown }) => (ctx.db as any).insert(a.table, a.doc) }),
  "w:patch": mutationGeneric({ args: { id: v.string(), doc: v.any() }, handler: (ctx, a: { id: string; doc: unknown }) => (ctx.db as any).patch(a.id, a.doc) }),
  "w:del": mutationGeneric({ args: { id: v.string() }, handler: (ctx, a: { id: string }) => (ctx.db as any).delete(a.id) }),
};

/** global:main's engine over the DO's SQLite, logging like the Shard's commit does. */
function source(storage: DurableObjectStorage) {
  const driver = new DoSqlDriver(storage);
  const engine = createEngine({ schema, functions, driver, shardName: () => "global:main" });
  engine.migrate();
  const tables = replicatedSet(schema.manifest);
  ensureBroadcastTables(driver);
  const run = (fn: string, args: unknown) =>
    driver.transaction(() => {
      const r = engine.runMutation(fn, args);
      logReplicated(driver, tables, r.changes as RowChange[]);
      return r.value as string;
    });
  return { driver, engine, run };
}

/** Targets that apply like `_ember:replicaApply` (mark, gap check), in memory. */
function fakeTargets() {
  const state = new Map<string, { seq: number; rows: Map<string, Record<string, unknown>> }>();
  const calls: Array<{ target: string; args: ReplicaApplyArgs }> = [];
  const failing = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const deliver = async (target: string, args: ReplicaApplyArgs): Promise<ReplicaApplyResult> => {
    calls.push({ target, args });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    if (failing.has(target)) throw new Error(`${target} is down`);
    const s = state.get(target) ?? { seq: 0, rows: new Map() };
    state.set(target, s);
    if ("snapshot" in args && args.snapshot) {
      if (args.snapshot.first) s.rows.clear();
      for (const r of args.snapshot.rows) s.rows.set(String(r.id), r.doc);
      if (args.snapshot.end) s.seq = args.snapshot.end.cut;
      return { seq: s.seq, applied: args.snapshot.rows.length, skipped: 0 };
    }
    const d = args as Extract<ReplicaApplyArgs, { rows: unknown[] }>;
    if (s.seq < d.prev) return { seq: s.seq, applied: 0, skipped: d.rows.length, resync: true };
    for (const r of d.rows) {
      if (r.seq <= s.seq) continue;
      if (r.op === "delete") s.rows.delete(String(r.id));
      else s.rows.set(String(r.id), r.doc!);
      s.seq = r.seq;
    }
    return { seq: s.seq, applied: d.rows.length, skipped: 0 };
  };
  return { state, calls, failing, deliver, maxInFlight: () => maxInFlight };
}

const opts = (t: ReturnType<typeof fakeTargets>, o: Partial<BroadcastOptions> = {}): BroadcastOptions => ({ deliver: t.deliver, maxAttempts: 2, backoffBaseMs: 10_000, ...o });

describe(".replicated() source (global:main)", () => {
  it("the drain creates its tables once per driver, not every turn", async () => {
    const t = fakeTargets();
    await runInDurableObject(box(), async (_i, state) => {
      const { driver, run } = source(state.storage);
      const ddl: string[] = [];
      const counted = { exec: (q: string, ...b: unknown[]) => (/^\s*CREATE /i.test(q) && ddl.push(q), driver.exec(q, ...(b as []))), transaction: <T>(f: () => T) => driver.transaction(f) } as unknown as typeof driver;
      await drainBroadcast(counted, schema.manifest, opts(t));
      const first = ddl.length;
      expect(first).toBeGreaterThan(0);
      run("w:put", { table: "fxRates", doc: { base: "EUR", rate: 6 } });
      await drainBroadcast(counted, schema.manifest, opts(t));
      await drainBroadcast(counted, schema.manifest, opts(t));
      expect(ddl).toHaveLength(first);
    });
  });

  it("bootstraps new targets with a snapshot, then delivers deltas in order; kinds outside `to` get no call", async () => {
    const t = fakeTargets();
    await runInDurableObject(box(), async (_i, state) => {
      const { driver, run } = source(state.storage);
      const usd = run("w:put", { table: "fxRates", doc: { base: "USD", rate: 5 } });
      const pro = run("w:put", { table: "plans", doc: { name: "pro" } });
      expect(registerShard(driver, schema.manifest, "org:a")).toEqual({ registered: true, snapshot: true });
      expect(registerShard(driver, schema.manifest, "room:1")).toEqual({ registered: true, snapshot: true });
      expect(registerShard(driver, schema.manifest, "org:a")).toEqual({ registered: false, snapshot: false });
      expect(nextBroadcastAt(driver)).not.toBeNull();

      await drainBroadcast(driver, schema.manifest, opts(t));
      expect([...t.state.get("org:a")!.rows.keys()].sort()).toEqual([usd, pro].sort());
      expect([...t.state.get("room:1")!.rows.keys()]).toEqual([usd]);
      // Same `_id` and `_creationTime` as the source.
      expect(t.state.get("org:a")!.rows.get(usd)).toMatchObject({ _id: usd, base: "USD", rate: 5 });
      // The bootstrap's cut covered the log: nothing pending, the log collected.
      expect(nextBroadcastAt(driver)).toBeNull();
      expect(broadcastStatus(driver).targets.every((x) => x.pending === 0)).toBe(true);

      t.calls.length = 0;
      run("w:patch", { id: usd, doc: { rate: 6 } });
      run("w:patch", { id: pro, doc: { name: "pro+" } });
      run("w:del", { id: usd });
      await drainBroadcast(driver, schema.manifest, opts(t));
      expect(t.state.get("org:a")!.rows.has(usd)).toBe(false);
      expect(t.state.get("org:a")!.rows.get(pro)).toMatchObject({ name: "pro+" });
      const room = t.calls.filter((c) => c.target === "room:1");
      // room gets the two fxRates rows in one call, and prev chains over the skipped plans row.
      expect(room).toHaveLength(1);
      expect((room[0]!.args as { rows: Array<{ table: string }> }).rows.map((r) => r.table)).toEqual(["fxRates", "fxRates"]);
      const org = t.calls.find((c) => c.target === "org:a")!.args as { prev: number; rows: Array<{ seq: number }> };
      expect(org.rows.map((r) => r.seq)).toEqual([...org.rows.map((r) => r.seq)].sort((a, b) => a - b));

      // Only plans changes: room is skipped without a call, and its next delivery's prev is still what it applied.
      t.calls.length = 0;
      run("w:patch", { id: pro, doc: { name: "max" } });
      await drainBroadcast(driver, schema.manifest, opts(t));
      expect(t.calls.map((c) => c.target)).toEqual(["org:a"]);
      run("w:put", { table: "fxRates", doc: { base: "EUR", rate: 6 } });
      await drainBroadcast(driver, schema.manifest, opts(t));
      expect(t.state.get("room:1")!.rows.size).toBe(1);
      expect(broadcastStatus(driver).targets.every((x) => x.pending === 0)).toBe(true);
    });
  });

  it("per turn: one snapshot read per kind and cut, one log page per cursor, one decode per row", async () => {
    /** A driver counting snapshot reads (user tables) and log page reads. */
    const counting = (driver: DoSqlDriver) => {
      const n = { snap: 0, page: 0 };
      const db = {
        exec: (q: string, ...b: unknown[]) => {
          if (/^\s*SELECT/i.test(q) && !/_ember|sqlite_/.test(q)) n.snap++;
          if (q.includes("FROM _ember_bcast_log WHERE seq > ?")) n.page++;
          return driver.exec(q, ...(b as []));
        },
        transaction: <T>(f: () => T) => driver.transaction(f),
      } as unknown as DoSqlDriver;
      return { db, n };
    };
    // Baseline: one target per kind.
    let baseline = 0;
    await runInDurableObject(box(), async (_i, state) => {
      const { driver, run } = source(state.storage);
      run("w:put", { table: "fxRates", doc: { base: "USD", rate: 5 } });
      run("w:put", { table: "plans", doc: { name: "pro" } });
      registerShard(driver, schema.manifest, "org:a");
      registerShard(driver, schema.manifest, "room:a");
      const { db, n } = counting(driver);
      await drainBroadcast(db, schema.manifest, opts(fakeTargets()));
      baseline = n.snap;
    });
    expect(baseline).toBeGreaterThan(0);

    const t = fakeTargets();
    await runInDurableObject(box(), async (_i, state) => {
      const { driver, run } = source(state.storage);
      const usd = run("w:put", { table: "fxRates", doc: { base: "USD", rate: 5 } });
      const pro = run("w:put", { table: "plans", doc: { name: "pro" } });
      const targets = ["org:a", "org:b", "org:c", "org:d", "org:e", "room:a", "room:b"];
      for (const x of targets) registerShard(driver, schema.manifest, x);
      const { db, n } = counting(driver);
      await drainBroadcast(db, schema.manifest, opts(t));
      // Seven targets, two kinds: the reads of one target per kind.
      expect(n.snap).toBe(baseline);
      for (const x of targets) expect([...t.state.get(x)!.rows.keys()].sort()).toEqual(x.startsWith("org:") ? [usd, pro].sort() : [usd]);

      // Deltas: every target reads the same page from the same cursor; read and decoded once.
      t.calls.length = 0;
      n.page = 0;
      run("w:patch", { id: usd, doc: { rate: 6 } });
      run("w:put", { table: "fxRates", doc: { base: "EUR", rate: 7 } });
      await drainBroadcast(db, schema.manifest, opts(t));
      expect(n.page).toBe(1);
      const docs = t.calls.map((c) => (c.args as { rows: Array<{ doc?: unknown }> }).rows[0]!.doc);
      expect(docs).toHaveLength(targets.length);
      for (const d of docs) expect(d).toBe(docs[0]);
      for (const x of targets) expect(t.state.get(x)!.rows.get(usd)).toMatchObject({ rate: 6 });
    });
  });

  it("a commit between two targets' snapshots in one turn: the later one reads the new rows, nobody misses them", async () => {
    await runInDurableObject(box(), async (_i, state) => {
      const { driver, run } = source(state.storage);
      run("w:put", { table: "fxRates", doc: { base: "USD", rate: 5 } });
      for (const x of ["org:a", "org:b", "org:c"]) registerShard(driver, schema.manifest, x);
      const t = fakeTargets();
      let mid: string | null = null;
      const deliver: BroadcastOptions["deliver"] = async (target, args) => {
        const r = await t.deliver(target, args);
        mid ??= run("w:put", { table: "fxRates", doc: { base: "EUR", rate: 6 } });
        return r;
      };
      await drainBroadcast(driver, schema.manifest, opts(t, { deliver, concurrency: 1 }));
      const snaps = t.calls.filter((c) => "snapshot" in c.args).map((c) => (c.args as { snapshot: { rows: unknown[] } }).snapshot.rows.length);
      expect(snaps).toEqual([1, 2, 2]);
      for (const x of ["org:a", "org:b", "org:c"]) expect(t.state.get(x)!.rows.size).toBe(2);
      expect(broadcastStatus(driver).targets.every((x) => x.pending === 0)).toBe(true);
    });
  });

  it("a failing target backs off alone; a lost target (gap) gets a resync; a restore resyncs all", async () => {
    const t = fakeTargets();
    await runInDurableObject(box(), async (_i, state) => {
      const { driver, run } = source(state.storage);
      registerShard(driver, schema.manifest, "org:a");
      registerShard(driver, schema.manifest, "org:b");
      await drainBroadcast(driver, schema.manifest, opts(t));
      t.failing.add("org:b");
      const id = run("w:put", { table: "fxRates", doc: { base: "USD", rate: 5 } });
      const r = await drainBroadcast(driver, schema.manifest, opts(t));
      expect(r.failed).toBe(1);
      expect(t.state.get("org:a")!.rows.has(id)).toBe(true);
      const b = broadcastStatus(driver, { target: "org:b" }).targets[0]!;
      expect(b).toMatchObject({ attempts: 1, pending: 1, last_error: "org:b is down" });
      // The log is kept for org:b.
      expect(r.collected).toBe(0);

      // org:b comes back having lost its state (a restore): its mark is 0, the source's prev is not → resync.
      t.failing.delete("org:b");
      t.state.delete("org:b");
      state.storage.sql.exec(`UPDATE _ember_bcast_targets SET next_at = 0, last_seq = 1 WHERE target = 'org:b'`);
      await drainBroadcast(driver, schema.manifest, opts(t));
      expect(broadcastStatus(driver, { target: "org:b" }).targets[0]!.snapshot).toBe(1);
      await drainBroadcast(driver, schema.manifest, opts(t));
      expect(t.state.get("org:b")!.rows.has(id)).toBe(true);

      expect(resyncAllTargets(driver, schema.manifest)).toBe(2);
      t.calls.length = 0;
      await drainBroadcast(driver, schema.manifest, opts(t));
      expect(t.calls.every((c) => "snapshot" in c.args)).toBe(true);
    });
  });

  it("delivers with bounded concurrency; a schema change resyncs every target once", async () => {
    const t = fakeTargets();
    await runInDurableObject(box(), async (_i, state) => {
      const { driver, run } = source(state.storage);
      expect(syncBroadcastTargets(driver, schema.manifest)).toBe(0);
      for (let i = 0; i < 20; i++) registerShard(driver, schema.manifest, `org:${String(i).padStart(2, "0")}`);
      run("w:put", { table: "fxRates", doc: { base: "USD", rate: 5 } });
      await drainBroadcast(driver, schema.manifest, opts(t, { concurrency: 3 }));
      expect(t.maxInFlight()).toBeLessThanOrEqual(3);
      expect(t.state.size).toBe(20);
      // Unchanged schema: nothing. A new version of the replicated tables: every target.
      expect(syncBroadcastTargets(driver, schema.manifest)).toBe(0);
      const next = defineSchema({ tables: { ...schema.tables, fxRates: defineTable({ base: v.string(), rate: v.number(), note: v.optional(v.string()) }).index("by_base", ["base"]).replicated() }, shards: schema.shards });
      expect(syncBroadcastTargets(driver, next.manifest)).toBe(20);
      expect(syncBroadcastTargets(driver, next.manifest)).toBe(0);
      // Turned off (a deploy without `.replicated()` tables), then on again with the very same tables: writes made
      // meanwhile were never logged, so every target is resynced although the version is the one it had.
      const off = defineSchema({ tables: { fxRates: defineTable({ base: v.string(), rate: v.number(), note: v.optional(v.string()) }).index("by_base", ["base"]), plans: defineTable({ name: v.string() }) }, shards: schema.shards });
      expect(syncBroadcastTargets(driver, off.manifest)).toBe(0);
      expect(broadcastStatus(driver).targets).toEqual([]);
      expect(syncBroadcastTargets(driver, next.manifest)).toBe(20);
      expect(broadcastStatus(driver).targets.every((x) => x.snapshot === 1)).toBe(true);
    });
    // global:main of an app that never had `.replicated()` tables runs the same check at every boot: it creates nothing.
    await runInDurableObject(box(), async (_i, state) => {
      const driver = new DoSqlDriver(state.storage);
      const none = defineSchema({ tables: { plans: defineTable({ name: v.string() }) } });
      expect(syncBroadcastTargets(driver, none.manifest)).toBe(0);
      expect(state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name LIKE '_ember_bcast%'`).toArray()).toEqual([]);
    });
  });

  it("catalog: every kind, pages in key order", async () => {
    await runInDurableObject(box(), async (_i, state) => {
      const driver = new DoSqlDriver(state.storage);
      for (const k of ["c", "a", "b", "d"]) registerShard(driver, schema.manifest, `org:${k}`);
      registerShard(driver, schema.manifest, "room:x");
      expect(registerShard(driver, schema.manifest, "global:main")).toEqual({ registered: false, snapshot: false });
      const p1 = listDirectory(driver, "org", { limit: 3 });
      expect(p1.shards.map((s) => s.shard)).toEqual(["org:a", "org:b", "org:c"]);
      expect(p1.next).toBe("c");
      const p2 = listDirectory(driver, "org", { cursor: p1.next, limit: 3 });
      expect(p2).toMatchObject({ shards: [{ shard: "org:d", kind: "org", key: "d" }], next: null });
      expect(listDirectory(driver, "room").shards.map((s) => s.shard)).toEqual(["room:x"]);
      expect(listDirectory(driver, "nope")).toEqual({ shards: [], next: null });
    });
  });
});
