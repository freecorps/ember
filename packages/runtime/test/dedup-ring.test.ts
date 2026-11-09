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
