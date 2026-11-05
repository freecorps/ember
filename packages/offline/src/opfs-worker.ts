// The Worker half of OPFS storage: SQLite-Wasm (`@sqlite.org/sqlite-wasm`, optional peer) on the Origin Private
// File System through the `opfs-sahpool` VFS. Sync access handles exist only in dedicated Workers, and the SQL path
// is synchronous (`SqlDriver`), so the whole offline store runs here — the server's DDL, row codec, SQL compiler and
// FTS5 search, exactly as `sqliteStorage` — and the page talks to it with `opfsStorage` (opfs.ts) over postMessage.
// `opfs-sahpool` needs no COOP/COEP headers (no SharedArrayBuffer).
//
// Tabs: the pool's files can be held by one Worker at a time, so the Workers of every tab elect a leader with Web
// Locks (tabs.ts); only the leader installs the VFS and opens the databases, the others forward over a
// BroadcastChannel. When the leader goes away, the next Worker installs the VFS (retrying while the old handles
// are released) and takes over.
//
//   // ember-offline.worker.ts — bundled as a module worker; imports the same schema and query() definitions
//   import { serveOpfsStorage } from "@freecorps/ember-offline/opfs-worker";
//   import schema from "../ember/schema";
//   import { list, search } from "../ember/messages";
//   serveOpfsStorage({ name: "chat", schema, queries: { "messages:list": list, "messages:search": search },
//                      sync: [{ query: "messages:recent", args: { days: 90 } }] });

import { serveStorage, type Endpoint, type Served } from "./remote.ts";
import { sqliteWasmStorage, type WasmSqliteDatabase } from "./sqlite-wasm.ts";
import type { OfflineOptions, OfflineStore } from "./store.ts";
import { coordinateTabs, type LockManagerLike, type TabCoordinator } from "./tabs.ts";

/** The part of the SQLite-Wasm module (`await sqlite3InitModule()`) used here. */
export interface Sqlite3Module {
  installOpfsSAHPoolVfs(opts: { name?: string; directory?: string; initialCapacity?: number; clearOnInit?: boolean }): Promise<SahPool>;
}

/** The part of the `opfs-sahpool` pool utility used here. */
export interface SahPool {
  OpfsSAHPoolDb: new (filename: string) => WasmSqliteDatabase;
  reserveMinimumCapacity(n: number): Promise<number>;
  pauseVfs(): unknown;
  unpauseVfs(): Promise<unknown>;
  isPaused(): boolean;
}

export interface OpfsWorkerOptions extends OfflineOptions {
  /** Storage name (OPFS directory `.ember-<name>`, database prefix, tab lock / channel). Default `"ember"`. */
  name?: string;
  /** Loads SQLite-Wasm. Default: `import("@sqlite.org/sqlite-wasm")` and its default init. */
  sqlite3?: () => Promise<Sqlite3Module>;
  /**
   * Files the pool keeps open: two per database (data + journal) — the main database plus one per shard. Default 16
   * (7 shards). Raise it for apps that use many shards.
   */
  capacity?: number;
  /** Coordinate the tabs that open this storage (default true; needs Web Locks). */
  multiTab?: boolean;
  /** Tests: the lock manager / channel (default `navigator.locks`, `BroadcastChannel`). */
  locks?: LockManagerLike | null;
  channel?: Endpoint & { close(): void };
  /** Where the page is (default: the worker global scope). */
  scope?: Endpoint;
}

const defaultSqlite3 = async (): Promise<Sqlite3Module> => {
  // A computed specifier keeps bundlers of apps that never use OPFS from resolving the optional peer.
  const id = "@sqlite.org/sqlite-wasm";
  const m = (await import(/* @vite-ignore */ id)) as { default: () => Promise<Sqlite3Module> };
  return await m.default();
};

/** Opens OPFS storage in this Worker (the leader's job). Call `close()` to release the files (pauses the VFS). */
export async function openOpfsStore(options: OpfsWorkerOptions, loaded?: { pool?: SahPool }): Promise<OfflineStore> {
  const name = options.name ?? "ember";
  let pool = loaded?.pool;
  if (!pool) {
    const sqlite3 = await (options.sqlite3 ?? defaultSqlite3)();
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: `ember-${name}`, directory: `.ember-${name}`, initialCapacity: options.capacity ?? 16 });
    if (loaded) loaded.pool = pool;
  } else if (pool.isPaused()) await pool.unpauseVfs();
  await pool.reserveMinimumCapacity(options.capacity ?? 16);
  const p = pool;
  const store = sqliteWasmStorage({ ...options, name, open: (n) => new p.OpfsSAHPoolDb(`/${n}.db`) });
  const close = store.close.bind(store);
  store.close = async () => {
    await close();
    // Release the access handles so another tab's Worker can take over.
    if (!p.isPaused()) p.pauseVfs();
  };
  return store;
}

/** Serves OPFS storage to the page (`opfsStorage`), coordinating with the other tabs' Workers. */
export function serveOpfsStorage(options: OpfsWorkerOptions): { storage: TabCoordinator; served: Served } {
  const name = options.name ?? "ember";
  const loaded: { pool?: SahPool } = {};
  const storage = coordinateTabs({
    name: `opfs:${name}`,
    open: () => openOpfsStore(options, loaded),
    ...(options.multiTab === false ? { locks: null } : options.locks !== undefined ? { locks: options.locks } : {}),
    ...(options.channel ? { channel: options.channel } : {}),
  });
  const scope = options.scope ?? (globalThis as unknown as Endpoint);
  const served = serveStorage(storage, scope);
  return { storage, served };
}
