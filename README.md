# Ember

Convex-style backend on Cloudflare: declare `schema.ts`, write `query`/`mutation`/`action`
functions, and the `ember` CLI generates types and deploys a Worker + SQLite Durable Object
shards with reactive sync over WebSocket. Optional offline-first client adapters.

Status: early (0.x). See [docs/PLAN.md](docs/PLAN.md) and the spike evidence in [docs/spikes](docs/spikes).

## Install

Node >= 22. The packages live under the `@freecorps` npm scope; the CLI binary is `ember`.

```sh
npx @freecorps/ember-cli init          # ember.json + a sample app in ember/ (--auth adds Better Auth)
npm install @freecorps/ember-server @freecorps/ember-runtime @freecorps/ember-client
npm install -D @freecorps/ember-cli    # then `npx ember ...`
npx ember dev                          # local Worker (Miniflare/workerd), codegen on change
npx ember deploy                       # to your Cloudflare account (wrangler login or CLOUDFLARE_API_TOKEN)
```

Front ends add `@freecorps/ember-react` (hooks), `@freecorps/ember-react-query` (TanStack Query) or
`@freecorps/ember-react-native` (Expo/React Native).

| Package | What it is |
|---|---|
| `@freecorps/ember-cli` | `ember` CLI: init, dev, codegen, deploy, logs, domains, metrics, dashboard |
| `@freecorps/ember-server` | `defineSchema`, `defineTable`, `v`, `query`/`mutation`/`action` builders |
| `@freecorps/ember-runtime` | Worker + Durable Objects (bundled into your Worker by the CLI) |
| `@freecorps/ember-values` | validators, shapes, index key encoding |
| `@freecorps/ember-client` | sync client (WebSocket, optimistic updates, offline queue) |
| `@freecorps/ember-react` | `EmberProvider`, `useQuery`, `useMutation`, `useAction`, `usePaginatedQuery` |
| `@freecorps/ember-react-query` | `emberQuery()` for TanStack Query |
| `@freecorps/ember-offline` | offline-first storage: IndexedDB, SQLite/expo-sqlite, SQLite-Wasm on OPFS (FTS5), TinyBase; reactive local queries, multi-tab |
| `@freecorps/ember-react-native` | connectivity, AsyncStorage queue, SecureStore auth, push registration (Expo or native tokens) |
| `@freecorps/ember-auth` | Better Auth in a dedicated Durable Object |
| `@freecorps/ember-push` | push from your Worker: Expo Push, or APNs + FCM directly with optional end-to-end encryption; device registry and a `push` component |
| `@freecorps/ember-expo-push` | device side of encrypted pushes: Expo config plugin (iOS Notification Service Extension), device key, Android decrypt task |
| `@freecorps/ember-rate-limit` | `rateLimit` component: token bucket / fixed window per key, transactional in mutations |
| `@freecorps/ember-workflows` | `workflows` component: durable multi-step functions on the shard scheduler |

## Offline-first (optional)

`@freecorps/ember-offline` keeps the last server results and their rows on the device and runs the same
`query()` definitions locally (same index ranges, filters, pagination, FTS5 search where SQLite is used) until
the server answers. Local results re-render when replicated rows change; mutations made offline are queued and
replayed with server-side dedup.

```ts
import { opfsStorage } from "@freecorps/ember-offline/opfs";            // browsers: SQLite-Wasm on OPFS, in a Worker
import { indexedDbStorage } from "@freecorps/ember-offline/indexeddb";   // browsers: IndexedDB
import { expoSqliteStorage } from "@freecorps/ember-offline/expo-sqlite"; // React Native / Expo
import { tinybaseStorage } from "@freecorps/ember-offline/tinybase";     // apps already on TinyBase
import { coordinateTabs } from "@freecorps/ember-offline";               // one storage, many tabs

// ember-offline.worker.ts
import { serveOpfsStorage } from "@freecorps/ember-offline/opfs-worker";
serveOpfsStorage({ name: "chat", schema, queries: { "messages:list": list, "messages:search": search }, sync });

// app
const client = new EmberClient({
  url,
  storage: opfsStorage({ worker: new Worker(new URL("./ember-offline.worker.ts", import.meta.url), { type: "module" }) }),
  optimisticUpdates: { "messages:send": addMessage },
});
```

Contract and limits: [docs/design/contracts.md](docs/design/contracts.md) ("Offline").

## Development

Bun workspaces. Everything runs from the TypeScript sources: no build is needed for tests, typecheck
or `ember dev` inside the repo (the `@freecorps/ember-source` export condition, see `AGENTS.md`).

```sh
bun install
bun run check          # typecheck + all tests
bun run build          # dist/ for every package (what npm gets)
bun run verify:pack    # pack, install the tarballs in a temp project, run the CLI and type-check a sample app
```

Releasing: [docs/RELEASING.md](docs/RELEASING.md).

License: MIT.
