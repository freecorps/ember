// The SQLite backends' connection handling (PR 3B-1): shard databases open on demand under an LRU bound (migrated once
// per session), expo-sqlite reuses prepared statements and relaxes fsync only where the server can resend the data.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stableStringify } from "@freecorps/ember-client";
import type { SqlDriver } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { NodeExpoDatabase } from "./backends.ts";
import { sqliteStorage } from "../src/sqlite.ts";
import { expoSqliteStorage } from "../src/expo-sqlite.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ember-sqlite-"));
  dirs.push(d);
  return d;
};
const upd = (shard: string, value: unknown, version = 1) => ({ shard, fn: "messages:list", args: { channel: "a" }, argsJson: stableStringify({ channel: "a" }), value, version });
const req = (shard: string) => ({ shard, fn: "messages:list", args: { channel: "a" }, argsJson: stableStringify({ channel: "a" }), identity: null });

describe("shard databases under an LRU bound", () => {
  it("at most maxOpenShards stay open; an evicted shard reopens transparently without migrating again", async () => {
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "hi" });
    const list = srv.q("messages:list", { channel: "a" });
    const dir = tmp();
    const open = new Set<string>();
    let opens = 0;
    let migrations = 0;
    const openDb = (n: string): SqlDriver & { close(): void } => {
      const d = createNodeSqliteDriver(join(dir, `${n}.db`));
      opens++;
      open.add(n);
      return {
        exec: (sql, ...p) => {
          if (/_ember_local_queries" \("key" TEXT PRIMARY KEY/.test(sql)) migrations++;
          return d.exec(sql, ...p);
        },
        transaction: (f) => d.transaction(f),
        close: () => {
          open.delete(n);
          d.close?.();
        },
      };
    };
    const shards = ["s:1", "s:2", "s:3"];
    const s = sqliteStorage({ schema, queries: offlineQueries, name: "m", open: openDb, maxOpenShards: 2 });
    await s.load();
    for (const sh of shards) await s.applyPatch(upd(sh, list));
    expect(open.size).toBe(3); // main + 2 shards
    expect(migrations).toBe(3);
    for (const sh of shards) expect((await s.runQueryLocally(req(sh)))!.value).toEqual(list);
    expect(open.size).toBe(3);
    expect(migrations).toBe(3);
    expect(opens).toBeGreaterThan(4);
    await s.close();
    expect(open.size).toBe(0);
    // A reload reads every shard's records under the same bound.
    const s2 = sqliteStorage({ schema, queries: offlineQueries, name: "m", open: openDb, maxOpenShards: 1 });
    await s2.load();
    expect(open.size).toBe(2);
    for (const sh of shards) expect((await s2.runQueryLocally(req(sh)))!.value).toEqual(list);
    await s2.close();
  });
});

describe("expo-sqlite", () => {
  it("prepares each statement once, and only the replica databases use synchronous = NORMAL", async () => {
    const srv = engineServer();
    for (let i = 0; i < 5; i++) srv.m("messages:send", { channel: "a", body: `m${i}` });
    const list = srv.q("messages:list", { channel: "a" }) as Array<Record<string, unknown>>;
    const dir = tmp();
    const dbs = new Map<string, NodeExpoDatabase>();
    const s = expoSqliteStorage({
      schema,
      queries: offlineQueries,
      name: "app",
      openDatabaseSync: (n) => {
        const d = new NodeExpoDatabase(join(dir, n));
        dbs.set(n, d);
        return d;
      },
    });
    await s.load();
    await s.applyPatch(upd("s:1", list, 1));
    const before = NodeExpoDatabase.prepared;
    for (let v = 2; v < 12; v++) await s.applyPatch(upd("s:1", list.map((d, i) => (i === v % 5 ? { ...d, body: `e${v}` } : d)), v));
    // Ten more commits of the same shapes: no statement prepared again.
    expect(NodeExpoDatabase.prepared - before).toBeLessThan(3);
    expect(dbs.get("app.db")!.pragmas).toEqual(["PRAGMA journal_mode = WAL"]);
    const shardDb = [...dbs.entries()].find(([n]) => n !== "app.db")![1];
    expect(shardDb.pragmas).toEqual(["PRAGMA journal_mode = WAL", "PRAGMA synchronous = NORMAL"]);
    await s.close();
  });
});
