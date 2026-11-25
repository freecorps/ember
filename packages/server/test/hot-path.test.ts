// PR 2A (hot-path CPU and allocations): every shortcut against the path it skips. Stored rows, results and errors
// must be what they were.

import { describe, expect, it } from "vitest";
import { compareValues, encodeKey, toSqlValue, ESCAPE, v, type ObjectShape } from "@freecorps/ember-values";
import { createNodeSqliteDriver } from "../src/testing.ts";
import { createEngine, createMatchIndex, defineSchema, defineTable, mutationGeneric, queryGeneric, sqlId, type SqlDriver, type SqlValue } from "../src/index.ts";
import { evalExpr, filterBuilder, passes, toExpr } from "../src/filter.ts";
import { idPrefix, parseId } from "../src/ids.ts";
import { decodeRow, layoutOf } from "../src/layout.ts";
import { QueryImpl } from "../src/query.ts";
import { coerceRow, SqlCache, compileSql } from "../src/sqlQuery.ts";
import { searchIndexKind } from "../src/search.ts";
import type { FilterExpr } from "../src/types.ts";
import type { IndexKind } from "../src/indexKinds.ts";
import { prng } from "./fixtures.ts";

const table = defineTable({
  a: v.string(),
  n: v.number(),
  big: v.int64(),
  flag: v.optional(v.boolean()),
  nb: v.union(v.number(), v.null()),
  meta: v.optional(v.object({ edited: v.boolean(), tags: v.array(v.string()) })),
  any: v.optional(v.any()),
})
  .index("by_a", ["a"])
  .index("by_n_a", ["n", "a"])
  .index("by_edited", ["meta.edited"])
  .index("by_flag", ["flag"])
  .searchIndex("search_a", { searchField: "a" });
const schema = defineSchema({ tables: { t: table } });

/** An engine whose UPDATEs are recorded (the columns each one sets). */
function shard(s = schema, driver: SqlDriver = createNodeSqliteDriver()) {
  let clock = 1_700_000_000_000;
  const r = prng(42);
  const updates: string[][] = [];
  const recording: SqlDriver = {
    ...driver,
    exec: (sql: string, ...p: SqlValue[]) => {
      const m = /^UPDATE "t" SET (.*) WHERE "_rowid" = \?$/.exec(sql);
      if (m) updates.push(m[1]!.split(", ").map((x) => x.replace(/ = \?$/, "")).sort());
      return driver.exec(sql, ...p);
    },
    transaction: (fn) => driver.transaction(fn),
  };
  const engine = createEngine({ schema: s, driver: recording, now: () => (clock += 1), random: r });
  engine.migrate();
  const mutate = <T>(fn: (db: any) => T): T => (engine.runMutation(mutationGeneric({ handler: (ctx: any) => fn(ctx.db) as any }) as any, {}) as { value: T }).value;
  const rows = () => driver.exec(`SELECT * FROM "t" ORDER BY "_rowid"`).rows;
  return { engine, driver, mutate, rows, updates };
}

const VALUES: Record<string, Array<() => unknown>> = {
  a: [() => "x", () => "y", () => "ação", () => "", () => "\u0000z"],
  n: [() => 1, () => 2.5, () => NaN, () => -0, () => 0, () => Infinity, () => -Infinity],
  big: [() => 0n, () => 5n, () => -(2n ** 63n)],
  flag: [() => true, () => false, () => undefined],
  nb: [() => null, () => 3, () => NaN],
  meta: [() => undefined, () => ({ edited: true, tags: [] }), () => ({ edited: false, tags: ["a"] })],
  any: [() => undefined, () => 1n, () => ({ deep: [new Uint8Array([0, 1])] }), () => "s", () => -0],
};
const FIELDS = Object.keys(VALUES);
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

describe("selective patch() and increment(): the same rows as a full rewrite", () => {
  it("random patches: every column, _json and _k_* as replace() writes them, and the same columns updated", () => {
    const r = prng(7);
    const viaPatch = shard();
    const viaReplace = shard();
    // node:sqlite on Node 22 (`truncatesTextAtNul`) reads a TEXT column back cut at its first NUL, so every document
    // read from such a row already differs from what was written (main does the same). A patch then recomputes index
    // keys from the cut string and replace() re-sets the "changed" column: neither is the engine path under test, so
    // that input stays out on such a driver. DO SQLite and Node 24 keep it (and `driver-quirks.test.ts` covers the cut).
    const values = viaPatch.driver.truncatesTextAtNul
      ? { ...VALUES, a: VALUES.a!.filter((x) => !String(x()).includes("\u0000")) }
      : VALUES;
    const ids: string[] = [];
    const docs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6; i++) {
      const doc: Record<string, unknown> = {};
      for (const f of FIELDS) {
        const x = pick(r, values[f]!)();
        if (x !== undefined) doc[f] = x;
      }
      const a = viaPatch.mutate((db) => db.insert("t", doc));
      const b = viaReplace.mutate((db) => db.insert("t", doc));
      expect(a).toBe(b);
      ids.push(a);
      docs.push(doc);
    }
    expect(viaPatch.rows()).toEqual(viaReplace.rows());
    for (let step = 0; step < 400; step++) {
      const i = Math.floor(r() * ids.length);
      const partial: Record<string, unknown> = {};
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
        const f = pick(r, FIELDS);
        partial[f] = pick(r, values[f]!)();
      }
      const next = { ...docs[i]! };
      for (const [k, x] of Object.entries(partial)) {
        if (x === undefined) delete next[k];
        else next[k] = x;
      }
      viaPatch.updates.length = 0;
      viaReplace.updates.length = 0;
      viaPatch.mutate((db) => db.patch(ids[i], partial));
      viaReplace.mutate((db) => db.replace(ids[i], next));
      docs[i] = next;
      expect(viaPatch.updates).toEqual(viaReplace.updates);
      expect(viaPatch.rows()).toEqual(viaReplace.rows());
    }
  });

  it("increment() of a column, an escaped value and an int64", () => {
    const a = shard();
    const b = shard();
    const doc = { a: "x", n: NaN, big: 1n, nb: null };
    const id = a.mutate((db) => db.insert("t", doc));
    b.mutate((db) => db.insert("t", doc));
    // NaN + 1 is NaN: the value stays escaped in _json.
    a.mutate((db) => db.increment(id, "n", 1));
    b.mutate((db) => db.replace(id, { ...doc, n: NaN }));
    expect(a.rows()).toEqual(b.rows());
    a.mutate((db) => db.patch(id, { n: 2 }));
    b.mutate((db) => db.replace(id, { ...doc, n: 2 }));
    expect(a.rows()).toEqual(b.rows());
    a.mutate((db) => db.increment(id, "n", -2));
    a.mutate((db) => db.increment(id, "big", 2n ** 62n));
    b.mutate((db) => db.replace(id, { ...doc, n: 0, big: 1n + 2n ** 62n }));
    expect(a.rows()).toEqual(b.rows());
  });

  it("a document with fields outside the schema (written by older code): a patch drops them, as a rewrite does", () => {
    const loose = defineSchema({ tables: { t: table }, schemaValidation: false });
    for (const partial of [{ a: "y" }, { n: 3 }, { flag: true }]) {
      const a = shard(loose);
      const b = shard(loose);
      const doc = { a: "x", n: 1, big: 0n, nb: null };
      const id = a.mutate((db) => db.insert("t", doc));
      b.mutate((db) => db.insert("t", doc));
      for (const s of [a, b]) s.driver.exec(`UPDATE "t" SET "_json" = '{"gone":{"x":1}}'`);
      expect(a.mutate((db) => db.get(id))).toMatchObject({ gone: { x: 1 } });
      a.mutate((db) => db.patch(id, partial));
      b.mutate((db) => db.replace(id, { ...doc, ...partial }));
      expect(a.rows()).toEqual(b.rows());
      expect(a.rows()[0]!._json).toBe("{}");
    }
  });

  it("a patch object with a \"__proto__\" key is refused (no inherited field reaches the merge) and writes nothing", () => {
    const a = shard();
    const id = a.mutate((db) => db.insert("t", { a: "x", n: 1, big: 0n, nb: null }));
    const before = a.rows();
    const partial = JSON.parse('{"__proto__": {"a": "inherited"}, "n": 2}');
    expect(() => a.mutate((db) => db.patch(id, partial))).toThrow(/System field __proto__ cannot be written/);
    expect(a.rows()).toEqual(before);
  });

  it("a patch that changes nothing writes nothing", () => {
    const s = shard();
    const id = s.mutate((db) => db.insert("t", { a: "x", n: 1, big: 0n, nb: null }));
    s.updates.length = 0;
    const r = s.engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.db.patch(id, { a: "x", n: 1 }) }) as any, {}) as { changes: unknown[] };
    expect(r.changes).toEqual([]);
    expect(s.updates).toEqual([]);
  });
});

describe("queries", () => {
  it("db.get in a query reads the data columns and returns the same document as in a mutation", () => {
    const s = shard();
    const id = s.mutate((db) => db.insert("t", { a: "x", n: -0, big: 3n, nb: null, meta: { edited: true, tags: ["q"] }, any: 2n }));
    const fromQuery = (s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.get(id) }) as any, {}) as { value: unknown }).value;
    const fromMutation = s.mutate((db) => db.get(id));
    expect(fromQuery).toEqual(fromMutation);
    expect(Object.is((fromQuery as { n: number }).n, -0)).toBe(true);
  });

  it("db.get records [key, key ++ 0x00) on by_id", () => {
    const s = shard();
    const id = s.mutate((db) => db.insert("t", { a: "x", n: 1, big: 0n, nb: null }));
    const { readSet } = s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.get(id) }) as any, {}) as { readSet: Array<{ lo: Uint8Array; hi: Uint8Array }> };
    const k = encodeKey([id]);
    expect(Uint8Array.from(readSet[0]!.lo)).toEqual(k);
    expect(readSet[0]!.hi).toEqual(Uint8Array.from([...k, 0]));
  });

  it("ctx keeps its fields, in order; storage and scheduler spread and assignable", () => {
    const s = shard();
    const seen = (s.engine.runQuery(
      queryGeneric({
        handler: (ctx: any) => {
          const keys = Object.keys(ctx);
          const copy = { ...ctx };
          const same = ctx.storage === ctx.storage && typeof ctx.scheduler.list === "function";
          ctx.storage = "replaced";
          return { keys, spread: typeof copy.storage.getUrl === "function" && typeof copy.scheduler.get === "function", same, replaced: ctx.storage };
        },
      }) as any,
      {},
    ) as { value: { keys: string[]; spread: boolean; same: boolean; replaced: string } }).value;
    expect(seen.keys).toEqual(["db", "auth", "now", "storage", "scheduler", "runQuery", "fail"]);
    expect(seen).toMatchObject({ spread: true, same: true, replaced: "replaced" });
  });

  it("a mutation's ctx: the same fields in the same order", () => {
    const s = shard();
    const out = (s.engine.runMutation(
      mutationGeneric({
        handler: (ctx: any) => {
          const keys = Object.keys(ctx);
          const { scheduler, storage } = { ...ctx };
          let refused = "";
          try {
            scheduler.runAfter(10, "missing:fn");
          } catch (e) {
            refused = (e as { code?: string }).code ?? String(e);
          }
          scheduler.cancel("job_x");
          return { keys, refused, upload: typeof storage.generateUploadUrl, sameSql: ctx.sql === ctx.sql, sameScheduler: ctx.scheduler === scheduler };
        },
      }) as any,
      {},
    ) as { value: unknown }).value;
    expect(out).toEqual({
      keys: ["db", "auth", "now", "random", "scheduler", "storage", "runQuery", "runMutation", "sql", "fail"],
      refused: "FunctionNotFound",
      upload: "function",
      sameSql: true,
      sameScheduler: true,
    });
  });

  it("plugin query methods live on a prototype, also for `new QueryImpl`", () => {
    const s = shard();
    s.mutate((db) => db.insert("t", { a: "hello world", n: 1, big: 0n, nb: null }));
    const out = (s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("t").withSearchIndex("search_a", (q: any) => q.search("a", "hello")).collect() }) as any, {}) as { value: unknown[] }).value;
    expect(out).toHaveLength(1);
    const kinds = new Map([["search", searchIndexKind]]);
    const env = { kinds } as unknown as ConstructorParameters<typeof QueryImpl>[0];
    const t = {} as ConstructorParameters<typeof QueryImpl>[1];
    const a = new QueryImpl(env, t) as unknown as Record<string, unknown>;
    const b = QueryImpl.of(env, t) as unknown as Record<string, unknown>;
    expect(typeof a.withSearchIndex).toBe("function");
    expect(Object.getPrototypeOf(a)).toBe(Object.getPrototypeOf(b));
    expect(a instanceof QueryImpl).toBe(true);
    expect(typeof (new QueryImpl({ kinds: new Map() } as unknown as typeof env, t) as unknown as Record<string, unknown>).withSearchIndex).toBe("undefined");
  });

  it("a plugin query method named like an instance field (`index`) still selects the plugin, as before", () => {
    const tag = { kind: "tag", queryMethod: "index" } as unknown as IndexKind;
    const other = { kind: "other", queryMethod: "withOtherIndex" } as unknown as IndexKind;
    const kinds = new Map([["tag", tag], ["other", other]]);
    const env = { kinds, isStaged: () => false } as unknown as ConstructorParameters<typeof QueryImpl>[0];
    const t = { name: "t", manifest: { indexes: [{ name: "by_tag", kind: "tag" }, { name: "by_other", kind: "other" }] } } as unknown as ConstructorParameters<typeof QueryImpl>[1];
    for (const make of [() => new QueryImpl(env, t), () => QueryImpl.of(env, t), () => QueryImpl.of(env, t)]) {
      const q = make() as unknown as Record<string, (name: string, arg: unknown) => unknown>;
      expect(q.index!("by_tag", "x")).toBe(q);
      expect((q as unknown as { plugin: unknown }).plugin).toEqual({ kind: tag, name: "by_tag", arg: "x" });
      // Methods that collide with nothing stay on the prototype.
      expect(Object.prototype.hasOwnProperty.call(q, "withOtherIndex")).toBe(false);
      const q2 = QueryImpl.of(env, t) as unknown as Record<string, (name: string, arg: unknown) => unknown>;
      expect(q2.withOtherIndex!("by_other", 1)).toBe(q2);
      expect((q2 as unknown as { plugin: unknown }).plugin).toEqual({ kind: other, name: "by_other", arg: 1 });
    }
  });
});

describe("ctx.db.sql: compiled once per template", () => {
  const tables = ["messages", "Users"];

  it("a cached template binds new values, keeps sql.id shapes apart and refuses the same values as before", () => {
    const cache = new SqlCache(tables);
    const run = (min: unknown, col = "likes") => {
      const strings = Object.freeze(Object.assign(["SELECT ", " FROM messages WHERE likes > ", ""], { raw: ["SELECT ", " FROM messages WHERE likes > ", ""] })) as unknown as TemplateStringsArray;
      return [strings, [sqlId(col), min]] as const;
    };
    const [strings, values] = run(5);
    const first = cache.compile(strings, values);
    expect(first).toEqual(compileSql(strings, values, tables));
    expect(cache.compile(strings, [sqlId("likes"), 7])).toEqual(compileSql(strings, [sqlId("likes"), 7], tables));
    expect(cache.compile(strings, [sqlId("body"), 7])).toEqual(compileSql(strings, [sqlId("body"), 7], tables));
    expect(() => cache.compile(strings, [sqlId("likes"), { x: 1 }])).toThrow(/unsupported parameter/);
    expect(() => cache.compile(strings, [sqlId("likes"), [1]])).toThrow(/unsupported parameter of type array/);
    // The result's arrays are the caller's.
    const a = cache.compile(strings, values);
    a.tables.push("x");
    a.params.push(1);
    expect(cache.compile(strings, values)).toEqual(first);
  });

  it("an unfrozen strings array (built by hand) is never cached", () => {
    const cache = new SqlCache(tables);
    const strings = Object.assign(["SELECT * FROM messages"], { raw: ["SELECT * FROM messages"] }) as unknown as TemplateStringsArray;
    expect(cache.compile(strings, []).tables).toEqual(["messages"]);
    (strings as unknown as string[])[0] = "SELECT * FROM users";
    expect(cache.compile(strings, []).tables).toEqual(["Users"]);
    (strings as unknown as string[])[0] = "DELETE FROM users";
    expect(() => cache.compile(strings, [])).toThrow(/only SELECT/);
  });

  it("a frozen strings array compiled with another number of values is not served from the cache", () => {
    const cache = new SqlCache(tables);
    const strings = Object.freeze(Object.assign(["SELECT 1 FROM messages", ""], { raw: ["SELECT 1 FROM messages", ""] })) as unknown as TemplateStringsArray;
    for (const values of [[], [2], [], [2], [sqlId("x")]]) {
      const want = (() => {
        try {
          return compileSql(strings, values, tables);
        } catch (e) {
          return String(e);
        }
      })();
      const got = (() => {
        try {
          return cache.compile(strings, values);
        } catch (e) {
          return String(e);
        }
      })();
      expect(got).toEqual(want);
    }
    // One value per gap (what a tag call passes): cached and rebound.
    const gap = Object.freeze(Object.assign(["SELECT * FROM messages WHERE likes > ", ""], { raw: ["", ""] })) as unknown as TemplateStringsArray;
    expect(cache.compile(gap, [1])).toEqual(compileSql(gap, [1], tables));
    expect(cache.compile(gap, [2])).toEqual(compileSql(gap, [2], tables));
  });

  it("different scopes (schema tables) do not share results", () => {
    const strings = Object.freeze(Object.assign(["SELECT * FROM messages"], { raw: ["SELECT * FROM messages"] })) as unknown as TemplateStringsArray;
    expect(new SqlCache(["messages"]).compile(strings, []).tables).toEqual(["messages"]);
    expect(() => new SqlCache(["other"]).compile(strings, [])).toThrow(/unknown table/);
  });

  it("an invalid template is refused at every run", () => {
    const cache = new SqlCache(tables);
    const strings = Object.freeze(Object.assign(["SELECT * FROM nope WHERE x = ", ""], { raw: ["", ""] })) as unknown as TemplateStringsArray;
    for (let i = 0; i < 3; i++) expect(() => cache.compile(strings, [1])).toThrow(/unknown table/);
  });

  it("the engine's ctx.db.sql over a real template", () => {
    const s = shard();
    s.mutate((db) => db.insert("t", { a: "x", n: 1, big: 0n, nb: null }));
    s.mutate((db) => db.insert("t", { a: "y", n: 5, big: 0n, nb: null }));
    const count = (min: number) => (s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.sql`SELECT count(*) AS c FROM t WHERE n > ${min}` }) as any, {}) as { value: Array<{ c: number }> }).value[0]!.c;
    expect([count(0), count(2), count(9), count(0)]).toEqual([2, 1, 0, 2]);
  });
});

/** The uncompiled `coerceRow`, verbatim. */
function refCoerceRow(shape: any, row: Record<string, unknown>): unknown {
  const accepts = (s: any, kind: string): boolean => s.kind === kind || s.kind === "any" || (s.kind === "union" && s.members.some((m: any) => accepts(m, kind)));
  const coerceValue = (s: any, x: unknown): unknown => {
    if (x === null) return null;
    if ((typeof x === "number" || typeof x === "bigint") && accepts(s, "boolean") && !accepts(s, "number") && (x == 0 || x == 1)) return x == 1;
    if ((typeof x === "string" || typeof x === "number") && accepts(s, "int64") && !accepts(s, typeof x === "string" ? "string" : "number")) {
      try {
        return BigInt(x);
      } catch {
        return x;
      }
    }
    if (typeof x === "bigint" && accepts(s, "number") && !accepts(s, "int64")) return Number(x);
    if (typeof x === "string" && (s.kind === "object" || s.kind === "array" || s.kind === "record")) {
      try {
        return JSON.parse(x);
      } catch {
        return x;
      }
    }
    return x;
  };
  if (shape.kind !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(row)) {
    const f = shape.fields[k];
    if (!f) {
      out[k] = x;
      continue;
    }
    out[k] = coerceValue(f.shape, x);
    if (out[k] === null && f.optional && !accepts(f.shape, "null")) delete out[k];
  }
  return out;
}

describe("coerceRow compiled per shape", () => {
  it("agrees with the uncompiled rules", () => {
    const shape = v.object({
      b: v.boolean(),
      bn: v.union(v.boolean(), v.number()),
      i: v.int64(),
      is: v.union(v.int64(), v.string()),
      n: v.number(),
      o: v.optional(v.object({ x: v.number() })),
      arr: v.array(v.number()),
      on: v.optional(v.union(v.string(), v.null())),
      os: v.optional(v.string()),
      a: v.any(),
    }).shape as ObjectShape;
    const cells: unknown[] = [null, 0, 1, 2, 0n, 1n, 5n, "0", "1", "12", "x", "1.5", '{"x":1}', "[1,2]", "{bad", 3.5];
    const r = prng(3);
    for (let i = 0; i < 3000; i++) {
      const row: Record<string, unknown> = {};
      for (const k of [...Object.keys(shape.fields), "extra"]) if (r() < 0.7) row[k] = pick(r, cells);
      expect(coerceRow(shape, row)).toEqual(refCoerceRow(shape, row));
    }
  });
});

describe("filters compiled once per expression", () => {
  const f = filterBuilder;
  const docs = [{ a: 1, b: "x", c: { d: 2 } }, { a: 2, b: "y" }, { a: NaN, c: { d: 1n } }, {}, { a: -0, b: null }];
  const randomExpr = (r: () => number, depth: number): unknown => {
    const leaf = () => (r() < 0.5 ? f.field(pick(r, ["a", "b", "c.d", "c", "missing"])) : pick(r, [1, 2, "x", null, NaN, -0, 1n, { d: 2 }]));
    if (depth > 3) return leaf();
    switch (Math.floor(r() * 4)) {
      case 0:
        return (f as any)[pick(r, ["eq", "neq", "lt", "lte", "gt", "gte"])](leaf(), leaf());
      case 1:
        return f.and(...Array.from({ length: Math.floor(r() * 3) }, () => randomExpr(r, depth + 1)));
      case 2:
        return f.or(...Array.from({ length: Math.floor(r() * 3) }, () => randomExpr(r, depth + 1)));
      default:
        return f.not(randomExpr(r, depth + 1));
    }
  };

  it("agrees with evalExpr (valid and odd expressions)", () => {
    const r = prng(9);
    for (let i = 0; i < 2000; i++) {
      const e = toExpr(randomExpr(r, 0));
      for (const d of docs) expect(passes(e, d)).toBe(evalExpr(e, d) === true);
    }
    const odd: FilterExpr[] = [{ op: "zz", args: [{ literal: 1 }, { literal: 1 }] } as unknown as FilterExpr, { op: "and", args: [] }, { op: "or", args: [] }];
    for (const e of odd) for (const d of docs) expect(passes(e, d)).toBe(evalExpr(e, d) === true);
    const broken = { op: "not", args: [] } as unknown as FilterExpr;
    expect(() => passes(broken, {})).toThrow();
    expect(() => evalExpr(broken, {})).toThrow();
    expect(passes(undefined, {})).toBe(true);
    expect(compareValues(1, 1)).toBe(0);
  });
});

describe("ids, rows, read sets", () => {
  it("idPrefix accepts exactly what parseId accepts", () => {
    const r = prng(5);
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZabcILOU_-é";
    const samples: unknown[] = [null, 5, "", "_", "a_", "_01J9Z3ABCDEFGHJKMNPQRSTVWX", "msg_01J9Z3ABCDEFGHJKMNPQRSTVWX", "a_b_01J9Z3ABCDEFGHJKMNPQRSTVWX", "msg_01j9z3abcdefghjkmnpqrstvwx"];
    for (let i = 0; i < 5000; i++) {
      let s = r() < 0.5 ? "msg_" : "";
      const n = r() < 0.6 ? 26 : Math.floor(r() * 30);
      for (let k = 0; k < n; k++) s += alphabet[Math.floor(r() * (r() < 0.9 ? 32 : alphabet.length))];
      samples.push(s);
    }
    for (const id of samples) expect(idPrefix(id)).toBe(parseId(id)?.prefix);
  });

  it("decodeRow: the `_json = {}` fast path gives what the general path gives", () => {
    const docShape = v.object({ s: v.string(), n: v.optional(v.number()), nb: v.union(v.boolean(), v.null()), o: v.optional(v.object({ x: v.number() })), b: v.bytes() }).shape as ObjectShape;
    const layout = layoutOf("t", docShape);
    const row = { _id: "t_1", _creationTime: 5, _json: "{}", s: "x", n: null, nb: null, b: new Uint8Array([1]) };
    expect(decodeRow(layout, row)).toEqual({ _id: "t_1", _creationTime: 5, s: "x", nb: null, b: new Uint8Array([1]) });
    expect(Object.keys(decodeRow(layout, row))).toEqual(["_id", "_creationTime", "s", "nb", "b"]);
    expect(decodeRow(layout, { ...row, nb: 1, n: 2.5 })).toEqual({ _id: "t_1", _creationTime: 5, s: "x", n: 2.5, nb: true, b: new Uint8Array([1]) });
    // A field named like an Object.prototype member takes the general path (unchanged behaviour).
    const odd = layoutOf("t", v.object({ toString: v.optional(v.string()), s: v.string() }).shape as ObjectShape);
    const general = decodeRow(odd, { _id: "t_1", _creationTime: 5, _json: '{"z":1}', toString: null, s: "x" });
    expect(Object.keys(decodeRow(odd, { _id: "t_1", _creationTime: 5, _json: "{}", toString: null, s: "x" }))).toEqual(Object.keys(general).filter((k) => k !== "z"));
    expect(toSqlValue("real", NaN)).toBe(ESCAPE);
  });

  it("matchIndex: re-registering the same read set keeps it; a different one replaces it", () => {
    const s = shard();
    const id = s.mutate((db) => db.insert("t", { a: "x", n: 1, big: 0n, nb: null }));
    const index = createMatchIndex<string>(schema);
    const q = (a: string) => (s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("t").withIndex("by_a", (b: any) => b.eq("a", a)).collect() }) as any, {}) as { readSet: any }).readSet;
    const doc = s.mutate((db) => db.get(id));
    const change = (before: any, after: any) => [{ table: "t", id, before, after }];
    index.set("k", q("x"));
    index.set("k", q("x"));
    expect(index.size).toBe(1);
    expect([...index.match(change(doc, { ...doc, n: 2 })).exact]).toEqual(["k"]);
    index.set("k", q("zzz"));
    expect([...index.match(change(doc, { ...doc, n: 2 })).exact]).toEqual([]);
    expect([...index.match(change({ ...doc, a: "zzz" }, { ...doc, a: "zzz", n: 3 })).exact]).toEqual(["k"]);
    // Same read set, different table-wide list: replaced.
    index.set("k", q("zzz"), ["t"]);
    expect([...index.match(change(doc, { ...doc, n: 2 })).exact]).toEqual(["k"]);
    index.set("k", q("zzz"));
    expect([...index.match(change(doc, { ...doc, n: 2 })).exact]).toEqual([]);
    // A search entry whose result ids changed is replaced too (its data differs).
    const search = (text: string) => (s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("t").withSearchIndex("search_a", (b: any) => b.search("a", text)).collect() }) as any, {}) as { readSet: any }).readSet;
    index.set("s", search("x"));
    expect(index.match(change(doc, { ...doc, n: 9 })).exact.has("s")).toBe(true);
    s.mutate((db) => db.patch(id, { a: "other" }));
    index.set("s", search("x"));
    expect(index.match(change({ ...doc, a: "other" }, { ...doc, a: "other", n: 9 })).exact.has("s")).toBe(false);
  });

  it("matchIndex: an entry changed in place and registered again is compared by its new bounds", () => {
    const s = shard();
    const id = s.mutate((db) => db.insert("t", { a: "x", n: 1, big: 0n, nb: null }));
    const doc = s.mutate((db) => db.get(id));
    const q = (a: string) => (s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("t").withIndex("by_a", (b: any) => b.eq("a", a)).collect() }) as any, {}) as { readSet: any[] }).readSet;
    const index = createMatchIndex<string>(schema);
    const rs = q("x");
    index.set("k", rs);
    const y = q("y")[0];
    Object.assign(rs[0], { lo: y.lo, hi: y.hi });
    index.set("k", rs);
    expect(index.match([{ table: "t", id, before: { ...doc, a: "y" }, after: { ...doc, a: "y", n: 2 } }]).exact.has("k")).toBe(true);
    expect(index.match([{ table: "t", id, before: doc, after: { ...doc, n: 2 } }]).exact.has("k")).toBe(false);
  });

  it("matchIndex: an entry changed in place after registering does not move the registration; a later equal set keeps it", () => {
    const s = shard();
    const id = s.mutate((db) => db.insert("t", { a: "x", n: 1, big: 0n, nb: null }));
    const doc = s.mutate((db) => db.get(id));
    const q = (n: number) => (s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("t").withIndex("by_a", (b: any) => b.eq("a", "x")).filter((f: any) => f.eq(f.field("n"), n)).collect() }) as any, {}) as { readSet: any[] }).readSet;
    const index = createMatchIndex<string>(schema);
    const rs = q(1);
    index.set("k", rs);
    // The caller reuses its entry for something else (another filter): the registration keeps the filter it was set
    // with, and a later set with an equal read set (no rebuild) still matches what that filter matches.
    rs[0].filter = q(5)[0].filter;
    index.set("k", q(1));
    expect(index.match([{ table: "t", id, before: null, after: { ...doc, n: 1 } }]).exact.has("k")).toBe(true);
    expect(index.match([{ table: "t", id, before: null, after: { ...doc, n: 5 } }]).exact.has("k")).toBe(false);
  });

  it("matchIndex: an update whose index fields did not move matches through one key", () => {
    const index = createMatchIndex<string>(schema);
    const s = shard();
    const id = s.mutate((db) => db.insert("t", { a: "x", n: 1, big: 0n, nb: null, meta: { edited: true, tags: [] } }));
    const doc = s.mutate((db) => db.get(id));
    const rs = (s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("t").withIndex("by_edited", (b: any) => b.eq("meta.edited", true)).filter((q: any) => q.eq(q.field("n"), 2)).collect() }) as any, {}) as { readSet: any }).readSet;
    index.set("k", rs);
    // meta is a new object with the same value: two keys, equal; the filter passes on the new version.
    expect(index.match([{ table: "t", id, before: doc, after: { ...doc, n: 2, meta: { edited: true, tags: [] } } }]).exact.has("k")).toBe(true);
    expect(index.match([{ table: "t", id, before: doc, after: { ...doc, n: 3 } }]).exact.has("k")).toBe(false);
    expect(index.match([{ table: "t", id, before: { ...doc, n: 2 }, after: { ...doc, n: 3 } }]).exact.has("k")).toBe(true);
    // -0 and 0 are different keys.
    const rs0 = (s.engine.runQuery(queryGeneric({ handler: (ctx: any) => ctx.db.query("t").withIndex("by_n_a", (b: any) => b.eq("n", -0)).collect() }) as any, {}) as { readSet: any }).readSet;
    index.set("z", rs0);
    expect(index.match([{ table: "t", id, before: { ...doc, n: 0 }, after: { ...doc, n: 0, big: 1n } }]).exact.has("z")).toBe(false);
    expect(index.match([{ table: "t", id, before: { ...doc, n: -0 }, after: { ...doc, n: -0, big: 1n } }]).exact.has("z")).toBe(true);
  });
});
