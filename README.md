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
| `@freecorps/ember-offline` | offline-first storage: IndexedDB, SQLite/expo-sqlite (FTS5), local query execution |
| `@freecorps/ember-react-native` | connectivity, AsyncStorage queue, SecureStore auth, push registration |
| `@freecorps/ember-auth` | Better Auth in a dedicated Durable Object |
| `@freecorps/ember-push` | device table helpers and the Expo Push sender; also a `push` component |
| `@freecorps/ember-rate-limit` | `rateLimit` component: token bucket / fixed window per key, transactional in mutations |
| `@freecorps/ember-workflows` | `workflows` component: durable multi-step functions on the shard scheduler |

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
