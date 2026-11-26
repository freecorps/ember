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
| `useQuery(ref, args?, { shard?, select?, equals? }?)` | the live value (or `select(value)`), `undefined` while loading or with `"skip"`; errors go to the nearest error boundary |
| `useQueryState(ref, args?)` | `{ status: "loading" \| "success" \| "error", data, error }` with the function's typed errors; never throws |
| `useQuerySnapshot(ref, args?)` | the raw `QuerySnapshot` (`optimistic`, `source: "local" \| "cache"` included) |
| `useSuspenseQuery(ref, args?)` | the value, suspending while loading (wrap in `<Suspense>`) |
| `useMutation(ref, { optimisticUpdate? }?)` | a stable function; `.withOptimisticUpdate(fn)`, `.safe(args)` (a `{ ok, value } \| { ok: false, error }` result) |
| `useMutationState(ref, { optimisticUpdate? }?)` | `{ mutate, isPending, data, error, result, reset }` for forms and buttons (memoized) |
| `useAction(ref)` | a function calling the action over HTTP; `.safe(args)` |
| `useActionState(ref)` | `{ run, isPending, data, error, result, reset, reducer }`; `reducer` plugs into React 19's `useActionState` |
| `usePaginatedQuery(ref, args, { initialNumItems })` | `{ results, status, isLoading, loadMore(n) }`; each page is its own live query |
| `useConnectionState(select?, equals?)` | online flag, per-shard socket state, unconfirmed mutations (or the part `select` picks) |
| `<EmberHydrate state>` | hands `client.dehydrate()` (as is or `encodeJson`ed) to the client before its children render |
| `usePreloadedQuery(preloaded)` | the live value of a `preloadQuery(client, ref, args)` / `fetchForHydration` result: the preloaded value at once, then live |
| `useEmberClient()` | the `EmberClient` of the nearest `EmberProvider` |

Functions declared with a named shard kind (`shard: "org"`) require `{ shard }` in the hook options; the types say so.

### Selectors

`select` renders a part of a value and re-renders only when that part changes:

```tsx
const doneCount = useQuery(api.todos.list, { list }, { select: (todos) => todos.filter((t) => t.done).length });
const open = useQuery(api.todos.list, { list }, { select: (todos) => todos.filter((t) => !t.done) });
const saving = useConnectionState((s) => s.pendingMutations > 0);
```

Two selections compare with `equals` (default `shallowEqual`: `Object.is`, or one level of an array / plain object).
The client keeps the identity of rows that did not change, so a filtered array of rows compares equal while none of
its rows changed. An inline selector is fine.

### Actions and forms

```tsx
const summarize = useActionState(api.ai.summarize);
<button disabled={summarize.isPending} onClick={() => summarize.run({ text })}>Summarize</button>;
{summarize.error?.kind === "app" && <p>{summarize.error.message}</p>}
// React 19: const [result, dispatch, pending] = useActionState(summarize.reducer, null);
```

`useMutationState(api.todos.add, { optimisticUpdate: (store, args) => ... })` applies the update on every call; the
latest (inline) function runs, and `mutate` keeps its identity.

## Limits

- Arguments are compared by value (stable JSON), so an inline object does not resubscribe on every render.
- `useSuspenseQuery` releases the subscription it opened to suspend once the component mounts with the value (its own
  subscription holds the query then), or a few seconds after the value if it never mounts. Its promise is per signed-in
  identity (and per org of a `fromAuth` function): never shared between users.

## Server rendering

On the server build the client with `WebSocket: null` (Node 22+ and Workers have a global WebSocket). `useSuspenseQuery`
then reads each query once over HTTP (`fetchForHydration` + `hydrate`) instead of subscribing, so a streaming render
(`renderToPipeableStream`, `prerender`) renders the value; `client.dehydrate()` lists what it read. Serialize it with
`encodeJson` and hand it to the browser client's `hydrate()` before `hydrateRoot`: every hook (`useQuery` too) shows the
value from the first render, on the server (`renderToString` included) and in the browser, with no loading flash, and
the subscription resumes from it.

```tsx
// server
const client = new EmberClient({ url, WebSocket: null, auth: () => tokenOf(request) });
const { prelude } = await prerender(<EmberProvider client={client}><App /></EmberProvider>);
const state = encodeJson(client.dehydrate());
// browser
client.hydrate(...(decodeJson(state) as HydratedQuery[]));
hydrateRoot(root, <EmberProvider client={client}><App /></EmberProvider>);
```
`<EmberHydrate state={state}>` does the `hydrate()` step in React (before its children render, so a client component
tree is enough), and `usePreloadedQuery` takes one preloaded query:

```tsx
// server (a loader, a server component)
const todos = await preloadQuery(serverClient, api.todos.list, { list });
// browser
function Todos({ todos }: { todos: Preloaded<typeof api.todos.list> }) {
  const list = usePreloadedQuery(todos); // never undefined; live after the first render
}
```

A preload the client refuses (read for another identity than the one signed in now) is not shown:
`usePreloadedQuery` then suspends until the live value comes.

- For TanStack Query, use `@freecorps/ember-react-query`; for Expo / React Native, `@freecorps/ember-react-native`
  (it re-exports these hooks).

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Protocolo WS v1" and "Contrato das funções"; hook typing in
[`docs/design/dx.md`](https://github.com/freecorps/ember/blob/main/docs/design/dx.md). Examples:
[`examples/chat`](https://github.com/freecorps/ember/tree/main/examples/chat),
[`examples/todo`](https://github.com/freecorps/ember/tree/main/examples/todo).

License: MIT.
