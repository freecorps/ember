// TinyBase specifics: the app's own Store holds the replica in plain tables (readable and reactive in TinyBase),
// app writes to those tables re-run local queries, and values JSON cannot carry survive the round trip.
import { describe, expect, it } from "vitest";
import { createStore } from "tinybase";
import { stableStringify, type LocalQueryResult } from "@freecorps/ember-client";
import { defineSchema, defineTable, makeId, query, v, type Doc } from "@freecorps/ember-server";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { tinybaseStorage, type TinyStore } from "../src/tinybase.ts";

const SHARD = "org:acme";
const req = (fn: string, args: Record<string, unknown> = {}, shard = SHARD) => ({ shard, fn, args, argsJson: stableStringify(args), identity: null });
const upd = (fn: string, args: Record<string, unknown>, value: unknown, version = 1, shard = SHARD) => ({ shard, fn, args, argsJson: stableStringify(args), value, version });

describe("tinybase storage", () => {
  it("puts replicated rows in the app's tables and re-runs local queries when the app writes them", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "hello" });
    const store = createStore();
    const s = tinybaseStorage({ store: store as unknown as TinyStore, schema, queries: offlineQueries });
    await s.load();
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    await s.applyPatch(upd("messages:list", { channel: "a" }, list));
    const id = list[0]!._id;
    // the app reads it as a TinyBase table: plain cells, first shard untagged
    expect(store.getRow("messages", id)).toEqual({ _id: id, _creationTime: list[0]!._creationTime, channel: "a", body: "hello" });
    let reactive = 0;
    store.addTableListener("messages", () => reactive++);

    const seen: Array<LocalQueryResult | undefined> = [];
    s.watchQueryLocally(req("messages:search", { q: "edited" }), (r) => seen.push(r));
    await s.flush();
    await s.flush();
    store.setCell("messages", id, "body", "edited by the app");
    await s.flush();
    await s.flush();
    expect(seen.map((r) => r!.value)).toEqual([[], ["edited by the app"]]);
    // the server stays the source of truth: its next value rewrites the row
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 2));
    expect(store.getCell("messages", id, "body")).toBe("hello");
    expect(reactive).toBe(2);

    // another shard's rows carry `_shard`
    srv.m("messages:send", { channel: "z", body: "other shard" });
    const z = srv.q("messages:list", { channel: "z" }) as Doc[];
    await s.applyPatch(upd("messages:list", { channel: "z" }, z, 1, "org:other"));
    expect(store.getCell("messages", z[0]!._id, "_shard")).toBe("org:other");
    expect((await s.runQueryLocally(req("messages:list", { channel: "z" }, "org:other")))!.value).toEqual(z);
    expect((await s.runQueryLocally(req("messages:list", { channel: "z" })))!.value).toEqual([]);
    await s.close();
  });

  it("keeps values JSON cannot carry (int64, bytes, NaN, nested objects, null)", async () => {
    const odd = defineSchema({
      tables: { blobs: defineTable({ n: v.int64(), data: v.bytes(), f: v.float64(), meta: v.object({ tags: v.array(v.string()), x: v.null() }) }) },
    });
    const all = query({ handler: (ctx: any) => ctx.db.query("blobs").collect() });
    const store = createStore();
    const s = tinybaseStorage({ store: store as unknown as TinyStore, schema: odd, queries: { "blobs:all": all } });
    await s.load();
    const doc = { _id: makeId(odd.manifest.tables.blobs!.idPrefix, 1, Math.random), _creationTime: 1, n: 2n ** 62n, data: new Uint8Array([0, 255]), f: Number.NaN, meta: { tags: ["a"], x: null } };
    await s.applyPatch(upd("blobs:all", {}, [doc]));
    const back = (await s.runQueryLocally(req("blobs:all")))!;
    expect(back.source).toBe("local");
    expect(back.value).toEqual([doc]);
    await s.close();
  });
});
