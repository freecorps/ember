/**
 * `@freecorps/ember-migrations`: data migrations as an Ember component (PLAN §22 L10), in batches per shard.
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(migrations);
 *
 *   // ember/migrations.ts
 *   import { Migrations } from "@freecorps/ember-migrations";
 *   import { components, internalMutation } from "./_generated/server";
 *   import type { DataModel } from "./_generated/server";
 *   export const m = new Migrations<DataModel>(components.migrations);
 *   export const addPlan = m.define({
 *     table: "orgs",
 *     batchSize: 200,
 *     migrateOne: (ctx, doc) => (doc.plan === undefined ? { plan: "free" } : undefined), // a patch, or write via ctx.db
 *   });
 *
 *   // in a mutation: m.run(ctx, internal.migrations.addPlan); m.runSerially(ctx, [internal.migrations.a, ...]);
 *   // m.status(ctx, internal.migrations.addPlan) (reactive); m.cancel(ctx, ...)
 *   // across shards: `ember migrations run migrations:addPlan --all [--dry-run]`, `ember migrations status ... --all`
 *
 * Each batch is its own transaction on the shard (the app's function and the cursor commit together), chained by
 * the shard scheduler. The state lives in the shard being migrated: every shard migrates on its own.
 */
import {
  createFunctionHandle,
  EmberError,
  getFunctionName,
  internalMutationGeneric,
  v,
  type ActionCtx,
  type AnyDataModel,
  type FunctionReference,
  type GenericDataModel,
  type MutationCtx,
  type RegisteredMutation,
} from "@freecorps/ember-server";
import { compareValues } from "@freecorps/ember-values";
import { DEFAULT_BATCH_SIZE, DRY_RUN, MAX_BATCH_SIZE, type BatchResult, type DryRunReport, type MigrationStatus } from "./component.ts";

export { migrations, functions as migrationsFunctions, DRY_RUN, MAX_BATCH_SIZE, DEFAULT_BATCH_SIZE, type MigrationStatus, type DryRunReport, type BatchResult } from "./component.ts";

type Ref<T extends "query" | "mutation", A, R> = FunctionReference<T, "public", A, R>;
type NextItem = { name: string; fn: string };
type StartArgs = { name: string; fn: string; batchSize?: number; reset?: boolean; dryRun?: boolean; next?: NextItem[] };
type StartResult = { status: MigrationStatus | null; dryRun?: DryRunReport };

/** What `components.<name>` of the migrations component looks like (structural: any install name works). */
export interface MigrationsComponentApi {
  lib: {
    start: Ref<"mutation", StartArgs, StartResult>;
    status: Ref<"query", { name: string }, MigrationStatus | null>;
    list: Ref<"query", Record<string, never>, MigrationStatus[]>;
    cancel: Ref<"mutation", { name: string }, boolean>;
  };
}

/** Args of the batch function `define` returns (what the component calls). */
export type BatchArgs = { cursor: string | null; batchSize?: number; dryRun?: boolean };

/** A migration: the internalMutation `define` returns (export it from an ember/ module). */
export type MigrationDefinition = RegisteredMutation<"internal", BatchArgs, BatchResult>;

/** A migration to run: the reference (`internal.migrations.addPlan`) or its name (`"migrations:addPlan"`). */
export type MigrationRef = FunctionReference<"mutation", "internal", BatchArgs, BatchResult> | string;

type Doc<DM extends GenericDataModel, T extends keyof DM> = DM[T]["document"];
/** Fields a `migrateOne` patch may set (system fields stay as they are). */
export type MigrationPatch<D> = { [K in Exclude<keyof D, "_id" | "_creationTime">]?: D[K] };

export interface MigrationDef<DM extends GenericDataModel, T extends keyof DM & string> {
  table: T;
  /** Documents per batch (one transaction each). Default 100; at most 4096. Lowered automatically over the shard's limits. */
  batchSize?: number;
  /**
   * Called for every document, in `_creationTime` order. Return a patch (applied with `ctx.db.patch`), or nothing and
   * write through `ctx.db` (any table). Synchronous, like any mutation. Throwing stops the migration at this batch
   * (status `failed`, nothing of the batch written); `start` again resumes from it.
   */
  migrateOne: (ctx: MutationCtx<DM>, doc: Doc<DM, T>) => MigrationPatch<Doc<DM, T>> | void | undefined | null;
}

/** Mutation/query ctx: `ctx.run*` returns values (same transaction). */
type SyncCtx = { runQuery: MutationCtx["runQuery"]; runMutation?: MutationCtx["runMutation"] };
/** Action ctx: `ctx.run*` returns Promises. */
type AsyncCtx = { runAction: ActionCtx["runAction"]; runQuery: ActionCtx["runQuery"]; runMutation: ActionCtx["runMutation"] };

export interface RunOptions {
  /** Documents per batch for this run (overrides the definition's `batchSize`). */
  batchSize?: number;
  /** Start over from the beginning, also when already done (counters cleared). */
  reset?: boolean;
  /** One batch, rolled back: returns what it would change; nothing is recorded. */
  dryRun?: boolean;
}

const SAMPLES = 10;

/** Equal as Ember values (index order: no serialization, key order and absent fields ignored). */
const sameValue = (a: unknown, b: unknown) => {
  if (a === b) return true;
  try {
    return compareValues(a, b) === 0;
  } catch {
    return false;
  }
};

function differs(before: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).some(([k, x]) => !sameValue(before[k], x));
}

const WRITES = ["insert", "patch", "replace", "delete", "increment"] as const;

/**
 * The ctx `migrateOne` sees: the same ctx, with `db` writes and `runMutation` counted in `writes`. Reads, `ctx.sql`
 * (the app's private tables, never documents) and the rest go straight through.
 */
function trackWrites(ctx: MutationCtx<AnyDataModel>): { ctx: MutationCtx<AnyDataModel>; writes: number } {
  const t = { ctx, writes: 0 };
  // `Object.create`: the engine's `db` keeps its own properties (getters included); only the writes are wrapped.
  const db = Object.create(ctx.db) as Record<string, unknown>;
  const real = ctx.db as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const k of WRITES) {
    if (typeof real[k] !== "function") continue;
    db[k] = (...args: unknown[]) => {
      t.writes++;
      return real[k]!(...args);
    };
  }
  t.ctx = {
    ...ctx,
    db: db as unknown as MutationCtx<AnyDataModel>["db"],
    runMutation: ((...args: Parameters<MutationCtx["runMutation"]>) => {
      t.writes++;
      return ctx.runMutation(...args);
    }) as MutationCtx<AnyDataModel>["runMutation"],
  };
  return t;
}

/** The name a migration is recorded under: its function's name. */
export function migrationName(ref: MigrationRef): string {
  const name = typeof ref === "string" ? ref : getFunctionName(ref as FunctionReference<"mutation">);
  return name.startsWith("&") ? name.slice(1) : name;
}

export class Migrations<DM extends GenericDataModel = AnyDataModel> {
  constructor(readonly component: MigrationsComponentApi) {}

  /**
   * Defines a migration over `table`: returns its batch function, an internalMutation to export from an ember/
   * module. The migration is recorded under that function's name (`"migrations:addPlan"`).
   */
  define<T extends keyof DM & string>(def: MigrationDef<DM, T>): MigrationDefinition {
    if (def.batchSize !== undefined && (!Number.isInteger(def.batchSize) || def.batchSize < 1 || def.batchSize > MAX_BATCH_SIZE)) {
      throw new Error(`Migrations.define(${def.table}): batchSize must be an integer in 1..${MAX_BATCH_SIZE}`);
    }
    return internalMutationGeneric({
      args: { cursor: v.union(v.string(), v.null()), batchSize: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
      handler: (ctx: MutationCtx<AnyDataModel>, a: BatchArgs): BatchResult => {
        const batchSize = a.batchSize ?? def.batchSize ?? DEFAULT_BATCH_SIZE;
        const page = ctx.db.query(def.table).paginate({ cursor: a.cursor, numItems: batchSize });
        let changed = 0;
        const samples: DryRunReport["samples"] = [];
        // Writes made in this batch so far (through `ctx.db`, `ctx.runMutation` or the patches applied here). While
        // there are none, a document whose `migrateOne` returned nothing is still the one the page read: no `db.get`
        // and no deep compare. After the first write any document may have changed (a trigger, a nested mutation or
        // an earlier `migrateOne` can write other documents), so it is re-read and compared as before.
        const tracked = trackWrites(ctx);
        for (const doc of page.page as Array<Record<string, unknown> & { _id: string }>) {
          const patch = def.migrateOne(tracked.ctx as unknown as MutationCtx<DM>, doc as Doc<DM, T>);
          let after: unknown;
          let didChange: boolean;
          if (patch && typeof patch === "object" && Object.keys(patch).length) {
            didChange = differs(doc, patch as Record<string, unknown>);
            if (didChange) {
              tracked.writes++;
              ctx.db.patch(doc._id as never, patch as never);
            }
            after = a.dryRun && didChange ? ctx.db.get(doc._id as never) : doc;
          } else if (tracked.writes === 0) {
            after = doc;
            didChange = false;
          } else {
            // Nothing returned: it may have written through ctx.db (an unwritten document is read from the cache).
            after = ctx.db.get(doc._id as never);
            didChange = !sameValue(doc, after);
          }
          if (didChange) {
            changed++;
            if (a.dryRun && samples.length < SAMPLES) samples.push({ _id: doc._id, before: doc, after: after ?? null });
          }
        }
        if (a.dryRun) {
          const report: DryRunReport = { processed: page.page.length, changed, isDone: page.isDone, samples };
          // Thrown so the component's savepoint rolls the batch back; it returns `report` to the caller.
          throw new EmberError<typeof DRY_RUN>(DRY_RUN, `dry run of ${def.table}: ${changed} of ${page.page.length} document(s) would change`, report);
        }
        return { continueCursor: page.continueCursor, isDone: page.isDone, processed: page.page.length, changed, batchSize };
      },
    }) as unknown as MigrationDefinition;
  }

  private startArgs(ref: MigrationRef, o: RunOptions, next: MigrationRef[] = []): StartArgs {
    const a: StartArgs = { name: migrationName(ref), fn: createFunctionHandle(ref as never) as string };
    if (o.batchSize !== undefined) a.batchSize = o.batchSize;
    if (o.reset) a.reset = true;
    if (o.dryRun) a.dryRun = true;
    if (next.length) a.next = next.map((r) => ({ name: migrationName(r), fn: createFunctionHandle(r as never) as string }));
    return a;
  }

  /**
   * Starts (or resumes) a migration in the caller's shard. Running: nothing changes. Done: a no-op unless `reset`.
   * Failed or canceled: continues from where it stopped. In a mutation: atomic with it (synchronous).
   */
  run(ctx: SyncCtx, ref: MigrationRef, opts?: RunOptions): StartResult;
  run(ctx: AsyncCtx, ref: MigrationRef, opts?: RunOptions): Promise<StartResult>;
  run(ctx: SyncCtx | AsyncCtx, ref: MigrationRef, opts: RunOptions = {}): StartResult | Promise<StartResult> {
    if (!ctx.runMutation) throw new Error("migrations.run needs a mutation or action ctx");
    return ctx.runMutation(this.component.lib.start, this.startArgs(ref, opts));
  }

  /**
   * Runs migrations one after the other in this shard: each starts when the previous one is done (already done ones
   * are skipped). A failure or a cancel stops the chain there; running it again resumes it.
   */
  runSerially(ctx: SyncCtx, refs: MigrationRef[]): StartResult | null;
  runSerially(ctx: AsyncCtx, refs: MigrationRef[]): Promise<StartResult | null>;
  runSerially(ctx: SyncCtx | AsyncCtx, refs: MigrationRef[]): StartResult | null | Promise<StartResult | null> {
    if (!ctx.runMutation) throw new Error("migrations.runSerially needs a mutation or action ctx");
    const [head, ...rest] = refs;
    if (!head) return null;
    return ctx.runMutation(this.component.lib.start, this.startArgs(head, {}, rest));
  }

  /** Status of a migration in this shard (reactive in a query); null if it never ran here. */
  status(ctx: SyncCtx, ref: MigrationRef): MigrationStatus | null;
  status(ctx: AsyncCtx, ref: MigrationRef): Promise<MigrationStatus | null>;
  status(ctx: SyncCtx | AsyncCtx, ref: MigrationRef) {
    return ctx.runQuery(this.component.lib.status, { name: migrationName(ref) });
  }

  /** Every migration recorded in this shard. */
  list(ctx: SyncCtx): MigrationStatus[];
  list(ctx: AsyncCtx): Promise<MigrationStatus[]>;
  list(ctx: SyncCtx | AsyncCtx) {
    return ctx.runQuery(this.component.lib.list, {});
  }

  /** Stops a running migration (after its current batch). False if it was not running. */
  cancel(ctx: SyncCtx, ref: MigrationRef): boolean;
  cancel(ctx: AsyncCtx, ref: MigrationRef): Promise<boolean>;
  cancel(ctx: SyncCtx | AsyncCtx, ref: MigrationRef) {
    if (!ctx.runMutation) throw new Error("migrations.cancel needs a mutation or action ctx");
    return ctx.runMutation(this.component.lib.cancel, { name: migrationName(ref) });
  }
}
