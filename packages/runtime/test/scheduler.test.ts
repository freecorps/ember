import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";
import { probes } from "./worker.ts";

const DAY = 86_400_000;

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

describe("scheduler", () => {
  it("runs scheduled mutation jobs in run_at order via the alarm and patches subscribers", async () => {
    const shard = "sched:order";
    const c = await connect(shard);
    await hello(c);
    c.send({ t: "sub", qid: 1, fn: "runs:list", args: {} });
    await c.waitFor(is("snap"));
    const items = [
      { label: "c", delayMs: 150 },
      { label: "a", delayMs: 30 },
      { label: "b", delayMs: 90 },
    ];
    expect((await api("mutation", { fn: "jobs:schedule", args: { items }, shard })).body.ok).toBe(true);
    const stub = shardStub(shard);
    const pending = await stub.inspect();
    expect(pending.jobs.map((j) => j.fn)).toEqual(["jobs:record", "jobs:record", "jobs:record"]);
    expect(pending.alarm).toBe(pending.jobs[0]!.run_at);
    const runs = await until(
      () => api("query", { fn: "runs:list", args: {}, shard }),
      (r) => r.body.value.length === 3,
    );
    expect(runs.body.value.map((r: { label: string }) => r.label)).toEqual(["a", "b", "c"]);
    const info = await stub.inspect();
    expect(info.jobs).toEqual([]);
    // only the hourly maintenance tick remains armed
    expect(info.alarm! - Date.now()).toBeGreaterThan(50 * 60_000);
    const patches = c.frames.filter((f) => f.t === "patch") as Array<Extract<ServerMessage, { t: "patch" }>>;
    expect(patches.map((p) => (p.changes[0]!.value as unknown[]).length)).toEqual([1, 2, 3]);
    c.close();
  });

  it("retries a failing job with backoff, then succeeds; exhausts maxAttempts into 'failed'", async () => {
    const shard = "sched:retry";
    const stub = shardStub(shard);
    await stub.enqueueJob(shard, { fn: "jobs:flaky", args: { label: "ok-on-3", failTimes: 2 } });
    await stub.enqueueJob(shard, { fn: "jobs:flaky", args: { label: "never", failTimes: 99 } });
    const info = await until(
      () => stub.inspect(),
      (i) => i.jobs.length === 1 && i.jobs[0]!.state === "failed",
    );
    expect(probes.flaky.get("ok-on-3")).toBe(3);
    expect(probes.flaky.get("never")).toBe(3);
    expect(info.jobs[0]).toMatchObject({ state: "failed", attempts: 3, max_attempts: 3, last_error: expect.stringContaining("flaky attempt 3") });
    const runs = await api("query", { fn: "runs:list", args: {}, shard });
    expect(runs.body.value.map((r: { label: string }) => r.label)).toEqual(["ok-on-3"]);
  });

  it("dedups enqueued jobs by key and caps the alarm at 30 days (chained)", async () => {
    const shard = "sched:far";
    const stub = shardStub(shard);
    const runAt = Date.now() + 400 * DAY;
    expect((await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "far" }, runAt, dedupKey: "k" })).id).toBeTypeOf("number");
    expect((await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "far" }, runAt, dedupKey: "k" })).id).toBeNull();
    const a1 = (await stub.inspect()).alarm!;
    expect(Math.abs(a1 - (Date.now() + 30 * DAY))).toBeLessThan(5000);
    await runDurableObjectAlarm(stub); // chain link fires early: nothing due, re-arm
    const after = await stub.inspect();
    expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0]).toMatchObject({ state: "pending", attempts: 0, run_at: runAt });
    expect(Math.abs(after.alarm! - (Date.now() + 30 * DAY))).toBeLessThan(5000);
  });

  it("hands action jobs to the queue; failed dispatch is retried then marked failed", async () => {
    const shard = "sched:action";
    const stub = shardStub(shard);
    await stub.enqueueJob(shard, { fn: "actions:ping", args: { n: 1 }, kind: "action" });
    await stub.enqueueJob(shard, { fn: "actions:ping", args: { fail: true }, kind: "action" });
    const info = await until(
      () => stub.inspect(),
      (i) => i.jobs.length === 1 && i.jobs[0]!.state === "failed",
    );
    expect(info.jobs[0]).toMatchObject({ attempts: 3, last_error: expect.stringContaining("queue down") });
    const mine = probes.actions.filter((a) => a.shard === shard);
    expect(mine.find((a) => (a.args as { n?: number }).n === 1)).toMatchObject({ fn: "actions:ping", attempt: 1 });
    expect(mine.filter((a) => (a.args as { fail?: boolean }).fail).map((a) => a.attempt)).toEqual([1, 2, 3]);
  });

  it("records a restore bookmark on migrate", async () => {
    const shard = "sched:bookmark";
    const info = await shardStub(shard).warm(shard).then(() => shardStub(shard).inspect());
    expect(info.bookmarks).toBe(1);
    expect(env.RUN_LONG).toBeDefined();
  });
});
