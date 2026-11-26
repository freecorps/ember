# @freecorps/ember-react-query

[TanStack Query](https://tanstack.com/query) integration for [Ember](https://github.com/freecorps/ember): Ember
queries live in the TanStack cache and stay live over the WebSocket while they have observers; mutations get typed
variables and errors.

```sh
npm install @freecorps/ember-react-query @freecorps/ember-client @tanstack/react-query
```

Peer dependencies: `@tanstack/react-query`, `react`.

## Example

```tsx
import { EmberClient } from "@freecorps/ember-client";
import { EmberQueryClient, emberAction, emberMutation, emberPaginatedQuery, emberQuery } from "@freecorps/ember-react-query";
import { QueryClient, useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../ember/_generated/api";

const ember = new EmberClient({ url, defaultShard: "global:main" });
const queryClient = new QueryClient();
new EmberQueryClient(ember).connect(queryClient);   // ember-aware key hash + follows the cache

function Messages({ roomId }: { roomId: Id<"rooms"> }) {
  const { data } = useQuery(emberQuery(api.messages.list, { roomId, paginationOpts: { numItems: 20, cursor: null } }));
  const send = useMutation(emberMutation(api.messages.send)); // send.error is EmberErrorOf<typeof api.messages.send>
  const summarize = useMutation(emberAction(api.ai.summarize));  // an action, same typing
  const feed = useInfiniteQuery(emberPaginatedQuery(api.messages.page, { roomId }, { numItems: 20 })); // feed.fetchNextPage()
  // ...
}
```

## Entry points

- `EmberQueryClient(client, options?)`: `.connect(queryClient)` / `.disconnect()`. Server patches and optimistic
  updates are pushed into the cache with `setQueryData`. With `{ ssr: true }` (the default when there is no
  `window`) it fetches with HTTP one-shots and never subscribes.
- `emberQuery(ref, args | "skip", { shard }?)`: `queryOptions` under the key `["ember", shard | null, "module:fn", args]`,
  `staleTime: Infinity`.
- `emberMutation(ref, opts?)` (full `useMutation` options) and `emberMutationFn(ref, opts?)` (just the `mutationFn`).
- `emberAction(ref, { shard }?)`: `useMutation` options for an action (`POST /api/action`), typed variables, result
  and `EmberErrorOf` errors; `emberActionFn` is just its `mutationFn`.
- `emberPaginatedQuery(ref, args | "skip", { numItems, shard? })`: `infiniteQueryOptions` over Ember's cursor
  pagination for `useInfiniteQuery`: the first page has `cursor: null`, `fetchNextPage` starts at `continueCursor`,
  `hasNextPage` is `!isDone`. Key `["ember:paginated", shard | null, "module:fn", args, numItems]`.
- SSR: `prefetchEmberQuery(queryClient, client, ref, args)` and `emberQueryOneShot(client, ref, args)` fetch over HTTP
  (`POST /api/query`); after hydration the browser's subscription resumes from that value instead of downloading it
  again (`emberHydrationKey`).
- Helpers: `isEmberQueryKey`, `emberQueryKeyHashFn`, `EmberError`.

## Limits

- A query is subscribed while it has observers and for `unsubscribeGraceMs` after the last one goes (default 5 s; `new EmberQueryClient(client, { unsubscribeGraceMs })`), or until TanStack garbage-collects it (`gcTime`) if that comes first. A remount within the grace keeps the subscription; a later one subscribes again (the cached data stays meanwhile).
- Functions routed by their own shard (`shard: { org: "orgId" }`, `fromAuth`) work without `{ shard }`: each query
  keeps the reference `emberQuery` built its key with (held weakly, with the key; a later `emberQuery` of the same name
  with another reference does not reroute it). A key restored from a persisted cache routes with the reference of an
  observer's `emberQuery`, else the last one seen for that function name, else on the key's shard (or the client's
  `defaultShard`).
- `emberAction` and `emberPaginatedQuery` route like every other call: `{ shard }`, else the reference's own routing
  (`fromArg`, `fromAuth`), else the client's `defaultShard`.
- `emberPaginatedQuery` pages are one-shot reads (the socket when one is open, else HTTP), not live: refetch or
  invalidate the key to see new rows (TanStack reads every loaded page again from its cursor). Paginated live queries
  with stable pages are `usePaginatedQuery` in `@freecorps/ember-react`.

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Protocolo WS v1". Tests with usage: [`packages/react-query/test`](https://github.com/freecorps/ember/tree/main/packages/react-query/test).

License: MIT.
