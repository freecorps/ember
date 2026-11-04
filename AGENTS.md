# Ember — agent instructions

Read `docs/PLAN.md` first. It is the source of truth for design decisions (D1–D12, sections 1–21).

## Layout
- `packages/values` — `v.*` validators, Shape, JSON Schema, order-preserving index key encoding.
- `packages/server` — `defineSchema`/`defineTable`/`defineShard`, index-kind plugin API, function builders, query builder → SQL compiler, read-set recording, schema→DDL and migration planner. Pure TS, no Cloudflare APIs.
- `packages/runtime` — Worker + Durable Objects (`Shard`, `Auth`, `System`): transactions, group commit, subscriptions, protocol, scheduler, files.
- `packages/client`, `packages/react`, `packages/react-query` — client SDKs.
- `packages/react-native` — Expo/RN: AppState+NetInfo connectivity, AsyncStorage pending storage, SecureStore bearer auth, `registerForPush`.
- `packages/push` — device table helpers + Expo Push sender (`sendPush`, receipts) for actions; `PushProvider` for APNs/FCM later.
- `apps/example-expo` — Expo example (own `tsconfig.json`, not in root `tsc -b`; check with `bun run typecheck` there).
- `packages/cli` — `ember` CLI (init/dev/codegen/deploy/...).
- `docs/spikes/*` — evidence from prototypes. Reuse ideas, do not import from there.

## Conventions
- Bun workspaces; TypeScript strict; tests with Vitest. Runtime tests use `@cloudflare/vitest-plugin` (workerd).
- Packages export TS source (`"exports": "./src/index.ts"`) until we add a build step.
- `packages/values` and `packages/server` must not import Cloudflare or Node-only APIs (they run in workerd, browsers and RN). Tests may use `node:sqlite` as a stand-in for DO SQLite through the `SqlDriver` interface.
- Mutations are synchronous inside; I/O only in actions (PLAN D6).
- Keep commits small, conventional-commit style. Run `bun run check` before committing.
- The dev laptop is modest: avoid running more than one heavy test suite or build at a time.
