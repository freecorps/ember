# Spike: first-party Better Auth on Workers + SQLite Durable Objects

Date: 2026-11-04. Everything ran locally (vitest + `@cloudflare/vitest-plugin` on workerd 2026-08-15, and `wrangler dev --local`). **Nothing was deployed.** The only wrangler command that touched the deploy path was `wrangler deploy --dry-run --outdir`, which bundles locally and uploads nothing.

Versions: `better-auth@1.7.17`, `@better-auth/core@1.7.17`, `@better-auth/test-utils@1.7.17`, `@better-auth/passkey@1.7.17`, `@better-auth/api-key@1.7.17`, `@convex-dev/better-auth@0.13.0` (read only), `wrangler@4.157`, `@cloudflare/vitest-plugin@1.5.1`, `vitest@4.1.12`.

Legend: **[TESTED]** = run in this spike, with evidence. **[SOURCE]** = read in `node_modules` source. **[DOCS]** = from docs or GitHub issues, not verified here.

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Can Better Auth run on DO SQLite? | **Yes [TESTED].** The custom adapter passes **460/460** tests of Better Auth's official adapter conformance suite (`@better-auth/test-utils/adapter`) inside workerd. The suite covers basic CRUD, transactions with real rollback, auth-flow, joins, number-id, uuid and case-insensitive. |
| E2E flows (sign up, sign in, session, bearer, JWT, org create/invite/accept, 2FA TOTP) | **10/10 PASS [TESTED]** through Worker → auth DO over HTTP. |
| Merged plugin schema without a DB, for codegen | **Yes [TESTED].** `getAuthTables(options)` from `better-auth/db` is a pure function of the options. It worked for all 12 target plugins; the resulting DDL applies cleanly to SQLite. |
| scrypt on Workers | **~36 ms per hash [TESTED].** In 1.7.x, `@better-auth/utils/password` resolves the `workerd` export condition to native `node:crypto.scrypt`. The pure-JS fallback (`@noble/hashes`) costs **~940 ms**. That 26x gap explains the old "CPU limit exceeded" issues. |
| Cheap `ctx.auth` | Short-lived JWT (jwt plugin, EdDSA) verified in the Worker with a cached JWKS: **~0.04 ms per verify, 0 DO hops [TESTED]**. Fallbacks are the signed cookie cache (local verify) and a DO session lookup (~1-2 ms locally). |
| Where auth tables live | **A dedicated auth DO (SQLite)**, not D1 and not the app shards. Reasons in §6.3. |

---

## 1. Better Auth adapter API [SOURCE + TESTED]

Source files: `node_modules/@better-auth/core/dist/db/adapter/{index,types,factory}.d.mts|.mjs`.

**Factory.** `createAdapterFactory({ config, adapter })` from `@better-auth/core/db/adapter`. It is re-exported via `better-auth/adapters`. The older `createAdapter` name is gone in 1.7. The factory returns `(options) => DBAdapter`.

`config` (`DBAdapterFactoryConfig`) has these fields:
- `adapterId` and `adapterName`.
- `usePlural`.
- `supportsNumericIds`, `supportsUUIDs`, `supportsJSON`, `supportsDates`, `supportsBooleans`, `supportsArrays`. When one of these is false, the factory serializes that type for you: Date↔ISO string, boolean↔0/1, json/arrays↔JSON string.
- `transaction: false | (cb) => …`.
- `disableIdGeneration`, `customIdGenerator`.
- `mapKeysTransformInput` / `mapKeysTransformOutput`.
- `customTransformInput` / `customTransformOutput`.
- `debugLogs`.

**Methods you implement (`CustomAdapter`).**
- Required: `create`, `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`.
- Optional (new in 1.7): `consumeOne` and `incrementOne`.
  - `consumeOne` is an atomic delete-and-return of one row. It is used for single-use verification tokens.
  - `incrementOne` is a guarded atomic counter (`field = field + delta WHERE guard`).
  - If you omit them, the factory falls back to snapshot-guarded delete and CAS retries. On a DO both are trivially atomic, because the DO is single-threaded and SQL is synchronous. We implemented both natively with `DELETE/UPDATE … WHERE rowid=(SELECT … LIMIT 1) RETURNING *`.
- Optional: `createSchema` (used by the `@better-auth/cli generate` path).
- `transaction` is configured on the factory, not on `CustomAdapter`.

**What the adapter receives.**
- Every method gets `{model, modelKey}`: the physical table name plus the canonical Better Auth key.
- `where` arrives as `CleanedWhere[]`, i.e. `{field, operator, value, connector:'AND'|'OR', mode:'sensitive'|'insensitive'}`.
  - Operators: `eq, ne, lt, lte, gt, gte, in, not_in, contains, starts_with, ends_with`.
  - `value === null` must map to `IS NULL` / `IS NOT NULL`.
  - Semantics, matching the kysely adapter: `(all AND clauses) AND (OR clause1 OR clause2 …)`.
- `findMany` also gets `limit`, `offset`, `sortBy`, `select`.

**Joins.**
- Callers pass `join: { model: true | {limit} }`. The factory resolves this into a `JoinConfig` of `{ on: {from,to}, relation: 'one-to-one'|'one-to-many', limit }`, inferred from `references` in the schema, in either direction.
- The adapter returns the joined rows nested under the model key.
- Joins are only used when the user sets `advanced.database.joins: true`. Otherwise Better Auth issues separate queries.
- Our adapter does one indexed lookup per base row. That is fine because DO SQLite is in-process.

**IDs.**
- By default Better Auth generates 32-char random string ids.
- `advanced.database.generateId`: `"serial"` gives numeric ids, which needs `supportsNumericIds`. `"uuid"` gives UUIDs. You can also pass a function or `false`.
- `forceAllowId` lets callers pin ids.
- Our adapter supports all three modes; the number-id and uuid suites pass.

**Schema model.**
- `BetterAuthDBSchema` = `Record<key, { modelName, fields: Record<name, DBFieldAttribute>, indexes?, disableMigrations?, order? }>`.
- `DBFieldAttribute` = `{ type: 'string'|'number'|'boolean'|'date'|'json'|'string[]'|'number[]'|literal[] (enum), required?, unique?, index?, references?: {model, field, onDelete}, fieldName?, defaultValue?, onUpdate?, input?, returned?, bigint?, sortable?, transform?, validator? }`.

**How plugins contribute schema.**
- A plugin object has `schema: { [model]: { fields, modelName?, indexes? } }`.
- `getAuthTables(options)` merges core tables, plugin fields and `user/session/account/verification.additionalFields`. It applies `modelName`/`fieldName` overrides. It adds `rateLimit` only when `rateLimit.storage === "database"`.
- It is **pure (no DB)**, so our CLI can call it directly ([TESTED] `scripts/dump-schema.ts`, `scripts/all-plugins-schema.ts`).
- Resolved composite indexes come from `getAuthTablesWithResolvedIndexes` in `@better-auth/core/db/internal`. This is an *internal* entry point, so pin the version or fall back to `field.index`/`unique`.
- `@better-auth/cli generate` calls the adapter's `createSchema` (Convex uses this to emit `defineTable` code). Our CLI does not need the Better Auth CLI at all.

**Official conformance suite.** `@better-auth/test-utils/adapter` exports `testAdapter`, `normalTestSuite`, `transactionsTestSuite`, `authFlowTestSuite`, `joinsTestSuite`, `numberIdTestSuite`, `uuidTestSuite` and `caseInsensitiveTestSuite`. It needs a `runMigrations(options)` callback, because tests change options (renamed fields and models, additional fields, plugins) and expect the schema to follow.

### Plugin schemas observed [TESTED, `evidence/all-plugins-schema.txt`]

Config: organization(teams) + admin + twoFactor + passkey + magicLink + emailOTP + apiKey + jwt + bearer + anonymous + username + phoneNumber.

Result: 13 tables (user, session, account, verification, organization, team, teamMember, member, invitation, twoFactor, passkey, apikey, jwks) and 30 DDL statements, all applied cleanly to SQLite.
- magicLink, emailOTP, bearer and anonymous add **no tables**. magicLink and emailOTP use `verification`; anonymous adds `user.isAnonymous`.
- admin adds `user.role/banned/…` and `session.impersonatedBy`.
- organization adds `session.activeOrganizationId` (and `activeTeamId` when teams are enabled).

---

## 2. How @convex-dev/better-auth does it [SOURCE: `node_modules/@convex-dev/better-auth/src`]

- **Component.** Auth tables live in a Convex *component* with its own schema (`src/component/schema.ts`, generated) and generic adapter functions (`component/adapter.ts`: create/findOne/… as Convex queries and mutations).
  - The app reaches them through `ctx.runQuery(component.adapter.findOne, …)`.
  - Auth tables are isolated from the app schema, and the app reads them only through helpers.
- **Schema generation.**
  - Their adapter implements `createSchema`, so `npx auth generate` (the Better Auth CLI) writes `defineTable(...)` code from `getAuthTables`.
  - They add hand-written extra indexes (`indexFields` in `client/create-schema.ts`). The reason: Convex can only query through declared indexes, while Better Auth queries e.g. `account` by `(accountId, providerId, userId)` and `session` by `expiresAt`.
  - Compound unique indexes are rejected.
  - Lesson for us: Better Auth's own `index`/`indexes` metadata does not cover every query it makes. SQLite falls back to table scans, which is acceptable at auth-table scale, but our CLI should emit the same extra indexes.
- **Where auth runs.**
  - `registerRoutes(http, createAuth)` mounts `auth.handler` as a **Convex HTTP action** on `/api/auth/*`.
  - Every adapter call becomes a separate `runQuery`/`runMutation`, i.e. many round trips per request.
  - Adapter config: `transaction: false`, `supportsDates: false`.
- **ctx.auth.**
  - The `convex()` Better Auth plugin wraps the **jwt plugin**. It is pinned to RS256 when `customJwt` is used, with 15-min expiry by default. The payload is the user minus id/image, plus `sessionId`, `iat` and `sub`.
  - It sets a `convex_jwt` cookie on `/get-session` and clears it on sign-in, sign-out and similar paths.
  - It exposes `/convex/jwks` and `/convex/.well-known/openid-configuration`.
  - `auth.config.ts` registers a `customJwt` provider (issuer = site URL, `applicationID: "convex"`, JWKS URL or a *static JWKS inlined as a data: URI* from an env var).
  - Convex's built-in `ctx.auth.getUserIdentity()` then verifies the JWT natively, with no DB.
- **`getAuthUser(ctx)`** does two more component lookups: the session by `identity.sessionId` with `expiresAt > now`, then the user. So it re-checks revocation, at the cost of reads.
- **Things they had to work around (avoid them).**
  - Cookie cache is force-disabled, because their adapter returned dates as numbers and 1.7 validates the cache with Dates. Our factory-based adapter returns real `Date`s, and cookie cache works [TESTED].
  - In query context, writes are monkey-patched to no-ops (`noopWrite`) because Convex queries are read-only. That hack is fragile; we don't need it because auth runs in the DO, which can always write.
  - `generateId: "uuid"` breaks their single-use reservations, because Convex assigns its own ids. We store Better Auth's ids as-is, and the uuid suite passes.
  - No transactions. We get real ones (`ctx.storage.transaction`).

**Copy from them:**
1. Auth tables isolated from app tables.
2. A first-party Better Auth plugin that issues the engine JWT and serves JWKS + OIDC discovery.
3. A static JWKS option, so verification needs zero fetches even on a cold isolate.
4. A `getAuthUser` that re-validates the session when the app wants revocation accuracy.
5. Extra-index list.
6. A codegen'd schema file with a "do not edit" header.

**Avoid:**
1. Running Better Auth where every adapter call is a cross-boundary RPC.
2. No-op write hacks.
3. Disabling the cookie cache.
4. Forcing RS256. EdDSA is the jwt-plugin default and verifies fine with `jose` on workerd.

---

## 3. Runtime on Workers

- **Password hashing [TESTED, `test/scrypt-bench.test.ts`].** Better Auth's default is scrypt N=16384, r=16, p=1, dkLen=64, which needs a 32 MiB working set.

  | implementation (workerd, local Mac) | median per hash |
  |---|---|
  | `node:crypto.scrypt` (nodejs_compat) | **33-36 ms** |
  | `better-auth/crypto` `hashPassword` (resolves to the above via the `workerd` export condition) | **35-39 ms** |
  | `@noble/hashes` scrypt (pure JS fallback) | **~920-960 ms** |

  - 8 concurrent hashes take ~250 ms, i.e. they serialize on one thread.
  - E2E sign-up is ~49-60 ms and sign-in ~36-42 ms. Both are dominated by scrypt. `get-session` is 3-7 ms. These numbers come from vitest and from curl against `wrangler dev`.
  - Note: `Date.now()` only advances across I/O in production Workers. Locally it advanced during CPU work (checked), so local numbers are meaningful, but production CPU may differ.
- **CPU limits [DOCS].**
  - Free plan: 10 ms CPU per request. Sign-up/sign-in will **not** fit; Better Auth issue #969 and the AnswerOverflow thread say the same.
  - Paid plan: 30 s default, up to 5 min. Some older accounts have a 50 ms cap.
  - Issue #8860 (sign-up exceeds CPU limit) was the pure-JS path. With 1.7's `workerd`→native mapping, ~35 ms is fine on Paid.
  - Our engine should **require Paid or offer a `password.hash` override** (e.g. PBKDF2 via WebCrypto, which is native too).
- **DO single-thread concern.**
  - When scrypt runs inside the one auth DO, it caps throughput at roughly 1000/36 ≈ **~27 sign-ins/s** for the whole app.
  - Mitigation implemented: the Worker passes an `RpcTarget` (`EdgeHasher`) on the DO RPC call (`AuthShard.handle(request, hasher)`). Better Auth's `password.hash`/`verify` then call back, so scrypt runs in the *calling Worker's isolate* and the DO only does SQL.
  - **Functionally [TESTED]** (`test/hash-offload.test.ts`): remote hashes verify locally and vice versa, and wrong passwords are rejected.
  - **The throughput benefit is NOT measurable locally**, because Worker and DO share one workerd process (~259 ms vs ~259 ms for 8 concurrent sign-ups). It needs a production load test.
- **Crypto and Node deps [TESTED].**
  - Needs the `nodejs_compat` flag (`node:crypto` scrypt and `node:async_hooks` AsyncLocalStorage, which Better Auth also uses for request context).
  - JWT signing and verification (jose, EdDSA/Ed25519), TOTP (HMAC), and encryption of the jwks private key and 2FA secrets all work in workerd.
  - Bundle size: **2.09 MiB raw / 372 KiB gzip** for Worker + DO + Better Auth + 4 plugins (`wrangler deploy --dry-run`). That is well within limits.
- **Gotchas found.**
  - **DO SQLite enforces foreign keys** (observed). With FK clauses in the DDL, 348/460 conformance tests fail ([TESTED], `evidence/adapter-with-fk-enforced.log`), because the suite inserts rows with dangling references. Real Better Auth flows pass *with* FKs (all E2E tests run with FKs on).
    - Decision: emit FKs (with `ON DELETE CASCADE` so delete-user cleans up) for the auth DO. Run the conformance suite with FKs off, as other SQL adapters do.
  - The organization plugin needs `emailVerified` for list/accept invitation. The test exercises the real `send-verification-email` → `verify-email` flow. Our engine must ship an email-sending hook (queue or outbox) as part of first-party support.
  - `getCookieCache` must be given `isSecure` matching the deployment. In production, cookies are `__Secure-` prefixed.

---

## 4. Secondary storage [SOURCE + reasoning; not tested]

`SecondaryStorage` = `get`, `set(key, value, ttlSeconds)`, `delete`, plus **`getAndDelete` (atomic)** and **`increment(key, ttl)` (atomic)**. Both atomic methods are required in 1.7.

When it is configured, Better Auth stores in it:
- sessions (keyed by token, holding JSON with session and user);
- `active-sessions-<userId>` lists;
- verification values;
- rate-limit counters.

Sessions are also written to the DB only when `session.storeSessionInDatabase` is set.

- **KV:** not suitable. It has no atomic `getAndDelete`/`increment`, it is eventually consistent (up to ~60 s), and its TTL minimum is 60 s. Revocation and single-use tokens would be wrong.
- **A DO:** correct (single-threaded, so atomic). But we *already* run Better Auth inside a DO whose SQLite is in-process, so a separate secondary-storage DO only adds a hop.
- **Recommendation:** do **not** configure `secondaryStorage` in v1.
  - Rate limiting: use `rateLimit.storage: "database"` (adds the `rateLimit` table in the auth DO, which is atomic and durable) or `"memory"` (the DO is a singleton, so memory is effectively global, but it is lost on eviction). Rate limiting is only on in production by default.
  - Revisit if we shard auth. A secondary storage then becomes the cross-shard session index (a DO keyed by token prefix), and KV may be used as a read-through cache only.

---

## 5. Spike implementation

| File | What |
|---|---|
| `src/do-sqlite-adapter.ts` | **The adapter.** `doSqliteAdapter(executor)` via `createAdapterFactory`. It includes all 8 required methods plus native `consumeOne`/`incrementOne`, joins, insensitive mode, and real transactions. The executor abstraction is `sqlStorageExecutor(ctx.storage.sql, txFn)` in production; the test harness passes an RPC-backed executor. `contains`/`starts_with`/`ends_with` use `instr`/`substr`, not `LIKE`, so `%`/`_` in user input are literal (the suite checks this). |
| `src/ddl.ts` | Better Auth schema → SQLite DDL (`tableSpecs`, `schemaDDL`) and an additive `migrate()` (new tables, columns and indexes; destructive rebuild only when `destructive:true`, used by tests). |
| `src/auth-config.ts` | Config: emailAndPassword + emailVerification + cookieCache + organization + jwt + bearer + twoFactor. It is a function of runtime hooks, so the CLI can evaluate it without a DB. |
| `src/auth-shard.ts` | `AuthShard` DO. It runs `betterAuth({... database: doSqliteAdapter(...)})` next to its SQLite. `fetch` = auth handler. RPC methods: `handle(req, hasher)`, `getSession`, `getJwks`. |
| `src/index.ts` | Worker: routes `/api/auth/*` to the DO. `resolveAuth()` resolves JWT, then cookie cache, then DO session lookup. `EdgeHasher` RpcTarget. `/api/whoami` demo. |
| `scripts/dump-schema.ts` | Codegen prototype. Writes `generated/auth-schema.json`, `generated/auth-schema.sql`, and `generated/auth-tables.ts` (engine-style `defineTable`/`v` with `owner:"auth"`). |
| `scripts/all-plugins-schema.ts` | Schema for all 12 target plugins, applied to `node:sqlite`. |
| `test/adapter.test.ts` | Better Auth's official conformance suite, run against a real DO via `runInDurableObject`. |
| `test/flow.test.ts` | E2E flows over HTTP through the Worker. |
| `test/scrypt-bench.test.ts`, `test/hash-offload.test.ts` | Hashing measurements and offload. |

Run: `npm test`. Use `WITH_FK=1 npx vitest run test/adapter.test.ts` for the FK-enforced variant. `npx tsx scripts/dump-schema.ts` runs codegen. `npx tsc -p .` is clean.

### Test results [TESTED] — `evidence/all-tests.log`

```
Test Files  4 passed (4)
     Tests  472 passed (472)
```

| Test | Result | Evidence |
|---|---|---|
| Better Auth adapter conformance (normal, transactions, auth-flow, joins, number-id, uuid, case-insensitive) | **PASS 460/460** | `evidence/all-tests.log` (e.g. `✓ … transaction ─ should rollback failing transaction`) |
| same, with FK constraints in DDL | 112/460 (expected: the suite inserts dangling FKs) | `evidence/adapter-with-fk-enforced.log` |
| sign up (scrypt in DO) | PASS, 49-60 ms | flow-results `signUpMs` |
| sign in / wrong password → 401 | PASS, 36-42 ms / 37-44 ms | `signInMs`, `signInBadMs` |
| get-session (cookie) | PASS, 5-7 ms | `getSessionMs` |
| get-session via bearer plugin | PASS | flow.test.ts |
| jwt plugin `/token`, `/jwks` (EdDSA), `set-auth-jwt` header on get-session | PASS | `jwksAlg: "EdDSA"` |
| ctx.auth: JWT verified in Worker | PASS, **0.035-0.045 ms avg** over 200 verifies, **1** JWKS fetch | `jwtVerifyAvgMs`, `jwksFetches == 1` |
| ctx.auth: cookie cache (local HMAC verify) | PASS | `via: "cookie-cache"` |
| ctx.auth: session lookup in DO | PASS, 1-2 ms local | `sessionLookupMs` |
| tampered JWT rejected | PASS | flow.test.ts |
| org: create, invite (hook fired), email verification, list invitations, accept, full-org shows owner+member, set-active | PASS | flow.test.ts |
| 2FA: enable TOTP, verify, sign-in → `twoFactorRedirect`, verify-totp, `twoFactorEnabled` | PASS | flow.test.ts |
| after sign-out: DO lookup → null; JWT still valid until exp; copied cookie-cache still valid until maxAge | PASS (documents the trade-off) | `cookieCacheAfterSignOut: "cookie-cache"` |
| scrypt bench | node 36 ms, noble 941 ms, BA 37 ms | `[scrypt-bench]` line |
| hash offload via RpcTarget | PASS functionally (3 remote / 1 local hash calls counted); no local speedup | `[hash-offload]` line |
| `wrangler dev --local` + curl | sign-up 200 in 36-49 ms, sign-in 35-36 ms, get-session 3-6 ms, `/api/whoami` via cookie-cache and via JWT, 0-1 ms | transcript below |
| codegen for 12 plugins | PASS, 13 tables, DDL applies | `evidence/all-plugins-schema.txt` |

curl transcript (wrangler dev, local):
```
sign-up 200 0.049s | 0.036s | 0.036s
sign-in 200 0.036s | 0.035s | 0.036s
get-session 200 0.006s | 0.003s | 0.003s
{"identity":{"subject":"hFrV9u…","sessionId":"DqaN…","email":"1curl-17298@example.com","activeOrganizationId":null,"via":"cookie-cache"},"ms":1}
{"identity":{"subject":"hFrV9u…","email":"1curl-17298@example.com","via":"jwt"},"ms":0}
```

Not tested: passkey (WebAuthn needs a browser authenticator), magic-link/email-OTP flows (their tables and codegen were tested, the flows were not), api-key flows, admin/impersonation, anonymous, OAuth social providers, production CPU timing, and DO throughput under load.

---

## 6. Recommended design for first-party Better Auth in the engine

### 6.1 Developer surface
```ts
// auth.config.ts
import { defineAuth } from "@engine/auth";
import { organization, twoFactor, admin } from "better-auth/plugins";
export default defineAuth({          // returns BetterAuthOptions + engine metadata
  emailAndPassword: { enabled: true },
  plugins: [organization(), twoFactor(), admin()],
  emails: "emails:send",              // engine action that sends verification/invite/OTP emails
  jwt: { ttl: "10m", claims: ({ user, session, member }) => ({ org: session.activeOrganizationId, role: member?.role }) },
});
```
The engine injects `database`, `secret`, `baseURL` and its own `engine()` plugin. The user never configures `jwt()`/`bearer()` by hand; we add them.

### 6.2 Codegen (CLI)
1. Bundle and evaluate `auth.config.ts` in Node with esbuild/tsx. Runtime hooks are stubs at this stage, which is why config must be a pure function of hooks (as in `src/auth-config.ts`).
2. `getAuthTables(options)` gives the merged core + plugin + additionalFields schema [TESTED]. Add the Convex-style extra-index list. Resolve composite indexes via `getAuthTablesWithResolvedIndexes` and pin the Better Auth minor version, because it is an internal API.
3. Emit:
   - `_generated/authSchema.ts`: `defineTable` entries tagged `owner: "auth"`, read-only to app code (prototype: `generated/auth-tables.ts`).
   - Typed `Id<"user">` and doc types, so app tables can declare `v.id("user")` and `v.id("organization")`.
   - A versioned SQL migration for the auth DO (prototype: `generated/auth-schema.sql`, `src/ddl.ts`). It is additive automatically; destructive changes need a reviewed migration, same policy as app tables.
4. Merge into the user schema namespace with conflicts rejected: the user cannot define `user`, `session`, … themselves. To extend the user record, they use `user.additionalFields` in the auth config, which flows through the same pipeline. Better Auth types (`auth.$Infer`) and our generated types then agree.

### 6.3 Where tables live: a dedicated auth DO (recommended) vs D1 vs app shards

| | Auth DO (SQLite) | D1 | App DO shards |
|---|---|---|---|
| Adapter round trips per auth request (Better Auth makes ~5-15 adapter calls for sign-in or org ops) | in-process, µs | 1 network hop **each** (Better Auth runs in the Worker, not next to D1) | n/a |
| Transactions | real (`storage.transaction`) [TESTED] | `batch` only; Better Auth's D1 path (kysely) runs without interactive transactions | real |
| Atomic `consumeOne`/`incrementOne` | trivially (single-threaded) [TESTED] | CAS fallback | trivially |
| Global uniqueness (email, org slug, session token) | yes (one DB) | yes | **no** (needs cross-shard coordination) |
| Ops consistency with the rest of engine (backups, PITR, migrations) | same machinery as app DOs | second storage system | same |
| Scale ceiling | one DO, ~1k simple req/s [DOCS]; scrypt must be offloaded | single-writer too, plus read replicas | n/a |

**Decision: one auth DO per deployment** (`idFromName("auth")`). Better Auth runs *inside* it, and the Worker forwards `/api/auth/*` to it over RPC. This is what the spike implements.
- Keep the hot path off it: `ctx.auth` comes from the JWT, verified in the Worker (§6.4).
- Keep CPU off it: pass the `EdgeHasher` RpcTarget so scrypt runs in the edge Worker [functionally TESTED; perf to verify in prod].
- Expected load on the auth DO is then only sign-in/up/out, token refresh every ~10 min per active client, and org admin. That is roughly *1000 req/s × 10 min ≈ 600k concurrently active clients* before it becomes the bottleneck. Validate with a load test.
- Future sharding (not v1): partition users by `hash(email)` across N auth DOs. Session token, JWT `kid` and `sub` would carry a shard prefix, and a small directory DO would own org-slug uniqueness. Better Auth's adapter interface makes this feasible, since the adapter can route by model and where clause, but it is real work. Don't do it until measured.

**App shards never hold auth tables.** App data that needs user info should:
- (a) use JWT claims (`sub`, `sid`, `org`, `role`); or
- (b) keep an app-owned mirror (`profiles`), maintained by `databaseHooks.user.create/update.after`. The auth DO enqueues an engine mutation, like Convex triggers; or
- (c) call `ctx.auth.getUser()`, which does an RPC to the auth DO and is cached per request.

`v.id("user")` in app tables is a logical reference only, with no FK across DOs.

### 6.4 `ctx.auth` in queries/mutations — recommendation

Resolution order in the engine Worker, before dispatching to the app DO (implemented in `resolveAuth`, `src/index.ts`):

1. **`Authorization: Bearer <JWT>`** (or an engine `__eng_jwt` cookie set by our plugin on get-session, like `convex_jwt`). Verify with `jose` against a JWKS.
   - The JWKS is cached per isolate and refetched on unknown `kid`. Better: inline a *static JWKS* in the Worker's env/bundle at deploy, as Convex does.
   - Cost: **~0.04 ms, 0 hops** [TESTED].
   - Claims: `sub`, `sid`, `email`, `org` (activeOrganizationId), `role`, `iat`, `exp`, `iss`, `aud`.
   - TTL 5-10 min.
2. **Signed cookie cache** (`session.cookieCache`, compact/HMAC or `jwe`). Verify locally with the secret: 0 hops [TESTED]. This handles browser SSR/first request before the client has a JWT.
3. **Opaque session token** (cookie or bearer plugin). RPC to the auth DO `getSession` (~1-2 ms local, plus one DO hop in prod). Revocation-exact.

The resulting `Identity` is passed to the app DO with the query or mutation. `ctx.auth.getUserIdentity()` is synchronous and cheap.

**Why JWT-first:**
- Queries and subscriptions are the hot path and are fanned out to many shards. A per-call session lookup would turn the auth DO into a global hot spot.
- **Trade-off [TESTED]:** after sign-out, the JWT (and any copied cookie-cache cookie) stays valid until `exp`/`maxAge`. Mitigations:
  - short TTL;
  - `ctx.auth.requireFreshSession()` for sensitive mutations, which forces path 3;
  - optionally, a revoked-`sid` list pushed from the auth DO to Workers for the ≤ TTL window.
- For websockets/subscriptions: authenticate on connect with the JWT. The client refreshes via `/api/auth/token` before `exp` and re-sends (`setAuth`), as Convex clients do. On expiry, the server drops the identity from live subscriptions.
- Org role in the JWT means authorization checks need no DB. Role changes take effect within TTL. The engine plugin should clear the JWT cookie when org membership or role changes.

### 6.5 Engine plugin (`engine()`; like Convex's `convex()` but without its hacks)
- It wraps `jwt()` (EdDSA default) and `bearer()`.
- `definePayload` adds `sid`, `org`, `role`.
- It sets and clears the engine JWT cookie on the same path matchers Convex uses (sign-in/up, callback, magic-link verify, email-otp verify, sign-out, update-session, get-session).
- It exposes `/.well-known/openid-configuration` and `/jwks`.
- It provides `rotateKeys` (the CLI pushes the new static JWKS to the Worker env).
- It keeps the cookie cache **on**.
- It requires email hooks (verification, invitation, magic link, OTP) to be wired to an engine action. The organization plugin *requires* verified email to accept invites [TESTED].

### 6.6 Risks / open items
- `getAuthTablesWithResolvedIndexes` is internal. Pin Better Auth to a minor version and run the conformance suite in CI on upgrades. `@convex-dev/better-auth` also pins (`>=1.7.16 <1.8.0`).
- Production CPU per scrypt and real DO throughput with the RpcTarget hasher need a deployed load test (not done: no deploys).
- Free-plan Workers cannot do email+password at all (10 ms CPU) [DOCS]. Document a Paid requirement, or let users opt into a cheaper hash.
- Passkey, magic-link, email-OTP, api-key and admin flows were not exercised E2E. Their schemas and codegen are verified, and they use the same adapter primitives that pass the conformance suite.

### Sources [DOCS]
- [better-auth#8860: sign-up exceeds CPU time limit on Workers](https://github.com/better-auth/better-auth/issues/8860)
- [better-auth#969: Cloudflare "script will never generate a response"](https://github.com/better-auth/better-auth/issues/969)
- [AnswerOverflow: Worker exceeded CPU time on sign-up/email](https://www.answeroverflow.com/m/1357795265108512808)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
