// The SQLite backends' connection handling (PR 3B-1): shard databases open on demand under an LRU bound (migrated once
// per session), expo-sqlite reuses prepared statements and relaxes fsync only where the server can resend the data.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stableStringify } from "@freecorps/ember-client";
import type { SqlDriver } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { NodeExpoDatabase } from "./backends.ts";
import { SqliteBackend, sqliteStorage, VACUUM_EVERY } from "../src/sqlite.ts";
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
    let peak = 0;
    const openDb = (n: string): SqlDriver & { close(): void } => {
      const d = createNodeSqliteDriver(join(dir, `${n}.db`));
      opens++;
      open.add(n);
      peak = Math.max(peak, open.size);
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
    // Evicted before the next one opens: never main + 3, even for a moment.
    expect(peak).toBe(3);
    await s.close();
    expect(open.size).toBe(0);
    // A reload opens the main database only; each shard's records are read on first use, under the same bound.
    const s2 = sqliteStorage({ schema, queries: offlineQueries, name: "m", open: openDb, maxOpenShards: 1 });
    await s2.load();
    expect(open.size).toBe(1);
    for (const sh of shards) expect((await s2.runQueryLocally(req(sh)))!.value).toEqual(list);
    expect(open.size).toBe(2);
    await s2.close();
  });

  it("a driver that cannot be closed is kept and reused (never dropped open); one whose close throws stays open", async () => {
    const dir = tmp();
    const opens = new Map<string, number>();
    const closes = new Map<string, number>();
    let throwing = true;
    const kind = (n: string) => (n === "m" ? "main" : (["none", "throws", "ok", "ok"] as const)[order.indexOf(n) - 1]!);
    const order: string[] = [];
    const openDb = (n: string): SqlDriver & { close?(): void } => {
      if (!order.includes(n)) order.push(n);
      opens.set(n, (opens.get(n) ?? 0) + 1);
      const d = createNodeSqliteDriver(join(dir, `${n}.db`));
      const base = { exec: (sql: string, ...p: Parameters<SqlDriver["exec"]>[1][]) => d.exec(sql, ...p), transaction: <T>(f: () => T) => d.transaction(f) };
      if (kind(n) === "none") return base;
      return {
        ...base,
        close: () => {
          if (throwing && kind(n) === "throws") throw new Error("busy");
          closes.set(n, (closes.get(n) ?? 0) + 1);
          d.close?.();
        },
      };
    };
    const be = new SqliteBackend(schema, openDb, "m", { maxOpenShards: 1 });
    await be.open();
    const shards = ["s:none", "s:throws", "s:ok1", "s:ok2"];
    for (let round = 0; round < 3; round++) for (const sh of shards) be.commit(sh, {});
    const [none, throws, ok1, ok2] = order.slice(1);
    // The unclosable and the failing ones opened once (kept, reused); the closable ones take turns under the bound.
    expect(opens.get(none!)).toBe(1);
    expect(opens.get(throws!)).toBe(1);
    expect(opens.get(ok1!)).toBeGreaterThan(1);
    expect(closes.get(ok2!)).toBeGreaterThan(0);
    throwing = false;
    be.commit("s:ok1", {});
    expect(closes.get(throws!)).toBe(1);
    expect(opens.get(throws!)).toBe(1);
    be.close();
  });
});

describe("cold start reads one shard at a time", () => {
  const seed = async (dir: string, shards: string[], opts: { now?: () => number } = {}) => {
    const srv = engineServer();
    for (let i = 0; i < 4; i++) srv.m("messages:send", { channel: "a", body: `m${i}` });
    const list = srv.q("messages:list", { channel: "a" });
    const s = sqliteStorage({ schema, queries: offlineQueries, name: "m", open: (n) => createNodeSqliteDriver(join(dir, `${n}.db`)), ...opts });
    await s.load();
    for (const sh of shards) await s.applyPatch(upd(sh, list));
    await s.close();
    return list;
  };
  const counting = (dir: string) => {
    const opened: string[] = [];
    const open = (n: string) => (opened.push(n), createNodeSqliteDriver(join(dir, `${n}.db`)));
    return { opened, open };
  };

  it("load, the client id and the pending queue (what hello waits for) open the main database only", async () => {
    const dir = tmp();
    const shards = Array.from({ length: 6 }, (_, i) => `org:${i}`);
    const list = await seed(dir, shards);
    const { opened, open } = counting(dir);
    const s = sqliteStorage({ schema, queries: offlineQueries, name: "m", open });
    await s.load();
    await s.persistPending.getClientId();
    await s.persistPending.load();
    expect(opened).toEqual(["m"]);
    expect((await s.runQueryLocally(req("org:3")))!.value).toEqual(list);
    expect(opened.length).toBe(2);
    // A write to an unread shard reads its records first: the same value at the same version is coalesced.
    let commits = 0;
    const be = (s as unknown as { backend: SqliteBackend }).backend;
    const commit = be.commit.bind(be);
    be.commit = (shard, c) => (commits++, commit(shard, c));
    await s.applyPatch({ ...upd("org:5", structuredClone(list)), epoch: "E" });
    expect(opened.length).toBe(3);
    expect(commits).toBe(1); // no owner: taken
    await s.applyPatch({ ...upd("org:5", structuredClone(list)), epoch: "E", identity: { subject: "a" } });
    await s.applyPatch({ ...upd("org:5", structuredClone(list)), epoch: "E", identity: { subject: "a" } });
    expect(commits).toBe(2); // the owner's value once, then coalesced
    await s.close();
  });

  it("retention applies to a shard when it is first read; clear() reads and drops every shard", async () => {
    const dir = tmp();
    let now = 1_000_000;
    await seed(dir, ["org:a", "org:b"], { now: () => now });
    now += 40 * 86_400_000;
    const { opened, open } = counting(dir);
    const s = sqliteStorage({ schema, queries: offlineQueries, name: "m", open, now: () => now });
    await s.load();
    expect(opened).toEqual(["m"]);
    // Stale: dropped as the shard is read, so the local run finds nothing replicated.
    expect((await s.runQueryLocally(req("org:a")))!.value).toEqual([]);
    await s.clear();
    expect(opened.length).toBe(3);
    await s.close();
  });
});

describe("empty shard databases go; new ones vacuum incrementally", () => {
  const files = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
  const autoVacuum = (path: string) => {
    const d = createNodeSqliteDriver(path);
    try {
      return Number(d.exec(`PRAGMA auto_vacuum`).rows[0]!.auto_vacuum);
    } finally {
      d.close?.();
    }
  };

  it("a shard left with nothing has its database deleted (and comes back when written again)", async () => {
    const dir = tmp();
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "hi" });
    const list = srv.q("messages:list", { channel: "a" });
    const removed: string[] = [];
    const s = sqliteStorage({
      schema,
      queries: offlineQueries,
      name: "m",
      open: (n) => createNodeSqliteDriver(join(dir, `${n}.db`)),
      remove: (n) => (removed.push(n), rmSync(join(dir, `${n}.db`), { force: true })),
    });
    await s.load();
    await s.applyPatch(upd("org:1", list));
    await s.applyPatch(upd("org:2", list));
    // org:2 has a pending mutation: it stays even when it holds nothing else.
    await s.persistPending.put({ mid: "x", shard: "org:2", fn: "messages:send", args: {}, createdAt: 1, identity: null } as never);
    expect(files(dir)).toHaveLength(3);
    await s.clear();
    expect(removed).toHaveLength(1);
    expect(files(dir)).toHaveLength(2);
    // Written again: a new database, under the same name.
    await s.applyPatch(upd("org:1", list, 2));
    expect(files(dir)).toHaveLength(3);
    expect((await s.runQueryLocally(req("org:1")))!.value).toEqual(list);
    await s.close();
    // Without `remove`, empty databases stay.
    const dir2 = tmp();
    const s2 = sqliteStorage({ schema, queries: offlineQueries, name: "m", open: (n) => createNodeSqliteDriver(join(dir2, `${n}.db`)) });
    await s2.load();
    await s2.applyPatch(upd("org:1", list));
    await s2.clear();
    expect(files(dir2)).toHaveLength(2);
    await s2.close();
  });

  it("new databases use auto_vacuum = INCREMENTAL; one created before keeps its mode", async () => {
    const dir = tmp();
    // A database from before: tables already there with auto_vacuum NONE.
    const old = createNodeSqliteDriver(join(dir, "m.db"));
    old.exec(`CREATE TABLE "_ember_local_meta" ("k" TEXT PRIMARY KEY, "v" TEXT NOT NULL) STRICT`);
    old.close?.();
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "hi" });
    const s = sqliteStorage({ schema, queries: offlineQueries, name: "m", open: (n) => createNodeSqliteDriver(join(dir, `${n}.db`)) });
    await s.load();
    await s.applyPatch(upd("org:1", srv.q("messages:list", { channel: "a" })));
    await s.close();
    const [main, ...shard] = files(dir).sort((a, b) => a.length - b.length);
    expect(autoVacuum(join(dir, main!))).toBe(0);
    expect(autoVacuum(join(dir, shard[0]!))).toBe(2);
  });

  it("freed pages go back to the file system every VACUUM_EVERY commits that free them", async () => {
    const dir = tmp();
    const srv = engineServer();
    for (let i = 0; i < 400; i++) srv.m("messages:send", { channel: `c${i % 40}`, body: `m${i} ${"x".repeat(500)}` });
    const vacuums: string[] = [];
    const open = (n: string): SqlDriver & { close?(): void } => {
      const d = createNodeSqliteDriver(join(dir, `${n}.db`));
      return { exec: (sql, ...p) => (/incremental_vacuum/.test(sql) && vacuums.push(n), d.exec(sql, ...p)), transaction: (f) => d.transaction(f), close: () => d.close?.() };
    };
    const s = sqliteStorage({ schema, queries: offlineQueries, name: "m", open, maxQueries: 1 });
    await s.load();
    // Each new channel evicts the previous one (maxQueries 1): a commit that frees its rows, every time.
    for (let c = 0; c < VACUUM_EVERY + 2; c++) await s.applyPatch(upd("org:1", srv.q("messages:list", { channel: `c${c % 40}` }), 1));
    expect(vacuums.filter((n) => n !== "m")).toHaveLength(1);
    const driver = ((s as unknown as { backend: SqliteBackend }).backend as unknown as { shards: Map<string, { driver: SqlDriver }> }).shards.get("org:1")!.driver;
    expect(Number(driver.exec(`PRAGMA freelist_count`).rows[0]!.freelist_count)).toBe(0);
    await s.close();
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
