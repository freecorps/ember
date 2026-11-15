import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  createEngine,
  createMatchIndex,
  JOBS_TABLE,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
  runLocalQuery,
  type EmberError,
  type ScheduledFunction,
  type ScheduledReader,
} from "../src/index.ts";
import { schema } from "./fixtures.ts";

const job = (id: string, kind: ScheduledFunction["state"]["kind"] = "pending"): ScheduledFunction => ({
  id,
  _creationTime: 1,
  name: "m:work",
  args: { n: 1 },
  scheduledTime: 10,
  state: kind === "failed" ? { kind, error: "boom" } : ({ kind } as ScheduledFunction["state"]),
  attempts: 0,
});

function setup(jobs: ScheduledFunction[]) {
  const reader: ScheduledReader = {
    get: (id) => jobs.find((j) => j.id === id) ?? null,
    list: ({ state, limit }) => jobs.filter((j) => !state || j.state.kind === state).slice(0, limit),
  };
  const work = mutationGeneric({ handler: () => null });
  const engine = createEngine({ schema, functions: { "m:work": work }, driver: createNodeSqliteDriver(), now: () => 1000, scheduledFunctions: reader });
  engine.migrate();
  return engine;
}

describe("ctx.scheduler.get / list (engine)", () => {
  test("queries read through the reader and record the job in the read set (point read by id, list table-wide)", () => {
    const engine = setup([job("job_a"), job("job_b", "success")]);
    const r = engine.runQuery(queryGeneric((ctx: any) => ctx.scheduler.get("job_a")) as any);
    expect(r.value).toMatchObject({ id: "job_a", state: { kind: "pending" } });
    expect(r.readSet).toEqual([expect.objectContaining({ table: JOBS_TABLE, index: "by_id" })]);
    const change = (id: string) => [{ table: JOBS_TABLE, id, before: { _id: id }, after: { _id: id } }] as never;
    expect(engine.matches(r.readSet, change("job_a"))).toBe(true);
    expect(engine.matches(r.readSet, change("job_b"))).toBe(false);
    // The subscription index answers the same.
    const index = createMatchIndex<string>(schema);
    index.set("q", r.readSet);
    expect([...index.match(change("job_b")).exact]).toEqual([]);
    expect([...index.match(change("job_a")).exact]).toEqual(["q"]);

    const l = engine.runQuery(queryGeneric((ctx: any) => ctx.scheduler.list({ state: "success" })) as any);
    expect((l.value as ScheduledFunction[]).map((j) => j.id)).toEqual(["job_b"]);
    expect(engine.matches(l.readSet, change("job_zzz"))).toBe(true);
    expect(engine.runQuery(queryGeneric((ctx: any) => ctx.scheduler.get("job_none")) as any).value).toBeNull();
  });

  test("a mutation sees what it scheduled and cancelled so far", () => {
    const engine = setup([job("job_a")]);
    const r = engine.runMutation(
      mutationGeneric((ctx: any) => {
        const id = ctx.scheduler.runAfter(5, makeFunctionReference("m:work"), {});
        ctx.scheduler.cancel("job_a");
        return { own: ctx.scheduler.get(id), a: ctx.scheduler.get("job_a"), pending: ctx.scheduler.list({ state: "pending" }).map((j: ScheduledFunction) => j.id), id };
      }) as any,
    );
    const v = r.value as { own: ScheduledFunction; a: ScheduledFunction; pending: string[]; id: string };
    expect(v.own).toMatchObject({ id: v.id, name: "m:work", scheduledTime: 1005, state: { kind: "pending" } });
    expect(v.a).toMatchObject({ state: { kind: "canceled" }, completedTime: 1000 });
    expect(v.pending).toEqual([v.id]);
  });

  test("bad arguments are ValidationErrors; replicas refuse job reads", () => {
    const engine = setup([]);
    const code = (f: (ctx: any) => unknown) => {
      try {
        engine.runQuery(queryGeneric(f) as any);
      } catch (e) {
        return (e as EmberError).code;
      }
      return "ok";
    };
    expect(code((ctx) => ctx.scheduler.list({ limit: 0 }))).toBe("ValidationError");
    expect(code((ctx) => ctx.scheduler.list({ state: "done" }))).toBe("ValidationError");
    expect(code((ctx) => ctx.scheduler.get(""))).toBe("ValidationError");
    const q = queryGeneric((ctx: any) => ctx.scheduler.get("job_a"));
    expect(() => runLocalQuery(q as any, {}, { schema, reader: { scan: () => [], get: () => null } })).toThrow(/ctx.scheduler.get is not available/);
  });
});
