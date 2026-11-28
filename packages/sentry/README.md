# @freecorps/ember-sentry

Error tracking for [Ember](https://github.com/freecorps/ember), compatible with the **Sentry Envelope API**: point
`@sentry/react`, `@sentry/react-native` or `@sentry/cloudflare` at your Ember deployment and get issues grouped by
fingerprint, stacks symbolicated with your source maps (in pure JS, no WASM), alerts, and a dashboard screen.

It is built to be cheap: **ingest writes no Durable Object row**. Events go through a Queue to a consumer that writes
about **one row per issue per batch** (up to 100 events); raw payloads, attachments and replays go gzipped to R2 with
a 30-day retention; time series and crash-free sessions go to Analytics Engine.

```sh
npm install @freecorps/ember-sentry
```

## Install

```ts
// ember/ember.config.ts
import { defineApp } from "@freecorps/ember-server";
import { sentry, sentryErrorReporter } from "@freecorps/ember-sentry";

export default defineApp({
  // Optional: Ember's own unhandled function errors (mutations, queries, actions, jobs, HTTP routes) as events.
  onError: sentryErrorReporter({ project: "api", release: process.env.RELEASE }),
}).use(sentry, {
  config: {
    projects: [
      { id: "web", keys: ["k7f3a9c2e1d04b58"], sampleRate: 1, transactionSampleRate: 0.1 },
      { id: "api", keys: ["b2c9e81f0a7d3364"] },
    ],
    alerts: { spike: { events: 100, windowMinutes: 10 }, webhooks: [{ url: "https://hooks.example.com/ember", secretEnv: "ALERT_SECRET" }] },
  },
});
```

`ember deploy` creates the component's Queue (`ember-<project>-<env>-sentry-events`, consumer batches of 100) and the
Analytics Engine binding (`EMBER_SENTRY_SENTRY_AE`, dataset `ember_sentry`). Payloads go to the files bucket
(`EMBER_FILES`, under `sentry/<install>/`; `config.bucket` picks another R2 binding).

## Point the SDKs at it

The DSN is `https://<public key>@<your host>/sentry/<project id>`:

```ts
import * as Sentry from "@sentry/react";
Sentry.init({ dsn: "https://k7f3a9c2e1d04b58@app.example.com/sentry/web", release: "web@1.2.3" });
```

The same works for `@sentry/react-native` and `@sentry/cloudflare`. Items handled: `event`, `transaction` (sampled by
`transactionSampleRate`, kept as Analytics Engine points), `session`/`sessions`, `attachment` (R2, up to 1 MiB) and
`replay_event`/`replay_recording` (R2, up to 10 MiB). Gzip and deflate bodies are accepted; answers are Sentry's
(200 `{ id }`, 413, 429 with `Retry-After` and `X-Sentry-Rate-Limits`).

From your own actions:

```ts
import { sentryCapture } from "@freecorps/ember-sentry";
try { await charge(); } catch (e) { await sentryCapture(ctx, components.sentry, e, { project: "api", tags: { step: "charge" } }); throw e; }
```

Mutations and queries cannot do I/O: let the error throw and turn on `onError`.

A tiny SDK is included for apps that do not want the official one:

```ts
import { init, captureException } from "@freecorps/ember-sentry/client";
init({ dsn: "https://k7f3a9c2e1d04b58@app.example.com/sentry/web", release: "web@1.2.3" }); // also hooks error / unhandledrejection
```

## Source maps

Upload the maps of each release from CI:

```sh
EMBER_SENTRY_UPLOAD_TOKEN=… ember sentry sourcemaps upload --project web --release web@1.2.3 --env production dist/
```

Each map is named after the script that references it (`//# sourceMappingURL=`), as a URL path (`~/assets/app-3f2a.js`,
`--url-prefix` when the scripts are served under a sub-path), with its debug id (`//# debugId=` or the map's
`debugId`). Maps are stored once per content (SHA-256); uploading the same build for another release only sends the
manifest. The CLI uses two admin routes you can call yourself: `POST /sentry/admin/sourcemaps` and
`PUT /sentry/admin/sourcemaps/blobs/<sha256>` (`Authorization: Bearer $EMBER_SENTRY_UPLOAD_TOKEN`, or
`EMBER_ADMIN_TOKEN`).

The consumer symbolicates frames before grouping, so a new build does not split an issue.

## Issues, grouping and status

An issue is one `(project, fingerprint)`. The default fingerprint is the exception type plus the top 5 in-app frames
(file and function, after symbolication), or the normalized message; `event.fingerprint` overrides it (with
`{{ default }}` expanded). Each row keeps `count`, `firstSeen`, `lastSeen`, `level`, `status`, `title`, `culprit`,
`release`, events per hour (24 h) and the symbolicated stack of the latest event; the full event is read back from R2.

`lib:setStatus` resolves, ignores or reopens an issue. A new event of a resolved issue reopens it (a regression);
ignored issues keep counting and never alert.

## Alerts

New issue and regression (on by default) and spike (`spike: { events, windowMinutes }`), decided in the same
transaction as the issue write, throttled per issue (`throttleMinutes`, 30) and per project (`maxPerHour`, 20).
Delivered as signed webhooks (`x-ember-sentry-signature: t=<unix>,v1=<HMAC-SHA256 hex of "t.body">`, check it with
`verifyWebhook`) and/or through a mutation of your app, where you send them with the email or push component:

```ts
// ember/alerts.ts
import { alertEmail, alertPush, vAlertArgs } from "@freecorps/ember-sentry";
export const notify = internalMutation({
  args: vAlertArgs,
  handler: (ctx, { alert }) => {
    email.send(ctx, { from: "alerts@example.com", to: "oncall@example.com", ...alertEmail(alert, { link: `https://dash.example.com/issues/${alert.issueId}` }) });
    push.send(ctx, ["oncall-user-id"], alertPush(alert));
  },
});
// config: alerts: { handler: "<createFunctionHandle(internal.alerts.notify)>" }
```

## Time series (Analytics Engine)

One point per event, session update, kept transaction and dropped item in the `ember_sentry` dataset. Crash-free
sessions of a release:

```sql
SELECT 1 - SUM(_sample_interval * double2) / SUM(_sample_interval * double1) AS crash_free
FROM ember_sentry WHERE blob1 = 'session' AND blob2 = 'web' AND blob3 = 'web@1.2.3' AND timestamp > NOW() - INTERVAL '7' DAY
```

Events per hour of an issue: `blob1 = 'event' AND blob6 = '<fingerprint>'`.

## Retention

Everything in R2 except the maps lives under day prefixes (`events/`, `spill/`, `attachments/`, `replays/`). A daily
cron deletes the prefixes older than `retentionDays` (30), in batches of 5000 objects. R2 lifecycle rules cannot be set
from a component; if you set one on the bucket for `sentry/`, keep it at least as long.

## Dashboard

The component adds an "Errors" screen: issues (filters by status, level, release and project; resolve, ignore,
reopen), the detail of an issue with its symbolicated stack and events per hour, the latest event with source context,
breadcrumbs and contexts (an `embed` block over `@freecorps/ember-dashboard-sdk`), and the source maps of each release.

TODO: a session replay player (the recordings are stored in R2 under `replays/`, not rendered yet).

## Cost

| Step | Durable Object rows written |
|---|---|
| Ingest (per envelope) | 0 |
| Consumer batch (up to 100 events) | about 1 per issue in the batch (5 entries on a new issue, 4 on an update, index entries included) |
| Alerts | 1 `alertState` row per project per hour when one fires |

Plus one R2 put per batch (and per attachment or replay segment) and one Analytics Engine point per event.

Contract: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) "Sentry".
