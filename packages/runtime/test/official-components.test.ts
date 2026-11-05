// The official components (rateLimit, workflows) installed in a real Worker on workerd: Shard DO, alarms, the
// action queue consumer.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ActionJobMessage } from "../src/config.ts";
import { api, shardStub, sleep } from "./helpers.ts";
import worker, { probes } from "./worker.ts";

/** Runs the action jobs the shard dispatched (the test config records them instead of using a Queue). */
async function pumpActions(shard: string) {
  let n = 0;
  for (;;) {
    const i = probes.actions.findIndex((m) => m.shard === shard);
    if (i < 0) return n;
    const [msg] = probes.actions.splice(i, 1) as [ActionJobMessage];
    let acked = false;
    await worker.queue({ messages: [{ body: msg, attempts: 1, timestamp: new Date(), ack: () => (acked = true), retry: () => {} }] } as any, env as any, {} as any);
    if (!acked) throw new Error(`action job ${msg.fn} failed`);
    n++;
  }
}

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 4000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await sleep(20);
  }
}

describe("rateLimit on workerd", () => {
  it("limits per key in the shard, inside the caller's transaction", async () => {
    const shard = "rl:a";
    const post = async (user: string) => (await api("mutation", { fn: "official:post", args: { user }, shard })).body.value;
    expect(await post("u1")).toEqual({ ok: true });
    expect(await post("u1")).toEqual({ ok: true });
    const third = await post("u1");
    expect(third.ok).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(29_000);
    expect(await post("u2")).toEqual({ ok: true });
    const runs = (await api("query", { fn: "runs:list", args: {}, shard })).body.value.map((r: { label: string }) => r.label);
    expect(runs).toEqual(["post:u1", "post:u1", "post:u2"]);
  });

  it("an action's limit is its own transaction on the action's shard and shares the bucket", async () => {
    const shard = "rl:b";
    const act = async () => {
      const res = await SELF.fetch("http://ember/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fn: "official:postFromAction", args: { user: "x" }, shard }),
      });
      return ((await res.json()) as any).value;
    };
    expect((await act()).ok).toBe(true);
    expect((await api("mutation", { fn: "official:post", args: { user: "x" }, shard })).body.value.ok).toBe(true);
    expect((await act()).ok).toBe(false);
  });
});

describe("workflows on workerd", () => {
  it("runs action, mutation, sleep and event steps through the shard's scheduler and the queue consumer", async () => {
    const shard = "wf:a";
    const id = (await api("mutation", { fn: "official:startFlow", args: { x: 7 }, shard })).body.value as string;
    expect(id).toMatch(/^workflows\$workflows_/);
    const status = () => api("query", { fn: "official:flowStatus", args: { id }, shard }).then((r) => r.body.value);
    // drive → action step (runAction job) → drive → mutation step → drive → sleep (alarm) → drive → event wait
    const s = await until(
      async () => {
        await pumpActions(shard);
        return status();
      },
      (st) => st?.current?.kind === "event",
    );
    expect(s).toMatchObject({ status: "running", stepCount: 4, current: { kind: "event", name: "event:go" } });
    expect((await api("mutation", { fn: "official:flowEvent", args: { id, z: 1 }, shard })).body.value).toBe(true);
    const done = await until(
      async () => {
        await pumpActions(shard);
        return status();
      },
      (st) => st?.status === "completed",
    );
    expect(done).toMatchObject({ status: "completed", result: 22, stepCount: 5 });
    const runs = (await api("query", { fn: "runs:list", args: {}, shard })).body.value.map((r: { label: string }) => r.label);
    expect(runs).toEqual(["wf:21", "wf-done:1"]);
    expect((await shardStub(shard).inspect()).jobs).toEqual([]);
  });
});
