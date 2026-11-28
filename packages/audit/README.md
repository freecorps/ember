# @freecorps/ember-audit

A transactional audit log for [Ember](https://github.com/freecorps/ember) apps: who changed what, written by triggers
**in the same transaction as the change** (a mutation that fails leaves no audit row), with only the changed fields,
redaction and a size cap. Old rows move to R2 as gzip NDJSON on a daily cron.

```ts
// ember/ember.config.ts
import { defineApp } from "@freecorps/ember-server";
import { audit } from "@freecorps/ember-audit";
export default defineApp().use(audit, { config: { retainDays: 90 } });

// ember/triggers.ts
import { auditTriggers } from "@freecorps/ember-audit";
import { components, defineTriggers } from "./_generated/server";
export default defineTriggers({
  ...auditTriggers(components.audit, {
    tables: {
      users: { redact: ["passwordHash"], ignore: ["lastSeenAt"] },
      invoices: { fields: ["status", "amount"], ops: ["update", "delete"] },
      projects: true,
    },
  }),
});

// ember/invoices.ts: app-level events, in the mutation's transaction
import { Audit } from "@freecorps/ember-audit";
const auditLog = new Audit(components.audit);
export const send = mutation({
  args: { id: v.id("invoices") },
  handler: (ctx, a) => {
    ctx.db.patch(a.id, { status: "sent" });
    auditLog.log(ctx, { action: "invoice.sent", target: a.id, data: { channel: "email" } });
  },
});
```

## Rows

`{ table, docId, op: "insert" | "update" | "delete" | "log", actor, at, diff?, action?, data?, truncated?, omitted? }`

- `actor`: the identity subject of the mutation, or `"system"` (jobs, crons, the dashboard). `at`: the mutation's
  `ctx.now`.
- `diff`: `{ <field>: { from?, to? } }` with only the audited fields that changed (an insert has every field as `to`,
  a delete as `from`). An update that changes no audited field writes no row. `fields` limits what is audited,
  `ignore` leaves fields out, `redact` keeps the change but stores `"[redacted]"` instead of the values.
- Size cap: 4 KiB per diff by default (`maxDiffBytes`, up to 64 KiB). Past it, whole changes are kept while they fit,
  the rest show `"[truncated]"` (`truncated: true`), and fields that do not fit even so are counted in `omitted`.
- Cost: **one audit row per audited write** (plus its index entries: `by_at`, `by_table_doc`, `by_actor`), in the
  shard of the mutation. To keep other triggers on an audited table: `users: [auditTriggers(...).users, mine]`.

## Reading

- `auditLog.list(ctx, { table?, docId?, actor?, op?, from?, to?, paginationOpts })`: newest first, through one index
  range (table + document, actor, table alone, or time), reactive in queries.
- `auditLog.archives(ctx)` (an action): the archive objects in R2. `readArchive(bucket, key)`: one archive's rows,
  for an app action that checks who may read it; `lib.readArchive` (internal) serves the dashboard.

## Retention and archive

A daily component cron (03:00 UTC, `hour`) on `global:main` (`shard`) archives the rows older than `retainDays`
(default 30) in batches of `batchSize` (default 1000, at most 1500):

1. a mutation claims the batch (the oldest rows past the cutoff, their ids, and the R2 key, all in a `pending` row);
2. an action writes them to R2 as `audit/<install>/YYYY/MM/DD/<batch>.ndjson.gz` (gzip NDJSON in Ember's tagged JSON),
   unless that object is already there;
3. a mutation deletes exactly those rows, marks the batch `archived` and, if old rows remain, schedules the next job.

A crash between 2 and 3 re-runs the same batch: the object is found and only the delete is done. Rows are deleted only
after their object exists, and each row goes to one object (two runs at once share the batch and its key): nothing is
lost or duplicated. Rows live in
the shard of each mutation: list the other shard kinds in `shardKinds` and the cron starts the archive on each of
their shards too. `archive: false` deletes old rows without writing them. The bucket is the files bucket
(`EMBER_FILES`) unless `bucket` names another binding; the orphan sweep of files never touches these keys.

## Dashboard

An "Audit log" screen per shard: the rows with filters (table, actor, op, document) and the diff in the detail, the
archive batches, and "Archive one batch now".
