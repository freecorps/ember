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
- `edgeLimit(ctx, binding, key)`: checks the Cloudflare Rate Limiting binding requested with
  `defineApp().use(rateLimit, { config: { binding: { name, limit, period: 10 | 60 } } })`, from actions or HTTP.

## Limits

- A limit is exact **per shard** (the state lives in the caller's shard). For one limit across shards, call it on a
  chosen shard from an action (`ctx.onShard("global:main")`).
- The Cloudflare binding is approximate and per location: use it to cut abuse, not for quotas.

Contract: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Componentes" → `rateLimit`. Used by `@freecorps/ember-email` (per-project send rate); tests in
[`packages/rate-limit/test`](https://github.com/freecorps/ember/tree/main/packages/rate-limit/test).

License: MIT.
