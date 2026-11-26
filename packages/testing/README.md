# @freecorps/ember-testing

Test an Ember app in Node with the real engine over `node:sqlite`: no workerd, no network. Calls are typed through
the generated `api`, the way a client calls them.

```ts
import { emberTest, expectError } from "@freecorps/ember-testing";
import schema from "../ember/schema";
import * as messages from "../ember/messages";
import { api } from "../ember/_generated/api";

const t = emberTest({ schema, modules: { messages } });
await t.mutation(api.messages.send, { roomId, body: "hi" });
expect(await t.query(api.messages.list, { roomId })).toHaveLength(1);

const e = await expectError(t.mutation(api.messages.send, { roomId, body: "" }), api.messages.send, "EmptyMessage");
await t.withIdentity({ subject: "ana" }).mutation(api.rooms.create, { name: "general" });
await t.advance(60_000);      // runs the jobs due in the next minute
await t.finishScheduled();     // or every job left
```

- One shard per name (`<kind>:<key>`). Calls route like the client does: the function's routing argument, then the
  `shard` option, then `defaultShard` (`global:main`). `WrongShard` is enforced.
- Actions run in-process with `ctx.runQuery` / `runMutation` / `runAction`, the scheduler, `ctx.env` and
  `ctx.storage`. Vectorize, AI Search, images and the browser are not emulated: use the workerd tests for those.
- `t.run((ctx) => ctx.db...)` sets up or inspects data directly, and `t.engine(shard)` gives the engine for anything else.
- `t.fetch("/webhook", { method: "POST", body })` calls the app's HTTP routes (`emberTest({ http })`, the default
  export of `ember/http.ts`).
- `ctx.scheduler.get(id)` / `list()` see the harness's jobs (pending, in progress, success, failed, canceled).
- `.replicated()` tables: what `global:main` writes reaches the harness's other shards on `t.syncReplicas()` (and at
  the start of `finishScheduled` / `advance`, and between their jobs), a full copy on a shard's first sync; before it,
  that shard reads an empty table and `ctx.db.replicaStatus(table).state` is `pending`. `ctx.shards.list/fanOut` in
  actions go over the shards the test has used.

## Files: `ctx.storage`

`ctx.storage` of actions and HTTP actions (`store`, `get`, `getUrl`, `getMetadata`, `delete`, `generateUploadUrl`)
works in memory: the shard's real `_files` table, a Map in place of the R2 bucket. Ids, metadata (`sha256` lowercase
hex, `size`, `contentType`, `state`), dedup by content per shard, reference counts (`FileInUse`) and the GC (an
explicit `delete` at once, a file nothing references after 24 h of `t.advance`) are the runtime's.

```ts
const id = await t.action(api.files.save, { text: "hello" });   // ctx.storage.store("hello", { contentType: "text/plain" })
const url = await t.action(api.files.url, { id });              // http://ember.test/api/storage/get?...
expect(await (await t.fetch(url!)).text()).toBe("hello");       // t.fetch serves the storage URLs (signed, expiring)
```

`t.fetch` also takes a `generateUploadUrl` ticket's URL (`PUT`) and `POST /api/storage/confirm`, as the client's
upload helper does in proxy mode (multipart uploads are not emulated).

## What a call costs: `t.measure` / `t.lastStats`

The engine's own counters (the ones `limits` check): SQLite rows read and written, documents read.

```ts
await t.query(api.messages.list, { roomId });
expect(t.lastStats()).toEqual({ rowsRead: 3, rowsWritten: 0, documentsRead: 3 });

const { value, stats } = await t.measure(() => t.action(api.messages.digest, {}));
expect(stats.documentsRead).toBeLessThan(100);   // every query and mutation the action ran, summed
```

`lastStats()` is the last call that finished (`query`, `mutation`, `action`, `run`, `fetch`, or the last scheduled
job `finishScheduled` / `advance` ran). `measure(fn)` sums every call inside `fn`; concurrent calls outside it do
not count.

## Closing

`t.close()` closes the harness's SQLite databases and drops its pending jobs and files; later calls throw. Or:

```ts
using t = emberTest({ schema, modules });         // closed at the end of the block
await using t2 = emberTest({ schema, modules });  // waits for calls still running, then closes
```

## Porting a convex-test suite: `@freecorps/ember-testing/convex-test`

The `convex-test` API over `emberTest`, so a Convex suite ports almost line by line:

```ts
import { convexTest } from "@freecorps/ember-testing/convex-test";
import { vi } from "vitest";
import schema from "../ember/schema";
import { api } from "../ember/_generated/api";

const t = convexTest(schema, import.meta.glob("../ember/**/*.ts"));
await t.mutation(api.messages.send, { body: "Hi!", author: "Sarah" });
const asSarah = t.withIdentity({ name: "Sarah" });
await t.run(async (ctx) => ctx.db.insert("messages", { body: "seeded", author: "x" }));
await t.fetch("/postMessage", { method: "POST", body: JSON.stringify({ body: "hi" }) });

vi.useFakeTimers();
await t.mutation(api.jobs.later, { delayMs: 10_000 });
vi.advanceTimersByTime(10_000);
await t.finishInProgressScheduledFunctions();
await t.finishAllScheduledFunctions(vi.runAllTimers);
```

- The clock is `Date.now()` and each scheduled job gets a `setTimeout` at its time, as in convex-test: fake timers
  (`vi.useFakeTimers()`, `vi.advanceTimersByTime`, `vi.runAllTimers`) drive the scheduler. A failed scheduled
  function is marked `failed` (`ctx.scheduler.get`) and does not throw into the test.
- `modules`: `import.meta.glob(...)` loaders or loaded modules by path. Paths lose their extension and the folder
  holding `_generated/`; `schema`, `crons`, `*.test` and `_generated/*` are skipped, and `http`'s default export
  serves `t.fetch`.
- Differences: the db API is synchronous (`await ctx.db.get(id)` still works, handlers must be synchronous);
  `t.run(async (ctx) => ...)` runs up to its first real `await` inside the mutation and the rest after the commit
  (not atomic); `withIdentity({ name, email, ...claims })` becomes `{ subject, issuer, claims: { tokenIdentifier,
  name, email, ...claims } }` (issuer `https://convex.test`, a subject derived from the fields, as convex-test);
  `ctx.db.system` is `ctx.scheduler.get/list` and `ctx.storage.getMetadata`; Convex components
  (`t.registerComponent`) are not emulated: Ember components come in through `convexTest(schema, modules, { app })`.
- Options: `defaultShard`, `env`, and as `emberTest`: `app` (the `ember.config.ts` default export), `triggers`,
  `replicas`, `limits`.
- `t.close()` clears the timers of jobs not run yet and closes the `emberTest` underneath (`afterEach(() =>
  t.close())`); `using` / `await using` (which first waits for the scheduled functions in progress) work too.
