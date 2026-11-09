// A mutation's read cache: a read-modify-write reads its document once; documents handed to the handler stay its
// own (mutating them changes nothing stored); writes and a failed nested mutation drop what they made stale.
import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import { createEngine, defineSchema, defineTable, mutationGeneric, queryGeneric, v } from "../src/index.ts";

const schema = defineSchema({
  tables: {
    counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
    blobs: defineTable({ name: v.string(), data: v.bytes() }).index("by_name", ["name"]),
  },
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

  test("bytes the handler mutates in place are its own: the cached row and the write stay right", () => {
    const s = setup();
    s.run((ctx) => ctx.db.insert("blobs", { name: "b", data: new Uint8Array([1, 2, 3]) }));
    s.run((ctx) => {
      const b = ctx.db.query("blobs").withIndex("by_name", (q: any) => q.eq("name", "b")).unique();
      b.data[0] = 9; // in place, never written
      const again = ctx.db.get(b._id);
      again.data[1] = 9; // a cached read, mutated too
      // The patch writes these bytes: the stored row must not look like it already has them.
      ctx.db.patch(b._id, { data: new Uint8Array([9, 9, 3]) });
    });
    const stored = s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("blobs").first() }) as any).value as any;
    expect([...stored.data]).toEqual([9, 9, 3]);
    s.run((ctx) => {
      const b = ctx.db.query("blobs").first();
      b.data[2] = 7;
      ctx.db.patch(b._id, { name: "renamed" });
    });
    const after = s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("blobs").first() }) as any).value as any;
    expect(after.name).toBe("renamed");
    expect([...after.data]).toEqual([9, 9, 3]);
  });

  test("a patch or replace that changes nothing is no change at all", () => {
    const s = setup();
    const id = s.run((ctx) => ctx.db.insert("counters", { name: "a", value: 1 })) as string;
    const patched = s.engine.runMutation(M((ctx) => ctx.db.patch(id, { value: 1 })), {});
    expect(patched.changes).toEqual([]);
    const replaced = s.engine.runMutation(M((ctx) => ctx.db.replace(id, { name: "a", value: 1 })), {});
    expect(replaced.changes).toEqual([]);
    const real = s.engine.runMutation(M((ctx) => ctx.db.patch(id, { value: 2 })), {});
    expect(real.changes).toHaveLength(1);
  });
});
