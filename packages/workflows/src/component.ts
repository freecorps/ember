// The workflows component (PLAN §8, §12): durable multi-step functions on the shard scheduler.
//
// Loop, per workflow (all in the shard where it was started):
//   lib:start (mutation, in the caller's transaction) ─ insert workflow, schedule lib:drive
//   lib:drive (action) ─ load journal → run the app's driver (replay, via a function handle) → lib:advance
//   lib:advance (mutation) ─ fenced by the step index: record the requested step and execute it:
//       query / mutation  → right here, in this transaction (exactly once with the journal); advance hands the
//                           finished entry back and the same drive run replays again (up to LOCAL_STEPS steps,
//                           then it schedules lib:drive)
//       action            → schedule lib:runAction (at least once; retried with backoff). Once the action's result is
//                           final, the same job replays the driver and lib:actionDone settles the step and advances to
//                           the next one in one transaction (no lib:drive job): one job per action step
//       sleep             → schedule lib:wake at `until` → drive
//       event             → consume a buffered event, or wait for lib:sendEvent (timeout → lib:wake)
//       parallel batch    → each step of a `steps` outcome as above, in one transaction (`batchStart`, and
//                           `batchPending` steps still running); the step that settles last drives on (its
//                           runAction job replays and advances, like a single action step)
//   done / failed         → status, result, and the onComplete handle in the same transaction (and, with
//                           `retentionMs`, a lib:expire job that deletes it later).
// Every scheduled job carries the step index it is for, so duplicate or stale jobs (action jobs are delivered at
// least once) are no-ops. A drive run that continues inline writes `driving` (its job's index) in the same patch as
// the step count; a retry of that job after a crash mid-loop resumes from the step count instead of stalling. A
// runAction job continuing after step i runs as the drive job of index i + 1 would (`driving` = i + 1), and its
// retry resumes the same way.

import { componentBuilders, defineComponent, defineSchema, defineTable, EmberError, paginationOptsValidator, unsafeRef, v, type ComponentCtx, type DataModelFromSchema, type GenericId, type WithoutSystemFields } from "@freecorps/ember-server";
import type { JournalEntry, Outcome, RetryPolicy, StepRequest } from "./replay.ts";

const status = v.union(v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("canceled"));
const stepKind = v.union(v.literal("query"), v.literal("mutation"), v.literal("action"), v.literal("sleep"), v.literal("event"));

const schema = defineSchema({
  tables: {
    workflows: defineTable({
      /** Handle of the app's driver (`workflow.define(...)`, an internalAction). */
      driver: v.string(),
      args: v.any(),
      status,
      /** Steps recorded so far (the next step's index). */
      stepCount: v.number(),
      result: v.optional(v.any()),
      error: v.optional(v.string()),
      /** Job of the pending action/sleep/timeout (cancelled by `cancel`). */
      pendingJob: v.optional(v.string()),
      onComplete: v.optional(v.string()),
      context: v.optional(v.any()),
      startedAt: v.number(),
      finishedAt: v.optional(v.number()),
      maxSteps: v.number(),
      /**
       * Index of the `lib:drive` job whose run is advancing steps inline (no job scheduled for each of them). Cleared
       * when a step schedules a job again. Absent in rows from older versions (= no inline run).
       */
      driving: v.optional(v.number()),
      /**
       * First index of the current batch of parallel steps (`Promise.all`), when it has more than one step: the batch
       * is `[batchStart, stepCount)`. Absent: the current step is the one at `stepCount - 1`.
       */
      batchStart: v.optional(v.number()),
      /** Steps of that batch still running: the one that settles last drives the workflow on. */
      batchPending: v.optional(v.number()),
    })
      // `list` by status, newest first (a status changes at most twice: the entry is written on start and on finish).
      .index("by_status", ["status"]),
    steps: defineTable({
      workflow: v.id("workflows"),
      index: v.number(),
      kind: stepKind,
      name: v.string(),
      fn: v.optional(v.string()),
      args: v.optional(v.any()),
      event: v.optional(v.string()),
      runAt: v.optional(v.number()),
      retry: v.optional(v.object({ maxAttempts: v.number(), initialBackoffMs: v.optional(v.number()), base: v.optional(v.number()) })),
      status: v.union(v.literal("pending"), v.literal("done"), v.literal("failed")),
      result: v.optional(v.any()),
      error: v.optional(v.string()),
      attempts: v.number(),
      startedAt: v.number(),
      completedAt: v.optional(v.number()),
      /** Pending job (action, sleep, event timeout) of a step of a parallel batch (a single step's is `pendingJob`). */
      job: v.optional(v.string()),
      /** End of the parallel batch the step belongs to (absent: a single step, `index + 1`). */
      batchEnd: v.optional(v.number()),
    })
      // Only `by_workflow`: a waiting event step is in the current batch (`[batchStart, stepCount)`, the last step when
      // it is not a parallel one). The `by_event` index of older versions had no reader: dropped (an index write each).
      .index("by_workflow", ["workflow", "index"]),
    /** Events sent before the workflow waits for them. */
    events: defineTable({ workflow: v.id("workflows"), event: v.string(), payload: v.optional(v.any()) }).index("by_workflow", ["workflow", "event"]),
  },
});

export type WorkflowsInstallConfig = {
  /** Steps per workflow before it fails (runaway loops; each step replays the journal). Default 1000. */
  maxSteps?: number;
  /**
   * How long a `completed` workflow (and its journal) is kept after it finished: then a `lib:expire` job deletes it
   * (as `cleanup` would; `status` → null). Default: kept until `cleanup`.
   */
  retentionMs?: number;
  /** The same for `failed` and `canceled` workflows. Default: kept until `cleanup`. */
  failedRetentionMs?: number;
};

const { query, mutation, internalMutation, internalQuery, internalAction } = componentBuilders<typeof schema, WorkflowsInstallConfig | undefined>();

type WId = GenericId<"workflows">;
type Ctx = ComponentCtx<typeof schema, WorkflowsInstallConfig | undefined>["mutation"];
type ReadCtx = ComponentCtx<typeof schema, WorkflowsInstallConfig | undefined>["query"];
type ActCtx = ComponentCtx<typeof schema, WorkflowsInstallConfig | undefined>["action"];
type WRow = DataModelFromSchema<typeof schema>["workflows"]["document"];

const DEFAULT_MAX_STEPS = 1000;
/**
 * Synchronous steps (query, mutation, buffered event) one `lib:drive` run advances before it hands over to a new
 * job: each saves a Queue job, a Worker invocation and a journal read; the bound keeps one run short.
 */
export const LOCAL_STEPS = 16;
/** Rows `cleanup` deletes per transaction; the rest goes to `lib:cleanupRest` jobs. */
export const CLEANUP_BATCH = 200;

export type WorkflowStepState = { index: number; kind: string; name: string; attempts: number; runAt?: number };

export type WorkflowStatus = {
  status: "running" | "completed" | "failed" | "canceled";
  result?: unknown;
  error?: string;
  stepCount: number;
  /** The step being executed / waited on, when running (the first one still running of a parallel batch). */
  current?: WorkflowStepState;
  /** All steps of a parallel batch still running (only for a batch of more than one step). */
  parallel?: WorkflowStepState[];
  startedAt: number;
  finishedAt?: number;
};

/** A row of `list`. */
export type WorkflowSummary = {
  id: string;
  status: WorkflowStatus["status"];
  stepCount: number;
  startedAt: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
};

function load(ctx: ReadCtx, id: string) {
  const id2 = ctx.db.normalizeId("workflows", id);
  return id2 ? ctx.db.get(id2) : null;
}

/** The step at `index` (one row per index: `first()`, no second row read to check it). */
function stepAt(ctx: ReadCtx, wf: WId, index: number) {
  return ctx.db.query("steps").withIndex("by_workflow", (q) => q.eq("workflow", wf).eq("index", index)).first();
}

/** The steps of the current batch, `[batchStart, stepCount)`: a parallel batch's rows (one row for a single step). */
function batchRows(ctx: ReadCtx, w: WRow) {
  if (w.batchStart === undefined) {
    const s = w.stepCount > 0 ? stepAt(ctx, w._id, w.stepCount - 1) : null;
    return s ? [s] : [];
  }
  const start = w.batchStart;
  return ctx.db.query("steps").withIndex("by_workflow", (q) => q.eq("workflow", w._id).gte("index", start)).collect();
}

/** Step `index` belongs to the current batch (the only steps that may still be pending). */
const inBatch = (w: WRow, index: number) => index >= (w.batchStart ?? w.stepCount - 1) && index < w.stepCount;

const stepState = (s: { index: number; kind: string; name: string; attempts: number; runAt?: number }): WorkflowStepState => ({
  index: s.index,
  kind: s.kind,
  name: s.name,
  attempts: s.attempts,
  ...(s.runAt !== undefined ? { runAt: s.runAt } : {}),
});

/** All journal rows of a workflow, in index order. */
const journalOf = (ctx: ReadCtx, wf: WId) => ctx.db.query("steps").withIndex("by_workflow", (q) => q.eq("workflow", wf)).collect();

function summaryOf(w: WRow): WorkflowSummary {
  const out: WorkflowSummary = { id: w._id, status: w.status, stepCount: w.stepCount, startedAt: w.startedAt };
  if (w.finishedAt !== undefined) out.finishedAt = w.finishedAt;
  if (w.result !== undefined) out.result = w.result;
  if (w.error !== undefined) out.error = w.error;
  return out;
}

const backoff = (r: RetryPolicy | undefined, attempts: number) => (r?.initialBackoffMs ?? 1000) * (r?.base ?? 2) ** Math.max(0, attempts - 1);

const drive = (ctx: Ctx, id: WId, index: number) => ctx.scheduler.runAfter(0, "lib:drive", { id, index });

/** Finishes a workflow (status, result, onComplete in this transaction). */
function finish(ctx: Ctx, w: any, end: { status: "completed" | "failed" | "canceled"; result?: unknown; error?: string }) {
  const patch: Record<string, unknown> = { status: end.status, finishedAt: ctx.now, pendingJob: undefined };
  if (w.driving !== undefined) patch.driving = undefined;
  if (w.batchStart !== undefined) Object.assign(patch, { batchStart: undefined, batchPending: undefined });
  if (end.result !== undefined) patch.result = end.result;
  if (end.error !== undefined) patch.error = end.error;
  ctx.db.patch(w._id, patch);
  if (w.onComplete) {
    const outcome = end.status === "completed" ? { kind: "success", result: end.result ?? null } : end.status === "failed" ? { kind: "failed", error: end.error ?? "" } : { kind: "canceled" };
    // A failing callback is undone (savepoint) and logged; the workflow still finishes.
    try {
      ctx.runMutation(w.onComplete, { workflowId: w._id, outcome, context: w.context ?? null });
    } catch (e) {
      console.error(`workflows: onComplete of ${w._id} failed: ${message(e)}`);
    }
  }
  const config = ctx.component.config;
  const keep = end.status === "completed" ? config?.retentionMs : config?.failedRetentionMs;
  if (keep !== undefined && Number.isFinite(keep)) ctx.scheduler.runAfter(Math.max(0, keep), "lib:expire", { id: w._id });
}

type StepResult = { ok: true; value: unknown } | { ok: false; error: string };

/** The fields that settle a step (`extra`: more fields for the same write). */
const settled = (ctx: Ctx, r: StepResult, extra: Record<string, unknown> = {}) =>
  r.ok ? { ...extra, status: "done" as const, result: r.value ?? null, completedAt: ctx.now } : { ...extra, status: "failed" as const, error: r.error, completedAt: ctx.now };

/**
 * Marks a waiting step (action, sleep, event) done/failed in one write and lets the workflow continue. The
 * workflow's `pendingJob` (the job that just ran, or a cancelled timeout) is left as is: cancelling a finished job is
 * a no-op, and the next step's write replaces it. In a parallel batch with other steps still running, only the count
 * goes down: the last one drives on.
 */
function settle(ctx: Ctx, w: WRow, s: { _id: GenericId<"steps"> }, r: StepResult, extra?: Record<string, unknown>) {
  ctx.db.patch(s._id, settled(ctx, r, extra));
  if (!lastPending(w)) return void ctx.db.patch(w._id, { batchPending: (w.batchPending ?? 1) - 1 });
  drive(ctx, w._id, w.stepCount);
}

/** The step being settled is the last one of the batch still running. */
const lastPending = (w: WRow) => w.batchStart === undefined || (w.batchPending ?? 1) <= 1;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Records and executes the step the driver asked for. */
type StepRow = WithoutSystemFields<DataModelFromSchema<typeof schema>["steps"]["document"]>;

const entryOf = (s: StepRow): JournalEntry => ({ index: s.index, kind: s.kind, name: s.name, status: s.status, ...(s.result !== undefined ? { result: s.result } : {}), ...(s.error !== undefined ? { error: s.error } : {}) });

/**
 * Records the steps of a batch (one step, or the parallel steps of a `steps` outcome) from index `index` and executes
 * them: one insert per step (already settled when it ran here) and one patch for the workflow. Returns the journal
 * entries when every step finished in this transaction and `inline` (the index of the drive job running inline) is
 * given: the caller replays on with them, and no `lib:drive` job is scheduled.
 */
function execute(ctx: Ctx, w: WRow, index: number, reqs: StepRequest[], inline: number | undefined): JournalEntry[] | null {
  const parallel = reqs.length > 1;
  const end = index + reqs.length;
  const entries: JournalEntry[] = [];
  let running = 0;
  let single: string | undefined;
  reqs.forEach((req, k) => {
    const at = index + k;
    const row: StepRow = { workflow: w._id, index: at, kind: req.kind, name: req.name, status: "pending", attempts: 0, startedAt: ctx.now };
    if (parallel) row.batchEnd = end;
    if ("fn" in req) {
      row.fn = req.fn;
      row.args = req.args;
      if (req.retry) row.retry = req.retry;
    }
    if (req.kind === "sleep") row.runAt = req.until ?? ctx.now + (req.ms ?? 0);
    if (req.kind === "event") {
      row.event = req.event;
      if (req.timeoutMs !== undefined) row.runAt = ctx.now + req.timeoutMs;
    }
    let result: StepResult | null = null;
    let job: string | undefined;
    switch (req.kind) {
      case "query":
      case "mutation":
        // Same transaction as the journal entry: a mutation step commits exactly once. A failure is undone
        // (savepoint) and recorded; the handler sees it as a rejected step.
        try {
          result = { ok: true, value: req.kind === "query" ? ctx.runQuery(unsafeRef<"query">(req.fn), req.args as Record<string, unknown>) : ctx.runMutation(unsafeRef<"mutation">(req.fn), req.args as Record<string, unknown>) };
        } catch (e) {
          result = { ok: false, error: message(e) };
        }
        row.attempts = 1;
        break;
      case "action":
        job = ctx.scheduler.runAfter(0, "lib:runAction", { id: w._id, index: at });
        break;
      case "sleep":
        job = ctx.scheduler.runAt(Math.max(ctx.now, row.runAt as number), "lib:wake", { id: w._id, index: at });
        break;
      case "event": {
        const buffered = ctx.db.query("events").withIndex("by_workflow", (q) => q.eq("workflow", w._id).eq("event", req.event)).first();
        if (buffered) {
          ctx.db.delete(buffered._id);
          result = { ok: true, value: buffered.payload ?? null };
        } else if (req.timeoutMs !== undefined) {
          job = ctx.scheduler.runAfter(req.timeoutMs, "lib:wake", { id: w._id, index: at });
        }
        break;
      }
    }
    const full: StepRow = result ? { ...row, ...settled(ctx, result) } : row;
    if (!result) running++;
    if (job !== undefined) {
      if (parallel) full.job = job;
      else single = job;
    }
    ctx.db.insert("steps", full);
    if (result) entries.push(entryOf(full));
  });
  const continues = running === 0 && inline !== undefined;
  const patch: Record<string, unknown> = { stepCount: end };
  if (single !== undefined) patch.pendingJob = single;
  else if (w.pendingJob !== undefined) patch.pendingJob = undefined; // the previous step's job, already run
  if (parallel) Object.assign(patch, { batchStart: index, batchPending: running });
  else if (w.batchStart !== undefined) Object.assign(patch, { batchStart: undefined, batchPending: undefined });
  if (continues) {
    if (w.driving !== inline) patch.driving = inline;
  } else if (w.driving !== undefined) patch.driving = undefined;
  ctx.db.patch(w._id, patch);
  if (running > 0) return null;
  if (continues) return entries;
  drive(ctx, w._id, end);
  return null;
}

/**
 * Deletes up to CLEANUP_BATCH journal rows of `wf`; schedules `lib:cleanupRest` only when rows are left (each read
 * takes one row more than it may delete, so a journal of exactly CLEANUP_BATCH rows needs no follow-up job).
 */
function deleteJournal(ctx: Ctx, wf: WId) {
  let budget = CLEANUP_BATCH;
  const steps = ctx.db.query("steps").withIndex("by_workflow", (q) => q.eq("workflow", wf)).take(budget + 1);
  for (const s of steps.slice(0, budget)) ctx.db.delete(s._id);
  let more = steps.length > budget;
  budget -= Math.min(steps.length, budget);
  if (!more) {
    const events = ctx.db.query("events").withIndex("by_workflow", (q) => q.eq("workflow", wf)).take(budget + 1);
    for (const e of events.slice(0, budget)) ctx.db.delete(e._id);
    more = events.length > budget;
  }
  if (more) ctx.scheduler.runAfter(0, "lib:cleanupRest", { id: wf });
}

/**
 * Applies the driver's outcome for step `index` (= `w.stepCount`, fenced by the caller): finish, or record and
 * execute the requested step (see `execute` for `inline` and the returned entry).
 */
function advanceTo(ctx: Ctx, w: WRow, index: number, o: Outcome, inline: number | undefined): JournalEntry[] | null {
  if (o.type === "done") return (finish(ctx, w, { status: "completed", result: o.result ?? null }), null);
  if (o.type === "failed") return (finish(ctx, w, { status: "failed", error: o.error }), null);
  // A replay() driver always asks for step `index` (= the journal length, fenced by the caller). Anything else
  // comes from a driver that is not one (any handle can be passed to start): fail loudly rather than
  // return with no job scheduled, which would leave the workflow "running" forever.
  const reqs = o.type === "step" ? [o.step] : o.type === "steps" && Array.isArray(o.steps) ? o.steps : [];
  if ((o.type !== "step" && o.type !== "steps") || o.index !== index || reqs.length === 0 || !reqs.every((r) => r && STEP_KINDS.has(r.kind))) {
    finish(ctx, w, { status: "failed", error: `InvalidOutcome: the driver returned ${show(o)} for step ${index} (expected a step request with index ${index}, done or failed)` });
    return null;
  }
  if (index + reqs.length > w.maxSteps) return (finish(ctx, w, { status: "failed", error: `workflow exceeded ${w.maxSteps} steps` }), null);
  return execute(ctx, w, index, reqs, inline);
}

type Loaded = { status: string; driver: string; args: unknown; stepCount: number; journal: JournalEntry[]; driving?: number };

const loadRun = async (ctx: ActCtx, id: WId) => (await ctx.runQuery(unsafeRef<"query">("lib:load"), { id })) as Loaded | null;

/**
 * One replay of the app's driver against `journal`, for step `at`. Null: the driver is waiting on a journaled step
 * that is still pending (a stale run): nothing to do.
 */
async function replayOnce(ctx: ActCtx, id: WId, w: Loaded, journal: JournalEntry[], at: number): Promise<Outcome | null> {
  let outcome: Outcome;
  try {
    outcome = (await ctx.runAction(unsafeRef<"action">(w.driver), { workflowId: id, args: w.args, journal })) as Outcome;
  } catch (e) {
    outcome = { type: "failed", error: `driver: ${message(e)}` };
  }
  if (!outcome || typeof outcome !== "object") outcome = { type: "failed", error: `driver returned an invalid outcome: ${show(outcome)}` };
  // "waiting" is only legitimate while a journaled step is still pending (sleep, event, action in flight):
  // that step's completion drives the workflow on. Otherwise nothing would ever run it again.
  if (outcome.type === "waiting") {
    if (journal.some((s) => s.status === "pending")) return null;
    outcome = { type: "failed", error: `InvalidOutcome: the driver returned "waiting" for step ${at} but no step is pending` };
  }
  return outcome;
}

/**
 * The inline loop of a drive run (job index `job`): replay, advance, and replay again with the entry `advance` hands
 * back, while steps finish inline. `n`: the number of the next advance in this run (LOCAL_STEPS per run).
 */
async function driveInline(ctx: ActCtx, id: WId, w: Loaded, journal: JournalEntry[], at: number, job: number, n: number): Promise<void> {
  for (; ; n++) {
    const outcome = await replayOnce(ctx, id, w, journal, at);
    if (!outcome) return;
    const args: { id: WId; index: number; outcome: Outcome; inline?: number } = { id, index: at, outcome };
    if (n < LOCAL_STEPS) args.inline = job;
    const entries = (await ctx.runMutation(unsafeRef<"mutation">("lib:advance"), args)) as JournalEntry[] | null;
    if (!entries) return; // finished, waiting on a job, scheduled the next drive, or fenced out
    journal.push(...entries);
    at += entries.length;
  }
}

/** Runs the drive job of index `index` (the step count it is for), from the journal. */
async function driveFrom(ctx: ActCtx, id: WId, index: number): Promise<void> {
  const w = await loadRun(ctx, id);
  if (w) await driveLoaded(ctx, id, w, index);
}

/** `driveFrom` with the run already loaded. */
async function driveLoaded(ctx: ActCtx, id: WId, w: Loaded, index: number): Promise<void> {
  if (w.status !== "running") return;
  // Stale or duplicate, unless this job's own run advanced inline before it died (the job is retried with the
  // same index): then it resumes from the step count.
  if (w.stepCount !== index && w.driving !== index) return;
  await driveInline(ctx, id, w, w.journal, w.stepCount, index, 1);
}

/**
 * What a runAction job needs, in one read: the action step to run (`step`; `final` when this attempt is the last one)
 * and the run (driver, args, journal) to replay once its result is final. `resume`: the step is settled and an inline
 * run continuing after it (`driving` = the end of its batch) did not finish (a retry of the job after a crash).
 */
type ActionStep = { step: { fn: string; args: unknown; name: string; final: boolean }; run: Loaded } | { resume: number; run: Loaded };

function loaded(w: WRow, journal: JournalEntry[]): Loaded {
  return { status: w.status, driver: w.driver, args: w.args, stepCount: w.stepCount, journal, ...(w.driving !== undefined ? { driving: w.driving } : {}) };
}

const outcomeValidator = v.any();

const STEP_KINDS = new Set(["query", "mutation", "action", "sleep", "event"]);
const show = (x: unknown) => {
  let j: string | undefined;
  try {
    j = JSON.stringify(x);
  } catch {}
  j ??= String(x);
  return j.length > 200 ? `${j.slice(0, 200)}...` : j;
};

export const functions = {
  lib: {
    /** Starts a workflow in this shard (in the caller's transaction). Returns its id. */
    start: mutation({
      args: { driver: v.string(), args: v.optional(v.any()), onComplete: v.optional(v.string()), context: v.optional(v.any()) },
      returns: v.string(),
      handler: (ctx, a) => {
        if (!a.driver.startsWith("&")) throw new EmberError("ValidationError", "workflows: driver must be a function handle");
        if (a.onComplete !== undefined && !a.onComplete.startsWith("&")) throw new EmberError("ValidationError", "workflows: onComplete must be a function handle");
        const doc: Record<string, unknown> = {
          driver: a.driver,
          args: a.args ?? {},
          status: "running",
          stepCount: 0,
          startedAt: ctx.now,
          maxSteps: ctx.component.config?.maxSteps ?? DEFAULT_MAX_STEPS,
        };
        if (a.onComplete) doc.onComplete = a.onComplete;
        if (a.context !== undefined) doc.context = a.context;
        const id = ctx.db.insert("workflows", doc as any);
        drive(ctx, id, 0);
        return id;
      },
    }),

    /** Status of a workflow (reactive); null if unknown. */
    status: query({
      args: { id: v.string() },
      handler: (ctx, { id }): WorkflowStatus | null => {
        const w = load(ctx, id);
        if (!w) return null;
        const out: WorkflowStatus = { status: w.status, stepCount: w.stepCount, startedAt: w.startedAt };
        if (w.result !== undefined) out.result = w.result;
        if (w.error !== undefined) out.error = w.error;
        if (w.finishedAt !== undefined) out.finishedAt = w.finishedAt;
        if (w.status === "running" && w.stepCount > 0) {
          const running = batchRows(ctx, w).filter((s) => s.status === "pending").map(stepState);
          if (running[0]) out.current = running[0];
          if (w.batchStart !== undefined) out.parallel = running;
        }
        return out;
      },
    }),

    /**
     * Workflows of this shard, newest first, optionally of one `status` (paginated: `{ page, isDone,
     * continueCursor }`). Each row is a summary (no current step: `status` has it).
     */
    list: query({
      args: { status: v.optional(status), paginationOpts: paginationOptsValidator },
      handler: (ctx, a): { page: WorkflowSummary[]; isDone: boolean; continueCursor: string } => {
        const which = a.status;
        const q = which === undefined ? ctx.db.query("workflows") : ctx.db.query("workflows").withIndex("by_status", (x) => x.eq("status", which));
        const r = q.order("desc").paginate(a.paginationOpts);
        return { ...r, page: r.page.map(summaryOf) };
      },
    }),

    /** The journal (for dashboards and debugging). */
    steps: query({
      args: { id: v.string() },
      handler: (ctx, { id }) => {
        const w = load(ctx, id);
        if (!w) return [];
        return ctx.db.query("steps").withIndex("by_workflow", (q) => q.eq("workflow", w._id)).collect()
          .map((s) => ({ index: s.index, kind: s.kind, name: s.name, status: s.status, attempts: s.attempts, result: s.result, error: s.error, startedAt: s.startedAt, completedAt: s.completedAt, ...(s.batchEnd !== undefined ? { batchEnd: s.batchEnd } : {}) }));
      },
    }),

    /** Delivers an event: completes a waiting `waitForEvent`, or buffers it. False if the workflow is not running. */
    sendEvent: mutation({
      args: { id: v.string(), event: v.string(), payload: v.optional(v.any()) },
      returns: v.boolean(),
      handler: (ctx, a) => {
        const w = load(ctx, a.id);
        if (!w || w.status !== "running") return false;
        // A step waiting for an event is in the current batch: the last step, or one of a parallel batch (the first
        // one waiting for this event takes it).
        const waiting = batchRows(ctx, w).find((s) => s.kind === "event" && s.status === "pending" && s.event === a.event);
        if (waiting) {
          const timeout = w.batchStart === undefined ? w.pendingJob : waiting.job;
          if (timeout) ctx.scheduler.cancel(timeout);
          settle(ctx, w, waiting, { ok: true, value: a.payload ?? null });
        } else {
          ctx.db.insert("events", { workflow: w._id, event: a.event, ...(a.payload !== undefined ? { payload: a.payload } : {}) });
        }
        return true;
      },
    }),

    /** Cancels a running workflow (its pending job is cancelled; onComplete gets `canceled`). */
    cancel: mutation({
      args: { id: v.string() },
      returns: v.boolean(),
      handler: (ctx, { id }) => {
        const w = load(ctx, id);
        if (!w || w.status !== "running") return false;
        if (w.pendingJob) ctx.scheduler.cancel(w.pendingJob);
        if (w.batchStart !== undefined) for (const s of batchRows(ctx, w)) if (s.status === "pending" && s.job) ctx.scheduler.cancel(s.job);
        finish(ctx, w, { status: "canceled" });
        return true;
      },
    }),

    /**
     * Deletes a finished workflow and its journal. False if it is still running (or unknown). The workflow row goes
     * now (status → null); a journal longer than CLEANUP_BATCH rows is deleted by `lib:cleanupRest` jobs.
     */
    cleanup: mutation({
      args: { id: v.string() },
      returns: v.boolean(),
      handler: (ctx, { id }) => {
        const w = load(ctx, id);
        if (!w || w.status === "running") return false;
        ctx.db.delete(w._id);
        deleteJournal(ctx, w._id);
        return true;
      },
    }),

    // ---------------------------------------------------------------------------------------- internal loop

    /** Retention (`retentionMs` / `failedRetentionMs`): deletes a finished workflow, as `cleanup` does. */
    expire: internalMutation({
      args: { id: v.id("workflows") },
      handler: (ctx, { id }) => {
        const w = ctx.db.get(id);
        if (!w || w.status === "running") return; // cleaned up already
        ctx.db.delete(w._id);
        deleteJournal(ctx, w._id);
      },
    }),

    /** The rest of a cleaned-up workflow's journal, CLEANUP_BATCH rows per job. */
    cleanupRest: internalMutation({
      args: { id: v.id("workflows") },
      handler: (ctx, { id }) => {
        if (ctx.db.get(id)) return; // not cleaned up (ids are never reused: a stale job)
        deleteJournal(ctx, id);
      },
    }),

    load: internalQuery({
      args: { id: v.id("workflows") },
      handler: (ctx, { id }) => {
        const w = ctx.db.get(id);
        if (!w) return null;
        return loaded(w, journalOf(ctx, id).map(entryOf));
      },
    }),

    /**
     * Replays the app's driver and hands the outcome to `advance`. `index`: the step count this run is for. Steps
     * that finish inside `advance` (query, mutation, buffered event) come back as journal entries and the run replays
     * again, up to LOCAL_STEPS of them; the last one schedules a new drive job.
     */
    drive: internalAction({
      args: { id: v.id("workflows"), index: v.number() },
      handler: async (ctx, { id, index }) => driveFrom(ctx, id, index),
    }),

    advance: internalMutation({
      args: { id: v.id("workflows"), index: v.number(), outcome: outcomeValidator, inline: v.optional(v.number()) },
      handler: (ctx, { id, index, outcome, inline }): JournalEntry[] | null => {
        const w = ctx.db.get(id);
        if (!w || w.status !== "running" || w.stepCount !== index) return null; // fenced: another run got here first
        return advanceTo(ctx, w, index, outcome as Outcome, inline);
      },
    }),

    /**
     * Runs an action step (at least once), then records it. When the result is final (a success, or the last
     * attempt's failure), this job also replays the driver with the settled step and `actionDone` advances to the
     * next step in the same transaction: no `lib:drive` job per action step. Steps that finish inline after it run
     * on in this job, as the drive job of the batch's end would (`driving` = that index, so a retry of this job after
     * a crash resumes from the step count). The step and the run come from one read (`actionStep`) before the
     * action: the journal does not change while the step is pending, except for parallel siblings settling, and a
     * replay that sees one of them still running is `waiting` (then the sibling that settles last drives on).
     */
    runAction: internalAction({
      args: { id: v.id("workflows"), index: v.number() },
      handler: async (ctx, { id, index }) => {
        const s = (await ctx.runQuery(unsafeRef<"query">("lib:actionStep"), { id, index })) as ActionStep | null;
        if (!s) return;
        if ("resume" in s) return driveLoaded(ctx, id, s.run, s.resume);
        let r: StepResult;
        try {
          r = { ok: true, value: await ctx.runAction(unsafeRef<"action">(s.step.fn), (s.step.args ?? {}) as Record<string, unknown>) };
        } catch (e) {
          r = { ok: false, error: message(e) };
        }
        const done = { id, index, result: r };
        // A failure with attempts left: actionDone schedules the retry.
        if (!r.ok && !s.step.final) return void (await ctx.runMutation(unsafeRef<"mutation">("lib:actionDone"), done));
        const w = s.run;
        const mine: JournalEntry = r.ok ? { index, kind: "action", name: s.step.name, status: "done", result: r.value ?? null } : { index, kind: "action", name: s.step.name, status: "failed", error: r.error };
        const journal = w.journal.map((e) => (e.index === index ? mine : e));
        const outcome = await replayOnce(ctx, id, w, journal, w.stepCount);
        const args: { id: WId; index: number; result: StepResult; outcome?: Outcome; inline?: number } = { ...done };
        if (outcome) {
          args.outcome = outcome;
          if (1 < LOCAL_STEPS) args.inline = w.stepCount;
        }
        const entries = (await ctx.runMutation(unsafeRef<"mutation">("lib:actionDone"), args)) as JournalEntry[] | null;
        if (!entries) return;
        journal.push(...entries);
        await driveInline(ctx, id, w, journal, w.stepCount + entries.length, w.stepCount, 2);
      },
    }),

    /** The action step `index` to run and the run to replay after it, in one read (`ActionStep`). Null: stale. */
    actionStep: internalQuery({
      args: { id: v.id("workflows"), index: v.number() },
      handler: (ctx, { id, index }): ActionStep | null => {
        const w = ctx.db.get(id);
        if (!w || w.status !== "running" || index >= w.stepCount) return null;
        const rows = journalOf(ctx, id);
        const s = rows[index]?.index === index ? rows[index] : rows.find((x) => x.index === index);
        if (!s) return null;
        const run = loaded(w, rows.map(entryOf));
        if (s.status !== "pending") {
          const end = s.batchEnd ?? index + 1;
          return w.driving === end && w.stepCount >= end ? { resume: end, run } : null;
        }
        if (s.kind !== "action" || !inBatch(w, index)) return null;
        return { step: { fn: s.fn!, args: s.args, name: s.name, final: s.attempts + 1 >= (s.retry?.maxAttempts ?? 1) }, run };
      },
    }),

    /**
     * Records an action step's result. Final with `outcome` (the driver's replay with this result, the step being
     * the last of its batch still running): settles the step and advances to the next batch in this transaction,
     * returning the entries when its steps finished inline (see `execute`). Final without one: settles (the last one
     * of a batch schedules `lib:drive`). Attempts left: schedules the retry.
     */
    actionDone: internalMutation({
      args: { id: v.id("workflows"), index: v.number(), result: v.any(), outcome: v.optional(outcomeValidator), inline: v.optional(v.number()) },
      handler: (ctx, { id, index, result, outcome, inline }): JournalEntry[] | null => {
        const w = ctx.db.get(id);
        if (!w || w.status !== "running" || !inBatch(w, index)) return null;
        const s = stepAt(ctx, id, index);
        if (!s || s.status !== "pending") return null; // a duplicate delivery already recorded it
        const attempts = s.attempts + 1;
        const r = result as StepResult;
        if (!r.ok && attempts < (s.retry?.maxAttempts ?? 1)) {
          // Not final here (the action side thought it was only if another delivery raced it: its outcome is dropped).
          ctx.db.patch(s._id, { attempts, error: r.error });
          const retry = ctx.scheduler.runAfter(backoff(s.retry, attempts), "lib:runAction", { id, index });
          if (w.batchStart === undefined) ctx.db.patch(w._id, { pendingJob: retry });
          else ctx.db.patch(s._id, { job: retry });
          return null;
        }
        // The outcome counts only if it was replayed for this batch with every other step of it settled (a sibling
        // that was still running then makes the replay `waiting`: no outcome).
        if (outcome === undefined || inline !== w.stepCount || !lastPending(w)) return (settle(ctx, w, s, r, { attempts }), null);
        // The outcome was replayed with this very result (`final` only grows with attempts, so the action side's
        // final attempt is final here too). The step row and the next ones are written in this transaction.
        ctx.db.patch(s._id, settled(ctx, r, { attempts }));
        return advanceTo(ctx, w, w.stepCount, outcome as Outcome, inline);
      },
    }),

    /** A sleep is over, or a waitForEvent timed out. */
    wake: internalMutation({
      args: { id: v.id("workflows"), index: v.number() },
      handler: (ctx, { id, index }) => {
        const w = ctx.db.get(id);
        if (!w || w.status !== "running" || !inBatch(w, index)) return;
        const s = stepAt(ctx, id, index);
        if (!s || s.status !== "pending") return;
        if (s.kind === "sleep") settle(ctx, w, s, { ok: true, value: null });
        else if (s.kind === "event") settle(ctx, w, s, { ok: false, error: `timed out waiting for event ${s.event}` });
      },
    }),
  },
};

export const workflows = defineComponent({
  name: "workflows",
  schema,
  functions,
  config: v.optional(v.object({ maxSteps: v.optional(v.number()), retentionMs: v.optional(v.number()), failedRetentionMs: v.optional(v.number()) })),
});
