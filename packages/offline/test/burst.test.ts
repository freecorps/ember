// The store's write path (PR 3B-1): a burst of updates is one commit per shard, a failed commit rolls the whole
// burst back in memory, log entries keep their size, local runs equal to the cached value are resumable, and point
// reads of known rows skip the backend.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmberClient, stableStringify, unsafeRef, type QuerySnapshot } from "@freecorps/ember-client";
import type { Doc } from "@freecorps/ember-server";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { backend, BACKENDS } from "./backends.ts";
import { MemoryBackend, memoryStorage, type Commit } from "../src/index.ts";

const SHARD = "org:acme";
const upd = (fn: string, args: Record<string, unknown>, value: unknown, version = 1, extra: object = {}) => ({
  shard: SHARD,
  fn,
  args,
  argsJson: stableStringify(args),
  value,
  version,
  ...extra,
});
const req = (fn: string, args: Record<string, unknown> = {}, identity: { subject: string } | null = null) => ({ shard: SHARD, fn, args, argsJson: stableStringify(args), identity });
const bodies = (x: unknown) => (x as Doc[]).map((d) => (d as unknown as { body: string }).body);
const until = (cond: () => unknown, timeout = 3000) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout, interval: 2 },
  );

/** A memory backend that counts commits and can be told to fail the next ones. */
class CountingBackend extends MemoryBackend {
  commits: Array<{ shard: string; c: Commit }> = [];
  fail = 0;
  override commit(shard: string, c: Commit) {
    if (this.fail > 0) {
      this.fail--;
      throw new Error("disk full");
    }
    this.commits.push({ shard, c });
    super.commit(shard, c);
  }
}

function seeded(n: number, channels = ["a", "b", "c"]) {
  const srv = engineServer();
  for (let i = 0; i < n; i++) srv.m("messages:send", { channel: channels[i % channels.length]!, body: `m${i}` });
  return srv;
}

describe("bursts of updates", () => {
  it("updates handed over together are one commit per shard, in order, and read back after a reload", async () => {
    const srv = seeded(9);
    const be = new CountingBackend();
    const s = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s.load();
    be.commits = [];
    const lists = ["a", "b", "c"].map((channel) => srv.q("messages:list", { channel }));
    const p = [
      s.applyPatch(upd("messages:list", { channel: "a" }, lists[0], 1)),
      s.applyPatch(upd("messages:list", { channel: "b" }, lists[1], 1)),
      s.applyPatch(upd("messages:count", {}, 9, 1)),
      // the same query twice in one burst: the later value wins
      s.applyPatch(upd("messages:list", { channel: "c" }, [], 1)),
      s.applyPatch(upd("messages:list", { channel: "c" }, lists[2], 2)),
      s.applyPatch(upd("messages:list", { channel: "x" }, [], 1, { shard: "org:other" })),
    ];
    await Promise.all(p);
    expect(be.commits.map((x) => x.shard)).toEqual([SHARD, "org:other"]);
    // every row once, as its last write
    const rows = be.commits[0]!.c.upsert!.map((r) => r.doc._id);
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows.length).toBe(9);
    await s.close();
    const s2 = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s2.load();
    for (const [i, channel] of ["a", "b", "c"].entries()) expect((await s2.runQueryLocally(req("messages:list", { channel })))!.value).toEqual(lists[i]);
    expect(await s2.runQueryLocally(req("messages:count"))).toEqual({ value: 9, source: "cache" });
  });

  it("a later write of a row in the burst replaces the earlier one (an upsert then a delete is a delete)", async () => {
    const srv = seeded(2, ["a"]);
    const be = new CountingBackend();
    const s = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s.load();
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    await s.applyPatch(upd("messages:list", { channel: "a" }, list, 1));
    be.commits = [];
    const edited = [{ ...list[0]!, body: "edited" }, list[1]!];
    await Promise.all([s.applyPatch(upd("messages:list", { channel: "a" }, edited, 2)), s.applyPatch(upd("messages:list", { channel: "a" }, [list[1]!], 3))]);
    expect(be.commits).toHaveLength(1);
    expect(be.commits[0]!.c.upsert ?? []).toEqual([]);
    expect(be.commits[0]!.c.delete).toEqual([{ table: "messages", id: list[0]!._id }]);
    expect(be.rows.get(SHARD)!.get("messages")!.has(list[0]!._id)).toBe(false);
    expect(bodies((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["m1"]);
  });

  it("a commit that fails rejects the whole burst and leaves memory as storage: nothing half-applied", async () => {
    const srv = seeded(4, ["a", "b"]);
    const be = new CountingBackend();
    const s = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s.load();
    const a = srv.q("messages:list", { channel: "a" }) as Doc[];
    const b = srv.q("messages:list", { channel: "b" }) as Doc[];
    await s.applyPatch(upd("messages:list", { channel: "a" }, a, 1));
    be.fail = 1;
    const burst = [
      s.applyPatch(upd("messages:list", { channel: "a" }, [], 2)),
      s.applyPatch(upd("messages:list", { channel: "b" }, b, 2)),
      s.applyPatch(upd("messages:count", {}, 4, 2)),
    ];
    for (const p of burst) await expect(p).rejects.toThrow("disk full");
    // As before the burst: channel a still owns its rows (they were not deleted), b and count are not stored.
    expect(bodies((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["m0", "m2"]);
    expect((await s.runQueryLocally(req("messages:list", { channel: "b" })))!.value).toEqual([]);
    expect(await s.runQueryLocally(req("messages:count"))).toBeUndefined();
    // The next burst works from that state: dropping a's rows deletes them now (refcounts were rolled back).
    await s.applyPatch(upd("messages:list", { channel: "a" }, [], 3));
    expect(be.rows.get(SHARD)!.get("messages")!.size).toBe(0);
    await s.applyPatch(upd("messages:list", { channel: "b" }, b, 3));
    expect(be.rows.get(SHARD)!.get("messages")!.size).toBe(2);
  });

  it("a store that cannot open rejects the burst (and the next one) instead of leaving it pending", async () => {
    const be = new CountingBackend();
    be.open = async () => {
      throw new Error("cannot open");
    };
    const s = memoryStorage({ schema, queries: offlineQueries, backend: be });
    const first = [s.applyPatch(upd("messages:count", {}, 1, 1)), s.applyPatch(upd("messages:count", {}, 2, 2))];
    for (const p of first) await expect(p).rejects.toThrow("cannot open");
    await expect(s.applyPatch(upd("messages:count", {}, 3, 3))).rejects.toThrow("cannot open");
  });

  it("an update queued after another operation is not pulled ahead of it", async () => {
    const srv = seeded(2, ["a"]);
    const s = memoryStorage({ schema, queries: offlineQueries });
    await s.load();
    const list = srv.q("messages:list", { channel: "a" });
    const p1 = s.applyPatch(upd("messages:list", { channel: "a" }, list, 1));
    const cleared = s.clear();
    const p2 = s.applyPatch(upd("messages:count", {}, 2, 1));
    await Promise.all([p1, cleared, p2]);
    expect((await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value).toEqual([]);
    expect(await s.runQueryLocally(req("messages:count"))).toEqual({ value: 2, source: "cache" });
  });

  it.each(BACKENDS)("%s: a burst round-trips through the backend", async (kind) => {
    const srv = seeded(6, ["a", "b"]);
    const b = backend(kind);
    try {
      const s = b.make({ schema, queries: offlineQueries });
      await s.load();
      const a1 = srv.q("messages:list", { channel: "a" }) as Doc[];
      const b1 = srv.q("messages:list", { channel: "b" }) as Doc[];
      await Promise.all([s.applyPatch(upd("messages:list", { channel: "a" }, a1, 1)), s.applyPatch(upd("messages:list", { channel: "b" }, b1, 1))]);
      // a second burst: an edit (appended to a's log), a row leaving b, both in one commit
      await Promise.all([
        s.applyPatch(upd("messages:list", { channel: "a" }, [{ ...a1[0]!, body: "edited" }, ...a1.slice(1)], 2)),
        s.applyPatch(upd("messages:list", { channel: "b" }, b1.slice(1), 2)),
      ]);
      await s.close();
      const s2 = b.make({ schema, queries: offlineQueries });
      await s2.load();
      expect(bodies((await s2.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["edited", "m2", "m4"]);
      expect(bodies((await s2.runQueryLocally(req("messages:list", { channel: "b" })))!.value)).toEqual(["m3", "m5"]);
      await s2.close();
    } finally {
      b.cleanup();
    }
  });
});

describe("the record log", () => {
  it("entries store their encoded size; entries written before it still bound the log on open", async () => {
    const srv = seeded(20, ["a"]);
    const be = new CountingBackend();
    const s = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s.load();
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    await s.applyPatch(upd("messages:list", { channel: "a" }, list, 1));
    await s.applyPatch(upd("messages:list", { channel: "a" }, [{ ...list[0]!, body: "x" }, ...list.slice(1)], 2));
    const [entry] = [...be.log.values()].flat();
    expect(entry!.bytes).toBe(JSON.stringify(entry!.diff).length);
    await s.close();
    // An entry from the previous version (no `bytes`): opening computes it, and the record keeps appending.
    delete entry!.bytes;
    const s2 = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s2.load();
    await s2.applyPatch(upd("messages:list", { channel: "a" }, [{ ...list[0]!, body: "y" }, ...list.slice(1)], 3));
    expect([...be.log.values()].flat().map((e) => e.seq)).toEqual([1, 2]);
    expect(bodies((await s2.runQueryLocally(req("messages:list", { channel: "a" })))!.value)[0]).toBe("y");
  });
});

describe("resuming from a local run", () => {
  it("a local result equal to its owner's cached value carries version/epoch/ik; another identity or a moved replica does not", async () => {
    const srv = seeded(3, ["a"]);
    const s = memoryStorage({ schema, queries: offlineQueries });
    await s.load();
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    const ana = { subject: "ana" };
    await s.applyPatch(upd("messages:list", { channel: "a" }, list, 5, { epoch: "E", ik: "tag", identity: ana }));
    expect(await s.runQueryLocally(req("messages:list", { channel: "a" }, ana))).toEqual({ value: list, source: "local", version: 5, epoch: "E", ik: "tag" });
    expect(await s.runQueryLocally(req("messages:list", { channel: "a" }, { subject: "bob" }))).toEqual({ value: list, source: "local" });
    // Another query brings a newer version of one of its rows: the local run is no longer that server value.
    const edited = { ...list[0]!, body: "newer" };
    await s.applyPatch(upd("messages:latest", { channel: "a", n: 1 }, [edited], 6, { epoch: "E", ik: "tag", identity: ana }));
    const r = await s.runQueryLocally(req("messages:list", { channel: "a" }, ana));
    expect(r).toEqual({ value: [edited, ...list.slice(1)], source: "local" });
  });

  it("a watched local result becomes resumable when its record catches up", async () => {
    const srv = seeded(2, ["a"]);
    const s = memoryStorage({ schema, queries: offlineQueries });
    await s.load();
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    const ana = { subject: "ana" };
    await s.applyPatch(upd("messages:latest", { channel: "a", n: 5 }, list, 1, { epoch: "E", ik: "t", identity: ana }));
    const seen: unknown[] = [];
    const off = s.watchQueryLocally(req("messages:list", { channel: "a" }, ana), (r) => seen.push(r));
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ value: list, source: "local" });
    await s.applyPatch(upd("messages:list", { channel: "a" }, list, 2, { epoch: "E", ik: "t", identity: ana }));
    await until(() => seen.length === 2);
    expect(seen[1]).toEqual({ value: list, source: "local", version: 2, epoch: "E", ik: "t" });
    off();
  });

  it("EmberClient resumes a registered offline query from its local run on reopen: unchanged, nothing downloaded", async () => {
    const srv = engineServer({ ident: true });
    srv.m("messages:send", { channel: "a", body: "one" });
    srv.m("messages:send", { channel: "a", body: "two" });
    const b = backend("sqlite");
    try {
      const open = () =>
        new EmberClient({
          url: "https://ember.test",
          WebSocket: srv.fake.WebSocket,
          fetch: srv.fake.fetch,
          connectivity: null,
          defaultShard: SHARD,
          heartbeat: false,
          httpFirst: false,
          storage: b.make({ schema, queries: offlineQueries }),
        });
      const c1 = open();
      const s1: QuerySnapshot[] = [];
      c1.subscribe(unsafeRef("messages:list"), { channel: "a" }, {}, (s) => s1.push(s));
      await until(() => s1.some((s) => s.status === "success" && !s.source));
      await c1.flushStorage();
      c1.close();
      const c2 = open();
      const s2: QuerySnapshot[] = [];
      c2.subscribe(unsafeRef("messages:list"), { channel: "a" }, {}, (s) => s2.push(s));
      await until(() => s2.some((s) => s.status === "success" && !s.source));
      expect(s2[0]).toMatchObject({ source: "local" });
      expect(bodies(s2.at(-1)!.value)).toEqual(["one", "two"]);
      const ws = srv.fake.open(SHARD).at(-1)!;
      const sub = ws.sent.find((m) => m !== "ping" && m.t === "sub") as { resume?: unknown };
      expect(sub.resume).toMatchObject({ version: expect.any(Number), epoch: expect.any(String), ik: expect.any(String) });
      expect(ws.received.filter((m) => m !== "pong" && m.t === "snap").map((m) => (m as { unchanged?: boolean }).unchanged)).toEqual([true]);
      await c2.flushStorage();
      c2.close();
    } finally {
      b.cleanup();
    }
  });
});

describe("point reads of known rows", () => {
  it("ctx.db.get of a row the store wrote is answered from memory, not the backend", async () => {
    const srv = seeded(2, ["a", "b"]);
    const be = new CountingBackend();
    let gets = 0;
    const reader = be.reader.bind(be);
    be.reader = (shard: string) => {
      const r = reader(shard);
      return { ...r, get: (t: string, id: string) => (gets++, r.get(t, id)) };
    };
    const s = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s.load();
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    await s.applyPatch(upd("messages:list", { channel: "a" }, list, 1));
    expect((await s.runQueryLocally(req("messages:one", { id: list[0]!._id })))!.value).toEqual(list[0]);
    expect(gets).toBe(0);
    // A row it never saw still goes to the backend (and reads null).
    const other = (srv.q("messages:list", { channel: "b" }) as Doc[])[0]!;
    expect(await s.runQueryLocally(req("messages:one", { id: other._id }))).toEqual({ value: null, source: "local" });
    expect(gets).toBe(1);
  });
});
