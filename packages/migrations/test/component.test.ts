// The migrations component end to end on the real engine (node:sqlite), with a small job runner standing in for the
// shard's scheduler: mutation jobs run in the engine, a job that throws is retried (attempts counted, read back by
// `ctx.scheduler.get` like the runtime's `_jobs`), up to 5 attempts.
import {
  anyComponents,
  composeApp,
  createEngine,
  defineApp,
  defineSchema,
  defineTable,
  mutationGeneric,
  queryGeneric,
  v,
  type DataModelFromSchema,
  type Job,
  type Limits,
  type ScheduledFunction,
  type QueryCtx,
  type MutationCtx,
  type ActionCtx,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { describe, expect, test } from "vitest";
import { Migrations, migrations, type MigrationStatus } from "../src/index.ts";
import { STEP_BATCHES, STEP_DOCUMENTS } from "../src/component.ts";

const T0 = 1_700_000_000_000;
const app = defineApp().use(migrations);

const schema = defineSchema({
  tables: {
    orgs: defineTable({ name: v.string(), plan: v.optional(v.string()), seats: v.optional(v.number()) }),
    audit: defineTable({ org: v.string() }),
  },
});
type DM = DataModelFromSchema<typeof schema>;
const m = new Migrations<DM>(anyComponents.migrations);

const probe = { failOn: "" as string, calls: 0 };

const defs = {
  addPlan: m.define({
    table: "orgs",
    batchSize: 3,
    migrateOne: (_ctx, doc) => {
      probe.calls++;
      if (doc.name === probe.failOn) throw new Error(`cannot migrate ${doc.name}`);
      return doc.plan === undefined ? { plan: "free" } : undefined;
    },
  }),
  // Writes through ctx.db instead of returning a patch.
  audit: m.define({
    table: "orgs",
    batchSize: 2,
    migrateOne: (ctx, doc) => {
      ctx.db.insert("audit", { org: doc._id });
    },
  }),
  // Returns nothing for every document and writes nothing (a re-run of an already applied migration).
  noop: m.define({ table: "orgs", batchSize: 4, migrateOne: () => undefined }),
  // A best-effort side effect per document: a nested mutation whose failure is caught (nothing written then).
  bestEffort: m.define({
    table: "orgs",
    batchSize: 4,
    migrateOne: (ctx) => {
      try {
        (ctx as unknown as { runMutation: (ref: string, a: unknown) => unknown }).runMutation("api:sideEffect", {});
      } catch {
        // ignored: the nested mutation's savepoint undid whatever it wrote
      }
    },
  }),
  // org0's migrateOne writes org1 (directly, or through a trigger on `audit`); org1's returns nothing.
  touchLater: m.define({
    table: "orgs",
    batchSize: 4,
    migrateOne: (ctx, doc) => {
      if (doc.name !== "org0") return;
      if (probe.failOn === "trigger") ctx.db.insert("audit", { org: doc._id });
      else {
        const org1 = ctx.db.query("orgs").collect().find((o) => o.name === "org1")!;
        ctx.db.patch(org1._id, { seats: 7 });
      }
    },
  }),
  seats: m.define({ table: "orgs", migrateOne: (_ctx, doc) => (doc.seats === undefined ? { seats: doc.plan === "free" ? 1 : 10 } : undefined) }),
  // Reads every org for each document: over a small read limit with big batches.
  heavy: m.define({
    table: "orgs",
    batchSize: 8,
    migrateOne: (ctx, doc) => {
      ctx.db.query("orgs").take(4);
      return { seats: (doc.seats ?? 0) + 100 };
    },
  }),
};

const api = {
  seed: mutationGeneric({ args: { n: v.number() }, handler: (ctx: any, { n }: { n: number }) => { for (let i = 0; i < n; i++) ctx.db.insert("orgs", { name: `org${i}`, ...(i % 4 === 0 ? { plan: "pro" } : {}) }); } }),
  run: mutationGeneric({
    args: { name: v.string(), dryRun: v.optional(v.boolean()), reset: v.optional(v.boolean()), batchSize: v.optional(v.number()) },
    handler: (ctx: any, a: any) => m.run(ctx, `defs:${a.name}`, { ...(a.dryRun ? { dryRun: true } : {}), ...(a.reset ? { reset: true } : {}), ...(a.batchSize ? { batchSize: a.batchSize } : {}) }),
  }),
  serial: mutationGeneric({ args: { names: v.array(v.string()) }, handler: (ctx: any, a: { names: string[] }) => m.runSerially(ctx, a.names.map((n) => `defs:${n}`)) }),
  cancel: mutationGeneric({ args: { name: v.string() }, handler: (ctx: any, a: { name: string }) => m.cancel(ctx, `defs:${a.name}`) }),
  status: queryGeneric({ args: { name: v.string() }, handler: (ctx: any, a: { name: string }) => m.status(ctx, `defs:${a.name}`) }),
  list: queryGeneric({ args: {}, handler: (ctx: any) => m.list(ctx) }),
};

function harness(limits?: Partial<Limits>, triggers?: Record<string, unknown>) {
  let now = T0;
  const composed = composeApp({ schema, functions: { defs, api }, app });
  const driver = createNodeSqliteDriver();
  let jobs: Job[] = [];
  const history = new Map<string, ScheduledFunction>();
  const errors: string[] = [];
  const engine = createEngine({
    schema: composed.schema,
    functions: composed.functions,
    driver,
    now: () => now,
    ...(limits ? { limits } : {}),
    ...(triggers ? { triggers } : {}),
    scheduledFunctions: { get: (id) => history.get(id) ?? null, list: () => [...history.values()] },
  });
  engine.migrate();
  const commit = (r: { scheduled: Job[]; cancelled: string[] }) => {
    for (const j of r.scheduled) history.set(j.id, { id: j.id, _creationTime: now, name: j.fn, args: j.args, scheduledTime: j.runAt, state: { kind: "pending" }, attempts: 0 });
    jobs.push(...r.scheduled);
    for (const id of r.cancelled) {
      const h = history.get(id);
      if (h) history.set(id, { ...h, state: { kind: "canceled" } });
    }
    jobs = jobs.filter((j) => !r.cancelled.includes(j.id));
  };
  const mutateFull = (name: string, args: unknown = {}) => {
    const r = engine.runMutation(name, args);
    commit(r);
    return r;
  };
  const mutate = (name: string, args: unknown = {}) => mutateFull(name, args).value as any;
  /** Runs due jobs until none is left; a throwing job is retried (5 attempts), like the shard's `_jobs`. */
  const tick = (limit?: number) => {
    for (let i = 0; i < (limit ?? 500); i++) {
      const due = jobs.filter((j) => j.runAt <= now).sort((a, b) => a.runAt - b.runAt)[0];
      if (!due) return i;
      const h = history.get(due.id)!;
      try {
        mutate(due.fn, due.args);
        jobs = jobs.filter((j) => j !== due);
        history.set(due.id, { ...h, state: { kind: "success" }, attempts: h.attempts + 1 });
      } catch (e) {
        errors.push((e as Error).message);
        const attempts = h.attempts + 1;
        if (attempts >= 5) {
          jobs = jobs.filter((j) => j !== due);
          history.set(due.id, { ...h, state: { kind: "failed", error: String(e) }, attempts });
        } else history.set(due.id, { ...h, attempts });
      }
    }
    if (limit === undefined) throw new Error("tick: too many jobs");
    return limit;
  };
  const status = (name: string) => engine.runQuery("api:status", { name }).value as MigrationStatus | null;
  const sql = (s: string) => driver.exec(s).rows;
  return { engine, mutate, mutateFull, tick, status, sql, jobs: () => jobs, errors, advance: (ms: number) => (now += ms) };
}

const plans = (h: ReturnType<typeof harness>) => h.sql(`SELECT plan FROM orgs ORDER BY _creationTime, _id`).map((r) => r.plan ?? null);

describe("migrations component", () => {
  test("walks the table in batches (several per job) with the cursor persisted; done is a no-op", () => {
    const h = harness();
    h.mutate("api:seed", { n: 8 });
    const started = h.mutate("api:run", { name: "addPlan" });
    expect(started.status).toMatchObject({ name: "defs:addPlan", status: "running", processed: 0, cursor: null });
    // Nothing ran yet: starting is just a row and a job, atomic with the caller.
    expect(h.jobs().map((j) => j.fn)).toEqual(["@migrations/lib:step"]);

    // 3 batches of 3 fit one job's budget: one job, one write of the row (was a job per batch).
    expect(h.tick()).toBe(1);
    expect(h.status("addPlan")).toMatchObject({ status: "done", processed: 8, changed: 6, batches: 3, failed: 0 });
    expect(plans(h)).toEqual(["pro", "free", "free", "free", "pro", "free", "free", "free"]);
    expect(h.jobs()).toEqual([]);

    // Done: running it again changes nothing and schedules nothing.
    const again = h.mutate("api:run", { name: "addPlan" });
    expect(again.status).toMatchObject({ status: "done", batches: 3 });
    expect(h.jobs()).toEqual([]);
    // reset: from the start, counters cleared (idempotent migrateOne: nothing left to change).
    h.mutate("api:run", { name: "addPlan", reset: true });
    h.tick();
    expect(h.status("addPlan")).toMatchObject({ status: "done", processed: 8, changed: 0, batches: 3 });
  });

  test("a thrown batch is undone alone (the job's earlier batches commit), stops at its cursor, and a new start resumes from there", () => {
    const h = harness();
    h.mutate("api:seed", { n: 8 });
    probe.failOn = "org4";
    h.mutate("api:run", { name: "addPlan" });
    h.tick();
    // Same job: batch 1 (org0..2) committed; batch 2 (org3..5) threw at org4 and wrote nothing (org3 stays unmigrated).
    expect(h.status("addPlan")).toMatchObject({ status: "failed", processed: 3, changed: 2, batches: 1, failed: 1, lastError: "cannot migrate org4" });
    expect(plans(h)).toEqual(["pro", "free", "free", null, "pro", null, null, null]);
    expect(h.jobs()).toEqual([]);

    probe.failOn = "";
    probe.calls = 0;
    h.mutate("api:run", { name: "addPlan" });
    h.tick();
    expect(probe.calls).toBe(5); // resumed: org0..2 were not looked at again
    expect(h.status("addPlan")).toMatchObject({ status: "done", processed: 8, changed: 6, failed: 1 });
    expect(h.status("addPlan")!.lastError).toBeUndefined();
    expect(plans(h)).toEqual(["pro", "free", "free", "free", "pro", "free", "free", "free"]);
  });

  test("dryRun runs one batch in a savepoint that is rolled back and reports what would change", () => {
    const h = harness();
    h.mutate("api:seed", { n: 5 });
    const r = h.mutate("api:run", { name: "addPlan", dryRun: true });
    expect(r.status).toBeNull();
    expect(r.dryRun).toMatchObject({ processed: 3, changed: 2, isDone: false });
    expect(r.dryRun.samples).toHaveLength(2);
    expect(r.dryRun.samples[0]).toMatchObject({ before: { name: "org1" }, after: { name: "org1", plan: "free" } });
    expect(r.dryRun.samples[0].before.plan).toBeUndefined();
    // Nothing written, nothing recorded, nothing scheduled.
    expect(plans(h)).toEqual(["pro", null, null, null, "pro"]);
    expect(h.status("addPlan")).toBeNull();
    expect(h.jobs()).toEqual([]);

    // Writes through ctx.db count as changes too, and are rolled back as well.
    const w = h.mutate("api:run", { name: "audit", dryRun: true, batchSize: 4 });
    expect(w.dryRun).toMatchObject({ processed: 4, changed: 0 });
    expect(h.sql(`SELECT COUNT(*) AS n FROM audit`)[0]!.n).toBe(0);
  });

  test("documents migrateOne leaves alone are not re-read while the batch has written nothing", () => {
    // The batch function called directly with a counting db: what the engine would serve, minus the cache.
    const docs = Array.from({ length: 5 }, (_, i) => ({ _id: `o${i}`, _creationTime: i, name: `org${i}` }));
    const run = (def: typeof defs.noop, runMutation: () => unknown = () => null) => {
      const counts = { get: 0, patch: 0 };
      const db = {
        query: () => ({ paginate: () => ({ page: docs, isDone: true, continueCursor: "end" }) }),
        get: (id: string) => {
          counts.get++;
          return docs.find((d) => d._id === id) ?? null;
        },
        patch: () => void counts.patch++,
        insert: () => "a1",
      };
      const r = (def as unknown as { handler: (ctx: unknown, a: unknown) => { changed: number } }).handler({ db, runMutation }, { cursor: null });
      return { ...counts, changed: r.changed };
    };
    // Before: one db.get + one deep compare per document.
    expect(run(defs.noop)).toEqual({ get: 0, patch: 0, changed: 0 });
    // A migration that writes elsewhere for every document still compares each one (it may have written it).
    expect(run(defs.audit)).toEqual({ get: 5, patch: 0, changed: 0 });
    // Patches returned: applied, never re-read (outside a dry run), as before.
    expect(run(defs.addPlan)).toEqual({ get: 0, patch: 5, changed: 5 });
    // A nested mutation counts once it returns; one that throws (caught) wrote nothing: the fast path stays.
    expect(run(defs.bestEffort)).toEqual({ get: 5, patch: 0, changed: 0 });
    const failing = () => {
      throw new Error("side effect failed");
    };
    expect(run(defs.bestEffort, failing)).toEqual({ get: 0, patch: 0, changed: 0 });
  });

  test("after a write in the batch, documents are compared again: direct writes and triggers are counted", () => {
    for (const mode of ["direct", "trigger"]) {
      probe.failOn = mode;
      const h = harness(undefined, {
        audit: (ctx: MutationCtx<DM>) => {
          const org1 = ctx.db.query("orgs").collect().find((o) => o.name === "org1")!;
          ctx.db.patch(org1._id, { seats: 7 });
        },
      });
      h.mutate("api:seed", { n: 6 });
      h.mutate("api:run", { name: "touchLater" });
      h.tick();
      probe.failOn = "";
      // org1 changed (written while org0 was migrated); org0 itself did not.
      expect(h.status("touchLater")).toMatchObject({ status: "done", processed: 6, changed: 1 });
      expect(h.sql(`SELECT seats FROM orgs ORDER BY _creationTime, _id`).map((r) => r.seats ?? null)).toEqual([null, 7, null, null, null, null]);
      const noop = h.mutate("api:run", { name: "noop" });
      h.tick();
      expect(h.status("noop")).toMatchObject({ status: "done", processed: 6, changed: 0 });
      void noop;
    }
  });

  test("migrations that write through ctx.db; status is reactive", () => {
    const h = harness();
    h.mutate("api:seed", { n: 3 });
    const q = h.engine.runQuery("api:status", { name: "audit" });
    expect(q.value).toBeNull();
    const r = h.mutateFull("api:run", { name: "audit" });
    // The query's read set covers the component's row: the start invalidates it, and so does every batch.
    expect(h.engine.matches(q.readSet, r.changes)).toBe(true);
    const q2 = h.engine.runQuery("api:status", { name: "audit" });
    const job = h.jobs()[0]!;
    const step = h.mutateFull(job.fn, job.args);
    expect(h.engine.matches(q2.readSet, step.changes)).toBe(true);
    h.tick();
    expect(h.status("audit")).toMatchObject({ status: "done", processed: 3 });
    expect(h.sql(`SELECT COUNT(*) AS n FROM audit`)[0]!.n).toBe(3);
    const list = h.engine.runQuery("api:list", {}).value as MigrationStatus[];
    expect(list.map((s) => s.name)).toEqual(["defs:audit"]);
  });

  test("cancel stops after the current job; starting again resumes", () => {
    const h = harness();
    const perJob = 3 * STEP_BATCHES; // addPlan: batches of 3
    h.mutate("api:seed", { n: perJob + 9 });
    h.mutate("api:run", { name: "addPlan" });
    h.tick(1);
    expect(h.status("addPlan")).toMatchObject({ status: "running", processed: perJob, batches: STEP_BATCHES });
    expect(h.mutate("api:cancel", { name: "addPlan" })).toBe(true);
    expect(h.jobs()).toEqual([]);
    expect(h.status("addPlan")).toMatchObject({ status: "canceled", processed: perJob });
    expect(h.mutate("api:cancel", { name: "addPlan" })).toBe(false);
    h.mutate("api:run", { name: "addPlan" });
    expect(h.tick()).toBe(1);
    expect(h.status("addPlan")).toMatchObject({ status: "done", processed: perJob + 9, batches: STEP_BATCHES + 3 });
  });

  test("a job runs batches up to its budget (STEP_DOCUMENTS documents, STEP_BATCHES batches); progress is written per job", () => {
    // Small batches: STEP_BATCHES per job.
    const h = harness();
    h.mutate("api:seed", { n: 100 });
    h.mutate("api:run", { name: "addPlan" });
    expect(h.tick(1)).toBe(1);
    expect(h.status("addPlan")).toMatchObject({ status: "running", processed: 3 * STEP_BATCHES, batches: STEP_BATCHES });
    expect(h.status("addPlan")!.cursor).not.toBeNull();
    expect(h.tick()).toBe(2); // 48 + 48 + 4: 3 jobs for 34 batches (was 34 jobs)
    expect(h.status("addPlan")).toMatchObject({ status: "done", processed: 100, changed: 75, batches: 34 });
    expect(plans(h).filter((p) => p === null)).toEqual([]);

    // Default-sized batches (100): STEP_DOCUMENTS / 100 = 5 per job.
    const h2 = harness();
    for (let i = 0; i < 4; i++) h2.mutate("api:seed", { n: 300 });
    h2.mutate("api:run", { name: "noop", batchSize: 100 });
    expect(h2.tick()).toBe(3); // 1200 documents: 500 + 500 + 200
    expect(h2.status("noop")).toMatchObject({ status: "done", processed: 1200, batches: 12 });
    expect(STEP_DOCUMENTS / 100).toBe(5);

    // A batch of more than half the budget runs alone.
    const h3 = harness();
    h3.mutate("api:seed", { n: 600 });
    h3.mutate("api:run", { name: "noop", batchSize: 300 });
    expect(h3.tick()).toBe(2);
    expect(h3.status("noop")).toMatchObject({ status: "done", processed: 600, batches: 2 });
  });

  test("a job of several batches over the shard's limits falls back to one batch per job, keeping the batch size", () => {
    // One batch of addPlan (3 documents, patched) fits the read limit; a job of many does not.
    const h = harness({ rowsRead: 40 });
    h.mutate("api:seed", { n: 30 });
    h.mutate("api:run", { name: "addPlan" });
    h.tick();
    expect(h.errors.some((e) => /Too many rows read/.test(e))).toBe(true);
    // Every document migrated exactly once (the failed transaction wrote nothing); the batch size was not lowered.
    expect(h.status("addPlan")).toMatchObject({ status: "done", processed: 30, changed: 22, batches: 10, failed: 0, batchSize: null });
    expect(plans(h).filter((p) => p === null)).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.jobs()).toEqual([]);
    // A reset starts with the whole budget again.
    h.mutate("api:run", { name: "addPlan", reset: true });
    expect(h.sql(`SELECT "stepBatches" AS s FROM "migrations$migrations"`)[0]!.s ?? null).toBeNull();
  });

  test("runSerially: each migration starts when the previous one is done; done ones are skipped; a failure stops the chain", () => {
    const h = harness();
    h.mutate("api:seed", { n: 4 });
    const r = h.mutate("api:serial", { names: ["addPlan", "seats"] });
    expect(r.status).toMatchObject({ name: "defs:addPlan", next: ["defs:seats"] });
    h.tick();
    expect(h.status("addPlan")).toMatchObject({ status: "done", next: [] });
    // seats ran after addPlan: every org has a plan, so seats depend on it.
    expect(h.status("seats")).toMatchObject({ status: "done", processed: 4, changed: 4 });
    expect(h.sql(`SELECT seats FROM orgs ORDER BY _creationTime, _id`).map((x) => x.seats)).toEqual([10, 1, 1, 1]);

    // addPlan is done already: the chain goes straight to audit.
    h.mutate("api:serial", { names: ["addPlan", "audit"] });
    expect(h.status("audit")).toMatchObject({ status: "running" });
    h.tick();
    expect(h.status("audit")).toMatchObject({ status: "done" });

    // A failure stops the chain before the next one.
    const h2 = harness();
    h2.mutate("api:seed", { n: 4 });
    probe.failOn = "org2";
    h2.mutate("api:serial", { names: ["addPlan", "seats"] });
    h2.tick();
    probe.failOn = "";
    expect(h2.status("addPlan")).toMatchObject({ status: "failed" });
    expect(h2.status("seats")).toBeNull();
    // Running the chain again resumes it.
    h2.mutate("api:serial", { names: ["addPlan", "seats"] });
    h2.tick();
    expect(h2.status("seats")).toMatchObject({ status: "done" });
  });

  test("a batch over the shard's limits fails its transaction; the retry halves the batch size until it fits", () => {
    // 8 docs per batch, each reading 4 more: ~45 rows per batch with the cursor and the patches. Limit 30.
    const h = harness({ rowsRead: 30 });
    h.mutate("api:seed", { n: 12 });
    h.mutate("api:run", { name: "heavy" });
    h.tick();
    expect(h.errors.some((e) => /Too many rows read/.test(e))).toBe(true);
    const s = h.status("heavy")!;
    expect(s).toMatchObject({ status: "done", processed: 12, changed: 12, failed: 0 });
    expect(s.batchSize).toBeLessThan(8);
    // Every document migrated exactly once (a failed transaction wrote nothing).
    expect(h.sql(`SELECT seats FROM orgs`).map((x) => x.seats)).toEqual(Array(12).fill(100));
    expect(h.jobs()).toEqual([]);
  });

  test("a batch that never fits fails the migration with a clear error", () => {
    const h = harness({ rowsRead: 5 });
    h.mutate("api:seed", { n: 3 });
    h.mutate("api:run", { name: "heavy" });
    h.tick();
    const s = h.status("heavy")!;
    expect(s.status).toBe("failed");
    expect(s.lastError).toMatch(/even with 1 document per batch/);
    expect(h.jobs()).toEqual([]);
  });

  test("bad arguments", () => {
    const h = harness();
    expect(() => h.engine.runMutation("@migrations/lib:start", { name: "x", fn: "defs:addPlan" })).toThrow(/function handle/);
    expect(() => h.mutate("api:run", { name: "addPlan", batchSize: 100_000 })).toThrow(/batchSize/);
    expect(() => m.define({ table: "orgs", batchSize: 0, migrateOne: () => undefined })).toThrow(/batchSize/);
  });
});

// Types: migrateOne gets the table's document and returns a patch typed by it.
() => {
  m.define({ table: "orgs", migrateOne: (_ctx, doc) => ({ plan: doc.name }) });
  // @ts-expect-error unknown table
  m.define({ table: "nope", migrateOne: () => undefined });
  // @ts-expect-error wrong field type in the patch
  m.define({ table: "orgs", migrateOne: () => ({ plan: 1 }) });
  // @ts-expect-error system fields are not patchable
  m.define({ table: "orgs", migrateOne: (_ctx, doc) => ({ _id: doc._id }) });
};
// The helpers take real ctx types: sync in queries and mutations, Promises in actions.
(qc: QueryCtx<DM>, mc: MutationCtx<DM>, ac: ActionCtx<DM>) => {
  const s: MigrationStatus | null = m.status(qc, "defs:addPlan");
  const started: MigrationStatus | null = m.run(mc, "defs:addPlan").status;
  const later: Promise<boolean> = m.cancel(ac, "defs:addPlan");
  return [s, started, later];
};
