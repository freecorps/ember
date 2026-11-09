// A mutation's read cache: a read-modify-write reads its document once; documents handed to the handler stay its
// own (mutating them changes nothing stored); writes and a failed nested mutation drop what they made stale.
import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import { createEngine, defineSchema, defineTable, mutationGeneric, queryGeneric, v } from "../src/index.ts";

const schema = defineSchema({
  tables: { counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]) },
});
const M = (handler: (ctx: any, a: any) => unknown) => mutationGeneric({ handler }) as any;
const one = (db: any, name: string) => db.query("counters").withIndex("by_name", (q: any) => q.eq("name", name)).unique();

function setup(functions: Record<string, unknown> = {}) {
  const driver = createNodeSqliteDriver();
  const engine = createEngine({ schema, driver, functions: functions as any });
  engine.migrate();
  const run = (h: (ctx: any, a: any) => unknown, args: unknown = {}) => engine.runMutation(M(h), args).value;
  const selects = (fn: () => unknown) => {
    let n = 0;
    const exec = driver.exec.bind(driver);
    driver.exec = (s: string, ...p: any[]) => {
      if (/^\s*SELECT/i.test(s)) n++;
      return exec(s, ...p);
    };
    try {
      fn();
    } finally {
      driver.exec = exec;
    }
    return n;
  };
  const read = (name: string) => engine.runQuery(queryGeneric({ handler: (ctx: any) => one(ctx.db, name) }) as any).value as any;
  return { engine, run, selects, read };
}

describe("mutation read cache", () => {
  test("query then patch reads the document once; increment reads it once", () => {
    const s = setup();
    s.run((ctx) => ctx.db.insert("counters", { name: "a", value: 0 }));
    const rmw = s.selects(() => s.run((ctx) => {
      const c = one(ctx.db, "a");
      ctx.db.patch(c._id, { value: c.value + 1 });
    }));
    expect(rmw).toBe(1);
    const id = s.read("a")._id;
    expect(s.selects(() => s.run((ctx) => ctx.db.increment(id, "value", 1)))).toBe(1);
    expect(s.read("a").value).toBe(2);
  });

  test("a document the handler mutated in place is not what gets written", () => {
    const s = setup();
    s.run((ctx) => ctx.db.insert("counters", { name: "a", value: 1 }));
    s.run((ctx) => {
      const c = one(ctx.db, "a");
      c.name = "changed in memory only";
      c.value = 99;
      ctx.db.patch(c._id, { value: 2 });
    });
    expect(s.read("a")).toMatchObject({ name: "a", value: 2 });
    expect(s.read("changed in memory only")).toBeNull();
  });

  test("a read after a write sees the write; a failed nested mutation leaves no stale row", () => {
    const failing = M((ctx, { id }: { id: string }) => {
      ctx.db.patch(id, { value: 1000 });
      // Read back (cached) after the write, then fail: the savepoint undoes the patch.
      ctx.db.get(id);
      throw new Error("callee fails");
    });
    const s = setup({ c: { failing } });
    s.run((ctx) => ctx.db.insert("counters", { name: "a", value: 1 }));
    const out = s.run((ctx) => {
      const c = one(ctx.db, "a");
      ctx.db.patch(c._id, { value: c.value + 1 });
      const after = ctx.db.get(c._id).value;
      try {
        ctx.runMutation("c:failing", { id: c._id });
      } catch {
        // caught by the caller
      }
      return { after, final: ctx.db.get(c._id).value };
    }) as { after: number; final: number };
    expect(out).toEqual({ after: 2, final: 2 });
    expect(s.read("a").value).toBe(2);
  });
});
