# @freecorps/ember-flags

Feature flags and remote config for [Ember](https://github.com/freecorps/ember). Flags live in one **`.replicated()`
table**: they are written in `global:main`, and the runtime copies every change to every shard. Evaluating a flag
inside any shard's query or mutation is then a **synchronous read of the shard's local copy: 0 RTT**, no cross-shard
call, and reactive (a query re-runs when its copy changes). The evaluator is pure and deterministic, so the same
function also runs on the client over a snapshot.

```sh
npm install @freecorps/ember-flags
```

## Install

```ts
// ember/ember.config.ts
import { defineApp } from "@freecorps/ember-server";
import { flags } from "@freecorps/ember-flags";

export default defineApp().use(flags);
```

## Evaluate (server)

```ts
// ember/flags.ts
import { FeatureFlags, vFlagContext } from "@freecorps/ember-flags";
import { components, query } from "./_generated/server";

export const ff = new FeatureFlags(components.flags, {
  newCheckout: { type: "boolean", default: false },
  checkoutTheme: { type: "string", default: "classic" },
});

// ember/checkout.ts: on any shard, inside the mutation's transaction
import { v } from "@freecorps/ember-server";
import { mutation } from "./_generated/server";
import { ff } from "./flags";

export const start = mutation({
  args: { plan: v.string() },
  handler: (ctx, a) => {
    const user = ctx.auth.getUserIdentity()!.subject;
    if (ff.evaluate(ctx, "newCheckout", { unitId: user, plan: a.plan })) {
      // ...
    }
  },
});
```

- `ff.evaluate(ctx, key, context)` returns the declared type (`boolean` above); a flag that is missing, or that holds
  a value of another type, serves the declared `default`.
- `ff.detail(ctx, key, context)` returns `{ value, reason, rule?, version? }`. `reason` is one of `missing`,
  `disabled`, `rule`, `rollout`, `outOfRollout` or `on`.
- `ff.all(ctx, context)` returns every flag's value by key.
- In an action, the same calls return Promises.

### How a flag is evaluated

1. A disabled flag serves `defaultValue`.
2. Otherwise, the first rule whose conditions all match serves that rule's `value`. Condition operators: `eq`, `neq`,
   `in`, `notIn`, `startsWith`, `semverGte` and `semverLt`. When the context attribute is an array, a condition
   matches if any element matches (`neq`/`notIn`: if none does). A missing attribute or an empty array satisfies
   `neq` and `notIn`; add an `in`/`eq` condition when the attribute must be present.
3. Otherwise, a flag with a `rollout: { percent, salt }` serves its on value to units whose bucket is inside the
   percent, and `defaultValue` to the rest and to contexts without a `unitId`. The bucket is
   `hash32(salt + "." + key + "." + unitId) % 10000`: the same in every shard and on every client. Raising the percent
   keeps everyone already inside; a new salt reshuffles who is in.
4. Otherwise the flag serves its on value: `value`, or `true` for a boolean flag.

## Admin (global:main only)

`setFlag`, `setRules`, `setRollout`, `toggle` and `deleteFlag` run where the table is written, in `global:main`. Each
one bumps the flag's `version`. Anywhere else the engine refuses the write with `ReadOnlyTable`.

```ts
ff.set(ctx, { key: "newCheckout", type: "boolean", defaultValue: false, clientVisible: true });
ff.setRollout(ctx, "newCheckout", 10);   // 10% of units
ff.setRules(ctx, "newCheckout", [{ conditions: [{ attr: "plan", op: "eq", value: "enterprise" }], value: true }]);
ff.toggle(ctx, "newCheckout", false);    // kill switch: everyone gets defaultValue
```

From an action on another shard, call them with `ctx.onShard("global:main")`. The Ember Dashboard has a **Feature
flags** screen (global scope). It has an enabled switch per flag, a "Rollout %" action, and "Edit rules" and "Delete"
behind a typed confirmation in protected environments.

## Client

Clients never call component functions, so the app exposes the values a client may see. These are the flags with
`clientVisible: true`:

```ts
// ember/flags.ts
export const forClient = query({ args: { context: vFlagContext }, handler: (ctx, a) => ff.forClient(ctx, a.context) });
```

```tsx
import { FlagsProvider, useFlag } from "@freecorps/ember-flags/react";

<FlagsProvider query={api.flags.forClient} args={{ context: { unitId: user.id, plan } }}>
  <App />
</FlagsProvider>;

const fresh = useFlag("newCheckout", false); // false while loading, when missing, or when the value has another type
const theme = useFlag("checkoutTheme", "classic"); // a string (the fallback's type, widened), not "classic"
```

Offline, or for your own UI, use the pure evaluator over a snapshot. Get the snapshot from `ff.definitions(ctx, {
clientVisible: true })`, exposed by an app query. Its entry point imports nothing else:

```ts
import { evaluate, evaluateAll } from "@freecorps/ember-flags/eval";
evaluate(snapshot.find((f) => f.key === "newCheckout"), { unitId }, false);
```

## Cost

- **A write** writes 1 row in `global:main`, plus 1 log row, plus 1 delivery and 1 write in every shard that receives
  replicated tables: writes × shards. `ember deploy` prints that number per table. Flags change rarely; data that
  changes every minute does not belong here.
- **An evaluation** is one indexed read of the local copy. It writes nothing and calls no other shard.
- **Staleness** is that of replication: eventual, in order per shard. `ctx.db.replicaStatus` tells how far a shard's
  copy is. Before a new shard's first copy arrives, it serves the declared defaults.

Contract: `docs/design/contracts.md`, section "Flags".
