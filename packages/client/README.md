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
  inject), `backoff`, `heartbeat`, `idleTimeoutMs`, `multiTab`.
- Methods: `query` (one shot), `subscribe` / `watchQuery` (live), `mutation`, `action`, `setAuth` / `clearAuth`,
  `connectionState` / `onConnectionStateChange`, `discardPending`, `fetchForHydration` / `hydrate` / `dehydrate` (SSR; `WebSocket: null` on the server),
  `files.upload` / `files.url`, `close`.
- `watchPaginatedQuery` for paginated queries (what `usePaginatedQuery` is built on).
- Errors: `EmberError` (`code`, `data`, `kind: "app" | "system"`), `isError(e, ref, code)`, `isAppError`, `errorRef`.
- Storage: `MemoryPendingStorage`, `KeyValuePendingStorage` (over any `KeyValueStore`; writes of one burst coalesced
  into one `setItem`), `memorySnapshotCache`,
  `keyValueSnapshotCache` (one key per query plus a small index, only what changed written; the old single-blob format
  is not migrated: it is removed, so the first load after upgrading is cold). One writer per store across tabs, elected with Web Locks over a `BroadcastChannel`: only in a page that
  has both, and over a store other than `sessionStorage` (two stores in one origin need different `prefix`es).
  Otherwise (React Native, Node, workers, a browser without either API, or `sessionStorage`) the instance writes its
  store from the start, so it must be that store's only cache instance (or pass `tabs` to coordinate them yourself);
  `browserConnectivity()`.
- Every call takes `{ shard }` to pick a shard explicitly; otherwise the function's declared routing (an argument or a
  token claim) or `defaultShard` decides.
- **`@freecorps/ember-client/testing`**: `FakeEmberServer` and `FakeSocket`, an in-process fake speaking the WebSocket
  protocol, for testing client SDKs (it is not a database; app tests belong in `@freecorps/ember-testing`); and
  `FakeBrowser`, fake tabs (BroadcastChannel + Web Locks, with crash and freeze) for testing `multiTab`.

## Several tabs: `multiTab`

`new EmberClient({ url, multiTab: true })` (opt-in) keeps one WebSocket per shard for every tab of the origin instead
of one per tab: the tab holding a Web Lock keeps the real sockets, and the other tabs' clients send the very same
frames to it over a `BroadcastChannel`. Each tab still has its own subscriptions, optimistic updates, mutation queue and
identity; only the transport is shared.

- **Per identity.** Tabs share a socket only when their tokens name the same identity with the same claims (apart from
  `exp`/`iat`/`nbf`/`jti`), or the same opaque token, or are both signed out. A tab signed in as someone else gets a
  socket of its own; `setAuth` to another identity moves that tab, alone, to a socket of the new identity (its socket
  closes before anything of the old one could reach it) and never sends an `auth` frame on the shared one.
- **Expiry per tab.** The leader checks each tab's own token `exp`: a tab whose token has expired gets nothing computed
  for the identity and runs nothing through the shared socket (as the shard does for an expired socket) until it
  renews its own token.
- **Mutations.** Tabs without a stored clientId take the leader's, so the shard's dedup key (identity, clientId, mid)
  is the same whichever socket a mutation goes out on. When the leader tab closes, crashes or freezes, the next tab
  leads, every client reconnects through it and resends what had no answer with the same mid: the shard answers those
  from its dedup, so nothing is lost or run twice while the shard still holds that mid's outcome. It holds it at least
  7 days and at most 14 (an outcome still in the change-log ring, with feature `ack`, stays answerable while its ring
  slot exists, even past 14 days); a resend after the outcome is gone (a tab back from a freeze or an offline queue
  older than that) counts as a new mutation and runs again.
- **Fallback.** Without Web Locks or BroadcastChannel (React Native, older Node, old browsers) it does nothing; a socket
  the leader does not take within `openTimeoutMs` (default 1 s) opens on its own.
- Options: `{ name, openTimeoutMs, clientIdTimeoutMs, lifecycle, locks, BroadcastChannel, onRoleChange }`;
  `client.tabRole` says `"leader"`, `"follower"`, `"starting"`, `"closed"`, or null when not sharing.

## Offline and identity

Without a `StorageAdapter` the client keeps results in memory and queues mutations in its `PendingStorage`. With one
(`@freecorps/ember-offline`) it also answers queries from the device. A queued mutation only ever goes out under the
identity that issued it: signed out it waits, another identity signing in drops it (`identity_changed`).
`discardPending()` drops the whole queue and rolls back its optimistic effects.

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Protocolo WS v1", "Várias abas", "Contrato das funções", "Arquivos" and "Offline". Examples:
[`examples/chat`](https://github.com/freecorps/ember/tree/main/examples/chat) (optimistic send, pagination),
[`examples/todo`](https://github.com/freecorps/ember/tree/main/examples/todo) (offline queue).

License: MIT.
