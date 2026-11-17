# @freecorps/ember-runtime

The Cloudflare side of [Ember](https://github.com/freecorps/ember): the Worker and the Durable Objects that run an
app built with `@freecorps/ember-server`. Each shard is a SQLite-backed Durable Object (`Shard`) that runs
transactions with group commit, live subscriptions over WebSocket, the scheduler and crons, files on R2, external
indexes (Vectorize, AI Search) and cross-shard replication; `System` evaluates crons with time zones.

```sh
npm install @freecorps/ember-runtime
```

Most apps never import it: `ember dev` and `ember deploy` (`@freecorps/ember-cli`) bundle it into the generated
Worker. Install it next to `@freecorps/ember-server` so the bundled version is the one you pinned.

## Embedding in an existing Worker

For an app that already has its own Worker and deploys with Wrangler, mount the runtime under a prefix:

```ts
import { createEmberWorker } from "@freecorps/ember-runtime";
export { Shard, System } from "@freecorps/ember-runtime";

const ember = createEmberWorker({ schema, functions, crons, basePath: "/ember", auth: { verify } });

export default {
  fetch: (req, env, ctx) => (ember.handles(req) ? ember.fetch(req, env, ctx) : myApp.fetch(req, env, ctx)),
  // Only Ember's queues may reach ember.queue: it acknowledges what it cannot read. Keep the "ember-" prefix for them.
  queue: (batch, env, ctx) => (batch.queue.startsWith("ember-") ? ember.queue(batch, env, ctx) : myApp.queue(batch, env, ctx)),
  // Ember needs a "* * * * *" trigger, so this fires every minute: myApp.scheduled picks its own work by c.cron.
  scheduled: async (c, env, ctx) => { await myApp.scheduled(c, env, ctx); await ember.scheduled(c, env, ctx); },
};
```

- The runtime then serves `/ember/ws`, `/ember/api/query|mutation|action`, `/ember/api/storage/*`,
  `/ember/api/_ember/*`, `/ember/health` and the app's HTTP routes; clients use `new EmberClient({ url:
  "https://app.example.com/ember" })`.
- `createEmberWorker` must run in the entry module before any `Shard` / `System` wakes up.
- Queues: `ember.queue` takes every message of a batch as its own and acknowledges what it cannot read, so only
  Ember's queues may reach it. The example routes by the `ember-` prefix: keep that prefix for Ember's queues alone, or
  compare `batch.queue` with their exact names.
- Crons: `ember deploy` gives the Worker a `* * * * *` Cron Trigger; with Wrangler, add it to `triggers.crons` next to
  your own (`ember.scheduled` evaluates the app's crons once a minute, and an extra tick is harmless). If your Worker
  has other triggers, dispatch your own work on `controller.cron`, since `scheduled` now also fires every minute.
- Bindings: `SHARD` (Durable Object `Shard`, SQLite, required), `SYSTEM` (Durable Object `System`, for crons),
  `EMBER_ACTIONS` (Queue for action jobs; without it they run in the shard's alarm), `EMBER_FILES` (R2, for
  `ctx.storage`), `EMBER_IMAGES`, `EMBER_REGISTRY` (D1 catalog, optional).
- Variables: `EMBER_PROJECT`, `EMBER_ENV`, `EMBER_STORAGE_SECRET`, `EMBER_PUBLIC_URL`, `EMBER_ADMIN_TOKEN` and a few
  optional ones; the full table is in contracts.md.
- Schema migrations run on each shard's first wake, as with `ember deploy`. What `ember deploy` would provision (the
  actions Queue, the D1 catalog) goes into your `wrangler.jsonc` by hand.

## Main entry points

- `createEmberWorker(options)` → `{ fetch, queue, scheduled, email, handles, revokeSockets }`.
- Durable Object classes: `Shard`, `System`.
- `ADMIN_API_LEVEL` / `ADMIN_FEATURES`: the admin API (`/api/_ember/*`, `EMBER_ADMIN_TOKEN`) version the dashboard and
  CLI check against.
- Lower-level pieces used by the CLI, the components and tests: `DoSqlDriver`, `ActionRunner`, the cron parser
  (`parseCron`, `nextCronMatch`), replication helpers.

## Limits

- One Durable Object per shard: a shard's throughput is that object's; a transaction never spans shards.
- Browser Rendering and Images are optional bindings: `ctx.browser` throws `BrowserNotConfigured` without
  `EMBER_BROWSER`, and `ctx.images` throws without `EMBER_IMAGES`.

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese): "Protocolo WS v1", "Admin / status", "Arquivos", "Replicação entre shards", "Embutir o runtime num
Worker existente". Design: [`docs/PLAN.md`](https://github.com/freecorps/ember/blob/main/docs/PLAN.md).

License: MIT.
