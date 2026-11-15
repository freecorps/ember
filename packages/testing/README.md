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
- Actions run in-process with `ctx.runQuery` / `runMutation` / `runAction`, the scheduler and `ctx.env`. Files,
  Vectorize, AI Search, images and the browser are not emulated: use the workerd tests for those.
- `t.run((ctx) => ctx.db...)` sets up or inspects data directly, and `t.engine(shard)` gives the engine for anything else.
- `t.fetch("/webhook", { method: "POST", body })` calls the app's HTTP routes (`emberTest({ http })`, the default
  export of `ember/http.ts`).
- `ctx.scheduler.get(id)` / `list()` see the harness's jobs (pending, in progress, success, failed, canceled).

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
  `ctx.db.system` is `ctx.scheduler.get/list` and `ctx.storage.getMetadata`; `ctx.storage.store` and Convex
  components (`t.registerComponent`) are not emulated.
