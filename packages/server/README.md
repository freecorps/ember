# @freecorps/ember-server

The app-facing API of [Ember](https://github.com/freecorps/ember), a Convex-style backend on Cloudflare: declare the
schema, write `query` / `mutation` / `action` functions, and the `ember` CLI (`@freecorps/ember-cli`) generates the
types and deploys them. This package also holds the engine itself (query compiler, read sets, schema → DDL and the
migration planner) as pure TypeScript with no Cloudflare or Node APIs; `@freecorps/ember-runtime` runs it inside
Durable Objects.

```sh
npm install @freecorps/ember-server @freecorps/ember-runtime
npm install -D @freecorps/ember-cli
```

## Example

From [`examples/chat`](https://github.com/freecorps/ember/tree/main/examples/chat):

```ts
// ember/schema.ts
import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    rooms: defineTable({ name: v.string() }).index("by_name", ["name"]),
    messages: defineTable({ roomId: v.id("rooms"), author: v.string(), body: v.string() })
      .index("by_room", ["roomId"]) // every index ends with _creationTime
      .searchIndex("search_body", { searchField: "body", filterFields: ["roomId"] }), // SQLite FTS5
  },
});

// ember/messages.ts
import { paginationOptsValidator, v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";
import { errors } from "./errors"; // defineErrors({ EmptyMessage: { message: "Empty message" }, ... })

export const list = query({
  args: { roomId: v.id("rooms"), paginationOpts: paginationOptsValidator },
  handler: (ctx, { roomId, paginationOpts }) =>
    ctx.db.query("messages").withIndex("by_room", (q) => q.eq("roomId", roomId)).order("desc").paginate(paginationOpts),
});

export const send = mutation({
  args: { roomId: v.id("rooms"), author: v.string(), body: v.string() },
  errors: [errors.EmptyMessage, errors.RoomNotFound],
  handler: (ctx, { roomId, author, body }) => {
    if (!body.trim()) throw errors.EmptyMessage();
    if (!ctx.db.get(roomId)) ctx.fail.RoomNotFound({ roomId });
    return ctx.db.insert("messages", { roomId, author, body: body.trim() });
  },
});
```

`ember codegen` (run by `ember dev`) writes `ember/_generated/`: `server` (builders typed by your schema), `api`
(typed function references for clients) and the manifest the runtime deploys.

## Main entry points

- **Schema**: `defineSchema`, `defineTable` (`.index`, `.searchIndex`, `.vectorIndex`, `.aiSearchIndex`,
  `.aggregate`, `.shard(kind, field)`, `.replicated({ to? })`), `defineShard({ key, locationHint? })`, `v` (from
  `@freecorps/ember-values`).
- **Functions**: `query`, `mutation`, `action`, their `internal*` variants and `httpAction` / `httpRouter` (typed
  routes with `params`, `query`, `body`, `returns`). Options include `args`, `returns`, `errors` and `shard`
  (`shard: "org"`, `shard: { org: "orgId" }` or `shard: { org: fromAuth("org") }` to route by a token claim). Import
  them from `./_generated/server` in an app so `ctx.db` is typed.
- **Errors**: `defineErrors({ Code: { data?, message?, status? } })`; thrown errors reach clients typed.
- **Scheduling and triggers**: `ctx.scheduler.runAfter` / `runAt` in mutations and actions, `cronJobs()` in
  `ember/crons.ts`, `defineTriggers` in `ember/triggers.ts` (run in the writing transaction).
- **Components**: `defineApp().use(component, options)` in `ember/ember.config.ts`, `defineComponent` to write one.
- **Convex import**: `defineImport` in `ember/import.config.ts` (used by `ember import convex`).
- **Local execution**: `runLocalQuery`, `runLocalMutation` and friends, used by `@freecorps/ember-offline` to run the
  same `query()` definitions on the device.
- **`@freecorps/ember-server/testing`**: `createNodeSqliteDriver()`, a `node:sqlite` `SqlDriver` for tests in Node
  (Node >= 22.5; kept out of the main entry so it stays free of Node-only APIs). For app tests, prefer
  `@freecorps/ember-testing`.

## Context

- Queries and mutations: `ctx.db` (get, query with `withIndex` / `withSearchIndex` / `filter` / `paginate`, and in
  mutations insert, patch, replace, delete, increment), `ctx.auth`, `ctx.storage`, `ctx.scheduler`; mutations also
  have `ctx.sql` (private SQL tables) and `ctx.random()`.
- Actions: `ctx.runQuery` / `runMutation` / `runAction`, `ctx.onShard(shard)`, `ctx.shards` (`list`, `fanOut`),
  `ctx.env`, `ctx.storage` (bytes and URLs), `ctx.images`, `ctx.browser`, vector and AI search.
- `ctx.auth.getUserIdentity()` / `ctx.auth.require()` return an `Identity<Claims>`. With `ember/auth.config.ts`,
  `ember codegen` prints the claims it signs in (`ember/_generated/claims.d.ts`: Better Auth's `sid`, `email`, `name`,
  `emailVerified`, `org?` with the organization plugin, and what `ember.claims` returns, optional) and the builders of
  `./_generated/server` use them: `claims.role` is typed, `claims.nope` and `fromAuth("nope")` are type errors. Without
  one (or the generic builders of this package) the claims are `Record<string, unknown>`.

## Limits worth knowing

- **Query and mutation handlers are synchronous**: no `await`, no I/O. A mutation is one SQLite transaction in one
  shard; network calls belong in actions, which run outside any transaction and call back in through
  `ctx.runQuery` / `ctx.runMutation`.
- A shard is one Durable Object (`<kind>:<key>`, default `global:main`); a transaction never spans shards. Replicated
  tables are written only in `global:main` and are eventually consistent copies elsewhere.
- Plan limits (rows read and written, result size, timeouts) are enforced per function; see `limits.ts` and
  `defineApp({ limits })`.
- `.index(name, fields, { sparse: true })` keeps only the documents that have every indexed field (an SQLite partial
  index): a document without an optional field costs no index row. A query sees only documents with every indexed
  field, so it reads as a plain index only when every matching document has every indexed field. Otherwise it differs:
  an upper bound without a lower one (`lt`/`lte`; `undefined` sorts first on a plain index, e.g. `eq("name", "a")
  .lt("tag", "z")` also returns `{ name: "a" }` there), a prefix of a compound index (`eq` on its first field only) or
  a scan without bounds leaves out the documents missing any of its fields. Turning it on or off rebuilds the index
  (staged backfill).
- `ctx.db.insert(table, (id) => doc)` builds the document from its new id (a job scheduled for it, a row that points
  back at it): one write instead of an insert and a patch. The callback and the row are one savepoint: if it throws,
  or the document it returns is refused, none of what it wrote or scheduled stays, even when the caller catches.
- `defineApp({ storage: { compactFormat: 2 } })` makes migrations create format 2 compact tables from then on (the
  rollback lever for format 3, the default); existing tables keep their format.

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md)
(in Portuguese), sections "Engine", "Contrato das funções", "Crons", "Replicação entre shards", "Componentes".
Typing rules: [`docs/design/dx.md`](https://github.com/freecorps/ember/blob/main/docs/design/dx.md). Examples:
[`examples/`](https://github.com/freecorps/ember/tree/main/examples).

License: MIT.
