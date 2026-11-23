// `armAlarm` reads only the subsystem a write touched (the rest comes from an in-memory cache): counted through
// `inspect().stats`. The cache is memory only, so an evicted object reads everything again, and the alarm still fires
// for jobs and files. The scheduler RPCs: a claim does not arm, a settle reads `_jobs` alone (or nothing when another
// job is sooner).
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, shardStub } from "./helpers.ts";

const reads = async (shard: string) => {
  const s = (await shardStub(shard).inspect()).stats;
  return { arms: s.alarmArms, jobs: s.alarmJobReads, files: s.alarmFileReads };
};
const delta = (a: Awaited<ReturnType<typeof reads>>, b: Awaited<ReturnType<typeof reads>>) => ({ arms: b.arms - a.arms, jobs: b.jobs - a.jobs, files: b.files - a.files });
const labels = async (shard: string) => ((await api("query", { fn: "runs:list", args: {}, shard })).body.value as Array<{ label: string }>).map((r) => r.label);

describe("armAlarm cache", () => {
  it("a commit that schedules a job re-reads _jobs only; a file write re-reads _files only", async () => {
    const shard = "arm:commits";
    await api("mutation", { fn: "jobs:schedule", args: { items: [{ delayMs: 3_600_000, label: "warm" }] }, shard });
    const N = 10;
    const r0 = await reads(shard);
    for (let i = 0; i < N; i++) await api("mutation", { fn: "jobs:schedule", args: { items: [{ delayMs: 3_600_000 + i, label: `j${i}` }] }, shard });
    const jobs = delta(r0, await reads(shard));
    // Before: every arm read jobs, files (and outbox/broadcast when present): 2N reads for N commits.
    expect(jobs).toEqual({ arms: N, jobs: N, files: 0 });

    const r1 = await reads(shard);
    for (let i = 0; i < 3; i++) await api("mutation", { fn: "files:generate", args: { contentType: "text/plain", size: 3 }, shard });
    expect(delta(r1, await reads(shard))).toMatchObject({ jobs: 0 });

    // Plain writes (no job, no file) read nothing.
    const r2 = await reads(shard);
    for (let i = 0; i < 3; i++) await api("mutation", { fn: "runs:add", args: { label: `p${i}` }, shard });
    expect(delta(r2, await reads(shard))).toMatchObject({ jobs: 0, files: 0 });
  });

  it("the alarm still fires for jobs, including after eviction (the cache is memory only)", async () => {
    const shard = "arm:evict";
    const stub = shardStub(shard);
    await api("mutation", { fn: "jobs:schedule", args: { items: [{ delayMs: 3_000_000, label: "far" }] }, shard });
    const far = (await stub.inspect()).alarm!;
    expect(far).toBeGreaterThan(Date.now() + 2_000_000);
    await evictDurableObject(stub);
    // A new instance: the next arm reads everything again and takes the sooner job.
    await api("mutation", { fn: "jobs:schedule", args: { items: [{ delayMs: 600_000, label: "due" }] }, shard });
    const due = (await stub.inspect()).alarm!;
    expect(due).toBeLessThan(far);
    const at = (await stub.inspect()).jobs.find((j) => j.fn === "jobs:record" && j.run_at === due);
    expect(at).toBeDefined();
    // Its time comes (moved behind the shard's back, then a fresh instance): the alarm runs it.
    await runInDurableObject(stub, (_i, state) => state.storage.sql.exec("UPDATE _jobs SET run_at = ? WHERE id = ?", Date.now() - 1, at!.id));
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await labels(shard)).toContain("due");
    expect((await stub.inspect()).alarm).toBe(far);
  });

  it("claimActionJob does not arm; settleActionJob arms nothing when another job is sooner", async () => {
    const shard = "arm:lease";
    const stub = shardStub(shard);
    const rpc = stub as unknown as { claimActionJob(s: string, id: string): Promise<{ run: boolean }>; settleActionJob(s: string, id: string, e: null): Promise<void> };
    // An action job handed to the Queue: its dispatched lease two minutes out (as the alarm turn that sent it leaves it).
    const { id } = await stub.enqueueJob(shard, { fn: "actions:record", args: { label: "leased" }, kind: "action", runAt: Date.now() + 86_400_000 });
    await runInDurableObject(stub, (_i, state) => state.storage.sql.exec("UPDATE _jobs SET state = 'dispatched', run_at = ? WHERE job_id = ?", Date.now() + 120_000, id));
    await evictDurableObject(stub);
    // A job sooner than any lease (one minute out); this first commit after the wake reads everything.
    await api("mutation", { fn: "jobs:schedule", args: { items: [{ delayMs: 60_000, label: "sooner" }] }, shard });
    const alarm = (await stub.inspect()).alarm;
    const r0 = await reads(shard);
    expect(await rpc.claimActionJob(shard, id!)).toEqual({ run: true });
    await rpc.settleActionJob(shard, id!, null);
    expect(delta(r0, await reads(shard))).toEqual({ arms: 0, jobs: 0, files: 0 });
    expect((await stub.inspect()).alarm).toBe(alarm); // still the sooner job

    // Without a sooner job, the settle reads _jobs alone and the alarm follows (here: the hourly maintenance only).
    const { id: id2 } = await stub.enqueueJob(shard, { fn: "actions:record", args: { label: "leased2" }, kind: "action", runAt: Date.now() + 86_400_000 });
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("DELETE FROM _jobs WHERE fn = 'jobs:record'");
      state.storage.sql.exec("UPDATE _jobs SET state = 'dispatched', run_at = ? WHERE job_id = ?", Date.now() + 120_000, id2);
    });
    await evictDurableObject(stub);
    await api("mutation", { fn: "runs:add", args: { label: "wake" }, shard });
    await api("mutation", { fn: "jobs:schedule", args: { items: [{ delayMs: 86_400_000 * 3, label: "much-later" }] }, shard });
    const r1 = await reads(shard);
    expect(await rpc.claimActionJob(shard, id2!)).toEqual({ run: true });
    expect(delta(r1, await reads(shard))).toEqual({ arms: 0, jobs: 0, files: 0 });
    await rpc.settleActionJob(shard, id2!, null);
    expect(delta(r1, await reads(shard))).toEqual({ arms: 1, jobs: 1, files: 0 });
    expect((await stub.inspect()).alarm).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });
});
