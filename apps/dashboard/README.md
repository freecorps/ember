# Ember Dashboard (`apps/dashboard`)

A Worker (JSON API) and a React SPA, bundled into one module and deployed into your own Cloudflare account by
`ember dashboard deploy` (or by `ember deploy`, which links each project to it). The contract — roles, writes, the
audit log, every endpoint — is `docs/design/contracts.md`, section "Dashboard"; `ROUTES` in `src/worker.ts` is that
table in code.

## Run it

- **Deployed:** `ember dashboard deploy` (Cloudflare Access in front, or a dashboard token). Never open without a login.
- **Locally, against `ember dev`:** `ember dev --dashboard` serves it on `http://127.0.0.1:8788` for the local runtime:
  no login (this machine only: loopback hosts and peers, never on Cloudflare), a local registry (D1 of the Miniflare
  session) and a session token for the runtime's admin endpoints. No Analytics Engine or live logs locally.
- **UI work:** `bun run dev` here runs Vite and proxies `/api` to a running dashboard Worker (`EMBER_DASHBOARD_URL`,
  default `http://localhost:8788` — that is, `ember dev --dashboard`).

## Screens

Health, Functions (charts, errors, the runner), **Estimated cost**, App screens and Components (declarative screens of
`defineApp`/`defineComponent({ dashboard })`), Shards, Data, Reactivity, Logs, Files, Users, Schedules, Deployments,
the audit log and Settings. Single keys switch sections (`?` lists them); `/` searches shards; **`⌘K` / `Ctrl+K`**
opens the command palette (environments, sections, screens, shards, tables, functions, users).

- **What it costs the project.** Opening a screen wakes no shard: Health and Shards read the shard catalog (D1) and ask
  for the live status (one request that wakes each shard it names, up to 50) only from the "Check live status" button
  or for the shard you select. The shard search is debounced and reads D1 only.
- **Estimated cost** (`src/pricing.ts`): a month projected from the metrics (Workers and Durable Object requests,
  SQLite rows read and written, SQLite storage) at Cloudflare's published prices — the module lists the pages and the
  date they were read. An estimate, labelled as one: CPU time, Durable Object duration and what the app keeps in
  D1/R2/KV are not measured, and nothing here bills anyone.

## Tests

`bun run test`: the Worker (`test/worker.test.ts`, `security.test.ts`, `perf.test.ts`, `logs.test.ts`,
`pricing.test.ts`) and the SPA in real Chromium (`test/browser`, playwright-core; skipped without an installed
Playwright browser unless `EMBER_REQUIRE_BROWSER=1`). The browser test counts every call the fake project receives
(`fakeProject().calls`). End to end against a real runtime: `examples/files-auth-jobs/test/dashboard.test.ts`;
`ember dev --dashboard`: `packages/cli/test/dev-dashboard.test.ts`.
