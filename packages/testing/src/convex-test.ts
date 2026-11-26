// `@freecorps/ember-testing/convex-test` (PLAN §22 L8): the `convex-test` API over `emberTest`, so a Convex test
// suite ports almost mechanically. Same names and the same timer model:
//
//   import { convexTest } from "@freecorps/ember-testing/convex-test";
//   const t = convexTest(schema, import.meta.glob("../ember/**/*.ts"));
//   await t.mutation(api.messages.send, { body: "hi" });
//   const asSarah = t.withIdentity({ name: "Sarah" });
//   vi.useFakeTimers();
//   await t.mutation(api.jobs.later, {});           // schedules something in 10 s
//   vi.advanceTimersByTime(10_000);                  // its timer fires: the job starts
//   await t.finishInProgressScheduledFunctions();    // ...and is awaited
//   await t.finishAllScheduledFunctions(vi.runAllTimers);
//
// Differences from convex-test (docs/design/contracts.md "Testes"):
// - the db API is synchronous (PLAN D6): `await ctx.db.get(id)` still works (awaiting a value), but handlers must
//   be; `t.run(async (ctx) => ...)` runs up to its first real `await` inside the mutation, the rest after it;
// - one shard per name (`<kind>:<key>`), as in `emberTest`: calls route by the function's shard argument, else
//   `global:main`;
// - files are in memory (`ctx.storage.store/get/getUrl/getMetadata/delete` in actions, as `emberTest`); Convex
//   components (`registerComponent`) are not emulated: pass Ember components as `app`; `ctx.db.system` does not
//   exist (`ctx.scheduler.get/list`, `ctx.storage.getMetadata`);
// - identities: `withIdentity({ subject, issuer, tokenIdentifier, name, email, ...claims })` becomes an Ember
//   identity `{ subject, issuer, claims: { tokenIdentifier, name, email, ...claims } }` (the shape the server sees).

import type { AppDefinition, GenericShards, GenericTables, HttpRouter, Identity, Limits, MutationCtx, ReplicaTableSpec, SchedulerReader, SchemaDefinition, TriggersDefinition } from "@freecorps/ember-server";
import type { ArgsAndOptions, ErrorSpec, FunctionReference, ShardSpec, Visibility } from "@freecorps/ember-values";
import { emberTest, type EmberTest } from "./index.ts";

type Ref<T extends "query" | "mutation" | "action"> = FunctionReference<T, Visibility, object, unknown, ErrorSpec, ShardSpec | null>;
type Options = { shard?: string };

/**
 * The app's modules: `import.meta.glob("../ember/**\/*.ts")` (lazy loaders by path, what convex-test takes), or
 * loaded modules by path (`{ messages, "chat/rooms": rooms }`).
 */
export type ConvexTestModules = Record<string, object | (() => Promise<unknown>)>;

/** convex-test's `withIdentity` argument: the `UserIdentity` fields, all optional, plus custom claims. */
export type TestIdentity = {
  subject?: string;
  issuer?: string;
  tokenIdentifier?: string;
  name?: string;
  email?: string;
  [claim: string]: unknown;
};

/** `ctx` of `t.run`: a mutation's (synchronous db, scheduler, storage reads). */
export type TestRunCtx = MutationCtx & { scheduler: SchedulerReader & MutationCtx["scheduler"] };

export interface TestConvex {
  query<Q extends Ref<"query">>(ref: Q, ...rest: ArgsAndOptions<Q, Options>): Promise<Q["_returnType"]>;
  mutation<M extends Ref<"mutation">>(ref: M, ...rest: ArgsAndOptions<M, Options>): Promise<M["_returnType"]>;
  action<A extends Ref<"action">>(ref: A, ...rest: ArgsAndOptions<A, Options>): Promise<A["_returnType"]>;
  /** Runs `fn` in a mutation (set up or inspect data). An async `fn` is awaited (see the module notes). */
  run<R>(fn: (ctx: TestRunCtx) => R | Promise<R>, opts?: Options): Promise<R>;
  /** The same backend, calling as this identity. */
  withIdentity(identity: TestIdentity): TestConvex;
  /** The app's HTTP routes (`http` module's default export): `t.fetch("/webhook", { method: "POST", body })`. */
  fetch(pathQueryFragment: string, init?: RequestInit): Promise<Response>;
  /** Waits for the scheduled functions that already started (their timers fired), and what they start meanwhile. */
  finishInProgressScheduledFunctions(): Promise<void>;
  /**
   * Runs scheduled functions until none is left: `advanceTimers` (e.g. `vi.runAllTimers`) fires the due timers, then
   * the started ones are awaited, `maxIterations` times at most (throws past it: a job that always reschedules).
   */
  finishAllScheduledFunctions(advanceTimers: () => void, maxIterations?: number): Promise<void>;
  /** The `emberTest` underneath (`scheduled()`, `engine(shard)`, ...), once the modules are loaded. */
  ember(): Promise<EmberTest>;
  /**
   * Clears the timers of jobs not run yet (a job's timer that fires afterwards runs nothing) and closes the harness
   * underneath (`EmberTest.close`: its SQLite databases); later calls throw. E.g. `afterEach(() => t.close())`.
   * Timers never keep the process alive (`unref`). Also `using t = ...`, or `await using` to wait for the scheduled
   * functions already in progress first.
   */
  close(): void;
  [Symbol.dispose](): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface ConvexTestOptions {
  /** Shard of calls that name none and do not route. Default `global:main`. */
  defaultShard?: string;
  /** `ctx.env` of actions. */
  env?: Record<string, unknown>;
  /** `ember/ember.config.ts`'s default export: its components are composed in (`EmberTestOptions.app`). */
  app?: AppDefinition;
  /** `ember/triggers.ts`'s default export. Default: the `triggers` module's, when `modules` has it. */
  triggers?: TriggersDefinition;
  /** Replica tables (`EmberTestOptions.replicas`), e.g. `authReplicaTables(authConfig)`. */
  replicas?: ReplicaTableSpec[];
  /** Project limits, as `defineApp({ limits })`. */
  limits?: Partial<Limits>;
}

/** Module paths that are not function modules. */
const SKIP = /(^|\/)(_generated\/|schema$|crons$|auth\.config$|convex\.config$|ember\.config$|[^/]*\.(test|spec)$)/;

/**
 * Module path → function module path: the extension goes, and the folder the paths share (the one holding
 * `_generated/` when there is one), so `"../ember/chat/rooms.ts"` becomes `"chat/rooms"`.
 */
export function modulePaths(keys: readonly string[]): Map<string, string> {
  const clean = keys.map((k) => k.replace(/\\/g, "/").replace(/\.(m|c)?(t|j)sx?$/, ""));
  let root = "";
  const gen = clean.find((k) => k.includes("_generated/"));
  if (gen) root = gen.slice(0, gen.indexOf("_generated/"));
  else if (clean.length) {
    const dirs = clean.map((k) => k.slice(0, k.lastIndexOf("/") + 1));
    root = dirs.reduce((a, b) => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return a.slice(0, a.lastIndexOf("/", i - 1) + 1);
    });
  }
  const out = new Map<string, string>();
  keys.forEach((k, i) => {
    const c = clean[i]!;
    const name = c.startsWith(root) ? c.slice(root.length) : c.replace(/^(\.\.?\/)+/, "");
    out.set(k, name);
  });
  return out;
}

/** convex-test's `withIdentity` defaults: issuer `https://convex.test`, a subject derived from the fields. */
export function toIdentity(i: TestIdentity): Identity {
  const { subject, issuer, tokenIdentifier, ...rest } = i;
  const sub = subject ?? `test_${hash(JSON.stringify(i))}`;
  const iss = issuer ?? "https://convex.test";
  return { subject: sub, issuer: iss, claims: { tokenIdentifier: tokenIdentifier ?? `${iss}|${sub}`, ...rest } };
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * convex-test's `convexTest(schema, modules)` over `emberTest`: the real engine over node:sqlite, the clock is
 * `Date.now()` (vitest fake timers move it) and each scheduled job gets a `setTimeout` at its time, as in
 * convex-test. Failed scheduled functions are marked `failed` (`ctx.scheduler.get`) and do not throw here.
 */
export function convexTest(schema: SchemaDefinition<GenericTables, GenericShards>, modules: ConvexTestModules = {}, opts: ConvexTestOptions = {}): TestConvex {
  const inProgress = new Set<Promise<void>>();
  let base: EmberTest | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  const close = () => {
    closed = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    base?.close();
  };
  const start = (id: string) => {
    // Started on the next microtask, not inside the timer callback: `vi.runAllTimers()` then fires only the timers
    // that exist now, and the timers the job arms wait for the next round (as in convex-test).
    const p: Promise<void> = Promise.resolve()
      .then(() => base!.runScheduled(id))
      .then(
        () => undefined,
        () => undefined, // recorded as `failed` by emberTest
      )
      .finally(() => inProgress.delete(p));
    inProgress.add(p);
  };
  const loading = (async () => {
    const paths = modulePaths(Object.keys(modules));
    const loaded: Record<string, object> = {};
    let http: HttpRouter | undefined;
    for (const [key, m] of Object.entries(modules)) {
      const name = paths.get(key)!;
      if (SKIP.test(name)) continue;
      const mod = (typeof m === "function" ? await (m as () => Promise<unknown>)() : m) as Record<string, unknown>;
      if (name === "http") {
        http = mod.default as HttpRouter | undefined;
        continue;
      }
      loaded[name] = mod;
    }
    base = emberTest({
      schema,
      modules: loaded,
      clock: () => Date.now(),
      ...(http ? { http } : {}),
      ...(opts.defaultShard ? { defaultShard: opts.defaultShard } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.app ? { app: opts.app } : {}),
      ...(opts.triggers ? { triggers: opts.triggers } : {}),
      ...(opts.replicas ? { replicas: opts.replicas } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      onSchedule: (job) => {
        if (closed) return;
        const timer = setTimeout(() => {
          timers.delete(timer);
          // A cancelled job is gone from `scheduled()`: its timer starts nothing (runScheduled would be a no-op).
          if (closed || !base!.scheduled().some((j) => j.id === job.id)) return;
          start(job.id);
        }, Math.max(0, job.runAt - Date.now()));
        // A real timer of a job far ahead never holds the test process open (fake timers have no unref).
        (timer as { unref?: () => void }).unref?.();
        timers.add(timer);
      },
    });
    if (closed) base.close();
    return base;
  })();

  const finishInProgress = async () => {
    while (inProgress.size) await Promise.all([...inProgress]);
  };

  const make = (identity: Identity | null): TestConvex => {
    const as = async () => {
      const t = await loading;
      return identity ? t.withIdentity(identity) : t;
    };
    return {
      query: (async (ref: Ref<"query">, ...rest: unknown[]) => ((await as()).query as (...a: unknown[]) => Promise<unknown>)(ref, ...rest)) as TestConvex["query"],
      mutation: (async (ref: Ref<"mutation">, ...rest: unknown[]) => ((await as()).mutation as (...a: unknown[]) => Promise<unknown>)(ref, ...rest)) as TestConvex["mutation"],
      action: (async (ref: Ref<"action">, ...rest: unknown[]) => ((await as()).action as (...a: unknown[]) => Promise<unknown>)(ref, ...rest)) as TestConvex["action"],
      run: async (fn, o) => (await as()).run((ctx) => fn(ctx as TestRunCtx), o) as never,
      withIdentity: (i) => make(toIdentity(i)),
      fetch: async (path, init) => (await as()).fetch(path, init),
      finishInProgressScheduledFunctions: async () => {
        await loading;
        await finishInProgress();
      },
      finishAllScheduledFunctions: async (advanceTimers, maxIterations = 100) => {
        const t = await loading;
        for (let i = 0; i < maxIterations; i++) {
          advanceTimers();
          await finishInProgress();
          if (!t.scheduled().length && !inProgress.size) return;
        }
        throw new Error(`finishAllScheduledFunctions: scheduled functions still pending after ${maxIterations} rounds (a job that always reschedules itself, or timers not faked: call vi.useFakeTimers())`);
      },
      ember: () => loading,
      close,
      [Symbol.dispose]: close,
      async [Symbol.asyncDispose]() {
        // A harness closed while its modules still load closes once they are.
        await loading.catch(() => undefined);
        await finishInProgress();
        close();
      },
    };
  };
  return make(null);
}
