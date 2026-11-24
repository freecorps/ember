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
  type PatchValue,
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
  /** How often a pool with running items checks for lost jobs (default 5 min). */
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
/**
 * A lost run comes back by its scheduler lease (`RUN_LEASE_MS`, 15 min) on its own; the reclaim check only frees a slot
 * whose job ended without reporting, so looking every minute only woke the shard: every 5 minutes.
 */
export const DEFAULT_RECLAIM_INTERVAL_MS = 5 * 60_000;
/**
 * Retention GC runs on boundaries this far apart (at most the retention itself): results expiring in the same window
 * are deleted by one tick, not one wake per result. A result is kept at least `retentionMs`.
 */
export const GC_GRANULARITY_MS = 15 * 60_000;
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
  const b = buffers.get(ctx);
  if (b) return b.doc;
  const p = readPool(ctx);
  if (p) return p;
  const id = ctx.db.insert("pool", {
    nextSeq: 0,
    cancelBefore: 0,
    totals: { ...ZERO },
  });
  return ctx.db.get(id)!;
}

/**
 * The pool row is written once per call of `pump`, `settle`, `cancelPage`, `cancel`, `cancelAll` and the tick (each
 * `finish` bumped a total and each start could move the tick: one write each before). Inside `batched`, `pool()` reads
 * the buffered row: `writePool` merges fields and `bump` adds to `deltas`; both are written when the outermost
 * `batched` returns. An onComplete is app code that may read this pool (`stats`, in a nested call with its own ctx,
 * which does not see the buffer) or call back into it (an enqueue): the buffered fields and totals are written before it
 * runs (so it sees its own outcome counted: one pool write per onComplete, as each finish cost before) and the row is
 * read again after it. Later totals stay deltas, added to the row as it is at the end (so a nested enqueue's own totals
 * are kept). A throw drops the buffer: the transaction (or savepoint) is undone.
 */
type Totals = Pool["totals"];
/** Fields of the pool row to write (undefined clears one). */
type PoolPatch = PatchValue<Omit<Pool, "_id" | "_creationTime">>;
type PoolBuffer = { doc: Pool; patch: PoolPatch; deltas: Partial<Totals> };
const buffers = new WeakMap<Ctx, PoolBuffer>();

const withDeltas = (p: Pool, d: Partial<Totals>): Pool => {
  if (!Object.keys(d).length) return p;
  const totals = { ...ZERO, ...p.totals };
  for (const k of Object.keys(d) as Array<keyof Totals>) totals[k] += d[k] ?? 0;
  return { ...p, totals };
};

function writePool(ctx: Ctx, fields: PoolPatch) {
  const b = buffers.get(ctx);
  if (!b) return ctx.db.patch(pool(ctx)._id, fields);
  Object.assign(b.patch, fields);
  b.doc = { ...b.doc, ...fields } as Pool;
}

/** Writes the buffered fields and the totals' deltas in one patch. */
function flushPool(ctx: Ctx, b: PoolBuffer) {
  const patch: PoolPatch = { ...b.patch };
  if (Object.keys(b.deltas).length) {
    patch.totals = withDeltas(ctx.db.get(b.doc._id)!, b.deltas).totals;
    b.deltas = {};
  }
  b.patch = {};
  if (Object.keys(patch).length) ctx.db.patch(b.doc._id, patch);
}

function batched<T>(ctx: Ctx, fn: () => T): T {
  if (buffers.has(ctx)) return fn();
  const b: PoolBuffer = { doc: pool(ctx), patch: {}, deltas: {} };
  buffers.set(ctx, b);
  let ok = false;
  try {
    const r = fn();
    ok = true;
    return r;
  } finally {
    buffers.delete(ctx);
    if (ok) flushPool(ctx, b);
  }
}

/** Runs app code (onComplete) with the buffered fields and totals written first and the row read again after. */
function unbuffered<T>(ctx: Ctx, fn: () => T): T {
  const b = buffers.get(ctx);
  if (!b) return fn();
  flushPool(ctx, b);
  try {
    return fn();
  } finally {
    const fresh = ctx.db.get(b.doc._id);
    if (fresh) b.doc = withDeltas(fresh, b.deltas);
  }
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

function bump(ctx: Ctx, field: keyof Totals, n = 1) {
  const b = buffers.get(ctx);
  if (b) {
    b.deltas[field] = (b.deltas[field] ?? 0) + n;
    b.doc = withDeltas(b.doc, { [field]: n });
    return;
  }
  const p = pool(ctx);
  ctx.db.patch(p._id, { totals: { ...p.totals, [field]: p.totals[field] + n } });
}

/** The GC boundary at or after `t`. */
function gcAt(t: number, retentionMs: number): number {
  const g = Math.min(GC_GRANULARITY_MS, retentionMs);
  return Math.ceil(t / g) * g;
}

/** When the oldest retained result expires (on a GC boundary), or Infinity. */
function nextGc(ctx: ReadCtx, set: Settings): number {
  if (set.retentionMs <= 0) return Infinity;
  let next = Infinity;
  for (const s of FINISHED) {
    const oldest = ctx.db.query("work").withIndex("by_finished", (q) => q.eq("status", s)).first();
    if (oldest?.finishedAt !== undefined) next = Math.min(next, gcAt(oldest.finishedAt + set.retentionMs + 1, set.retentionMs));
  }
  return next;
}

/** Sets the one tick to exactly `at` (none for Infinity): an idle pool needs no reclaim tick, only its GC. */
function retimeTick(ctx: Ctx, at: number) {
  const p = pool(ctx);
  const when = at === Infinity ? undefined : Math.max(at, ctx.now);
  // Already there (or no tick and none needed). A future tick has not run: the tick clears tickAt/tickJob in the
  // transaction it runs in, so an equal future tickAt is a pending job. One due now or before may have failed: re-armed.
  if (p.tickAt === when && (when === undefined || when > ctx.now)) return;
  if (p.tickJob) ctx.scheduler.cancel(p.tickJob);
  writePool(ctx, when === undefined ? { tickAt: undefined, tickJob: undefined } : { tickAt: when, tickJob: ctx.scheduler.runAt(when, "lib:tick", {}) });
}

/** The pool fields that keep one tick scheduled at or before `at` (null: the current tick already does). */
function tickPatch(ctx: Ctx, p: Pool, at: number): Pick<Pool, "tickAt" | "tickJob"> | null {
  if (p.tickAt !== undefined && p.tickAt <= at && p.tickAt > ctx.now - STALE_TICK_MS && tickAlive(ctx, p)) return null;
  if (p.tickJob) ctx.scheduler.cancel(p.tickJob);
  const when = Math.max(at, ctx.now);
  return { tickAt: when, tickJob: ctx.scheduler.runAt(when, "lib:tick", {}) };
}

/**
 * Whether the tick the row names may still run. A future one has not run (the tick clears tickAt/tickJob in the
 * transaction it runs in). One due now or before is usually just late, unless its job already ended: it failed (rolled
 * back, so tickAt still names it), or was cancelled. Read only for an overdue tick.
 */
function tickAlive(ctx: Ctx, p: Pool): boolean {
  if (p.tickAt === undefined || p.tickAt > ctx.now || !p.tickJob) return true;
  const job = ctx.scheduler.get(p.tickJob);
  return !job || job.state.kind === "pending" || job.state.kind === "inProgress";
}

/** Keeps one tick scheduled at or before `at`. */
function ensureTick(ctx: Ctx, at: number) {
  const p = pool(ctx);
  const patch = tickPatch(ctx, p, at);
  if (patch) writePool(ctx, patch);
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
  batched(ctx, () => pumpBuffered(ctx));
}

function pumpBuffered(ctx: Ctx) {
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
        // Without onComplete nothing the rest of the heads depend on changed (it took no slot).
        if (head.onComplete) break;
        continue;
      }
      startItem(ctx, head, set);
    }
  }
}

/** The item is done: status, result, totals and onComplete in this transaction. Does not pump. */
function finish(ctx: Ctx, w: Work, result: WorkResult, extra: Partial<Work> = {}) {
  bump(ctx, result.kind === "success" ? "succeeded" : result.kind === "failed" ? "failed" : "canceled");
  // Without onComplete nothing reads the finished row before it goes: with no retention it is deleted unpatched.
  if (!w.onComplete && settingsOf(ctx, pool(ctx)).retentionMs === 0) {
    ctx.db.delete(w._id);
    return;
  }
  ctx.db.patch(w._id, { ...extra, status: result.kind, result, finishedAt: ctx.now, job: undefined, attemptAt: undefined, cancelRequested: undefined });
  if (w.onComplete) {
    const onComplete = w.onComplete;
    // In a savepoint: a failing callback is undone and recorded; the item stays finished and its slot is freed.
    unbuffered(ctx, () => {
      try {
        ctx.runMutation(unsafeRef<"mutation">(onComplete), { workId: w._id, context: w.context ?? null, result });
      } catch (e) {
        console.error(`workpool ${ctx.component.name}: onComplete of ${w._id} failed: ${message(e)}`);
        ctx.db.patch(w._id, { onCompleteError: message(e) });
      }
    });
  }
  const set = settingsOf(ctx, pool(ctx));
  if (set.retentionMs === 0) ctx.db.delete(w._id);
  // The tick armed while items ran stays, even when the pool goes idle: moving it to the GC of the oldest result here
  // cancelled one job and scheduled another on every burst's end (and the next start moved it back). The reclaim tick
  // finds nothing running and moves itself to the GC (`lib:tick`), once. It is brought sooner when this result's GC
  // comes first (a retention shorter than the reclaim interval), and armed when there is none (`ensureTick` never
  // moves it later).
  if (set.retentionMs > 0) ensureTick(ctx, gcAt(ctx.now + set.retentionMs + 1, set.retentionMs));
}

function backoff(ctx: Ctx, r: RetryBehavior, failures: number) {
  const d = r.initialBackoffMs * r.base ** Math.max(0, failures - 1);
  // ±25% jitter, so items that failed together do not retry together.
  return Math.round(d * (0.75 + 0.5 * ctx.random()));
}

/** The outcome of the running attempt of `w` (already fenced). Pumps. */
function settle(ctx: Ctx, w: Work, o: RunOutcome) {
  batched(ctx, () => settleBuffered(ctx, w, o));
}

function settleBuffered(ctx: Ctx, w: Work, o: RunOutcome) {
  if (w.cancelRequested || "canceled" in o) finish(ctx, w, { kind: "canceled" });
  else if (o.ok) finish(ctx, w, { kind: "success", returnValue: o.value ?? null });
  else if (w.retry && w.attempts < w.retry.maxAttempts) {
    const at = ctx.now + backoff(ctx, w.retry, w.attempts);
    const attempt = w.attempts + 1;
    const job = ctx.scheduler.runAt(at, w.kind === "action" ? "lib:run" : "lib:runMutation", { id: w._id, attempt });
    ctx.db.patch(w._id, { attempts: attempt, job, attemptAt: at, lastError: o.error });
    bump(ctx, "retries");
  } else finish(ctx, w, { kind: "failed", error: o.error }, { lastError: o.error });
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

/**
 * What a run job names: `{ id, attempt }`, or `{ seq, rank, attempt }` for an item started by the enqueue that
 * inserted it (its job was scheduled before the row had an id).
 */
type RunRef = { id?: WId; seq?: number; rank?: number; attempt: number };
const runRefArgs = { id: v.optional(v.id("work")), seq: v.optional(v.number()), rank: v.optional(v.number()), attempt: v.number() };

function fencedRef(ctx: ReadCtx, r: RunRef): Work | null {
  if (r.id !== undefined) return fenced(ctx, r.id, r.attempt);
  const { seq, rank } = r;
  if (seq === undefined || rank === undefined) return null;
  // The default priority is rank -0, which sorts apart from +0 in an index key; args that went through plain JSON
  // (a Queue message) come back as 0, so both are tried.
  for (const k of rank === 0 ? [-0, 0] : [rank]) {
    const w = ctx.db.query("work").withIndex("by_queue", (q) => q.eq("status", "running").eq("rank", k).eq("seq", seq)).first();
    if (w) return w.attempts === r.attempt ? w : null;
  }
  return null;
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
  return batched(ctx, () => cancelPageBuffered(ctx, before));
}

function cancelPageBuffered(ctx: Ctx, before: number): number {
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
        const before = settingsOf(ctx, p);
        // Only what differs from the stored row is written (the helper sends its options with every enqueue).
        const patch: Partial<Pool> = {};
        const mp = positiveInt(a.maxParallelism, "maxParallelism", MAX_PARALLELISM_LIMIT);
        if (mp !== undefined && mp !== p.maxParallelism) patch.maxParallelism = mp;
        const rt = nonNegative(a.retentionMs, "retentionMs");
        const retentionChanged = rt !== undefined && rt !== before.retentionMs;
        if (rt !== undefined && rt !== p.retentionMs) patch.retentionMs = rt;
        const ri = positiveInt(a.reclaimIntervalMs, "reclaimIntervalMs", DAY_MS);
        if (ri !== undefined && ri !== p.reclaimIntervalMs) patch.reclaimIntervalMs = ri;
        const set: Settings = { maxParallelism: mp ?? before.maxParallelism, retentionMs: rt ?? before.retentionMs, reclaimIntervalMs: ri ?? before.reclaimIntervalMs };

        type New = { it: (typeof a.items)[number]; seq: number };
        const ids: Array<string | New> = [];
        const fresh: New[] = [];
        const keys = new Map<string, New>();
        let seq = p.nextSeq;
        for (const it of a.items) {
          if (!it.fn.startsWith("&")) bad("fn must be a function handle (createFunctionHandle)");
          if (it.onComplete !== undefined && !it.onComplete.startsWith("&")) bad("onComplete must be a function handle (createFunctionHandle)");
          if (it.priority !== undefined && !Number.isFinite(it.priority)) bad("priority must be a finite number");
          if (it.retry) checkRetry(it.retry);
          if (it.key !== undefined) {
            const inBatch = keys.get(it.key);
            if (inBatch) {
              ids.push(inBatch);
              continue;
            }
            const same = ctx.db.query("work").withIndex("by_key", (q) => q.eq("key", it.key)).first();
            if (same) {
              ids.push(same._id);
              continue;
            }
          }
          const n: New = { it, seq: seq++ };
          if (it.key !== undefined) keys.set(it.key, n);
          ids.push(n);
          fresh.push(n);
        }

        // With nothing queued, the new items that fit start right away, in the order the pump would take them
        // (priority, then enqueue order): each is inserted as running with its job (one write instead of an insert
        // and a patch). The job is scheduled first, so it names the item by (rank, seq), unique in the pool.
        const queued = ctx.db.query("work").withIndex("by_queue", (q) => q.eq("status", "pending")).first() !== null;
        const room = queued || !fresh.length ? 0 : Math.max(0, set.maxParallelism - count(ctx, "running"));
        // Inserted (and their jobs scheduled) in the pump's order too, so same-time jobs start highest priority first;
        // the ids still come back in input order (`inserted`).
        const order = room > 0 ? [...fresh].sort((x, y) => (y.it.priority ?? 0) - (x.it.priority ?? 0) || x.seq - y.seq) : fresh;
        const direct = new Set(order.slice(0, room));
        const inserted = new Map<New, string>();
        for (const n of order) {
          const it = n.it;
          const rank = -(it.priority ?? 0);
          const doc = {
            kind: it.kind,
            fn: it.fn,
            args: it.args ?? {},
            rank,
            seq: n.seq,
            enqueuedAt: ctx.now,
            ...(it.retry ? { retry: checkRetry(it.retry) } : {}),
            ...(it.onComplete ? { onComplete: it.onComplete } : {}),
            ...(it.context !== undefined ? { context: it.context } : {}),
            ...(it.key !== undefined ? { key: it.key } : {}),
          };
          if (direct.has(n)) {
            const job = ctx.scheduler.runAfter(0, it.kind === "action" ? "lib:run" : "lib:runMutation", { seq: n.seq, rank, attempt: 1 });
            inserted.set(n, ctx.db.insert("work", { ...doc, status: "running", attempts: 1, job, attemptAt: ctx.now, startedAt: ctx.now }));
          } else inserted.set(n, ctx.db.insert("work", { ...doc, status: "pending", attempts: 0 }));
        }
        // One write of the pool row: changed settings, nextSeq, totals and the reclaim tick of the items started here.
        if (seq !== p.nextSeq) patch.nextSeq = seq;
        if (fresh.length) patch.totals = { ...p.totals, enqueued: p.totals.enqueued + fresh.length };
        if (direct.size) Object.assign(patch, tickPatch(ctx, p, ctx.now + set.reclaimIntervalMs));
        if (Object.keys(patch).length) ctx.db.patch(p._id, patch);
        // Items already queued may start now (a raised maxParallelism, slots freed meanwhile); without a queue, every
        // new item that fit has started and the rest found no room.
        if (queued) pump(ctx);
        // A new retention moves the GC of the results already kept (e.g. an enqueue that only hit a finished key): an
        // idle pool's one tick goes to it; a busy pool keeps its reclaim tick, brought sooner if the GC comes first.
        if (retentionChanged) {
          const gc = nextGc(ctx, settingsOf(ctx, pool(ctx)));
          if (count(ctx, "running") === 0 && count(ctx, "pending") === 0) retimeTick(ctx, gc);
          else if (gc !== Infinity) ensureTick(ctx, gc);
        }
        return ids.map((x) => (typeof x === "string" ? x : inserted.get(x)!));
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
        return batched(ctx, () => {
          const ok = cancelItem(ctx, w._id);
          pump(ctx);
          return ok;
        });
      },
    }),

    /** Cancels every item enqueued so far (later enqueues are not affected). Returns how many it canceled right away. */
    cancelAll: mutation({
      args: {},
      returns: v.number(),
      handler: (ctx) => {
        return batched(ctx, () => {
          const p = pool(ctx);
          writePool(ctx, { cancelBefore: p.nextSeq });
          return cancelPage(ctx, p.nextSeq);
        });
      },
    }),

    // ------------------------------------------------------------------------------------------- internal

    cancelAllNext: internalMutation({ args: { before: v.number() }, handler: (ctx, { before }) => void cancelPage(ctx, before) }),

    load: internalQuery({
      args: runRefArgs,
      handler: (ctx, ref) => {
        const w = fencedRef(ctx, ref);
        return w ? { id: w._id, fn: w.fn, args: w.args, cancel: w.cancelRequested === true } : null;
      },
    }),

    /** Runs attempt `attempt` of an action item, then reports (at least once: a lease that runs out runs it again). */
    run: internalAction({
      args: runRefArgs,
      leaseMs: RUN_LEASE_MS,
      handler: async (ctx, ref) => {
        const w = (await ctx.runQuery(unsafeRef<"query">("lib:load"), ref)) as { id: WId; fn: string; args: Record<string, unknown>; cancel: boolean } | null;
        if (!w) return;
        const { id } = w;
        const { attempt } = ref;
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
      args: runRefArgs,
      handler: (ctx, ref) => {
        const w = fencedRef(ctx, ref);
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
      handler: (ctx) => batched(ctx, () => tickBuffered(ctx)),
    }),
  },
};

/** `lib:tick`: reclaims lost slots, deletes expired results, pumps, and schedules the next tick while there is work. */
function tickBuffered(ctx: Ctx) {
  let set = settingsOf(ctx, pool(ctx));
  writePool(ctx, { tickAt: undefined, tickJob: undefined });
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
  // (The oldest retained result's GC is on a boundary: results expiring in the same window go in one tick.)
  const next = Math.min(count(ctx, "running") > 0 || more ? ctx.now + set.reclaimIntervalMs : Infinity, nextGc(ctx, set));
  if (next !== Infinity) ensureTick(ctx, next);
}

export const installConfigValidator = v.optional(
  v.object({ maxParallelism: v.optional(v.number()), retentionMs: v.optional(v.number()), reclaimIntervalMs: v.optional(v.number()) }),
);

export const workpool = defineComponent({
  name: "workpool",
  schema,
  functions,
  config: installConfigValidator,
});
