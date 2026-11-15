// Scheduled function metadata (PLAN §8, §22 L7): what `ctx.scheduler.get(id)` / `list()` return. The jobs live in
// the runtime's `_jobs` table (packages/runtime shard.ts); the engine reads them through a `ScheduledReader` the
// runtime (or the test harness) provides, so this package never knows the table's columns.

/** The table name read sets and changes use for scheduled jobs (reactivity: `by_id` per job, the rest table-wide). */
export const JOBS_TABLE = "_jobs";

export type ScheduledFunctionState =
  | { kind: "pending" }
  | { kind: "inProgress" }
  | { kind: "success" }
  | { kind: "failed"; error: string }
  | { kind: "canceled" };

export type ScheduledFunctionStateKind = ScheduledFunctionState["kind"];
export const SCHEDULED_STATE_KINDS: readonly ScheduledFunctionStateKind[] = ["pending", "inProgress", "success", "failed", "canceled"];

/**
 * A scheduled job, close to Convex's `_scheduled_functions` document: `id` (Convex `_id`), `_creationTime`, `name`
 * (`"module:function"`), `args` (the object passed; Convex wraps it in an array), `scheduledTime`, `completedTime`
 * (terminal states only), `state`. `attempts`: runs so far (the scheduler retries failures with backoff; a job is
 * `failed` only after its last attempt).
 */
export interface ScheduledFunction {
  id: string;
  _creationTime: number;
  name: string;
  args: unknown;
  scheduledTime: number;
  completedTime?: number;
  state: ScheduledFunctionState;
  attempts: number;
}

export interface ListScheduledOptions {
  /** Only jobs in this state. */
  state?: ScheduledFunctionStateKind;
  /** At most this many (default 100, at most 1000), oldest first (by `_creationTime`). */
  limit?: number;
}

/** What the engine needs to answer `ctx.scheduler.get/list` (synchronous: it runs inside the transaction). */
export interface ScheduledReader {
  get(id: string): ScheduledFunction | null;
  list(o: { state?: ScheduledFunctionStateKind; limit: number }): ScheduledFunction[];
}

/** `ctx.scheduler` reads, in queries and mutations (and, async, in actions). */
export interface SchedulerReader {
  /** The job `id` (what `runAfter`/`runAt` returned), or null once unknown (never scheduled, or past its retention). */
  get(id: string): ScheduledFunction | null;
  /** Jobs of this shard, oldest first. */
  list(o?: ListScheduledOptions): ScheduledFunction[];
}

export const LIST_SCHEDULED_DEFAULT = 100;
export const LIST_SCHEDULED_MAX = 1000;
