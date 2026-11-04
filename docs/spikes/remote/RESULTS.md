# Remote spike results (Cloudflare production, FreeCorps account)

Run on 2026-11-04, between 16:35 and 17:20 UTC, against account `<ACCOUNT_ID>`, using `*.<subdomain>.workers.dev` URLs only.

- **Resources.** Only `ember-spike-*` Workers were created, together with their DO namespaces. No D1, queues, routes or domains were created. Everything was deleted at the end (see the last section).
- **Client.** A macOS laptop in **Campinas** (from ipinfo.io), using Node 24 and `ws@8`.
- **Plan.** The account is on **Workers Paid**. The evidence is that `limits.cpu_ms = 300000` was accepted on upload (`{"limits":{"cpu_ms":300000}}`), and that setting is only available on Paid. The OAuth token can't read `/subscriptions` (`10000 Authentication error`).
- **Token.** The OAuth token came from `npx wrangler auth token`. It was read into process memory or a shell variable only, and never printed or written to a file. The Better Auth secret was generated at upload time with `crypto.randomBytes` and sent as a `secret_text` binding, never stored.
- **Evidence.** Raw outputs are in `evidence/`. Code is in `lib/`, `workers/`, `scripts/` and `auth/` (a copy of `../better-auth` with secret and baseURL taken from env).

## Summary table

| # | Result | Key evidence | Implication for PLAN.md |
|---|---|---|---|
| R1 | **Both work in a single upload without wrangler.** `exports` and `migrations` each create a SQLite DO class *and* its binding in one multipart PUT. They are mutually exclusive. `exports` gives strict drift detection plus rename and delete tombstones. | `evidence/r1-*.json` | The CLI deploys through raw REST. Use **`exports`** as the source of truth; the "two applies" problem does not exist for script upload. |
| R2 | Code-only version plus a 10/90 deployment works. **DO ids are 100% sticky**: 30 ids × 100 requests, every id on a single version, 2/30 ids on the new version. The front Worker split was 10.4%. **Every version must carry identical `exports`**, or the deploy fails with `100405`. A version that *adds a class* through `exports` can be deployed at 100% through the Deployments API. | `evidence/r2.json`, `r2-attempt1.json` | `ember deploy` = always send the full `exports` map. Gradual rollout only when `exports` is unchanged. Lifecycle changes go at 100% (Versions or Script PUT). |
| R3 | 5-year alarm accepted and persisted across `ctx.abort()` and 100 s idle. 60 s alarms (20 DOs): **delay p50 2 ms, p95 15 ms, max 15 ms**. | `evidence/r3.json` | Scheduler: one DO alarm = `MIN(run_at)` is fine. No horizon cap is needed. |
| R4 | **10,000 hibernatable sockets on one DO: 0 failures.** Stopped at 10k as instructed. Broadcast to 10k: server-side send loop ~1.0–1.3 s, last client received at 2.4–2.8 s. Still worked after 15 s of idle (hibernation). | `evidence/r4-wsmax-a.json` | Plan for ≤ ~5k subscribers per shard for sub-second fan-out. Beyond that, fan out through child "presence" DOs. |
| R5 | Row limit: **max BLOB = 8,388,636 bytes (~8 MiB)**. 8,388,637 fails with `string or blob too big: SQLITE_TOOBIG`. **The documented 2 MB is not enforced.** PRAGMA and function blocklist **identical to local**. **Alarm that throws: SQL and KV writes are NOT rolled back** (same as local). FTS5 unicode61 rd=2, trigram, bm25, snippet and highlight all work. | `evidence/r5-*.{json,txt}`, `r3.json` (`rb_result`) | Keep the ≤ 2 MB doc limit as the product limit (headroom). Alarm handlers must use `transactionSync` or be idempotent. |
| R6 | `getCurrentBookmark` + `onNextSessionRestoreBookmark` + `ctx.abort()` **restores exactly** (rows reverted), and the returned undo bookmark re-applies the newer state. `getBookmarkForTime` is **coarse and lagging**: it fails on young DOs (`Requested time is before this database existed.`), and on older DOs it resolves to an earlier checkpoint (it dropped a write made 30 s before the target time). | `evidence/r6*.{json,txt}` | `ember restore` should use **bookmarks we record ourselves** (e.g. per deploy, per migration, hourly). Treat time-based restore as approximate. |
| R7 | 200 sign-ups at c=20, 0 errors, no CPU-limit errors. **DO-hash: 10.4/s, p50 1.79 s, p95 2.79 s.** **Worker-hash: sign-up 6.5/s, p50 3.0 s, p95 3.36 s; sign-in 39/s, p50 441 ms, p95 753 ms** (vs 10.7/s, p50 1.74 s in DO-hash). Worker CPU p50 with hashing = **96.5 ms** (scrypt in prod ≈ 90 ms, vs 36 ms locally). | `evidence/r7-*` | The auth DO caps at ~10 hashes/s. Hash in the Worker, **and do not hold a storage transaction across the hash RPC** (sign-up does, which serializes it). |
| R8 | From Campinas, workers.dev traffic lands in **MIA** (VCP only for 1.1.1.1 and occasionally otherwise). **`locationHint:"sam"` does not place DOs in South America**: they land in MIA, ATL, ORD or EWR. HTTP query p50 148 ms / p95 197 ms. Mutation p50 178 ms. WS mutation→ack p50 161–167 ms, →patch on another socket p50 163 ms. Cold wake of an existing DO **~56–60 ms** (Worker-side). New DO creation 190–490 ms. Hibernated socket shows no wake penalty. | `evidence/r8*.json` | Latency is network-dominated (~130 ms to MIA). PLAN's "São Paulo → `sam`" assumption is wrong for now. Placement can't be pinned to BR; optimistic updates in clients are mandatory. |
| X1 | One DO, 3 row writes/mutation: **~1.1–2.2k msgs/s with 1 mutation per WS message** (saturates; ack p50 rises to ~1 s at 2,000 in flight). **Batching 10/txn: 6.7–10.5k mut/s. Batching 100/txn: 32.5k mut/s.** CPU (GraphQL analytics): **~166 µs per single-mutation message**, **~17–20 µs per mutation** inside a batch, so ~120–150 µs is fixed per event. | `evidence/x1-*` | Group commit (many mutations per event / per `transactionSync`) is a ~15× throughput lever. Design the shard runtime to coalesce queued mutations per turn. |
| X2 | `await ctx.storage.sync()` after a write: **32–34 ms (p50) in MIA, 22 ms in EWR**. Client RTT: mutation − query = **~30 ms** p50 (178 vs 148). WS mutation vs WS ping without write: 167 vs 133 ms = **~33 ms**. | `evidence/r8-http.json`, `r8-ws-cold.json` | The output gate adds ~30 ms to every acknowledged write. Every round trip pays it unless acks are optimistic. |

---

## R1: programmatic deploy without wrangler

How it was done:
- Token from `npx wrangler auth token` (OAuth; it worked for every Workers Scripts, Versions, Deployments, DO namespace and GraphQL call).
- Multipart `PUT /accounts/{id}/workers/scripts/{name}`, with a `metadata` part plus `index.js` as `application/javascript+module` (`lib/cf.mjs`).
- Each upload had a DO binding `{type:"durable_object_namespace",name:"SHARD",class_name:"Shard"}` and `version_metadata`.

| Case | Response |
|---|---|
| `exports:{Shard:{type:"durable-object",state:"created",storage:"sqlite"}}` + binding, first upload | **200**. `exports_reconciliation:{created:["Shard"],...}`. Namespace `use_sqlite:true`. The first fetch works (DO SQL insert). |
| Same `exports` re-uploaded | 200. `reconciliation.created: []` (idempotent). |
| Live form without `state`: `{type:"durable-object",storage:"sqlite"}` | 200, no changes. This is the steady-state form. |
| Re-upload **without** `exports` once a class exists | **400 `100402`**: `Durable Object exports reconciliation failed: [provisioned_class_missing_from_config] class 'Shard' has a provisioned Durable Object namespace (...) but is not declared in exports. Every provisioned class must be declared in exports (live or tombstone); silent drift is not permitted.` (with `meta.details[].suggestion`). |
| `exports` **and** `migrations` together | **400 `100400`**: `` `exports` and `migrations` are mutually exclusive; please specify only one.`` |
| Add class `Extra` with `state:"created"` | 200, `created:["Extra"]` |
| Rename `Shard→Shard2` (`{state:"renamed",renamed_to:"Shard2"}`), delete `Extra` (`{state:"deleted"}`) | 200, `renamed:[{from:"Shard",to:"Shard2"}]`, `deleted:["Extra"]`. **Data preserved**: the counter continued at n=3,4,5 after the rename. For a few seconds after upload, the old code was still served. |
| Classic `migrations:{new_tag:"v1",new_sqlite_classes:["Shard"]}` + binding, first upload | **200** (`migration_tag:"v1"`). DO works, `use_sqlite:true`. **No two-step problem.** |
| `migrations` with wrong `old_tag` | **412 `10079`**: `Actor migration tag precondition failed, got tag 'WRONG' when expected tag is 'v1'.` |
| Code-only re-upload with no `migrations` | 200 (the migration tag is kept) |
| Binding to a class never declared (no exports, no migrations) | **400 `10061`**: `Cannot create binding for class 'Shard' because it is not currently configured to implement Durable Objects. Configure a migration in your configuration to add this class.` |

## R2: Versions API and gradual deployment

Endpoints used: `POST /workers/scripts/{name}/versions` (multipart, same format as upload) and `POST /workers/scripts/{name}/deployments {strategy:"percentage",versions:[...]}`.

**Version uploads:**
- A version upload **without** `exports` on an exports-managed script is accepted (200). Deploying it then fails.
- `migrations` in a version upload is rejected: **400 `10211`** `Version upload failed. You attempted to upload a version of a Worker that includes a Durable Object migration, but migrations must be fully applied via a non-versioned deployment.`
- A version upload that *changes* `exports` (adds `New3`) is accepted (200).

**Deployments:**
- 10/90 with a version whose `exports` differ: **400 `100405`** `All versions in a multi-version deployment must declare identical exports. Deploy the version that changes exports at 100% first, then split traffic.`
- 100% deploy of a version without `exports`: **400 `100402`** (the same reconciliation error as R1).
- 10/90 with identical `exports`: **200**. 30 DO ids × 100 requests (c=20): **every id served by exactly one version**. **2/30 ids** were on the new version. Front Worker versions were split 312/3000 (10.4%) new.
- Promote to 100%: within ~15 s, all ids (including the previously old ones) were on the new code, with state intact (n=202).
- **Deploying the lifecycle-changing version (adds `New3`) at 100% through the Deployments API: 200**, and namespace `ember-spike-r1-exports_New3` (`use_sqlite:true`) was created. With `exports`, a lifecycle change no longer needs a Script PUT.

## R3: alarms

| Check | Result |
|---|---|
| `setAlarm(now + 5y)` | Accepted. `getAlarm()` = `1951491294707` (2031-11). |
| After `ctx.abort()` (the request returns a 500 Cloudflare error page) | `getAlarm()` is unchanged. `bootAgeMs:0` confirms a new instance. |
| After 100 s idle | Unchanged. |
| 60 s alarm, 20 DOs in parallel | 20/20 fired. `fired − scheduled` ms = `[1,3,2,1,2,1,3,1,2,2,3,3,2,1,15,2,1,1,1,1]`: **p50 2, p95/max 15**. `alarmInfo = {retryCount:0,isRetry:false}`. |
| Retry after throw | First retry ran ~2.07 s after the scheduled time (`retryCount:1,isRetry:true`), matching the local measurement. |

## R4: WebSockets per DO

- **Setup.** A single DO (default placement, MIA). Sockets were opened from one Node process, 100 at a time, with `perMessageDeflate:false`.
- **Broadcast.** Triggered by an HTTP call: the DO loops `getWebSockets("sub")` and calls `send`. Timing runs from the moment the client sends the trigger request.
- **Server count** = `getWebSockets().length`, as reported by the DO.

| Step | Opened (fail) | Open time | Server count | Broadcast 32 B: HTTP RTT / last received | Broadcast 1 KB: HTTP RTT / last received |
|---|---|---|---|---|---|
| 1k | 1000 (0) | 5.5 s | 1000 | 537 / 900 ms | 256 / 605 ms |
| 5k | +4000 (0) | 18.6 s | 5000 | 1143 / 2297 ms | 544 / 1735 ms |
| 10k | +5000 (0) | 25.1 s | 10000 | 1304 / 2789 ms | 1079 / 2444 ms |
| 10k after 15 s idle | | | 10000 | 1965 / 2580 ms | |

- **No error and no close code at any step.** The run stopped at 10k as instructed, so 32k was not tested.
- **Local machine limits.** We did not hit any. The ephemeral port range is 49152–65535, i.e. 16,384 ports per destination, which would cap one client IP at ~16k sockets. `ulimit -n` = 1,048,576 and `kern.maxfilesperproc` = 61,440.
- **Where the broadcast time goes.** The baseline client RTT is ~150 ms, so the DO's send loop costs roughly **~100 µs per socket**: ≈ 1 s for 10k. The remainder is delivery plus a single Node process decrypting 10k TLS frames.

## R5: production limits

- **Row/value size.**
  - BLOB and TEXT of 1 MB, 2,000,000 B, 2 MiB, 2 MiB+1, 4 MiB and 8 MiB all **insert and persist**. They survive `ctx.abort()`.
  - Two 1.5 MB columns in one row, and growing a row to 3 MB with `UPDATE a = a || a`, both work.
  - Bisection: **max BLOB 8,388,636 B. 8,388,637 B → `string or blob too big: SQLITE_TOOBIG`.** The same error appears for 10 MB, 12 MB, 16 MB and 32 MB.
  - (Locally the limit was 16 MiB; production is stricter at ~8 MiB. Neither enforces the documented 2 MB.)
- **Other limits** are the same as local:
  - `bind_101` fails with `too many SQL variables at offset 207: SQLITE_ERROR`.
  - A 100,001-byte statement fails with `statement too long: SQLITE_TOOBIG`.
- **PRAGMAs.**
  - Every PRAGMA on the local blocked list is also blocked in prod, with `not authorized: SQLITE_AUTH`: all 33 (`page_count`, `user_version`, `integrity_check`, `journal_mode`, ...).
  - Every PRAGMA on the local allowed list is also allowed (`table_list`, `foreign_keys`→1, `page_size`→4096, `quick_check`→ok, `optimize`, ...).
- **Functions.**
  - Blocked: `sqlite_version`, `log10`, `sqlite_compileoption_used` and `sqlite_source_id` → `not authorized to use function: X`. `load_extension` → `not authorized`.
  - OK: `log`, `unixepoch`, `json`, `jsonb`, `randomblob`, `concat_ws` and `unhex`.
- **Statements.** The same as local:
  - `ATTACH`, `CREATE TEMP TABLE` and `fts4` give SQLITE_AUTH.
  - `VACUUM` gives `cannot VACUUM from within a transaction`.
  - `BEGIN` and `SAVEPOINT` give the "use transactionSync" error.
  - `rtree`, `ANALYZE` and `REINDEX` work.
  - `dbstat` and `generate_series` give `no such table`.
  - `_cf_KV` gives `no such table` (before KV use).
- **FTS5.**
  - `unicode61 remove_diacritics 2`: `acao` matches "Uma ação judicial", and `cora*` matches "Coração valente".
  - `trigram`: `nvoic` matches "Overdue INVOICE #42".
  - `bm25` = -0.909, `snippet` = "the quick brown [fox]…", and `highlight` works.
- **Alarm that throws.** Attempt 0 inserted into `rb_test`, did `storage.put("marker")`, then threw. On the retry (`retryCount:1`), **both the SQL row and the KV marker were visible**. **No rollback**, in either production or local.
- **Clock.** `Date.now()` and `performance.now()` do not advance during a 2e7-iteration sync loop (0 ms). In prod, in-DO timing only works across I/O.

## R6: point-in-time recovery

- **Bookmark format.** Bookmarks look like `00000000-00000008-00005119-<hash>`. The first field increments after each restore, and after some sessions (for example, `00000001-…` after a restore). The undo bookmark looks like `0000000N-ffffffff-…`.
- **Bookmark restore works.** We wrote `before1, before2` and saved `getCurrentBookmark()`. We then wrote `after1, after2`, called `onNextSessionRestoreBookmark(bm)` (which returned an undo bookmark) and then `ctx.abort()`. The next read returned **`["before1","before2"]`**. Restoring the undo bookmark gave back all 4 rows.
- **`getBookmarkForTime(Date.now()-60s)`** on a 65 s-old DO failed with `Requested time is before this database existed.`. On a 60 s-old DO with writes at t0, t30 and t60, `ago` = 15, 45, 58 and 65 s **all** failed with the same error.
- **On older DOs** it returned bookmarks (60 s and 600 s ago on a ~45 min-old DO, but *not* 1200 s ago), so the history window starts some minutes after creation.
- **Granularity.** On a ~15 min-old DO we wrote `A`, waited 20 s, wrote `B`, then asked for the bookmark at 10 s ago. It returned the **same bookmark as an earlier request for "60 s ago"**, and the restore removed **both A and B** (rows `[]`). Time-based bookmarks resolve to an older checkpoint, not to the exact time.
- **Errors.** Passing the error-JSON or a malformed string as a bookmark gives `Invalid bookmark format.`

## R7: Better Auth load (Paid plan; the CPU limit was not configured on these Workers, so the default applies)

- **Variants.**
  - `ember-spike-auth-dohash`: Better Auth runs in the DO and scrypt runs in the DO.
  - `ember-spike-auth-wkhash`: the DO calls back an `EdgeHasher` RpcTarget, so scrypt runs in the Worker isolate.
- **Bundle.** Built with `wrangler deploy --dry-run --outdir` (local only), then uploaded through the API. The bundle is 2.1 MB, and startup took 67 ms and 125 ms respectively.

| Variant | Op | n / c | OK | ops/s | p50 | p95 | Errors |
|---|---|---|---|---|---|---|---|
| DO-hash | sign-up | 200 / 20 | 200 | 10.4 | 1786 ms | 2792 ms | 0 |
| DO-hash | sign-in | 200 / 20 | 200 | 10.7 | 1739 ms | 2859 ms | 0 |
| Worker-hash | sign-up | 200 / 20 | 200 | 6.5 | 3002 ms | 3356 ms | 0 |
| Worker-hash | sign-in | 200 / 20 | 200 | 39.3 | 441 ms | 753 ms | 0 |
| Worker-hash (repeat) | sign-up / sign-in | 100 / 20 | 100 / 100 | 6.3 / 31.2 | 3073 / 489 ms | 3576 / 804 ms | 0 |
| DO-hash (repeat) | sign-up / sign-in | 100 / 20 | 100 / 100 | 9.9 / 11.0 | 1791 / 1812 ms | 2903 / 1891 ms | 0 |

- **Worker CPU (GraphQL `workersInvocationsAdaptive`).**
  - Worker-hash: **cpuTimeP50 96.5 ms, P99 199 ms** (the hash runs in the Worker).
  - DO-hash: 0.7 ms (the Worker only proxies).
  - **scrypt costs ~90 ms of CPU in production**, versus 36 ms locally.
  - DO-side analytics were rate-limited or not yet available.
- **No `exceeded CPU` errors.**
- **Why DO-hash caps at ~10/s.** ~95 ms of CPU per hash, serialized on the DO's single thread.
- **Why Worker-hash sign-up is slower than DO-hash.** Better Auth's sign-up runs inside `ctx.storage.transaction(...)`, and the hash RPC is awaited inside it. This is verified in source: `better-auth/dist/api/routes/sign-up.mjs:144` calls `runWithTransaction(...)`, and `password.hash` is called at `:214` inside it. Our adapter maps that to `ctx.storage.transaction`. The DO stays blocked for the hash *plus* the RPC round trip. Sign-in does not hold a transaction, so it scales (~4×).

## R8: latency from Campinas

The Worker ran in **MIA** for 100% of these samples. The baseline (Worker-only `/ping`) was p50 136 ms. curl showed TCP connect at 124 ms and TLS at 257 ms.

| Target (actual DO colo from in-DO `cdn-cgi/trace`) | HTTP query p50/p95 | HTTP mutation p50/p95 | Server `sync()` p50 | Worker→DO RTT p50 |
|---|---|---|---|---|
| default, no hint (MIA) | 147.7 / 196.7 | 177.5 / 196.7 | 34 ms | 5 ms |
| hint `sam` (landed **EWR**) | 182.3 / 206.5 | 200.1 / 215.3 | 22 ms | 40 ms |
| hint `sam` (landed MIA) | 151.2 / 195.5 | 183.6 / 202.1 | 32 ms | 6 ms |

- **Placement of hint `sam`** across 9 fresh ids: 6 MIA, 1 ATL, 1 ORD, 1 EWR.
- **Placement of other hints** (Worker-side RTT): `enam`→ATL 20 ms, `wnam`→DFW 46 ms, `weur`→AMS 127 ms, `apac`→NRT 171 ms / SIN 240 ms.
- **WebSocket** (100 sequential mutations; `patch` goes to a second socket on the same DO):
  - Default (MIA): mutation→ack p50 **166.7** / p95 193.4. Mutation→patch p50 **163.3** / p95 189.1. Ping without a write: p50 133.2.
  - Hint `sam` (EWR): ack 180.6 / 184.4. Patch 179.8 / 183.5. Ping 160.2.
  - Patch usually arrives *before* the ack (96/100), because both are released together by the output gate.
- **Cold wake** (`evidence/r8-coldwake-controlled.json`, with TLS warmed first):
  - Existing DO after 75 s idle: first Worker→DO call **56–60 ms** (one 249 ms outlier), versus 3–8 ms warm.
  - Brand-new DO, first call: 189–487 ms.
  - Client-side, a first request after idle *without* a warm connection took ~490 ms, of which ~260 ms was the TLS handshake (`evidence/r8-ws-cold.json`).
  - A WebSocket idle for 75 s (hibernated) answered its first ping in 136 ms, the same as warm.

## X1: single-DO throughput

Each mutation is `INSERT INTO docs` (+ `docs_k` index) + `UPSERT counters` (3 row writes). Load came over N WebSockets with a pipelined window, for 20 s.

| Mode | In flight | Mutations/s | Msgs/s | Ack p50 / p95 |
|---|---|---|---|---|
| 1 per message | 20×5 = 100 | 586 (RTT-bound) | 586 | 165 / 203 ms |
| 1 per message | 50×10 = 500 | 1,423 (run 2: 1,098) | same | 336 / 493 ms (run 2: 439 / 632) |
| 1 per message | 100×20 = 2,000 | 2,168 (saturated) | 2,168 | 964 / 1413 ms |
| 10 per `transactionSync` | 500 | 6,745 (run 2: 10,497) | 675–1,050 | 465–722 ms |
| 100 per `transactionSync` | 500 | **32,477** (both runs) | 325 | 1478–1559 ms |

**CPU, measured by GraphQL `durableObjectsPeriodicGroups` / `InvocationsAdaptiveGroups` in isolated minutes** (`evidence/x1-graphql-cpu-isolated.json`):

| Workload | CPU |
|---|---|
| 1 mutation per message | 3.64 s / 21,964 msgs = **166 µs per message**. Invocation cpu p50 136 µs, **wall p50 539 µs**. |
| 100 per txn | 12.9 s / 650k = **19.9 µs per mutation**. 1.7 ms CPU per message. |
| 10 per txn | 7.15 s / 210k = 34 µs per mutation |
| In-DO loop, 50k mutations in one `transactionSync` | 4.26 s / 150k = **28 µs per mutation** |

**Reading:**
- Each event (WS message) has ~120–150 µs of fixed CPU and ~0.5 ms wall. That caps a shard at ~2k events/s.
- Per mutation, SQL costs ~20–30 µs (3 row writes).
- Batching N mutations per event is the main throughput lever.
- `wall p50 539 µs` vs `cpu 136 µs` per message suggests per-event runtime overhead beyond JS CPU.

## X2: commit / output-gate latency

- **Server side.** `t0 = Date.now(); write; await ctx.storage.sync(); Date.now() - t0` gave **p50 34 ms (MIA)**, 32 ms (MIA, second DO) and **22 ms (EWR)**, with p95 37–43 ms.
- **Client side.** HTTP mutation − HTTP query p50 = 177.5 − 147.7 = **~30 ms** (MIA) and 200.1 − 182.3 = 18 ms (EWR). Over WS, mutation→ack − ping = 166.7 − 133.2 = **~33 ms**.
- **Conclusion.** Every write response is held ~20–35 ms by the output gate (replicated commit). The client sees it as added RTT. Reads pay nothing.

---

## Implications to fold into PLAN.md

1. **Deploy (§11, §18 R1/R2).**
   - Use `exports` (declarative), not `migrations`. The CLI must always send the **full** `exports` map, including tombstones.
   - Code-only change → Versions + percentage deploy. DO ids stay pinned, which was verified.
   - `exports` change → deploy that version at 100% first. The Versions API also handles lifecycle changes.
   - Error codes to handle: `100402`, `100400`, `100405`, `10211`, `10079`, `10061`.
2. **Scheduler (§8).** Alarms are precise (p95 15 ms) and accept far-future times. Alarm writes are not rolled back on throw, so wrap the job execution in `transactionSync` and mark jobs done idempotently.
3. **Reactivity (§4, §5).**
   - Plan for ~5k subscribers per shard for sub-second fan-out. 10k works but broadcast takes ~1 s server-side.
   - Coalesce patches: one `send` per socket per commit.
4. **Throughput (§5, "beat Convex").**
   - A shard sustains ~1–2k events/s without batching, and **~30k mutations/s with batching**.
   - The runtime should drain the queued mutations in each turn into one `transactionSync` (group commit), and send acks after the single output-gate release.
5. **Latency (§17, R8).**
   - BR users today land in MIA. The `sam` hint is ignored, or there is no SA DO colo.
   - Budget ~150 ms read RTT and ~180 ms write RTT from Campinas. Optimistic updates are mandatory in clients.
   - Keep WebSockets open: they hibernate, and waking costs nothing.
   - Re-measure with a custom domain on a Pro or Business zone (out of scope here) to see whether ingress moves to GRU/VCP.
6. **Limits (§15).**
   - The real cap is ~8 MiB per value. Keep the product limit at 2 MB for headroom, since the docs promise 2 MB and may enforce it later.
   - The PRAGMA and function blocklist matches local, so the local test suite is representative.
7. **Restore (`ember restore`).** Record bookmarks explicitly (pre-deploy, pre-migration, periodic) and restore by bookmark. `getBookmarkForTime` is only approximate and is unavailable for the first minutes of a DO's life.
8. **Auth (§9).**
   - scrypt is ~90 ms of CPU in production. The auth DO tops out at ~10 hashes/s.
   - Run hashing in the Worker and make sure no `storage.transaction` is open across the hash call. Hash before entering the adapter transaction; this may need a Better Auth `password.hash` hook that pre-hashes in the Worker before forwarding.
   - Alternatively, shard auth across several DOs.

## Resources created and deleted

The cleanup script `scripts/cleanup.mjs` wrote its log to `evidence/cleanup.txt`.

**Created:**
- Workers `ember-spike-r1-exports`, `ember-spike-r1-migr`, `ember-spike-main`, `ember-spike-auth-dohash` and `ember-spike-auth-wkhash`.
- DO namespaces `ember-spike-r1-migr_Shard`, `ember-spike-r1-exports_Shard2` (renamed from `_Shard`), `ember-spike-r1-exports_New3`, `ember-spike-main_Shard`, `ember-spike-auth-dohash_AuthShard` and `ember-spike-auth-wkhash_AuthShard`.
- `ember-spike-r1-exports_Extra` was created and then deleted through an `exports` tombstone.
- `ember-spike-r1-nodecl` was rejected with error 10061, so it was never created.
- No D1, queues, KV, R2, routes or custom domains were created.

**Deleted:**
- All 5 Workers were deleted with `DELETE /workers/scripts/{name}?force=true` (HTTP 200 each). That also removed all 6 DO namespaces.
- After cleanup, the account lists 24 scripts, the same 24 non-spike scripts as before the run, with **0 `ember-spike-*` scripts and 0 `ember-spike-*` DO namespaces**.

**Caveats:**
- The DO-side GraphQL analytics for the two auth namespaces were still empty when queried (an earlier query hit `Rate limiter budget depleted`). The R7 CPU numbers therefore come from the Worker-side `workersInvocationsAdaptive` only.
- The X1 evidence files for `s-1-50x10`, `b-10` and `b-100` were overwritten by the second, CPU-isolated run. The first-run numbers are in the table above.
