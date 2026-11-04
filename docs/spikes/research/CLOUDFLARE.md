# Cloudflare + Expo research for "Convex on Cloudflare"

Research date: 2026-11-04. Sources are official docs only: developers.cloudflare.com, docs.expo.dev, github.com, plus reactnative.dev for one RN item. Nothing was deployed.

**Legend**
- **[V]**: verified on the cited page in this session.
- **[K]**: from prior knowledge, not re-fetched this session. Re-check these before relying on them.
- **CONFLICT**: the docs contradict each other, or recently renamed something.

---

## 0. Things that changed recently

Each of these affects the design.

1. **Declarative DO lifecycle (`exports`) is replacing `migrations`.** The Script Upload API metadata now has an `exports` map, where each entry is `durable-object` with a `state` of `created`, `deleted`, `renamed`, `transferred` or `expecting-transfer`. There is also an `exports_reconciliation` field. The new typed `cloudflare.config.ts` (open beta, `cf` package) says `exports` "replaces an ordered Durable Object migration history", and that tombstones are kept only until a deploy reports them stale. The legacy `migrations` field (`new_sqlite_classes`, `old_tag`/`new_tag`, `steps`) still exists. **CONFLICT:** the IaC page still documents only `migrations`.
   - https://developers.cloudflare.com/cf/projects/cloudflare-config/
   - https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
2. **New `cf` CLI and `cloudflare.config.ts`.** These are open beta. They need Node ≥ 22.18 and ESM, and they don't support Bun. The cron docs already show `triggers.scheduled(...)` plus `cf deploy`. The format "can change before the stable release". [V]
3. **Basin renames.**
   - "Basin Pipelines" was formerly Cloudflare Pipelines and is now GA.
   - "Basin SQL" was formerly R2 SQL and is now GA. The old R2 SQL APIs "will be deprecated in the future".
   - "Basin Catalog" appears to be the renamed R2 Data Catalog, but no page states that explicitly.
   - https://developers.cloudflare.com/pipelines/
   - https://developers.cloudflare.com/r2-sql/
4. **AI Search billing starts 2026-12-01.** The limits page was updated 2026-11-02. [V]
5. **Email Sending is still public beta.** It launched 2026-04-16, and no GA entry appears in the changelog. SMTP submission is also beta. [V]
6. **D1 query result cap.** A 50 MB result-size limit took effect 2026-11-04, today. [V]

---

## 1. Deploy pipeline

### Facts

**Script Upload API: one-shot upload plus deploy** [V]
- Call `PUT /accounts/{account_id}/workers/scripts/{name}` with `multipart/form-data`. The body is a `metadata` JSON part plus one part per module, for example `type=application/javascript+module`.
- This call "will implicitly create a version and deployment".
- Some fields are accepted only here, not on version uploads: `migrations`, `logpush`, `tail_consumers` and `tags`.
- If `compatibility_date` is omitted on an API upload, it falls back to 2021-11-02, so always set it.
- https://developers.cloudflare.com/workers/platform/infrastructure-as-code/
- https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/

**Metadata fields** [V]
- `main_module`, `compatibility_date`, `compatibility_flags`, `bindings[]`, `migrations` and `exports`.
- `keep_bindings`: "List of binding types to keep from previous_upload". Use it to keep secrets you didn't resend.
- `observability{enabled, head_sampling_rate, logs, traces}`.
- `limits{cpu_ms, subrequests}`.
- `placement`: smart, region, hostname or host.
- `tail_consumers`, `annotations` and `assets`.
- `code_update_strategy{mode: immediate | deferred, max_delay}`.

**Binding enum** [V]
The API reference lists 38 binding types, including: `ai`, `ai_search`, `ai_search_namespace`, `analytics_engine`, `browser`, `d1`, `dispatch_namespace`, `durable_object_namespace`, `hyperdrive`, `images`, `kv_namespace`, `pipelines`, `queue`, `ratelimit`, `r2_bucket`, `secret_text`, `secret_key`, `secrets_store_secret`, `send_email`, `service`, `vectorize`, `version_metadata`, `workflow`, `vpc_service`, `media`, `artifacts`, `flagship` and `messaging`.

Shapes:

| Binding | Shape |
|---|---|
| R2 | `{type:"r2_bucket", name, bucket_name}` |
| Queue producer | `{type:"queue", name, queue_name}` |
| Vectorize | `{type:"vectorize", name, index_name}` |
| Workers AI | `{type:"ai", name}` |
| Email send | `{type:"send_email", name, allowed_destination_addresses?, allowed_sender_addresses?, destination_address?}` |
| Workflow | `{type:"workflow", name, workflow_name, class_name?, script_name?}` |
| AI Search instance | `{type:"ai_search", name, instance_name, namespace?}`. The instance "must exist at deploy time". |
| AI Search namespace | `{type:"ai_search_namespace", name, namespace}` |
| Rate limit | `{type:"ratelimit", name, namespace_id, simple:{limit, period}}` |
| DO | `{type:"durable_object_namespace", name, class_name}` |

**Workers / Versions / Deployments API (beta)** [V]
1. `POST /accounts/{id}/workers/workers {name}`
2. `POST /accounts/{id}/workers/workers/{worker_id}/versions` with modules as `content_base64`
3. `POST /accounts/{id}/workers/scripts/{name}/deployments {strategy:"percentage", versions:[{percentage, version_id}]}`

The TypeScript SDK equivalents are `client.workers.beta.workers.*` and `client.workers.scripts.deployments.create`. The Terraform resources are `cloudflare_worker`, `cloudflare_worker_version` and `cloudflare_workers_deployment`.

**DO migrations with versions** [V]
- "Durable Object migrations are applied with deployments." "Versions of Worker bundles that change Durable Object class lifecycle cannot be uploaded" as versions. Use a full deploy (script upload) for those.
- Lifecycle changes cannot be rolled back past the version that introduced them.
- Best practice: ship lifecycle changes separately from code changes.
- The IaC page documents a chicken-and-egg problem: on first creation, the binding can't reference the class before the migration is applied. The workaround is two applies. It "also applies to the API or SDKs".
- https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/

**Gradual deployments** [V]
- A deployment can contain at most 2 versions, chosen from the last 100 uploaded.
- Each DO instance is pinned to one version per deployment. Raising a version's percentage never moves a DO back to the old version.
- Version affinity and version overrides exist.
- https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/

**Secrets** [V]
- `PUT /accounts/{id}/workers/scripts/{name}/secrets {name, text, type:"secret_text"}`. `secret_key` (WebCrypto keys) is also supported.
- Each PUT creates a new version. Use "Patch multiple script secrets" for batches.
- Alternatively, include `secret_text` bindings in the upload metadata.
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/

**Cron triggers** [V]
- `PUT /accounts/{id}/workers/scripts/{name}/schedules` with body `[{"cron":"*/30 * * * *"}]`. This replaces the whole set.
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/

**Wrangler as a library** [V]
- `createTestHarness`: current and recommended.
- `getPlatformProxy`: current. It gives Node.js proxies to local workerd bindings.
- `experimental_generateTypes`: experimental.
- `unstable_dev` and `unstable_startWorker`: **deprecated**. Cloudflare recommends `createTestHarness`, or Vite `createServer` with the Cloudflare Vite plugin.
- **No programmatic deploy function is documented.**
- https://developers.cloudflare.com/workers/wrangler/api/

**Limits** [V]
- Worker size: 64 MiB uncompressed. Startup must finish within 1 s (error `10021`).
- Workers per account: 500 on Paid.
- Environment variables: 128 per Worker on Paid.
- **CONFLICT:** the Workflows limits page still says 10 MB script size on Paid.
- https://developers.cloudflare.com/workers/platform/limits/

**Workers for Platforms** [V]
- Upload user Workers with `PUT /accounts/{id}/workers/dispatch/namespaces/{ns}/scripts/{name}`. A dispatcher Worker reaches them through a `dispatch_namespace` binding.
- Unlimited scripts. Custom per-script CPU and subrequest limits, tags and outbound Workers.
- Pricing: $25/mo, which includes 20M requests, 60M CPU-ms and 1,000 scripts. Extra scripts cost $0.02 each.
- The docs don't say whether user Workers can host DOs. Dynamic Workers ("Durable Object Facets": loaded code runs "as a Durable Object with its own isolated SQLite storage") are the newer primitive for multi-tenant code.
- https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/platform/pricing/
- https://developers.cloudflare.com/dynamic-workers/

### Recommendation

**The CLI can deploy without wrangler.**
- Bundle with esbuild, using the `workerd` conditions and `nodejs_compat` if needed.
- Then call the REST API through the `cloudflare` TS SDK.

**Two code paths:**
- **(a) Schema or DO lifecycle change**, such as a new shard class, rename or delete: use one-shot `PUT /workers/scripts/{name}` with `exports` (preferred, pending a test) or `migrations` with `new_sqlite_classes`, plus `old_tag`/`new_tag` for optimistic concurrency. This is always a 100% deploy.
- **(b) Code-only change**: upload a version, then create a deployment with a percentage. This gives gradual rollout and instant rollback.

**Keep DO classes stable.**
- Keep one `Shard` class, plus a few system classes such as `Catalog`, `Scheduler` and `Presence`, that never change.
- User tables become rows and SQLite tables *inside* shards, not new DO classes. Almost every `npx ourcli deploy` then takes path (b).
- Schema migrations run as data migrations inside shards: lazily on first access by schema version, or by fan-out via a queue.

**Resource provisioning before upload.** Idempotent "ensure" calls:
- R2 buckets, Queues plus consumers, Vectorize indexes plus metadata indexes, AI Search namespaces and instances, Workflows, Email Routing rules.
- Then the upload.
- Then secrets via the bulk PATCH.
- Then `PUT /schedules`.
- Store the plan and hash in `.ourcli/state.json`, like Terraform-lite.

**Where wrangler still fits.**
- Use `getPlatformProxy` or `createTestHarness` in dev and test.
- Don't depend on wrangler internals for deploy.
- Watch `cf`/`cloudflare.config.ts`. We could *emit* a `cloudflare.config.ts` as an escape hatch once it is stable.

**Multi-tenant later.**
- WfP or Dynamic Workers would host each tenant's generated code.
- DO support for WfP user Workers needs verification. Dynamic Workers + Facets look like the intended path.

---

## 2. Scheduling: Cron vs DO alarms vs Workflows vs Queues

### Facts

**Cron Triggers** [V]
- 250 per account on Paid, 5 on Free. No separate per-Worker cap is stated.
- 5-field cron with Quartz extensions (`L`, `W`, `#`). Weekdays run "1 = Sunday".
- Minute granularity. **UTC only.**
- Changes take up to 15 min to propagate.
- CPU limit on Paid: 30 s for intervals under 1 h, 15 min for intervals of 1 h or more.
- Local runs need `/cdn-cgi/local/scheduled`.
- https://developers.cloudflare.com/workers/configuration/cron-triggers/

**DO alarms** [V]
- One alarm per DO, and `setAlarm` overrides the previous one.
- At-least-once execution. Retries use exponential backoff starting at 2 s, "up to 6 retries".
- Only one `alarm()` runs at a time per DO.
- Handler wall time is 15 min. CPU is the normal per-invocation limit.
- **The docs give no maximum future time and no precision guarantee.**
- https://developers.cloudflare.com/durable-objects/api/alarms/

**Workflows** [V]
- `step.sleep` maximum is **365 days**.
- Steps: 10,000 default, up to 25,000.
- Step result: 1 MiB. State: 1 GB per instance.
- Retries: up to 10,000 per step.
- Creation rate: 300/s per account, 100/s per workflow.
- Concurrency: 50,000 running, and waiting/sleeping instances don't count. **CONFLICT:** the prose on the same page says 10,000.
- Retention: 30 days.
- Workflows also has its own cron schedules: 100 per account.
- https://developers.cloudflare.com/workflows/reference/limits/

**Workflows pricing** [V]
- Requests: $0.30/M.
- CPU: $0.02/M ms.
- Storage: $0.20/GB-mo.
- Steps: $0.80 per 100k, with 500k/mo included. Step and storage billing began 2026-08-10.
- Sleeping is free.
- https://developers.cloudflare.com/workflows/reference/pricing/

**Queues** [V]
- **Maximum `delaySeconds` is 24 h**, for both send and retry.
- At-least-once delivery. Ordering is not documented.
- 5,000 msgs/s per queue. Messages are 128 KB.
- Batches: 100 msgs. `sendBatch`: 100 msgs or 256 KB.
- 100 retries. Retention up to 14 days.
- 250 concurrent consumers. Consumers get 15 min wall time.
- https://developers.cloudflare.com/queues/platform/limits/
- https://developers.cloudflare.com/queues/reference/delivery-guarantees/

### Recommendation

**`ctx.scheduler.runAfter` / `runAt`, any horizon**
- Store jobs in a `_scheduled_functions` table *inside the owning shard DO*, indexed by `run_at`.
- The shard keeps exactly one alarm set to `min(run_at)`.
- The alarm handler claims due rows transactionally, executes them or enqueues to a Queue, and re-arms.
- Catch errors yourself and re-arm, because 6 retries is not enough for us.
- This mirrors Convex semantics: transactional with the mutation that scheduled the job, and cancellable by ID.
- For multi-year horizons, the alarm timestamp is just a number. Verify that a far-future alarm is accepted (see Unknowns). The fallback is to cap alarms at, say, 30 days and re-arm.

**`crons.ts`**
- Don't map user crons to CF Cron Triggers. The 250/account cap, UTC-only schedules and 15-min propagation all rule it out.
- Instead, use **one** system cron, `* * * * *`, on the engine Worker. It pokes a singleton `CronScheduler` DO.
- That DO stores the parsed user cron specs and computes next fire times *with IANA timezones* using our own parser.
- It then uses its own alarm to fire exactly on time, so the system cron is only a watchdog.
- Due jobs are dispatched as scheduled functions to the right shard, or to a Queue.
- This gives unlimited crons, timezone support and Convex parity.

**"Send email later"**
- Treat it as a normal scheduled function in the mailbox or tenant shard (DO alarm).
- At fire time, enqueue to the `outbound-email` Queue.
- The consumer calls `env.EMAIL.send` with an idempotency key, the message ID, deduped in shard state.
- Queue delays (≤24 h) suit short retries and backoff only.

**Workflows**
- Reserve for multi-step, long-lived processes with per-step retries: domain onboarding (create zone → wait DNS → verify → enable routing), bulk import, data migrations across shards, drip sequences.
- Not for every scheduled function. Step billing and the 300/s creation rate make it a poor fit there.

---

## 3. Vectorize, AI Search, embeddings

### Facts

**Vectorize limits** [V]
- Indexes per account: 50,000 default on Paid. More cost $0.10/mo each.
- **20M vectors per index.**
- **≤1536 dims**, float32.
- Metadata: 10 KiB per vector.
- **10 metadata indexes per index.** Each indexes only the first 64 bytes of string values.
- **50,000 namespaces per index**, with names up to 64 B.
- topK: 50 when returning values or metadata, 100 otherwise.
- Upsert: 1,000 per batch from Workers, 5,000 over HTTP.
- IDs: up to 64 B.
- https://developers.cloudflare.com/vectorize/platform/limits/

**Metadata filtering** [V]
- Operators: `$eq $ne $in $nin $lt $lte $gt $gte`.
- Filter JSON must be under 2048 B.
- **Metadata indexes must exist before upsert.** Vectors inserted earlier must be re-upserted to be indexed.
- Namespace filtering runs before metadata filtering.
- https://developers.cloudflare.com/vectorize/reference/metadata-filtering/

**Vectorize pricing** [V]
- `(queried + stored vectors) × dims × $0.01/1M`, plus `stored × dims × $0.05/100M`.
- Paid includes 50M queried and 10M stored dimensions.
- https://developers.cloudflare.com/vectorize/platform/pricing/

**Local dev** [V]
- "There is no current local simulation for Vectorize". Use `remote: true` bindings.
- Workers AI always runs remotely.
- DOs and Workflows can't be remote.
- https://developers.cloudflare.com/workers/development-testing/

**AI Search: data sources** [V]
- Sources: built-in storage via the **Items API**, plus at most one external source (Website or R2).
- Uploaded items are "indexed immediately".
- https://developers.cloudflare.com/ai-search/configuration/data-source/built-in-storage/

**AI Search: namespace binding** [V]
- Config: `ai_search_namespaces: [{binding, namespace}]`. Needs wrangler ≥ 4.68.1.
- Wrangler creates a missing namespace on deploy.
- At runtime, `env.AI_SEARCH.get(name)` works, and you can list, create and delete instances. This enables per-tenant instances.
- https://developers.cloudflare.com/ai-search/concepts/namespaces/

**AI Search: Items API** [V]
- `items.upload(name, content, {metadata})`, `uploadAndPoll`, `list({metadata_filter})`, `get(id).info()`, `download()`, `logs()`, `chunks()` and `delete(id)`.
- Item names: up to 128 chars.
- **Custom metadata: 5 fields per instance**, as `Record<string,string>`, declared on the instance.
- https://developers.cloudflare.com/ai-search/api/items/workers-binding/

**AI Search: hybrid search** [V]
- On by default.
- BM25 keyword scoring plus vector search, fused with `rrf` (default) or `max`.
- Optional reranking.
- Retrieval type can be overridden per request.
- https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/

**AI Search: limits** [V]
- Instances: 5,000 default on Paid, then $0.10 each.
- **100 namespaces per account**, even on Paid.
- **1M files per instance, or 500K with hybrid.**
- File size: 10 MiB for text and code, 4 MiB for other formats.

**AI Search: pricing** [V]
- Monthly inclusion: 5M ingestion tokens, 10 GB-mo, 1k semantic queries and 1k full-text queries.
- Overage:
  - Ingestion: $0.75/M tokens.
  - Storage: $2/GB-mo.
  - Semantic or hybrid queries: $0.75 per 1k.
  - Full-text queries: $0.10 per 1k.
- Billing starts 2026-12-01.
- https://developers.cloudflare.com/ai-search/platform/limits-pricing/

**AI Search: open questions**
- Local dev: only `remote: true` is documented for the namespace binding.
- No GA or beta label is shown.

**Workers AI embeddings for pt-BR** [V for IDs and pricing; dims are K]
- `@cf/baai/bge-m3`: multilingual, 60k-token context, $0.0118/M tokens. 1024 dims [K].
- `@cf/qwen/qwen3-embedding-0.6b`: 8,192-token context, $0.0118/M tokens, supports instructions. 1024 dims [K].
- `@cf/google/embeddinggemma-300m`: beta, "100+ languages". 768 dims [K].
- The `bge-*-en` models are English only.
- Pages:
  - https://developers.cloudflare.com/workers-ai/models/bge-m3/
  - https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/
  - https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/

### Recommendation

**`.searchIndex()`**
- FTS5 inside the shard DO's SQLite, as an external-content table kept in sync by our write path.
- This gives transactional, reactive and free search.
- Test FTS5 tokenizer availability in DO SQLite. `unicode61 remove_diacritics 2` matters for pt-BR.

**`.vectorIndex({dims, filterFields})`**
- Back it with Vectorize: one index per (table, model), with `namespace = shardId` or tenant.
- 50k namespaces fits per-tenant isolation. Beyond that, use metadata `tenant`.
- Make the CLI create metadata indexes **before** the first deploy that writes, and fail the deploy if `filterFields` > 10.
- Ingestion is asynchronous and not transactional: write to the shard, enqueue to Queue, embed (Workers AI), then upsert.
- Expose `vectorSearch` as an *action*, not a reactive query, as Convex does.
- Default model: `bge-m3`, for pt-BR.

**`.aiSearchIndex()`**
- Use it for document or attachment RAG over email bodies and PDFs.
- One namespace for the app, one instance per tenant (≤5,000 default) or a shared instance with a `tenant` metadata field (5 fields max).
- Push via `items.upload` from a queue consumer, keeping our row ID as the item name.
- The 100-namespace account cap means we can't do one namespace per tenant.
- Watch costs after 2026-12-01.

---

## 4. R2 and images

### Facts

**Presigned URLs** [V]
- The binding can't presign. Use `aws4fetch` in the Worker with R2 S3 credentials stored as secrets.
- Supported: GET, HEAD, PUT and DELETE. **POST form uploads are not supported.**
- Expiry: 1 s to 7 days.
- **Presigned URLs don't work on custom domains**, only on `<acct>.r2.cloudflarestorage.com`.
- Signing `Content-Type` locks the upload type.
- Needs bucket CORS for browsers.
- https://developers.cloudflare.com/r2/api/s3/presigned-urls/

**R2 limits** [V]
- Objects: ~4.995 TiB. Single PUT: ~4.995 GiB.
- Multipart: up to 10,000 parts, each part capped like a single upload.
- Keys: 1,024 B. Metadata: 8,192 B.
- **1 write/s per key.**
- Unlimited buckets (100k default).
- The REST API limit is 1,200 requests per 5 min.
- https://developers.cloudflare.com/r2/platform/limits/

**Event notifications** [V]
- Events: `object-create` and `object-delete`, delivered to a Queue.
- 100 rules per bucket. Prefix and suffix filters. Overlapping rules are rejected.
- https://developers.cloudflare.com/r2/buckets/event-notifications/

**Lifecycle** [V]
- Actions: expire, transition to `STANDARD_IA`, and abort multipart. The default aborts multipart after 7 days.
- Up to 1,000 rules.
- Rules typically act within 24 h.
- Managed through the S3 API (`PutBucketLifecycleConfiguration`) or wrangler.
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/

**Local dev**
- R2 is simulated locally by default, and `remote: true` is optional [V].

**Images binding** [V]
- Chain: `env.IMAGES.input(stream).transform(...).output({format})`, plus `.info()`.
- Works on raw bytes, such as an R2 object body.
- Input: up to 20 MB.
- Local dev supports only width, height, rotate and format. Use `--remote` for full fidelity.
- Output isn't cached automatically.
- HEIC input isn't confirmed on that page.
- https://developers.cloudflare.com/images/transform-images/bindings/

**Images pricing** [V]
- 5,000 unique transformations per month included, then $0.50 per 1,000. `.info()` is free.
- https://developers.cloudflare.com/images/pricing/

### Recommendation

**Uploads**
- The mobile client gets a presigned PUT from an action, with `Content-Type` and key signed.
- For files over about 100 MB, use S3 multipart with presigned `UploadPart` URLs.
- The R2 `object-create` notification goes to a Queue. The consumer finalizes the `_storage` row in the shard, then extracts, embeds or thumbnails.

**Downloads**
- Serve through a Worker route on our domain that checks auth and streams from the binding. Presigned URLs can't use custom domains.
- Or redirect to a short-lived presigned GET.

**Thumbnails**
- Generate on upload with the Images binding.
- Store the derivative in R2, then serve with a cache.
- This avoids repeat-transformation billing.

**Lifecycle**
- Abort multipart after 1 day on `tmp/`.
- Move to IA after 30 days for old attachments.

**Writes**
- Avoid hot keys, because of the 1 write/s per-key limit.

---

## 5. Platform limits

| Item | Limit | Source |
|---|---|---|
| Worker CPU | 30 s default on Paid, up to 5 min via `limits.cpu_ms`. Free is 10 ms. | [V] https://developers.cloudflare.com/workers/platform/limits/ |
| Worker memory | 128 MB per isolate | [V] same |
| Subrequests | 10,000 default on Paid, configurable "up to 10M". 6 concurrent open connections. | [V] same |
| Request body | 100 MB on Free/Pro, 200 MB on Business, up to 5 GB on Enterprise | [V] same |
| `waitUntil` | 30 s after the response | [V] same |
| DO SQLite storage | 10 GB per DO, unlimited per account on Paid | [V] https://developers.cloudflare.com/durable-objects/platform/limits/ |
| DO CPU | 30 s per request, raisable to 5 min. The timer resets on each HTTP request or WS message. | [V] same |
| DO throughput | **~1,000 req/s soft limit per DO** | [V] same |
| DO WebSocket | Received messages up to 32 MiB. **Max sockets per DO is not documented** ("thousands"). | [V] same, plus https://developers.cloudflare.com/durable-objects/best-practices/websockets/ |
| DO WS attachment | `serializeAttachment` up to 16,384 B. Hibernation stops duration billing. Ping gets an automatic pong. | [V] websockets page |
| DO SQL | 100 columns, 2 MB per row, 100 KB per statement, **100 bound params**, LIKE pattern up to 50 B | [V] limits page |
| DO classes | 500 per account on Paid | [V] |
| Queues | See section 2 | [V] |
| Workflows | See section 2 | [V] |
| D1 | **10 GB per DB (hard)**, 1M DBs per account, 1 TB per account. Single-threaded. 30 s per query. 50 MB results. Read replicas via the Sessions API with no extra cost (status not labelled). | [V] https://developers.cloudflare.com/d1/platform/limits/ and https://developers.cloudflare.com/d1/best-practices/read-replication/ |

**CONFLICT:** for Free-plan DO storage, the page says both 5 GB per account and 1 GB per DO.

### Recommendation

**Shard sizing**
- The 1,000 req/s per DO and 10 GB caps define shard sizing.
- Shard by tenant or mailbox, with a fan-out tier for huge tenants.
- Batch WS frames as the docs suggest: 10–100 messages per frame, flushed every 50–100 ms.

**Bound parameters**
- The 100-parameter limit on bound params matters for our query compiler: chunk `IN (...)` lists and multi-row inserts.

**Global catalog**
- Options are D1 or a single `Catalog` DO.
- Data: tenant → shard map, domains → tenant, API keys, push tokens.
- The catalog is small, at well under 10 GB, so either works.
- **Prefer D1 with read replication.** Lookups are read-heavy and global, and Sessions bookmarks give read-your-writes.
- Writes are rare, which suits single-threaded D1.
- Cache hot lookups (API key → tenant) in the Worker's memory or KV.

**CPU limits**
- Set `limits.cpu_ms` higher (60–300 s) on the queue consumer and shard for migrations.
- Keep 30 s for the request path.

---

## 6. Email Service: sending and Email Routing

### Facts

**Status** [V]
- Email Sending is **public beta**, since 2026-04-16. It needs Workers Paid.
- SMTP submission is beta, since 2026-06-08.
- Email Routing has been available for longer.
- https://developers.cloudflare.com/email-service/platform/changelog/

**Domain must be a Cloudflare zone in *the same account*** [V]
- Onboarding: "Choose a domain from your Cloudflare account".
- Routing: "You must be using Cloudflare DNS to use Email Service".
- The onboarding API is **zone-scoped**: `POST /zones/{zone_id}/email/sending/subdomains`, whose `name` may be the apex, a subdomain or `*.example.com`, plus `GET .../subdomains/{id}/dns`.
- Sending fails with `E_SENDER_DOMAIN_NOT_AVAILABLE` (binding) or SMTP `550 5.7.1` when the domain isn't onboarded "under the account that owns the API token".
- No doc describes manual DNS records for external DNS providers.
- Pages:
  - https://developers.cloudflare.com/email-service/configuration/domains/
  - https://developers.cloudflare.com/email-service/get-started/route-emails/
  - https://developers.cloudflare.com/api/resources/email_sending/
  - https://developers.cloudflare.com/email-service/get-started/send-emails/

**Records** [V]
- Records live under `cf-bounce.<domain>`: MX, SPF `include:_spf.mx.cloudflare.net`, DKIM `cf-bounce._domainkey`, plus DMARC at `_dmarc`.
- Records show as locked or unlocked, and are managed by Email Service.

**Multiple domains** [V]
- Up to 30 sending or routing domains **per zone**, including subdomains.
- No per-account cap is documented, so one account can hold many zones.
- Programmatic onboarding is possible once the zone is in our account: create the zone (`POST /zones`) [K], have the customer switch NS, then `POST /zones/{id}/email/sending/subdomains` and `POST /zones/{id}/email/routing/dns`.
- https://developers.cloudflare.com/email-service/platform/limits/

**Routing API** [V]
- Enable with `POST /zones/{id}/email/routing/dns`.
- Rules: `/zones/{id}/email/routing/rules`, with actions `forward`, `worker` or `drop`.
- Catch-all is available on the apex only.
- Destination addresses are account-level: **200 per account**.
- Wrangler can manage rules from an `addresses` config, since 2026-09-04.
- https://developers.cloudflare.com/api/resources/email_routing/

**Delivery events** [V]
- **Event subscriptions to a Queue**, one subscription per sending domain.
- Types: `delivered`, `deferred`, `bounced`, `failed`, `rejected` and `complained`.
- Payload: `{type, source{zoneId, domain}, payload{eventId, messageId, sender, recipient, terminal, delivery{status, smtpStatusCode, ...}, bounce{type, classification, reason}, complaint{type}, ...}, metadata{...}}`.
- No opens or clicks. No webhooks: consume from the queue and fan out yourself.
- Routing events are not published.
- https://developers.cloudflare.com/email-service/reference/event-subscriptions/

**Analytics** [V]
- Zone-level GraphQL datasets: `emailSendingAdaptive(Groups)` and `emailRoutingAdaptive(Groups)`. Fields include status, sendingDomain, errorCause and auth results, with message-level events.
- 31-day retention.
- **The docs don't mention a Logpush dataset.**
- The dashboard Activity log includes message preview, kept about 7 days.
- https://developers.cloudflare.com/email-service/observability/metrics-analytics/

**Suppression API** [V]
- Account-scoped CRUD plus bulk import (1,000 items, 10 requests/min) at `/accounts/{id}/email/sending/suppressions`.
- Since 2026-09-25, scope is `account` or `sending_domain`. Bounces and complaints are auto-suppressed per sending domain.
- Subdomain setting `drop_suppressed_recipients` chooses between dropping the suppressed address and failing the whole request.

**Send limits and pricing** [V]
- 25 MiB per message, 50 recipients, 16 KB of custom headers.
- **Unpublished, reputation-based daily quota** that starts "conservative".
- **Transactional only, no marketing email** (FAQ).
- 3,000 emails/mo included, then $0.35 per 1,000. Routing is free.
- Pages:
  - https://developers.cloudflare.com/email-service/platform/pricing/
  - https://developers.cloudflare.com/email-service/reference/faq/

**Email Workers: inbound** [V]
- Message fields: `from`, `to`, `headers`, `raw` (stream), `rawSize`, `canBeForwarded`.
- Inbound size: 25 MiB.
- `forward(rcpt, headers)` delivers only to **verified destination addresses** and only accepts `X-*` headers.
- `reply()`:
  - once per event
  - the incoming mail must have a valid DMARC result
  - must go to the original sender, from the same domain
  - throws if `References` has more than 100 entries
- `setReject(reason)` sends a permanent SMTP error.
- Mail is forwarded only if it passes SPF or DKIM (since 2025-07).
- Local testing uses `/cdn-cgi/local/email`.
- https://developers.cloudflare.com/email-service/api/route-emails/email-handler/

### Recommendation

**Main constraint: we can't copy Resend's onboarding.** With Resend, the customer adds DNS records to any provider. With Cloudflare Email Service, every customer sending or receiving domain must be **a zone in our Cloudflare account**. Options:

- **(a) Zone in our account.** The customer delegates NS for the apex or a subdomain to our account. Subdomain delegation (`mail.customer.com` as its own zone) avoids moving their apex, but subdomain zones may require Enterprise [K]. This needs a remote test.
- **(b) Shared domain.** Customers send from `customer.oursendingdomain.com` subdomains of a zone we own, onboarded via the API. Only 30 per zone, so shard across many zones.
- **(c) Hybrid.** Use Email Service for our own and shared domains, and keep a pluggable `EmailProvider` interface (Amazon SES, Postmark) for bring-your-own-domain customers who won't move DNS.

**Policy risk.** The "transactional only" rule and the unpublished quota make reselling Cloudflare Email Service as a Resend-like product a policy and abuse risk. Get written confirmation from Cloudflare (sales or support) before committing.

**Inbound**
- Route a catch-all per zone to our engine Worker's `email()` handler.
- Write the raw MIME to R2 (`raw` stream to R2 `put`).
- Parse with postal-mime, insert into the mailbox shard, then push.
- Use `setReject` for unknown recipients and policy violations.
- Avoid `forward()` except to verified addresses, which limits auto-forward features.

**Events**
- Event subscription goes to the queue `email-events`.
- The consumer updates the message status in the shard (idempotent on `eventId`), then fans out customer webhooks via our own Queue with retries.
- Use GraphQL only for dashboards and backfill.

---

## 7. Other services worth integrating

Each item says what it is for and how to expose it.

- **Workers AI:** embeddings (bge-m3) and classification or spam scoring inside actions. Expose as `ctx.ai`. Always remote in dev. [V]
- **AI Gateway:** caching, rate limiting, logging and fallback for any LLM call from user actions. Route `ctx.ai` and external providers through it. [K]
- **Turnstile:** bot protection for signup and send endpoints. Verify the token server-side in an HTTP action helper. [K]
- **Images:** thumbnails and avatars through the binding; see section 4. [V]
- **Browser Rendering** ("Browser Run"): email HTML screenshots and previews, plus HTML-to-PDF. Binding `browser`, remote in dev. [V]
- **Analytics Engine:**
  - **Use it for per-tenant event logs and metrics**: sends, opens, function latency, usage metering.
  - Per data point: 20 blobs, 20 doubles, 1 index, with blobs totalling 16 KB.
  - 250 writes per invocation. 3-month retention. Query via the SQL API.
  - Gives cheap usage-based billing for our own customers.
  - https://developers.cloudflare.com/analytics/analytics-engine/limits/ [V]
- **Logpush / Workers Logs / Tail Workers:** ship Worker logs to R2 for audit. `tail_consumers` in metadata gives a per-tenant log stream to the dashboard. [V field, K product]
- **Hyperdrive:** lets user actions talk to an external Postgres or MySQL. Low priority. There is no remote dev binding yet. [V]
- **Basin Pipelines, Catalog and SQL** (formerly Pipelines, R2 Data Catalog and R2 SQL; now GA): the cold archive of shard change-logs and audit trails as Iceberg in R2. Exactly-once to R2. Queryable for analytics without loading the shards. Binding `pipelines`. [V; the rename is a CONFLICT to watch]
- **Secrets Store:** account-level secrets shared across Workers (`secrets_store_secret` binding). Good for the provider keys of our platform, not per-tenant secrets. [V binding, K product]
- **Rate Limiting binding:** per-key `limit()` with a 10 s or 60 s period. Per-colo and eventually consistent, so use it for abuse throttling only. Use a DO limiter for strict quotas such as the send quota. [V] https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- **Containers:** heavy MIME, AV scanning (ClamAV) and DKIM tooling that needs native binaries. Use sparingly. [K]
- **Realtime / Calls:** not needed for email. Skip.
- **Queues:** the backbone for async work (embeddings, outbound send, events, webhooks). [V]
- **Dynamic Workers:** a future path to run tenant-supplied functions with DO Facets. [V]

---

## 8. Expo side

### Facts

**expo-sqlite (SDK 58)** [V]
- The config plugin has `enableFTS`, **default `true`**, which enables FTS3, FTS4 and FTS5 on iOS and Android. Prebuilt web WASM has no FTS.
- Other plugin options: `useSQLCipher`, `withSQLiteVecExtension` (sqlite-vec) and `customBuildFlags`.
- `expo-sqlite/kv-store`: a drop-in AsyncStorage replacement with sync methods. There is also a `localStorage` polyfill.
- **Session extension** is supported: `createSessionAsync`, `createChangeset`, `applyChangeset`, `invertChangeset`. This is useful for offline mutation logs.
- No libSQL or Turso sync option is on the page.
- https://docs.expo.dev/versions/latest/sdk/sqlite/

**Push via APNs or FCM directly** [V]
- `getDevicePushTokenAsync()` returns native tokens.
- APNs: p8 key + Key ID + Team ID, an ES256 JWT, HTTP/2 to `api.push.apple.com`, `apns-topic` = bundle ID.
- FCM v1: service-account OAuth to `fcm.googleapis.com/v1/projects/<p>/messages:send`.
- Push no longer works in Expo Go since SDK 53.
- https://docs.expo.dev/push-notifications/sending-notifications-custom/

**Expo Push Service** [V]
- 600 notifications/s per project. 100 messages per request.
- 4096 B payload.
- Receipts are cleared after 24 h. No SLA.
- Optional access-token enforcement.
- https://docs.expo.dev/push-notifications/sending-notifications/

**Background and silent push** [V]
- Set `enableBackgroundRemoteNotifications: true`, which adds `remote-notification` to `UIBackgroundModes`.
- Use a data-only payload with `contentAvailable: true`.
- `Notifications.registerTaskAsync` works with `expo-task-manager`.
- Apple advises sending no more than 2–3 per hour.
- https://docs.expo.dev/versions/latest/sdk/notifications/

**Background tasks** [V]
- `expo-background-fetch` is **deprecated** in favor of `expo-background-task`.
- On iOS, BGTaskScheduler decides when tasks run ("short intervals are often ignored", often overnight).
- Tasks stop after a force-quit, need a physical device, and have a 15-min minimum. The default interval is 12 h.
- https://docs.expo.dev/versions/latest/sdk/background-task/
- https://docs.expo.dev/versions/latest/sdk/background-fetch/

**EAS Submit to TestFlight** [V]
- Needs a paid Apple Developer account, `ios.bundleIdentifier`, and `ascAppId` in `eas.json`.
- An App Store Connect API key is required for `--non-interactive` CI, with `EXPO_TOKEN`.
- `eas build --auto-submit` works, or EAS Workflows with a `testflight` job, which can target internal and external groups.
- Processing takes about 10–15 min. No Mac is needed.
- https://docs.expo.dev/submit/ios/

**React Native WebSocket** [V]
- `send(string | ArrayBuffer | ArrayBufferView | Blob)`.
- `binaryType` is `'blob'` or `'arraybuffer'`. It starts undefined but behaves as `arraybuffer`.
- Binary frames are base64-bridged to native, which adds a CPU cost on large frames.
- RN docs say nothing about background behavior. iOS suspends backgrounded apps, which drops the socket.
- Sources:
  - https://github.com/facebook/react-native/blob/main/packages/react-native/Libraries/WebSocket/WebSocket.js
  - https://reactnative.dev/docs/network

### Recommendation

**Local store**
- Use expo-sqlite with FTS5 (default on) as the local replica and inbox store.
- Mirror the server-side `.searchIndex()` locally for offline search.
- Use the kv-store for the auth token cache.

**Sync protocol**
- JSON or CBOR over WSS.
- Keep frames modest (≤64 KB), because of base64 bridging.
- Reconnect on `AppState` `active`. Resume with a per-query cursor or version (Convex-style `QuerySet` versions).

**Push**
- Send **APNs and FCM directly from a Worker** (queue consumer).
- APNs over HTTP/2 from a Worker via `fetch` needs verification. Expo Push is the simpler fallback, since it is a plain HTTPS JSON API that works from Workers.
- Start with **Expo Push Service** for speed: 600/s is enough. Keep the provider pluggable.
- Visible pushes notify about new mail.
- Use a Notification Service Extension later for decrypting or previewing (not covered on the page).
- Don't rely on background fetch for mail sync. Use the push, then sync on open.

**Release**
- EAS Build plus an EAS Workflow `testflight` job, with an ASC API key stored in EAS.

---

## Remaining unknowns that need a remote test

Use a throwaway Paid account or a test zone, and delete everything afterwards. **Nothing below has been run.**

1. **Declarative `exports` vs `migrations` via the raw API.**
   1. `PUT /workers/scripts/t1` (multipart) with `metadata.exports = {"Shard": {"type":"durable-object","state":"created", ...}}`, a matching DO binding, and the class exported.
   2. Read `exports_reconciliation` in the response.
   3. Repeat with `{state:"renamed"}`.
   4. Separately, try `migrations:{new_tag:"v1", new_sqlite_classes:["Shard"]}` together with the binding *in the same upload*, to see whether the two-step problem still exists for script upload as opposed to versions.
   5. Record the error codes.
2. **Versions upload with an unchanged DO class.**
   1. After step 1, upload a code-only version through the beta API.
   2. Deploy 10/90.
   3. Confirm shards stick to one version (use `version_metadata`) across 100 requests per DO ID.
3. **Far-future DO alarm.**
   1. `setAlarm(Date.now() + 5*365*864e5)`, then `getAlarm()`.
   2. Confirm it's accepted and persisted after eviction (wait for hibernation, then read again).
   3. Also measure firing precision for an alarm 60 s out: log `Date.now() - scheduled` across 50 runs.
4. **Max WebSockets per DO and hibernation.**
   1. Open N hibernatable sockets to one DO from a load script (k6 or Node `ws`), stepping N = 1k, 5k, 10k, 32k.
   2. Record the first failure or close code, broadcast latency, and memory errors.
5. **FTS5 in DO SQLite.**
   1. `CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61 remove_diacritics 2')`.
   2. Insert "ação" and query "acao". Also try the `trigram` tokenizer, `bm25()`, `highlight()` and `snippet()`.
6. **Email Sending for a domain outside our account.**
   1. Try `POST /zones/{zone}/email/sending/subdomains` for a zone in account A using a token from account B. Expect failure.
   2. Try a **partial (CNAME) setup** zone, if a Business plan is available, and a **subdomain zone**, such as delegating `mail.example.com` NS to account A.
   3. Record which ones accept onboarding and actually send (check `delivered` events).
7. **Email Routing for a delegated subdomain.**
   1. On the same subdomain zone as test 6, `POST /zones/{id}/email/routing/dns`.
   2. Add a catch-all with action `worker`.
   3. Send from Gmail and confirm the `email()` handler fires, logging `rawSize`, the `Authentication-Results` header and `canBeForwarded`.
8. **Sending quota and cadence for a new account.**
   1. Send 50, then 200, then 1,000 transactional emails over a day to verified addresses (free) and to seed inboxes (Gmail, Outlook, iCloud).
   2. Record rate-limit responses, quota headers or errors, and spam placement.
   3. Also ask support about SaaS, multi-tenant reselling and the transactional policy.
9. **Event subscription delivery semantics.**
   1. Subscribe a sending domain to a Queue.
   2. Send to a known bad address and to a complaint simulator if one exists.
   3. Measure event latency, duplicates (same `eventId`) and ordering (deferred → bounced).
10. **Vectorize and AI Search in local dev.**
    1. `wrangler dev` with `vectorize` and `ai_search_namespaces` set to `remote:true`. Confirm queries and `items.upload` work.
    2. Confirm `env.AI_SEARCH.create(...)` signature and latency for runtime instance creation.
    3. Measure `uploadAndPoll` time for a 50 KB pt-BR email body with hybrid on.
    4. Query in pt-BR with keyword-only and hybrid modes, and record recall.
11. **Embedding dims and pt-BR quality.**
    1. Call `@cf/baai/bge-m3`, `@cf/qwen/qwen3-embedding-0.6b` and `@cf/google/embeddinggemma-300m` and record `shape`.
    2. Run a 100-pair pt-BR email retrieval eval (MRR@10) to choose the default.
12. **APNs HTTP/2 from a Worker.**
    1. From a Worker, `fetch("https://api.sandbox.push.apple.com/3/device/<token>")` with an ES256 JWT, using WebCrypto ECDSA P-256 signing.
    2. Confirm APNs accepts it. Workers `fetch` negotiates HTTP/2 to origins, which needs verifying.
    3. Fallback: Expo Push API.
13. **Presigned multipart from RN.**
    1. Upload a 300 MB file from an iOS device using presigned `UploadPart` URLs and `CompleteMultipartUpload` signed in the Worker.
    2. Confirm the R2 `object-create` notification arrives in the Queue and records `size` and `eTag`.
14. **Images binding with HEIC.**
    1. Run `env.IMAGES.input(r2obj.body).transform({width:256}).output({format:"image/webp"})` on an iPhone HEIC photo.
    2. Record whether HEIC input is supported and the latency.
15. **Workflows concurrency conflict.**
    1. Create 12,000 instances that each do `step.do` for CPU-bound 10 s work.
    2. Check whether running instances cap at 10k or 50k.
16. **Cron trigger count via API.**
    1. `PUT /schedules` with 5 crons on one Worker, then 300 across Workers.
    2. Confirm the 250 per-account cap and any per-Worker cap.
