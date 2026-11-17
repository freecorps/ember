# @freecorps/ember-offline

Optional offline-first storage for the [Ember](https://github.com/freecorps/ember) client. A `StorageAdapter` keeps
the last server results and their rows on the device, runs the same `query()` definitions locally (same index
ranges, filters, pagination, and FTS5 search where SQLite is used) until the server answers, re-renders local
results when replicated rows change, and persists the queue of mutations made offline (replayed with server-side
dedup).

```sh
npm install @freecorps/ember-offline @freecorps/ember-client
```

Optional peers, by backend: `@sqlite.org/sqlite-wasm` (OPFS, SQLite-Wasm), `expo-sqlite`, `tinybase`.

## Example

From [`examples/todo/web`](https://github.com/freecorps/ember/tree/main/examples/todo/web) (IndexedDB):

```ts
import { EmberClient } from "@freecorps/ember-client";
import { indexedDbStorage } from "@freecorps/ember-offline/indexeddb";
import schema from "../../ember/schema";
import * as lists from "../../ember/lists";
import * as todos from "../../ember/todos";
import { optimisticUpdates } from "./optimistic"; // the app's own updates, by mutation name

const storage = indexedDbStorage({
  name: "ember-todo",
  schema,
  queries: { "lists:list": lists.list, "todos:list": todos.list }, // these run on the device when offline
});

export const client = new EmberClient({ url: window.location.origin, defaultShard: "global:main", storage, optimisticUpdates });
```

SQLite-Wasm on OPFS runs in a Worker and serves every tab of the origin:

```ts
// ember-offline.worker.ts
import { serveOpfsStorage } from "@freecorps/ember-offline/opfs-worker";
serveOpfsStorage({ name: "chat", schema, queries: { "messages:list": list, "messages:search": search }, sync });

// app
import { opfsStorage } from "@freecorps/ember-offline/opfs";
const client = new EmberClient({
  url,
  storage: opfsStorage({ worker: new Worker(new URL("./ember-offline.worker.ts", import.meta.url), { type: "module" }) }),
});
```

## Entry points

| Import | What it is |
|---|---|
| `@freecorps/ember-offline` | `createOfflineStorage`, `memoryStorage`, `coordinateTabs` (one storage shared by many tabs through Web Locks), `localOptimisticUpdates` (run registered mutations locally as optimistic updates), `serveStorage` / `RemoteStorage` |
| `@freecorps/ember-offline/indexeddb` | `indexedDbStorage` (browsers) |
| `@freecorps/ember-offline/opfs` | `opfsStorage({ worker })`: the page side of the OPFS storage |
| `@freecorps/ember-offline/opfs-worker` | `serveOpfsStorage`, `openOpfsStore`: SQLite-Wasm on OPFS inside a module Worker |
| `@freecorps/ember-offline/sqlite-wasm` | `sqliteWasmStorage`, `wasmSqliteDriver` (SQLite-Wasm without OPFS) |
| `@freecorps/ember-offline/sqlite` | `sqliteStorage` over any `SqlDriver` |
| `@freecorps/ember-offline/expo-sqlite` | `expoSqliteStorage` (React Native / Expo; pass it as `storage` to `createEmberClient`) |
| `@freecorps/ember-offline/tinybase` | `tinybaseStorage`, for apps already on TinyBase |

Common options: `schema`, `queries` (functions that run locally, by name), `sync` (queries to keep replicated),
`maxQueries`, `retentionMs`.

## Limits

- Mutations do not run on the device unless you opt in with `localOptimisticUpdates`: offline writes show through
  optimistic layers, and the replica only changes when the server answers.
- Local results are reactive until the first server value; after that the server's live query takes over.
- The replica is partial: local `take`, counts and bm25 ranking can differ from the server until the next answer.
- Queries that are not registered only get their cached value (`source: "cache"`). Inside a local query,
  `ctx.storage`, `ctx.db.aggregate`, `ctx.runQuery`, `ctx.scheduler.get` / `list` and plugin indexes the backend
  cannot serve throw `OfflineUnsupported`.
- IndexedDB, memory and TinyBase reset the replica on any schema change (SQLite only when the migration planner
  refuses). OPFS needs a module Worker and `createSyncAccessHandle`; only Chromium is tested here. The OPFS pool keeps
  `capacity` files open (two per database: the main one plus one per shard).
- Local identity comes from the JWT's `sub` / `iss`, unverified. A queued mutation only goes out under the identity
  that issued it.

Contract and limits: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md)
(in Portuguese), "Offline" and "Mutations no cliente". Examples: [`examples/todo`](https://github.com/freecorps/ember/tree/main/examples/todo)
(IndexedDB); the browser tests in [`packages/offline/test/browser`](https://github.com/freecorps/ember/tree/main/packages/offline/test/browser)
(OPFS and multi-tab in Chromium).

License: MIT.
