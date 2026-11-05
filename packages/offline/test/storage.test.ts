import { afterEach, describe, expect, it } from "vitest";
import { stableStringify, type PendingMutationRecord } from "@freecorps/ember-client";
import { defineSchema, defineTable, v, type Doc } from "@freecorps/ember-server";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { backend, BACKENDS } from "./backends.ts";
import { MemoryBackend, memoryStorage, type OfflineStore } from "../src/index.ts";

const SHARD = "org:acme";
const req = (fn: string, args: Record<string, unknown> = {}, shard = SHARD) => ({ shard, fn, args, argsJson: stableStringify(args), identity: null });
const upd = (fn: string, args: Record<string, unknown>, value: unknown, version = 1, shard = SHARD) => ({ shard, fn, args, argsJson: stableStringify(args), value, version });
const bodies = (x: unknown) => (x as Doc[]).map((d) => (d as any).body);

describe.each(BACKENDS)("offline storage: %s", (kind) => {
  const cleanups: Array<() => void> = [];
  const open: OfflineStore[] = [];
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close().catch(() => undefined);
    for (const c of cleanups.splice(0)) c();
  });
  const setup = () => {
    const b = backend(kind);
    cleanups.push(b.cleanup);
    const make = (o: Partial<Parameters<typeof b.make>[0]> = {}) => {
      const s = b.make({ schema, queries: offlineQueries, ...o });
      open.push(s);
      return s;
    };
    return { make };
  };

  it("replicates query results, survives a reload, and runs the same queries locally (search included)", async () => {
    const srv = engineServer();
    for (const [channel, body] of [["a", "Ação rápida"], ["a", "acao lenta"], ["a", "nada"], ["b", "outra ação"]]) srv.m("messages:send", { channel, body });
    const { make } = setup();
    const s1 = make();
    await s1.load();
    await s1.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    await s1.applyPatch(upd("messages:list", { channel: "b" }, srv.q("messages:list", { channel: "b" })));
    await s1.applyPatch(upd("messages:count", {}, srv.q("messages:count")));
    await s1.close();
    open.splice(open.indexOf(s1), 1);

    const s2 = make();
    await s2.load();
    // registered: computed locally from replicated rows, identical to the server
    expect(await s2.runQueryLocally(req("messages:list", { channel: "a" }))).toEqual({ value: srv.q("messages:list", { channel: "a" }), source: "local" });
    expect(await s2.runQueryLocally(req("messages:latest", { channel: "a", n: 2 }))).toEqual({ value: srv.q("messages:latest", { channel: "a", n: 2 }), source: "local" });
    // never subscribed, still answerable: search over every replicated row, accent-insensitive
    const local = (await s2.runQueryLocally(req("messages:search", { q: "acao" })))!;
    expect(local.source).toBe("local");
    expect([...(local.value as string[])].sort()).toEqual([...(srv.q("messages:search", { q: "acao" }) as string[])].sort());
    expect((local.value as string[]).sort()).toEqual(["Ação rápida", "acao lenta", "outra ação"]);
    if (kind === "sqlite" || kind === "expo-sqlite" || kind === "sqlite-wasm") expect(local.value).toEqual(srv.q("messages:search", { q: "acao" })); // FTS5: same bm25 order
    expect((await s2.runQueryLocally(req("messages:search", { q: "RAP" })))!.value).toEqual(["Ação rápida"]);
    // not registered: the cached server value
    expect(await s2.runQueryLocally(req("messages:count"))).toEqual({ value: 4, source: "cache" });
    expect(await s2.runQueryLocally(req("messages:count", {}, "org:other"))).toBeUndefined();
    // another shard has its own replica
    expect((await s2.runQueryLocally(req("messages:list", { channel: "a" }, "org:other")))!.value).toEqual([]);
  });

  it("deletes a row when no stored result owns it any more", async () => {
    const srv = engineServer();
    const id1 = srv.m("messages:send", { channel: "a", body: "one" });
    srv.m("messages:send", { channel: "a", body: "two" });
    const { make } = setup();
    const s = make();
    await s.load();
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    await s.applyPatch(upd("messages:latest", { channel: "a", n: 1 }, srv.q("messages:latest", { channel: "a", n: 1 })));
    // edited on the server: both owners see the new body
    srv.m("messages:edit", { id: id1, body: "uno" });
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 2));
    expect(bodies((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["uno", "two"]);
    expect((await s.runQueryLocally(req("messages:search", { q: "one" })))!.value).toEqual([]);
    // deleted on the server: gone from list; `latest` (n=1) never owned it
    srv.m("messages:remove", { id: id1 });
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 3));
    expect(bodies((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["two"]);
    // `two` is still owned by `latest` after `list` changes channel contents away from it
    await s.applyPatch(upd("messages:list", { channel: "a" }, [], 4));
    expect(bodies((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["two"]);
    await s.applyPatch(upd("messages:latest", { channel: "a", n: 1 }, [], 5));
    expect((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value).toEqual([]);
  });

  it("keeps the client id, the pending queue (in order) and the identity across reloads", async () => {
    const { make } = setup();
    const s1 = make();
    expect(await s1.load()).toEqual({ identity: null });
    const p = s1.persistPending;
    expect(await p.getClientId()).toBeNull();
    await p.setClientId("client-1");
    const rec = (mid: string, body: string): PendingMutationRecord => ({ mid, shard: SHARD, fn: "messages:send", args: { channel: "a", body, n: 2n ** 60n }, createdAt: 1 });
    await p.put(rec("m1", "first"));
    await p.put(rec("m2", "second"));
    await p.put(rec("m3", "third"));
    await p.put(rec("m1", "first, edited"));
    await p.remove("m2");
    await s1.setIdentity({ subject: "ada", issuer: "me" });
    await s1.close();
    open.splice(open.indexOf(s1), 1);

    const s2 = make();
    expect(await s2.load()).toEqual({ identity: { subject: "ada", issuer: "me" } });
    expect(await s2.persistPending.getClientId()).toBe("client-1");
    const loaded = await s2.persistPending.load();
    expect(loaded.map((r) => [r.mid, r.args.body])).toEqual([["m1", "first, edited"], ["m3", "third"]]);
    expect(loaded[0]!.args.n).toBe(2n ** 60n);
    // local queries run as the stored identity
    expect((await s2.runQueryLocally({ ...req("messages:mine"), identity: { subject: "ada" } }))!.value).toBe("ada");
  });

  it("evicts the least recently refreshed results and drops expired ones on load", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "in a" });
    srv.m("messages:send", { channel: "b", body: "in b" });
    let now = 1_000_000;
    const { make } = setup();
    const s = make({ maxQueries: 1, now: () => now });
    await s.load();
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    now += 10;
    await s.applyPatch(upd("messages:list", { channel: "b" }, srv.q("messages:list", { channel: "b" })));
    expect((await s.runQueryLocally(req("messages:search", { q: "in" })))!.value).toEqual(["in b"]);
    await s.close();
    open.splice(open.indexOf(s), 1);

    now += 31 * 86_400_000;
    const s2 = make({ now: () => now });
    await s2.load();
    expect((await s2.runQueryLocally(req("messages:list", { channel: "b" })))!.value).toEqual([]);
  });

  it("resets the replica (not the pending queue) on an incompatible schema change", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "old" });
    const { make } = setup();
    const s1 = make();
    await s1.load();
    await s1.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    await s1.persistPending.put({ mid: "m1", shard: SHARD, fn: "messages:send", args: {}, createdAt: 1 });
    await s1.close();
    open.splice(open.indexOf(s1), 1);

    const next = defineSchema({
      tables: {
        messages: defineTable({ channel: v.string(), body: v.string(), author: v.optional(v.string()), required: v.number() })
          .index("by_channel", ["channel"])
          .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
        channels: defineTable({ name: v.string() }),
      },
    });
    const s2 = make({ schema: next });
    await s2.load();
    expect((await s2.runQueryLocally(req("messages:list", { channel: "a" })))?.value ?? []).toEqual([]);
    expect((await s2.persistPending.load()).map((r) => r.mid)).toEqual(["m1"]);
  });
});

describe("offline storage: failed commits", () => {
  it("leave refcounts and records as they were, so a later delete still removes the row", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "one" });
    let failNext = false;
    class FlakyBackend extends MemoryBackend {
      override commit(...a: Parameters<MemoryBackend["commit"]>) {
        if (failNext) {
          failNext = false;
          throw new Error("quota");
        }
        return super.commit(...a);
      }
    }
    const s = memoryStorage({ schema, queries: offlineQueries, backend: new FlakyBackend() });
    await s.load();
    const list = srv.q("messages:list", { channel: "a" });
    failNext = true;
    await expect(s.applyPatch(upd("messages:list", { channel: "a" }, list))).rejects.toThrow("quota");
    expect(await s.runQueryLocally(req("messages:list", { channel: "a" }))).toEqual({ value: [], source: "local" });
    await s.applyPatch(upd("messages:list", { channel: "a" }, list));
    expect(bodies((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["one"]);
    await s.applyPatch(upd("messages:list", { channel: "a" }, [], 2));
    expect((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value).toEqual([]);
    // dropping records (clear/eviction/retention) too: a failed drop keeps them, a later one removes them
    await s.applyPatch(upd("messages:list", { channel: "a" }, list, 3));
    failNext = true;
    await expect(s.clear()).rejects.toThrow("quota");
    expect(await s.runQueryLocally(req("messages:count"))).toBeUndefined();
    expect(bodies((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["one"]);
    await s.clear();
    expect((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value).toEqual([]);
    await s.close();
  });
});
