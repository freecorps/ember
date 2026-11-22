// The workpool component (PLAN §12, §22 L11): bounded parallelism for actions and mutations, on the shard scheduler.
//
// One install is one pool; its tables live in the caller's shard, so the cap is per pool *per shard*.
//
//   lib:enqueue (mutation, in the caller's transaction) ─ insert pending items, then pump
//   pump ─ while running < maxParallelism: the head of the queue (priority, then FIFO) becomes running and gets a job
//       action item   → job lib:run (an action under the scheduler's lease: at least once) → lib:complete (fenced)
//       mutation item → job lib:runMutation: the work, its result and onComplete in one transaction (exactly once)
//   settle ─ success / final failure / cancel: status, result, totals and the onComplete handle in that transaction,
//       then pump again; a failure with attempts left keeps the slot and schedules the next attempt after a backoff.
//   lib:tick (a mutation job, while the pool has work or retained results) ─ reclaims running items whose job is gone
//       (finished without reporting, failed, vanished): the slot never leaks; deletes results past retentionMs.
//
// Every run job carries the attempt it is for; `attempts` on the item is the fence, so duplicate deliveries and late
// reports of an older attempt are no-ops.

import {
  componentBuilders,
  defineComponent,
  defineSchema,
  defineTable,
  EmberError,
  unsafeRef,
  v,
  type ComponentCtx,
  type DataModelFromSchema,
  type GenericId,
} from "@freecorps/ember-server";

// ---------------------------------------------------------------------------------------------------- shapes

export const retryValidator = v.object({ maxAttempts: v.number(), initialBackoffMs: v.number(), base: v.number() });

/** What `onComplete` receives as `result`. */
export const vResultValidator = v.union(
  v.object({ kind: v.literal("success"), returnValue: v.any() }),
  v.object({ kind: v.literal("failed"), error: v.string() }),
  v.object({ kind: v.literal("canceled") }),
);

const status = v.union(v.literal("pending"), v.literal("running"), v.literal("success"), v.literal("failed"), v.literal("canceled"));
const FINISHED = ["success", "failed", "canceled"] as const;

const totals = v.object({
  enqueued: v.number(),
  succeeded: v.number(),
  failed: v.number(),
  canceled: v.number(),
  /** Attempts scheduled after a failure. */
  retries: v.number(),
  /** Running items whose job was gone (finished without reporting, failed or vanished), counted as a failed attempt. */
  reclaimed: v.number(),
});

const schema = defineSchema({
  tables: {
    work: defineTable({
      kind: v.union(v.literal("action"), v.literal("mutation")),
      /** Function handle of the work (`&mod:fn`). */
      fn: v.string(),
      args: v.any(),
      status,
      /** `-priority`: the queue index is ascending, higher priority first. */
      rank: v.number(),
      /** Enqueue order in this pool (FIFO within a priority). */
      seq: v.number(),
      /** Attempts started or scheduled (the fence of run jobs and reports). */
      attempts: v.number(),
      retry: v.optional(retryValidator),
      onComplete: v.optional(v.string()),
      context: v.optional(v.any()),
      key: v.optional(v.string()),
      /** The job of the current attempt. */
      job: v.optional(v.string()),
      /** When the current attempt's job is due (a retry waits for its backoff). */
      attemptAt: v.optional(v.number()),
      cancelRequested: v.optional(v.boolean()),
      lastError: v.optional(v.string()),
      result: v.optional(vResultValidator),
      onCompleteError: v.optional(v.string()),
      enqueuedAt: v.number(),
      startedAt: v.optional(v.number()),
      finishedAt: v.optional(v.number()),
    })
      .index("by_queue", ["status", "rank", "seq"])
      .index("by_key", ["key"])
      .index("by_finished", ["status", "finishedAt"])
      .aggregate("by_status", { by: ["status", "rank"] }),
    /** One row: the settings a `Workpool` helper sent (the last enqueue wins over the install config), counters, tick. */
    pool: defineTable({
      maxParallelism: v.optional(v.number()),
      retentionMs: v.optional(v.number()),
      reclaimIntervalMs: v.optional(v.number()),
      nextSeq: v.number(),
      /** `cancelAll` cancels every item enqueued before this seq (pump never starts one). */
      cancelBefore: v.number(),
      tickAt: v.optional(v.number()),
      tickJob: v.optional(v.string()),
      totals,
    }),
  },
});

export type RetryBehavior = { maxAttempts: number; initialBackoffMs: number; base: number };
export type WorkResult<R = unknown> = { kind: "success"; returnValue: R } | { kind: "failed"; error: string } | { kind: "canceled" };

export type WorkpoolInstallConfig = {
  /** Items running at once in this pool, per shard (default 10). Overridden by `new Workpool(..., { maxParallelism })`. */
  maxParallelism?: number;
  /** How long finished items (status, result) are kept (default 1 day; 0 = deleted right after onComplete). */
  retentionMs?: number;
  /** How often a pool with running items checks for lost jobs (default 60 s). */
  reclaimIntervalMs?: number;
};

export type WorkStatus =
  | { state: "pending"; /** Items ahead of this one (counted up to MAX_POSITION). */ position: number }
  | { state: "running"; attempt: number; /** Set while a retry waits for its backoff. */ retryAt?: number; lastError?: string; cancelRequested?: true }
  | { state: "finished"; result: WorkResult };

export type WorkpoolStats = {
  pending: number;
  running: number;
  /** Finished items still retained, by outcome. */
  finished: { success: number; failed: number; canceled: number };
  maxParallelism: number;
  /** Since the pool was created in this shard. */
  totals: { enqueued: number; succeeded: number; failed: number; canceled: number; retries: number; reclaimed: number };
};

export const DEFAULT_MAX_PARALLELISM = 10;
export const MAX_PARALLELISM_LIMIT = 1000;
export const DEFAULT_RETENTION_MS = 24 * 60 * 60_000;
export const DEFAULT_RECLAIM_INTERVAL_MS = 60_000;
/** `status().position` counts at most this many items ahead in the same priority. */
export const MAX_POSITION = 1000;
/** Default retry behavior for `retry: true`. */
export const DEFAULT_RETRY: RetryBehavior = { maxAttempts: 5, initialBackoffMs: 250, base: 2 };
/**
 * Lease of `lib:run` (the job an action item runs in): a run handed to the Queue that is not finished after this long
 * is run again by the shard. 15 minutes is the longest a Worker invocation may run, so a live run is never duplicated
 * by its lease; a crashed one is retried after it.
 */
export const RUN_LEASE_MS = 15 * 60_000;
const ENQUEUE_MAX = 1000;
const CANCEL_PAGE = 200;
const GC_BATCH = 500;
const PUMP_BUDGET = 200;
/** A tick due this long ago that never ran is considered lost (a new one is scheduled). */
const STALE_TICK_MS = 10 * 60_000;

const { query, mutation, internalMutation, internalQuery, internalAction } = componentBuilders<typeof schema, WorkpoolInstallConfig | undefined>();

type DM = DataModelFromSchema<typeof schema>;
type Work = DM["work"]["document"];
type Pool = DM["pool"]["document"];
type WId = GenericId<"work">;
type Ctx = ComponentCtx<typeof schema, WorkpoolInstallConfig | undefined>["mutation"];
type ReadCtx = ComponentCtx<typeof schema, WorkpoolInstallConfig | undefined>["query"];

/** What a run reports. */
export type RunOutcome = { ok: true; value: unknown } | { ok: false; error: string } | { canceled: true };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const bad = (m: string): never => {
  throw new EmberError("ValidationError", `workpool: ${m}`);
};

function checkRetry(r: RetryBehavior): RetryBehavior {
  if (!Number.isInteger(r.maxAttempts) || r.maxAttempts < 1) bad("retry.maxAttempts must be an integer >= 1");
  if (!Number.isFinite(r.initialBackoffMs) || r.initialBackoffMs < 0) bad("retry.initialBackoffMs must be >= 0");
  if (!Number.isFinite(r.base) || r.base < 1) bad("retry.base must be >= 1");
  return { maxAttempts: r.maxAttempts, initialBackoffMs: r.initialBackoffMs, base: r.base };
}

const positiveInt = (n: number | undefined, what: string, max: number) => {
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > max)) bad(`${what} must be an integer in 1..${max}`);
  return n;
};
const nonNegative = (n: number | undefined, what: string) => {
  if (n !== undefined && (!Number.isFinite(n) || n < 0)) bad(`${what} must be >= 0`);
  return n;
};

// ---------------------------------------------------------------------------------------------------- pool row

function readPool(ctx: ReadCtx): Pool | null {
  return ctx.db.query("pool").first();
}

const ZERO = { enqueued: 0, succeeded: 0, failed: 0, canceled: 0, retries: 0, reclaimed: 0 };

function pool(ctx: Ctx): Pool {
  const p = readPool(ctx);
  if (p) return p;
  const id = ctx.db.insert("pool", {
    nextSeq: 0,
    cancelBefore: 0,
    totals: { ...ZERO },
  });
  return ctx.db.get(id)!;
}

type Settings = { maxParallelism: number; retentionMs: number; reclaimIntervalMs: number };
const DAY_MS = 24 * 60 * 60_000;

/** Effective settings: what a helper sent last, else the install config (read now: a redeploy applies), else defaults. */
function settingsOf(ctx: ReadCtx, p: Pool | null): Settings {
  const cfg = ctx.component.config;
  return {
    maxParallelism: p?.maxParallelism ?? positiveInt(cfg?.maxParallelism, "config.maxParallelism", MAX_PARALLELISM_LIMIT) ?? DEFAULT_MAX_PARALLELISM,
    retentionMs: p?.retentionMs ?? nonNegative(cfg?.retentionMs, "config.retentionMs") ?? DEFAULT_RETENTION_MS,
    reclaimIntervalMs: p?.reclaimIntervalMs ?? positiveInt(cfg?.reclaimIntervalMs, "config.reclaimIntervalMs", DAY_MS) ?? DEFAULT_RECLAIM_INTERVAL_MS,
  };
}

function bump(ctx: Ctx, field: keyof Pool["totals"], n = 1) {
  const p = pool(ctx);
  ctx.db.patch(p._id, { totals: { ...p.totals, [field]: p.totals[field] + n } });
}

/** Keeps one tick scheduled at or before `at`. */
function ensureTick(ctx: Ctx, at: number) {
  const p = pool(ctx);
  if (p.tickAt !== undefined && p.tickAt <= at && p.tickAt > ctx.now - STALE_TICK_MS) return;
  if (p.tickJob) ctx.scheduler.cancel(p.tickJob);
  const when = Math.max(at, ctx.now);
  ctx.db.patch(p._id, { tickAt: when, tickJob: ctx.scheduler.runAt(when, "lib:tick", {}) });
}

// ---------------------------------------------------------------------------------------------------- queue

const count = (ctx: ReadCtx, s: Work["status"]) => ctx.db.aggregate("work", "by_status").range((q) => q.eq("status", s)).reduce((n, g) => n + g.count, 0);

function startItem(ctx: Ctx, w: Work, set: Settings) {
  const attempt = w.attempts + 1;
  const job = ctx.scheduler.runAfter(0, w.kind === "action" ? "lib:run" : "lib:runMutation", { id: w._id, attempt });
  ctx.db.patch(w._id, { status: "running", attempts: attempt, job, attemptAt: ctx.now, ...(w.startedAt === undefined ? { startedAt: ctx.now } : {}) });
  ensureTick(ctx, ctx.now + set.reclaimIntervalMs);
}

/** Starts queued items while there is room (a canceled-by-cancelAll head is finished instead). */
function pump(ctx: Ctx) {
  // As many heads as there are free slots, in one read; starting one changes nothing the next depends on. A canceled
  // head's onComplete may enqueue (and pump) or change the settings: everything is read again after one.
  for (let budget = PUMP_BUDGET; budget > 0; ) {
    const p = pool(ctx);
    const set = settingsOf(ctx, p);
    const room = set.maxParallelism - count(ctx, "running");
    if (room <= 0) return;
    const heads = ctx.db.query("work").withIndex("by_queue", (q) => q.eq("status", "pending")).take(Math.min(room, budget));
    if (!heads.length) return;
    for (const head of heads) {
      budget--;
      if (head.seq < p.cancelBefore) {
        finish(ctx, head, { kind: "canceled" });
        break;
      }
      startItem(ctx, head, set);
    }
  }
}

/** The item is done: status, result, totals and onComplete in this transaction. Does not pump. */
function finish(ctx: Ctx, w: Work, result: WorkResult) {
  ctx.db.patch(w._id, { status: result.kind, result, finishedAt: ctx.now, job: undefined, attemptAt: undefined, cancelRequested: undefined });
  bump(ctx, result.kind === "success" ? "succeeded" : result.kind === "failed" ? "failed" : "canceled");
  if (w.onComplete) {
    // In a savepoint: a failing callback is undone and recorded; the item stays finished and its slot is freed.
    try {
      ctx.runMutation(unsafeRef<"mutation">(w.onComplete), { workId: w._id, context: w.context ?? null, result });
    } catch (e) {
      console.error(`workpool ${ctx.component.name}: onComplete of ${w._id} failed: ${message(e)}`);
      ctx.db.patch(w._id, { onCompleteError: message(e) });
    }
  }
  const { retentionMs } = settingsOf(ctx, pool(ctx));
  if (retentionMs === 0) ctx.db.delete(w._id);
  else ensureTick(ctx, ctx.now + retentionMs);
}

function backoff(ctx: Ctx, r: RetryBehavior, failures: number) {
  const d = r.initialBackoffMs * r.base ** Math.max(0, failures - 1);
  // ±25% jitter, so items that failed together do not retry together.
  return Math.round(d * (0.75 + 0.5 * ctx.random()));
}

/** The outcome of the running attempt of `w` (already fenced). Pumps. */
function settle(ctx: Ctx, w: Work, o: RunOutcome) {
  if (w.cancelRequested || "canceled" in o) finish(ctx, w, { kind: "canceled" });
  else if (o.ok) finish(ctx, w, { kind: "success", returnValue: o.value ?? null });
  else if (w.retry && w.attempts < w.retry.maxAttempts) {
    const at = ctx.now + backoff(ctx, w.retry, w.attempts);
    const attempt = w.attempts + 1;
    const job = ctx.scheduler.runAt(at, w.kind === "action" ? "lib:run" : "lib:runMutation", { id: w._id, attempt });
    ctx.db.patch(w._id, { attempts: attempt, job, attemptAt: at, lastError: o.error });
    bump(ctx, "retries");
  } else {
    ctx.db.patch(w._id, { lastError: o.error });
    finish(ctx, w, { kind: "failed", error: o.error });
  }
  pump(ctx);
}

function load(ctx: ReadCtx, id: string): Work | null {
  const n = ctx.db.normalizeId("work", id);
  return n ? ctx.db.get(n) : null;
}

/** The running attempt `attempt` of item `id`, or null (finished, canceled, an older attempt: stale or duplicate). */
function fenced(ctx: ReadCtx, id: WId, attempt: number): Work | null {
  const w = ctx.db.get(id);
  return w && w.status === "running" && w.attempts === attempt ? w : null;
}

function cancelItem(ctx: Ctx, id: WId): boolean {
  // Fresh: an earlier cancel's onComplete may have changed this item.
  const w = ctx.db.get(id);
  if (!w) return false;
  if (w.status === "pending") {
    finish(ctx, w, { kind: "canceled" });
    return true;
  }
  if (w.status !== "running") return false;
  if (w.cancelRequested) return true;
  const job = w.job ? ctx.scheduler.get(w.job) : null;
  if (job && job.state.kind === "inProgress") {
    // An action in flight cannot be stopped: it keeps its slot until it reports, and then finishes as canceled.
    ctx.db.patch(w._id, { cancelRequested: true });
    return true;
  }
  // Not started (or waiting for a retry): the job is cancelled; a run that starts anyway finds the item finished.
  if (w.job) ctx.scheduler.cancel(w.job);
  finish(ctx, w, { kind: "canceled" });
  return true;
}

/** Cancels up to CANCEL_PAGE items enqueued before `before`; continues in a job when there may be more. */
function cancelPage(ctx: Ctx, before: number): number {
  let n = 0;
  for (const s of ["running", "pending"] as const) {
    for (const w of ctx.db.query("work").withIndex("by_queue", (q) => q.eq("status", s)).take(CANCEL_PAGE * 2)) {
      if (n >= CANCEL_PAGE) break;
      if (w.seq < before && !w.cancelRequested && cancelItem(ctx, w._id)) n++;
    }
  }
  if (n >= CANCEL_PAGE) ctx.scheduler.runAfter(0, "lib:cancelAllNext", { before });
  pump(ctx);
  return n;
}

// ---------------------------------------------------------------------------------------------------- functions

const itemValidator = v.object({
  kind: v.union(v.literal("action"), v.literal("mutation")),
  fn: v.string(),
  args: v.optional(v.any()),
  onComplete: v.optional(v.string()),
  context: v.optional(v.any()),
  retry: v.optional(retryValidator),
  priority: v.optional(v.number()),
  key: v.optional(v.string()),
});

const optionsArgs = {
  /** Pool settings sent by the `Workpool` helper (stored: the last enqueue wins). */
  maxParallelism: v.optional(v.number()),
  retentionMs: v.optional(v.number()),
  reclaimIntervalMs: v.optional(v.number()),
};

export const functions = {
  lib: {
    /** Enqueues items in this shard's pool (in the caller's transaction). Returns their ids, in order. */
    enqueue: mutation({
      args: { items: v.array(itemValidator), ...optionsArgs },
      returns: v.array(v.string()),
      handler: (ctx, a) => {
        if (a.items.length > ENQUEUE_MAX) bad(`at most ${ENQUEUE_MAX} items per enqueue`);
        const p = pool(ctx);
        const settings: Partial<Settings> = {};
        const mp = positiveInt(a.maxParallelism, "maxParallelism", MAX_PARALLELISM_LIMIT);
        if (mp !== undefined) settings.maxParallelism = mp;
        const rt = nonNegative(a.retentionMs, "retentionMs");
        if (rt !== undefined) settings.retentionMs = rt;
        const ri = positiveInt(a.reclaimIntervalMs, "reclaimIntervalMs", DAY_MS);
        if (ri !== undefined) settings.reclaimIntervalMs = ri;
        if (Object.keys(settings).length) ctx.db.patch(p._id, settings);
        const ids: string[] = [];
        let seq = p.nextSeq;
        let added = 0;
        for (const it of a.items) {
          if (!it.fn.startsWith("&")) bad("fn must be a function handle (createFunctionHandle)");
          if (it.onComplete !== undefined && !it.onComplete.startsWith("&")) bad("onComplete must be a function handle (createFunctionHandle)");
          if (it.priority !== undefined && !Number.isFinite(it.priority)) bad("priority must be a finite number");
          if (it.key !== undefined) {
            const same = ctx.db.query("work").withIndex("by_key", (q) => q.eq("key", it.key)).first();
            if (same) {
              ids.push(same._id);
              continue;
            }
          }
          const id = ctx.db.insert("work", {
            kind: it.kind,
            fn: it.fn,
            args: it.args ?? {},
            status: "pending",
            rank: -(it.priority ?? 0),
            seq: seq++,
            attempts: 0,
            enqueuedAt: ctx.now,
            ...(it.retry ? { retry: checkRetry(it.retry) } : {}),
            ...(it.onComplete ? { onComplete: it.onComplete } : {}),
            ...(it.context !== undefined ? { context: it.context } : {}),
            ...(it.key !== undefined ? { key: it.key } : {}),
          });
          ids.push(id);
          added++;
        }
        ctx.db.patch(p._id, { nextSeq: seq });
        if (added) bump(ctx, "enqueued", added);
        pump(ctx);
        return ids;
      },
    }),

    /** Reactive status of an item; null when unknown (never enqueued here, or past its retention). */
    status: query({
      args: { id: v.string() },
      handler: (ctx, { id }): WorkStatus | null => {
        const w = load(ctx, id);
        if (!w) return null;
        if (w.status === "pending") {
          const higher = ctx.db.aggregate("work", "by_status").range((q) => q.eq("status", "pending").lt("rank", w.rank)).reduce((n, g) => n + g.count, 0);
          const same = ctx.db.query("work").withIndex("by_queue", (q) => q.eq("status", "pending").eq("rank", w.rank).lt("seq", w.seq)).take(MAX_POSITION).length;
          return { state: "pending", position: Math.min(MAX_POSITION, higher + same) };
        }
        if (w.status === "running") {
          const out: WorkStatus = { state: "running", attempt: w.attempts };
          if (w.attemptAt !== undefined && w.attempts > 1 && w.job && ctx.scheduler.get(w.job)?.state.kind === "pending") out.retryAt = w.attemptAt;
          if (w.lastError !== undefined) out.lastError = w.lastError;
          if (w.cancelRequested) out.cancelRequested = true;
          return out;
        }
        return { state: "finished", result: w.result ?? (w.status === "success" ? { kind: "success", returnValue: null } : w.status === "failed" ? { kind: "failed", error: w.lastError ?? "" } : { kind: "canceled" }) };
      },
    }),

    /** Counts for dashboards and alerts (reactive). */
    stats: query({
      args: {},
      handler: (ctx): WorkpoolStats => {
        const p = readPool(ctx);
        return {
          pending: count(ctx, "pending"),
          running: count(ctx, "running"),
          finished: { success: count(ctx, "success"), failed: count(ctx, "failed"), canceled: count(ctx, "canceled") },
          maxParallelism: settingsOf(ctx, p).maxParallelism,
          totals: { ...ZERO, ...p?.totals },
        };
      },
    }),

    /**
     * Cancels an item: a pending one (or a running one whose job has not started) finishes as canceled now; an action
     * in flight finishes as canceled when it returns (its result is dropped). False if unknown or already finished.
     */
    cancel: mutation({
      args: { id: v.string() },
      returns: v.boolean(),
      handler: (ctx, { id }) => {
        const w = load(ctx, id);
        if (!w) return false;
        const ok = cancelItem(ctx, w._id);
        pump(ctx);
        return ok;
      },
    }),

    /** Cancels every item enqueued so far (later enqueues are not affected). Returns how many it canceled right away. */
    cancelAll: mutation({
      args: {},
      returns: v.number(),
      handler: (ctx) => {
        const p = pool(ctx);
        ctx.db.patch(p._id, { cancelBefore: p.nextSeq });
        return cancelPage(ctx, p.nextSeq);
      },
    }),

    // ------------------------------------------------------------------------------------------- internal

    cancelAllNext: internalMutation({ args: { before: v.number() }, handler: (ctx, { before }) => void cancelPage(ctx, before) }),

    load: internalQuery({
      args: { id: v.id("work"), attempt: v.number() },
      handler: (ctx, { id, attempt }) => {
        const w = fenced(ctx, id, attempt);
        return w ? { fn: w.fn, args: w.args, cancel: w.cancelRequested === true } : null;
      },
    }),

    /** Runs attempt `attempt` of an action item, then reports (at least once: a lease that runs out runs it again). */
    run: internalAction({
      args: { id: v.id("work"), attempt: v.number() },
      leaseMs: RUN_LEASE_MS,
      handler: async (ctx, { id, attempt }) => {
        const w = (await ctx.runQuery(unsafeRef<"query">("lib:load"), { id, attempt })) as { fn: string; args: Record<string, unknown>; cancel: boolean } | null;
        if (!w) return;
        let outcome: RunOutcome;
        if (w.cancel) outcome = { canceled: true };
        else {
          try {
            outcome = { ok: true, value: (await ctx.runAction(unsafeRef<"action">(w.fn), w.args)) ?? null };
          } catch (e) {
            outcome = { ok: false, error: message(e) };
          }
        }
        // If this report fails, the job fails and the scheduler runs it again (the work runs again: at least once).
        await ctx.runMutation(unsafeRef<"mutation">("lib:complete"), { id, attempt, outcome });
      },
    }),

    complete: internalMutation({
      args: { id: v.id("work"), attempt: v.number(), outcome: v.any() },
      handler: (ctx, { id, attempt, outcome }) => {
        const w = fenced(ctx, id, attempt);
        if (w) settle(ctx, w, outcome as RunOutcome);
      },
    }),

    /** A mutation item: the work (in a savepoint), its result and onComplete commit together, exactly once. */
    runMutation: internalMutation({
      args: { id: v.id("work"), attempt: v.number() },
      handler: (ctx, { id, attempt }) => {
        const w = fenced(ctx, id, attempt);
        if (!w) return;
        if (w.cancelRequested) return settle(ctx, w, { canceled: true });
        let outcome: RunOutcome;
        try {
          outcome = { ok: true, value: ctx.runMutation(unsafeRef<"mutation">(w.fn), w.args as Record<string, unknown>) };
        } catch (e) {
          outcome = { ok: false, error: message(e) };
        }
        settle(ctx, w, outcome);
      },
    }),

    /** Reclaims lost slots, deletes expired results, pumps, and schedules the next tick while there is work. */
    tick: internalMutation({
      args: {},
      handler: (ctx) => {
        let p = pool(ctx);
        let set = settingsOf(ctx, p);
        ctx.db.patch(p._id, { tickAt: undefined, tickJob: undefined });
        for (const w of ctx.db.query("work").withIndex("by_queue", (q) => q.eq("status", "running")).take(MAX_PARALLELISM_LIMIT * 2)) {
          const job = w.job ? ctx.scheduler.get(w.job) : null;
          let lost: string | null = null;
          if (!job) {
            // Unknown job: past its retention, or never recorded. Allow one interval (a reader that lags behind).
            if (ctx.now - (w.attemptAt ?? w.enqueuedAt) >= set.reclaimIntervalMs) lost = "its job is gone";
          } else if (job.state.kind === "failed") lost = `its job failed (${job.state.error})`;
          else if (job.state.kind === "success" || job.state.kind === "canceled") lost = `its job ended (${job.state.kind}) without reporting`;
          if (lost === null) continue;
          console.warn(`workpool ${ctx.component.name}: reclaiming ${w._id} (attempt ${w.attempts}): ${lost}`);
          bump(ctx, "reclaimed");
          const fresh = ctx.db.get(w._id);
          if (fresh && fresh.status === "running") settle(ctx, fresh, { ok: false, error: `lost: ${lost}` });
        }
        set = settingsOf(ctx, pool(ctx));
        let more = false;
        if (set.retentionMs > 0) {
          let left = GC_BATCH;
          for (const s of FINISHED) {
            const old = ctx.db.query("work").withIndex("by_finished", (q) => q.eq("status", s).lt("finishedAt", ctx.now - set.retentionMs)).take(left);
            for (const w of old) ctx.db.delete(w._id);
            left -= old.length;
          }
          more = left <= 0;
        }
        pump(ctx);
        set = settingsOf(ctx, pool(ctx));
        // Next: soon while items run (reclaim) or a GC batch was full; else when the oldest retained result expires.
        let next = count(ctx, "running") > 0 || more ? ctx.now + set.reclaimIntervalMs : Infinity;
        if (set.retentionMs > 0) {
          for (const s of FINISHED) {
            const oldest = ctx.db.query("work").withIndex("by_finished", (q) => q.eq("status", s)).first();
            if (oldest?.finishedAt !== undefined) next = Math.min(next, oldest.finishedAt + set.retentionMs + 1);
          }
        }
        if (next !== Infinity) ensureTick(ctx, next);
      },
    }),
  },
};

export const installConfigValidator = v.optional(
  v.object({ maxParallelism: v.optional(v.number()), retentionMs: v.optional(v.number()), reclaimIntervalMs: v.optional(v.number()) }),
);

export const workpool = defineComponent({
  name: "workpool",
  schema,
  functions,
  config: installConfigValidator,
});
