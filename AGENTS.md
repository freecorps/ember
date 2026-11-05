# Ember — agent instructions

Read `docs/PLAN.md` first. It is the source of truth for design decisions (D1–D12, sections 1–21).

## Layout
- `packages/values` — `v.*` validators, Shape, JSON Schema, order-preserving index key encoding.
- `packages/server` — `defineSchema`/`defineTable`/`defineShard`, index-kind plugin API, function builders, query builder → SQL compiler, read-set recording, schema→DDL and migration planner. Pure TS, no Cloudflare APIs.
- `packages/runtime` — Worker + Durable Objects (`Shard`, `Auth`, `System`): transactions, group commit, subscriptions, protocol, scheduler, files.
- `packages/client`, `packages/react`, `packages/react-query` — client SDKs.
- `packages/offline` — optional offline-first `StorageAdapter`s for the client (memory, IndexedDB, SQLite/expo-sqlite, SQLite-Wasm on OPFS in a Worker, TinyBase) over `@freecorps/ember-server`'s local query execution (`runLocalQuery`), reactive local results, multi-tab coordination (`coordinateTabs`). Workerd E2E in `test/workerd`; real-Chromium E2E in `test/browser` (playwright-core, reuses an installed Playwright browser, skipped without one).
- `packages/react-native` — Expo/RN: AppState+NetInfo connectivity, AsyncStorage pending storage, SecureStore bearer auth, `registerForPush` (Expo or native token, APNs environment, Android channels).
- `packages/push` — device registry + senders for actions: Expo Push (`sendPush`, receipts) and direct APNs (HTTP/2, `.p8` ES256) + FCM v1 (`sendToDevices`), HPKE end-to-end envelopes (ported from Brigade's MIT `packages/push`); `pushComponent`. Unit tests use fake APNs/FCM (`test/fakes.ts`); `test/workerd` runs the component in workerd. Brigade's relay and mobile app are AGPL: do not copy code from them.
- `packages/expo-push` — device side of encrypted pushes: `app.plugin.cjs` (Expo config plugin adding the iOS Notification Service Extension, plain CJS, no build), `ios/EmberNotificationService/*.swift` (shipped as is), device key in SecureStore, Android decrypt task, pure-JS HPKE (noble). `test/swift.test.ts` compiles the Swift on macOS (skipped without Xcode).
- `packages/rate-limit`, `packages/workflows` — official components (`defineComponent`, PLAN §12; contracts.md "Componentes").
- `examples/*` — small apps used as documentation and E2E drivers, one workspace each: `chat`, `todo` (offline), `files-auth-jobs`, `email-lite`. Each has `ember/` (functions + schema), a Vite/React client in `web/` (except `email-lite`), and workerd tests; `bun run check` runs them (`ember codegen` first, since `ember/_generated` is not committed). `examples/_testing` is the shared test client.
- `apps/example-expo` — Expo example (own `tsconfig.json`, not in root `tsc -b`; check with `bun run typecheck` there).
- `packages/cli` — `ember` CLI (init/dev/codegen/deploy/env/logs/projects/domains/metrics/dashboard).
- `apps/dashboard` — Ember Dashboard: Worker API + React SPA, bundled and deployed by `ember dashboard deploy` (own `tsconfig.json`, tests with `bun run test` there).
- `docs/spikes/*` — evidence from prototypes. Reuse ideas, do not import from there.

## Conventions
- Bun workspaces; TypeScript strict; tests with Vitest. Runtime tests use `@cloudflare/vitest-plugin` (workerd).
- Package `exports` point to `dist/` (what npm gets) plus a `"@freecorps/ember-source": "./src/*.ts"` condition that tsconfig, Vitest (`vitest.shared.mjs`), Metro and the CLI enable in the repo: tests, typecheck and `ember dev` run from source, no build needed. A new entry point needs both (see `docs/RELEASING.md`). `bun run build` / `bun run verify:pack` before touching packaging.
- `packages/values` and `packages/server` must not import Cloudflare or Node-only APIs (they run in workerd, browsers and RN). Tests may use `node:sqlite` as a stand-in for DO SQLite through the `SqlDriver` interface.
- Mutations are synchronous inside; I/O only in actions (PLAN D6).
- Keep commits small, conventional-commit style. Run `bun run check` before committing.
- The dev laptop is modest: avoid running more than one heavy test suite or build at a time.
