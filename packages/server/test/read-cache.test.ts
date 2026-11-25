// A mutation's read cache: a read-modify-write reads its document once; documents handed to the handler stay its
// own (mutating them changes nothing stored); writes and a failed nested mutation drop what they made stale.
import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import { createEngine, defineSchema, defineTable, mutationGeneric, queryGeneric, v } from "../src/index.ts";
import { docKey } from "../src/ddl.ts";
import { decodeRow, layoutOf } from "../src/layout.ts";

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

// PR 4B-3b: a mutation reads no `_k_*` BLOB (keys are compared from the documents), keeps what it writes in the
// cache, and stores exactly what it stored before (checked against main's engine with random writes while developing:
// same values, changes, rowsWritten, documentsRead and stored rows on classic, format 2 and format 3).
describe("mutation read cache: writes (PR 4B-3b)", () => {
  const keyed = defineSchema({
    tables: {
      t: defineTable({ a: v.string(), n: v.number(), b: v.optional(v.bytes()), meta: v.optional(v.object({ e: v.boolean() })) })
        .index("by_a", ["a"])
        .index("by_n_a", ["n", "a"])
        .index("by_e", ["meta.e"]),
    },
  });
  function keyedSetup(opts: Record<string, unknown> = {}) {
    const driver = createNodeSqliteDriver();
    const engine = createEngine({ schema: keyed, driver, ...opts } as any);
    engine.migrate();
    const statements: string[] = [];
    const exec = driver.exec.bind(driver);
    driver.exec = (s: string, ...p: any[]) => {
      statements.push(s);
      return exec(s, ...p);
    };
    const run = (h: (ctx: any) => unknown) => engine.runMutation(M(h), {});
    const rows = () => exec(`SELECT * FROM "t" ORDER BY "_rowid"`).rows;
    return { engine, run, statements, rows };
  }

  test("a write is read back from the cache: insert, patch, replace, then get, read once", () => {
    const s = keyedSetup();
    // (The first insert of a compact table reads its top `_rowid` once.)
    s.run((ctx) => ctx.db.insert("t", { a: "w", n: 0 }));
    s.statements.length = 0;
    const r = s.run((ctx) => {
      const id = ctx.db.insert("t", { a: "x", n: 1 });
      const d1 = ctx.db.get(id);
      ctx.db.patch(id, { n: 2 });
      const d2 = ctx.db.get(id);
      ctx.db.replace(id, { a: "y", n: 3, meta: { e: true } });
      return [d1, d2, ctx.db.get(id)];
    });
    expect(s.statements.filter((x) => /^\s*SELECT/i.test(x))).toEqual([]);
    const [d1, d2, d3] = r.value as any[];
    expect([d1.n, d2.n, d3.a, d3.meta]).toEqual([1, 2, "y", { e: true }]);
    // Counted as before: three gets, and the patch and the replace read their document (from the cache).
    expect(r.usage!.documentsRead).toBe(5);
    const fresh = s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.get(d3._id) }) as any).value;
    expect(fresh).toEqual(d3);
  });

  test("no `SELECT *` and no `_k_*` column read by a mutation (by id or by a scan)", () => {
    const s = keyedSetup();
    const id = s.run((ctx) => ctx.db.insert("t", { a: "x", n: 1 })).value as string;
    s.statements.length = 0;
    s.run((ctx) => {
      ctx.db.patch(id, { a: "z" });
      const d = ctx.db.query("t").withIndex("by_n_a", (q: any) => q.eq("n", 1)).first();
      ctx.db.patch(d._id, { n: 5 });
    });
    const selects = s.statements.filter((x) => /^\s*SELECT/i.test(x));
    expect(selects.length).toBeGreaterThan(0);
    for (const x of selects) {
      expect(x).not.toMatch(/SELECT \*/);
      // Only the scanned index's own key column (its range filter and order), never another.
      expect(x.match(/"_k_[a-z_]+"/g)?.filter((k) => k !== `"_k_by_n_a"`) ?? []).toEqual([]);
    }
    expect(s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("t").withIndex("by_n_a", (q: any) => q.eq("n", 5)).collect() }) as any).value).toHaveLength(1);
  });

  test("bytes written stay the handler's: changing them after the write changes neither the cache nor the row", () => {
    const s = keyedSetup();
    const r = s.run((ctx) => {
      const b = new Uint8Array([1, 2]);
      const id = ctx.db.insert("t", { a: "x", n: 1, b });
      b[0] = 9;
      const d = ctx.db.get(id);
      d.b[1] = 8;
      return [id, ctx.db.get(id).b];
    });
    const [id, b] = r.value as [string, Uint8Array];
    expect([...b]).toEqual([1, 2]);
    expect([...(s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.get(id) }) as any).value as any).b]).toEqual([1, 2]);
  });

  test("a lone surrogate in an indexed TEXT column: not cached as written, and a patch repairs its key as before", () => {
    const s = keyedSetup();
    const r = s.run((ctx) => {
      const id = ctx.db.insert("t", { a: "z\ud800", n: 1 });
      return [id, ctx.db.get(id).a];
    });
    const [id, a] = r.value as [string, string];
    // What SQLite gives back, not what was written (as a read after the write always gave).
    expect(a).toBe("z\ufffd");
    const keyBefore = s.rows()[0]!._k_by_a;
    // The key was written from the lone surrogate; the document now holds U+FFFD: rewritten to match it.
    const p = s.run((ctx) => ctx.db.patch(id, { a: "z\ufffd" }));
    expect(p.changes).toHaveLength(1);
    expect(s.rows()[0]!._k_by_a).not.toEqual(keyBefore);
    expect(s.run((ctx) => ctx.db.patch(id, { a: "z\ufffd" })).usage!.rowsWritten).toBe(0);
  });

  test("random writes: every stored key is its document's key, and a no-op write writes nothing", () => {
    for (const compactFormat of [2, 3] as const) {
      const s = keyedSetup({ compactFormat });
      let seed = 7;
      const r = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
      const doc = () => ({ a: pick(["x", "y", ""]), n: pick([1, 2, NaN, -0, 0]), ...(r() < 0.5 ? { meta: { e: r() < 0.5 } } : {}), ...(r() < 0.3 ? { b: new Uint8Array([1]) } : {}) });
      const ids: string[] = [];
      for (let i = 0; i < 200; i++) {
        s.run((ctx) => {
          for (let k = 0; k < 3; k++) {
            const op = Math.floor(r() * 4);
            if (op === 0 || !ids.length) ids.push(ctx.db.insert("t", doc()));
            else if (op === 1) ctx.db.patch(pick(ids), r() < 0.5 ? { n: pick([1, 2, NaN]) } : doc());
            else if (op === 2) ctx.db.replace(pick(ids), doc());
            else ctx.db.get(pick(ids));
          }
        });
        if (i % 20) continue;
        const id = pick(ids);
        const same = s.run((ctx) => {
          const d = ctx.db.get(id);
          const { _id, _creationTime, ...rest } = d;
          ctx.db.replace(id, rest);
          ctx.db.patch(id, { a: d.a, n: d.n });
        });
        expect(same.usage!.rowsWritten).toBe(0);
        expect(same.changes).toEqual([]);
      }
      for (const row of s.rows()) {
        const d = decodeRow(layoutOf("t", keyed.manifest.tables.t!.document), row as any);
        expect(row._k_by_a).toEqual(docKey(d, ["a", "_creationTime", "_id"]));
        expect(row._k_by_n_a).toEqual(docKey(d, ["n", "a", "_creationTime", "_id"]));
        expect(row._k_by_e).toEqual(docKey(d, ["meta.e", "_creationTime", "_id"]));
      }
    }
  });

  test("a row in a staged backfill window: its key is left to the backfill, lossy TEXT or not", () => {
    for (const compactFormat of [2, 3] as const) {
      const plain = defineSchema({ tables: { t: defineTable({ a: v.string(), n: v.number() }) } });
      const indexed = defineSchema({ tables: { t: defineTable({ a: v.string(), n: v.number() }).index("by_a", ["a"]) } });
      const driver = createNodeSqliteDriver();
      const first = createEngine({ schema: plain, driver, compactFormat } as any);
      first.migrate();
      const ids = first.runMutation(M((ctx) => [ctx.db.insert("t", { a: "z\ud800", n: 1 }), ctx.db.insert("t", { a: "y", n: 1 })]), {}).value as string[];
      const engine = createEngine({ schema: indexed, driver, compactFormat } as any);
      expect(engine.migrate().staged.length).toBeGreaterThan(0);
      const keys = () => driver.exec(`SELECT "_k_by_a" AS k FROM "t" ORDER BY "_rowid"`).rows.map((r) => r.k);
      expect(keys()).toEqual([null, null]);
      // Rewrites that keep `a` (U+FFFD as read back, and a plain string): the key column stays the backfill's.
      for (const id of ids) {
        const r = engine.runMutation(M((ctx) => {
          const d = ctx.db.get(id);
          ctx.db.replace(id, { a: d.a, n: 2 });
        }), {});
        expect(r.changes).toHaveLength(1);
      }
      expect(keys()).toEqual([null, null]);
      while (!engine.backfillStep(1).done);
      const layout = layoutOf("t", indexed.manifest.tables.t!.document);
      for (const row of driver.exec(`SELECT * FROM "t" ORDER BY "_rowid"`).rows) {
        expect(row._k_by_a).toEqual(docKey(decodeRow(layout, row as any), ["a", "_creationTime", "_id"]));
      }
    }
  });

  test("a \"__proto__\" key: data inside a value (insert, patch, replace read it back the same), refused at the top", () => {
    const anySchema = defineSchema({ tables: { t: defineTable({ a: v.string(), x: v.any() }).index("by_a", ["a"]) } });
    for (const compactFormat of [undefined, 2, 3] as const) {
      const driver = createNodeSqliteDriver();
      const engine = createEngine({ schema: anySchema, driver, compactFormat } as any);
      engine.migrate();
      const run = (h: (ctx: any) => unknown) => engine.runMutation(M(h), {}).value;
      const get = (id: string) => engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.get(id) }) as any).value as Record<string, unknown>;
      const value = (n: number) => JSON.parse(`{"__proto__":{"polluted":${n}},"k":[{"__proto__":${n}}]}`);
      const id = run((ctx) => ctx.db.insert("t", { a: "a", x: value(1) })) as string;
      const text = (n: number) => `{"__proto__":{"polluted":${n}},"k":[{"__proto__":${n}}]}`;
      expect(JSON.stringify(get(id).x)).toBe(text(1));
      expect(JSON.stringify(run((ctx) => {
        ctx.db.patch(id, { x: value(2) });
        return ctx.db.get(id).x;
      }))).toBe(text(2));
      expect(JSON.stringify(get(id).x)).toBe(text(2));
      run((ctx) => ctx.db.replace(id, { a: "b", x: value(3) }));
      const d = get(id);
      expect([d.a, JSON.stringify(d.x)]).toEqual(["b", text(3)]);
      expect(Object.getPrototypeOf(d.x)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      // At the top a "__proto__" key is a system-style name (fields may not start with "_"): every write refuses it.
      const top = JSON.parse('{"__proto__":{"a":"inherited"},"a":"c","x":1}');
      expect(() => run((ctx) => ctx.db.insert("t", top))).toThrow(/System field __proto__ cannot be written/);
      expect(() => run((ctx) => ctx.db.replace(id, top))).toThrow(/System field __proto__ cannot be written/);
      expect(() => run((ctx) => ctx.db.patch(id, top))).toThrow(/System field __proto__ cannot be written/);
      expect(get(id).a).toBe("b");
    }
  });
});
