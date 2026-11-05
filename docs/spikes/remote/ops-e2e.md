# Ops E2E on Cloudflare production: restore, pre-warm, key rotation, R12/R14/R15

Run on 2026-11-05 between 01:17 and 02:05 UTC on the FreeCorps account (`<ACCOUNT_ID>`), using only
`*.<subdomain>.workers.dev` URLs. The load benchmark from the same session is in `bench.md`.

- **Resources.** Only `ember-spike-*` resources were created:
  - the project Worker `ember-spike-ops-test` (project `spike-ops`, env `test`, with Shard/System/Auth DOs);
  - the registry D1 `ember-spike-ops-registry`;
  - the load generator `ember-spike-ops-loadgen`;
  - the probe Worker `ember-spike-ops-probe`.

  All of them were deleted and checked with a GET (see Cleanup).
- **Drivers.**
  - `scripts/ops-e2e.ts` (phases `deploy`, `restore`, `prewarm`, `bench`, `keys`, `cleanup`, `inventory`) calls
    the CLI's programmatic API and the real `ember` entry (`main([...])`).
  - `scripts/probes.ts` runs the R12/R14/R15 probes.
  - Run them with `bun --conditions=@freecorps/ember-source run …`.
- **Client.** The same macOS laptop in Campinas (Bun 1.4, `fetch` and the global `WebSocket`). Requests entered
  Cloudflare at GIG.
- **Secrets.**
  - The Cloudflare token came from the CLI's wrangler fallback and stayed in process memory.
  - The project admin token, the load-generator token and the probe token were random per process and only uploaded
    as `secret_text`. When a later phase ran in a new process, the admin token was re-uploaded with `PUT …/secrets`;
    it was never stored.
  - Test users had random `@example.com` emails and random passwords.
  - Output was redacted before printing: account id, workers.dev subdomain, emails, local paths.
- **Evidence.** `evidence/ops-*.json`, `evidence/ops-e2e-*.log` and `evidence/probes-*.{json,log}`.

## 1. `ember restore` (PITR)

Flow on shard `room:a`:
1. Write 3 rows, then `ember restore --shard room:a --mark before-import`.
2. Write 3 more rows.
3. `--list`, restore to the mark, undo, restore to a time, undo again.
4. Try a target outside the 30-day window.
5. Deploy v2, which adds an index and therefore migrates.
6. Write to `room:a` and `room:b`, then `ember restore --all --to deploy:<v2>`.

During steps 1–3 a live `EmberClient` stayed subscribed to `bench:count` on `room:a`.

| Step | Result | CLI wall time (laptop → Worker → DO restart) |
|---|---|---|
| `--mark before-import` | bookmark `00000000-00000010-0000511a-…` recorded as `manual:before-import` | |
| `--list` | `migrate` + `manual:before-import`, with age | |
| `--to <mark> --yes` | rows **6 → 3**; printed `undo: … --to 00000000-ffffffff-…` | **1,085 ms** |
| live subscriber | reconnected (new epoch → full `snap`) and showed **3** | |
| `--to <undo> --yes` | rows **3 → 6** | 1,278 ms |
| `--to 2026-11-05T01:18:56Z` (1 s after the mark) | resolved to the mark (newest bookmark at or before), rows **3** | 1,076 ms |
| undo again | rows **6** | |
| `--to 2026-09-01T00:00:00Z` | refused: `outside the 30-day PITR window` (nothing changed) | |
| deploy v2 (adds index `by_sent`) | first boot of every shard recorded `deploy:9efe0750-…` **before** migrating | |
| writes after v2 | a 6 → 9, b 3 → 6, c 3 | |
| `--all --to deploy:9efe0750-… --yes` | plan listed 4 catalog shards. Result: **a 6, b 3, c 3** (the state when v2 went live); undo bookmarks saved to `.ember/restores/<label>.json` | 6,610 ms (4 shards, concurrency 4) |
| status after `--all` | `room:a`/`room:b` back on the **v2 schema**: the restored DB predates the v2 migration, and the next boot migrated it again | |

- **Undo bookmarks.** They look like `0000000N-ffffffff-…`, as in R6. Each restore added `pre-restore:<id>`,
  `undo:<id>` and `restore:<id>` rows.
- **Bookmark rows survive the restore.** The restored database only has the older rows; `restoreFinish` re-imports the
  newer ones (see the `room:a reasons now` line in the log).
- **The catalog behind `--all`.** It comes from the registry's `shards` table. Listing bookmarks wakes each shard, so
  `room:c`, which had not booted under v2 yet, recorded `deploy:v2` at that moment and was restored to its own
  (unchanged) state.

## 2. Shard pre-warm (PLAN §19 "Primeira requisição")

- **What changed.**
  - `EmberClient` now opens the shard WebSocket **while** it fetches the auth token: TLS, the Worker and the Durable
    Object's cold wake overlap the token round trip.
  - Subscriptions are sent right after `hello`, without waiting for `ready`. The server handles a socket's frames in
    order, so this saves one round trip.
  - The Worker no longer awaits a separate `warm()` RPC before forwarding the upgrade. That saves one internal
    Worker→DO hop; with a token in the upgrade it still warms in parallel with verification.
  - `pipelineConnect: false` restores the old serial order (token → socket → `hello` → `ready` → `sub`). That is the
    "before" below.
- **Method.**
  - A real Better Auth user was created on the deployed project. Each trial built a fresh `EmberClient` whose `auth`
    callback calls `GET /api/auth/token` (Auth DO), subscribed `bench:recent` on a shard, and stopped the clock at the
    first server snapshot.
  - **Cold**: 16 new shards per round, written once, then left idle for 100 s. R8 found that a wake after ~75 s idle
    costs 56–60 ms.
  - **Warm**: the same shard right after.
  - Variants alternated shard by shard; 3 rounds gave n = 24 per cell.

| Time to first snapshot (ms), new client | p50 | p95 | p99 |
|---|---|---|---|
| serial (before), cold shard | 1,384 | 1,712 | 1,730 |
| **pipelined (after), cold shard** | **944** | **1,254** | 1,350 |
| serial (before), warm shard | 1,171 | 1,464 | 1,564 |
| **pipelined (after), warm shard** | **839** | **1,028** | 1,075 |
| token fetch alone (all trials) | 174 | 278 | 702 |

- **Gain.** Cold p50 drops 440 ms (−32%) and warm p50 drops 332 ms (−28%).
- **The cold penalty shrinks.** It was 213 ms serial and is 105 ms pipelined: the wake now overlaps the token fetch.
- **The rest is network.** From Campinas to MIA/IAD, a fresh client still pays TLS (~260 ms, R8), the token round trip
  and one WebSocket round trip.

## 3. Key rotation (`ember keys rotate`)

On the same Worker, after a redeploy with this branch's runtime:

| Step | Result |
|---|---|
| before | JWT T1 (kid `YS9u…`) accepted by `users:me` |
| `ember keys rotate --env test --jwt` (4.9 s) | new kid `JsbP…`; both kids published; `EMBER_AUTH_JWKS` refreshed (2 keys). T1, the new T2 and the session token all accepted. No sign-out. |
| `ember keys rotate --env test --auth-secret --yes` (15.5 s, including an 8 s settle) | `EMBER_AUTH_SECRET_R1` added, plus a new JWT key `rMbf…` minted under it. JWKS has 3 keys. T1 and T2 still verify (until their 5 min `exp`). The old session can no longer mint JWTs (signed with the old secret), as documented. A new sign-up works and gets a token with the new kid. |
| secrets afterwards | `EMBER_ADMIN_TOKEN`, `EMBER_AUTH_JWKS`, `EMBER_AUTH_SECRET`, `EMBER_AUTH_SECRET_R1` |

- **`--files`.** It rotates `EMBER_STORAGE_SECRET` by generation. It was covered by tests (`runtime/test/keys.test.ts`:
  URLs signed by the previous generation still verify) but not run remotely, because the spike project had no files
  bucket.

## 4. R12: APNs over HTTP/2 from a Worker (no Apple credentials)

| Check | Result |
|---|---|
| ES256 in a Worker (WebCrypto P-256, PKCS#8 import like an Apple `.p8`, JWS signature) | 64-byte raw `r‖s` signature, verifies |
| `POST https://api.sandbox.push.apple.com/3/device/<64 zeros>` with a bogus provider JWT | **HTTP 403 `{"reason":"InvalidProviderToken"}`** with an `apns-id` header, 347 ms |
| Same against `api.push.apple.com` | **403 `InvalidProviderToken`**, 243 ms |
| Expo Push (`exp.host/--/api/v2/push/send`) with an invalid token | 200, per-ticket `DeviceNotRegistered` |

- **APNs is reachable from Workers `fetch`.** APNs only speaks HTTP/2, and it answered with its own JSON error and
  `apns-id`, so `fetch` negotiated HTTP/2 with Apple. Provider-token JWTs can be signed in the Worker with WebCrypto
  alone.
- **Not tested** (needs Apple credentials and a device): a valid `.p8` key and team/key ids, a real device token,
  topic/push-type rules, delivery latency, and token caching (APNs wants the provider token reused for 20–60 min).

## 5. R14: HEIC through the Images binding

A 1200×1200 HEIC (HEVC, 43,891 bytes, converted locally with `sips` and not committed) and a PNG control of the same
image went through the `images` binding (`info` + `input().transform({width/height 256, fit: scale-down}).output()`):

| Input → output | `info()` | Output | Time |
|---|---|---|---|
| HEIC → WebP | `image/heic`, 1200×1200 | `image/webp`, 51,996 B (RIFF…WEBP) | 399 ms (first call) |
| HEIC → JPEG | same | `image/jpeg`, 8,494 B | 75 ms |
| HEIC → AVIF | same | `image/avif`, 5,234 B | 130 ms |
| PNG → WebP (control) | `image/png`, 1200×1200 | `image/webp`, 47,656 B | 245 ms |

- **HEIC input is supported.** iPhone photos can go straight to `ctx.images.thumbnail`; no fallback is needed.
  Note that WebP of this flat image came out larger than JPEG.

## 6. R15: Cron Trigger limits and timing

- **Account consumption.** At the time, the other 25 scripts in the account used 4 Cron Triggers.
- **Per Worker.** `PUT …/schedules` accepted 1, 3, 4, 5, 10, 20 and **50** distinct expressions on one Worker (the
  probe stopped at 50). There is no small per-Worker limit; the budget is the account's (250 on Paid, 📄).
- **Syntax.**
  - A 6-field expression with seconds is refused: `10100: invalid cron string`.
  - A `CRON_TZ=` prefix is refused: triggers are UTC only.
  - Quartz `L` and `#` are accepted (`0 9 L * *`, `0 9 * * 1#2`).
  - Duplicate expressions are refused (`10100: duplicate cron found`).
- **Propagation.** On a freshly uploaded Worker, `* * * * *` fired for the first time **666 s (~11 min)** after the
  schedule was set: 0 fires in minutes 1–10, then every minute (4 fires in the next 4 minutes). Account analytics
  (`workersInvocationsScheduled`) showed no scheduled invocation before that.
- **Timing once running.** From `controller.scheduledTime` to the handler's `Date.now()`: **309, 317, 542, 790 ms**
  (`evidence/probes-r15-cron.json`). The first probe run (`probes-r12-r14-r15.json`) waited only ~4 minutes and saw 0
  fires, for the same propagation reason.
- **How Ember maps onto this.** Ember uses **one** trigger per project environment (`* * * * *`, only when `crons.ts`
  defines crons). The System DO evaluates every `crons.ts` entry per minute, with time zones, which the platform cannot
  do. So N crons cost 1 of the account's 250 triggers, and Quartz extensions and seconds are not needed.
- **Propagation consequence.** After the **first** deploy of an environment, its crons may start ~11 minutes late.
  Missed minutes are coalesced by the System DO's 60-minute catch-up window, but a cron due during the gap runs late.
  `ember deploy` now prints this.

## Cleanup

`evidence/ops-e2e-cleanup.log` and `evidence/probes-*.log`:

| Resource | Delete | Verification GET |
|---|---|---|
| Worker `ember-spike-ops-test` (Shard/System/Auth DO namespaces) | `DELETE /workers/scripts/…?force=true` → ok | `GET …/settings` → **10007** (no such script) |
| Worker `ember-spike-ops-loadgen` (Agent DO namespace) | ok | **10007** |
| Worker `ember-spike-ops-probe` (Log DO namespace; deleted by each probe run) | ok | **10007** |
| D1 `ember-spike-ops-registry` | `DELETE /d1/database/<id>` → ok | `GET /d1/database/<id>` → **7404** (not found) |
| Inventory after cleanup | | 0 `ember-spike*` scripts, 0 DO namespaces, 0 D1 databases |

- **Local files.** The scratch project in `packages/cli/.tmp/` (with its `.e2e-state.json`, which held URLs and
  version ids only) was removed, as were the local HEIC/PNG samples.
- **No Analytics Engine dataset.** The project ran with `metrics: { enabled: false }`, so none was created.
