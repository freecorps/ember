# @freecorps/ember-client

The framework-agnostic client of [Ember](https://github.com/freecorps/ember): live queries over WebSocket (one
connection per shard, deduplicated subscriptions), mutations with optimistic updates and a pending queue replayed
with server-side dedup, actions, typed errors and file uploads. Works in browsers, React Native and workerd.

```sh
npm install @freecorps/ember-client
```

React apps use it through `@freecorps/ember-react`, `@freecorps/ember-react-query` or
`@freecorps/ember-react-native`.

## Example

```ts
import { EmberClient, isError, optimistic, optimisticUpdatesFor } from "@freecorps/ember-client";
import { api } from "../ember/_generated/api";

const client = new EmberClient({
  url: window.location.origin,            // the Worker (same origin, or its URL)
  defaultShard: "global:main",
  auth: async () => session?.token ?? null, // optional: a JWT or session token for ctx.auth
  optimisticUpdates: optimisticUpdatesFor(optimistic(api.messages.send, addMessageOptimistically)),
});

const stop = client.subscribe(api.messages.list, { roomId, paginationOpts: { numItems: 30, cursor: null } }, undefined, (snap) => {
  if (snap.status === "success") render(snap.value);
});

try {
  await client.mutation(api.messages.send, { roomId, author: "ana", body: "hi" });
} catch (e) {
  if (isError(e, api.messages.send, "MessageTooLong")) alert(`max ${e.data.max}`);
}

const once = await client.query(api.rooms.list, {});
const { storageId } = await client.files.upload(file, { mutation: api.files.generateUploadUrl });
```

The optimistic update itself (`store.getAllQueries` / `store.setQuery`) is in
[`examples/chat/web/src/optimistic.ts`](https://github.com/freecorps/ember/blob/main/examples/chat/web/src/optimistic.ts).

## Main entry points

- `EmberClient` options: `url`, `auth`, `defaultShard`, `storage` (a `PendingStorage` or an offline
  `StorageAdapter`), `optimisticUpdates`, `connectivity`, `snapshotCache`, `onError`, `WebSocket` / `fetch` (to
  inject), `backoff`, `heartbeat`, `idleTimeoutMs`.
- Methods: `query` (one shot), `subscribe` / `watchQuery` (live), `mutation`, `action`, `setAuth` / `clearAuth`,
  `connectionState` / `onConnectionStateChange`, `discardPending`, `fetchForHydration` / `hydrate` (SSR),
  `files.upload` / `files.url`, `close`.
- `watchPaginatedQuery` for paginated queries (what `usePaginatedQuery` is built on).
- Errors: `EmberError` (`code`, `data`, `kind: "app" | "system"`), `isError(e, ref, code)`, `isAppError`, `errorRef`.
- Storage: `MemoryPendingStorage`, `KeyValuePendingStorage` (over any `KeyValueStore`; writes of one burst coalesced
  into one `setItem`), `memorySnapshotCache`,
  `keyValueSnapshotCache` (one key per query plus a small index, only what changed written; the old single-blob format
  is migrated). One writer per store across tabs, elected with Web Locks over a `BroadcastChannel`: only in a page that
  has both, and over a store other than `sessionStorage` (two stores in one origin need different `prefix`es).
  Otherwise (React Native, Node, workers, a browser without either API, or `sessionStorage`) the instance writes its
  store from the start, so it must be that store's only cache instance (or pass `tabs` to coordinate them yourself);
  `browserConnectivity()`.
- Every call takes `{ shard }` to pick a shard explicitly; otherwise the function's declared routing (an argument or a
  token claim) or `defaultShard` decides.
- **`@freecorps/ember-client/testing`**: `FakeEmberServer` and `FakeSocket`, an in-process fake speaking the WebSocket
  protocol, for testing client SDKs (it is not a database; app tests belong in `@freecorps/ember-testing`).

## Offline and identity

Without a `StorageAdapter` the client keeps results in memory and queues mutations in its `PendingStorage`. With one
(`@freecorps/ember-offline`) it also answers queries from the device. A queued mutation only ever goes out under the
identity that issued it: signed out it waits, another identity signing in drops it (`identity_changed`).
`discardPending()` drops the whole queue and rolls back its optimistic effects.

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Protocolo WS v1", "Contrato das funções", "Arquivos" and "Offline". Examples:
[`examples/chat`](https://github.com/freecorps/ember/tree/main/examples/chat) (optimistic send, pagination),
[`examples/todo`](https://github.com/freecorps/ember/tree/main/examples/todo) (offline queue).

License: MIT.
