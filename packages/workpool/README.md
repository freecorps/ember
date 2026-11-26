# @freecorps/ember-workpool

Bounded parallelism for [Ember](https://github.com/freecorps/ember) apps: run expensive work (paid APIs, write-backs
to external systems) at most N at a time, with retries and a completion callback that runs in a transaction.

```ts
// ember/ember.config.ts
import { defineApp } from "@freecorps/ember-server";
import { workpool } from "@freecorps/ember-workpool";
export default defineApp().use(workpool, { name: "aiPool" }).use(workpool, { name: "emailPool" });

// ember/ai.ts
import { v } from "@freecorps/ember-server";
import { Workpool, vOnCompleteArgs } from "@freecorps/ember-workpool";
import { components, internal, internalMutation, mutation, query } from "./_generated/server";

const pool = new Workpool(components.aiPool, { maxParallelism: 4, retry: { maxAttempts: 5, initialBackoffMs: 1000, base: 2 } });

export const start = mutation({
  args: { id: v.id("docs") },
  handler: (ctx, a) => pool.enqueueAction(ctx, internal.ai.summarize, { docId: a.id }, { onComplete: internal.ai.saved, context: { docId: a.id } }),
});

export const saved = internalMutation({
  args: vOnCompleteArgs, // { workId, context, result: { kind: "success", returnValue } | { kind: "failed", error } | { kind: "canceled" } }
  handler: (ctx, { context, result }) => { /* same transaction that marks the item finished */ },
});

export const progress = query({ args: { workId: v.string() }, handler: (ctx, a) => pool.status(ctx, a.workId) }); // reactive
```

## What you get

- `enqueueAction` / `enqueueMutation` and their `...Batch` variants. In a mutation they are synchronous and atomic
  with it (the mutation fails, nothing is enqueued); in an action each call is its own transaction.
- At most `maxParallelism` items running per pool **per shard**. FIFO; `priority` (higher first) per item. Action
  items run in parallel through the actions Queue (`ember.json` `resources.actions`); without it the shard runs action
  jobs one at a time in its alarm, so the cap holds but a pool never runs more than one action at once.
- `onComplete` (a mutation) runs exactly once per item, in the transaction that records the result. If it throws,
  its writes are undone, the error is stored on the item (`onCompleteError`) and the item still finishes.
- `status(ctx, id)`: `{ state: "pending", position }`, `{ state: "running", attempt, retryAt?, lastError? }` or
  `{ state: "finished", result }`; null once unknown. `stats(ctx)`: pending, running, finished by outcome, totals.
- `cancel(ctx, id)`, `cancelAll(ctx)`: `onComplete` gets `{ kind: "canceled" }`.
- `key`: an idempotency key; while an item with that key is retained, enqueueing again returns its id. In the
  `...Batch` variants `key` is a function, `(args, index) => string`, so each item gets its own key
  (`{ key: (a) => \`summarize:${a.docId}\` }`); a fixed string is a type error (and throws), since it would make the
  whole batch one item.
- `onComplete` is typed against the work: its `result.returnValue` must accept what the work function returns
  (`vOnCompleteArgs` takes anything; an args validator with a typed result is checked).

## Retries and delivery

- **Actions** run at least once. A run is a scheduled job (`lib:run`) under the scheduler's lease: if the Worker
  dies, the lease (15 minutes, the longest a Worker invocation may run) runs it again. Make the work idempotent, or
  safe to repeat (an idempotency key sent to the API you call).
- Retries are opt-in: `retry` on the pool (a behavior, or `true` for `DEFAULT_RETRY`) applies to every action item;
  `retry: false` or a behavior on an item overrides it. Delay `initialBackoffMs * base^(n-1)`, ±25% jitter. An item
  keeps its slot while it waits for a retry.
- **Mutations** run exactly once: the work, its result and `onComplete` commit together. They are not retried
  unless the item asks (`retry` on the item); a failing one is rolled back and reported as `failed`.
- A running item whose job is gone (it failed in the scheduler, ended without reporting, or vanished) is reclaimed by
  the pool's periodic check (`reclaimIntervalMs`, default 5 min; a crashed run comes back sooner through its 15-minute
  scheduler lease): the attempt counts as failed, so the slot is never lost. The check is a scheduled job that runs
  only while the pool has running items. An idle pool keeps one job, for the retention GC of its oldest result, on a
  15-minute boundary (at most the retention), so results that expire in the same window are deleted in one wake.
- Cancelling a queued item, or one whose job has not started (a retry waiting), finishes it at once. An action already
  running cannot be stopped: it keeps its slot until it returns, and then finishes as `canceled` (its result is dropped).

## Per shard, and one cap for all shards

The pool's tables live in the shard of whoever calls it (like every Ember component), so the cap is per pool and per
shard: two org shards each run up to `maxParallelism`. For one cap across the whole app, pin the pool to a shard:

```ts
const globalPool = new Workpool(components.aiPool, { maxParallelism: 4, shard: "global:main" });

// from an action on any shard: the call goes through ctx.onShard("global:main")
export const summarize = action({ args: { docId: v.string() }, handler: (ctx, a) =>
  globalPool.enqueueAction(ctx, internal.ai.run, { docId: a.docId }, { onComplete: internal.ai.saved, key: `summarize:${a.docId}` }) });

// from a mutation: schedule that action (atomic with the mutation); it runs at least once, the key dedupes
ctx.scheduler.runAfter(0, internal.ai.summarize, { docId });
```

Trade-offs: enqueueing from a mutation is no longer atomic with it (the scheduled action is), all pinned work and its
`onComplete` run in `global:main` (to write back, take the caller's shard as an argument and use `ctx.onShard(shard)`
from an action, and write back every `result.kind`: `failed` carries the error, `canceled` nothing; see
`test/testing.test.ts`), work functions must be allowed to run there (no `shard:` of another kind), and every pinned call is
a round trip to that shard. Inside that shard (its queries, its `onComplete`), use `globalPool.here`.

## Settings

| Where | Settings |
|---|---|
| `new Workpool(components.x, options)` | `maxParallelism`, `retry`, `retentionMs`, `reclaimIntervalMs`, `shard`. The first four are sent with every enqueue and stored: the last enqueue wins. |
| `.use(workpool, { name, config })` | `maxParallelism` (default 10), `retentionMs` (default 1 day; 0 deletes an item right after `onComplete`), `reclaimIntervalMs` (default 5 min): used when no helper sent one. |

## Observability

`pool.stats(ctx)` (a reactive query) returns `{ pending, running, finished: { success, failed, canceled }, maxParallelism,
totals: { enqueued, succeeded, failed, canceled, retries, reclaimed } }`. In the dashboard, the pool is two read-only
component tables per shard, `<install>$work` (one row per item: status, attempts, lastError, result) and
`<install>$pool` (settings and totals), and its jobs appear as `@<install>/lib:run`, `lib:runMutation` and
`lib:tick` in the shard's jobs.

## Testing

`emberTest({ schema, modules, app })` from `@freecorps/ember-testing` composes the component in; `t.advance(ms)` runs
the item, its retries and `onComplete` on the test clock. See `test/testing.test.ts`.
