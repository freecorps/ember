import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { connect, hello, is, shardStub, sleep } from "./helpers.ts";

type Snap = Extract<ServerMessage, { t: "snap" }> & { value?: any };
type Patch = Extract<ServerMessage, { t: "patch" }>;

describe("shard websocket protocol", () => {
  it("requires hello, answers ready, ping/pong auto-response, rejects bad frames", async () => {
    const c = await connect("chat:basic");
    c.send({ t: "sub", qid: 1, fn: "auth:whoami", args: {} });
    expect(await c.waitFor(is("err"))).toMatchObject({ code: "no_hello" });
    const ready = await hello(c);
    expect(ready).toMatchObject({ shard: "chat:basic", version: 0 });
    expect(ready.epoch).toMatch(/[0-9a-f-]{36}/);
    c.send("ping");
    await sleep(30);
    expect(c.raw).toContain("pong");
    c.send("{oops");
    expect(await c.waitFor(is("err"))).toMatchObject({ code: "bad_frame" });
    c.send({ t: "hello", clientId: "x", protocol: 1 });
    expect(await c.waitFor(is("err"))).toMatchObject({ code: "duplicate_hello" });
    c.close();
  });

  it("subscribe on A, mutate on B -> one patch on A, mres on B", async () => {
    const shard = "chat:sub";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a);
    await hello(b, "client-b", "good:bob");
    a.send({ t: "sub", qid: "q1", fn: "messages:list", args: { channel: "general" } });
    a.send({ t: "sub", qid: "q2", fn: "messages:list", args: { channel: "other" } });
    expect(await a.waitFor<Snap>(is("snap", (m) => m.qid === "q1"))).toMatchObject({ version: 0, value: [] });
    await a.waitFor(is("snap", (m) => m.qid === "q2"));
    b.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "general", body: "hello" } });
    const patch = await a.waitFor<Patch>(is("patch"));
    expect(patch.version).toBe(1);
    // q2 reads the same table but its result did not change -> not in the patch
    expect(patch.changes).toEqual([{ qid: "q1", value: [expect.objectContaining({ body: "hello", author: "bob" })] }]);
    expect(await b.waitFor(is("mres"))).toMatchObject({ mid: 1, ok: true, version: 1 });
    // unsub stops patches
    a.send({ t: "unsub", qid: "q1" });
    await sleep(20);
    b.send({ t: "mut", mid: 2, fn: "messages:send", args: { channel: "general", body: "again" } });
    await b.waitFor(is("mres", (m) => m.mid === 2));
    await sleep(30);
    expect(a.frames.filter((f) => f.t === "patch")).toEqual([]);
    expect(await shardStub(shard).inspect()).toMatchObject({ subs: 1, queries: 1 });
    a.close();
    b.close();
  });

  it("auth: token on hello, auth frame re-snaps, invalid or already-expired tokens are refused", async () => {
    const c = await connect("chat:auth");
    await hello(c, "c", "good:ann");
    c.send({ t: "sub", qid: 1, fn: "auth:whoami", args: {} });
    expect(await c.waitFor<Snap>(is("snap"))).toMatchObject({ value: "ann" });
    c.send({ t: "auth", token: "good:zed" });
    expect(await c.waitFor<Snap>(is("snap"))).toMatchObject({ qid: 1, value: "zed" });
    c.send({ t: "auth", token: "nope" });
    expect(await c.waitFor(is("err"))).toMatchObject({ code: "unauthenticated" });
    c.send({ t: "auth", token: "expired:old" });
    expect(await c.waitFor(is("err"))).toMatchObject({ code: "unauthenticated" });
    c.close();
  });

  it("hibernation wake restores subscriptions from _ember_subs", async () => {
    const shard = "chat:hibernate";
    const a = await connect(shard);
    const b = await connect(shard);
    await hello(a, "a", "good:amy");
    await hello(b);
    a.send({ t: "sub", qid: 9, fn: "messages:list", args: { channel: "h" } });
    await a.waitFor(is("snap"));
    const stub = shardStub(shard);
    const before = await stub.inspect();
    await evictDurableObject(stub);
    b.send({ t: "mut", mid: "m1", fn: "messages:send", args: { channel: "h", body: "after wake" } });
    const patch = await a.waitFor<Patch>(is("patch"));
    expect(patch.changes).toEqual([{ qid: 9, value: [expect.objectContaining({ body: "after wake" })] }]);
    await b.waitFor(is("mres"));
    const after = await stub.inspect();
    expect(after.stats.booted).toBe(1); // fresh instance
    expect(after.stats.rebuiltSubs).toBe(1);
    expect(after.stats.migrated).toBe(0); // schema check cached per isolate
    expect(before.epoch).toBe(after.epoch);
    // identity survived in the attachment
    a.send({ t: "sub", qid: 10, fn: "auth:whoami", args: {} });
    expect(await a.waitFor<Snap>(is("snap", (m) => m.qid === 10))).toMatchObject({ value: "amy" });
    a.close();
    b.close();
  });

  it("closing a socket removes its subscriptions", async () => {
    const shard = "chat:close";
    const a = await connect(shard);
    await hello(a);
    a.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "x" } });
    await a.waitFor(is("snap"));
    a.close();
    await sleep(50);
    expect(await shardStub(shard).inspect()).toMatchObject({ subs: 0, queries: 0 });
  });

  it("resume: unchanged, changed elsewhere, changed, too old, wrong epoch", async () => {
    const shard = "chat:resume";
    const c = await connect(shard);
    const { epoch } = await hello(c);
    const mut = async (mid: number, channel: string) => {
      c.send({ t: "mut", mid, fn: "messages:send", args: { channel, body: `m${mid}` } });
      return (await c.waitFor(is("mres", (m) => m.mid === mid))) as { version: number };
    };
    await mut(1, "r"); // v1
    await mut(2, "elsewhere"); // v2: other channel, same table
    const sub = (qid: number, resume?: { version: number; epoch: string }) => {
      c.send(resume ? { t: "sub", qid, fn: "messages:list", args: { channel: "r" }, resume } : { t: "sub", qid, fn: "messages:list", args: { channel: "r" } });
      return c.waitFor<Snap>(is("snap", (m) => m.qid === qid));
    };
    // A qid this client never got a snapshot for cannot be resumed (identity unknown): full snap first.
    expect((await sub(1, { version: 2, epoch })).value).toHaveLength(1);
    c.send({ t: "unsub", qid: 1 });
    expect(await sub(1, { version: 2, epoch })).toEqual({ t: "snap", qid: 1, version: 2, unchanged: true });
    c.send({ t: "unsub", qid: 1 });
    // v2 wrote another channel: outside the by_channel range read by the query -> still unchanged.
    expect(await sub(1, { version: 1, epoch })).toMatchObject({ unchanged: true });
    c.send({ t: "unsub", qid: 1 });
    // changed since v0, wrong epoch, too old (log keeps 5 versions), from the future -> full snap
    expect((await sub(1, { version: 0, epoch })).value).toHaveLength(1);
    c.send({ t: "unsub", qid: 1 });
    expect((await sub(1, { version: 2, epoch: "other" })).value).toHaveLength(1);
    c.send({ t: "unsub", qid: 1 });
    for (let i = 3; i <= 9; i++) await mut(i, "elsewhere");
    expect((await sub(1, { version: 2, epoch })).value).toHaveLength(1);
    c.send({ t: "unsub", qid: 1 });
    expect(await sub(1, { version: 9, epoch })).toMatchObject({ unchanged: true });
    c.send({ t: "unsub", qid: 1 });
    expect((await sub(1, { version: 99, epoch })).value).toHaveLength(1);
    c.close();
  });
});
