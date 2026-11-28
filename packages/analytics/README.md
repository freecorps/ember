# @freecorps/ember-analytics

Lightweight product analytics for [Ember](https://github.com/freecorps/ember) apps on Cloudflare. Each event is one
[Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) data point, written by the
Worker that received it: **no Durable Object is woken or written per event** (0 rows per event). Counts, funnels and
retention come from the Analytics Engine SQL API, cached briefly.

```ts
// ember/ember.config.ts
import { defineApp } from "@freecorps/ember-server";
import { analytics } from "@freecorps/ember-analytics";
export default defineApp().use(analytics, {
  config: {
    dimensions: ["plan", "path"], // string props with a column of their own (blob8..blob20)
    measures: ["amount"],         // number props with a column of their own (double2..double20)
    archive: true,                // also keep the raw events in R2 (gzip NDJSON)
    rateLimit: { binding: "RL_ANALYTICS", limit: 600, period: 60 }, // per IP, at the edge
  },
});
```

```ts
// in the browser: batched, flushed every 10 s and on pagehide (sendBeacon), text/plain so there is no CORS preflight
import { createAnalytics } from "@freecorps/ember-analytics/client";
const analytics = createAnalytics({ url: "https://my-app.example.com" });
analytics.track("viewed_pricing", { plan: "pro" });
```

```ts
// ember/billing.ts (actions): server-side events and queries
import { v } from "@freecorps/ember-server";
import { Analytics } from "@freecorps/ember-analytics";
import { action, components } from "./_generated/server";

const analytics = new Analytics(components.analytics);

export const checkoutDone = action({
  args: { amount: v.number() },
  handler: async (ctx, a) => {
    await analytics.track(ctx, "checkout_completed", { amount: a.amount }); // the caller's identity is the user
  },
});

export const report = action({
  args: {},
  handler: async (ctx) => ({
    funnel: await analytics.funnel(ctx, { steps: ["viewed_pricing", "started_checkout", "checkout_completed"], windowHours: 24, days: 7 }),
    retention: await analytics.retention(ctx, { period: "week", periods: 8 }),
    top: await analytics.topEvents(ctx, { sinceHours: 24 }),
  }),
});
```

## Ingest

- `POST /analytics/track` (the install's mount + `/track`) takes `{ events: [{ name, props?, ts?, anonymousId?, userId? }] }`
  as JSON (`text/plain` or `application/json`), answers `204`, and the preflight (`OPTIONS`) for clients that send a
  bearer token. Limits: 32 KiB per body (413), 50 events per batch, names `[A-Za-z][A-Za-z0-9 _.:/-]*` up to 64,
  20 flat props per event (string, number, boolean; strings cut at 256), `ts` within the last 7 days (else the
  server's time). A batch that breaks a rule is refused whole (400 `bad_batch`).
- **The user is never trusted from the body.** With a valid bearer token, `userId` is the identity's subject. Without
  one, a `userId` in the batch is dropped unless `trustClientUserId: true`. The anonymous id is the client's.
- Rate limit: with `rateLimit`, each batch is checked against a Workers Rate Limiting binding, per IP
  (`cf-connecting-ip`), or per signed-in user with `key: "user"` (anonymous callers still by IP). The key is never
  something the client picks (an anonymous id, an `x-forwarded-for`); over it, 429. With `limit` and `period` the component asks `ember deploy`
  for the binding; without them it uses one declared elsewhere (for example the rateLimit component's `bindings`).
  A binding that is not there yet (not deployed) is skipped with a warning: only the size caps apply. A binding that
  is there but fails is **not** skipped: the route answers 503 (`retry-after: 10`) and writes nothing, and the client
  keeps the batch for later. Without `rateLimit`, only the size caps apply.
- Server side: `analytics.track(ctx, name, props)` / `trackMany` from actions. Mutations cannot do I/O: schedule an
  action from them.

## Data point layout

| column | value |
|---|---|
| `index1` | event name |
| `blob1` .. `blob6` | name, userId, anonymousId, source (`client`/`server`), country, install key (`<EMBER_PROJECT>/<EMBER_ENV>:<install>`) |
| `blob7` | JSON of the props no dimension or measure took (up to 2 KiB, whole props only) |
| `blob8` .. `blob20` | the declared `dimensions`, in order |
| `double1` | the event's time (ms) |
| `double2` .. `double20` | the declared `measures`, in order |

The dataset is `ember_analytics` and the binding `EMBER_ANALYTICS` by default (`dataset`, `binding` in the config);
`ember deploy` creates the binding, `ember dev` simulates it. Datasets belong to the Cloudflare account, so staging and
production on the default dataset write to the same one: the install key in `blob6` carries the deployment
(`EMBER_PROJECT`/`EMBER_ENV`, set by every deploy) and every query filters on it, so each deployment's reports only
see its own rows. Without the binding, the Analytics Engine write is skipped (warned once); an `archive` still runs.

## Queries

`lib.counts`, `lib.topEvents`, `lib.funnel`, `lib.retention` (actions; the `Analytics` helper wraps them) call the
SQL API with `EMBER_ANALYTICS_ACCOUNT_ID` (or the files bucket's `EMBER_R2_ACCOUNT_ID`) and the secret
`EMBER_ANALYTICS_API_TOKEN` ("Account Analytics: Read"), read on the server only (`ember env set`). Results are cached
for 60 s (`sql.cacheSeconds`) in the isolate and in the data center's Cache API. Without the env:
`AnalyticsNotConfigured`; an API error (a non-2xx, a request that fails, an answer without a `data` list of rows):
`AnalyticsQueryFailed`, never cached. Composing the exported helpers yourself: give `retentionSql` and
`parseRetention` the same `now` (required by the parser), so the cohort labels match the statement.

The SQL API has no bind parameters, so names are checked against a closed alphabet (no quote, no backslash) and then
written as escaped literals; numbers are clamped integers. Analytics Engine SQL has no JOIN: a funnel counts, per user,
the **first** time of each step (in order, within the window from step 1); retention puts each user in the cohort of
their first event in the range (the range is the cohort horizon; Analytics Engine keeps three months). On a sampled
dataset, per-user numbers are estimates. Every query uses the event's own time (`double1`, the `ts` the batch carried),
not when the point was written: a batch sent late (offline, a beacon) keeps its order. Events with neither a user nor
an anonymous id count as events, not as a user. `sql.base` must be `https:` (plain `http:` only to the loopback), and redirects are not followed. A user is
`u:<userId>` or `a:<anonymousId>`: a subject and an anonymous id with the same text are two users. `counts` returns at
most 10 000 rows, the newest buckets.

## Raw archive

With `archive: true` (or `{ bucket, prefix }`), each accepted batch is also written to R2 by the same action as
`analytics/YYYY/MM/DD/HH/<uuid>.ndjson.gz` (UTC hour of arrival, gzip NDJSON, `customMetadata.count`), with no
Durable Object write. Best effort: a failed archive write is logged, the events are in Analytics Engine already.

## Dashboard

An "Analytics" screen (global): events and active users today and the top events of the last 24 h (refreshed by the
summary cron, every 60 minutes by default, `summary: false` to turn it off: one row written per refresh, never per
event), and **Funnel** / **Retention** actions whose last result shows as a table.
