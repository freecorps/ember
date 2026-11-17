# @freecorps/ember-migrations

Data migrations for [Ember](https://github.com/freecorps/ember) apps, as a component: walk a table in batches, one
transaction per batch on the shard being migrated, with a persisted cursor, dry runs that are rolled back, reactive
status and serial chains. `ember migrations run|status|cancel` (in `@freecorps/ember-cli`) drives a migration across
every shard.

```sh
npm install @freecorps/ember-migrations
```

## Example

```ts
// ember/ember.config.ts
import { defineApp } from "@freecorps/ember-server";
import { migrations } from "@freecorps/ember-migrations";
export default defineApp().use(migrations);

// ember/migrations.ts
import { Migrations } from "@freecorps/ember-migrations";
import { components, type DataModel } from "./_generated/server";

export const m = new Migrations<DataModel>(components.migrations);
export const addPlan = m.define({
  table: "orgs",
  batchSize: 200,                                                                  // default 100, at most 4096
  migrateOne: (ctx, doc) => (doc.plan === undefined ? { plan: "free" } : undefined), // a patch, or write via ctx.db
});

// in a mutation or action: m.run(ctx, internal.migrations.addPlan, { dryRun?, reset?, batchSize? })
//                           m.runSerially(ctx, [internal.migrations.a, internal.migrations.b])
//                           m.cancel(ctx, internal.migrations.addPlan)
// in a query (reactive):    m.status(ctx, internal.migrations.addPlan), m.list(ctx)
```

Across shards, from the CLI (through the admin function runner, `EMBER_ADMIN_TOKEN`):

```sh
ember migrations run migrations:addPlan --all --wait        # or --shard org:acme; --kind org; --dry-run; --reset
ember migrations status migrations:addPlan --all            # exits 1 unless done on every shard
ember migrations cancel migrations:addPlan --all
```

## How it runs

- `define` returns an internal mutation of your app. It pages the table by `_creationTime` and applies the patch
  `migrateOne` returns (typed against the table, without `_id` / `_creationTime`); `migrateOne` may also write through
  `ctx.db`. The migration's name is the function's name (`migrations:addPlan`).
- Each batch is one scheduled mutation job: the app's function and the cursor commit together. A batch that throws is
  rolled back and the migration becomes `failed`; running it again resumes from that batch. A batch over the shard's
  read/write limits is retried with half the batch size, down to one document.
- `dryRun`: one batch, rolled back; returns `processed`, `changed`, `isDone` and up to 10 `{ _id, before, after }`
  samples. Nothing is recorded or scheduled.
- Starting a running migration changes nothing; a `done` one is a no-op unless `reset`. `runSerially` starts each
  migration when the previous one is `done`; a failure or cancel stops the chain.
- `MigrationStatus`: `status` (`running`, `done`, `failed`, `canceled`), `processed`, `changed`, `failed`, `batches`,
  `batchSize`, `cursor`, `lastError?`, timestamps, `next`.

## Limits

- State lives in the shard being migrated: every shard migrates on its own; the CLI fans out over the shard catalog.
- A new required field takes two deploys: ship it as `v.optional(...)` with every writer already setting it (a
  document written without the field after its batch has passed is not migrated, and the status still says `done`),
  run the migration on every shard until
  `ember migrations status <name> --all` exits 0, then make it required (without the name, `status` lists only the
  migrations a shard already has a row for, so one that never started there does not show). A shard that still has documents without the field
  refuses the new schema at boot (`MigrationRefused`).
- Not to be confused with `ember migrate convex`, the codemod.

Contract: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Migrações de dados". Tests with usage: [`packages/migrations/test`](https://github.com/freecorps/ember/tree/main/packages/migrations/test).

License: MIT.
