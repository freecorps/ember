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
| `init [dir] [--auth]` | `ember.json` and a sample app in `ember/` that passes `tsc` as generated: `defineErrors`, a per-channel `.aggregate()` count, a cron on `internal.messages.trim`; `--auth` adds Better Auth, typed profile sync and `ctx.auth.require()` |
| `dev [--port 8787] [--no-persist] [--remote]` | runs locally in Miniflare/workerd and rebuilds on change (incremental bundle; an `ember.json` edit reloads the config and rebuilds, a `.dev.vars` edit reloads the values without a rebuild); `--remote` binds the env's real Workers AI, Vectorize, Browser Rendering and Images |
| `codegen [--check] [--strict]` | writes `ember/_generated` (types + manifest; `claims.d.ts`: the identity's claims from `ember/auth.config.ts`); `--check` fails in CI when it is out of date. In `ember dev` it is incremental: a save re-infers the edited modules and the ones importing them |
| `types <module:fn>`, `openapi [--out file]` | a function's contract; OpenAPI 3.1 of the public functions and typed HTTP routes (both read `ember/_generated/manifest.json` and `api.d.ts` when they are current, else run codegen in memory) |
| `deploy [--env prod] [--wait] [--gradual N] [--dry-run] [--preflight] [--allow-schema-rollback] [--allow-missing-env]` | deploys `ember-<project>-<env>` through the Cloudflare API; `--wait` polls until shards have migrated; `--preflight` asks the live shards what the migration would do, uploading nothing. Stops before uploading when the app schema is one this environment already left for a newer one (registry deploy history), says what that rollback costs, and needs `--allow-schema-rollback` to go ahead. When the history cannot be read, the deploy warns and goes ahead unchecked. Also stops when a required var of `defineApp({ env })` is neither a secret on the Worker nor a var in `ember.json`, naming them (`--allow-missing-env` deploys anyway; a first deploy only warns, since secrets need the Worker). A redeploy reads the Worker's state in parallel and skips the workers.dev, R2 CORS and lifecycle writes that would change nothing, and the `limits`/`placement` write when the Worker already has them |
| `deploy --preview <branch> [--destroy]` | an ephemeral `preview-<slug>` environment (Worker `ember-<project>-preview-<slug>`) derived from `environments.preview`: same vars and settings, its own Durable Objects, bucket and queues; the same branch always maps to the same environment. `--destroy` deletes it (also `ember destroy --preview <branch>`) |
| `destroy [--env name] --yes` | deletes the Worker, its Durable Object data and the env's resources |
| `run <fn> ['<json args>']` | calls a query, mutation or action over HTTP |
| `env list\|set\|get\|rm` | secrets (Worker secrets) and vars (`ember.json`) of an environment |
| `logs`, `metrics` | tail the Worker's logs (filter by function or shard); p50/p95, errors and rows per function |
| `shards ls [--kind k]`, `shards inspect <kind:key>` | the environment's shards from the registry catalog (size, schema version, last write); one shard live: size, versions, tables with row counts, open jobs, subscriptions (`--json` for both) |
| `mcp [--allow-env name] [--allow-run name]` | an MCP server on stdio for coding agents (see below) |
| `projects ls`, `domains add\|ls` | the account registry; custom domains with conflict checks |
| `restore --shard kind:key --list\|--mark\|--to …`, `restore --all --to …` | point-in-time restore of shards (30-day window); `--discard-newer` also restores shards a newer runtime upgraded (after rolling the Worker back), discarding what was written since the bookmark |
| `keys rotate [--jwt] [--files] [--auth-secret]` | rotate signing keys |
| `files orphans [--grace 24h] [--delete [--yes]] [--json]` | objects of the files bucket no file row references: lists them (dry run) or deletes them, page by page |
| `import convex <snapshot.zip>`, `import convex --from-deployment …`, `import verify convex`, `export`, `import ember` | move data in from Convex (keeping ids) or between Ember environments |
| `migrations run\|status\|cancel <name> [--all]` | drive `@freecorps/ember-migrations` data migrations across shards |
| `migrate convex [--src convex] [--out ember] [--strict]` | codemod: port a Convex functions folder (queries and mutations become synchronous). First checks the libraries the functions import (and the `package.json` next to them) against what runs in an Ember action (workerd + `nodejs_compat`), warning about the ones that do not; `--strict` stops there |
| `dashboard deploy\|token\|destroy` | the Ember Dashboard in your account |

`ember --help` lists every option. Environment: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `EMBER_ADMIN_TOKEN`
(admin endpoints, `--wait`, imports, migrations).

## `ember.json`: Worker limits and placement

```jsonc
{
  "limits": { "cpuMs": 60000 },   // CPU per Worker invocation, 10–300000 ms (paid plan; default 30000)
  "placement": "smart",           // Smart Placement
  "environments": { "prod": {}, "dev": { "limits": { "cpuMs": 30000 } }, "preview": { "vars": { "STAGE": "preview" } } }
}
```

Both are script-level settings: they go up with a Script PUT, so a redeploy that would change them deploys at 100% in one
request, and one whose Worker already has them is a plain code upload. Absent, Ember leaves whatever the Worker has.

## MCP server

`ember mcp` serves the project to coding agents (Claude Code, Cursor, any MCP client) over stdio:

```sh
claude mcp add ember -- npx ember mcp                    # the running `ember dev` only
claude mcp add ember -e EMBER_ADMIN_TOKEN=... -- npx ember mcp --allow-env prod
```

| Tool | |
|---|---|
| `schema`, `functions`, `types`, `codegen` | tables and indexes, functions, one function's `api.d.ts` contract, `ember codegen`: from the code on disk |
| `run` | runs a query, mutation or action (optionally as a user) through the admin function runner |
| `data`, `shards` | a shard's tables and documents, read-only and paged; the shard catalog or one shard live |
| `logs`, `metrics` | a few seconds of a deployed Worker's tail; p50/p95, errors and rows per function |

Live tools act on the running `ember dev` unless the call names a deployed environment, which the server must be
started with: `--allow-env <env>` for reading, `--allow-run <env>` for running functions there, and every mutation or
action on it also needs `confirm: "<env>"` in the call. Admin calls use `EMBER_ADMIN_TOKEN` (start `ember dev` with the
same value).

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
