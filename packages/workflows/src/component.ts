// The workflows component (PLAN §8, §12): durable multi-step functions on the shard scheduler.
//
// Loop, per workflow (all in the shard where it was started):
//   lib:start (mutation, in the caller's transaction) ─ insert workflow, schedule lib:drive
//   lib:drive (action) ─ load journal → run the app's driver (replay, via a function handle) → lib:advance
//   lib:advance (mutation) ─ fenced by the step index: record the requested step and execute it:
//       query / mutation  → right here, in this transaction (exactly once with the journal) → schedule lib:drive
//       action            → schedule lib:runAction (at least once; retried with backoff) → lib:complete → drive
//       sleep             → schedule lib:wake at `until` → drive
//       event             → consume a buffered event, or wait for lib:sendEvent (timeout → lib:wake)
//   done / failed         → status, result, and the onComplete handle in the same transaction.
// Every scheduled job carries the step index it is for, so duplicate or stale jobs (action jobs are delivered at
// least once) are no-ops.

import { componentBuilders, defineComponent, defineSchema, defineTable, EmberError, v, type GenericId } from "@freecorps/ember-server";
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
type Ctx = any;

const DEFAULT_MAX_STEPS = 1000;

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

function load(ctx: Ctx, id: string) {
  const id2 = ctx.db.normalizeId("workflows", id);
  return id2 ? ctx.db.get(id2) : null;
}

function stepAt(ctx: Ctx, wf: WId, index: number) {
  return ctx.db.query("steps").withIndex("by_workflow", (q: any) => q.eq("workflow", wf).eq("index", index)).unique();
}

const backoff = (r: RetryPolicy | undefined, attempts: number) => (r?.initialBackoffMs ?? 1000) * (r?.base ?? 2) ** Math.max(0, attempts - 1);

const drive = (ctx: Ctx, id: WId, index: number) => ctx.scheduler.runAfter(0, "lib:drive", { id, index });

/** Finishes a workflow (status, result, onComplete in this transaction). */
function finish(ctx: Ctx, w: any, end: { status: "completed" | "failed" | "canceled"; result?: unknown; error?: string }) {
  const patch: Record<string, unknown> = { status: end.status, finishedAt: ctx.now, pendingJob: undefined };
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

/** Marks step `index` done/failed and lets the workflow continue. */
function settle(ctx: Ctx, w: any, s: any, r: { ok: true; value: unknown } | { ok: false; error: string }) {
  ctx.db.patch(s._id, r.ok ? { status: "done", result: r.value ?? null, completedAt: ctx.now } : { status: "failed", error: r.error, completedAt: ctx.now });
  if (w.pendingJob) ctx.db.patch(w._id, { pendingJob: undefined });
  drive(ctx, w._id, w.stepCount);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Records and executes the step the driver asked for. */
function execute(ctx: Ctx, w: any, index: number, req: StepRequest) {
  const row: Record<string, unknown> = { workflow: w._id, index, kind: req.kind, name: req.name, status: "pending", attempts: 0, startedAt: ctx.now };
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
  const sid = ctx.db.insert("steps", row);
  ctx.db.patch(w._id, { stepCount: index + 1 });
  const wf = { ...w, stepCount: index + 1 };
  const s = { _id: sid, ...row };
  switch (req.kind) {
    case "query":
    case "mutation": {
      // Same transaction as the journal entry: a mutation step commits exactly once. A failure is undone
      // (savepoint) and recorded; the handler sees it as a rejected step.
      let r: { ok: true; value: unknown } | { ok: false; error: string };
      try {
        r = { ok: true, value: req.kind === "query" ? ctx.runQuery(req.fn, req.args) : ctx.runMutation(req.fn, req.args) };
      } catch (e) {
        r = { ok: false, error: message(e) };
      }
      ctx.db.patch(sid, { attempts: 1 });
      settle(ctx, wf, s, r);
      return;
    }
    case "action":
      ctx.db.patch(w._id, { pendingJob: ctx.scheduler.runAfter(0, "lib:runAction", { id: w._id, index }) });
      return;
    case "sleep":
      ctx.db.patch(w._id, { pendingJob: ctx.scheduler.runAt(Math.max(ctx.now, row.runAt as number), "lib:wake", { id: w._id, index }) });
      return;
    case "event": {
      const buffered = ctx.db.query("events").withIndex("by_workflow", (q: any) => q.eq("workflow", w._id).eq("event", req.event)).first();
      if (buffered) {
        ctx.db.delete(buffered._id);
        settle(ctx, wf, s, { ok: true, value: buffered.payload ?? null });
      } else if (req.timeoutMs !== undefined) {
        ctx.db.patch(w._id, { pendingJob: ctx.scheduler.runAfter(req.timeoutMs, "lib:wake", { id: w._id, index }) });
      }
      return;
    }
  }
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

    /** Deletes a finished workflow and its journal. False if it is still running (or unknown). */
    cleanup: mutation({
      args: { id: v.string() },
      returns: v.boolean(),
      handler: (ctx, { id }) => {
        const w = load(ctx, id);
        if (!w || w.status === "running") return false;
        for (const s of ctx.db.query("steps").withIndex("by_workflow", (q) => q.eq("workflow", w._id)).collect()) ctx.db.delete(s._id);
        for (const e of ctx.db.query("events").withIndex("by_workflow", (q) => q.eq("workflow", w._id)).collect()) ctx.db.delete(e._id);
        ctx.db.delete(w._id);
        return true;
      },
    }),

    // ---------------------------------------------------------------------------------------- internal loop

    load: internalQuery({
      args: { id: v.id("workflows") },
      handler: (ctx, { id }) => {
        const w = ctx.db.get(id);
        if (!w) return null;
        const journal: JournalEntry[] = ctx.db
          .query("steps")
          .withIndex("by_workflow", (q) => q.eq("workflow", id))
          .collect()
          .map((s) => ({ index: s.index, kind: s.kind, name: s.name, status: s.status, ...(s.result !== undefined ? { result: s.result } : {}), ...(s.error !== undefined ? { error: s.error } : {}) }));
        return { status: w.status, driver: w.driver, args: w.args, stepCount: w.stepCount, journal };
      },
    }),

    /** Replays the app's driver and hands the outcome to `advance`. `index`: the step count this run is for. */
    drive: internalAction({
      args: { id: v.id("workflows"), index: v.number() },
      handler: async (ctx, { id, index }) => {
        const w = (await ctx.runQuery("lib:load" as any, { id })) as { status: string; driver: string; args: unknown; stepCount: number; journal: JournalEntry[] } | null;
        if (!w || w.status !== "running" || w.stepCount !== index) return; // stale or duplicate
        let outcome: Outcome;
        try {
          outcome = (await ctx.runAction(w.driver as any, { workflowId: id, args: w.args, journal: w.journal })) as Outcome;
        } catch (e) {
          outcome = { type: "failed", error: `driver: ${message(e)}` };
        }
        if (!outcome || typeof outcome !== "object") outcome = { type: "failed", error: `driver returned an invalid outcome: ${show(outcome)}` };
        if (outcome.type === "waiting") return;
        await ctx.runMutation("lib:advance" as any, { id, index, outcome });
      },
    }),

    advance: internalMutation({
      args: { id: v.id("workflows"), index: v.number(), outcome: outcomeValidator },
      handler: (ctx, { id, index, outcome }) => {
        const w = ctx.db.get(id);
        if (!w || w.status !== "running" || w.stepCount !== index) return; // fenced: another run got here first
        const o = outcome as Outcome;
        if (o.type === "done") return finish(ctx, w, { status: "completed", result: o.result ?? null });
        if (o.type === "failed") return finish(ctx, w, { status: "failed", error: o.error });
        // A replay() driver always asks for step `index` (= the journal length, fenced above). Anything else
        // comes from a driver that is not one (any handle can be passed to start): fail loudly rather than
        // return with no job scheduled, which would leave the workflow "running" forever.
        if (o.type !== "step" || o.index !== index || !o.step || !STEP_KINDS.has(o.step.kind)) {
          return finish(ctx, w, { status: "failed", error: `InvalidOutcome: the driver returned ${show(o)} for step ${index} (expected a step request with index ${index}, done or failed)` });
        }
        if (index >= w.maxSteps) return finish(ctx, w, { status: "failed", error: `workflow exceeded ${w.maxSteps} steps` });
        execute(ctx, w, index, o.step);
      },
    }),

    /** Runs an action step (at least once), then records it. */
    runAction: internalAction({
      args: { id: v.id("workflows"), index: v.number() },
      handler: async (ctx, { id, index }) => {
        const s = (await ctx.runQuery("lib:pendingStep" as any, { id, index })) as { fn: string; args: unknown } | null;
        if (!s) return;
        let r: { ok: true; value: unknown } | { ok: false; error: string };
        try {
          r = { ok: true, value: await ctx.runAction(s.fn as any, s.args ?? {}) };
        } catch (e) {
          r = { ok: false, error: message(e) };
        }
        await ctx.runMutation("lib:actionDone" as any, { id, index, result: r });
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
        const r = result as { ok: true; value: unknown } | { ok: false; error: string };
        if (!r.ok && attempts < (s.retry?.maxAttempts ?? 1)) {
          ctx.db.patch(s._id, { attempts, error: r.error });
          ctx.db.patch(w._id, { pendingJob: ctx.scheduler.runAfter(backoff(s.retry, attempts), "lib:runAction", { id, index }) });
          return;
        }
        ctx.db.patch(s._id, { attempts });
        settle(ctx, w, s, r);
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
