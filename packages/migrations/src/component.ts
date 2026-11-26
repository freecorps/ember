// The migrations component (PLAN §22 L10): data migrations in batches, per shard, on the shard scheduler.
//
//   lib:start (mutation, in the caller's transaction) ─ upsert the migration row (status running), schedule lib:step
//   lib:step  (mutation job) ─ fenced by `run`: call the app's batch function (a handle made by `m.define`) in this
//             transaction (a savepoint per batch) with the persisted cursor, batch after batch while the job's budget
//             lasts (STEP_DOCUMENTS documents, STEP_BATCHES batches) → record cursor + counters → schedule lib:step
//             again, or finish (done → start the next one of a `runSerially` chain).
// The batches of a job and the cursor commit together, so a crash re-runs them (the job is retried) and a thrown
// batch is undone alone: the batches before it in the job commit with the cursor after them (status failed; `start`
// resumes from that batch). A job over the shard's per-transaction limits (TooManyReads / TooManyWrites /
// TooManyDocumentsRead) spends its transaction: the step fails as a whole and the scheduler retries the job. The retry
// sees `attempts > 0` (ctx.scheduler.get) and, instead of running the same work again, lowers it and schedules a fresh
// job: first to one batch per job (`stepBatches`), then halving the batch size, down to 1 document.
// The budget counts documents, not time: the Workers clock does not move during synchronous code, and the shard's
// row limits are what a transaction can run into.

import { componentBuilders, defineComponent, defineSchema, defineTable, EmberError, paginationOptsValidator, unsafeRef, v, type ComponentCtx, type DataModelFromSchema, type PatchValue } from "@freecorps/ember-server";

const status = v.union(v.literal("running"), v.literal("done"), v.literal("failed"), v.literal("canceled"));
const nextItem = v.object({ name: v.string(), fn: v.string() });

const schema = defineSchema({
  tables: {
    migrations: defineTable({
      /** The migration's name: the app function's name (`migrations:addPlan`). */
      name: v.string(),
      /** Handle of the app's batch function (`m.define(...)`, an internalMutation). */
      fn: v.string(),
      status,
      /** Where the next batch starts (null: the beginning of the table). */
      cursor: v.union(v.string(), v.null()),
      /** Documents per batch (null: the definition's own `batchSize`). Halved on TooManyReads/TooManyWrites. */
      batchSize: v.union(v.number(), v.null()),
      /** The batch size the app's function last used (what a halving starts from). */
      lastBatchSize: v.optional(v.number()),
      /** 1 once a job failed as a whole transaction: one batch per job from then on (absent: up to STEP_BATCHES). */
      stepBatches: v.optional(v.number()),
      processed: v.number(),
      changed: v.number(),
      /** Batches that threw (each one stopped the migration). */
      failed: v.number(),
      batches: v.number(),
      lastError: v.optional(v.string()),
      /** Incremented by every (re)start: jobs of an earlier run are no-ops. */
      run: v.number(),
      pendingJob: v.optional(v.string()),
      /** Migrations to start after this one completes (`runSerially`). */
      next: v.array(nextItem),
      startedAt: v.number(),
      updatedAt: v.number(),
      finishedAt: v.optional(v.number()),
    })
      .index("by_name", ["name"])
      // The dashboard's table of one status (`lib:runs`).
      .index("by_status", ["status", "name"]),
  },
});

const { query, mutation, internalMutation, internalQuery } = componentBuilders<typeof schema, undefined>();

type Ctx = ComponentCtx<typeof schema, undefined>["mutation"];
type ReadCtx = ComponentCtx<typeof schema, undefined>["query"];
type Row = DataModelFromSchema<typeof schema>["migrations"]["document"];
/** A patch: `undefined` removes an optional field. */
type Patch = PatchValue<Row>;

/** Code of the error a dry run throws to roll its batch back (`data` is the `DryRunReport`). */
export const DRY_RUN = "MigrationDryRun";
/** Largest batch accepted (half the default write limit of a transaction). */
export const MAX_BATCH_SIZE = 4096;
/**
 * Documents one `lib:step` job looks at, at most, over its batches: another batch runs while the documents so far
 * plus one more batch stay within it (so a batch of more than half of it runs alone). Five default batches of 100:
 * a few thousand rows read and, with every document patched, well under the default 8 192 rows written.
 */
export const STEP_DOCUMENTS = 500;
/** Batches one `lib:step` job runs, at most (small batches: the per-job cost is the row and the job). */
export const STEP_BATCHES = 16;

export type MigrationStatus = {
  name: string;
  status: "running" | "done" | "failed" | "canceled";
  /** Documents looked at so far. */
  processed: number;
  /** Documents the migration changed (patched, replaced, deleted, or written through ctx.db). */
  changed: number;
  /** Batches that threw. */
  failed: number;
  batches: number;
  batchSize: number | null;
  /** Where the next batch starts (a pagination cursor); null at the start. */
  cursor: string | null;
  lastError?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Migrations still queued after this one (`runSerially`). */
  next: string[];
};

/** What one batch of the app's function returns. */
export type BatchResult = { continueCursor: string; isDone: boolean; processed: number; changed: number; batchSize: number };

export type DryRunReport = {
  /** Documents the batch looked at. */
  processed: number;
  /** Documents it would change. */
  changed: number;
  isDone: boolean;
  /** Up to 10 of the changed documents, before and after (`after: null` = deleted). */
  samples: Array<{ _id: string; before: unknown; after: unknown }>;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown) => (e instanceof EmberError ? e.code : undefined);

function byName(ctx: ReadCtx, name: string) {
  return ctx.db.query("migrations").withIndex("by_name", (q) => q.eq("name", name)).unique();
}

function view(r: Row): MigrationStatus {
  const out: MigrationStatus = {
    name: r.name,
    status: r.status,
    processed: r.processed,
    changed: r.changed,
    failed: r.failed,
    batches: r.batches,
    batchSize: r.batchSize,
    cursor: r.cursor,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    next: r.next.map((n) => n.name),
  };
  if (r.lastError !== undefined) out.lastError = r.lastError;
  if (r.finishedAt !== undefined) out.finishedAt = r.finishedAt;
  return out;
}

function checkHandle(what: string, fn: string) {
  if (!fn.startsWith("&")) throw new EmberError("ValidationError", `migrations: ${what} must be a function handle (createFunctionHandle), got ${JSON.stringify(fn)}`);
}

function checkBatchSize(n: number | undefined) {
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE)) throw new EmberError("ValidationError", `migrations: batchSize must be an integer in 1..${MAX_BATCH_SIZE}`);
}

/** One batch of the app's function, in a savepoint of this transaction. */
function batch(ctx: Ctx, fn: string, cursor: string | null, batchSize: number | null, dryRun: boolean): unknown {
  const args: Record<string, unknown> = { cursor };
  if (batchSize !== null) args.batchSize = batchSize;
  if (dryRun) args.dryRun = true;
  return ctx.runMutation(unsafeRef<"mutation">(fn), args);
}

function isBatchResult(x: unknown): x is BatchResult {
  const r = x as BatchResult;
  return !!r && typeof r === "object" && typeof r.continueCursor === "string" && typeof r.isDone === "boolean" && typeof r.processed === "number" && typeof r.changed === "number" && typeof r.batchSize === "number";
}

/** Failed runs of the job running now (0 on its first run, or without a scheduler reader). */
function priorAttempts(ctx: Ctx, job: string | undefined): number {
  if (!job) return 0;
  try {
    return ctx.scheduler.get(job)?.attempts ?? 0;
  } catch {
    return 0;
  }
}

const LIMIT_ERRORS = new Set(["TooManyReads", "TooManyWrites", "TooManyDocumentsRead"]);

/** Batches a job may run with batches of `size` (the cap `stepBatches` and the document budget). */
const batchesFor = (r: Row, size: number) => Math.max(1, Math.min(r.stepBatches ?? STEP_BATCHES, Math.floor(STEP_DOCUMENTS / Math.max(1, size))));

const schedule = (ctx: Ctx, id: Row["_id"], run: number) => ctx.scheduler.runAfter(0, "lib:step", { id, run });

/** Starts (or resumes) a migration; returns its row. Starting a running one changes nothing. */
/** `next` omitted (a resume from the dashboard, a plain `start`): a migration that ran before keeps the chain it had. */
function begin(ctx: Ctx, a: { name: string; fn: string; batchSize?: number; reset?: boolean; next?: Array<{ name: string; fn: string }> }): Row {
  const row = byName(ctx, a.name);
  if (!row) {
    const doc = {
      name: a.name,
      fn: a.fn,
      status: "running" as const,
      cursor: null,
      batchSize: a.batchSize ?? null,
      processed: 0,
      changed: 0,
      failed: 0,
      batches: 0,
      run: 1,
      next: a.next ?? [],
      startedAt: ctx.now,
      updatedAt: ctx.now,
    };
    // Written once, with the job that runs it (no insert and then a patch).
    const id = ctx.db.insert("migrations", (id) => ({ ...doc, pendingJob: schedule(ctx, id, 1) }));
    return ctx.db.get(id)!;
  }
  if (row.status === "running" && !a.reset) {
    if (a.next?.length) ctx.db.patch(row._id, { next: [...row.next, ...a.next], updatedAt: ctx.now });
    return ctx.db.get(row._id)!;
  }
  if (row.status === "done" && !a.reset) {
    // Already done: a no-op, but a chain moves on to its next migration.
    if (a.next?.length) startNext(ctx, a.next);
    return row;
  }
  if (row.pendingJob) ctx.scheduler.cancel(row.pendingJob);
  const run = row.run + 1;
  // Resumed (or started over) without a chain of its own: the successors it was queued with still follow it.
  const patch: Patch = { fn: a.fn, status: "running", run, next: a.next ?? row.next, updatedAt: ctx.now, lastError: undefined, finishedAt: undefined };
  if (a.batchSize !== undefined) patch.batchSize = a.batchSize;
  // A new batch size, or a reset: the per-job budget starts over too.
  if ((a.batchSize !== undefined || a.reset) && row.stepBatches !== undefined) patch.stepBatches = undefined;
  if (a.reset) Object.assign(patch, { cursor: null, processed: 0, changed: 0, failed: 0, batches: 0, startedAt: ctx.now });
  patch.pendingJob = schedule(ctx, row._id, run);
  ctx.db.patch(row._id, patch);
  return ctx.db.get(row._id)!;
}

function startNext(ctx: Ctx, next: Array<{ name: string; fn: string }>) {
  const [head, ...rest] = next;
  if (head) begin(ctx, { name: head.name, fn: head.fn, next: rest });
}

export const functions = {
  lib: {
    /**
     * Starts a migration in this shard (in the caller's transaction), or resumes a failed/canceled one from its
     * cursor. Done: a no-op unless `reset` (back to the start, counters cleared). `dryRun`: runs one batch (from the
     * cursor of an unfinished run, else from the start) in a savepoint that is rolled back, and returns what it would
     * change; nothing is recorded.
     */
    start: mutation({
      args: {
        name: v.string(),
        fn: v.string(),
        batchSize: v.optional(v.number()),
        reset: v.optional(v.boolean()),
        dryRun: v.optional(v.boolean()),
        next: v.optional(v.array(nextItem)),
      },
      handler: (ctx, a): { status: MigrationStatus | null; dryRun?: DryRunReport } => {
        checkHandle("fn", a.fn);
        checkBatchSize(a.batchSize);
        for (const n of a.next ?? []) checkHandle(`next ${n.name}`, n.fn);
        if (a.dryRun) {
          const row = byName(ctx, a.name);
          const cursor = row && row.status !== "done" && !a.reset ? row.cursor : null;
          try {
            batch(ctx, a.fn, cursor, a.batchSize ?? row?.batchSize ?? null, true);
          } catch (e) {
            if (codeOf(e) === DRY_RUN) {
              return { status: row ? view(row) : null, dryRun: (e as EmberError<string>).data as DryRunReport };
            }
            throw e;
          }
          throw new EmberError("ValidationError", `migrations: ${a.name} did not roll its dry run back (is fn a function made by Migrations.define?)`);
        }
        return { status: view(begin(ctx, { name: a.name, fn: a.fn, ...(a.batchSize !== undefined ? { batchSize: a.batchSize } : {}), ...(a.reset ? { reset: true } : {}), ...(a.next !== undefined ? { next: a.next } : {}) })) };
      },
    }),

    /** Status of a migration in this shard (reactive); null if it never ran here. */
    status: query({
      args: { name: v.string() },
      handler: (ctx, { name }): MigrationStatus | null => {
        const r = byName(ctx, name);
        return r ? view(r) : null;
      },
    }),

    /** Every migration recorded in this shard, by name (reactive). */
    list: query({
      args: {},
      handler: (ctx): MigrationStatus[] => ctx.db.query("migrations").withIndex("by_name").collect().map(view),
    }),

    /** Stops a running migration after its current job (the pending batch job is cancelled). False if not running. */
    cancel: mutation({
      args: { name: v.string() },
      returns: v.boolean(),
      handler: (ctx, { name }) => {
        const r = byName(ctx, name);
        if (!r || r.status !== "running") return false;
        if (r.pendingJob) ctx.scheduler.cancel(r.pendingJob);
        ctx.db.patch(r._id, { status: "canceled", pendingJob: undefined, next: [], updatedAt: ctx.now, finishedAt: ctx.now });
        return true;
      },
    }),

    /**
     * The migrations in this shard by name, a page at a time (one status through `by_status`), with their function
     * handle: the dashboard's table (resuming one runs `lib:start` with the row's `name` and raw handle `fn`;
     * `function` is only the name shown).
     */
    runs: internalQuery({
      args: { status: v.optional(status), paginationOpts: paginationOptsValidator },
      handler: (ctx, { status: s, paginationOpts }) => {
        const q = s !== undefined ? ctx.db.query("migrations").withIndex("by_status", (r) => r.eq("status", s)) : ctx.db.query("migrations").withIndex("by_name");
        const page = q.paginate(paginationOpts);
        return { ...page, page: page.page.map((r) => ({ ...view(r), fn: r.fn, function: r.fn.startsWith("&") ? r.fn.slice(1) : r.fn, pendingJob: r.pendingJob ?? null })) };
      },
    }),

    // ---------------------------------------------------------------------------------------- internal loop

    /** Batches while the job's budget lasts: the app's function and the cursor commit together. */
    step: internalMutation({
      args: { id: v.id("migrations"), run: v.number() },
      handler: (ctx, { id, run }) => {
        const r = ctx.db.get(id);
        if (!r || r.status !== "running" || r.run !== run) return; // canceled, restarted, or a duplicate
        const prior = priorAttempts(ctx, r.pendingJob);
        if (prior > 0) {
          // The previous run of this job failed as a whole transaction: over the shard's limits (or a crash). Less
          // work per job: first one batch per job (as many batches would only fail again), then half the batch size.
          const size = r.batchSize ?? r.lastBatchSize ?? DEFAULT_BATCH_SIZE;
          if (r.stepBatches !== 1) {
            ctx.db.patch(id, { stepBatches: 1, updatedAt: ctx.now, lastError: `a job of up to ${batchesFor(r, size)} batch(es) failed as a whole transaction (shard limits?): one batch per job now`, pendingJob: schedule(ctx, id, run) });
            return;
          }
          if (size <= 1) {
            ctx.db.patch(id, { status: "failed", failed: r.failed + 1, lastError: `batch at cursor ${r.cursor ?? "start"} failed ${prior} time(s) as a whole transaction, even with 1 document per batch`, pendingJob: undefined, updatedAt: ctx.now });
            return;
          }
          const half = Math.floor(size / 2);
          ctx.db.patch(id, { batchSize: half, updatedAt: ctx.now, lastError: `batch of ${size} failed as a whole transaction (shard limits?): batch size lowered to ${half}`, pendingJob: schedule(ctx, id, run) });
          return;
        }
        // What the batches so far add up to (written once, with the cursor after the last one that committed).
        const acc = { cursor: r.cursor, processed: 0, changed: 0, batches: 0, lastBatchSize: r.lastBatchSize };
        const progress = (): Patch => {
          const p: Patch = { updatedAt: ctx.now };
          if (acc.batches === 0) return p;
          Object.assign(p, { cursor: acc.cursor, processed: r.processed + acc.processed, changed: r.changed + acc.changed, batches: r.batches + acc.batches });
          if (acc.lastBatchSize !== r.lastBatchSize) p.lastBatchSize = acc.lastBatchSize;
          return p;
        };
        for (;;) {
          let out: unknown;
          try {
            out = batch(ctx, r.fn, acc.cursor, r.batchSize, false);
          } catch (e) {
            const code = codeOf(e);
            // Over the limits: this transaction is spent (every further statement throws). Let the job fail; its
            // retry lowers the work (above).
            if (code && LIMIT_ERRORS.has(code)) throw e;
            ctx.db.patch(id, { ...progress(), status: "failed", failed: r.failed + 1, lastError: code ? `${code}: ${message(e)}` : message(e), pendingJob: undefined });
            console.error(`migrations: ${r.name} failed at cursor ${acc.cursor ?? "start"}: ${message(e)}`);
            return;
          }
          if (!isBatchResult(out)) {
            ctx.db.patch(id, { ...progress(), status: "failed", failed: r.failed + 1, lastError: `InvalidBatch: ${r.name} returned ${JSON.stringify(out)?.slice(0, 200)} (is fn a function made by Migrations.define?)`, pendingJob: undefined });
            return;
          }
          acc.cursor = out.continueCursor;
          acc.processed += out.processed;
          acc.changed += out.changed;
          acc.batches++;
          acc.lastBatchSize = out.batchSize;
          if (out.isDone) {
            ctx.db.patch(id, { ...progress(), status: "done", finishedAt: ctx.now, pendingJob: undefined, next: [], lastError: undefined });
            startNext(ctx, r.next);
            return;
          }
          // Another batch within the job's budget? (A batch that saw nothing without being done: leave it to a new job.)
          if (out.processed === 0 || acc.batches >= batchesFor(r, out.batchSize)) break;
        }
        ctx.db.patch(id, { ...progress(), pendingJob: schedule(ctx, id, run) });
      },
    }),
  },
};

/** Documents per batch when neither the definition nor the run says. */
export const DEFAULT_BATCH_SIZE = 100;

const lib = functions.lib;

export const migrations = defineComponent({
  name: "migrations",
  schema,
  functions,
  // The migrations' screen in the Ember Dashboard (contracts.md "Telas declarativas"): per shard, where each one runs.
  dashboard: {
    label: "Data migrations",
    icon: "database",
    description: "Batched data migrations in this shard: progress, errors; cancel, resume, or start over. Across shards: `ember migrations`.",
    tabs: [
      {
        id: "runs",
        label: "Migrations",
        blocks: [
          {
            kind: "table",
            id: "runs",
            query: lib.runs,
            rowKey: "name",
            columns: [
              { label: "Migration", path: "name", format: "code" },
              { label: "Status", path: "status", format: "badge" },
              { label: "Processed", path: "processed", format: "number" },
              { label: "Changed", path: "changed", format: "number" },
              { label: "Batches", path: "batches", format: "number" },
              { label: "Updated", path: "updatedAt", format: "ago" },
            ],
            detail: {
              query: lib.status,
              fromRow: { name: "name" },
              sections: [
                {
                  kind: "kv",
                  items: [
                    { label: "Status", path: "status", format: "badge" },
                    { label: "Processed", path: "processed", format: "number" },
                    { label: "Changed", path: "changed", format: "number" },
                    { label: "Failed batches", path: "failed", format: "number" },
                    { label: "Batch size", path: "batchSize", format: "number" },
                    { label: "Cursor", path: "cursor", format: "code" },
                    { label: "Started", path: "startedAt", format: "date" },
                    { label: "Finished", path: "finishedAt", format: "date" },
                  ],
                },
                { kind: "stacktrace", label: "Last error", path: "lastError" },
                { kind: "json", label: "Next in the chain", path: "next" },
              ],
            },
            rowActions: [
              { id: "cancel", label: "Cancel", fn: lib.cancel, fromRow: { name: "name" }, description: "Stops after the batch in flight." },
              { id: "resume", label: "Resume", fn: lib.start, fromRow: { name: "name", fn: "fn" }, description: "A failed or canceled migration resumes from its cursor; a running or done one is left as is." },
              { id: "restart", label: "Start over", fn: lib.start, args: { reset: true }, fromRow: { name: "name", fn: "fn" }, destructive: true, description: "Runs it again from the beginning, counters cleared." },
            ],
          },
        ],
      },
    ],
  },
});
