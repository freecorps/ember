// Every backend, behind one factory, so the same tests run against all of them. `make()` returns a fresh adapter
// over the *same* persistent storage each time (a "reload").
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import type { SqlValue } from "@freecorps/ember-server";
import { expoSqliteStorage, type ExpoSqliteDatabase } from "../src/expo-sqlite.ts";
import { indexedDbStorage } from "../src/indexeddb.ts";
import { MemoryBackend, memoryStorage, type OfflineOptions, type OfflineStore } from "../src/index.ts";
import { sqliteStorage } from "../src/sqlite.ts";
import { sqliteWasmStorage } from "../src/sqlite-wasm.ts";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createStore } from "tinybase";
import { createFilePersister } from "tinybase/persisters/persister-file";
import { tinybaseStorage, type TinyStore } from "../src/tinybase.ts";

/** The official SQLite-Wasm build (FTS5 included), as in browsers; files live in its in-memory file system. */
export const sqlite3 = await sqlite3InitModule();

/** expo-sqlite's synchronous API over node:sqlite: exercises the expo adapter's SQL path for real. */
export class NodeExpoDatabase implements ExpoSqliteDatabase {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }
  getAllSync(sql: string, params: SqlValue[]) {
    return this.db.prepare(sql).all(...(params as any[]));
  }
  runSync(sql: string, params: SqlValue[]) {
    return { changes: Number(this.db.prepare(sql).run(...(params as any[])).changes) };
  }
  execSync(sql: string) {
    this.db.exec(sql);
  }
  closeSync() {
    this.db.close();
  }
}

export type BackendKind = "memory" | "sqlite" | "expo-sqlite" | "indexeddb" | "sqlite-wasm" | "tinybase";
export const BACKENDS: BackendKind[] = ["memory", "sqlite", "expo-sqlite", "indexeddb", "sqlite-wasm", "tinybase"];

export function backend(kind: BackendKind) {
  const dir = kind === "sqlite" || kind === "expo-sqlite" || kind === "tinybase" ? mkdtempSync(join(tmpdir(), "ember-offline-")) : null;
  const mem = new MemoryBackend();
  const idb = new IDBFactory();
  const name = `app-${Math.random().toString(36).slice(2)}`;
  const make = (o: OfflineOptions): OfflineStore => {
    switch (kind) {
      case "memory":
        return memoryStorage({ ...o, backend: mem });
      case "sqlite":
        return sqliteStorage({ ...o, name, open: (n) => createNodeSqliteDriver(join(dir!, `${n}.db`)) });
      case "expo-sqlite":
        return expoSqliteStorage({ ...o, name, openDatabaseSync: (n) => new NodeExpoDatabase(join(dir!, n)) });
      case "indexeddb":
        return indexedDbStorage({ ...o, name, indexedDB: idb, IDBKeyRange });
      case "tinybase": {
        // a fresh Store each time, loaded from (and saved to) a file by TinyBase's own persister
        const store = createStore();
        const persister = createFilePersister(store, join(dir!, `${name}.json`));
        return tinybaseStorage({ ...o, store: store as unknown as TinyStore, persister });
      }
      case "sqlite-wasm":
        return sqliteWasmStorage({ ...o, name, open: (n) => new sqlite3.oo1.DB(`/${n}.db`, "c") });
    }
  };
  return { make, cleanup: () => dir && rmSync(dir, { recursive: true, force: true }) };
}
