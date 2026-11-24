// What an idle or nearly idle shard costs (DO duration, requests, rows): the hourly tick after an idle hour records no
// bookmark and reports nothing, its cleanups skip tables with nothing to clean, `armAlarm` takes `next_maint` and
// `backfill` from memory, and a commit whose metrics points are all sampled out does not wait for durability.
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setMetricsSink, type AnalyticsEngineDatasetLike } from "../src/metrics.ts";
import type { Shard } from "../src/shard.ts";
import { api, shardStub } from "./helpers.ts";

type Exec = (sql: string, ...params: unknown[]) => unknown;
interface Internals {
  driver: { exec: Exec };
  env: Record<string, unknown>;
  emitAfterCommit(kind: string, items: Array<{ fn: string; at: number; error: { code: string } | null; rowsRead: number; rowsWritten: number }>): void;
}
const internals = (inst: Shard) => inst as unknown as Internals;

/** Runs `f` recording every statement the shard's driver executes (with its parameters). */
async function recording(inst: Shard, f: () => Promise<void>): Promise<Array<[string, unknown[]]>> {
  const d = internals(inst).driver;
  const exec = d.exec;
  const seen: Array<[string, unknown[]]> = [];
  d.exec = (sql, ...params) => {
    seen.push([sql, params]);
    return exec.call(d, sql, ...params);
  };
  try {
    await f();
  } finally {
    d.exec = exec;
  }
  return seen;
}

const meta = (state: DurableObjectState, k: string) => state.storage.sql.exec("SELECT v FROM _ember_rt_meta WHERE k = ?", k).toArray()[0]?.v ?? null;

afterEach(() => setMetricsSink(null));

describe("idle shard cost", () => {
  it("the tick after an idle hour stands down without a bookmark or a catalog report; an active one keeps both", async () => {
    const shard = "idle:maint";
    const stub = shardStub(shard);
    await api("mutation", { fn: "runs:add", args: { label: "one" }, shard });
    const reasons = async () => (await stub.bookmarks(shard)).map((b) => b.reason);
    const before = await reasons();
    // The tick a write armed: active (a commit since the last one).
    await runInDurableObject(stub, async (inst: Shard, state) => {
      state.storage.sql.exec("UPDATE _ember_rt_meta SET v = '0' WHERE k = 'next_maint'");
      await inst.alarm();
      expect(Number(meta(state, "next_maint"))).toBeGreaterThan(Date.now());
    });
    expect(await reasons()).toEqual([...before, "hourly"]);
    // An hour later, nothing committed: no bookmark, no catalog read, no DELETE on tables with nothing to clean; the
    // tick stands down (no next_maint) and the alarm with it.
    let seen: Array<[string, unknown[]]> = [];
    await runInDurableObject(stub, async (inst: Shard, state) => {
      state.storage.sql.exec("UPDATE _ember_rt_meta SET v = '0' WHERE k = 'next_maint'");
      seen = await recording(inst, () => inst.alarm());
      expect(meta(state, "next_maint")).toBeNull();
    });
    expect(await reasons()).toEqual([...before, "hourly"]);
    expect(seen.filter(([, p]) => p[0] === "catalog_at")).toEqual([]);
    expect(seen.filter(([s]) => /DELETE FROM _ember_(bookmarks|sub_ident)/.test(s))).toEqual([]);
    expect((await stub.inspect()).alarm).toBeNull();
    // The next write arms the tick again, and that tick is active.
    await api("mutation", { fn: "runs:add", args: { label: "two" }, shard });
    await runInDurableObject(stub, async (inst: Shard, state) => {
      expect(meta(state, "next_maint")).not.toBeNull();
      state.storage.sql.exec("UPDATE _ember_rt_meta SET v = '0' WHERE k = 'next_maint'");
      await inst.alarm();
    });
    expect(await reasons()).toEqual([...before, "hourly", "hourly"]);
  });

  it("the maintenance deletes bookmarks past retention and old _ember_sub_ident rows when there are some", async () => {
    const shard = "idle:retention";
    const stub = shardStub(shard);
    await api("mutation", { fn: "runs:add", args: { label: "one" }, shard });
    await runInDurableObject(stub, async (inst: Shard, state) => {
      const old = Date.now() - 31 * 86_400_000;
      // Ids follow time: the old rows come first, as they would.
      state.storage.sql.exec("UPDATE _ember_bookmarks SET id = id + 1000");
      state.storage.sql.exec("INSERT INTO _ember_bookmarks(id, at, bookmark, reason) VALUES (1, ?, 'x', 'hourly')", old);
      state.storage.sql.exec("INSERT INTO _ember_sub_ident(client_id, qid, identity, at) VALUES ('c', '1', 'anon', ?), ('c', '2', 'anon', ?)", old, Date.now());
      state.storage.sql.exec("UPDATE _ember_rt_meta SET v = '0' WHERE k = 'next_maint'");
      await inst.alarm();
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM _ember_bookmarks WHERE at < ?", Date.now() - 30 * 86_400_000).one().n).toBe(0);
      expect(state.storage.sql.exec("SELECT qid FROM _ember_sub_ident").toArray()).toEqual([{ qid: "2" }]);
    });
  });

  it("armAlarm reads next_maint and backfill once, until one of them is written", async () => {
    const shard = "idle:arm-meta";
    const stub = shardStub(shard);
    const metaReads = async () => (await stub.inspect()).stats.alarmMetaReads;
    await api("mutation", { fn: "runs:add", args: { label: "one" }, shard });
    // Scheduler RPCs arm on every call: after the first, the meta comes from memory.
    await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "a" }, runAt: Date.now() + 3_600_000 * 5 });
    const r0 = await metaReads();
    for (let i = 0; i < 5; i++) await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: `j${i}` }, runAt: Date.now() + 3_600_000 * 5 });
    expect(await metaReads()).toBe(r0);
    const alarm = (await stub.inspect()).alarm!;
    // The tick (the hourly maintenance) is what the alarm waits for: it is still the hour the first commit armed.
    expect(alarm).toBeLessThan(Date.now() + 3_600_000 + 1000);
    // The alarm turn writes next_maint (setMeta): the arm at its end reads it again, and the alarm follows.
    await runInDurableObject(stub, async (inst: Shard, state) => {
      state.storage.sql.exec("UPDATE _ember_rt_meta SET v = '0' WHERE k = 'next_maint'");
      await inst.alarm();
      expect((await state.storage.getAlarm())!).toBe(Number(meta(state, "next_maint")));
    });
    expect(await metaReads()).toBeGreaterThan(r0);
  });

  it("a commit whose points are all sampled out does not wait for durability; an error point still does", async () => {
    const points: unknown[] = [];
    const ds: AnalyticsEngineDatasetLike = { writeDataPoint: (p) => void points.push(p) };
    setMetricsSink(ds);
    const shard = "idle:sample";
    await api("mutation", { fn: "runs:add", args: { label: "one" }, shard });
    points.length = 0;
    await runInDurableObject(shardStub(shard), async (inst: Shard, state) => {
      const i = internals(inst);
      const sync = state.storage.sync.bind(state.storage);
      let syncs = 0;
      state.storage.sync = () => {
        syncs++;
        return sync();
      };
      const prev = i.env.EMBER_METRICS_SAMPLE;
      i.env.EMBER_METRICS_SAMPLE = "0";
      try {
        const ok = { fn: "runs:add", at: Date.now(), error: null, rowsRead: 1, rowsWritten: 1 };
        i.emitAfterCommit("mutation", [ok, ok]);
        expect(syncs).toBe(0);
        i.emitAfterCommit("mutation", [ok, { ...ok, error: { code: "Boom" } }]);
        expect(syncs).toBe(1);
        await sync();
        await new Promise((r) => setTimeout(r, 0));
      } finally {
        i.env.EMBER_METRICS_SAMPLE = prev;
        state.storage.sync = sync;
      }
    });
    // Only the error point, written once (not drawn again).
    expect(points).toHaveLength(1);
    expect(JSON.stringify(points[0])).toContain("Boom");
  });
});
