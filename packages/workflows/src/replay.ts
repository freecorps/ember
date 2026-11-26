// Journal-and-replay (app side): a workflow handler is an async function of `step`. Each run replays it from the
// start against the journal of finished steps; journaled steps resolve (or reject) with their recorded outcome, and
// the first step not in the journal suspends the handler. The run reports that request (or the final result) to
// the component, which records it in the shard and executes it. So the handler must be deterministic: every
// effect goes through `step.*` (no fetch, no Math.random/Date.now deciding which step comes next).

import type { AnyFunctionReference, FunctionReference, FunctionReturnType, OptionalRestArgs, Visibility } from "@freecorps/ember-values";

/** What a step asks the component to do. `fn` is a function handle (absolute, `&mod:fn`). */
export type StepRequest =
  | { kind: "query" | "mutation" | "action"; name: string; fn: string; args: unknown; retry?: RetryPolicy }
  /** `ms` is relative to when the shard records the step; `until` is absolute. */
  | { kind: "sleep"; name: string; ms?: number; until?: number }
  | { kind: "event"; name: string; event: string; timeoutMs?: number };

/** A journaled step as the driver receives it. */
export type JournalEntry = {
  index: number;
  kind: StepRequest["kind"];
  name: string;
  status: "pending" | "done" | "failed";
  result?: unknown;
  error?: string;
  /** End of the parallel batch the step ran in (absent: a batch of its own, `index + 1`). */
  batchEnd?: number;
};

export type RetryPolicy = { maxAttempts: number; initialBackoffMs?: number; base?: number };

/** What one replay produced. */
export type Outcome =
  | { type: "step"; index: number; step: StepRequest }
  /**
   * Steps requested together (`Promise.all([step.runAction(a), step.runAction(b)])`): indexes `index`, `index + 1`, …
   * in call order. The workflow replays again once all of them settled.
   */
  | { type: "steps"; index: number; steps: StepRequest[] }
  | { type: "done"; result?: unknown }
  | { type: "failed"; error: string }
  /** A journaled step is still running (a parallel sibling, or a stale duplicate run): nothing to do yet. */
  | { type: "waiting" };

/** Rejection of a step that failed (its error message), seen by the handler. */
export class StepFailed extends Error {
  override readonly name = "StepFailed";
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

/** The handler took a different path than the journal recorded (non-deterministic code). */
export class NonDeterminism extends Error {
  override readonly name = "NonDeterminism";
}

/** A step's function: a reference (`internal.mod.fn`, typed) or a name (`"mod:fn"`, untyped: prefer `unsafeRef`). */
type FnRef = AnyFunctionReference | string;
type QueryFn = FunctionReference<"query", Visibility> | string;
type MutationFn = FunctionReference<"mutation", Visibility> | string;
type ActionFn = FunctionReference<"action", Visibility> | string;
/** `[args?, options?]` (`[args, options?]` when the function has required args), typed by the reference. */
export type StepArgs<F> = [...OptionalRestArgs<F>, opts?: StepOptions];
/** What a step resolves with: the function's return type (`unknown` for a name). */
export type StepResult<F> = F extends AnyFunctionReference ? FunctionReturnType<F> : unknown;

export interface StepOptions {
  /** Label in the journal (default: the function name / kind). Part of the determinism check. */
  name?: string;
  /** Actions only (mutations and queries are not retried: their failures are deterministic). */
  retry?: RetryPolicy | false;
}

/**
 * `step` inside a workflow handler. Steps started together run in parallel (`await Promise.all([step.runAction(a),
 * step.runAction(b)])`): each gets its own journal entry (by call order, so the batch is the same on every replay),
 * and the handler goes on once all of them settled.
 */
export interface WorkflowStep {
  /** The workflow's id. */
  readonly workflowId: string;
  /** Runs a query on the workflow's shard (journaled). */
  runQuery<F extends QueryFn>(fn: F, ...rest: StepArgs<F>): Promise<StepResult<F>>;
  /** Runs a mutation on the workflow's shard, exactly once: its writes and the journal entry commit together. */
  runMutation<F extends MutationFn>(fn: F, ...rest: StepArgs<F>): Promise<StepResult<F>>;
  /** Runs an action (at least once; retried per `retry`). */
  runAction<F extends ActionFn>(fn: F, ...rest: StepArgs<F>): Promise<StepResult<F>>;
  /** Sleeps `ms` (durable: the shard scheduler wakes the workflow; years are fine). */
  sleep(ms: number, opts?: { name?: string }): Promise<void>;
  /** Sleeps until a timestamp (ms). */
  sleepUntil(timestamp: number | Date, opts?: { name?: string }): Promise<void>;
  /** Waits for `sendEvent(id, event, payload)`; resolves with the payload. Rejects (StepFailed) after `timeoutMs`. */
  waitForEvent<T = unknown>(event: string, opts?: { timeoutMs?: number; name?: string }): Promise<T>;
}

const FUNCTION_NAME = Symbol.for("ember.functionName");
export function handleOf(fn: FnRef | object): string {
  const name = typeof fn === "string" ? fn : (fn as Record<symbol, unknown>)[FUNCTION_NAME];
  if (typeof name !== "string") throw new Error("workflow step: expected a function reference (internal.mod.fn) or a function name");
  return name.startsWith("&") ? name : `&${name}`;
}

/** Resolves after the microtasks queued so far (and the ones they queue) ran: the handler went as far as it can. */
const quiet = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Replays `handler` against `journal`. Steps are matched by position, kind and name (not by args or time). The
 * handler runs until it cannot go on: every step it asks for that is not in the journal yet is part of the outcome
 * (one `step`, or a `steps` batch for steps started together). While a journaled step is still pending (a parallel
 * sibling still running) the outcome is `waiting`: new steps are only asked for once the whole batch settled, so the
 * order in which parallel steps finish never changes which index a later step gets.
 *
 * Journaled steps are handed back batch by batch, as they ran (`batchEnd`; a step without one is a batch of its own):
 * the results of a batch are released once the handler asked for all of its steps, never earlier. So a branch that
 * resolves from the journal cannot run ahead and ask for a step of a later batch before a sibling branch asked for
 * its step of this one: every replay sees the same rounds as the run that recorded them.
 */
export async function replay(
  handler: (step: WorkflowStep, args: any) => Promise<unknown>,
  input: { workflowId: string; args: unknown; journal: JournalEntry[]; defaultRetry?: RetryPolicy },
): Promise<Outcome> {
  const journal = [...input.journal].sort((a, b) => a.index - b.index);
  let index = 0;
  const requested: StepRequest[] = [];
  let first = -1;
  let waiting = false;
  /** Set on a journal mismatch: the run fails even if the handler catches the error. */
  let nondet: string | null = null;
  let signal!: () => void;
  const blocked = new Promise<void>((resolve) => (signal = resolve));
  const never = new Promise<never>(() => {});
  /** The journaled batch being asked for: `[roundStart, roundEnd)`, and its steps asked for so far. */
  let roundStart = 0;
  let roundEnd = 0;
  let held: Array<{ rec: JournalEntry; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const release = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const batch = held;
    held = [];
    if (batch.some((h) => h.rec.status === "pending")) {
      waiting = true;
      signal();
      return;
    }
    for (const h of batch) {
      if (h.rec.status === "failed") h.reject(new StepFailed(h.rec.name, h.rec.error ?? "step failed"));
      else h.resolve(h.rec.result);
    }
  };

  const next = <T>(req: StepRequest): Promise<T> => {
    if (nondet) return never;
    const i = index++;
    const rec = journal[i];
    if (!rec) {
      if (first < 0) first = i;
      requested.push(req);
      signal();
      return never;
    }
    if (i >= roundEnd) {
      roundStart = i;
      roundEnd = Math.min(journal.length, Math.max(i + 1, rec.batchEnd ?? i + 1));
      // The handler asks for fewer steps of this batch than it recorded (it is blocked, or finished): mismatch.
      const start = i;
      const end = roundEnd;
      if (end - start > 1) {
        timer = setTimeout(() => {
          if (roundStart !== start || held.length === 0 || nondet) return;
          nondet = `step ${start}: the journal has a batch of ${end - start} parallel steps but the workflow now asks for ${held.length}`;
          signal();
        }, 0);
      }
    }
    if (rec.kind !== req.kind || rec.name !== req.name) {
      nondet = `step ${i}: the journal has ${rec.kind} "${rec.name}" but the workflow now asks for ${req.kind} "${req.name}"`;
      signal();
      throw new NonDeterminism(nondet);
    }
    const p = new Promise<T>((resolve, reject) => held.push({ rec, resolve: resolve as (v: unknown) => void, reject }));
    if (i === roundEnd - 1) release();
    return p;
  };
  const fnStep = (kind: "query" | "mutation" | "action") => (fn: FnRef, args?: unknown, opts: StepOptions = {}) => {
    const h = handleOf(fn);
    const req: StepRequest = { kind, name: opts.name ?? h.slice(1), fn: h, args: args ?? {} };
    if (kind === "action") {
      const retry = opts.retry === false ? { maxAttempts: 1 } : (opts.retry ?? input.defaultRetry);
      if (retry) req.retry = retry;
    }
    return next(req);
  };
  const step: WorkflowStep = {
    workflowId: input.workflowId,
    runQuery: fnStep("query") as WorkflowStep["runQuery"],
    runMutation: fnStep("mutation") as WorkflowStep["runMutation"],
    runAction: fnStep("action") as WorkflowStep["runAction"],
    sleep: (ms, o = {}) => next({ kind: "sleep", name: o.name ?? "sleep", ms: Math.max(0, ms) }),
    sleepUntil: (t, o = {}) => next({ kind: "sleep", name: o.name ?? "sleep", until: t instanceof Date ? t.getTime() : t }),
    waitForEvent: (event, o = {}) => next({ kind: "event", name: o.name ?? `event:${event}`, event, ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) }),
  };

  const run = (async (): Promise<Outcome> => {
    try {
      const result = await handler(step, input.args);
      return result === undefined ? { type: "done" } : { type: "done", result };
    } catch (e) {
      if (e instanceof NonDeterminism) return { type: "failed", error: `NonDeterminism: ${e.message}` };
      return { type: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  })();
  const out = await Promise.race([run, blocked.then(() => null)]);
  // Steps started together are asked for in the same run of microtasks (`Promise.all([...])`, or a later step of a
  // branch whose journaled steps resolved): wait until the handler cannot go any further, then take them all.
  await quiet();
  if (timer !== undefined) clearTimeout(timer);
  if (nondet) return { type: "failed", error: `NonDeterminism: ${nondet}` };
  if (waiting) return { type: "waiting" };
  // A handler that ignores a suspended step (no await) and finishes: the request wins (it must run first).
  if (requested.length === 1) return { type: "step", index: first, step: requested[0]! };
  if (requested.length > 1) return { type: "steps", index: first, steps: requested };
  return out ?? (await run);
}
