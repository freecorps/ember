/**
 * `@freecorps/ember-offline`: optional offline-first storage for `@freecorps/ember-client` (PLAN §10).
 *
 *   import { indexedDbStorage } from "@freecorps/ember-offline/indexeddb";      // browsers
 *   import { expoSqliteStorage } from "@freecorps/ember-offline/expo-sqlite";   // React Native / Expo
 *   import { sqliteStorage } from "@freecorps/ember-offline/sqlite";            // any synchronous SqlDriver
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
export { NeedData, recordKey, type BackendReader, type Commit, type OfflineBackend, type QueryRecord } from "./backend.ts";
export { MemoryBackend, memoryStorage } from "./memory.ts";
export type { LocalSchema } from "@freecorps/ember-server";
export type { StorageAdapter, SyncSpec, LocalQueryResult, QueryUpdate } from "@freecorps/ember-client";
