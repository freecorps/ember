import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";
import worker, { config, probes } from "./worker.ts";
import { setEmberConfig } from "../src/config.ts";
import type { ActionJobMessage } from "../src/config.ts";

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

  it("due mutation jobs run together: one commit (one version, one patch), in run_at order, a failing one alone undone", async () => {
    const shard = "sched:group";
    const stub = shardStub(shard);
    const past = Date.now() - 1000;
    await stub.warm(shard);
    const v0 = (await stub.inspect()).version;
    await runInDurableObject(stub, async (_i, state) => {
      // Inserted directly (already due), so a single alarm turn finds them all at once.
      for (let i = 0; i < 6; i++) {
        state.storage.sql.exec(
          "INSERT INTO _jobs (run_at, fn, args, kind, state, attempts, max_attempts, created_at, updated_at, job_id) VALUES (?, ?, ?, 'mutation', 'pending', 0, 3, ?, ?, ?)",
          past + i, i === 3 ? "jobs:flaky" : "jobs:record", JSON.stringify(i === 3 ? { label: "grp-flaky", failTimes: 99 } : { label: `g${i}` }), past, past, `job_grp${i}`,
        );
      }
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    const runs = await api("query", { fn: "runs:list", args: {}, shard });
    expect(runs.body.value.map((r: { label: string }) => r.label)).toEqual(["g0", "g1", "g2", "g4", "g5"]);
    const info = await stub.inspect();
    expect(info.version).toBe(v0 + 1);
    expect(info.jobs.map((j) => [j.fn, j.state, j.attempts])).toEqual([["jobs:flaky", "pending", 1]]);
  });

  it("a due job cancelled by an earlier due job of the same batch never runs", async () => {
    const shard = "sched:group-cancel";
    const stub = shardStub(shard);
    const past = Date.now() - 1000;
    await stub.warm(shard);
    await runInDurableObject(stub, async (_i, state) => {
      const rows: Array<[string, unknown, string]> = [
        ["jobs:record", { label: "c0" }, "job_gc0"],
        ["jobs:cancel", { id: "job_gc2" }, "job_gc1"],
        ["jobs:record", { label: "c2" }, "job_gc2"],
        ["jobs:record", { label: "c3" }, "job_gc3"],
      ];
      rows.forEach(([fn, args, id], i) =>
        state.storage.sql.exec(
          "INSERT INTO _jobs (run_at, fn, args, kind, state, attempts, max_attempts, created_at, updated_at, job_id) VALUES (?, ?, ?, 'mutation', 'pending', 0, 3, ?, ?, ?)",
          past + i, fn, JSON.stringify(args), past, past, id,
        ),
      );
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    const runs = await api("query", { fn: "runs:list", args: {}, shard });
    expect(runs.body.value.map((r: { label: string }) => r.label)).toEqual(["c0", "c3"]);
    expect((await stub.inspect()).jobs.filter((j) => j.state === "pending")).toEqual([]);
  });

  it("a batched job's outcome and scheduled jobs are written before the next job of the batch runs (one commit)", async () => {
    const shard = "sched:group-cut";
    const stub = shardStub(shard);
    const past = Date.now() - 1000;
    await stub.warm(shard);
    const v0 = (await stub.inspect()).version;
    await runInDurableObject(stub, async (_i, state) => {
      const rows: Array<[string, unknown]> = [
        ["jobs:record", { label: "k0" }],
        ["jobs:later", { label: "k-child" }],
        ["jobs:seeJobs", {}],
        ["jobs:record", { label: "k3" }],
        ["jobs:record", { label: "k4" }],
      ];
      rows.forEach(([fn, args], i) =>
        state.storage.sql.exec(
          "INSERT INTO _jobs (run_at, fn, args, kind, state, attempts, max_attempts, created_at, updated_at, job_id) VALUES (?, ?, ?, 'mutation', 'pending', 0, 3, ?, ?, ?)",
          past + i, fn, JSON.stringify(args), past, past, `job_gk${i}`,
        ),
      );
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    const runs = await api("query", { fn: "runs:list", args: {}, shard });
    // `seeJobs` (third) saw the first two succeeded and the child pending (itself, k3, k4, the child), as if each had
    // run alone; without the per-job writes it would see them pending and no child (5).
    expect(runs.body.value.map((r: { label: string }) => r.label)).toEqual(["k0", "seen:job_gk0=success,job_gk1=success,pending=4", "k3", "k4"]);
    const info = await stub.inspect();
    expect(info.version).toBe(v0 + 1);
    expect(info.jobs.map((j) => [j.fn, j.state])).toEqual([["jobs:record", "pending"]]);
  });

  it("a batched job scheduling a child due before the rest of the batch: the child runs first, as sequentially", async () => {
    const shard = "sched:group-early";
    const stub = shardStub(shard);
    const past = Date.now() - 1000;
    await stub.warm(shard);
    await runInDurableObject(stub, async (_i, state) => {
      const rows: Array<[string, unknown]> = [
        ["jobs:scheduleAt", { at: past - 10_000, label: "child" }],
        ["jobs:record", { label: "e1" }],
        ["jobs:record", { label: "e2" }],
      ];
      rows.forEach(([fn, args], i) =>
        state.storage.sql.exec(
          "INSERT INTO _jobs (run_at, fn, args, kind, state, attempts, max_attempts, created_at, updated_at, job_id) VALUES (?, ?, ?, 'mutation', 'pending', 0, 3, ?, ?, ?)",
          past + i, fn, JSON.stringify(args), past, past, `job_ge${i}`,
        ),
      );
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    const runs = await api("query", { fn: "runs:list", args: {}, shard });
    expect(runs.body.value.map((r: { label: string }) => r.label)).toEqual(["child", "e1", "e2"]);
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
    expect((await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "far" }, runAt, dedupKey: "k" })).id).toMatch(/^job_/);
    expect((await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "far" }, runAt, dedupKey: "k" })).id).toBeNull();
    const a1 = (await stub.inspect()).alarm!;
    expect(Math.abs(a1 - (Date.now() + 30 * DAY))).toBeLessThan(5000);
    await runDurableObjectAlarm(stub); // chain link fires early: nothing due, re-arm
    const after = await stub.inspect();
    expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0]).toMatchObject({ state: "pending", attempts: 0, run_at: runAt });
    expect(Math.abs(after.alarm! - (Date.now() + 30 * DAY))).toBeLessThan(5000);
  });

  it("hands action jobs to the queue under a lease; failed dispatch is retried then marked failed", async () => {
    const shard = "sched:action";
    const stub = shardStub(shard);
    await stub.enqueueJob(shard, { fn: "actions:ping", args: { n: 1 }, kind: "action" });
    await stub.enqueueJob(shard, { fn: "actions:ping", args: { fail: true }, kind: "action" });
    const info = await until(
      () => stub.inspect(),
      (i) => i.jobs.some((j) => j.state === "failed"),
    );
    expect(info.jobs.find((j) => j.state === "failed")).toMatchObject({ attempts: 3, last_error: expect.stringContaining("queue down") });
    // The one the queue took stays as its lease until the consumer reports back.
    expect(info.jobs.find((j) => j.state !== "failed")).toMatchObject({ state: "dispatched", attempts: 0 });
    const mine = probes.actions.filter((a) => a.shard === shard);
    expect(mine.find((a) => (a.args as { n?: number }).n === 1)).toMatchObject({ fn: "actions:ping", attempt: 1 });
    expect(mine.filter((a) => (a.args as { fail?: boolean }).fail).map((a) => a.attempt)).toEqual([1, 2, 3]);
  });

  it("records a restore bookmark on migrate", async () => {
    const shard = "sched:bookmark";
    const info = await shardStub(shard).warm(shard).then(() => shardStub(shard).inspect());
    expect(info.bookmarks).toBe(2); // deploy:<version> (first boot) + migrate
    expect(env.RUN_LONG).toBeDefined();
  });
});

/** Delivers the dispatched action jobs of `shard` to the queue consumer, as the Queue would. Returns them. */
async function deliver(shard: string, keep = false): Promise<Array<{ msg: ActionJobMessage; acked: boolean; retried: boolean }>> {
  const mine = probes.actions.filter((m) => m.shard === shard);
  if (!keep) probes.actions = probes.actions.filter((m) => m.shard !== shard);
  const out = [];
  for (const msg of mine) {
    const r = { msg, acked: false, retried: false };
    const message = { id: msg.jobId, body: msg, attempts: 1, timestamp: new Date(), ack: () => (r.acked = true), retry: () => (r.retried = true) };
    await worker.queue({ queue: "ember-actions", messages: [message] } as any, env as any, {} as any);
    out.push(r);
  }
  return out;
}

const labels = async (shard: string) => (await api("query", { fn: "runs:list", args: {}, shard })).body.value.map((r: { label: string }) => r.label);

describe("action jobs under a lease (the queue never loses one)", () => {
  it("the consumer claims, runs and reports: the row goes, and a second delivery of the same message runs nothing", async () => {
    const shard = "lease:ok";
    const stub = shardStub(shard);
    await stub.enqueueJob(shard, { fn: "actions:record", args: { label: "once" }, kind: "action" });
    await until(() => stub.inspect(), (i) => i.jobs[0]?.state === "dispatched");
    const [first] = await deliver(shard, true);
    expect(first).toMatchObject({ acked: true, retried: false, msg: { lease: true, attempt: 1 } });
    expect((await stub.inspect()).jobs).toEqual([]);
    const [again] = await deliver(shard);
    expect(again).toMatchObject({ acked: true });
    expect(await labels(shard)).toEqual(["once"]);
  });

  it("a queue that takes the message and never delivers it: the shard runs the job itself when the lease runs out", async () => {
    const shard = "lease:stalled";
    const stub = shardStub(shard);
    await stub.enqueueJob(shard, { fn: "actions:leased", args: { label: "rescued" }, kind: "action" });
    const dispatched = await until(() => stub.inspect(), (i) => i.jobs[0]?.state === "dispatched");
    expect(dispatched.jobs[0]!.run_at - Date.now()).toBeLessThanOrEqual(1000);
    expect(probes.actions.some((m) => m.shard === shard)).toBe(true);
    const runs = await until(() => labels(shard), (l) => l.length === 1, 5000);
    expect(runs).toEqual(["rescued"]);
    expect((await stub.inspect()).jobs).toEqual([]);
    // The stalled message arriving late finds nothing to claim: acked, not run again.
    const late = await deliver(shard);
    expect(late.every((d) => d.acked)).toBe(true);
    expect(await labels(shard)).toEqual(["rescued"]);
  });

  it("a consumer that claims and then dies: the claim's lease runs out and the shard runs the job", async () => {
    const shard = "lease:claimed";
    const stub = shardStub(shard);
    await stub.enqueueJob(shard, { fn: "actions:leased", args: { label: "after-claim" }, kind: "action" });
    await until(() => stub.inspect(), (i) => i.jobs[0]?.state === "dispatched");
    const msg = probes.actions.find((m) => m.shard === shard)!;
    probes.actions = probes.actions.filter((m) => m.shard !== shard);
    expect(await (stub as any).claimActionJob(shard, msg.jobId)).toEqual({ run: true });
    expect((await stub.inspect()).jobs[0]).toMatchObject({ state: "claimed" });
    // A second claim (a duplicate delivery) is refused.
    expect(await (stub as any).claimActionJob(shard, msg.jobId)).toEqual({ run: false });
    expect(await until(() => labels(shard), (l) => l.length === 1, 5000)).toEqual(["after-claim"]);
    expect((await stub.inspect()).jobs).toEqual([]);
  });

  it("a failure the consumer reports is retried by the shard with backoff, then succeeds", async () => {
    const shard = "lease:retry";
    const stub = shardStub(shard);
    probes.flaky.delete("lease-flaky");
    await stub.enqueueJob(shard, { fn: "actions:flaky", args: { label: "lease-flaky", failTimes: 1 }, kind: "action" });
    await until(() => stub.inspect(), (i) => i.jobs[0]?.state === "dispatched");
    const [first] = await deliver(shard);
    expect(first).toMatchObject({ acked: true, retried: false });
    expect((await stub.inspect()).jobs[0]).toMatchObject({ state: expect.stringMatching(/pending|dispatched/), attempts: 1, last_error: expect.stringContaining("flaky action attempt 1") });
    const redispatched = await until(() => Promise.resolve(probes.actions.filter((m) => m.shard === shard)), (l) => l.length === 1);
    expect(redispatched[0]).toMatchObject({ attempt: 2, lease: true });
    await deliver(shard);
    expect(await labels(shard)).toEqual(["lease-flaky"]);
    expect((await stub.inspect()).jobs).toEqual([]);
  });

  it("a job cancelled after it was handed to the queue is not run when the message arrives", async () => {
    const shard = "lease:cancel";
    const stub = shardStub(shard);
    const { id } = await stub.enqueueJob(shard, { fn: "actions:record", args: { label: "never" }, kind: "action" });
    await until(() => stub.inspect(), (i) => i.jobs[0]?.state === "dispatched");
    expect(await stub.cancelJob(shard, id!)).toBe(true);
    const [d] = await deliver(shard);
    expect(d).toMatchObject({ acked: true });
    expect(await labels(shard)).toEqual([]);
  });

  it("a job the shard runs after its lease keeps the alarm armed while it runs, and is given back if the object dies", async () => {
    const shard = "lease:running";
    const stub = shardStub(shard);
    await stub.enqueueJob(shard, { fn: "actions:local", args: { label: "x" }, kind: "action", runAt: Date.now() + 3_600_000 });
    // What a crash mid-run leaves: the row `running`, nothing else due.
    const started = Date.now() - 6 * 60_000;
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE _jobs SET state = 'running', run_at = ?, updated_at = ?", started + 5 * 60_000, started);
    });
    await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "far" }, runAt: Date.now() + 7 * DAY });
    // The alarm is armed for the running row's recovery (not only for the far job, a week away): it is given back and
    // runs again. Before, nothing re-armed for a `running` row and the job waited for unrelated work.
    expect(await until(() => labels(shard), (l) => l.length === 1)).toEqual(["x"]);
    expect((await stub.inspect()).jobs.map((j) => j.fn)).toEqual(["jobs:record"]);
  });

  it("a scheduler.actionLeaseMs under 1 s is raised to 1 s: the job is never due again in the turn that dispatched it", async () => {
    const shard = "lease:floor";
    const stub = shardStub(shard);
    try {
      setEmberConfig({ ...config, scheduler: { ...config.scheduler, actionLeaseMs: 0 } });
      await stub.warm(shard);
      await evictDurableObject(stub);
      await stub.enqueueJob(shard, { fn: "actions:record", args: { label: "floor" }, kind: "action" });
      const info = await until(() => stub.inspect(), (i) => i.jobs[0]?.state === "dispatched");
      expect(info.jobs[0]!.run_at - Date.now()).toBeGreaterThan(500);
      expect(await labels(shard)).toEqual([]);
    } finally {
      setEmberConfig(config);
      await evictDurableObject(stub).catch(() => {});
    }
  });

  it("action({ dispatch: \"shard\" }) always runs in the shard's alarm, never through the queue", async () => {
    const shard = "lease:local";
    const stub = shardStub(shard);
    await stub.enqueueJob(shard, { fn: "actions:local", args: { label: "here" }, kind: "action" });
    expect(await until(() => labels(shard), (l) => l.length === 1)).toEqual(["here"]);
    expect(probes.actions.some((m) => m.shard === shard)).toBe(false);
    expect((await stub.inspect()).jobs).toEqual([]);
  });

  it("a message from an older runtime (no lease) is acked or retried by the queue, as before", async () => {
    const shard = "lease:legacy";
    const acked: string[] = [];
    const retried: string[] = [];
    const m = (id: string, body: unknown) => ({ id, body, attempts: 1, timestamp: new Date(), ack: () => acked.push(id), retry: () => retried.push(id) });
    await worker.queue(
      { queue: "ember-actions", messages: [m("ok", { shard, jobId: "job_x", fn: "actions:record", args: { label: "old" }, attempt: 1 }), m("bad", { shard, jobId: "job_y", fn: "actions:record", args: { label: 1 }, attempt: 1 })] } as any,
      env as any,
      {} as any,
    );
    expect(acked).toEqual(["ok"]);
    expect(retried).toEqual(["bad"]);
    expect(await labels(shard)).toEqual(["old"]);
  });
});

/**
 * A stand-in for the `EMBER_ACTIONS` Queue binding with the JSON content type: a body that JSON cannot carry (a
 * `bigint`) rejects, as do a message over 128 KB and a batch over 256 KB. `hold` keeps the next send pending until
 * the test settles it.
 */
function jsonQueue() {
  const size = (body: unknown) => new TextEncoder().encode(JSON.stringify(body)).byteLength;
  const q = {
    batches: [] as ActionJobMessage[][],
    hold: null as null | { started: () => void; result: Promise<void> },
    async send(body: ActionJobMessage) {
      await q.sendBatch([{ body }]);
    },
    async sendBatch(messages: Iterable<{ body: ActionJobMessage }>) {
      const list = [...messages];
      const held = q.hold;
      q.hold = null;
      if (held) {
        held.started();
        await held.result;
      }
      const sizes = list.map((m) => size(m.body)); // throws on a bigint, like the JSON content type
      if (sizes.some((n) => n > 128_000)) throw new Error("message too large");
      if (sizes.reduce((a, b) => a + b, 0) > 256_000) throw new Error("batch too large");
      q.batches.push(list.map((m) => JSON.parse(JSON.stringify(m.body)) as ActionJobMessage));
    },
  };
  return q;
}

/** `shard` reconstructed with no `dispatchAction`, its `EMBER_ACTIONS` being `queue`. */
async function withQueue(shard: string, queue: ReturnType<typeof jsonQueue>) {
  const stub = shardStub(shard);
  const { dispatchAction: _, ...noDispatch } = config;
  setEmberConfig(noDispatch);
  try {
    await stub.warm(shard);
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance) => {
      const o = instance as unknown as { env: Record<string, unknown> };
      o.env = { ...o.env, EMBER_ACTIONS: queue };
    });
  } finally {
    setEmberConfig(config);
  }
  return stub;
}

/** Delivers messages to the queue consumer, as the Queue would. */
async function consume(msgs: ActionJobMessage[]) {
  for (const body of msgs) {
    const message = { id: body.jobId, body, attempts: 1, timestamp: new Date(), ack: () => {}, retry: () => {} };
    await worker.queue({ queue: "ember-actions", messages: [message] } as any, env as any, {} as any);
  }
}

describe("action jobs through the EMBER_ACTIONS queue (JSON messages, sendBatch)", () => {
  it("int64 args travel as argsJson, batched with the rest, and reach the action as bigints", async () => {
    const shard = "q:int64";
    const queue = jsonQueue();
    const stub = await withQueue(shard, queue);
    const runAt = Date.now() + 300;
    await stub.enqueueJob(shard, { fn: "actions:recordBig", args: { label: "a", n: 9007199254740993n }, kind: "action", runAt });
    await stub.enqueueJob(shard, { fn: "actions:record", args: { label: "plain" }, kind: "action", runAt });
    await stub.enqueueJob(shard, { fn: "actions:recordBig", args: { label: "b", n: -2n }, kind: "action", runAt });
    await until(() => Promise.resolve(queue.batches.length), (n) => n > 0);
    expect(queue.batches).toHaveLength(1);
    const [batch] = queue.batches;
    expect(batch!.map((m) => [m.fn, m.args !== undefined, typeof m.argsJson])).toEqual([
      ["actions:recordBig", false, "string"],
      ["actions:record", true, "undefined"],
      ["actions:recordBig", false, "string"],
    ]);
    await consume(batch!);
    expect((await labels(shard)).sort()).toEqual(["a:9007199254740993", "b:-2", "plain"]);
    expect((await stub.inspect()).jobs.filter((j) => j.state !== "success")).toEqual([]);
  });

  it("a message over the per-message limit goes in a sendBatch of its own: its rejection fails only it", async () => {
    const shard = "q:large";
    const queue = jsonQueue();
    const stub = await withQueue(shard, queue);
    const runAt = Date.now() + 300;
    await stub.enqueueJob(shard, { fn: "actions:record", args: { label: "x".repeat(130_000) }, kind: "action", runAt });
    await stub.enqueueJob(shard, { fn: "actions:record", args: { label: "small" }, kind: "action", runAt });
    const info = await until(() => stub.inspect(), (i) => i.jobs.some((j) => j.last_error) && i.jobs.some((j) => j.state === "dispatched"));
    expect(queue.batches.map((b) => b.map((m) => (m.args as { label: string }).label))).toEqual([["small"]]);
    const big = info.jobs.find((j) => j.last_error)!;
    // Retried with backoff (and failed for good after maxAttempts): the queue never takes it.
    expect(big).toMatchObject({ state: expect.stringMatching(/^(pending|failed)$/), last_error: expect.stringContaining("message too large") });
    expect(info.jobs.find((j) => j.state === "dispatched")).toMatchObject({ attempts: 0, last_error: null });
  });

  for (const during of ["cancelled", "claimed"] as const) {
    it(`a send that fails after the job was ${during} meanwhile leaves the job as it is`, async () => {
      const shard = `q:fail-${during}`;
      const queue = jsonQueue();
      const stub = await withQueue(shard, queue);
      let fail!: (e: Error) => void;
      let inSend = false;
      queue.hold = { started: () => (inSend = true), result: new Promise<void>((_, rej) => (fail = rej)) };
      const { id } = await stub.enqueueJob(shard, { fn: "actions:record", args: { label: "held" }, kind: "action" });
      // Polled (not awaited): a promise the shard settles would resume this test inside the shard's I/O context.
      await until(() => Promise.resolve(inSend), Boolean);
      expect(inSend).toBe(true);
      if (during === "cancelled") expect(await stub.cancelJob(shard, id!)).toBe(true);
      else expect(await stub.claimActionJob(shard, id!)).toEqual({ run: true });
      fail(new Error("queue down"));
      await sleep(150); // the rejected send has been handled by now
      const after = (await stub.inspect()).jobs.find((j) => j.job_id === id);
      // Not brought back to `pending` (to run again) by the failed send: inspect() leaves cancelled jobs out.
      if (during === "cancelled") expect(after).toBeUndefined();
      else expect(after).toMatchObject({ state: "claimed", attempts: 0, last_error: null });
    });
  }
});

describe("alarm after commits that cannot move it", () => {
  it("plain commits leave the armed alarm alone; scheduling and cancelling a job still re-arm it", async () => {
    const shard = "chat:alarm-skip";
    const m = async (fn: string, args: unknown) => {
      const r = await api("mutation", { fn, args, shard });
      expect(r.body.ok).toBe(true);
      return r.body.value;
    };
    const stub = shardStub(shard);
    const alarm = () => runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    await m("runs:add", { label: "first" }); // first commit after boot: arms (hourly maintenance)
    const maint = await alarm();
    expect(maint).not.toBeNull();
    const t0 = Date.now();
    const id = await m("jobs:later", { label: "a" }); // a job 60 s out: before the hourly tick
    const job = await alarm();
    expect(job!).toBeLessThan(maint!);
    expect(job!).toBeGreaterThanOrEqual(t0 + 59_000);
    for (let i = 0; i < 5; i++) await m("runs:add", { label: `p${i}` });
    expect(await alarm()).toBe(job);
    // Cancelling the job (no row change): the alarm goes back to the hourly maintenance.
    await m("jobs:cancel", { id });
    expect(await alarm()).toBe(maint);
  });
});
