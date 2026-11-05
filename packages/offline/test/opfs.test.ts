// The OPFS adapter's wiring in Node: page (`opfsStorage`) ⇄ Worker (`serveOpfsStorage`) over MessageChannel ports,
// the real SQLite-Wasm build underneath, and an `opfs-sahpool` stand-in that is exclusive like the real one (one
// unpaused pool per directory at a time). Two tabs' Workers coordinate; the leader's close pauses the pool so the
// next one can take it. The real thing (OPFS, Worker, Web Locks in Chromium) is test/browser/.
import { afterEach, describe, expect, it, vi } from "vitest";
import { stableStringify, type LocalQueryResult } from "@freecorps/ember-client";
import type { Doc } from "@freecorps/ember-server";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { sqlite3 } from "./backends.ts";
import { FakeLocks } from "./locks.ts";
import { opfsStorage } from "../src/opfs.ts";
import { openOpfsStore, serveOpfsStorage, type SahPool, type Sqlite3Module } from "../src/opfs-worker.ts";

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
  let installs = 0;
  const module = (): Sqlite3Module => ({
    async installOpfsSAHPoolVfs({ directory }) {
      const dir = directory!;
      const me = {};
      if (owners.has(dir)) throw new Error("NoModificationAllowedError: access handles are taken");
      owners.set(dir, me);
      installs++;
      let paused = false;
      const pool: SahPool = {
        OpfsSAHPoolDb: class {
          constructor(file: string) {
            if (paused) throw new Error("pool paused");
            return new sqlite3.oo1.DB(`/${dir.slice(1)}-${file.slice(1)}`, "c") as any;
          }
        } as any,
        reserveMinimumCapacity: async (n) => n,
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
  return { module, installs: () => installs };
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
    const pending = s.runQueryLocally(req("messages:list", { channel: "a" }));
    await s.close();
    expect(terminated).toBe(1);
    await expect(pending).rejects.toThrow("closed");
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
