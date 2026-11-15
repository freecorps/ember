import { describe, expect, test } from "vitest";
import {
  actionGeneric,
  checkLimits,
  DEFAULT_LIMITS,
  defineApp,
  limitWarnings,
  makeFunctionReference,
  MAX_LIMITS,
  mutationGeneric,
  queryGeneric,
  runLocalQuery,
  usageFractions,
  type EmberError,
  type QueryCtx,
} from "../src/index.ts";
import { fresh, schema, withUser } from "./fixtures.ts";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as EmberError).code ?? (e as Error).message;
  }
  return "no error";
};

function seeded(n: number, opts: Parameters<typeof fresh>[0] = {}) {
  const s = fresh(opts);
  const author = withUser(s);
  s.tx((db) => {
    for (let i = 0; i < n; i++) db.insert("messages", { channel: i % 2 ? "odd" : "even", author, body: `m${i}`, likes: i });
  });
  return s;
}

describe("documents read", () => {
  test("counts what db.get, scans (rows .filter() drops included) and pagination hand out", () => {
    const s = seeded(20);
    const read = (fn: (ctx: QueryCtx) => unknown) => s.engine.runQuery(queryGeneric({ handler: fn as any }) as any).usage!.documentsRead;
    expect(read((ctx) => ctx.db.query("messages").collect())).toBe(20);
    expect(read((ctx) => ctx.db.query("messages").take(3))).toBe(3);
    expect(read((ctx) => ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", "odd")).collect())).toBe(10);
    // `.filter()` reads what it drops: 20 scanned for 1 returned.
    expect(read((ctx) => ctx.db.query("messages").filter((q) => q.eq(q.field("likes"), 7)).collect())).toBe(20);
    expect(read((ctx) => ctx.db.query("messages").paginate({ numItems: 5, cursor: null }))).toBeGreaterThanOrEqual(5);
    const id = s.run((db) => db.query("messages").first()).value!._id;
    expect(read((ctx) => [ctx.db.get(id), ctx.db.get(id)])).toBe(2);
    // A missing id reads nothing.
    expect(read((ctx) => ctx.db.get(id.replace(/.$/, (c: string) => (c === "a" ? "b" : "a")) as any))).toBe(0);
  });

  test("TooManyDocumentsRead is separate from TooManyReads (SQLite rows); the mutation is rolled back", () => {
    const s = seeded(12, { limits: { documentsRead: 10 } });
    expect(code(() => s.run((db) => db.query("messages").collect()))).toBe("TooManyDocumentsRead");
    expect(code(() => s.run((db) => db.query("messages").take(10)))).toBe("no error");
    expect(code(() => s.tx((db) => { db.insert("users", { name: "B", email: "b@x", admin: false }); db.query("messages").collect(); }))).toBe("TooManyDocumentsRead");
    expect(s.run((db) => db.query("users").collect()).value).toHaveLength(1);
    // SQLite rows: the index entries count too, documents do not change.
    const rows = seeded(12, { limits: { rowsRead: 10 } });
    expect(code(() => rows.run((db) => db.query("messages").collect()))).toBe("TooManyReads");
  });

  test("defaults: 16 384 documents (Convex), 4× that in SQLite rows", () => {
    expect(DEFAULT_LIMITS).toEqual({ rowsRead: 65_536, documentsRead: 16_384, rowsWritten: 8_192, documentSize: 2 * 1024 * 1024, triggerRuns: 10_000 });
    const r = seeded(3).run((db) => db.query("messages").collect()) as unknown as { usage: { limits: unknown } };
    expect(r.usage.limits).toEqual(DEFAULT_LIMITS);
  });
});

describe("limits per project and per function", () => {
  const list = queryGeneric({ limits: { documentsRead: 5 }, handler: (ctx: QueryCtx) => ctx.db.query("messages").collect() });
  const wide = queryGeneric({ limits: { documentsRead: 100 }, handler: (ctx: QueryCtx) => ctx.db.query("messages").collect() });
  const listAll = queryGeneric((ctx: QueryCtx) => ctx.db.query("messages").collect());
  const nested = queryGeneric({ limits: { documentsRead: 100 }, handler: (ctx: any) => ctx.runQuery(makeFunctionReference("m:list")) });
  const nestedTight = queryGeneric({ limits: { documentsRead: 12 }, handler: (ctx: any) => [ctx.db.query("messages").take(8), ctx.runQuery(makeFunctionReference("m:wide"))] });
  const bulk = mutationGeneric({
    limits: { rowsWritten: 10_000 },
    handler: (ctx: any) => {
      const author = ctx.db.query("users").first()._id;
      for (let i = 0; i < 400; i++) ctx.db.insert("messages", { channel: "bulk", author, body: "x", likes: i });
    },
  });

  test("a function's limits apply to its top-level calls, over the project's", () => {
    const s = seeded(10, { limits: { documentsRead: 8, rowsWritten: 100 } });
    expect(code(() => s.engine.runQuery(list as any))).toBe("TooManyDocumentsRead");
    expect(code(() => s.engine.runQuery(listAll as any))).toBe("TooManyDocumentsRead"); // the project's 8
    const r = s.engine.runQuery(wide as any);
    expect(r.usage).toMatchObject({ documentsRead: 10, limits: { documentsRead: 100, rowsWritten: 100, rowsRead: DEFAULT_LIMITS.rowsRead } });
    expect(code(() => s.engine.runMutation(bulk as any))).toBe("no error"); // 400 docs × rows > the project's 100
  });

  test("nested ctx.runQuery spends the caller's budget under the caller's limits", () => {
    const s = seeded(10, { functions: { "m:list": list, "m:wide": wide } });
    // The callee's own 5 does not apply when it is called from another function...
    expect(code(() => s.engine.runQuery(nested as any))).toBe("no error");
    expect(s.engine.runQuery(nested as any).usage!.documentsRead).toBe(10);
    // ...nor does its higher one: 8 + 10 > the caller's 12.
    expect(code(() => s.engine.runQuery(nestedTight as any))).toBe("TooManyDocumentsRead");
  });

  test("defineApp({ limits }) is checked; nothing passes MAX_LIMITS", () => {
    expect(defineApp({ limits: { documentsRead: 32_000 } }).limits).toEqual({ documentsRead: 32_000 });
    expect(defineApp().limits).toEqual({});
    expect(() => defineApp({ limits: { documentsRead: MAX_LIMITS.documentsRead + 1 } })).toThrow(/above the ceiling of 131072/);
    expect(() => defineApp({ limits: { documentSize: 4 * 1024 * 1024 } })).toThrow(/ceiling/);
    expect(() => defineApp({ limits: { rowsRead: 0 } })).toThrow(/positive integer/);
    expect(() => defineApp({ limits: { docs: 1 } as never })).toThrow(/unknown limit "docs"/);
    expect(() => queryGeneric({ limits: { rowsWritten: 10 } as never, handler: () => 1 })).toThrow(/limits.rowsWritten does not apply here/);
    expect(() => actionGeneric({ limits: { rowsRead: 10 }, handler: async () => 1 } as never)).toThrow(/applies to queries and mutations/);
    expect(() => mutationGeneric({ limits: { rowsRead: MAX_LIMITS.rowsRead * 2 }, handler: () => 1 })).toThrow(/ceiling/);
    expect(() => fresh({ limits: { rowsWritten: MAX_LIMITS.rowsWritten + 1 } })).toThrow(/createEngine: limits.rowsWritten/);
    expect(checkLimits({ rowsRead: 10, documentsRead: undefined }, "x")).toEqual({ rowsRead: 10 });
  });

  test("a mutation's documentSize applies to its writes", () => {
    const s = seeded(1);
    const small = mutationGeneric({
      limits: { documentSize: 100 },
      handler: (ctx: any) => ctx.db.insert("users", { name: "x".repeat(200), email: "e", admin: false }),
    });
    expect(code(() => s.engine.runMutation(small as any))).toBe("DocumentTooLarge");
  });

  test("local execution honours the function's documentsRead", () => {
    const docs = Array.from({ length: 6 }, (_, i) => ({ _id: `msg_${i}`, _creationTime: i, channel: "a", body: "x", likes: i }));
    const reader = { scan: () => docs.map((doc) => ({ doc, key: new Uint8Array() })), get: () => null } as never;
    expect(code(() => runLocalQuery(list as any, {}, { schema, reader }))).toBe("TooManyDocumentsRead");
    expect(code(() => runLocalQuery(wide as any, {}, { schema, reader }))).toBe("no error");
  });
});

describe("warnings at 70%", () => {
  test("usage fractions and the text ember dev prints (the dashboard's copy is checked in its own tests)", () => {
    const limits = { ...DEFAULT_LIMITS, documentsRead: 100 };
    const f = usageFractions({ rowsRead: 10, documentsRead: 71, rowsWritten: 0, limits });
    expect(f.documentsRead).toBeCloseTo(0.71);
    const w = limitWarnings(f);
    expect(w).toEqual([{ kind: "limits", counter: "documentsRead", message: expect.stringContaining("used 71% of its documents read limit (TooManyDocumentsRead at 100%)") }]);
    expect(limitWarnings({ documentsRead: 0.69 })).toEqual([]);
  });
});
