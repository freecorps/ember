# @freecorps/ember-rate-limit

Rate limiting for [Ember](https://github.com/freecorps/ember) apps, as a component: token bucket and fixed window per
name and key, stored in the shard and transactional inside mutations (a mutation that fails later gives the tokens
back). Optionally asks `ember deploy` for a Cloudflare Rate Limiting binding to shed abusive traffic before it reaches
a shard.

```sh
npm install @freecorps/ember-rate-limit
```

## Example

```ts
// ember/ember.config.ts
import { defineApp } from "@freecorps/ember-server";
import { rateLimit } from "@freecorps/ember-rate-limit";
export default defineApp().use(rateLimit);

// ember/limits.ts
import { HOUR, MINUTE, RateLimiter } from "@freecorps/ember-rate-limit";
import { components } from "./_generated/server";

export const limiter = new RateLimiter(components.rateLimit, {
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
  signUp: { kind: "fixed window", rate: 100, period: HOUR },
});

// in a mutation: synchronous, same transaction
const { ok, retryAfter } = limiter.limit(ctx, "sendMessage", { key: userId });
// or let a refusal reach the client as a RateLimited error ({ name, retryAfter })
limiter.limit(ctx, "sendMessage", { key: userId, throws: true });
// in an action: a Promise, its own transaction on the action's shard
await limiter.limit(ctx, "signUp");
```

## What you get

- `RateLimiter(component, limits)`: `limit(ctx, name, { key?, count?, reserve?, throws? })`, `check` (no tokens
  taken; reactive in queries), `getValue` (tokens left and capacity, for a UI), `reset`. In mutations (and, for
  `check` / `getValue`, queries) the calls are synchronous; in actions they return Promises.
- Token bucket: `rate` tokens per `period` ms, refilled continuously, `capacity` (default `rate`). Fixed window:
  `rate` per window aligned to `start` (default the epoch); leftover accumulates up to `capacity`.
- `reserve: true` takes the tokens anyway (going negative, up to `maxReserved`) and returns when the reservation is
  valid. A refusal writes nothing.
- The limits are sent with each call, so they change without redeploying; named limits can also go in the install
  config (`config.limits`).
- `SECOND`, `MINUTE`, `HOUR`, `DAY`; `assertAllowed(name, result)`; `RATE_LIMITED`.
- Typed error: a refusal with `throws: true` (or `assertAllowed`) throws `rateLimitErrors.RateLimited`, an app error
  made with `defineErrors` (`kind: "app"`, HTTP status 429, `data: { name, retryAfter }`):
  `rateLimitErrors.RateLimited.is(e)` on the server, `isError(e, rateLimitErrors.RateLimited)` on the client.
- GC of expired buckets: each row records when its bucket is full again (the same as no row, so deleting it gives
  nobody extra tokens). One job per shard (`lib:gc`) deletes those rows in batches and reschedules itself while rows
  remain; none runs once the table is empty. Configure with `config.gc`: `{ ttlMs?: 0, batchSize?: 500,
  intervalMs?: 1 hour }`, or `gc: false` to turn it off. `intervalMs` is the least time before a job that waits for
  the next expiry, so a limiter keyed by IP costs one job per interval, not one per key; a job whose batch was full
  continues at once, without waiting, so a backlog of expired rows costs one job per `batchSize` rows (ten rows with
  `batchSize: 4`: three jobs, 4 + 4 + 2). Every write makes sure the shard has a job, so turning the GC back on
  collects the rows written while it was off. Rows written by an older version (no `expiresAt`) are kept until their
  next write. A limit named in the install config is checked again with its current config before its row goes:
  after a redeploy with a slower limit, a bucket still in debt under it is kept. A config sent with each call is only
  known to its calls: its rows go when they were full under the config of their last write.
- `edgeLimit(ctx, binding, key)`: checks a Cloudflare Rate Limiting binding requested with
  `defineApp().use(rateLimit, { config: { binding: { name, limit, period: 10 | 60 } } })`, or several with
  `bindings: { RL_LOGIN: { limit: 5, period: 60 }, RL_API: { limit: 100, period: 10 } }`, from actions or HTTP.

## Limits

- A limit is exact **per shard** (the state lives in the caller's shard). For one limit across shards, call it on a
  chosen shard from an action (`ctx.onShard("global:main")`).
- The Cloudflare binding is approximate and per location: use it to cut abuse, not for quotas.

Contract: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Componentes" → `rateLimit`. Used by `@freecorps/ember-email` (per-project send rate); tests in
[`packages/rate-limit/test`](https://github.com/freecorps/ember/tree/main/packages/rate-limit/test).

License: MIT.
