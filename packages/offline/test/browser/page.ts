// A test page: an EmberClient with OPFS storage (its Worker: worker.ts) or IndexedDB coordinated across tabs. Online pages run the real engine in the
// page (SQLite-Wasm in memory) behind the client's fake socket server; offline pages have no server at all.
// The test drives it through `window.t` (page.evaluate).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { EmberClient, unsafeRef, type QuerySnapshot, type StorageAdapter } from "@freecorps/ember-client";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { indexedDbStorage } from "../../src/indexeddb.ts";
import { opfsStorage } from "../../src/opfs.ts";
import { coordinateTabs } from "../../src/tabs.ts";
import { wasmSqliteDriver } from "../../src/sqlite-wasm.ts";
import { engineServerWith, offlineQueries, schema, type Server } from "../shared-app.ts";

type Start = { name: string; online: boolean; kind: "opfs" | "indexeddb"; seed?: Array<{ channel: string; body: string }> };

const t = {
  roles: [] as string[],
  /** Operations the page posted to its offline Worker (OPFS). */
  ops: [] as string[],
  snaps: {} as Record<string, QuerySnapshot>,
  client: null as EmberClient | null,
  /** The page's StorageAdapter (what the client was given). */
  storage: null as (StorageAdapter & { clear?(): Promise<void> }) | null,
  srv: null as Server | null,
  async start({ name, online, kind, seed = [] }: Start) {
    let fake: FakeEmberServer;
    if (online) {
      const sqlite3 = await sqlite3InitModule();
      t.srv = engineServerWith(wasmSqliteDriver(new sqlite3.oo1.DB(":memory:", "c")));
      for (const m of seed) t.srv.m("messages:send", m);
      fake = t.srv.fake;
    } else fake = new FakeEmberServer({ queries: {}, mutations: {} });
    let storage;
    if (kind === "opfs") {
      const worker = new Worker(`./worker.js?name=${encodeURIComponent(name)}`, { type: "module" });
      const post = worker.postMessage.bind(worker);
      worker.postMessage = (m: unknown) => {
        const op = (m as { op?: unknown } | null)?.op;
        if (typeof op === "string") t.ops.push(op);
        post(m);
      };
      worker.addEventListener("message", (e) => {
        const role = (e.data as { role?: string } | null)?.role;
        if (role) t.roles.push(role);
      });
      storage = opfsStorage({ worker });
    } else {
      // IndexedDB on the page's thread, the tabs coordinated with the real Web Locks + BroadcastChannel
      storage = coordinateTabs({ name, open: () => indexedDbStorage({ name, schema, queries: offlineQueries }), onRoleChange: (r) => t.roles.push(r) });
    }
    t.storage = storage;
    t.client = new EmberClient({
      url: "https://ember.test",
      WebSocket: fake.WebSocket,
      fetch: fake.fetch,
      connectivity: { isOnline: () => online, subscribe: () => () => {} },
      defaultShard: "org:acme",
      heartbeat: false,
      storage,
    });
    await t.client.ready();
  },
  sub(key: string, fn: string, args: Record<string, unknown>) {
    t.client!.subscribe(unsafeRef<"query">(fn), args, {}, (s: QuerySnapshot) => (t.snaps[key] = s));
  },
  snap(key: string) {
    const s = t.snaps[key];
    return s ? { status: s.status, value: s.value, source: s.source ?? null, optimistic: s.optimistic } : null;
  },
  mutate(fn: string, args: Record<string, unknown>) {
    void t.client!.mutation(unsafeRef<"mutation">(fn), args).catch(() => undefined);
  },
  pending: () => t.client!.connectionState().pendingMutations,
  /**
   * A follower stores a value, waits for the leader's saved notice, then calls `clear()` without awaiting it and
   * stores the same value again: how many rows the storage holds for it afterwards.
   */
  async clearRace(channel: string) {
    const s = t.storage!;
    const req = { shard: "org:acme", fn: "messages:list", args: { channel }, argsJson: JSON.stringify({ channel }), identity: null };
    const local = await s.runQueryLocally(req);
    const u = { ...req, value: local!.value, version: 1e9, epoch: "E2E", ik: "t" };
    await s.applyPatch(u);
    await new Promise((r) => setTimeout(r, 300));
    const cleared = s.clear!();
    await s.applyPatch(u);
    await cleared;
    const after = await s.runQueryLocally(req);
    return after?.source === "local" ? (after.value as unknown[]).length : -1;
  },
  flush: () => t.client!.flushStorage(),
  /** Names under the OPFS root (one level of directories). */
  async opfs(): Promise<string[]> {
    const root = await navigator.storage.getDirectory();
    const out: string[] = [];
    for await (const [n, h] of (root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      out.push(n);
      if (h.kind === "directory") for await (const [m] of (h as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) out.push(`${n}/${m}`);
    }
    return out;
  },
};

(globalThis as unknown as { t: typeof t }).t = t;
