// A test page: an EmberClient with OPFS storage (its Worker: worker.ts) or IndexedDB coordinated across tabs. Online pages run the real engine in the
// page (SQLite-Wasm in memory) behind the client's fake socket server; offline pages have no server at all.
// The test drives it through `window.t` (page.evaluate).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { EmberClient, type QuerySnapshot } from "@freecorps/ember-client";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { indexedDbStorage } from "../../src/indexeddb.ts";
import { opfsStorage } from "../../src/opfs.ts";
import { coordinateTabs } from "../../src/tabs.ts";
import { wasmSqliteDriver } from "../../src/sqlite-wasm.ts";
import { engineServerWith, offlineQueries, schema, type Server } from "../shared-app.ts";

type Start = { name: string; online: boolean; kind: "opfs" | "indexeddb"; seed?: Array<{ channel: string; body: string }> };

const t = {
  roles: [] as string[],
  snaps: {} as Record<string, QuerySnapshot>,
  client: null as EmberClient | null,
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
      worker.addEventListener("message", (e) => {
        const role = (e.data as { role?: string } | null)?.role;
        if (role) t.roles.push(role);
      });
      storage = opfsStorage({ worker });
    } else {
      // IndexedDB on the page's thread, the tabs coordinated with the real Web Locks + BroadcastChannel
      storage = coordinateTabs({ name, open: () => indexedDbStorage({ name, schema, queries: offlineQueries }), onRoleChange: (r) => t.roles.push(r) });
    }
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
    t.client!.subscribe(fn, args, {}, (s: QuerySnapshot) => (t.snaps[key] = s));
  },
  snap(key: string) {
    const s = t.snaps[key];
    return s ? { status: s.status, value: s.value, source: s.source ?? null, optimistic: s.optimistic } : null;
  },
  mutate(fn: string, args: Record<string, unknown>) {
    void t.client!.mutation(fn, args).catch(() => undefined);
  },
  pending: () => t.client!.connectionState().pendingMutations,
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
