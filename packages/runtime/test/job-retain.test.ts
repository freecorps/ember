/**
 * Ephemeral jobs: `mutation/action({ retainMs: 0 })` deletes the `_jobs` row of a scheduled run when it succeeds (or is
 * cancelled), instead of keeping it `scheduler.retainMs` (7 days) and deleting it later in the hourly maintenance.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, shardStub, sleep } from "./helpers.ts";
import worker, { probes } from "./worker.ts";

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 3000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

const status = async (shard: string, id: string) => (await api("query", { fn: "jobs:status", args: { id }, shard })).body.value;
const runs = async (shard: string) => (await api("query", { fn: "runs:list", args: {}, shard })).body.value.length as number;
const written = async (shard: string) => (await shardStub(shard).inspect()).rows.written;

/** Schedules `n` jobs of `fn` on `shard`, one by one, and waits for them to run. Rows written for all of it, and the ids. */
async function runJobs(shard: string, fn: string, n: number): Promise<{ rows: number; ids: string[] }> {
  const stub = shardStub(shard);
  await stub.warm(shard);
  const w0 = await written(shard);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await stub.enqueueJob(shard, { fn, args: { label: `j${i}` } })).id!);
    await until(() => runs(shard), (c) => c === i + 1);
  }
  // The query reads above write nothing; the job rows settle with the commit that ran them.
  return { rows: (await written(shard)) - w0, ids };
}

describe("retainMs: 0 (ephemeral jobs)", () => {
  it("a finished run keeps no row: get() is null, nothing for the maintenance, fewer rows written", async ({ annotate }) => {
    const N = 10;
    const kept = await runJobs("retain:kept", "jobs:record", N);
    const gone = await runJobs("retain:gone", "jobs:recordEphemeral", N);
    expect(await status("retain:kept", kept.ids[0]!)).toMatchObject({ state: { kind: "success" } });
    expect(await status("retain:gone", gone.ids[0]!)).toBeNull();
    expect((await shardStub("retain:kept").inspect()).finishedJobs).toBe(N);
    expect((await shardStub("retain:gone").inspect()).finishedJobs).toBe(0);
    // A kept row is also deleted later, by the maintenance (one more row written each, a week later).
    expect(gone.rows).toBeLessThan(kept.rows);
    await annotate(`rows written per scheduled mutation job (schedule + run + settle): kept ${kept.rows / N} (+ its delete at the maintenance, a week later) vs retainMs: 0 ${gone.rows / N}`);
  });

  it("a cancelled ephemeral job keeps no row; a kept one stays `canceled`", async () => {
    const shard = "retain:cancel";
    const stub = shardStub(shard);
    const a = (await stub.enqueueJob(shard, { fn: "jobs:recordEphemeral", args: { label: "x" }, runAt: Date.now() + 60_000 })).id!;
    const b = (await stub.enqueueJob(shard, { fn: "jobs:record", args: { label: "y" }, runAt: Date.now() + 60_000 })).id!;
    expect(await stub.cancelJob(shard, a)).toBe(true);
    expect(await stub.cancelJob(shard, b)).toBe(true);
    expect(await status(shard, a)).toBeNull();
    expect((await status(shard, b)).state.kind).toBe("canceled");
    expect(await stub.cancelJob(shard, a)).toBe(false);
  });

  it("a leased action job settled by the queue consumer: the row goes on success", async () => {
    const shard = "retain:action";
    const stub = shardStub(shard);
    const { id } = await stub.enqueueJob(shard, { fn: "actions:recordEphemeral", args: { label: "act" }, kind: "action" });
    const msg = await until(() => Promise.resolve(probes.actions.find((m) => m.shard === shard)), (m) => !!m);
    probes.actions = probes.actions.filter((m) => m.shard !== shard);
    let acked = false;
    const message = { id: "m", body: msg!, attempts: 1, timestamp: new Date(), ack: () => (acked = true), retry: () => undefined };
    await worker.queue({ queue: "ember-actions", messages: [message] } as never, env as never, {} as never);
    expect(acked).toBe(true);
    expect(await runs(shard)).toBe(1);
    expect(await status(shard, id!)).toBeNull();
    expect((await stub.inspect()).finishedJobs).toBe(0);
  });

  it("only mutations and actions take it, and only 0", async () => {
    const { query, mutation, action } = await import("@freecorps/ember-server");
    expect(() => (query as (d: unknown) => unknown)({ retainMs: 0, handler: () => 1 })).toThrow(/retainMs/);
    expect(() => (mutation as (d: unknown) => unknown)({ retainMs: 1000, handler: () => 1 })).toThrow(/retainMs must be 0/);
    expect((action as (d: unknown) => { retainMs?: number })({ retainMs: 0, handler: async () => 1 }).retainMs).toBe(0);
  });
});
