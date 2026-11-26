/**
 * Leased action jobs of one Queue batch are claimed and settled per shard: one `claimActionJobs` and one
 * `settleActionJobs` RPC (DO request) per shard, instead of one claim and one settle per message. Semantics are the
 * one-job path's: a job runs at most once per claim, a refused claim acks without running, failures are retried by
 * the shard, a job claimed and never started in time is handed back to the shard.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ActionJobMessage } from "../src/config.ts";
import { api, shardStub, sleep } from "./helpers.ts";
import { leaseDeadline } from "../src/worker.ts";
import worker, { probes } from "./worker.ts";

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

const LEASE_RPCS = ["claimActionJob", "settleActionJob", "claimActionJobs", "settleActionJobs"];

/**
 * The test env with every Shard stub wrapped: counts the lease RPCs by name, and `missing` makes a method throw as a
 * shard instance of the runtime before it would (mid-deploy). `claimDelayMs`: the claim reaches the shard that late
 * (a slow hop: the lease starts when it arrives). `settled`: every outcome reported, with when.
 */
function countingEnv(missing: string[] = [], claimDelayMs = 0) {
  const calls: string[] = [];
  const settled: Array<{ at: number; jobId: string; released?: true; error?: unknown }> = [];
  const ns = env.SHARD;
  const SHARD = {
    idFromName: (n: string) => ns.idFromName(n),
    get: (id: DurableObjectId, o?: DurableObjectNamespaceGetDurableObjectOptions) => {
      const s = ns.get(id, o) as unknown as Record<string, unknown>;
      return new Proxy(s, {
        get(target, prop) {
          const v = Reflect.get(target, prop);
          if (typeof prop !== "string" || !LEASE_RPCS.includes(prop)) return v;
          return (...args: unknown[]) => {
            calls.push(prop);
            if (missing.includes(prop)) return Promise.reject(new Error(`The RPC receiver does not implement the method "${prop}".`));
            if (prop === "settleActionJobs") for (const o of args[1] as Array<{ jobId: string }>) settled.push({ at: Date.now(), ...o });
            if (prop === "claimActionJobs" && claimDelayMs) return sleep(claimDelayMs).then(() => (v as (...a: unknown[]) => unknown)(...args));
            return (v as (...a: unknown[]) => unknown)(...args);
          };
        },
      });
    },
  };
  return { env: { ...env, SHARD }, calls, settled };
}

type Delivered = { msg: ActionJobMessage; acked: boolean; retried: boolean };

/** Hands `msgs` to the queue consumer as one batch. */
async function deliverBatch(msgs: ActionJobMessage[], e: unknown): Promise<Delivered[]> {
  const out: Delivered[] = msgs.map((msg) => ({ msg, acked: false, retried: false }));
  const messages = out.map((r, i) => ({ id: `${r.msg.jobId}-${i}`, body: r.msg, attempts: 1, timestamp: new Date(), ack: () => (r.acked = true), retry: () => (r.retried = true) }));
  await worker.queue({ queue: "ember-actions", messages } as never, e as never, {} as never);
  return out;
}

/** Schedules `labels` as `fn` jobs on `shard` and takes their Queue messages once dispatched. */
async function dispatched(shard: string, fn: string, labels: string[]): Promise<ActionJobMessage[]> {
  const stub = shardStub(shard);
  for (const label of labels) await stub.enqueueJob(shard, { fn, args: fn === "actions:flaky" ? { label, failTimes: 1 } : { label }, kind: "action" });
  await until(() => Promise.resolve(probes.actions.filter((m) => m.shard === shard)), (l) => l.length === labels.length);
  const mine = probes.actions.filter((m) => m.shard === shard);
  probes.actions = probes.actions.filter((m) => m.shard !== shard);
  return mine;
}

const labels = async (shard: string) => (await api("query", { fn: "runs:list", args: {}, shard })).body.value.map((r: { label: string }) => r.label).sort();

describe("leased action jobs, per shard and batch", () => {
  it("leaseDeadline: the shard's leaseUntil, kept within the claim's round trip", () => {
    // Claim sent at 1000, answered at 1200, lease 1000: the lease ends between 2000 and 2200.
    expect(leaseDeadline({ leaseMs: 1000, leaseUntil: 2150 }, 1000, 1200)).toBe(2150);
    expect(leaseDeadline({ leaseMs: 1000, leaseUntil: 9000 }, 1000, 1200)).toBe(2200); // shard clock ahead
    expect(leaseDeadline({ leaseMs: 1000, leaseUntil: 100 }, 1000, 1200)).toBe(2000); // shard clock behind
    expect(leaseDeadline({ leaseMs: 1000 }, 1000, 1200)).toBe(2000); // no leaseUntil: from the send
  });

  it("half its lease is counted from when the shard granted it, not from when the claim was sent", async () => {
    const shard = "leaseb:slowclaim";
    const msgs = await dispatched(shard, "actions:leased", ["late-claim"]);
    // 1 s lease; the claim takes 700 ms to reach the shard: past half the lease since it was sent, not since granted.
    const { env: e, settled } = countingEnv([], 700);
    const out = await deliverBatch(msgs, e);
    expect(out.every((d) => d.acked && !d.retried)).toBe(true);
    expect(settled.map((s) => ({ jobId: s.jobId, released: s.released, error: s.error }))).toEqual([{ jobId: msgs[0]!.jobId, released: undefined, error: null }]);
    expect(await labels(shard)).toEqual(["late-claim"]);
  });

  it("an outcome waiting for a slow job of its shard is reported before its own lease ends", async () => {
    const shard = "leaseb:deadline";
    const quick = await dispatched(shard, "actions:leased", ["quick"]);
    const slow = await dispatched(shard, "actions:slowRecord", ["slow"]);
    const { env: e, settled, calls } = countingEnv();
    const t0 = Date.now();
    const out = await deliverBatch([...quick, ...slow], e);
    expect(out.every((d) => d.acked && !d.retried)).toBe(true);
    // The 1 s job's outcome went before its lease ran out (not with the 2 s job's, nor after SETTLE_MAX_WAIT_MS).
    const q = settled.find((s) => s.jobId === quick[0]!.jobId)!;
    expect(q.at - t0).toBeLessThan(1000);
    expect(calls.filter((c) => c === "settleActionJobs")).toHaveLength(2);
    // So the shard never ran it again after a lapsed lease.
    await sleep(300);
    expect(await labels(shard)).toEqual(["quick", "slow"]);
    expect((await shardStub(shard).inspect()).jobs).toEqual([]);
  });

  it("one claim and one settle RPC per shard for the whole batch (was one of each per message)", async ({ annotate }) => {
    const a = "leaseb:a";
    const b = "leaseb:b";
    const ma = await dispatched(a, "actions:record", ["a1", "a2", "a3", "a4", "a5", "a6"]);
    const mb = await dispatched(b, "actions:record", ["b1", "b2", "b3", "b4"]);
    probes.flaky.delete("leaseb-flaky");
    const mf = await dispatched(a, "actions:flaky", ["leaseb-flaky"]);
    const { env: e, calls } = countingEnv();
    const out = await deliverBatch([...ma, ...mb, ...mf], e);
    expect(out.every((d) => d.acked && !d.retried)).toBe(true);
    const count = (n: string) => calls.filter((c) => c === n).length;
    expect({ claims: count("claimActionJobs"), settles: count("settleActionJobs"), one: count("claimActionJob") + count("settleActionJob") }).toEqual({ claims: 2, settles: 2, one: 0 });
    await annotate(`11 leased jobs on 2 shards: ${calls.length} lease RPCs (one claim + one settle per message: 22)`);
    expect(await labels(a)).toEqual(["a1", "a2", "a3", "a4", "a5", "a6"]);
    expect(await labels(b)).toEqual(["b1", "b2", "b3", "b4"]);
    // The failure was reported in the same settle: the shard retries it (backoff) and it goes out again.
    const again = await until(() => Promise.resolve(probes.actions.filter((m) => m.shard === a)), (l) => l.length === 1);
    expect(again[0]).toMatchObject({ fn: "actions:flaky", attempt: 2, lease: true });
    probes.actions = probes.actions.filter((m) => m.shard !== a);
    await deliverBatch(again, e);
    expect(await labels(a)).toEqual(["a1", "a2", "a3", "a4", "a5", "a6", "leaseb-flaky"]);
    expect((await shardStub(a).inspect()).jobs).toEqual([]);
    expect((await shardStub(b).inspect()).jobs).toEqual([]);
  });

  it("the same message twice in one batch runs once (the second claim is refused and acked)", async () => {
    const shard = "leaseb:dup";
    const [m] = await dispatched(shard, "actions:record", ["once"]);
    const { env: e, calls } = countingEnv();
    const out = await deliverBatch([m!, m!], e);
    expect(out.every((d) => d.acked)).toBe(true);
    expect(calls.filter((c) => c === "claimActionJobs")).toHaveLength(1);
    expect(await labels(shard)).toEqual(["once"]);
  });

  it("a shard of the runtime before the batch RPCs: one claim and one settle per job, same outcome", async () => {
    const shard = "leaseb:old";
    const msgs = await dispatched(shard, "actions:record", ["o1", "o2", "o3"]);
    const { env: e, calls } = countingEnv(["claimActionJobs", "settleActionJobs"]);
    const out = await deliverBatch(msgs, e);
    expect(out.every((d) => d.acked && !d.retried)).toBe(true);
    expect(calls.filter((c) => c === "claimActionJob")).toHaveLength(3);
    expect(calls.filter((c) => c === "settleActionJob")).toHaveLength(3);
    expect(await labels(shard)).toEqual(["o1", "o2", "o3"]);
    expect((await shardStub(shard).inspect()).jobs).toEqual([]);
  });

  it("a claimed job handed back unstarted (`released`) runs in the shard now, not when its lease runs out", async () => {
    const shard = "leaseb:released";
    const [m] = await dispatched(shard, "actions:record", ["handed-back"]);
    const stub = shardStub(shard) as unknown as {
      claimActionJobs(s: string, ids: string[]): Promise<Array<{ run: boolean; leaseMs?: number }>>;
      settleActionJobs(s: string, o: Array<{ jobId: string; released: true }>): Promise<void>;
    };
    const [claim] = await stub.claimActionJobs(shard, [m!.jobId]);
    // `actions:record` has the default lease (5 minutes): only the release brings it back this soon.
    expect(claim).toMatchObject({ run: true, leaseMs: 300_000 });
    expect((claim as { leaseUntil?: number }).leaseUntil).toBeGreaterThan(Date.now() + 299_000);
    await stub.settleActionJobs(shard, [{ jobId: m!.jobId, released: true }]);
    expect(await until(() => labels(shard), (l) => l.length === 1)).toEqual(["handed-back"]);
    expect((await shardStub(shard).inspect()).jobs).toEqual([]);
    // Not handed to the queue again: it ran in the shard.
    expect(probes.actions.filter((x) => x.shard === shard)).toEqual([]);
  });

  it("an unreachable shard at claim time: its messages are retried, and a later delivery runs them", async () => {
    const ok = "leaseb:reach";
    const msgs = await dispatched(ok, "actions:record", ["r1"]);
    const { env: e } = countingEnv(["claimActionJobs", "claimActionJob"]);
    const out = await deliverBatch(msgs, e);
    expect(out.every((d) => d.retried && !d.acked)).toBe(true);
    // Nothing ran while the shard was out of reach.
    expect(await labels(ok)).toEqual([]);
    // Delivered again (the Queue's retry) to a reachable shard: runs.
    const again = await deliverBatch(msgs, countingEnv().env);
    expect(again.every((d) => d.acked)).toBe(true);
    expect(await labels(ok)).toEqual(["r1"]);
  });
});
