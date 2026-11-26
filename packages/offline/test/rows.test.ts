// The rows a store knows decoded (store.ts `RowCache`): filled by its writes and by what local runs read, bounded
// (`maxCachedRows`), and always what storage holds. And IndexedDB's descending scans in one request (`getAllRecords`)
// with the cursor fallback.
import { describe, expect, it } from "vitest";
import { IDBFactory, IDBIndex, IDBKeyRange } from "fake-indexeddb";
import { stableStringify, type QueryUpdate } from "@freecorps/ember-client";
import type { Doc } from "@freecorps/ember-server";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { indexedDbStorage } from "../src/indexeddb.ts";
import { MemoryBackend, memoryStorage, type Commit } from "../src/index.ts";

const SHARD = "org:acme";
const upd = (fn: string, args: Record<string, unknown>, value: unknown, version: number): QueryUpdate => ({ shard: SHARD, fn, args, argsJson: stableStringify(args), value, version, epoch: "E", identity: null });
const req = (fn: string, args: Record<string, unknown>) => ({ shard: SHARD, fn, args, argsJson: stableStringify(args), identity: null });

/** A fresh IndexedDB database, reopened by each `make()`. */
function idbStore() {
  const idb = new IDBFactory();
  const name = `rows-${Math.random()}`;
  const make = () => indexedDbStorage({ schema, queries: offlineQueries, name, indexedDB: idb, IDBKeyRange });
  return { make };
}

describe("rows known decoded", () => {
  it("IndexedDB: a re-run reads by id from memory (no round trip) and gets the same objects", async () => {
    const srv = engineServer();
    for (let i = 0; i < 6; i++) srv.m("messages:send", { channel: "a", body: `m${i}` });
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    const { make } = idbStore();
    const s1 = make();
    await s1.load();
    await s1.applyPatch(upd("messages:list", { channel: "a" }, list, 1));
    await s1.close();
    // A fresh store (a reload): nothing known until read.
    const s = make();
    await s.load();
    const db = (s as unknown as { backend: { db: IDBDatabase } }).backend.db;
    let reads = 0;
    const orig = db.transaction.bind(db);
    db.transaction = ((names: string | string[], mode?: IDBTransactionMode) => {
      if (mode !== "readwrite") reads++;
      return orig(names, mode);
    }) as IDBDatabase["transaction"];
    const first = (await s.runQueryLocally(req("messages:latest", { channel: "a", n: 3 })))!.value as Doc[];
    expect(first.map((d) => d.body)).toEqual(["m5", "m4", "m3"]);
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    const one = (await s.runQueryLocally(req("messages:one", { id: first[1]!._id })))!.value;
    expect(reads).toBe(0);
    expect(one).toBe(first[1]);
    const again = (await s.runQueryLocally(req("messages:latest", { channel: "a", n: 3 })))!.value as Doc[];
    again.forEach((d, i) => expect(d).toBe(first[i]));
    await s.close();
  });

  it("a row read back after a restart is not rewritten when the server sends it unchanged", async () => {
    const srv = engineServer();
    for (let i = 0; i < 5; i++) srv.m("messages:send", { channel: "a", body: `m${i}` });
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    const be = new MemoryBackend(schema);
    const s1 = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s1.load();
    await s1.applyPatch(upd("messages:list", { channel: "a" }, list, 1));
    await s1.close();
    const s2 = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s2.load();
    // The cold start shows the local result (reads every row), then the server's next value comes: one row changed.
    await s2.runQueryLocally(req("messages:list", { channel: "a" }));
    const commits: Commit[] = [];
    const commit = be.commit.bind(be);
    be.commit = (shard, c) => (commits.push(c), commit(shard, c));
    const next = structuredClone(list).map((d, i) => (i === 2 ? { ...d, body: "edited" } : d));
    await s2.applyPatch(upd("messages:list", { channel: "a" }, next, 2));
    expect(commits).toHaveLength(1);
    expect(commits[0]!.upsert!.map((u) => u.doc.body)).toEqual(["edited"]);
    await s2.close();
  });

  it("bounded: past maxCachedRows the oldest go, and what is still needed is read back", async () => {
    const srv = engineServer();
    for (let i = 0; i < 30; i++) srv.m("messages:send", { channel: `c${i % 3}`, body: `m${i}` });
    const be = new MemoryBackend(schema);
    const s = memoryStorage({ schema, queries: offlineQueries, backend: be, maxCachedRows: 4 });
    await s.load();
    for (let c = 0; c < 3; c++) await s.applyPatch(upd("messages:list", { channel: `c${c}` }, srv.q("messages:list", { channel: `c${c}` }), 1));
    const rows = (s as unknown as { rows: { m: Map<string, unknown> } }).rows.m;
    expect(rows.size).toBe(4);
    for (let c = 0; c < 3; c++) {
      const v = (await s.runQueryLocally(req("messages:list", { channel: `c${c}` })))!.value as Doc[];
      expect(v.map((d) => d.body)).toEqual((srv.q("messages:list", { channel: `c${c}` }) as Doc[]).map((d) => d.body));
      expect(rows.size).toBeLessThanOrEqual(4);
    }
    await s.close();
  });
});

describe("rows a burst staged", () => {
  it("are not evicted before their commit: a later read in the burst sees them, and the cache matches storage after", async () => {
    const srv = engineServer();
    for (let i = 0; i < 3; i++) srv.m("messages:send", { channel: "a", body: `m${i}` });
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    const be = new MemoryBackend(schema);
    const s1 = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s1.load();
    await s1.applyPatch(upd("messages:list", { channel: "a" }, list, 1));
    await s1.applyPatch(upd("messages:one", { id: list[0]!._id }, list[0], 1));
    await s1.close();
    // A restart with room for one row: nothing known, the records not materialized.
    const s = memoryStorage({ schema, queries: offlineQueries, backend: be, maxCachedRows: 1 });
    await s.load();
    // One burst: the list moves every row forward (row 0 staged, then rows 1 and 2), then the same `one` value comes
    // again (same version, fingerprint and owner): resolving the stored record reads row 0 — the staged one, not
    // storage's previous copy.
    const next = list.map((d) => ({ ...d, body: `${d.body}!` }));
    await Promise.all([s.applyPatch(upd("messages:list", { channel: "a" }, next, 2)), s.applyPatch(upd("messages:one", { id: list[0]!._id }, list[0], 1))]);
    const cached = (await s.runQueryLocally(req("messages:one", { id: list[0]!._id })))!.value as Doc;
    await s.close();
    const fresh = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await fresh.load();
    const stored = (await fresh.runQueryLocally(req("messages:one", { id: list[0]!._id })))!.value as Doc;
    await fresh.close();
    expect(cached.body).toBe(stored.body);
  });

  it("a burst whose commit fails leaves no staged row behind", async () => {
    const srv = engineServer();
    for (let i = 0; i < 3; i++) srv.m("messages:send", { channel: "a", body: `m${i}` });
    const list = srv.q("messages:list", { channel: "a" }) as Doc[];
    const be = new MemoryBackend(schema);
    const s = memoryStorage({ schema, queries: offlineQueries, backend: be, maxCachedRows: 2 });
    await s.load();
    await s.applyPatch(upd("messages:list", { channel: "a" }, list, 1));
    const commit = be.commit.bind(be);
    be.commit = async () => {
      throw new Error("disk full");
    };
    await expect(s.applyPatch(upd("messages:list", { channel: "a" }, list.map((d) => ({ ...d, body: "lost" })), 2))).rejects.toThrow("disk full");
    be.commit = commit;
    const rows = (s as unknown as { rows: { m: Map<string, unknown>; staged: Map<string, unknown> } }).rows;
    expect(rows.staged.size).toBe(0);
    expect(rows.m.size).toBeLessThanOrEqual(2);
    const v = (await s.runQueryLocally(req("messages:list", { channel: "a" })))!.value as Doc[];
    expect(v.map((d) => d.body)).toEqual(list.map((d) => d.body));
    await s.close();
  });
});

describe("IndexedDB descending scans", () => {
  const latest = async (withRecords: boolean) => {
    const proto = IDBIndex.prototype as unknown as { getAllRecords?: unknown };
    const had = proto.getAllRecords;
    if (!withRecords) delete proto.getAllRecords;
    try {
      const srv = engineServer();
      for (let i = 0; i < 8; i++) srv.m("messages:send", { channel: i % 2 ? "a" : "b", body: `m${i}` });
      const { make } = idbStore();
      const s = make();
      await s.load();
      await s.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 1));
      await s.applyPatch(upd("messages:list", { channel: "b" }, srv.q("messages:list", { channel: "b" }), 1));
      // A fresh store: the scan goes to IndexedDB.
      await s.close();
      const s2 = make();
      await s2.load();
      const out = ((await s2.runQueryLocally(req("messages:latest", { channel: "a", n: 3 })))!.value as Doc[]).map((d) => d.body);
      await s2.close();
      return out;
    } finally {
      if (!withRecords) proto.getAllRecords = had;
    }
  };
  it("getAllRecords({ direction: 'prev' }) where the browser has it, a cursor otherwise: the same rows", async () => {
    expect(typeof (IDBIndex.prototype as unknown as { getAllRecords?: unknown }).getAllRecords).toBe("function");
    expect(await latest(true)).toEqual(["m7", "m5", "m3"]);
    expect(await latest(false)).toEqual(["m7", "m5", "m3"]);
  });
});
