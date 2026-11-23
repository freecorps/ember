// The workflows component (PLAN §8, §12): durable multi-step functions on the shard scheduler.
//
// Loop, per workflow (all in the shard where it was started):
//   lib:start (mutation, in the caller's transaction) ─ insert workflow, schedule lib:drive
//   lib:drive (action) ─ load journal → run the app's driver (replay, via a function handle) → lib:advance
//   lib:advance (mutation) ─ fenced by the step index: record the requested step and execute it:
//       query / mutation  → right here, in this transaction (exactly once with the journal); advance hands the
//                           finished entry back and the same drive run replays again (up to LOCAL_STEPS steps,
//                           then it schedules lib:drive)
//       action            → schedule lib:runAction (at least once; retried with backoff) → lib:complete → drive
//       sleep             → schedule lib:wake at `until` → drive
//       event             → consume a buffered event, or wait for lib:sendEvent (timeout → lib:wake)
//   done / failed         → status, result, and the onComplete handle in the same transaction.
// Every scheduled job carries the step index it is for, so duplicate or stale jobs (action jobs are delivered at
// least once) are no-ops. A drive run that continues inline writes `driving` (its job's index) in the same patch as
// the step count; a retry of that job after a crash mid-loop resumes from the step count instead of stalling.

import { componentBuilders, defineComponent, defineSchema, defineTable, EmberError, unsafeRef, v, type ComponentCtx, type DataModelFromSchema, type GenericId, type WithoutSystemFields } from "@freecorps/ember-server";
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
    }).index("by_status", ["status"]),
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
    })
      .index("by_workflow", ["workflow", "index"])
      .index("by_event", ["workflow", "status", "event"]),
    /** Events sent before the workflow waits for them. */
    events: defineTable({ workflow: v.id("workflows"), event: v.string(), payload: v.optional(v.any()) }).index("by_workflow", ["workflow", "event"]),
  },
});

export type WorkflowsInstallConfig = {
  /** Steps per workflow before it fails (runaway loops; each step replays the journal). Default 1000. */
  maxSteps?: number;
};

const { query, mutation, internalMutation, internalQuery, internalAction } = componentBuilders<typeof schema, WorkflowsInstallConfig | undefined>();

type WId = GenericId<"workflows">;
type Ctx = ComponentCtx<typeof schema, WorkflowsInstallConfig | undefined>["mutation"];
type ReadCtx = ComponentCtx<typeof schema, WorkflowsInstallConfig | undefined>["query"];

const DEFAULT_MAX_STEPS = 1000;
/**
 * Synchronous steps (query, mutation, buffered event) one `lib:drive` run advances before it hands over to a new
 * job: each saves a Queue job, a Worker invocation and a journal read; the bound keeps one run short.
 */
export const LOCAL_STEPS = 16;
/** Rows `cleanup` deletes per transaction; the rest goes to `lib:cleanupRest` jobs. */
export const CLEANUP_BATCH = 200;

export type WorkflowStatus = {
  status: "running" | "completed" | "failed" | "canceled";
  result?: unknown;
  error?: string;
  stepCount: number;
  /** The step being executed / waited on, when running. */
  current?: { index: number; kind: string; name: string; attempts: number; runAt?: number };
  startedAt: number;
  finishedAt?: number;
};

function load(ctx: ReadCtx, id: string) {
  const id2 = ctx.db.normalizeId("workflows", id);
  return id2 ? ctx.db.get(id2) : null;
}

function stepAt(ctx: ReadCtx, wf: WId, index: number) {
  return ctx.db.query("steps").withIndex("by_workflow", (q) => q.eq("workflow", wf).eq("index", index)).unique();
}

const backoff = (r: RetryPolicy | undefined, attempts: number) => (r?.initialBackoffMs ?? 1000) * (r?.base ?? 2) ** Math.max(0, attempts - 1);

const drive = (ctx: Ctx, id: WId, index: number) => ctx.scheduler.runAfter(0, "lib:drive", { id, index });

/** Finishes a workflow (status, result, onComplete in this transaction). */
function finish(ctx: Ctx, w: any, end: { status: "completed" | "failed" | "canceled"; result?: unknown; error?: string }) {
  const patch: Record<string, unknown> = { status: end.status, finishedAt: ctx.now, pendingJob: undefined };
  if (w.driving !== undefined) patch.driving = undefined;
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
}

type StepResult = { ok: true; value: unknown } | { ok: false; error: string };

/** The fields that settle a step (`extra`: more fields for the same write). */
const settled = (ctx: Ctx, r: StepResult, extra: Record<string, unknown> = {}) =>
  r.ok ? { ...extra, status: "done" as const, result: r.value ?? null, completedAt: ctx.now } : { ...extra, status: "failed" as const, error: r.error, completedAt: ctx.now };

/**
 * Marks a waiting step (action, sleep, event) done/failed in one write and lets the workflow continue. The
 * workflow's `pendingJob` (the job that just ran, or a cancelled timeout) is left as is: cancelling a finished job is
 * a no-op, and the next step's write replaces it.
 */
function settle(ctx: Ctx, w: any, s: any, r: StepResult, extra?: Record<string, unknown>) {
  ctx.db.patch(s._id, settled(ctx, r, extra));
  drive(ctx, w._id, w.stepCount);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Records and executes the step the driver asked for. */
type StepRow = WithoutSystemFields<DataModelFromSchema<typeof schema>["steps"]["document"]>;

const entryOf = (s: StepRow): JournalEntry => ({ index: s.index, kind: s.kind, name: s.name, status: s.status, ...(s.result !== undefined ? { result: s.result } : {}), ...(s.error !== undefined ? { error: s.error } : {}) });

/**
 * Records step `index` and executes it: one insert for the step (already settled when it runs here) and one patch
 * for the workflow. Returns the journal entry when the step finished in this transaction and `inline` (the index of
 * the drive job running inline) is given: the caller replays on with it, and no `lib:drive` job is scheduled.
 */
function execute(ctx: Ctx, w: any, index: number, req: StepRequest, inline: number | undefined): JournalEntry | null {
  const row: StepRow = { workflow: w._id, index, kind: req.kind, name: req.name, status: "pending", attempts: 0, startedAt: ctx.now };
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
      job = ctx.scheduler.runAfter(0, "lib:runAction", { id: w._id, index });
      break;
    case "sleep":
      job = ctx.scheduler.runAt(Math.max(ctx.now, row.runAt as number), "lib:wake", { id: w._id, index });
      break;
    case "event": {
      const buffered = ctx.db.query("events").withIndex("by_workflow", (q) => q.eq("workflow", w._id).eq("event", req.event)).first();
      if (buffered) {
        ctx.db.delete(buffered._id);
        result = { ok: true, value: buffered.payload ?? null };
      } else if (req.timeoutMs !== undefined) {
        job = ctx.scheduler.runAfter(req.timeoutMs, "lib:wake", { id: w._id, index });
      }
      break;
    }
  }
  const full: StepRow = result ? { ...row, ...settled(ctx, result) } : row;
  ctx.db.insert("steps", full);
  const continues = result !== null && inline !== undefined;
  const patch: Record<string, unknown> = { stepCount: index + 1 };
  if (job !== undefined) patch.pendingJob = job;
  else if (w.pendingJob !== undefined) patch.pendingJob = undefined; // the previous step's job, already run
  if (continues) {
    if (w.driving !== inline) patch.driving = inline;
  } else if (w.driving !== undefined) patch.driving = undefined;
  ctx.db.patch(w._id, patch);
  if (result === null) return null;
  if (continues) return entryOf(full);
  drive(ctx, w._id, index + 1);
  return null;
}

/** Deletes up to CLEANUP_BATCH journal rows of `wf`; schedules `lib:cleanupRest` when more are left. */
function deleteJournal(ctx: Ctx, wf: WId) {
  let budget = CLEANUP_BATCH;
  for (const s of ctx.db.query("steps").withIndex("by_workflow", (q) => q.eq("workflow", wf)).take(budget)) {
    ctx.db.delete(s._id);
    budget--;
  }
  if (budget > 0) {
    for (const e of ctx.db.query("events").withIndex("by_workflow", (q) => q.eq("workflow", wf)).take(budget)) {
      ctx.db.delete(e._id);
      budget--;
    }
  }
  if (budget === 0) ctx.scheduler.runAfter(0, "lib:cleanupRest", { id: wf });
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
          const s = stepAt(ctx, w._id, w.stepCount - 1);
          if (s && s.status === "pending") out.current = { index: s.index, kind: s.kind, name: s.name, attempts: s.attempts, ...(s.runAt !== undefined ? { runAt: s.runAt } : {}) };
        }
        return out;
      },
    }),

    /** The journal (for dashboards and debugging). */
    steps: query({
      args: { id: v.string() },
      handler: (ctx, { id }) => {
        const w = load(ctx, id);
        if (!w) return [];
        return ctx.db.query("steps").withIndex("by_workflow", (q) => q.eq("workflow", w._id)).collect()
          .map((s) => ({ index: s.index, kind: s.kind, name: s.name, status: s.status, attempts: s.attempts, result: s.result, error: s.error, startedAt: s.startedAt, completedAt: s.completedAt }));
      },
    }),

    /** Delivers an event: completes a waiting `waitForEvent`, or buffers it. False if the workflow is not running. */
    sendEvent: mutation({
      args: { id: v.string(), event: v.string(), payload: v.optional(v.any()) },
      returns: v.boolean(),
      handler: (ctx, a) => {
        const w = load(ctx, a.id);
        if (!w || w.status !== "running") return false;
        const waiting = ctx.db.query("steps").withIndex("by_event", (q) => q.eq("workflow", w._id).eq("status", "pending").eq("event", a.event)).first();
        if (waiting) {
          if (w.pendingJob) ctx.scheduler.cancel(w.pendingJob); // the timeout
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
        const journal: JournalEntry[] = ctx.db
          .query("steps")
          .withIndex("by_workflow", (q) => q.eq("workflow", id))
          .collect()
          .map(entryOf);
        return { status: w.status, driver: w.driver, args: w.args, stepCount: w.stepCount, journal, ...(w.driving !== undefined ? { driving: w.driving } : {}) };
      },
    }),

    /**
     * Replays the app's driver and hands the outcome to `advance`. `index`: the step count this run is for. Steps
     * that finish inside `advance` (query, mutation, buffered event) come back as journal entries and the run replays
     * again, up to LOCAL_STEPS of them; the last one schedules a new drive job.
     */
    drive: internalAction({
      args: { id: v.id("workflows"), index: v.number() },
      handler: async (ctx, { id, index }) => {
        const w = (await ctx.runQuery(unsafeRef<any>("lib:load"), { id })) as { status: string; driver: string; args: unknown; stepCount: number; journal: JournalEntry[]; driving?: number } | null;
        if (!w || w.status !== "running") return;
        // Stale or duplicate, unless this job's own run advanced inline before it died (the job is retried with the
        // same index): then it resumes from the step count.
        if (w.stepCount !== index && w.driving !== index) return;
        const journal = w.journal;
        let at = w.stepCount;
        for (let n = 1; ; n++) {
          let outcome: Outcome;
          try {
            outcome = (await ctx.runAction(w.driver as any, { workflowId: id, args: w.args, journal })) as Outcome;
          } catch (e) {
            outcome = { type: "failed", error: `driver: ${message(e)}` };
          }
          if (!outcome || typeof outcome !== "object") outcome = { type: "failed", error: `driver returned an invalid outcome: ${show(outcome)}` };
          // "waiting" is only legitimate while a journaled step is still pending (sleep, event, action in flight):
          // that step's completion drives the workflow on. Otherwise nothing would ever run it again.
          if (outcome.type === "waiting") {
            if (journal.some((s) => s.status === "pending")) return;
            outcome = { type: "failed", error: `InvalidOutcome: the driver returned "waiting" for step ${at} but no step is pending` };
          }
          const args: { id: WId; index: number; outcome: Outcome; inline?: number } = { id, index: at, outcome };
          if (n < LOCAL_STEPS) args.inline = index;
          const entry = (await ctx.runMutation(unsafeRef<any>("lib:advance"), args)) as JournalEntry | null;
          if (!entry) return; // finished, waiting on a job, scheduled the next drive, or fenced out
          journal.push(entry);
          at++;
        }
      },
    }),

    advance: internalMutation({
      args: { id: v.id("workflows"), index: v.number(), outcome: outcomeValidator, inline: v.optional(v.number()) },
      handler: (ctx, { id, index, outcome, inline }): JournalEntry | null => {
        const w = ctx.db.get(id);
        if (!w || w.status !== "running" || w.stepCount !== index) return null; // fenced: another run got here first
        const o = outcome as Outcome;
        if (o.type === "done") return (finish(ctx, w, { status: "completed", result: o.result ?? null }), null);
        if (o.type === "failed") return (finish(ctx, w, { status: "failed", error: o.error }), null);
        // A replay() driver always asks for step `index` (= the journal length, fenced above). Anything else
        // comes from a driver that is not one (any handle can be passed to start): fail loudly rather than
        // return with no job scheduled, which would leave the workflow "running" forever.
        if (o.type !== "step" || o.index !== index || !o.step || !STEP_KINDS.has(o.step.kind)) {
          finish(ctx, w, { status: "failed", error: `InvalidOutcome: the driver returned ${show(o)} for step ${index} (expected a step request with index ${index}, done or failed)` });
          return null;
        }
        if (index >= w.maxSteps) return (finish(ctx, w, { status: "failed", error: `workflow exceeded ${w.maxSteps} steps` }), null);
        return execute(ctx, w, index, o.step, inline);
      },
    }),

    /** Runs an action step (at least once), then records it. */
    runAction: internalAction({
      args: { id: v.id("workflows"), index: v.number() },
      handler: async (ctx, { id, index }) => {
        const s = (await ctx.runQuery(unsafeRef<any>("lib:pendingStep"), { id, index })) as { fn: string; args: unknown } | null;
        if (!s) return;
        let r: StepResult;
        try {
          r = { ok: true, value: await ctx.runAction(s.fn as any, s.args ?? {}) };
        } catch (e) {
          r = { ok: false, error: message(e) };
        }
        await ctx.runMutation(unsafeRef<any>("lib:actionDone"), { id, index, result: r });
      },
    }),

    pendingStep: internalQuery({
      args: { id: v.id("workflows"), index: v.number() },
      handler: (ctx, { id, index }) => {
        const w = ctx.db.get(id);
        if (!w || w.status !== "running" || w.stepCount !== index + 1) return null;
        const s = stepAt(ctx, id, index);
        return s && s.status === "pending" && s.kind === "action" ? { fn: s.fn!, args: s.args } : null;
      },
    }),

    actionDone: internalMutation({
      args: { id: v.id("workflows"), index: v.number(), result: v.any() },
      handler: (ctx, { id, index, result }) => {
        const w = ctx.db.get(id);
        if (!w || w.status !== "running" || w.stepCount !== index + 1) return;
        const s = stepAt(ctx, id, index);
        if (!s || s.status !== "pending") return; // a duplicate delivery already recorded it
        const attempts = s.attempts + 1;
        const r = result as StepResult;
        if (!r.ok && attempts < (s.retry?.maxAttempts ?? 1)) {
          ctx.db.patch(s._id, { attempts, error: r.error });
          ctx.db.patch(w._id, { pendingJob: ctx.scheduler.runAfter(backoff(s.retry, attempts), "lib:runAction", { id, index }) });
          return;
        }
        settle(ctx, w, s, r, { attempts });
      },
    }),

    /** A sleep is over, or a waitForEvent timed out. */
    wake: internalMutation({
      args: { id: v.id("workflows"), index: v.number() },
      handler: (ctx, { id, index }) => {
        const w = ctx.db.get(id);
        if (!w || w.status !== "running" || w.stepCount !== index + 1) return;
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
  config: v.optional(v.object({ maxSteps: v.optional(v.number()) })),
});
