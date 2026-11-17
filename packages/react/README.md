# @freecorps/ember-react

React hooks for [Ember](https://github.com/freecorps/ember) over `@freecorps/ember-client`: live queries, mutations
with optimistic updates, actions, live pagination and connection state.

```sh
npm install @freecorps/ember-react @freecorps/ember-client
```

Peer dependency: `react`.

## Example

From [`examples/chat/web`](https://github.com/freecorps/ember/tree/main/examples/chat/web):

```tsx
import { EmberClient } from "@freecorps/ember-client";
import { EmberProvider, useMutation, usePaginatedQuery, useQuery } from "@freecorps/ember-react";
import { api } from "../../ember/_generated/api";

const client = new EmberClient({ url: window.location.origin, defaultShard: "global:main" });
createRoot(root).render(<EmberProvider client={client}><App /></EmberProvider>);

function Room({ roomId }: { roomId: Id<"rooms"> }) {
  const room = useQuery(api.rooms.get, { roomId });                 // undefined while loading
  const { results, status, loadMore } = usePaginatedQuery(api.messages.list, { roomId }, { initialNumItems: 20 });
  const send = useMutation(api.messages.send).withOptimisticUpdate(addMessageOptimistically);
  const found = useQuery(api.messages.search, term ? { roomId, text: term } : "skip");
  // ...
}
```

## Hooks

| Hook | What it returns |
|---|---|
| `useQuery(ref, args?, { shard }?)` | the live value, `undefined` while loading or with `"skip"`; errors go to the nearest error boundary |
| `useQueryState(ref, args?)` | `{ status: "loading" \| "success" \| "error", data, error }` with the function's typed errors; never throws |
| `useQuerySnapshot(ref, args?)` | the raw `QuerySnapshot` (`optimistic`, `source: "local" \| "cache"` included) |
| `useSuspenseQuery(ref, args?)` | the value, suspending while loading (wrap in `<Suspense>`) |
| `useMutation(ref)` | a stable function; `.withOptimisticUpdate(fn)`, `.safe(args)` (a `{ ok, value } \| { ok: false, error }` result) |
| `useMutationState(ref)` | `{ mutate, isPending, data, error, reset }` for forms and buttons |
| `useAction(ref)` | a function calling the action over HTTP; `.safe(args)` |
| `usePaginatedQuery(ref, args, { initialNumItems })` | `{ results, status, isLoading, loadMore(n) }`; each page is its own live query |
| `useConnectionState()` | online flag, per-shard socket state, unconfirmed mutations |
| `useEmberClient()` | the `EmberClient` of the nearest `EmberProvider` |

Functions declared with a named shard kind (`shard: "org"`) require `{ shard }` in the hook options; the types say so.

## Limits

- Arguments are compared by value (stable JSON), so an inline object does not resubscribe on every render.
- `useSuspenseQuery` keeps the subscription a few seconds after the first value so the remounted component finds it.
- For TanStack Query, use `@freecorps/ember-react-query`; for Expo / React Native, `@freecorps/ember-react-native`
  (it re-exports these hooks).

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Protocolo WS v1" and "Contrato das funções"; hook typing in
[`docs/design/dx.md`](https://github.com/freecorps/ember/blob/main/docs/design/dx.md). Examples:
[`examples/chat`](https://github.com/freecorps/ember/tree/main/examples/chat),
[`examples/todo`](https://github.com/freecorps/ember/tree/main/examples/todo).

License: MIT.
