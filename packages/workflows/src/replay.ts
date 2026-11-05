// Journal-and-replay (app side): a workflow handler is an async function of `step`. Each run replays it from the
// start against the journal of finished steps; journaled steps resolve (or reject) with their recorded outcome, and
// the first step not in the journal suspends the handler. The run reports that request (or the final result) to
// the component, which records it in the shard and executes it. So the handler must be deterministic: every
// effect goes through `step.*` (no fetch, no Math.random/Date.now deciding which step comes next).

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
};

export type RetryPolicy = { maxAttempts: number; initialBackoffMs?: number; base?: number };

/** What one replay produced. */
export type Outcome =
  | { type: "step"; index: number; step: StepRequest }
  | { type: "done"; result?: unknown }
  | { type: "failed"; error: string }
  /** The journal ends in a step that is still running (a stale duplicate run): nothing to do. */
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

type FnRef = string | object;

export interface StepOptions {
  /** Label in the journal (default: the function name / kind). Part of the determinism check. */
  name?: string;
  /** Actions only (mutations and queries are not retried: their failures are deterministic). */
  retry?: RetryPolicy | false;
}

/** `step` inside a workflow handler. */
export interface WorkflowStep {
  /** The workflow's id. */
  readonly workflowId: string;
  /** Runs a query on the workflow's shard (journaled). */
  runQuery<R = any>(fn: FnRef, args?: unknown, opts?: StepOptions): Promise<R>;
  /** Runs a mutation on the workflow's shard, exactly once: its writes and the journal entry commit together. */
  runMutation<R = any>(fn: FnRef, args?: unknown, opts?: StepOptions): Promise<R>;
  /** Runs an action (at least once; retried per `retry`). */
  runAction<R = any>(fn: FnRef, args?: unknown, opts?: StepOptions): Promise<R>;
  /** Sleeps `ms` (durable: the shard scheduler wakes the workflow; years are fine). */
  sleep(ms: number, opts?: { name?: string }): Promise<void>;
  /** Sleeps until a timestamp (ms). */
  sleepUntil(timestamp: number | Date, opts?: { name?: string }): Promise<void>;
  /** Waits for `sendEvent(id, event, payload)`; resolves with the payload. Rejects (StepFailed) after `timeoutMs`. */
  waitForEvent<T = unknown>(event: string, opts?: { timeoutMs?: number; name?: string }): Promise<T>;
}

const FUNCTION_NAME = Symbol.for("ember.functionName");
export function handleOf(fn: FnRef): string {
  const name = typeof fn === "string" ? fn : (fn as Record<symbol, unknown>)[FUNCTION_NAME];
  if (typeof name !== "string") throw new Error("workflow step: expected a function reference (internal.mod.fn) or a function name");
  return name.startsWith("&") ? name : `&${name}`;
}

/**
 * Replays `handler` against `journal`. Steps are matched by position, kind and name (not by args or time).
 */
export async function replay(
  handler: (step: WorkflowStep, args: any) => Promise<unknown>,
  input: { workflowId: string; args: unknown; journal: JournalEntry[]; defaultRetry?: RetryPolicy },
): Promise<Outcome> {
  const journal = [...input.journal].sort((a, b) => a.index - b.index);
  let index = 0;
  let request: Outcome | null = null;
  /** Set on a journal mismatch: the run fails even if the handler catches the error. */
  let nondet: string | null = null;
  let signal!: (o: Outcome) => void;
  const blocked = new Promise<Outcome>((resolve) => (signal = resolve));
  const never = new Promise<never>(() => {});

  const next = <T>(req: StepRequest): Promise<T> => {
    if (request) return never; // already suspended (parallel branches are not supported yet)
    const i = index++;
    const rec = journal[i];
    if (!rec) {
      request = { type: "step", index: i, step: req };
      signal(request);
      return never;
    }
    if (rec.kind !== req.kind || rec.name !== req.name) {
      nondet = `step ${i}: the journal has ${rec.kind} "${rec.name}" but the workflow now asks for ${req.kind} "${req.name}"`;
      signal({ type: "failed", error: `NonDeterminism: ${nondet}` });
      throw new NonDeterminism(`step ${i}: the journal has ${rec.kind} "${rec.name}" but the workflow now asks for ${req.kind} "${req.name}"`);
    }
    if (rec.status === "pending") {
      request = { type: "waiting" };
      signal(request);
      return never;
    }
    if (rec.status === "failed") return Promise.reject(new StepFailed(rec.name, rec.error ?? "step failed"));
    return Promise.resolve(rec.result as T);
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
  const out = await Promise.race([run, blocked]);
  if (nondet) return { type: "failed", error: `NonDeterminism: ${nondet}` };
  // A handler that ignores a suspended step (no await) and finishes: the request wins (it must run first).
  return request ?? out;
}
