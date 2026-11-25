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
- Each scheduled mutation job runs batches while its budget lasts (500 documents, at most 16 batches: five batches of
  the default 100), each in a savepoint; their writes and the cursor commit together. A batch that throws is rolled
  back alone (the job's earlier batches commit) and the migration becomes `failed`; running it again resumes from
  that batch. A job over the shard's read/write limits is retried with one batch per job, then with half the batch
  size, down to one document. Status and cancel move per job.
- `dryRun`: one batch, rolled back; returns `processed`, `changed`, `isDone` and up to 10 `{ _id, before, after }`
  samples. Nothing is recorded or scheduled.
- Starting a running migration changes nothing; a `done` one is a no-op unless `reset`. `runSerially` starts each
  migration when the previous one is `done`; a failure or cancel stops the chain.
- `MigrationStatus`: `status` (`running`, `done`, `failed`, `canceled`), `processed`, `changed`, `failed`, `batches`,
  `batchSize`, `cursor`, `lastError?`, timestamps, `next`.

## Limits

- State lives in the shard being migrated: every shard migrates on its own; the CLI fans out over the shard catalog.
- A new required field takes two deploys: ship it as `v.optional(...)` with every writer already setting it, and
  start the migration only once no older version still takes writes (with `ember deploy --gradual`, after the rollout
  reaches 100%). A document written without the field after its batch has passed is not migrated, and the status still
  says `done`. Run the migration on every shard until `ember migrations status <name> --all` exits 0, then make the
  field required (without the name, `status` lists only the migrations a shard already has a row for, so one that never
  started there does not show). A shard that still has documents without the field
  refuses the new schema at boot (`MigrationRefused`).
- That flow needs the field to keep its storage when it becomes required. An optional field that also accepts `null`
  (`v.optional(v.union(v.string(), v.null()))`) lives in the JSON column, and the required one gets a column of its
  own: the planner refuses that change on a table with data even when every document has the field.
- Not to be confused with `ember migrate convex`, the codemod.

Contract: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Migrações de dados". Tests with usage: [`packages/migrations/test`](https://github.com/freecorps/ember/tree/main/packages/migrations/test).

License: MIT.
