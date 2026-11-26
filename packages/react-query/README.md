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
import { EmberQueryClient, emberMutation, emberQuery } from "@freecorps/ember-react-query";
import { QueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../ember/_generated/api";

const ember = new EmberClient({ url, defaultShard: "global:main" });
const queryClient = new QueryClient();
new EmberQueryClient(ember).connect(queryClient);   // ember-aware key hash + follows the cache

function Messages({ roomId }: { roomId: Id<"rooms"> }) {
  const { data } = useQuery(emberQuery(api.messages.list, { roomId, paginationOpts: { numItems: 20, cursor: null } }));
  const send = useMutation(emberMutation(api.messages.send)); // send.error is EmberErrorOf<typeof api.messages.send>
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
- Paginated live queries with stable pages are `usePaginatedQuery` in `@freecorps/ember-react`; here a paginated query
  is one TanStack query per page arguments.

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Protocolo WS v1". Tests with usage: [`packages/react-query/test`](https://github.com/freecorps/ember/tree/main/packages/react-query/test).

License: MIT.
