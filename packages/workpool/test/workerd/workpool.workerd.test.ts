/**
 * The workpool component in workerd: real runtime (Worker + Shard DOs, alarms, action jobs under a lease). Action jobs
 * are delivered to the Worker's queue consumer by the test as soon as the shard dispatches them, all at once, so the
 * cap is measured under real concurrency; a stalled queue (a message never delivered) shows the lease re-run.
 */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { probes } from "./worker.ts";
import type { ActionJobMessage } from "@freecorps/ember-runtime";

const call = async (kind: "query" | "mutation" | "action", fn: string, args: unknown, shard: string) => {
  const res = await SELF.fetch(`http://ember/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
  const body = (await res.json()) as { ok: boolean; value?: any; error?: unknown };
  if (!body.ok) throw new Error(`${kind} ${fn}: ${JSON.stringify(body)}`);
  return body.value;
};
const stub = (shard: string) => env.SHARD.get(env.SHARD.idFromName(shard));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deliver(msg: ActionJobMessage) {
  const message = { id: msg.jobId, body: msg, attempts: 1, timestamp: new Date(), ack: () => {}, retry: () => {} };
  await worker.queue({ queue: "ember-actions", messages: [message] } as any, env as any, {} as any);
}

/** Delivers every action job the given shards dispatch, as soon as it shows up and concurrently, until `done()`. */
async function pumpQueue(shards: string[], done: () => Promise<boolean>, timeoutMs = 15_000) {
  const running = new Set<Promise<void>>();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const mine = probes.actions.filter((m) => shards.includes(m.shard));
    probes.actions = probes.actions.filter((m) => !shards.includes(m.shard));
    for (const m of mine) {
      const p: Promise<void> = deliver(m).finally(() => running.delete(p));
      running.add(p);
    }
    if (!running.size && (await done())) return;
    await sleep(5);
  }
  throw new Error("pumpQueue: timed out");
}

const reset = () => Object.assign(probes, { inFlight: 0, max: 0, started: [] });

describe("workpool in workerd", () => {
  it("a burst of 20 with maxParallelism 3: never more than 3 at once, FIFO, one onComplete each", async () => {
    reset();
    const shard = "wp:burst";
    const labels = Array.from({ length: 20 }, (_, i) => `b${String(i).padStart(2, "0")}`);
    const ids = (await call("mutation", "api:enqueue", { labels, max: 3 }, shard)) as string[];
    await pumpQueue([shard], async () => (await call("query", "api:done", {}, shard)).length === 20);
    expect(probes.max).toBe(3);
    // FIFO: the pool hands out items in order; calls delivered in the same wave may start in any order among themselves.
    expect([...probes.started].sort()).toEqual(labels);
    for (const [i, l] of labels.entries()) expect(Math.abs(probes.started.indexOf(l) - i)).toBeLessThan(3);
    const finished = (await call("query", "api:done", {}, shard)) as Array<{ workId: string; label: string; result: unknown }>;
    expect(finished.map((d) => d.workId).sort()).toEqual([...ids].sort());
    for (const d of finished) expect(d.result).toEqual({ kind: "success", returnValue: `done:${d.label}` });
    expect(await call("query", "api:stats", {}, shard)).toMatchObject({ pending: 0, running: 0, totals: { enqueued: 20, succeeded: 20 } });
  });

  it("one cap across shards: a pool pinned to global:main, enqueued from actions on two org shards", async () => {
    reset();
    await call("action", "api:enqueueGlobal", { labels: ["a1", "a2", "a3", "a4", "a5"] }, "org:a");
    await call("action", "api:enqueueGlobal", { labels: ["b1", "b2", "b3", "b4", "b5"] }, "org:b");
    await pumpQueue(["global:main", "org:a", "org:b"], async () => (await call("query", "api:globalStats", {}, "global:main")).totals.succeeded >= 10);
    expect(probes.max).toBe(2);
    expect(probes.started).toHaveLength(10);
    expect(await call("query", "api:globalStats", {}, "org:a")).toMatchObject({ totals: { enqueued: 0 } });
  });

  it("a stalled queue: the lease runs out, the shard runs the item itself; the late message runs nothing", async () => {
    reset();
    const shard = "wp:lease";
    const [id] = (await call("mutation", "api:enqueue", { labels: ["stalled"], max: 1 }, shard)) as string[];
    let msg: ActionJobMessage | undefined;
    for (let i = 0; i < 200 && !msg; i++) {
      msg = probes.actions.find((m) => m.shard === shard);
      if (!msg) await sleep(5);
    }
    expect(msg?.fn).toBe("@aiPool/lib:run");
    probes.actions = probes.actions.filter((m) => m !== msg); // the Queue accepted it and never delivers
    // The 15-minute lease, fast-forwarded: the dispatched row is due now.
    await runInDurableObject(stub(shard), (_i, state) => {
      state.storage.sql.exec("UPDATE _jobs SET run_at = ? WHERE job_id = ? AND state = 'dispatched'", Date.now() - 1, msg!.jobId);
    });
    await runDurableObjectAlarm(stub(shard));
    for (let i = 0; i < 200 && (await call("query", "api:done", {}, shard)).length === 0; i++) await sleep(10);
    expect(await call("query", "api:status", { id }, shard)).toEqual({ state: "finished", result: { kind: "success", returnValue: "done:stalled" } });
    await deliver(msg!); // arrives late: its claim is refused
    await sleep(50);
    expect(probes.started).toEqual(["stalled"]);
    expect(await call("query", "api:done", {}, shard)).toHaveLength(1);
  });

  it("a running item whose job failed is reclaimed by the tick: its slot goes to the next item", async () => {
    reset();
    const shard = "wp:reclaim";
    const [lost, next] = (await call("mutation", "api:enqueue", { labels: ["lost", "next"], max: 1 }, shard)) as string[];
    let msg: ActionJobMessage | undefined;
    for (let i = 0; i < 200 && !msg; i++) {
      msg = probes.actions.find((m) => m.shard === shard);
      if (!msg) await sleep(5);
    }
    probes.actions = probes.actions.filter((m) => m !== msg);
    // The scheduler gave up on the job (what `maxAttempts` failures of the run leave): nothing will report.
    await runInDurableObject(stub(shard), (_i, state) => {
      state.storage.sql.exec("UPDATE _jobs SET state = 'failed', last_error = 'action_failed: worker crashed', run_at = ? WHERE job_id = ?", Date.now(), msg!.jobId);
    });
    // The tick (reclaimIntervalMs 300 in this install) finds it, fails it, and starts `next`.
    await pumpQueue([shard], async () => (await call("query", "api:status", { id: next }, shard))?.state === "finished");
    expect(await call("query", "api:status", { id: lost }, shard)).toEqual({
      state: "finished",
      result: { kind: "failed", error: "lost: its job failed (action_failed: worker crashed)" },
    });
    expect(probes.started).toEqual(["next"]);
    expect((await call("query", "api:stats", {}, shard)).totals).toMatchObject({ reclaimed: 1, failed: 1, succeeded: 1 });
  });
});
