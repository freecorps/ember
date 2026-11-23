// A one-shard harness over the real engine (node:sqlite) with a scheduler that behaves like the runtime's where the
// workpool cares: mutation jobs run in the engine, action jobs run **concurrently** (each one started when due and not
// awaited), `ctx.scheduler.get` sees every job's state, and a test can lose or redeliver a job (a crash, an expired
// lease) or move the clock.
import {
  checkAccess,
  composeApp,
  createEngine,
  resolveReference,
  splitFunctionName,
  type AnyRegisteredFunction,
  type AppDefinition,
  type Job,
  type RegisteredHttpAction,
  type ScheduledFunction,
  type ScheduledFunctionState,
  type SchemaDefinition,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";

export const T0 = 1_700_000_000_000;

type Entry = { job: Job; state: ScheduledFunctionState; attempts: number; created: number };

export function harness(input: { schema: SchemaDefinition<any, any>; functions: Record<string, object>; app: AppDefinition<any> }) {
  let now = T0;
  const composed = composeApp({ schema: input.schema, functions: input.functions, app: input.app });
  const driver = createNodeSqliteDriver();
  const history = new Map<string, Entry>();
  const asScheduled = (e: Entry): ScheduledFunction => ({
    id: e.job.id,
    _creationTime: e.created,
    name: e.job.fn,
    args: e.job.args,
    scheduledTime: e.job.runAt,
    state: e.state,
    attempts: e.attempts,
  });
  const engine = createEngine({
    schema: composed.schema,
    functions: composed.functions,
    driver,
    now: () => now,
    scheduledFunctions: {
      get: (id) => {
        const e = history.get(id);
        return e ? structuredClone(asScheduled(e)) : null;
      },
      list: ({ state, limit }) => [...history.values()].filter((e) => !state || e.state.kind === state).slice(0, limit).map(asScheduled),
    },
  });
  engine.migrate();
  const fns = new Map(Object.entries(composed.functions)) as Map<string, AnyRegisteredFunction | RegisteredHttpAction>;
  const inflight = new Map<Promise<void>, string>();

  /** What every mutation and query used (engine `usage`), and the jobs scheduled per function. */
  const counters = { rowsRead: 0, rowsWritten: 0, scheduled: {} as Record<string, number> };
  const record = (r: { scheduled: Job[]; cancelled: string[] }) => {
    for (const j of r.scheduled) counters.scheduled[j.fn] = (counters.scheduled[j.fn] ?? 0) + 1;
    for (const j of r.scheduled) history.set(j.id, { job: j, state: { kind: "pending" }, attempts: 0, created: now });
    for (const id of r.cancelled) {
      const e = history.get(id);
      if (e && e.state.kind === "pending") e.state = { kind: "canceled" };
    }
  };
  const mutate = (name: string, args: unknown = {}) => {
    const r = engine.runMutation(name, args);
    counters.rowsRead += r.usage?.rowsRead ?? 0;
    counters.rowsWritten += r.usage?.rowsWritten ?? 0;
    record(r);
    return r.value;
  };
  const query = (name: string, args: unknown = {}) => {
    const r = engine.runQuery(name, args);
    counters.rowsRead += r.usage?.rowsRead ?? 0;
    return r.value;
  };
  const ctxFor = (name: string) => {
    const path = splitFunctionName(name).path;
    const res = (ref: unknown) => {
      const r = resolveReference(path, ref as string);
      checkAccess(fns, r);
      return r.name;
    };
    return {
      runQuery: async (ref: unknown, a?: unknown) => query(res(ref), a ?? {}),
      runMutation: async (ref: unknown, a?: unknown) => mutate(res(ref), a ?? {}),
      runAction: async (ref: unknown, a?: unknown) => runAction(res(ref), a ?? {}),
      env: {},
      now,
    };
  };
  const runAction = async (name: string, args: unknown): Promise<unknown> => {
    const f = fns.get(name);
    if (!f || f.type !== "action") throw new Error(`not an action: ${name}`);
    return f.handler(ctxFor(name), args);
  };

  /** Runs one job (an action job is started, not awaited). */
  const start = (e: Entry) => {
    e.state = { kind: "inProgress" };
    e.attempts++;
    if (e.job.kind === "mutation") {
      try {
        mutate(e.job.fn, e.job.args);
        e.state = { kind: "success" };
      } catch (err) {
        e.state = { kind: "failed", error: String(err) };
      }
      return;
    }
    const p: Promise<void> = runAction(e.job.fn, e.job.args).then(
      () => {
        if (e.state.kind === "inProgress") e.state = { kind: "success" };
      },
      (err) => {
        if (e.state.kind === "inProgress") e.state = { kind: "failed", error: String(err) };
      },
    );
    const tracked = p.finally(() => inflight.delete(tracked));
    inflight.set(tracked, e.job.id);
  };

  const due = () => [...history.values()].filter((e) => e.state.kind === "pending" && e.job.runAt <= now).sort((a, b) => a.job.runAt - b.job.runAt);
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };

  return {
    engine,
    counters,
    resetCounters: () => Object.assign(counters, { rowsRead: 0, rowsWritten: 0, scheduled: {} }),
    mutate,
    query,
    history,
    now: () => now,
    advance: (ms: number) => (now += ms),
    sql: (s: string) => driver.exec(s).rows,
    /** Starts every due job (and what they schedule, while due), then lets started actions reach their next await. */
    async runDue(limit = 1000) {
      for (let n = 0; ; n++) {
        if (n > limit) throw new Error("runDue: too many jobs");
        await flush();
        const next = due()[0];
        if (!next) return;
        start(next);
      }
    },
    /** Waits for every started action to finish. */
    async idle() {
      while (inflight.size) await Promise.all([...inflight.keys()]);
      await flush();
    },
    pendingJobs: () => [...history.values()].filter((e) => e.state.kind === "pending").map((e) => e.job),
    /** Runs a job again as the scheduler does when its lease runs out (same id, same args). */
    redeliver(id: string) {
      const e = history.get(id);
      if (!e) throw new Error(`no job ${id}`);
      start(e);
    },
    /** The job's args as a Queue message carries them (plain JSON: -0 becomes 0). */
    jsonArgs(id: string) {
      const e = history.get(id);
      if (!e) throw new Error(`no job ${id}`);
      e.job = { ...e.job, args: JSON.parse(JSON.stringify(e.job.args)) };
    },
    /** Stops waiting for a job's runs (they hang forever: a dead Worker). */
    abandon(id: string) {
      for (const [p, j] of inflight) if (j === id) inflight.delete(p);
    },
    /** The scheduler lost track of a job: it reads as `state` (or vanishes with null). */
    setJob(id: string, state: ScheduledFunctionState | null) {
      if (state === null) history.delete(id);
      else history.get(id)!.state = state;
    },
  };
}

/** A gate actions wait on, so a test decides when each in-flight call returns. */
export function gates() {
  const waiting: Array<() => void> = [];
  return {
    wait: () => new Promise<void>((r) => waiting.push(r)),
    get waiting() {
      return waiting.length;
    },
    releaseAll() {
      for (const r of waiting.splice(0)) r();
    },
    releaseOne() {
      waiting.shift()?.();
    },
  };
}
