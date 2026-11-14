// Reactive local results (watchQueryLocally) and values persisted as row references + row-diff logs, on every
// backend; then the client side: an offline subscription follows replica changes made by another client.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmberClient, stableStringify, type LocalQueryResult, type QuerySnapshot, unsafeRef } from "@freecorps/ember-client";
import type { Doc } from "@freecorps/ember-server";
import type { RowDiff } from "@freecorps/ember-values";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { backend, BACKENDS } from "./backends.ts";
import { MemoryBackend, memoryStorage, type OfflineStore } from "../src/index.ts";

const SHARD = "org:acme";
const req = (fn: string, args: Record<string, unknown> = {}, shard = SHARD) => ({ shard, fn, args, argsJson: stableStringify(args), identity: null });
const upd = (fn: string, args: Record<string, unknown>, value: unknown, version = 1, shard = SHARD) => ({ shard, fn, args, argsJson: stableStringify(args), value, version });
const bodies = (x: unknown) => (x as Doc[]).map((d) => (d as any).body);
const until = (cond: () => unknown, timeout = 3000) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout, interval: 2 },
  );

describe.each(BACKENDS)("reactive local results: %s", (kind) => {
  const cleanups: Array<() => void> = [];
  const open: OfflineStore[] = [];
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close().catch(() => undefined);
    for (const c of cleanups.splice(0)) c();
  });
  const setup = () => {
    const b = backend(kind);
    cleanups.push(b.cleanup);
    return (o: Partial<Parameters<typeof b.make>[0]> = {}) => {
      const s = b.make({ schema, queries: offlineQueries, ...o });
      open.push(s);
      return s;
    };
  };

  it("re-runs a watched query when rows inside its read set change, and only then", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "a1" });
    srv.m("messages:send", { channel: "b", body: "b1" });
    const s = setup()();
    await s.load();
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    await s.applyPatch(upd("messages:list", { channel: "b" }, srv.q("messages:list", { channel: "b" })));

    const seenA: Array<LocalQueryResult | undefined> = [];
    const seenSearch: Array<LocalQueryResult | undefined> = [];
    const offA = s.watchQueryLocally(req("messages:latest", { channel: "a", n: 5 }), (r) => seenA.push(r));
    s.watchQueryLocally(req("messages:search", { q: "b2" }), (r) => seenSearch.push(r));
    await s.flush();
    await s.flush();
    expect(seenA.map((r) => bodies(r!.value))).toEqual([["a1"]]);
    expect(seenSearch.map((r) => r!.value)).toEqual([[]]);

    // a row of channel b changes: outside latest(a)'s ranges → no re-run there; the search sees it
    srv.m("messages:send", { channel: "b", body: "b2" });
    await s.applyPatch(upd("messages:list", { channel: "b" }, srv.q("messages:list", { channel: "b" }), 2));
    await s.flush();
    expect(seenA.length).toBe(1);
    expect(seenSearch.map((r) => r!.value)).toEqual([[], ["b2"]]);

    // a row of channel a arrives through another query's server value → latest(a) re-runs
    srv.m("messages:send", { channel: "a", body: "a2" });
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 3));
    await s.flush();
    expect(seenA.map((r) => bodies(r!.value))).toEqual([["a1"], ["a2", "a1"]]);

    // a row leaves (deleted on the server) → re-run; after unwatch, nothing more
    const a1 = (srv.q("messages:list", { channel: "a" }) as Doc[])[0]!._id;
    srv.m("messages:remove", { id: a1 });
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 4));
    await s.flush();
    expect(seenA.map((r) => bodies(r!.value)).at(-1)).toEqual(["a2"]);
    offA();
    await s.applyPatch(upd("messages:list", { channel: "a" }, [], 5));
    await s.flush();
    expect(seenA.length).toBe(3);
  });

  it("re-runs a watched db.get when that row changes (point reads are in the read set)", async () => {
    const srv = engineServer();
    const id = srv.m("messages:send", { channel: "a", body: "v1" });
    srv.m("messages:send", { channel: "a", body: "other" });
    const s = setup()();
    await s.load();
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    const seen: Array<LocalQueryResult | undefined> = [];
    s.watchQueryLocally(req("messages:one", { id }), (r) => seen.push(r));
    await s.flush();
    await s.flush();
    expect(seen.map((r) => (r!.value as any)?.body)).toEqual(["v1"]);
    srv.m("messages:edit", { id, body: "v2" });
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 2));
    await s.flush();
    await s.flush();
    expect(seen.map((r) => (r!.value as any)?.body)).toEqual(["v1", "v2"]);
    srv.m("messages:remove", { id });
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 3));
    await s.flush();
    await s.flush();
    expect(seen.map((r) => (r!.value as any)?.body ?? null)).toEqual(["v1", "v2", null]);
  });

  it("re-sends a cached value when the record of its args changes (and clear() empties local results)", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "a1" });
    const s = setup()();
    await s.load();
    const seen: Array<LocalQueryResult | undefined> = [];
    s.watchQueryLocally(req("messages:count"), (r) => seen.push(r));
    await s.flush();
    await s.applyPatch(upd("messages:count", {}, 1));
    await s.flush();
    await s.applyPatch(upd("messages:count", {}, 1, 2)); // same value: not re-sent
    await s.applyPatch(upd("messages:count", {}, 7, 3));
    await s.flush();
    expect(seen).toEqual([undefined, { value: 1, source: "cache" }, { value: 7, source: "cache" }]);

    const list: Array<LocalQueryResult | undefined> = [];
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    s.watchQueryLocally(req("messages:list", { channel: "a" }), (r) => list.push(r));
    await s.flush();
    await s.clear();
    await s.flush();
    expect(list.map((r) => bodies(r!.value))).toEqual([["a1"], []]);
  });

  it("persists small changes as row diffs, compacts, and reloads the exact values", async () => {
    const srv = engineServer();
    for (let i = 0; i < 40; i++) srv.m("messages:send", { channel: "a", body: `message ${i} `.repeat(8) });
    const make = setup();
    // `messages:list` replicated through `sync` but not registered: reads come from the stored (referenced) value
    const opts = { queries: { messages: { search: offlineQueries.messages.search } }, sync: [{ query: "messages:list", args: { channel: "a" } }] };
    const s1 = make(opts);
    await s1.load();
    let version = 1;
    await s1.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), version++));
    const ids = (srv.q("messages:list", { channel: "a" }) as Doc[]).map((d) => d._id);
    for (let i = 0; i < 70; i++) {
      // edit one, sometimes insert or remove one: each change is a few rows
      srv.m("messages:edit", { id: ids[i % ids.length], body: `edit ${i}` });
      if (i % 10 === 3) srv.m("messages:send", { channel: "a", body: `new ${i}` });
      if (i % 10 === 7) srv.m("messages:remove", { id: ids.splice(5, 1)[0] });
      await s1.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), version++));
      // plus an unregistered, non-replicated doc value: diffs carry full docs there
      await s1.applyPatch(upd("messages:latest", { channel: "a", n: 3 }, srv.q("messages:latest", { channel: "a", n: 3 }), version++));
    }
    expect((await s1.runQueryLocally(req("messages:list", { channel: "a" })))!.value).toEqual(srv.q("messages:list", { channel: "a" }));
    await s1.close();
    open.splice(open.indexOf(s1), 1);

    const s2 = make(opts);
    await s2.load();
    expect(await s2.runQueryLocally(req("messages:list", { channel: "a" }))).toEqual({ value: srv.q("messages:list", { channel: "a" }), source: "cache" });
    expect(await s2.runQueryLocally(req("messages:latest", { channel: "a", n: 3 }))).toEqual({ value: srv.q("messages:latest", { channel: "a", n: 3 }), source: "cache" });
    // the rows are the server's, searchable; and further diffs build on the reloaded state
    expect((await s2.runQueryLocally(req("messages:search", { q: "edit 69" })))!.value).toContain("edit 69");
    srv.m("messages:send", { channel: "a", body: "after reload" });
    await s2.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), version++));
    await s2.close();
    open.splice(open.indexOf(s2), 1);
    const s3 = make(opts);
    await s3.load();
    expect((await s3.runQueryLocally(req("messages:list", { channel: "a" })))!.value).toEqual(srv.q("messages:list", { channel: "a" }));
  });
});

describe("row-diff log", () => {
  it("appends a few ids per change and rewrites the record when the log would outgrow it", async () => {
    const srv = engineServer();
    for (let i = 0; i < 50; i++) srv.m("messages:send", { channel: "a", body: `body ${i}` });
    const b = new MemoryBackend(schema);
    const s = memoryStorage({ schema, queries: offlineQueries, backend: b });
    await s.load();
    const key = `${SHARD}\u0000messages:list\u0000${stableStringify({ channel: "a" })}`;
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    const base = b.queries.get(key)!;
    expect(base.refs).toBe(true);
    expect((base.value as unknown[]).every((x) => Object.keys(x as object).join() === "_id,$row")).toBe(true);
    srv.m("messages:send", { channel: "a", body: "one more" });
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 2));
    expect(b.queries.get(key)).toBe(base); // not rewritten
    const [entry] = b.log.get(key)!;
    const diff = entry!.diff as RowDiff;
    expect(diff.remove).toEqual([]);
    expect(diff.upsert).toHaveLength(1);
    expect(Object.keys(diff.upsert[0]!)).toEqual(["_id", "$row"]);
    expect(entry!.add).toHaveLength(1);
    // an edit changes the row only: the skeleton is the same, the entry is empty
    const first = (srv.q("messages:list", { channel: "a" }) as Doc[])[0]!._id;
    srv.m("messages:edit", { id: first, body: "edited" });
    await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 3));
    expect(b.log.get(key)!.at(-1)!.diff).toEqual({ remove: [], upsert: [] });
    // reshuffles are logged as `order` lists until the log would outgrow the base: then compaction
    let value = srv.q("messages:list", { channel: "a" }) as Doc[];
    let n = 0;
    for (let v = 4; b.queries.get(key) === base && n < 5; v++, n++) await s.applyPatch(upd("messages:list", { channel: "a" }, (value = [...value].reverse()), v));
    expect(n).toBeGreaterThan(1);
    expect(b.queries.get(key)).not.toBe(base);
    expect(b.log.get(key)).toBeUndefined();
    await s.close();
  });
});

describe("offline client: local results follow the replica", () => {
  it("an offline subscription re-renders when another client's server values change the rows it read", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "first" });
    const store = memoryStorage({ schema, queries: offlineQueries });
    // The adapter is shared (as tabs share the leader's store); only `online` talks to the server.
    const shared = Object.assign(Object.create(store), { close: () => {} }) as OfflineStore;
    const mk = (online: boolean) =>
      new EmberClient({
        url: "https://ember.test",
        WebSocket: srv.fake.WebSocket,
        fetch: srv.fake.fetch,
        connectivity: { isOnline: () => online, subscribe: () => () => {} },
        defaultShard: SHARD,
        heartbeat: false,
        storage: shared,
      });
    const online = mk(true);
    const offline = mk(false);
    const seen: QuerySnapshot<Doc[]>[] = [];
    offline.subscribe(unsafeRef("messages:latest"), { channel: "a", n: 2 }, {}, (s: QuerySnapshot<any>) => seen.push(s));
    const live: QuerySnapshot<Doc[]>[] = [];
    online.subscribe(unsafeRef("messages:list"), { channel: "a" }, {}, (s: QuerySnapshot<any>) => live.push(s));
    await until(() => seen.at(-1)?.status === "success" && bodies(seen.at(-1)!.value).length === 1);
    expect(seen.at(-1)).toMatchObject({ source: "local" });

    await online.mutation(unsafeRef("messages:send"), { channel: "a", body: "second" });
    await until(() => bodies(seen.at(-1)?.value ?? []).length === 2);
    expect(bodies(seen.at(-1)!.value)).toEqual(["second", "first"]);
    expect(seen.at(-1)).toMatchObject({ source: "local" });
    online.close();
    offline.close();
    await store.close();
  });
});
