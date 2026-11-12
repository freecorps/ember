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
