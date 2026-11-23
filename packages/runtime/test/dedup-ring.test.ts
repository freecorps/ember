// Mutation outcomes in the change-log ring (feature "ack"): a socket mutation's outcome rides in its commit's ring
// row, so retries are deduped with no dedup row; the client's ack lets the shard forget it, and only outcomes never
// acknowledged move to the dedup generation tables when their slot is reused (test worker: changeLogVersions = 5).
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import type { Shard } from "../src/shard.ts";
import { api, connect, hello, is, shardStub, type Client } from "./helpers.ts";

type Mres = Extract<ServerMessage, { t: "mres" }>;

const RING = 5;

/** Commits `n` versions through HTTP (no dedup), one per call. */
async function commits(shard: string, n: number) {
  for (let i = 0; i < n; i++) {
    const r = await api("mutation", { fn: "messages:send", args: { channel: "filler", body: `f${i}` }, shard });
    expect(r.body.ok).toBe(true);
  }
}

/** Rows of the newest dedup generation for `mid` (qidKey form). */
async function spilled(shard: string, mid: string): Promise<number> {
  return runInDurableObject(shardStub(shard), (instance: Shard) => {
    const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
    const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '_ember_dedup%'").toArray();
    let n = 0;
    for (const t of tables) n += sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${t.name} WHERE mid = ?`, JSON.stringify(mid)).toArray()[0]!.n;
    return n;
  });
}

async function mutate(c: Client, mid: string, body: string): Promise<Mres> {
  c.send({ t: "mut", mid, fn: "messages:send", args: { channel: "ring", body } });
  return c.waitFor<Mres>(is("mres", (m) => m.mid === mid));
}

describe("outcomes in the change-log ring", () => {
  it("negotiates the feature", async () => {
    const c = await connect("chat:ring-ready");
    expect((await hello(c, "dev", undefined, ["ack"])).features).toEqual(["ack"]);
    c.close();
  });

  it("a retry is deduped from the ring (no dedup row), then from the generations once its slot is reused", async () => {
    const shard = "chat:ring-unacked";
    const c1 = await connect(shard);
    await hello(c1, "dev-1", "good:dan", ["ack"]);
    const first = await mutate(c1, "a", "once");
    expect(first).toMatchObject({ ok: true });
    expect(await spilled(shard, "a")).toBe(0);
    c1.close();
    // Retry while the ring still holds it.
    const c2 = await connect(shard);
    await hello(c2, "dev-1", "good:dan", ["ack"]);
    expect(await mutate(c2, "a", "once")).toEqual(first);
    // Reuse its slot: the outcome was never acknowledged, so it moves to the dedup table and stays findable.
    await commits(shard, RING + 1);
    expect(await spilled(shard, "a")).toBe(1);
    expect(await mutate(c2, "a", "once")).toEqual(first);
    const list = await api("query", { fn: "messages:list", args: { channel: "ring" }, shard });
    expect(list.body.value).toHaveLength(1);
    c2.close();
  });

  it("an acknowledged outcome is forgotten when its slot is reused: never a dedup row", async () => {
    const shard = "chat:ring-acked";
    const c = await connect(shard);
    await hello(c, "dev-1", "good:dan", ["ack"]);
    const first = await mutate(c, "b", "once");
    c.send({ t: "ack", mids: ["b"] });
    // Still in the ring: a retry (which an honest client would not send) is deduped.
    expect(await mutate(c, "b", "once")).toEqual(first);
    await commits(shard, RING + 1);
    expect(await spilled(shard, "b")).toBe(0);
    c.close();
  });

  it("acks of another client or identity, or for unknown mids, change nothing", async () => {
    const shard = "chat:ring-foreign";
    const owner = await connect(shard);
    await hello(owner, "dev-1", "good:dan", ["ack"]);
    await mutate(owner, "c", "once");
    const other = await connect(shard);
    await hello(other, "dev-2", "good:dan", ["ack"]);
    other.send({ t: "ack", mids: ["c", "nope"] });
    const intruder = await connect(shard);
    await hello(intruder, "dev-1", "good:eve", ["ack"]);
    intruder.send({ t: "ack", mids: ["c"] });
    await commits(shard, RING + 1);
    expect(await spilled(shard, "c")).toBe(1);
    owner.close();
    other.close();
    intruder.close();
  });

  it("acks waiting in a socket's attachment survive an eviction; with the socket gone they only cost the spill", async () => {
    const shard = "chat:ring-evicted";
    const c = await connect(shard);
    await hello(c, "dev-1", "good:dan", ["ack"]);
    const kept = await mutate(c, "d1", "kept");
    c.send({ t: "ack", mids: ["d1"] });
    await new Promise((r) => setTimeout(r, 20));
    await evictDurableObject(shardStub(shard));
    await commits(shard, RING + 1);
    expect(await spilled(shard, "d1")).toBe(0);
    expect(kept.ok).toBe(true);

    const lost = await mutate(c, "d2", "lost");
    c.send({ t: "ack", mids: ["d2"] });
    await new Promise((r) => setTimeout(r, 20));
    c.close();
    await new Promise((r) => setTimeout(r, 20));
    await evictDurableObject(shardStub(shard));
    await commits(shard, RING + 1);
    expect(await spilled(shard, "d2")).toBe(1);
    const again = await connect(shard);
    await hello(again, "dev-1", "good:dan", ["ack"]);
    expect(await mutate(again, "d2", "lost")).toEqual(lost);
    again.close();
  });

  it("acks written into a ring row survive an eviction", async () => {
    const shard = "chat:ring-durable";
    const c = await connect(shard);
    await hello(c, "dev-1", "good:dan", ["ack"]);
    await mutate(c, "e", "once");
    c.send({ t: "ack", mids: ["e"] });
    await new Promise((r) => setTimeout(r, 20));
    // The next commit carries the ack; then the object restarts and loads the ring from storage.
    await commits(shard, 1);
    await evictDurableObject(shardStub(shard));
    await commits(shard, RING + 1);
    expect(await spilled(shard, "e")).toBe(0);
  });
});

/** A socket mutation by name, its `mres`. */
async function call(c: Client, mid: string, fn: string, args: Record<string, unknown>): Promise<Mres> {
  c.send({ t: "mut", mid, fn, args });
  return c.waitFor<Mres>(is("mres", (m) => m.mid === mid));
}

/** Whether the shard has marked `(identity, clientId)` as having spilled outcomes (each of its mutations then looks). */
async function marked(shard: string, identity: string, clientId: string): Promise<boolean | undefined> {
  return runInDurableObject(shardStub(shard), (instance: Shard) => (instance as unknown as { spilledClients: Map<string, boolean> }).spilledClients.get(`${identity}\n${clientId}`));
}

describe("outcomes with no effect (nothing written, or an error)", () => {
  it("never become dedup rows nor mark the client, and a retry still gets the same outcome", async () => {
    const shard = "chat:volatile";
    const c1 = await connect(shard);
    await hello(c1, "dev-v", "good:dan", ["ack"]);
    const noop = await call(c1, "n1", "misc:noop", {});
    const failed = await call(c1, "f1", "messages:send", { channel: "v", body: "fail" });
    expect(noop).toMatchObject({ ok: true, value: null });
    expect(failed).toMatchObject({ ok: false });
    expect(await spilled(shard, "n1")).toBe(0);
    expect(await spilled(shard, "f1")).toBe(0);
    expect(await marked(shard, "dan", "dev-v")).not.toBe(true);
    // The mres was "lost": the client resends on a new socket and gets the very same answers.
    c1.close();
    const c2 = await connect(shard);
    await hello(c2, "dev-v", "good:dan", ["ack"]);
    expect(await call(c2, "n1", "misc:noop", {})).toEqual(noop);
    expect(await call(c2, "f1", "messages:send", { channel: "v", body: "fail" })).toEqual(failed);
    // Slots reused without an ack: still no dedup row (re-running changes nothing).
    await commits(shard, RING + 1);
    expect(await spilled(shard, "n1")).toBe(0);
    expect(await spilled(shard, "f1")).toBe(0);
    expect(await marked(shard, "dan", "dev-v")).not.toBe(true);
    const list = await api("query", { fn: "messages:list", args: { channel: "v" }, shard });
    expect(list.body.value).toEqual([]);
    c2.close();
  });

  it("a later commit's ring row carries them: an eviction keeps the outcome; an ack forgets it", async () => {
    const shard = "chat:volatile-evicted";
    const c = await connect(shard);
    await hello(c, "dev-w", "good:dan", ["ack"]);
    const kept = await call(c, "k1", "misc:noop", {});
    const acked = await call(c, "k2", "misc:noop", {});
    c.send({ t: "ack", mids: ["k2"] });
    await new Promise((r) => setTimeout(r, 20));
    await commits(shard, 1);
    await evictDurableObject(shardStub(shard));
    expect(await call(c, "k1", "misc:noop", {})).toEqual(kept);
    // Acknowledged: forgotten (an honest client never resends it; this one runs again, harmlessly, at a new version).
    const again = await call(c, "k2", "misc:noop", {});
    expect(again).toMatchObject({ ok: true, value: null });
    expect(acked).toMatchObject({ ok: true });
    await commits(shard, RING + 1);
    expect(await spilled(shard, "k1")).toBe(0);
    c.close();
  });

  it("a socket mutation that only schedules a job (no row change) still has its outcome kept durably: exactly once", async () => {
    const shard = "chat:volatile-jobs";
    const c1 = await connect(shard);
    await hello(c1, "dev-j", "good:dan", ["ack"]);
    const first = await call(c1, "j1", "jobs:later", { label: "once" });
    expect(first.ok).toBe(true);
    expect(await spilled(shard, "j1")).toBe(1);
    c1.close();
    await evictDurableObject(shardStub(shard));
    const c2 = await connect(shard);
    await hello(c2, "dev-j", "good:dan", ["ack"]);
    expect(await call(c2, "j1", "jobs:later", { label: "once" })).toEqual(first);
    const jobs = (await shardStub(shard).inspect()).jobs.filter((j) => j.fn === "jobs:record");
    expect(jobs).toHaveLength(1);
    c2.close();
  });

  it("in a commit with changes, an error's outcome rides in the ring row and is not spilled when the slot is reused", async () => {
    const shard = "chat:volatile-ring";
    const c = await connect(shard);
    await hello(c, "dev-r", "good:dan", ["batch"]);
    // One frame: both mutations land in one group-commit batch (one ring row).
    c.send(JSON.stringify([{ t: "mut", mid: "ok1", fn: "messages:send", args: { channel: "vr", body: "yes" } }, { t: "mut", mid: "bad1", fn: "messages:send", args: { channel: "vr", body: "fail" } }]));
    const ok = await c.waitFor<Mres>(is("mres", (m) => m.mid === "ok1"));
    const bad = await c.waitFor<Mres>(is("mres", (m) => m.mid === "bad1"));
    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(await call(c, "bad1", "messages:send", { channel: "vr", body: "fail" })).toEqual(bad);
    await commits(shard, RING + 1);
    // Never acknowledged (no "ack" feature): the effectful one moves to the dedup table, the error does not.
    expect(await spilled(shard, "ok1")).toBe(1);
    expect(await spilled(shard, "bad1")).toBe(0);
    expect(await call(c, "ok1", "messages:send", { channel: "vr", body: "yes" })).toEqual(ok);
    c.close();
  });
});
