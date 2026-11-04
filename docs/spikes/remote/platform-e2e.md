# Platform E2E on Cloudflare production (PLAN §11, §14, §21 — Phase 4b)

Run on 2026-11-04, around 20:52–21:10 UTC, on the FreeCorps account (`<ACCOUNT_ID>`). Only `ember-spike-*` resources
were created; all were deleted at the end (see Cleanup).

- **Project.** `ember init --project spike-dash` in `packages/cli/.tmp/ember-spike-dash` (so `@ember/*` resolve to the
  workspace), `ember.json` edited to: `environments: { test: { vars: { EMBER_TRACE: "1" } } }`,
  `metrics: { dataset: "ember_spike_metrics" }`. Worker: `ember-spike-dash-test`.
- **Registry override.** `EMBER_REGISTRY_NAME=ember-spike-registry` (same as `--registry ember-spike-registry`).
- **Dashboard.** Deployed as `ember-spike-dashboard` (`deployDashboard({ name })`, same code as
  `ember dashboard deploy --name`).
- **Driver.** One Bun script calling the CLI's programmatic API (`deploy`, `D1Registry`, `streamLogs`, `addDomain`,
  `deployDashboard`) plus `fetch` against the deployed URLs.
- **Secrets.** The Cloudflare token came from the CLI's wrangler fallback. The project admin token and the dashboard
  token were random per run, kept in process memory only and redacted from all output (`<admin>`, `<dash>`). The
  dashboard's `CF_API_TOKEN` (Analytics Engine SQL) was the same short-lived wrangler OAuth token, uploaded as a
  `secret_text` of the throwaway dashboard Worker and gone with it. Nothing was written to files.

## 1. Deploy with registry + metrics (`ember deploy --env test --wait`)

```
  registry: created D1 database ember-spike-registry
deploy ember-spike-dash-test: create (new DO classes: Shard, System)
  bundle 268.4 KiB sha256 9d0c670afb34
  uploaded ember-spike-dash-test (created Shard, System)
  cron triggers: * * * * *
  registry: recorded spike-dash/test
ember-spike-dash-test → https://ember-spike-dash-test.<subdomain>.workers.dev
waiting for shards to migrate (schema 4b4ebf8324bf)...
  shards ready: global:main
```

- The first deploy created the D1 registry (all 7 tables via one multi-statement `POST /d1/database/{id}/query`).
- `ember.json` got a `fingerprint` (uuid).
- The Worker got `{"type":"d1","name":"EMBER_REGISTRY","id":"92f39794…"}` and
  `{"type":"analytics_engine","name":"EMBER_METRICS","dataset":"ember_spike_metrics"}`. Both binding types upload fine
  in a Script PUT next to the DO `exports`.

## 2. Ownership: same project name from another repo

A copy of the project without `fingerprint` (= another repository) deploying `spike-dash/test`:

```
{"refused":true,"message":"project \"spike-dash\" is already registered in this account by another repository
 (https://github.com/freecorps/ember.git). Rename \"project\" in ember.json, or — if this repo really owns it — set
 \"fingerprint\" in ember.json to the registered one (see `ember projects ls`)."}
```

Refused before any Workers API call (verified in the mocked test too).

## 3. Traffic + `ember logs` (tail API, `trace-v1` WebSocket, filter `--fn messages:send`)

Traffic: 12 × (`messages:send` + `messages:list` + `messages:count`), every third on `global:spike2`, the rest on
`global:main`, plus one failing `messages:edit` (`id: "not-an-id"`). All HTTP 200 except the failing edit (400).

```
events: 32, filtered lines: 7
tailing ember-spike-dash-test (session 69930445) — Ctrl-C to stop
20:53:17.369 ok Shard
  20:53:17.369 mutation     messages:send global:spike2 ok 0ms r1/w4 63B
20:53:20.208 ok Shard
  20:53:20.208 mutation     messages:send global:spike2 ok 0ms r1/w4 63B
```

- `POST /workers/scripts/:name/tails` → `{id, url}`; WebSocket with subprotocol `trace-v1`; `DELETE .../tails/:id` on
  exit.
- Executions run in the Shard DO, so tail events carry `entrypoint: "Shard"` (no request URL); the `ember:exec` lines
  (`EMBER_TRACE=1`) are what makes `--fn/--shard` filtering work.
- Event count (32) is lower than the number of executions: tail is sampled/batched by the platform, and the window
  started ~4 s after session creation.

## 4. Shard catalog (registry `shards`, written by the shards through the D1 binding)

```
[{"shard":"global:main","kind":"global","key":"main","schema":"4b4ebf8324bf","db_size":114688,"last_write":null,
  "reported_at":1793825589779},
 {"shard":"global:spike2","kind":"global","key":"spike2","schema":"4b4ebf8324bf","db_size":114688,"last_write":null,
  "reported_at":1793825597219}]
```

- Each shard reported right after its first migration (the report waits for the shard to learn its name, then runs in
  `ctx.waitUntil`). `last_write` is null because the first report precedes the first write; it is filled by the hourly
  maintenance report (not observed in this short run).

## 5. Admin data browser (`GET /api/_ember/data`)

```
shard=global:main&table=messages&limit=3 → 200, rows 3, done false, cursor "3", first body "hello 1"
no token → 401
```

## 6. Dashboard (`ember-spike-dashboard`, token auth, service binding to the project)

```
deployed ember-spike-dashboard (241.8 KiB, 1 project service binding) → https://ember-spike-dashboard.<subdomain>.workers.dev
GET /                → 200 <!doctype html>…
GET /api/projects    → 401 without token; 200 with: spike-dash → test:ember-spike-dash-test:2 shards
GET /api/shards?project=spike-dash&env=test&status=1 → 200, catalog 2, live (via service binding → /api/_ember/status):
    global:main   ready true size 118784 schema 4b4ebf8324bf
    global:spike2 ready true size 118784 schema 4b4ebf8324bf
GET /api/crons       → 200: "trim-general 0 * * * * messages:trim last=-"
GET /api/data?…shard=global:spike2&table=messages&limit=2 → 200, rows 2, cursor "2"
GET /api/data?…shard=global:main (tables) → messages 8 (schema), _jobs 0, _files 0, _ember_migrations 1, _ember_bookmarks 1
GET /api/functions?project=spike-dash&env=test&hours=1 → 200, 4 functions (below)
```

- The dashboard reaches the project Worker through a **service binding** (`EMBER_SVC_0`), not the public workers.dev
  URL. Worker → Worker fetches between workers.dev hosts of the same account have historically failed (error 1042);
  the fetch fallback was not exercised here.

## 7. Analytics Engine (dataset `ember_spike_metrics`, SQL API with the wrangler OAuth token)

`SHOW TABLES` → `ember_spike_metrics` (created on first write). `ember metrics` / dashboard query result:

| fn | kind | calls | errors | p50 ms | p95 ms | rows read/call | rows written | bytes out |
|---|---|---|---|---|---|---|---|---|
| messages:list | query | 13 | 0 | 0 | 0 | 3.0 | 0 | 5005 |
| messages:send | mutation | 12 | 0 | 0 | 0 | 1.0 | 48 | 756 |
| messages:count | query | 11 | 0 | 0 | 0 | 4.7 | 0 | 11 |
| messages:edit | mutation | 1 | 1 | 0 | 0 | — | 0 | 0 |

- `SELECT count()` returned 21 stored rows for ~37 executions: Analytics Engine sampled them itself
  (`_sample_interval` = 2 on several rows). Weighted by `_sample_interval * double5`, `messages:send` comes out at
  exactly 12 — weighting is required, `count()` is wrong.
- **Bug found and fixed:** `SUM(IF(blob6 = 'error', _sample_interval * double5, 0))` → 422 "the 2nd and 3rd arguments to
  IF() function must have the same type (Double and Integer)". Fixed with `0.0` (commit `fix(dashboard): …`).
- Both `quantileExactWeighted(q)(col, w)` and `quantileWeighted(q, col, w)` are accepted.
- **Durations are 0.** workerd only advances `performance.now()`/`Date.now()` across I/O, and queries/mutations are
  synchronous inside the DO, so the per-execution duration measured in the shard is 0 (actions, which do I/O, get real
  durations). p50/p95 for queries/mutations need another source (see Gaps).

## 8. `ember domains add` (dry run on a real zone, no write)

```
[dry run] ember-spike-dash.freecorps.com.br (zone freecorps.com.br) is free; would attach it to ember-spike-dash-test
```

Zone lookup (`GET /zones?name=`), `GET /workers/domains?zone_id=`, `GET /zones/:id/workers/routes` and the registry were
all read; no Custom Domain was attached (it would create DNS records outside `ember-spike-*`). The attach path
(`PUT /workers/domains`) is covered by the mocked test only.

## 9. `ember projects ls` (registry read)

```
spike-dash  (https://github.com/freecorps/ember.git)  fingerprint 2fde8904…
  test  ember-spike-dash-test  https://ember-spike-dash-test.<subdomain>.workers.dev  schema 4b4ebf8324bf
```

## Cleanup

```
DELETE worker ember-spike-dash-test: 200 ok          (?force=true: also drops its DO namespaces)
DELETE worker ember-spike-dashboard: 200 ok
DELETE d1 ember-spike-registry: 200 ok
remaining ember-spike workers: []
remaining ember-spike D1: []
remaining ember-spike DO namespaces: []
tails on deleted worker: 404
```

- The Analytics Engine dataset `ember_spike_metrics` is still listed by `SHOW TABLES`: Analytics Engine has no API to
  delete a dataset. Its 21 rows expire with the platform retention (3 months); it holds no secrets (project name,
  function names, counters).
- The local scratch project in `packages/cli/.tmp/` was removed.

## Gaps

- Query/mutation durations are 0 inside the DO (frozen clock without I/O). Options: time from RPC arrival to response in
  the Worker (includes the hop), or Workers Analytics `cpuTime`/`wallTime` per invocation (GraphQL), joined by time.
- Cloudflare Access was not configured in front of the spike dashboard (token fallback exercised live; Access JWT
  verification is covered by a unit test with a generated RS256 key).
- The hourly catalog refresh (`last_write`) and the real `PUT /workers/domains` attach were not observed live.
