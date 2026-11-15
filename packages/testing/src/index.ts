// `@freecorps/ember-testing` (docs/design/dx.md §3.12): test an Ember app in Node, with the real engine over node:sqlite
// (no workerd, no network), typed through the generated `api`:
//
//   const t = emberTest({ schema, modules: { messages, rooms } });
//   const id = await t.mutation(api.messages.send, { roomId, body: "hi" });
//   expect(await t.query(api.messages.list, { roomId })).toHaveLength(1);
//   const e = await expectError(t.mutation(api.messages.send, { roomId, body: "" }), api.messages.send, "EmptyMessage");
//   await t.withIdentity({ subject: "ana" }).mutation(api.rooms.create, { name: "general" });
//   await t.finishScheduled();   // runs the jobs the mutations scheduled, in time order
//
// One shard per name (`<kind>:<key>`), created on first use: calls route like the client does (the function's routing
// argument or, for `fromAuth`, the claim of `withIdentity`'s identity, the `shard` option, else `defaultShard`). Actions run in-process with `ctx.runQuery` / `ctx.runMutation` /
// `ctx.runAction` / the scheduler / `ctx.env`; files, Vectorize, AI Search, images and the browser are not emulated.
// Components: pass `app` (`ember/ember.config.ts`'s default export) and they are composed in, as the Worker does.

import {
  checkAccess,
  checkShard,
  composeApp,
  createEngine,
  resolveReference,
  scopesOf,
  splitFunctionName,
  SYSTEM_AUTH,
  failApi,
  errorFromWire,
  errorInfo,
  flattenFunctions,
  getFunctionName,
  isAppError,
  matchRoute,
  type HttpRouter,
  isTriggersDefinition,
  type AnyRegisteredFunction,
  type AppDefinition,
  type Engine,
  type Identity,
  type GenericShards,
  type GenericTables,
  type Job,
  type Limits,
  type MutationCtx,
  type ScheduledFunction,
  type ScheduledFunctionState,
  type ScheduledReader,
  type SchemaDefinition,
  type TriggersDefinition,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import {
  FUNCTION_NAME,
  FUNCTION_SHARD,
  getFunctionShard,
  routeShard,
  withDefaults,
  validate,
  type AnyFunctionReference,
  type ArgsAndOptions,
  type ErrorSpec,
  type FunctionErrors,
  type FunctionReference,
  type ShardSpec,
  type Visibility,
} from "@freecorps/ember-values";

type Ref<T extends "query" | "mutation" | "action"> = FunctionReference<T, Visibility, object, unknown, ErrorSpec, ShardSpec | null>;
type Options = { shard?: string };

export interface EmberTestOptions {
  schema: SchemaDefinition<GenericTables, GenericShards>;
  /** The app's modules by path (`{ messages, "chat/rooms": rooms }`), as `import * as messages from "../ember/messages"`. */
  modules: Record<string, object>;
  /**
   * `ember/triggers.ts`'s default export (`defineTriggers({...})`). Default: `modules.triggers.default` when
   * `modules` has the triggers module (`import * as triggers from "../ember/triggers"`).
   */
  triggers?: TriggersDefinition;
  /** Shard of calls that name none and do not route. Default `global:main`. */
  defaultShard?: string;
  /** `ctx.env` of actions. */
  env?: Record<string, unknown>;
  /**
   * `ember/ember.config.ts`'s default export (`defineApp().use(component, ...)`): its components are composed in, and
   * actions resolve references from their own scope (a component's `"lib:x"`, `components.x.lib.y`, handles).
   */
  app?: AppDefinition;
  /** Start of the test clock (ms). Default: a fixed instant, so `_creationTime`s are reproducible. */
  now?: number;
  /** Project limits, as `defineApp({ limits })` (functions' own `limits` apply over them). */
  limits?: Partial<Limits>;
  /**
   * An outside clock instead of the harness's own (`() => Date.now()`, so vitest fake timers drive it): `now` is
   * ignored and `advance` throws (move your clock, then `runScheduled`). Used by `convexTest`.
   */
  clock?: () => number;
  /** Called with each job a call schedules (after the call returns), e.g. to arm a timer for it. */
  onSchedule?: (job: Job & { shard: string }) => void;
  /** `ember/http.ts`'s default export (`httpRouter()`), for `fetch`. */
  http?: HttpRouter;
}

/** An application error of `F`, as a test sees it (code and typed data). */
export type AppErrorOf<S> = S extends ErrorSpec<infer C, infer D> ? Error & { readonly kind: "app"; readonly code: C; readonly data: D } : never;

export interface EmberTest {
  query<Q extends Ref<"query">>(ref: Q, ...rest: ArgsAndOptions<Q, Options>): Promise<Q["_returnType"]>;
  mutation<M extends Ref<"mutation">>(ref: M, ...rest: ArgsAndOptions<M, Options>): Promise<M["_returnType"]>;
  action<A extends Ref<"action">>(ref: A, ...rest: ArgsAndOptions<A, Options>): Promise<A["_returnType"]>;
  /** The same harness (same data and clock) calling as `identity`. */
  withIdentity(identity: Identity | { subject: string; claims?: Record<string, unknown> }): EmberTest;
  /** Runs `fn` in a mutation on `shard` (default: the default shard): set up or inspect data directly. */
  run<R>(fn: (ctx: MutationCtx) => R, opts?: Options): Promise<R>;
  /** Jobs scheduled and not run yet, soonest first. */
  scheduled(): ReadonlyArray<Job & { shard: string }>;
  /** Advances the clock by `ms`, then runs the jobs due by then (and what they schedule, while due). */
  advance(ms: number): Promise<number>;
  /** Runs every scheduled job (the clock jumps to each), until none is left (at most `maxJobs`). Returns how many ran. */
  finishScheduled(maxJobs?: number): Promise<number>;
  /** Runs the scheduled job `id` now, if it is still pending (false: unknown, cancelled or already run). */
  runScheduled(id: string): Promise<boolean>;
  /**
   * Calls the app's HTTP routes (`EmberTestOptions.http`): `fetch("/webhook", { method: "POST", body })`. The path
   * may carry a query string; the origin is ignored. Runs the route's httpAction with this harness's identity.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The current test clock (ms). */
  now(): number;
  /** The engine of a shard (`migrate()`d), for anything else. */
  engine(shard?: string): Engine;
}

export function emberTest(options: EmberTestOptions): EmberTest {
  let own = options.now ?? 1_700_000_000_000;
  const external = options.clock;
  const now = (): number => (external ? external() : own);
  /** Moves the harness clock forward (no-op with an outside clock: it is the caller's). */
  const reach = (t: number) => {
    if (!external) own = Math.max(own, t);
  };
  const defaultShard = options.defaultShard ?? "global:main";
  const engines = new Map<string, Engine>();
  const composed = options.app ? composeApp({ schema: options.schema, functions: options.modules, app: options.app }) : null;
  const schema = composed?.schema ?? options.schema;
  const functions: object = composed?.functions ?? options.modules;
  const fns = flattenFunctions(functions);
  /** A reference as an action in `scope` names it (own scope, a direct child's public function, a handle). */
  const resolve = (scope: readonly string[], ref: unknown): string => {
    const r = resolveReference(scope, ref as AnyFunctionReference | string);
    if (r.via === "child") checkAccess(fns, r);
    return r.name;
  };
  const jobs: Array<Job & { shard: string }> = [];
  /** Every job scheduled so far and its state, for `ctx.scheduler.get/list` (kept for the whole test). */
  const history = new Map<string, ScheduledFunction & { shard: string }>();
  let seq = 0;
  const fromModules = (options.modules.triggers as { default?: unknown } | undefined)?.default;
  const triggers = options.triggers ?? (isTriggersDefinition(fromModules) ? fromModules : undefined);
  const setState = (id: string, state: ScheduledFunctionState) => {
    const h = history.get(id);
    if (!h) return;
    const done = state.kind === "success" || state.kind === "failed" || state.kind === "canceled";
    history.set(id, { ...h, state, ...(done ? { completedTime: now() } : {}), ...(state.kind === "inProgress" ? { attempts: h.attempts + 1 } : {}) });
  };
  const readerOf = (shard: string): ScheduledReader => ({
    get: (id) => {
      const h = history.get(id);
      if (!h || h.shard !== shard) return null;
      const { shard: _s, ...job } = h;
      return structuredClone(job);
    },
    list: ({ state, limit }) =>
      [...history.values()]
        .filter((h) => h.shard === shard && (!state || h.state.kind === state))
        .slice(0, limit)
        .map(({ shard: _s, ...job }) => structuredClone(job)),
  });

  const engineOf = (shard: string): Engine => {
    let e = engines.get(shard);
    if (!e) {
      e = createEngine({
        schema,
        functions,
        driver: createNodeSqliteDriver(),
        now,
        random: seeded(++seq),
        shardName: () => shard,
        ...(triggers ? { triggers } : {}),
        scheduledFunctions: readerOf(shard),
        ...(options.limits ? { limits: options.limits } : {}),
      });
      e.migrate();
      engines.set(shard, e);
    }
    return e;
  };

  const shardOf = (ref: AnyFunctionReference | string, args: unknown, explicit: string | undefined, identity: Identity | null): string => {
    const name = getFunctionName(ref);
    // A reference by name routes by the registered function's `fromAuth` claim too.
    const own = fns.get(name);
    const spec = (typeof ref === "string" ? undefined : getFunctionShard(ref)) ?? (own && own.type !== "httpAction" && own.shard?.fromClaim !== undefined ? own.shard : undefined);
    const s = routeShard({ [FUNCTION_NAME]: name, [FUNCTION_SHARD]: spec } as unknown as AnyFunctionReference, args, explicit, defaultShard, identity?.claims);
    if (!s) {
      if (spec?.fromClaim !== undefined) {
        if (!identity) throw errorFromWire({ code: "Unauthenticated", message: `${name} runs in the "${spec.kind}" shard of the caller's ${spec.fromClaim} claim: not signed in (withIdentity)` });
        throw errorFromWire({ code: "WrongShard", message: `${name} runs in the "${spec.kind}" shard of the caller's ${spec.fromClaim} claim, and the identity has none`, data: { expected: spec.kind, shard: null } });
      }
      throw new Error(`${name} runs in "${spec?.kind}" shards: pass { shard: "${spec?.kind}:<key>" }`);
    }
    return s;
  };

  /** Rethrows engine errors as they would reach a client (code, data, kind). */
  const asClientError = (e: unknown): never => {
    throw errorFromWire(errorInfo(e));
  };

  const queue = (shard: string, scheduled: Job[], cancelled: string[]) => {
    for (const id of cancelled) {
      const i = jobs.findIndex((j) => j.id === id);
      if (i >= 0) {
        jobs.splice(i, 1);
        setState(id, { kind: "canceled" });
      }
    }
    for (const j of scheduled) {
      jobs.push({ ...j, shard });
      history.set(j.id, { id: j.id, _creationTime: now(), name: j.fn, args: j.args, scheduledTime: j.runAt, state: { kind: "pending" }, attempts: 0, shard });
    }
    if (options.onSchedule) for (const j of scheduled) options.onSchedule({ ...j, shard });
    jobs.sort((a, b) => a.runAt - b.runAt);
  };

  /** `system`: the harness's scheduled jobs (no identity, no `fromAuth` claim check, as in the runtime). */
  const make = (identity: Identity | null, system = false): EmberTest => {
    const auth = identity ? { identity } : system ? SYSTEM_AUTH : undefined;

    const runQuery = (name: AnyFunctionReference | string, args: unknown, shard: string) => {
      try {
        return engineOf(shard).runQuery(name as never, args ?? {}, auth).value;
      } catch (e) {
        return asClientError(e);
      }
    };
    const runMutation = (name: AnyFunctionReference | string, args: unknown, shard: string) => {
      let r;
      try {
        r = engineOf(shard).runMutation(name as never, args ?? {}, auth);
      } catch (e) {
        return asClientError(e);
      }
      queue(shard, r.scheduled, r.cancelled);
      return r.value;
    };
    const runAction = async (name: string, args: unknown, shard: string, internal: boolean): Promise<unknown> => {
      const f = fns.get(name) as AnyRegisteredFunction | undefined;
      if (!f || f.type !== "action" || (!internal && f.visibility !== "public")) throw errorFromWire({ code: "FunctionNotFound", message: `Function ${name} not found` });
      const a = withDefaults(f.args, args ?? {});
      const r = validate(f.args, a);
      if (!r.ok) throw errorFromWire({ code: "ValidationError", message: `Invalid arguments for ${name}: ${r.path}: ${r.message}`, data: { path: r.path, issues: [{ path: r.path, message: r.message }] } });
      try {
        checkShard(name, f.shard, shard, a, auth);
        return await f.handler({ ...actionCtx(shard, splitFunctionName(name).path), fail: failApi(f) }, a);
      } catch (e) {
        return asClientError(e);
      }
    };
    const schedule = (shard: string, scope: readonly string[], runAt: number, ref: unknown, args: unknown) => {
      const name = resolve(scope, ref);
      const f = fns.get(name);
      if (!f || (f.type !== "mutation" && f.type !== "action")) throw new Error(`Cannot schedule ${name}: not a mutation or action`);
      const id = `job_test_${++seq}`;
      queue(shard, [{ id, fn: name, args: args ?? {}, runAt, kind: f.type }], []);
      return id;
    };
    const actionCtx = (shard: string, scope: readonly string[] = []): Record<string, unknown> => {
      const handle = (s: string) => ({
        shard: s,
        runQuery: async (ref: AnyFunctionReference, args?: unknown) => runQuery(resolve(scope, ref), args, s),
        runMutation: async (ref: AnyFunctionReference, args?: unknown) => runMutation(resolve(scope, ref), args, s),
        scheduler: {
          runAfter: async (ms: number, ref: unknown, args?: unknown) => schedule(s, scope, now() + Math.max(0, ms), ref, args),
          runAt: async (ts: number | Date, ref: unknown, args?: unknown) => schedule(s, scope, ts instanceof Date ? ts.getTime() : ts, ref, args),
          cancel: async (id: string) => {
            const i = jobs.findIndex((j) => j.id === id && j.shard === s);
            if (i >= 0) {
              jobs.splice(i, 1);
              setState(id, { kind: "canceled" });
            }
            return i >= 0;
          },
          get: async (id: string) => readerOf(s).get(id),
          list: async (o: { state?: ScheduledFunctionState["kind"]; limit?: number } = {}) => readerOf(s).list({ ...(o.state ? { state: o.state } : {}), limit: o.limit ?? 100 }),
        },
      });
      return {
        ...handle(shard),
        onShard: (s: string) => handle(s),
        runAction: async (ref: AnyFunctionReference, args?: unknown) => runAction(resolve(scope, ref), args, shard, true),
        ...(scope.length ? { component: { name: scope.join("/"), config: scopesOf(schema).scope(scope)?.config } } : {}),
        auth: {
          getUserIdentity: async () => identity,
          require: async () => {
            if (!identity) throw errorFromWire({ code: "Unauthenticated", message: "Not signed in" });
            return identity;
          },
        },
        env: { ...(options.env ?? {}) },
        now: now(),
        storage: unsupported("ctx.storage"),
        images: unsupported("ctx.images"),
        browser: unsupported("ctx.browser"),
        vectorSearch: () => Promise.reject(new Error("ctx.vectorSearch is not emulated by @freecorps/ember-testing")),
        aiSearch: () => Promise.reject(new Error("ctx.aiSearch is not emulated by @freecorps/ember-testing")),
      };
    };

    const split = (rest: unknown[]) => ({ args: (rest[0] ?? {}) as Record<string, unknown>, opts: rest[1] as Options | undefined });

    const runJob = async (j: Job & { shard: string }) => {
      const i = jobs.indexOf(j);
      if (i >= 0) jobs.splice(i, 1);
      reach(j.runAt);
      const system = make(null, true);
      setState(j.id, { kind: "inProgress" });
      try {
        if (j.kind === "mutation") await system.mutation(namedRef<"mutation">(j.fn), j.args as Record<string, unknown>, { shard: j.shard });
        else await (system as unknown as { _action(name: string, args: unknown, shard: string): Promise<unknown> })._action(j.fn, j.args, j.shard);
      } catch (e) {
        setState(j.id, { kind: "failed", error: `${(e as { code?: string }).code ?? "Error"}: ${(e as Error)?.message ?? String(e)}` });
        throw e;
      }
      setState(j.id, { kind: "success" });
    };

    const t: EmberTest & { _action(name: string, args: unknown, shard: string): Promise<unknown> } = {
      async query(ref, ...rest) {
        const { args, opts } = split(rest);
        return runQuery(ref, args, shardOf(ref, args, opts?.shard, identity));
      },
      async mutation(ref, ...rest) {
        const { args, opts } = split(rest);
        return runMutation(ref, args, shardOf(ref, args, opts?.shard, identity));
      },
      async action(ref, ...rest) {
        const { args, opts } = split(rest);
        return runAction(getFunctionName(ref), args, shardOf(ref, args, opts?.shard, identity), false);
      },
      _action: (name, args, shard) => runAction(name, args, shard, true),
      withIdentity: (id) => make({ ...id } as Identity),
      async run(fn, opts) {
        const shard = opts?.shard ?? defaultShard;
        // A callback that returns a Promise (`async (ctx) => { await ctx.db.insert(...) }`, as Convex tests write it):
        // what runs before its first real await is the mutation; the rest runs after the commit, each statement on
        // its own (fine for setup and inspection, not atomic). Jobs it schedules are queued once it settles.
        let pending: PromiseLike<unknown> | undefined;
        const inline = {
          [Symbol.for("ember.function")]: true,
          type: "mutation",
          visibility: "internal",
          args: { kind: "object", fields: {} },
          handler: (ctx: MutationCtx) => {
            const out = fn(ctx);
            if (out && typeof (out as { then?: unknown }).then === "function") {
              pending = out as unknown as PromiseLike<unknown>;
              return undefined;
            }
            return out;
          },
        };
        const r = engineOf(shard).runMutation(inline as never, {}, auth);
        if (!pending) {
          queue(shard, r.scheduled, r.cancelled);
          return r.value as never;
        }
        try {
          return (await pending) as never;
        } finally {
          // The engine hands back its own lists: what the callback scheduled after the commit is in them too.
          queue(shard, r.scheduled, r.cancelled);
        }
      },
      scheduled: () => [...jobs],
      async advance(ms) {
        if (external) throw new Error("advance(): this harness reads an outside clock (options.clock): move it, then runScheduled(id)");
        const until = own + ms;
        let n = 0;
        while (jobs.length && jobs[0]!.runAt <= until) {
          await runJob(jobs[0]!);
          n++;
        }
        reach(until);
        return n;
      },
      async finishScheduled(maxJobs = 1000) {
        let n = 0;
        while (jobs.length) {
          if (n >= maxJobs) throw new Error(`finishScheduled: more than ${maxJobs} jobs (a job that always reschedules itself?)`);
          await runJob(jobs[0]!);
          n++;
        }
        return n;
      },
      async runScheduled(id) {
        const j = jobs.find((x) => x.id === id);
        if (!j) return false;
        await runJob(j);
        return true;
      },
      async fetch(path, init) {
        const router = options.http;
        if (!router) throw new Error("fetch(): pass the app's http router (emberTest({ http }) / convexTest's `http` module)");
        const url = new URL(path, "http://ember.test");
        const request = new Request(url, init);
        const hit = matchRoute(router.routes, request.method, url.pathname);
        if (!hit) return new Response(JSON.stringify({ ok: false, error: { code: "not_found", message: "not found" } }), { status: 404, headers: { "content-type": "application/json" } });
        if ("methodMismatch" in hit) return new Response(JSON.stringify({ ok: false, error: { code: "method_not_allowed", message: `${request.method} is not allowed on ${url.pathname}` } }), { status: 405 });
        const route = hit.route;
        const shard = typeof route.shard === "function" ? route.shard(request) : (route.shard ?? defaultShard);
        const res = await route.handler.handler(actionCtx(shard) as never, request);
        if (!(res instanceof Response)) throw new Error(`fetch(): ${route.method} ${url.pathname} did not return a Response`);
        return res;
      },
      now,
      engine: (shard = defaultShard) => engineOf(shard),
    };
    return t;
  };

  return make(null);
}

/**
 * Awaits `p`, expects it to reject with the application error `code` of `fn`, and returns it typed:
 * `const e = await expectError(t.mutation(api.x.y, args), api.x.y, "TooLong"); e.data.max`.
 */
export async function expectError<F extends AnyFunctionReference, const C extends FunctionErrors<F>["code"]>(
  p: Promise<unknown>,
  _fn: F,
  code: C,
): Promise<AppErrorOf<Extract<FunctionErrors<F>, { code: C }>>> {
  let value: unknown;
  try {
    value = await p;
  } catch (e) {
    if (isAppError(e) && e.code === code) return e as never;
    const got = isAppError(e) ? `application error ${e.code}` : `${(e as { code?: string })?.code ?? "error"}: ${(e as Error)?.message ?? String(e)}`;
    throw new Error(`expected application error ${code}, got ${got}`);
  }
  throw new Error(`expected application error ${code}, but the call returned ${JSON.stringify(value)}`);
}

function namedRef<T extends "query" | "mutation" | "action">(name: string): FunctionReference<T, Visibility, Record<string, unknown>, unknown> {
  return { [Symbol.for("ember.functionName")]: name } as unknown as FunctionReference<T, Visibility, Record<string, unknown>, unknown>;
}

function unsupported(what: string) {
  return new Proxy({}, { get: () => () => Promise.reject(new Error(`${what} is not emulated by @freecorps/ember-testing (use the workerd tests for it)`)) });
}

function seeded(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}
