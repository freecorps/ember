// `ctx.scheduler.get/list` (PLAN §8, §22 L7): finished jobs stay in `_jobs` (`scheduler.retainMs`, 7 days), job reads
// are reactive, and the hourly maintenance collects them.
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setEmberConfig } from "../src/config.ts";
import type { Shard } from "../src/shard.ts";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";
import { config } from "./worker.ts";

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

const status = async (shard: string, id: string) => (await api("query", { fn: "jobs:status", args: { id }, shard })).body.value;

describe("ctx.scheduler.get / list", () => {
  it("pending → success with scheduledTime and completedTime; the row stays for get()", async () => {
    const shard = "sget:run";
    const t0 = Date.now();
    await api("mutation", { fn: "jobs:schedule", args: { items: [{ label: "x", delayMs: 30 }] }, shard });
    const [job] = (await api("query", { fn: "jobs:listJobs", args: {}, shard })).body.value;
    expect(job).toMatchObject({ name: "jobs:record", args: { label: "x" }, state: { kind: "pending" }, attempts: 0 });
    expect(job.scheduledTime).toBeGreaterThanOrEqual(t0 + 30);
    expect(job.completedTime).toBeUndefined();
    const done = await until(() => status(shard, job.id), (j) => j?.state.kind === "success");
    expect(done).toMatchObject({ id: job.id, state: { kind: "success" }, scheduledTime: job.scheduledTime, attempts: 1 });
    expect(done.completedTime).toBeGreaterThanOrEqual(job.scheduledTime);
    expect((await api("query", { fn: "jobs:listJobs", args: { state: "success" }, shard })).body.value.map((j: { id: string }) => j.id)).toEqual([job.id]);
    expect((await api("query", { fn: "jobs:listJobs", args: { state: "pending" }, shard })).body.value).toEqual([]);
    // inspect().jobs keeps meaning "still to run, or failed".
    const info = await shardStub(shard).inspect();
    expect(info.jobs).toEqual([]);
    expect(info.finishedJobs).toBe(1);
    expect(await status(shard, "job_unknown")).toBeNull();
  });

  it("failed after its last attempt, with the error; canceled from a mutation, an action and the RPC", async () => {
    const shard = "sget:fail";
    const stub = shardStub(shard);
    const failing = (await stub.enqueueJob(shard, { fn: "jobs:flaky", args: { label: "never-get", failTimes: 99 }, maxAttempts: 2 })).id!;
    const f = await until(() => status(shard, failing), (j) => j?.state.kind === "failed");
    expect(f).toMatchObject({ state: { kind: "failed", error: expect.stringContaining("flaky attempt 2") }, attempts: 2 });
    expect(f.completedTime).toEqual(expect.any(Number));

    const a = (await api("mutation", { fn: "jobs:later", args: { label: "a" }, shard })).body.value;
    expect((await api("mutation", { fn: "jobs:cancelAndRead", args: { id: a }, shard })).body.value).toBe("canceled");
    expect(await status(shard, a)).toMatchObject({ state: { kind: "canceled" }, completedTime: expect.any(Number) });
    const b = (await api("mutation", { fn: "jobs:later", args: { label: "b" }, shard })).body.value;
    expect(await stub.cancelJob(shard, b)).toBe(true);
    expect(await stub.cancelJob(shard, b)).toBe(false);
    expect((await status(shard, b)).state.kind).toBe("canceled");
  });

  it("a finished or cancelled job frees its dedup key (the row stays, the key does not)", async () => {
    const shard = "sget:dedup";
    const stub = shardStub(shard);
    const done = (await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "d1" }, dedupKey: "once" })).id!;
    expect(done).toMatch(/^job_/);
    expect((await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "d1" }, dedupKey: "once" })).id).toBeNull();
    await until(() => status(shard, done), (j) => j?.state.kind === "success");
    const next = (await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "d2" }, dedupKey: "once", runAt: Date.now() + 60_000 })).id!;
    expect(next).toMatch(/^job_/);
    expect(await stub.cancelJob(shard, next)).toBe(true);
    expect((await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "d3" }, dedupKey: "once", runAt: Date.now() + 60_000 })).id).toMatch(/^job_/);
    // The finished rows still answer get().
    expect((await status(shard, done)).state.kind).toBe("success");
    expect((await status(shard, next)).state.kind).toBe("canceled");
  });

  it("list() refuses a state that is not one (inherited keys included)", async () => {
    const shard = "sget:badstate";
    await runInDurableObject(shardStub(shard), async (inst: Shard) => {
      await expect(inst.listScheduled(shard, { state: "toString" as never })).rejects.toMatchObject({ code: "ValidationError" });
    });
  });

  it("a mutation sees the job it just scheduled", async () => {
    const shard = "sget:own";
    const r = (await api("mutation", { fn: "jobs:scheduleAndRead", args: {}, shard })).body.value;
    expect(r.own).toMatchObject({ id: r.id, name: "jobs:record", state: { kind: "pending" } });
    expect((await status(shard, r.id)).state.kind).toBe("pending");
  });

  it("actions read through the shard", async () => {
    const shard = "sget:action";
    const id = (await api("mutation", { fn: "jobs:later", args: { label: "x" }, shard })).body.value;
    const r = (await (await SELF.fetch("http://ember/api/action", { method: "POST", body: JSON.stringify({ fn: "actions:jobStatus", args: { id }, shard }) })).json()) as { value: unknown };
    expect(r.value).toMatchObject({ one: { id, state: { kind: "pending" } }, all: 1 });
  });

  it("is reactive: a subscription to get(id) gets a patch when the job runs (no new version needed)", async () => {
    const shard = "sget:live";
    const id = (await api("mutation", { fn: "jobs:later", args: { label: "live" }, shard })).body.value;
    const c = await connect(shard);
    await hello(c);
    c.send({ t: "sub", qid: 1, fn: "jobs:status", args: { id } });
    const snap = (await c.waitFor(is("snap"))) as { values?: unknown };
    expect(JSON.stringify(snap)).toContain('"pending"');
    // Another job's change does not touch it (point read by id)...
    const other = (await api("mutation", { fn: "jobs:later", args: { label: "other" }, shard })).body.value;
    await shardStub(shard).cancelJob(shard, other);
    await sleep(50);
    expect(c.frames.filter((f) => f.t === "patch" && JSON.stringify(f).includes('"canceled"'))).toEqual([]);
    // ...its own does.
    await shardStub(shard).cancelJob(shard, id);
    const patch = await c.waitFor((f) => f.t === "patch" && JSON.stringify(f).includes('"canceled"'));
    expect(patch).toBeTruthy();
    c.close();
  });

  it("the maintenance deletes finished jobs past scheduler.retainMs; retainMs 0 deletes them when they finish", async () => {
    const shard = "sget:gc";
    const stub = shardStub(shard);
    const id = (await api("mutation", { fn: "jobs:later", args: { label: "gc" }, shard })).body.value;
    await stub.cancelJob(shard, id);
    expect((await status(shard, id)).state.kind).toBe("canceled");
    // Age the row past the retention and run the maintenance now.
    await runInDurableObject(stub, async (inst: Shard, state) => {
      state.storage.sql.exec("UPDATE _jobs SET run_at = run_at - ?, updated_at = updated_at - ? WHERE job_id = ?", 8 * 86_400_000, 8 * 86_400_000, id);
      state.storage.sql.exec("INSERT INTO _ember_rt_meta(k, v) VALUES ('next_maint', '0') ON CONFLICT(k) DO UPDATE SET v = '0'");
      await inst.alarm();
    });
    expect(await status(shard, id)).toBeNull();

    try {
      setEmberConfig({ ...config, scheduler: { ...config.scheduler, retainMs: 0 } });
      const s2 = "sget:noretain";
      const j = (await api("mutation", { fn: "jobs:later", args: { label: "x" }, shard: s2 })).body.value;
      await shardStub(s2).cancelJob(s2, j);
      expect(await status(s2, j)).toBeNull();
    } finally {
      setEmberConfig(config);
    }
  });
});
