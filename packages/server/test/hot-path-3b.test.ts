// PR 3b (engine hot path): one transaction per group commit, a cheaper ctx, and the withIndex range builder.
// Every shortcut is checked against the path it replaces: results, rows, read sets and usage must be what they were.

import { describe, expect, it } from "vitest";
import { v } from "@freecorps/ember-values";
import { createNodeSqliteDriver } from "../src/testing.ts";
import { createEngine, defineSchema, defineTable, mutationGeneric, queryGeneric, type MutationBatchResult, type SqlDriver } from "../src/index.ts";

const schema = defineSchema({
  tables: {
    t: defineTable({ a: v.string(), n: v.number() }).index("by_a", ["a"]),
  },
});

/** An engine over node:sqlite whose driver counts `transaction()` calls (top level and savepoints). */
function counted() {
  const inner = createNodeSqliteDriver();
  const stats = { transactions: 0, top: 0, depth: 0 };
  const driver: SqlDriver = {
    exec: (sql, ...p) => inner.exec(sql, ...p),
    transaction: (fn) => {
      stats.transactions++;
      if (stats.depth === 0) stats.top++;
      stats.depth++;
      try {
        return inner.transaction(fn);
      } finally {
        stats.depth--;
      }
    },
  };
  let clock = 1_700_000_000_000;
  const engine = createEngine({ schema, driver, now: () => (clock += 1) });
  engine.migrate();
  const count = () => Number(inner.exec(`SELECT count(*) AS n FROM "t"`).rows[0]!.n);
  return { engine, stats, inner, count };
}

const insert = (a: string) => mutationGeneric({ handler: (ctx: any) => ctx.db.insert("t", { a, n: 1 }) }) as any;
const failing = (a: string) =>
  mutationGeneric({
    handler: (ctx: any) => {
      ctx.db.insert("t", { a, n: 1 });
      throw new Error(`boom ${a}`);
    },
  }) as any;

describe("commitMutationBatch: one transaction while no item fails", () => {
  it("a batch without failures: one transaction, no savepoint; the commit's writes go with it", () => {
    const { engine, stats, inner, count } = counted();
    const t0 = stats.transactions;
    const out = engine.commitMutationBatch([insert("x"), insert("y"), insert("z")].map((name) => ({ name, args: {}, ctx: { identity: null } as any })), (results) => {
      inner.exec(`CREATE TABLE IF NOT EXISTS side (x INTEGER)`);
      inner.exec(`INSERT INTO side VALUES (1)`);
      return results;
    });
    expect(stats.transactions - t0).toBe(1);
    expect(out.map((r) => r.ok)).toEqual([true, true, true]);
    expect(count()).toBe(3);
    expect(inner.exec(`SELECT count(*) AS n FROM side`).rows[0]!.n).toBe(1);
  });

  it("one item: one transaction; when it fails, its writes are undone and the commit still runs (it ran once)", () => {
    const { engine, stats, count } = counted();
    let runs = 0;
    const fn = mutationGeneric({
      handler: (ctx: any) => {
        runs++;
        ctx.db.insert("t", { a: "q", n: 1 });
        throw new Error("nope");
      },
    }) as any;
    const t0 = stats.transactions;
    const top0 = stats.top;
    let committed: MutationBatchResult[] = [];
    engine.commitMutationBatch([{ name: fn, args: {}, ctx: { identity: null } as any }], (r) => (committed = r));
    expect(runs).toBe(1);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ ok: false, error: { message: expect.stringContaining("nope") } });
    expect(count()).toBe(0);
    // The rolled back attempt and the transaction that commits the failure.
    expect(stats.top - top0).toBe(2);
    expect(stats.transactions - t0).toBe(2);
  });

  it("a failing item among others is undone alone, as runMutationBatch does", () => {
    const a = counted();
    const b = counted();
    const items = (e: ReturnType<typeof counted>) => [insert("x"), failing("f"), insert("y")].map((name) => ({ name, args: {}, ctx: { identity: null } as any }));
    const viaCommit = a.engine.commitMutationBatch(items(a), (r) => r);
    const viaRun = b.engine.runMutationBatch(items(b));
    const shape = (rs: MutationBatchResult[]) => rs.map((r) => (r.ok ? { ok: true, changes: r.changes.length } : { ok: false, code: r.error.code, message: r.error.message }));
    expect(shape(viaCommit)).toEqual(shape(viaRun));
    expect(a.count()).toBe(2);
    expect(b.count()).toBe(2);
    expect(a.inner.exec(`SELECT a FROM "t" ORDER BY a`).rows.map((r) => r.a)).toEqual(["x", "y"]);
  });

  it("a commit callback that throws undoes the items too", () => {
    const { engine, count } = counted();
    expect(() =>
      engine.commitMutationBatch([{ name: insert("x"), args: {}, ctx: { identity: null } as any }], () => {
        throw new Error("commit failed");
      }),
    ).toThrow("commit failed");
    expect(count()).toBe(0);
  });

  it("a nested ctx.runMutation that fails is still undone alone inside the single transaction", () => {
    const { engine, count, inner } = counted();
    const inner1 = failing("inner");
    const outer = mutationGeneric({
      handler: (ctx: any) => {
        ctx.db.insert("t", { a: "outer", n: 1 });
        try {
          ctx.runMutation(inner1, {});
        } catch {
          // caught: the callee's insert is undone, the caller's kept
        }
        return null;
      },
    }) as any;
    const r = engine.commitMutationBatch([{ name: outer, args: {}, ctx: { identity: null } as any }], (x) => x);
    expect(r[0]!.ok).toBe(true);
    expect(count()).toBe(1);
    expect(inner.exec(`SELECT a FROM "t"`).rows[0]!.a).toBe("outer");
  });
});

describe("a mutation's ctx (built without intermediate objects)", () => {
  it("members are the same object on every read, spread, assignable, and replaced members are what the handler reads", () => {
    const { engine } = counted();
    const out = (engine.runMutation(
      mutationGeneric({
        handler: (ctx: any) => {
          const same = ctx.db === ctx.db && ctx.scheduler === ctx.scheduler && ctx.storage === ctx.storage && ctx.runQuery === ctx.runQuery && ctx.runMutation === ctx.runMutation && ctx.auth === ctx.auth && ctx.db.sql === ctx.db.sql;
          const copy = { ...ctx };
          const spread = copy.db === ctx.db && copy.runMutation === ctx.runMutation && copy.sql === ctx.sql;
          const db = ctx.db;
          ctx.db = { wrapped: db };
          ctx.runQuery = "rq";
          ctx.db.wrapped.sql = "sql";
          return { same, spread, wrapped: ctx.db.wrapped === db, rq: ctx.runQuery, sql: db.sql, desc: Object.getOwnPropertyDescriptor(ctx, "storage")!.enumerable };
        },
      }) as any,
      {},
    ) as { value: unknown }).value;
    expect(out).toEqual({ same: true, spread: true, wrapped: true, rq: "rq", sql: "sql", desc: true });
  });

  it("a query's ctx.db.sql: one per run, assignable, reactive per table", () => {
    const { engine } = counted();
    const out = (engine.runQuery(
      queryGeneric({
        handler: (ctx: any) => {
          const same = ctx.db.sql === ctx.db.sql;
          const rows = ctx.db.sql`SELECT count(*) AS n FROM t`;
          ctx.db.sql = 1;
          return { same, n: rows[0].n, after: ctx.db.sql, keys: Object.keys(ctx.db) };
        },
      }) as any,
      {},
    ) as { value: unknown; readSet: unknown[] });
    expect(out.value).toMatchObject({ same: true, n: 0, after: 1 });
    expect((out.value as { keys: string[] }).keys).toContain("sql");
    expect(out.readSet).toHaveLength(1);
  });
});

describe("withIndex range builder", () => {
  it("chains, and refuses misplaced bounds with the same errors", () => {
    const { engine } = counted();
    engine.runMutation(insert("b"), {});
    const run = (build: (q: any) => unknown) => {
      try {
        return (engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("t").withIndex("by_a", build).collect().map((d: any) => d.a) }) as any, {}) as { value: unknown }).value;
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(run((q) => q.eq("a", "b"))).toEqual(["b"]);
    expect(run((q) => q.gte("a", "a").lt("a", "c"))).toEqual(["b"]);
    expect(run((q) => q.gt("a", "b"))).toEqual([]);
    expect(run((q) => q.lte("a", "b").gte("a", "a"))).toBe("withIndex(by_a): only one lower bound, before the upper bound");
    expect(run((q) => q.eq("n", 1))).toBe("withIndex(by_a): eq(n) must be on a");
    expect(run((q) => q.gt("a", "a").eq("a", "b"))).toBe("withIndex(by_a): eq() after a range bound");
  });
});
