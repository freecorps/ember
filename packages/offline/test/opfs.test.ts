// The OPFS adapter's wiring in Node: page (`opfsStorage`) ⇄ Worker (`serveOpfsStorage`) over MessageChannel ports,
// the real SQLite-Wasm build underneath, and an `opfs-sahpool` stand-in that is exclusive like the real one (one
// unpaused pool per directory at a time). Two tabs' Workers coordinate; the leader's close pauses the pool so the
// next one can take it. The real thing (OPFS, Worker, Web Locks in Chromium) is test/browser/.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPendingStorage, stableStringify, type LocalQueryResult } from "@freecorps/ember-client";
import type { Doc } from "@freecorps/ember-server";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { sqlite3 } from "./backends.ts";
import { FakeLocks } from "./locks.ts";
import { opfsStorage } from "../src/opfs.ts";
import { serveStorage } from "../src/remote.ts";
import { OPFS_CAPACITY_HEADROOM, openOpfsStore, serveOpfsStorage, type SahPool, type Sqlite3Module } from "../src/opfs-worker.ts";

const SHARD = "org:acme";
const req = (fn: string, args: Record<string, unknown> = {}) => ({ shard: SHARD, fn, args, argsJson: stableStringify(args), identity: null });
const upd = (fn: string, args: Record<string, unknown>, value: unknown, version = 1) => ({ shard: SHARD, fn, args, argsJson: stableStringify(args), value, version });
const bodies = (x: unknown) => (x as Doc[]).map((d) => (d as any).body);
const until = (cond: () => unknown, timeout = 3000) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout, interval: 2 },
  );

/** `installOpfsSAHPoolVfs` over the wasm in-memory FS; a second unpaused pool on a directory throws, as OPFS does. */
function fakeOpfs() {
  const owners = new Map<string, object>();
  /** Per directory, like opfs-sahpool: every file stored takes one of `capacity` (open or not). */
  const dirs = new Map<string, { files: Set<string>; capacity: number }>();
  let installs = 0;
  const module = (): Sqlite3Module => ({
    async installOpfsSAHPoolVfs({ directory, initialCapacity }) {
      const dir = directory!;
      const fs = dirs.get(dir) ?? { files: new Set<string>(), capacity: 0 };
      dirs.set(dir, fs);
      fs.capacity = Math.max(fs.capacity, initialCapacity ?? 6);
      const me = {};
      if (owners.has(dir)) throw new Error("NoModificationAllowedError: access handles are taken");
      owners.set(dir, me);
      installs++;
      let paused = false;
      const pool: SahPool = {
        OpfsSAHPoolDb: class {
          constructor(file: string) {
            if (paused) throw new Error("pool paused");
            if (!fs.files.has(file)) {
              if (fs.files.size >= fs.capacity) throw new Error(`SAH pool is full. Cannot create file ${file}`);
              fs.files.add(file);
            }
            return new sqlite3.oo1.DB(`/${dir.slice(1)}-${file.slice(1)}`, "c") as any;
          }
        } as any,
        reserveMinimumCapacity: async (n) => (fs.capacity = Math.max(fs.capacity, n)),
        getCapacity: () => fs.capacity,
        getFileCount: () => fs.files.size,
        isPaused: () => paused,
        pauseVfs() {
          paused = true;
          if (owners.get(dir) === me) owners.delete(dir);
          return pool;
        },
        async unpauseVfs() {
          if (owners.has(dir)) throw new Error("NoModificationAllowedError: access handles are taken");
          owners.set(dir, me);
          paused = false;
          return pool;
        },
      };
      return pool;
    },
  });
  return { module, installs: () => installs, dir: (name: string) => dirs.get(`.ember-${name}`) };
}

describe("opfs storage (Node wiring over SQLite-Wasm)", () => {
  const ends: Array<() => void> = [];
  afterEach(() => {
    for (const e of ends.splice(0)) e();
  });

  it("runs the store in the Worker; tabs hand the pool over; data survives", async () => {
    const opfs = fakeOpfs();
    const locks = new FakeLocks();
    const name = `o-${Math.random().toString(36).slice(2)}`;
    const tab = (id: string) => {
      const { port1: page, port2: scope } = new MessageChannel();
      const channel = new BroadcastChannel(`ember-offline:opfs:${name}`);
      const worker = serveOpfsStorage({
        name,
        schema,
        queries: offlineQueries,
        sync: [{ query: "messages:list", args: { channel: "a" } }],
        sqlite3: async () => opfs.module(),
        locks: locks.forTab(id),
        channel,
        scope: scope as any,
      });
      scope.start();
      page.start();
      const storage = opfsStorage({ worker: Object.assign(page as any, { terminate: () => page.close() }) });
      ends.push(() => {
        page.close();
        scope.close();
        channel.close();
      });
      return { storage, worker, kill: () => (locks.kill(id), channel.close(), scope.close()) };
    };

    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "Olá" });
    const a = tab("A");
    expect(await a.storage.load()).toEqual({ identity: null });
    expect(a.storage.sync).toEqual([{ query: "messages:list", args: { channel: "a" } }]);
    await until(() => a.worker.storage.role === "leader");
    const b = tab("B");
    await b.storage.load();
    await until(() => b.worker.storage.role === "follower");

    const seen: Array<LocalQueryResult | undefined> = [];
    b.storage.watchQueryLocally(req("messages:search", { q: "ola" }), (r) => seen.push(r));
    await b.storage.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" })));
    await until(() => seen.at(-1) && (seen.at(-1)!.value as string[]).length === 1);
    expect(seen.at(-1)).toEqual({ value: ["Olá"], source: "local" }); // FTS5, accent-insensitive, in the Worker

    // the leader's page closes: its Worker closes the database and pauses the pool; B's Worker takes it over
    await a.storage.close();
    await until(() => b.worker.storage.role === "leader");
    expect(opfs.installs()).toBe(2);
    srv.m("messages:send", { channel: "a", body: "segunda" });
    await b.storage.applyPatch(upd("messages:list", { channel: "a" }, srv.q("messages:list", { channel: "a" }), 2));
    expect(bodies((await b.storage.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["Olá", "segunda"]);

    // B's tab crashes (no close: the pool stays taken until "the browser" frees it); C retries until it can
    b.kill();
    const c = tab("C");
    const opening = c.storage.load();
    await new Promise((r) => setTimeout(r, 60));
    // what OPFS does when the crashed Worker's handles are finally released:
    (b.worker.storage as any).store?.close?.();
    await opening;
    await until(() => c.worker.storage.role === "leader");
    expect(bodies((await c.storage.runQueryLocally(req("messages:list", { channel: "a" })))!.value)).toEqual(["Olá", "segunda"]);
    await c.storage.close();
  });

  it("fails the page's load when the Worker reports an error", async () => {
    const { port1 } = new MessageChannel();
    const listeners: Array<(e: { message: string }) => void> = [];
    const worker = Object.assign(port1 as any, {
      addEventListener(t: string, l: any) {
        if (t === "error") listeners.push(l);
        else MessagePort.prototype.addEventListener.call(port1, t as any, l);
      },
    });
    const s = opfsStorage({ worker });
    const loading = s.load();
    for (const l of listeners) l({ message: "SyntaxError: bad module" });
    await expect(loading).rejects.toThrow("offline worker failed: SyntaxError: bad module");
    port1.close();
  });
  it("close() does not hang on a dead Worker: it stops waiting, rejects what is in flight and terminates", async () => {
    // A Worker that reported an error (failed to start / crashed): close returns at once.
    const crashed = new MessageChannel();
    const listeners: Array<(e: { message: string }) => void> = [];
    let terminated = 0;
    const worker = Object.assign(crashed.port1 as any, {
      addEventListener(t: string, l: any) {
        if (t === "error") listeners.push(l);
        else MessagePort.prototype.addEventListener.call(crashed.port1, t as any, l);
      },
      terminate: () => terminated++,
    });
    const s = opfsStorage({ worker });
    const loading = s.load();
    for (const l of listeners) l({ message: "boom" });
    await expect(loading).rejects.toThrow("offline worker failed: boom");
    // A Worker that reported an error is not trusted again: calls fail at once, it is terminated (once).
    await expect(s.runQueryLocally(req("messages:list", { channel: "a" }))).rejects.toThrow("offline worker failed: boom");
    await s.close();
    expect(terminated).toBe(1);
    crashed.port1.close();

    // A Worker that went silent without an error event: close gives up after closeTimeoutMs.
    const silent = new MessageChannel();
    let terminatedSilent = 0;
    const s2 = opfsStorage({ worker: Object.assign(silent.port1 as any, { terminate: () => terminatedSilent++ }), closeTimeoutMs: 30 });
    const t0 = Date.now();
    await s2.close();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(terminatedSilent).toBe(1);
    silent.port1.close();
  });
  it("a Worker that crashes after load fails the calls in flight and later ones, and the watches, instead of hanging", async () => {
    const ch = new MessageChannel();
    const listeners: Array<(e: { message: string }) => void> = [];
    let terminated = 0;
    const worker = Object.assign(ch.port1 as any, {
      addEventListener(t: string, l: any) {
        if (t === "error") listeners.push(l);
        else MessagePort.prototype.addEventListener.call(ch.port1, t as any, l);
      },
      terminate: () => terminated++,
    });
    ch.port1.start();
    ch.port2.start();
    // The Worker side: loads, then never answers a query (it is about to crash).
    const served = serveStorage(
      {
        load: async () => ({ identity: null }),
        applyPatch: async () => {},
        runQueryLocally: () => new Promise(() => {}),
        watchQueryLocally: () => () => {},
        persistPending: new MemoryPendingStorage(),
      },
      ch.port2 as any,
    );
    const s = opfsStorage({ worker });
    await s.load();
    const inflight = s.runQueryLocally(req("messages:list", { channel: "a" }));
    const watchErrors: string[] = [];
    s.watchQueryLocally(req("messages:list", { channel: "a" }), () => {}, (e) => watchErrors.push(e.message));
    await new Promise((r) => setTimeout(r, 10));
    for (const l of listeners) l({ message: "RuntimeError: unreachable" });
    await expect(inflight).rejects.toThrow("offline worker failed: RuntimeError: unreachable");
    await expect(s.applyPatch(upd("messages:list", { channel: "a" }, []))).rejects.toThrow("offline worker failed");
    expect(watchErrors).toEqual(["offline worker failed: RuntimeError: unreachable"]);
    expect(terminated).toBe(1);
    // A late announcement from it changes nothing.
    ch.port2.postMessage({ ember: "offline/1", k: "leader", from: "w" });
    await new Promise((r) => setTimeout(r, 10));
    await expect(s.flush()).rejects.toThrow("offline worker failed");
    await s.close();
    expect(terminated).toBe(1);
    served.stop();
    ch.port1.close();
  });

  it("the pool grows with the shards: past its initial capacity (closed databases still hold files) and on reopen", async () => {
    const opfs = fakeOpfs();
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "hi" });
    const list = srv.q("messages:list", { channel: "a" });
    const args = { channel: "a" };
    const at = (shard: string) => ({ shard, fn: "messages:list", args, argsJson: stableStringify(args) });
    const name = `c-${Math.random().toString(36).slice(2)}`;
    // Capacity 4 and 2 open shards: before, the 4th database (main + 3 shards) failed with "SAH pool is full".
    const options = { name, schema, queries: offlineQueries, sqlite3: async () => opfs.module(), capacity: 4, maxOpenShards: 2 };
    const loaded: { pool?: SahPool } = {};
    const s = await openOpfsStore(options, loaded);
    await s.load();
    const shards = Array.from({ length: 20 }, (_, i) => `org:${i}`);
    for (const sh of shards) await s.applyPatch({ ...at(sh), value: list, version: 1 });
    expect(opfs.dir(name)!.files.size).toBe(21);
    expect(opfs.dir(name)!.capacity).toBeGreaterThanOrEqual(21);
    await s.close();
    // Closed databases still hold their files (and their slots).
    expect(opfs.dir(name)!.files.size).toBe(21);
    expect(opfs.dir(name)!.capacity).toBeGreaterThanOrEqual(21);
    // Reopened (another Worker): room for what is stored plus new shards right away.
    const again = await openOpfsStore(options);
    expect(opfs.dir(name)!.capacity).toBeGreaterThanOrEqual(21 + 8);
    await again.load();
    for (const sh of shards) expect((await again.runQueryLocally({ ...at(sh), identity: null }))!.value).toEqual(list);
    for (const sh of ["new:1", "new:2", "new:3"]) await again.applyPatch({ ...at(sh), value: list, version: 1 });
    await again.close();
  });

  it("shards opened while the pool grows top it up again once that growth settles; close waits for it", async () => {
    const opfs = fakeOpfs();
    const srv = engineServer();
    srv.m("messages:send", { channel: "a", body: "hi" });
    const list = srv.q("messages:list", { channel: "a" });
    const args = { channel: "a" };
    const at = (shard: string) => ({ shard, fn: "messages:list", args, argsJson: stableStringify(args) });
    const name = `g-${Math.random().toString(36).slice(2)}`;
    // Like addCapacity: the room shows up before the call settles. Settles only when released.
    const held: Array<() => void> = [];
    const module = async () => {
      const m = opfs.module();
      return {
        async installOpfsSAHPoolVfs(o: Parameters<Sqlite3Module["installOpfsSAHPoolVfs"]>[0]) {
          const pool = await m.installOpfsSAHPoolVfs(o);
          const reserve = pool.reserveMinimumCapacity;
          let first = true;
          pool.reserveMinimumCapacity = async (n) => {
            const r = await reserve(n);
            if (first) first = false;
            else await new Promise<void>((done) => held.push(done));
            return r;
          };
          return pool;
        },
      } as Sqlite3Module;
    };
    const s = await openOpfsStore({ name, schema, queries: offlineQueries, sqlite3: module, capacity: 16 });
    await s.load();
    const dir = opfs.dir(name)!;
    let i = 0;
    while (!held.length) await s.applyPatch({ ...at(`org:${i++}`), value: list, version: 1 });
    // A burst while that growth is under way: the free files drop below half the headroom.
    while (dir.capacity - dir.files.size >= OPFS_CAPACITY_HEADROOM / 2) await s.applyPatch({ ...at(`org:${i++}`), value: list, version: 1 });
    expect(held).toHaveLength(1);
    held.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    // The follow-up growth (was dropped): sized for the files stored now.
    expect(held).toHaveLength(1);
    expect(dir.capacity).toBe(dir.files.size + OPFS_CAPACITY_HEADROOM);
    let closed = false;
    const closing = s.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(false); // still waiting for the growth before pausing the VFS
    held.shift()!();
    await closing;
    expect(dir.capacity - dir.files.size).toBeGreaterThanOrEqual(OPFS_CAPACITY_HEADROOM / 2);
  });

  it("openOpfsStore pauses the pool again when opening fails after the VFS is installed", async () => {
    const opfs = fakeOpfs();
    let failReserve = true;
    const module = async () => {
      const m = opfs.module();
      return {
        async installOpfsSAHPoolVfs(o: Parameters<Sqlite3Module["installOpfsSAHPoolVfs"]>[0]) {
          const pool = await m.installOpfsSAHPoolVfs(o);
          const reserve = pool.reserveMinimumCapacity;
          pool.reserveMinimumCapacity = async (n) => {
            if (failReserve) throw new Error("quota");
            return reserve(n);
          };
          return pool;
        },
      };
    };
    const loaded: { pool?: SahPool } = {};
    const options = { name: `p-${Math.random().toString(36).slice(2)}`, schema, queries: offlineQueries, sqlite3: module };
    await expect(openOpfsStore(options, loaded)).rejects.toThrow("quota");
    expect(loaded.pool!.isPaused()).toBe(true);
    // another Worker can take the pool now
    const other = await openOpfsStore({ ...options, sqlite3: async () => opfs.module() });
    await other.load();
    await other.close();
    // and the first one, retrying, too
    failReserve = false;
    const again = await openOpfsStore(options, loaded);
    await again.load();
    await again.close();
  });
});
