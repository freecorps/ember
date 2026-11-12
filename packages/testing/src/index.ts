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
// argument, the `shard` option, else `defaultShard`). Actions run in-process with `ctx.runQuery` / `ctx.runMutation` /
// `ctx.runAction` / the scheduler / `ctx.env`; files, Vectorize, AI Search, images and the browser are not emulated.

import {
  checkShard,
  createEngine,
  failApi,
  errorFromWire,
  errorInfo,
  flattenFunctions,
  getFunctionName,
  isAppError,
  type AnyRegisteredFunction,
  type Engine,
  type Identity,
  type GenericShards,
  type GenericTables,
  type Job,
  type MutationCtx,
  type SchemaDefinition,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import {
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
  /** Shard of calls that name none and do not route. Default `global:main`. */
  defaultShard?: string;
  /** `ctx.env` of actions. */
  env?: Record<string, unknown>;
  /** Start of the test clock (ms). Default: a fixed instant, so `_creationTime`s are reproducible. */
  now?: number;
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
  /** The current test clock (ms). */
  now(): number;
  /** The engine of a shard (`migrate()`d), for anything else. */
  engine(shard?: string): Engine;
}

export function emberTest(options: EmberTestOptions): EmberTest {
  let clock = options.now ?? 1_700_000_000_000;
  const defaultShard = options.defaultShard ?? "global:main";
  const engines = new Map<string, Engine>();
  const fns = flattenFunctions(options.modules);
  const jobs: Array<Job & { shard: string }> = [];
  let seq = 0;

  const engineOf = (shard: string): Engine => {
    let e = engines.get(shard);
    if (!e) {
      e = createEngine({ schema: options.schema, functions: options.modules, driver: createNodeSqliteDriver(), now: () => clock, random: seeded(++seq), shardName: () => shard });
      e.migrate();
      engines.set(shard, e);
    }
    return e;
  };

  const shardOf = (ref: AnyFunctionReference | string, args: unknown, explicit?: string): string => {
    const s = routeShard(typeof ref === "string" ? { [Symbol.for("ember.functionName")]: ref } as unknown as AnyFunctionReference : ref, args, explicit, defaultShard);
    if (!s) {
      const spec = typeof ref === "string" ? undefined : getFunctionShard(ref);
      throw new Error(`${getFunctionName(ref)} runs in "${spec?.kind}" shards: pass { shard: "${spec?.kind}:<key>" }`);
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
      if (i >= 0) jobs.splice(i, 1);
    }
    for (const j of scheduled) jobs.push({ ...j, shard });
    jobs.sort((a, b) => a.runAt - b.runAt);
  };

  const make = (identity: Identity | null): EmberTest => {
    const auth = identity ? { identity } : undefined;

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
        checkShard(name, f.shard, shard, a);
        return await f.handler({ ...actionCtx(shard), fail: failApi(f) }, a);
      } catch (e) {
        return asClientError(e);
      }
    };
    const schedule = (shard: string, runAt: number, ref: unknown, args: unknown) => {
      const name = getFunctionName(ref as AnyFunctionReference | string);
      const f = fns.get(name);
      if (!f || (f.type !== "mutation" && f.type !== "action")) throw new Error(`Cannot schedule ${name}: not a mutation or action`);
      const id = `job_test_${++seq}`;
      queue(shard, [{ id, fn: name, args: args ?? {}, runAt, kind: f.type }], []);
      return id;
    };
    const actionCtx = (shard: string): Record<string, unknown> => {
      const handle = (s: string) => ({
        shard: s,
        runQuery: async (ref: AnyFunctionReference, args?: unknown) => runQuery(ref, args, s),
        runMutation: async (ref: AnyFunctionReference, args?: unknown) => runMutation(ref, args, s),
        scheduler: {
          runAfter: async (ms: number, ref: unknown, args?: unknown) => schedule(s, clock + Math.max(0, ms), ref, args),
          runAt: async (ts: number | Date, ref: unknown, args?: unknown) => schedule(s, ts instanceof Date ? ts.getTime() : ts, ref, args),
          cancel: async (id: string) => {
            const i = jobs.findIndex((j) => j.id === id);
            if (i >= 0) jobs.splice(i, 1);
            return i >= 0;
          },
        },
      });
      return {
        ...handle(shard),
        onShard: (s: string) => handle(s),
        runAction: async (ref: AnyFunctionReference, args?: unknown) => runAction(getFunctionName(ref), args, shard, true),
        auth: {
          getUserIdentity: async () => identity,
          require: async () => {
            if (!identity) throw errorFromWire({ code: "Unauthenticated", message: "Not signed in" });
            return identity;
          },
        },
        env: { ...(options.env ?? {}) },
        now: clock,
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
      clock = Math.max(clock, j.runAt);
      const system = make(null);
      if (j.kind === "mutation") await system.mutation(namedRef<"mutation">(j.fn), j.args as Record<string, unknown>, { shard: j.shard });
      else await (system as unknown as { _action(name: string, args: unknown, shard: string): Promise<unknown> })._action(j.fn, j.args, j.shard);
    };

    const t: EmberTest & { _action(name: string, args: unknown, shard: string): Promise<unknown> } = {
      async query(ref, ...rest) {
        const { args, opts } = split(rest);
        return runQuery(ref, args, shardOf(ref, args, opts?.shard));
      },
      async mutation(ref, ...rest) {
        const { args, opts } = split(rest);
        return runMutation(ref, args, shardOf(ref, args, opts?.shard));
      },
      async action(ref, ...rest) {
        const { args, opts } = split(rest);
        return runAction(getFunctionName(ref), args, shardOf(ref, args, opts?.shard), false);
      },
      _action: (name, args, shard) => runAction(name, args, shard, true),
      withIdentity: (id) => make({ ...id } as Identity),
      async run(fn, opts) {
        const shard = opts?.shard ?? defaultShard;
        const inline = { [Symbol.for("ember.function")]: true, type: "mutation", visibility: "internal", args: { kind: "object", fields: {} }, handler: (ctx: MutationCtx) => fn(ctx) };
        const r = engineOf(shard).runMutation(inline as never, {}, auth);
        queue(shard, r.scheduled, r.cancelled);
        return r.value as never;
      },
      scheduled: () => [...jobs],
      async advance(ms) {
        const until = clock + ms;
        let n = 0;
        while (jobs.length && jobs[0]!.runAt <= until) {
          await runJob(jobs[0]!);
          n++;
        }
        clock = Math.max(clock, until);
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
      now: () => clock,
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
