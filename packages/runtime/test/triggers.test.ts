// Per-table triggers (PLAN §22 L2) through the runtime: `createEmberWorker({ triggers })` reaches every shard's engine,
// and they run in client mutations, scheduled jobs, actions' runMutation and the dashboard's data edits, in the same
// transaction (a throwing trigger fails only its own item of a group-committed batch).
import { runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import type { Shard } from "../src/shard.ts";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";

type Patch = Extract<ServerMessage, { t: "patch" }>;

const tally = async (shard: string, key: string) => (await api("query", { fn: "tallies:get", args: { key }, shard })).body.value as string[];

async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const x = await fn();
    if (ok(x) || Date.now() > end) return x;
    await sleep(20);
  }
}

const admin = (path: string, body: unknown) =>
  SELF.fetch(`http://ember/api/_ember/${path}`, {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

describe("triggers", () => {
  it("run in client mutations, and subscribers see what they wrote", async () => {
    const shard = "trig:client";
    const c = await connect(shard);
    await hello(c);
    c.send({ t: "sub", qid: "t", fn: "tallies:get", args: { key: "a" } });
    await c.waitFor(is("snap"));
    expect((await api("mutation", { fn: "tallies:add", args: { key: "a" }, shard })).body.ok).toBe(true);
    const p = await c.waitFor<Patch>(is("patch"));
    expect(p.changes[0]).toMatchObject({ qid: "t", value: ["insert"] });
    c.close();
  });

  it("run in scheduled jobs and in an action's runMutation", async () => {
    const shard = "trig:jobs";
    expect((await api("mutation", { fn: "tallies:addLater", args: { key: "j" }, shard })).body.ok).toBe(true);
    expect(await until(() => tally(shard, "j"), (x) => x.length === 1)).toEqual(["insert"]);
    const r = await SELF.fetch("http://ember/api/action", { method: "POST", body: JSON.stringify({ fn: "tallies:addFromAction", args: { key: "act" }, shard }) });
    expect(r.status).toBe(200);
    expect(await tally(shard, "act")).toEqual(["insert"]);
  });

  it("run on the dashboard's insert / patch / delete", async () => {
    const shard = "trig:dash";
    const ins = await admin("data/insert", { shard, table: "tallied", doc: { key: "d" } });
    expect(ins.status).toBe(200);
    const id = ins.body.value as string;
    expect((await admin("data/patch", { shard, table: "tallied", id, fields: { fail: false } })).status).toBe(200);
    expect((await admin("data/delete", { shard, table: "tallied", ids: [id] })).status).toBe(200);
    expect(await tally(shard, "d")).toEqual(["insert", "update", "delete"]);
    // A throwing trigger refuses the dashboard's write too.
    const bad = await admin("data/insert", { shard, table: "tallied", doc: { key: "d", fail: true } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(await tally(shard, "d")).toEqual(["insert", "update", "delete"]);
  });

  it("a throwing trigger fails only its own item of a group-committed batch", async () => {
    const shard = "trig:batch";
    const stub = shardStub(shard);
    await stub.warm(shard);
    const outcomes = await runInDurableObject(stub, (instance: Shard) =>
      Promise.all(Array.from({ length: 5 }, (_, i) => instance.mutation(shard, "tallies:add", { key: "b", ...(i === 2 ? { fail: true } : {}) }, null))),
    );
    expect(outcomes.map((o) => o.ok)).toEqual([true, true, false, true, true]);
    expect(outcomes[2]).toMatchObject({ ok: false, error: { message: expect.stringContaining("trigger refused") } });
    expect(await tally(shard, "b")).toEqual(["insert", "insert", "insert", "insert"]);
    expect((await stub.inspect()).stats).toMatchObject({ batches: 1 });
  });
});
