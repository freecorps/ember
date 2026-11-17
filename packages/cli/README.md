# @freecorps/ember-cli

The `ember` command for [Ember](https://github.com/freecorps/ember), a Convex-style backend on Cloudflare: scaffold
an app, run it locally in workerd, generate its types, deploy it to your Cloudflare account and operate it (secrets,
logs, metrics, domains, restores, imports, data migrations, the dashboard).

```sh
npx @freecorps/ember-cli init          # ember.json + a sample app in ember/ (--auth adds Better Auth)
npm install @freecorps/ember-server @freecorps/ember-runtime @freecorps/ember-client
npm install -D @freecorps/ember-cli    # then `npx ember ...`
npx ember dev                          # local Worker (Miniflare/workerd), codegen on change
npx ember deploy                       # to your Cloudflare account (wrangler login or CLOUDFLARE_API_TOKEN)
```

Node >= 22. `wrangler` (>= 4.40) is an optional peer: `ember dev --remote` needs it, and without
`CLOUDFLARE_API_TOKEN` the CLI asks `npx wrangler auth token` for credentials.

## Commands

| Command | What it does |
|---|---|
| `init [dir] [--auth]` | `ember.json` and a sample app in `ember/` |
| `dev [--port 8787] [--no-persist] [--remote]` | runs locally in Miniflare/workerd and rebuilds on change; `--remote` binds the env's real Workers AI, Vectorize, Browser Rendering and Images |
| `codegen [--check] [--strict]` | writes `ember/_generated` (types + manifest); `--check` fails in CI when it is out of date |
| `types <module:fn>`, `openapi [--out file]` | a function's contract; OpenAPI 3.1 of the public functions and typed HTTP routes |
| `deploy [--env prod] [--wait] [--gradual N] [--dry-run]` | deploys `ember-<project>-<env>` through the Cloudflare API; `--wait` polls until shards have migrated |
| `destroy [--env name] --yes` | deletes the Worker, its Durable Object data and the env's resources |
| `run <fn> ['<json args>']` | calls a query, mutation or action over HTTP |
| `env list\|set\|get\|rm` | secrets (Worker secrets) and vars (`ember.json`) of an environment |
| `logs`, `metrics` | tail the Worker's logs (filter by function or shard); p50/p95, errors and rows per function |
| `projects ls`, `domains add\|ls` | the account registry; custom domains with conflict checks |
| `restore --shard kind:key --list\|--mark\|--to …`, `restore --all --to …` | point-in-time restore of shards (30-day window); `--discard-newer` also restores shards a newer runtime upgraded (after rolling the Worker back), discarding what was written since the bookmark |
| `keys rotate [--jwt] [--files] [--auth-secret]` | rotate signing keys |
| `import convex <snapshot.zip>`, `import convex --from-deployment …`, `import verify convex`, `export`, `import ember` | move data in from Convex (keeping ids) or between Ember environments |
| `migrations run\|status\|cancel <name> [--all]` | drive `@freecorps/ember-migrations` data migrations across shards |
| `migrate convex [--src convex] [--out ember]` | codemod: port a Convex functions folder (queries and mutations become synchronous) |
| `dashboard deploy\|token\|destroy` | the Ember Dashboard in your account |

`ember --help` lists every option. Environment: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `EMBER_ADMIN_TOKEN`
(admin endpoints, `--wait`, imports, migrations).

## Secrets

```sh
ember env set STRIPE_KEY --env prod                 # value from a hidden prompt or stdin, never argv
ember env set STRIPE_KEY --from-env STRIPE_KEY      # CI
ember env list --env prod                           # names only
ember env set PUBLIC_URL https://app.example --var --env prod   # plain var in ember.json, sent by the next deploy
```

In `ember dev` the same names come from `.dev.vars` next to `ember.json`. Names starting with `EMBER_` belong to Ember.

## Programmatic API

The package's main entry exports `main` (the CLI itself), `codegen`, `buildManifest`, `buildWorker` and the
`ember.json` config helpers, for tooling that embeds the build.

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese): "Secrets e vars", "PITR / `ember restore`", "Importar do Convex", "Migrações de dados", "Bundle do
Worker", "Dashboard". Release and packaging: [`docs/RELEASING.md`](https://github.com/freecorps/ember/blob/main/docs/RELEASING.md).

License: MIT.
