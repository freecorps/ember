/**
 * `@freecorps/ember-offline`: optional offline-first storage for `@freecorps/ember-client` (PLAN §10).
 *
 *   import { opfsStorage } from "@freecorps/ember-offline/opfs";                // browsers: SQLite-Wasm on OPFS (Worker:
 *                                                                               //   serveOpfsStorage from "/opfs-worker")
 *   import { indexedDbStorage } from "@freecorps/ember-offline/indexeddb";      // browsers
 *   import { expoSqliteStorage } from "@freecorps/ember-offline/expo-sqlite";   // React Native / Expo
 *   import { tinybaseStorage } from "@freecorps/ember-offline/tinybase";        // the replica in a TinyBase Store
 *   import { sqliteStorage } from "@freecorps/ember-offline/sqlite";            // any synchronous SqlDriver
 *   import { sqliteWasmStorage } from "@freecorps/ember-offline/sqlite-wasm";   // any SQLite-Wasm oo1 database
 *   import { coordinateTabs } from "@freecorps/ember-offline";                  // several tabs, one storage
 *
 *   new EmberClient({
 *     url,
 *     storage: indexedDbStorage({ name: "my-app", schema, queries: { messages: { list, search } }, sync: [...] }),
 *     optimisticUpdates: { "messages:send": addMessage },
 *   });
 *
 * Contract and limits: docs/design/contracts.md, "Offline".
 */
export { createOfflineStorage, OfflineStore, type OfflineOptions } from "./store.ts";
export { localOptimisticUpdates, type LocalOptimisticOptions } from "./mutations.ts";
export {
  NeedData,
  recordKey,
  type BackendReader,
  type Commit,
  type ExternalChange,
  type OfflineBackend,
  type QueryLogEntry,
  type QueryRecord,
} from "./backend.ts";
export { MemoryBackend, memoryStorage } from "./memory.ts";
export { coordinateTabs, TabCoordinator, type LockManagerLike, type TabRole, type TabsOptions } from "./tabs.ts";
export { RemoteStorage, serveStorage, type Endpoint, type ServableStorage, type Served, type ServeOptions } from "./remote.ts";
export type { LocalSchema } from "@freecorps/ember-server";
export type { StorageAdapter, SyncSpec, LocalQueryResult, QueryUpdate } from "@freecorps/ember-client";
