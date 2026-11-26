// Measurements for PR 4b of 0.10 (not run in CI). Run once on the base commit and once on this tree:
//   boot             a SQLite store with 20 shards (5 queries of 50 rows each): databases opened and ms until `load()`
//                    and the pending queue are ready (what the client's `hello` waits for), then until the first
//                    local result of one shard
//   empty shards     shard databases left on disk after `clear()`
//   pending burst    40 mutations queued then settled at once: backend write transactions (SQLite, IndexedDB,
//                    TinyBase persister saves) and ms
//   same value       the same value handed over again (N tabs): ms per skipped update, by the same objects (the
//                    client keeps unchanged rows) and by a structured clone (another tab's)
//   bridge           messages posted for a burst of 20 updates; bytes Worker→Page per watched result when 1 of 500
//                    rows changes
//
//   bun --conditions=@freecorps/ember-source packages/offline/bench/cold.ts
import { join } from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { stableStringify, type PendingMutationRecord, type QueryUpdate } from "@freecorps/ember-client";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import type { Doc, SqlDriver } from "@freecorps/ember-server";
import { createStore } from "tinybase";
import { engineServer, offlineQueries, schema } from "../test/app.ts";
import { sqliteStorage } from "../src/sqlite.ts";
import { indexedDbStorage } from "../src/indexeddb.ts";
import { tinybaseStorage, type TinyStore } from "../src/tinybase.ts";
import { memoryStorage } from "../src/memory.ts";
import { RemoteStorage, serveStorage, type Endpoint } from "../src/remote.ts";
import type { OfflineStore } from "../src/store.ts";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const upd = (shard: string, channel: string, value: unknown, version: number): QueryUpdate => ({
  shard,
  fn: "messages:list",
  args: { channel },
  argsJson: stableStringify({ channel }),
  value,
  version,
  epoch: "E",
  identity: { subject: "u1" },
});

// ------------------------------------------------------------------------------------------------ boot with N shards
{
  const SHARDS = 20;
  const srv = engineServer();
  for (let i = 0; i < 5 * 50; i++) srv.m("messages:send", { channel: `c${i % 5}`, body: `m${i} ${"x".repeat(80)}` });
  const lists = Array.from({ length: 5 }, (_, c) => srv.q("messages:list", { channel: `c${c}` }) as Doc[]);
  const dir = mkdtempSync(join(tmpdir(), "ember-cold-"));
  let opened = 0;
  const open = (n: string): SqlDriver & { close?(): void } => {
    opened++;
    return createNodeSqliteDriver(join(dir, `${n}.db`)) as SqlDriver & { close?(): void };
  };
  const make = () => sqliteStorage({ schema, queries: offlineQueries, name: "b", open, maxOpenShards: 32 });
  {
    const s = make();
    await s.load();
    for (let k = 0; k < SHARDS; k++) await Promise.all(lists.map((l, c) => s.applyPatch(upd(`org:${k}`, `c${c}`, l, 1))));
    await s.close();
  }
  const boots: number[] = [];
  const firsts: number[] = [];
  let dbs = 0;
  for (let round = 0; round < 7; round++) {
    opened = 0;
    const t0 = performance.now();
    const s = make();
    await s.load();
    await s.persistPending.getClientId();
    await s.persistPending.load();
    boots.push(performance.now() - t0);
    dbs = opened;
    await s.runQueryLocally({ shard: "org:3", fn: "messages:list", args: { channel: "c1" }, argsJson: stableStringify({ channel: "c1" }), identity: { subject: "u1" } });
    firsts.push(performance.now() - t0);
    await s.close();
  }
  console.log(`boot, ${SHARDS} shards × 5 queries × 50 rows (sqlite): ${dbs} databases opened before hello, ${median(boots).toFixed(1)} ms until hello can go, ${median(firsts).toFixed(1)} ms until the first local result`);
  {
    const s = make();
    await s.load();
    await s.clear();
    await s.close();
  }
  console.log(`after clear(): ${readdirSync(dir).filter((f) => f.endsWith(".db")).length} database files on disk (main + shards)`);
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------------------ pending burst
const record = (i: number): PendingMutationRecord => ({ mid: `m${i}`, fn: "messages:send", args: { channel: "c", body: `b${i}` }, shard: "main", identity: null }) as unknown as PendingMutationRecord;
async function pendingBurst(kind: "sqlite" | "indexeddb" | "tinybase") {
  const N = 40;
  const counter = { tx: 0 };
  const dir = mkdtempSync(join(tmpdir(), "ember-pend-"));
  let s: OfflineStore;
  if (kind === "sqlite") {
    const open = (n: string): SqlDriver & { close?(): void } => {
      const d = createNodeSqliteDriver(join(dir, `${n}.db`));
      // Each write outside a transaction is a transaction (and a sync) of its own.
      let depth = 0;
      return {
        exec: (sql, ...p) => {
          if (depth === 0 && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) counter.tx++;
          return d.exec(sql, ...p);
        },
        transaction: (f) => {
          if (depth === 0) counter.tx++;
          depth++;
          try {
            return d.transaction(f);
          } finally {
            depth--;
          }
        },
        close: () => d.close?.(),
      };
    };
    s = sqliteStorage({ schema, queries: offlineQueries, name: "p", open });
  } else if (kind === "indexeddb") {
    const idb = new IDBFactory();
    const proto = Object.getPrototypeOf(await new Promise<IDBDatabase>((r) => (idb.open("probe").onsuccess = (e) => r((e.target as IDBOpenDBRequest).result)))) as IDBDatabase;
    const orig = proto.transaction;
    proto.transaction = function (this: IDBDatabase, names: string | string[], mode?: IDBTransactionMode) {
      if (mode === "readwrite") counter.tx++;
      return orig.call(this, names, mode);
    } as IDBDatabase["transaction"];
    s = indexedDbStorage({ schema, queries: offlineQueries, name: `p${Math.random()}`, indexedDB: idb, IDBKeyRange });
  } else {
    const store = createStore() as unknown as TinyStore;
    s = tinybaseStorage({ schema, queries: offlineQueries, store, persister: { load: async () => {}, save: async () => void counter.tx++ } });
  }
  await s.load();
  const times: number[] = [];
  let txs = 0;
  for (let round = 0; round < 5; round++) {
    counter.tx = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: N }, (_, i) => s.persistPending.put(record(round * N + i))));
    await Promise.all(Array.from({ length: N }, (_, i) => s.persistPending.remove(`m${round * N + i}`)));
    times.push(performance.now() - t0);
    txs = counter.tx;
  }
  await s.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(`pending burst, ${N} put + ${N} remove (${kind}): ${txs} write transactions, ${median(times).toFixed(1)} ms`);
}
await pendingBurst("sqlite");
await pendingBurst("indexeddb");
await pendingBurst("tinybase");

// ------------------------------------------------------------------------------------------------ same value again
{
  const srv = engineServer();
  for (let i = 0; i < 200; i++) srv.m("messages:send", { channel: "c", body: `m${i} ${"lorem ipsum ".repeat(8)}` });
  const list = srv.q("messages:list", { channel: "c" }) as Doc[];
  const s = memoryStorage({ schema, queries: offlineQueries });
  await s.load();
  await s.applyPatch(upd("s", "c", list, 1));
  const N = 400;
  const time = async (value: () => unknown) => {
    const xs: number[] = [];
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      for (let i = 0; i < N; i++) await s.applyPatch(upd("s", "c", value(), 1));
      xs.push(((performance.now() - t0) / N) * 1000);
    }
    return median(xs);
  };
  const same = await time(() => [...list]);
  const clone = await time(() => structuredClone(list));
  console.log(`same value again (200 rows): ${same.toFixed(1)} µs per update (the client's objects), ${clone.toFixed(1)} µs (a structured clone)`);
}

// ------------------------------------------------------------------------------------------------ bridge
{
  const listeners = new Map<object, Set<(e: { data: unknown }) => void>>();
  const posted: Array<{ dir: "up" | "down"; k: string; bytes: number }> = [];
  const end = (dir: "up" | "down"): Endpoint => {
    const me = {};
    listeners.set(me, new Set());
    return {
      postMessage(data) {
        const copy = structuredClone(data);
        posted.push({ dir, k: (data as { k: string }).k, bytes: JSON.stringify(data, (_k, x) => (typeof x === "bigint" ? String(x) : x)).length });
        for (const [k, ls] of listeners) if (k !== me) for (const l of ls) queueMicrotask(() => l({ data: copy }));
      },
      addEventListener: (_t, l) => void listeners.get(me)!.add(l),
      removeEventListener: (_t, l) => void listeners.get(me)!.delete(l),
    };
  };
  const srv = engineServer();
  for (let i = 0; i < 500; i++) srv.m("messages:send", { channel: "c", body: `m${i} ${"lorem ipsum ".repeat(8)}` });
  for (let c = 0; c < 20; c++) srv.m("messages:send", { channel: `d${c}`, body: `x` });
  const store = memoryStorage({ schema, queries: offlineQueries });
  serveStorage(store, end("down"));
  const remote = new RemoteStorage(end("up"));
  await remote.load();
  let list = srv.q("messages:list", { channel: "c" }) as Doc[];
  await remote.applyPatch(upd("s", "c", list, 1));
  const results: unknown[] = [];
  const off = remote.watchQueryLocally({ shard: "s", fn: "messages:list", args: { channel: "c" }, argsJson: stableStringify({ channel: "c" }), identity: { subject: "u1" } }, (r) => results.push(r));
  while (!results.length) await new Promise((r) => setTimeout(r, 1));
  const watchBytes: number[] = [];
  for (let v = 2; v < 12; v++) {
    list = list.map((d, i) => (i === v ? { ...d, body: `edited ${v}` } : d));
    const before = posted.length;
    const n = results.length;
    await remote.applyPatch(upd("s", "c", list, v));
    while (results.length === n) await new Promise((r) => setTimeout(r, 1));
    watchBytes.push(posted.slice(before).filter((p) => p.dir === "down" && p.k !== "res").reduce((a, p) => a + p.bytes, 0));
  }
  off();
  const lists = Array.from({ length: 20 }, (_, c) => srv.q("messages:list", { channel: `d${c}` }) as Doc[]);
  const before = posted.length;
  await Promise.all(lists.map((l, c) => remote.applyPatch(upd("s", `d${c}`, l, 1))));
  const burst = posted.slice(before);
  console.log(
    `bridge: a burst of 20 updates → ${burst.filter((p) => p.dir === "up").length} messages Page→Worker, ${burst.filter((p) => p.dir === "down").length} Worker→Page; watched result (500 rows, 1 changed) → ${median(watchBytes)} B Worker→Page`,
  );
  remote.close();
}
