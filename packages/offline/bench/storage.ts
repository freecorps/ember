// Measurements for PR 3B-1 (not run in CI). Before = the previous behaviour, reproduced in the same process:
//   burst commits    20 queries changed by one server frame: one applyPatch awaited at a time (one commit each, as
//                    before) vs handed over together (one commit per shard); SQLite transactions, IndexedDB
//                    readwrite transactions, wall time
//   bridge           bytes posted per patch over RemoteStorage (whole value vs RowDiff of the changed rows)
//
//   bun --conditions=@freecorps/ember-source packages/offline/bench/storage.ts
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MemoryPendingStorage, stableStringify, type QueryUpdate } from "@freecorps/ember-client";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import type { Doc, SqlDriver } from "@freecorps/ember-server";
import { engineServer, offlineQueries, schema } from "../test/app.ts";
import { sqliteStorage } from "../src/sqlite.ts";
import { indexedDbStorage } from "../src/indexeddb.ts";
import { RemoteStorage, serveStorage, type Endpoint } from "../src/remote.ts";
import type { OfflineStore } from "../src/store.ts";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const row = (i: number, tag: string) => ({ _id: `id${i}`, _creationTime: 1_700_000_000_000 + i, body: `message ${i} ${tag} "quoted" ${"lorem ipsum ".repeat(9)}` });

// ------------------------------------------------------------------------------------------------ burst commits
async function bursts(kind: "sqlite" | "indexeddb") {
  const srv = engineServer();
  const CH = 20;
  for (let i = 0; i < CH * 25; i++) srv.m("messages:send", { channel: `c${i % CH}`, body: `m${i} ${"x".repeat(80)}` });
  const lists = Array.from({ length: CH }, (_, c) => srv.q("messages:list", { channel: `c${c}` }) as Doc[]);
  const counter = { tx: 0 };
  const dir = mkdtempSync(join(tmpdir(), "ember-bench-"));
  let make: () => OfflineStore;
  if (kind === "sqlite") {
    const open = (n: string): SqlDriver & { close?(): void } => {
      const d = createNodeSqliteDriver(join(dir, `${n}.db`));
      return { exec: (sql, ...p) => d.exec(sql, ...p), transaction: (f) => (counter.tx++, d.transaction(f)), close: () => d.close?.() };
    };
    make = () => sqliteStorage({ schema, queries: offlineQueries, name: "b", open });
  } else {
    const idb = new IDBFactory();
    const proto = Object.getPrototypeOf((await new Promise<IDBDatabase>((r) => (idb.open("probe").onsuccess = (e) => r((e.target as IDBOpenDBRequest).result))))) as IDBDatabase;
    const orig = proto.transaction;
    proto.transaction = function (this: IDBDatabase, names: string | string[], mode?: IDBTransactionMode) {
      if (mode === "readwrite") counter.tx++;
      return orig.call(this, names, mode);
    } as IDBDatabase["transaction"];
    make = () => indexedDbStorage({ schema, queries: offlineQueries, name: `b${Math.random()}`, indexedDB: idb, IDBKeyRange });
  }
  const upd = (c: number, value: unknown, version: number): QueryUpdate => ({ shard: "s", fn: "messages:list", args: { channel: `c${c}` }, argsJson: stableStringify({ channel: `c${c}` }), value, version });
  const run = async (together: boolean) => {
    const s = make();
    await s.load();
    await Promise.all(lists.map((l, c) => s.applyPatch(upd(c, l, 1))));
    counter.tx = 0;
    const t0 = performance.now();
    for (let round = 0; round < 10; round++) {
      const next = lists.map((l, c) => upd(c, l.map((d, i) => (i === round ? { ...d, body: `edited ${round}` } : d)), 2 + round));
      if (together) await Promise.all(next.map((u) => s.applyPatch(u)));
      else for (const u of next) await s.applyPatch(u);
    }
    const ms = performance.now() - t0;
    await s.close();
    return { tx: counter.tx / 10, ms: ms / 10 };
  };
  const before = await run(false);
  const after = await run(true);
  rmSync(dir, { recursive: true, force: true });
  console.log(`burst of ${CH} changed queries (${kind}): ${before.tx} → ${after.tx} transactions, ${before.ms.toFixed(1)} → ${after.ms.toFixed(1)} ms per burst`);
}
await bursts("sqlite");
await bursts("indexeddb");

// ------------------------------------------------------------------------------------------------ bridge bytes
{
  const listeners = new Map<object, Set<(e: { data: unknown }) => void>>();
  const posted: Array<{ op?: string; bytes: number; cloneMs: number }> = [];
  const end = (): Endpoint => {
    const me = {};
    listeners.set(me, new Set());
    return {
      postMessage(data) {
        const t0 = performance.now();
        const copy = structuredClone(data);
        posted.push({ op: (data as { op?: string }).op, bytes: JSON.stringify(data).length, cloneMs: performance.now() - t0 });
        for (const [k, ls] of listeners) if (k !== me) for (const l of ls) queueMicrotask(() => l({ data: copy }));
      },
      addEventListener: (_t, l) => void listeners.get(me)!.add(l),
      removeEventListener: (_t, l) => void listeners.get(me)!.delete(l),
    };
  };
  serveStorage({ load: async () => ({ identity: null }), applyPatch: async () => {}, runQueryLocally: async () => undefined, persistPending: new MemoryPendingStorage() }, end());
  const remote = new RemoteStorage(end());
  await remote.load();
  let value = Array.from({ length: 500 }, (_, i) => row(i, "v0"));
  const u = (v: unknown, version: number): QueryUpdate => ({ shard: "s", fn: "messages:list", args: {}, argsJson: "{}", value: v, version, epoch: "E" });
  await remote.applyPatch(u(value, 1));
  for (let v = 2; v < 22; v++) {
    value = value.map((d, i) => (i === v ? { ...d, body: `edited ${v}` } : d));
    await remote.applyPatch(u(value, v));
  }
  const whole = posted.find((p) => p.op === "applyPatch")!;
  const diffs = posted.filter((p) => p.op === "applyDiff");
  console.log(
    `bridge per patch (500 rows, 1 changed): whole ${kib(whole.bytes)} (${whole.cloneMs.toFixed(2)} ms clone) → diff ${median(diffs.map((d) => d.bytes))} B (${median(diffs.map((d) => d.cloneMs)).toFixed(3)} ms clone)`,
  );
  remote.close();
}
