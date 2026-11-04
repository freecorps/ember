import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import type { Shard } from "../src/shard.ts";
import { api, connect, hello, is, shardStub, sleep } from "./helpers.ts";

type Mres = Extract<ServerMessage, { t: "mres" }>;

describe("group commit", () => {
  it("N concurrent mutations -> one transaction, one version, one patch; a failing item is isolated", async () => {
    const shard = "chat:gc";
    const watcher = await connect(shard);
    const w = await connect(shard);
    await hello(watcher);
    await hello(w);
    watcher.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "g" } });
    await watcher.waitFor(is("snap"));
    const N = 20;
    for (let i = 0; i < N; i++) {
      w.send({ t: "mut", mid: i, fn: "messages:send", args: { channel: "g", body: i === 7 ? "fail" : `b${i}` } });
    }
    const results: Mres[] = [];
    for (let i = 0; i < N; i++) results.push(await w.waitFor<Mres>(is("mres", (m) => m.mid === i)));
    const ok = results.filter((r) => r.ok) as Array<Extract<Mres, { ok: true }>>;
    expect(ok).toHaveLength(N - 1);
    expect(results[7]).toMatchObject({ ok: false, error: { code: "Error", message: expect.stringContaining("may not be") } });
    const info = await shardStub(shard).inspect();
    // Delivery timing decides how many batches form; every batch is one version and one patch.
    const versions = [...new Set(ok.map((r) => r.version))].sort();
    expect(versions).toEqual(Array.from({ length: info.stats.batches }, (_, i) => i + 1));
    expect(info.stats.batches).toBeLessThan(N / 2);
    await sleep(20);
    const patches = watcher.frames.filter((f) => f.t === "patch") as Array<Extract<ServerMessage, { t: "patch" }>>;
    expect(patches.map((p) => p.version)).toEqual(versions);
    expect(patches.at(-1)!.changes[0]!.value).toHaveLength(N - 1);
    watcher.close();
    w.close();
  });

  it("mutations enqueued in the same turn commit in exactly one transaction", async () => {
    const shard = "chat:gc-exact";
    const stub = shardStub(shard);
    await stub.warm(shard);
    const outcomes = await runInDurableObject(stub, (instance: Shard) =>
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          instance.mutation(shard, "messages:send", { channel: "e", body: i === 3 ? "fail" : `${i}` }, null),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.ok).map((o) => (o as { version: number }).version)).toEqual(Array(9).fill(1));
    expect(outcomes[3]).toMatchObject({ ok: false, error: { code: "Error", message: expect.stringContaining("may not be") } });
    const info = await stub.inspect();
    expect(info.stats).toMatchObject({ batches: 1, batchSizes: [10] });
    expect(info.version).toBe(1);
  });

  it("HTTP mutations join the same batch", async () => {
    const shard = "chat:gc-http";
    const rs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => api("mutation", { fn: "messages:send", args: { channel: "h", body: `${i}` }, shard })),
    );
    expect(rs.every((r) => r.body.ok)).toBe(true);
    const info = await shardStub(shard).inspect();
    expect(info.stats.batches).toBeLessThan(8);
    expect(info.version).toBe(info.stats.batches);
  });

  it("dedup by (identity, clientId, mid): retries return the stored result without re-running", async () => {
    const shard = "chat:dedup";
    const c1 = await connect(shard);
    await hello(c1, "dev-1", "good:dan");
    c1.send({ t: "mut", mid: "x", fn: "messages:send", args: { channel: "d", body: "once" } });
    const first = await c1.waitFor<Mres>(is("mres"));
    c1.send({ t: "mut", mid: "x", fn: "messages:send", args: { channel: "d", body: "once" } });
    c1.send({ t: "mut", mid: "x", fn: "messages:send", args: { channel: "d", body: "once" } });
    expect(await c1.waitFor(is("mres"))).toEqual(first);
    expect(await c1.waitFor(is("mres"))).toEqual(first);
    c1.close();
    // reconnect (same identity + clientId) and retry: still deduped
    const c2 = await connect(shard);
    await hello(c2, "dev-1", "good:dan");
    c2.send({ t: "mut", mid: "x", fn: "messages:send", args: { channel: "d", body: "once" } });
    expect(await c2.waitFor(is("mres"))).toEqual(first);
    // same mid from another client or identity is a different mutation
    const c3 = await connect(shard);
    await hello(c3, "dev-2", "good:dan");
    c3.send({ t: "mut", mid: "x", fn: "messages:send", args: { channel: "d", body: "once" } });
    expect(await c3.waitFor(is("mres"))).toMatchObject({ ok: true, version: 2 });
    // duplicates inside one batch run once
    c2.send({ t: "mut", mid: "y", fn: "messages:send", args: { channel: "d", body: "y" } });
    c2.send({ t: "mut", mid: "y", fn: "messages:send", args: { channel: "d", body: "y" } });
    const y1 = await c2.waitFor(is("mres"));
    expect(await c2.waitFor(is("mres"))).toEqual(y1);
    const list = await api("query", { fn: "messages:list", args: { channel: "d" }, shard });
    expect(list.body.value).toHaveLength(3);
    c2.close();
    c3.close();
  });

  it("an async mutation handler is rejected and rolled back (SqlDriver)", async () => {
    const shard = "chat:async";
    const r = await api("mutation", { fn: "misc:async", args: {}, shard });
    expect(r.body).toMatchObject({ ok: false, error: { code: "AsyncHandler", message: expect.stringContaining("Promise") } });
    expect((await api("query", { fn: "messages:list", args: { channel: "async" }, shard })).body.value).toEqual([]);
    expect((await shardStub(shard).inspect()).version).toBe(0);
  });
});
