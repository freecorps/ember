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

export type BackendKind = "memory" | "sqlite" | "expo-sqlite" | "indexeddb";
export const BACKENDS: BackendKind[] = ["memory", "sqlite", "expo-sqlite", "indexeddb"];

export function backend(kind: BackendKind) {
  const dir = kind === "sqlite" || kind === "expo-sqlite" ? mkdtempSync(join(tmpdir(), "ember-offline-")) : null;
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
    }
  };
  return { make, cleanup: () => dir && rmSync(dir, { recursive: true, force: true }) };
}
