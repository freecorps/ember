// node:sqlite quirks of Node 22 the engine's write path must not trust (DO SQLite has neither; runtime test
// `sqlite-text-bytes.test.ts`): TEXT read back cut at its first NUL (`SqlDriver.truncatesTextAtNul`), and a view over
// a zero-length ArrayBuffer bound as NULL (the test driver binds it as an empty BLOB).
import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import { createEngine, defineSchema, defineTable, mutationGeneric, queryGeneric, v, type SqlDriver, type SqlValue } from "../src/index.ts";
import { docKey, indexFields } from "../src/ddl.ts";

const schema = defineSchema({
  tables: { t: defineTable({ a: v.string(), b: v.bytes(), n: v.number() }).index("by_a", ["a"]) },
});
const M = (handler: (ctx: any) => unknown) => mutationGeneric({ handler }) as any;
const Q = (handler: (ctx: any) => unknown) => queryGeneric({ handler }) as any;

/** The test driver, reading TEXT as Node 22 does: cut at the first NUL. */
function truncating() {
  const inner = createNodeSqliteDriver();
  const cut = (x: SqlValue) => (typeof x === "string" && x.includes("\u0000") ? x.slice(0, x.indexOf("\u0000")) : x);
  const driver: SqlDriver = {
    truncatesTextAtNul: true,
    exec: (sql, ...params) => {
      const r = inner.exec(sql, ...params);
      return { ...r, rows: r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, x]) => [k, cut(x)]))) };
    },
    transaction: (fn) => inner.transaction(fn),
  };
  return { inner, driver };
}

function setup(driver: SqlDriver) {
  const engine = createEngine({ schema, driver, functions: {} });
  engine.migrate();
  const run = (h: (ctx: any) => unknown) => engine.runMutation(M(h), {}).value;
  const byA = (a: string) => (engine.runQuery(Q((ctx) => ctx.db.query("t").withIndex("by_a", (q: any) => q.eq("a", a)).collect())).value as any[]).map((d) => d.n);
  return { engine, run, byA };
}

describe("driver quirks", () => {
  test("TEXT cut at a NUL on read: a replace copying the cut value rewrites the index key, as main does", () => {
    const { inner, driver } = truncating();
    const s = setup(driver);
    const id = s.run((ctx) => ctx.db.insert("t", { a: "z\u0000tail", b: new Uint8Array([1]), n: 1 })) as string;
    // The read gives "z": the key must be "z"'s, as `main` (SELECT *, every key recomputed and compared with the
    // stored one) leaves it. The column is not rewritten (same value as read), in `main` too.
    s.run((ctx) => {
      const d = ctx.db.get(id);
      expect(d.a).toBe("z");
      ctx.db.replace(id, { a: d.a, b: d.b, n: 2 });
    });
    expect(s.byA("z")).toEqual([2]);
    const row = inner.exec(`SELECT * FROM "t"`).rows[0]!;
    expect(row._k_by_a).toEqual(docKey({ a: "z", _creationTime: row._creationTime, _id: id } as any, indexFields(s.engine.manifest.tables.t!, "by_a")!));
    // A patch of another field leaves a key that matches the document alone.
    s.run((ctx) => ctx.db.patch(id, { n: 3 }));
    expect(s.byA("z")).toEqual([3]);
  });

  test("the test driver reports the quirk of the Node it runs on", () => {
    const d = createNodeSqliteDriver();
    const s = (d.exec("SELECT ? AS s", "a\u0000b").rows[0]!.s as string);
    expect(d.truncatesTextAtNul).toBe(s !== "a\u0000b");
  });

  test("NUL in an indexed field over the real test driver: the key is the one of the value read, as in main", () => {
    const d = createNodeSqliteDriver();
    const s = setup(d);
    const id = s.run((ctx) => ctx.db.insert("t", { a: "z\u0000tail", b: new Uint8Array([1]), n: 1 })) as string;
    s.run((ctx) => {
      const x = ctx.db.get(id);
      ctx.db.replace(id, { a: x.a, b: x.b, n: 2 });
    });
    s.run((ctx) => ctx.db.patch(id, { n: 3 }));
    // Node 24: "z\0tail" whole. Node 22: "z" (the read cuts it), and the replace moved the key to it.
    const a = (s.engine.runQuery(Q((ctx) => ctx.db.get(id))).value as any).a as string;
    expect(a).toBe(d.truncatesTextAtNul ? "z" : "z\u0000tail");
    const row = d.exec(`SELECT * FROM "t"`).rows[0]!;
    expect(row._k_by_a).toEqual(docKey({ a, _creationTime: row._creationTime, _id: id } as any, indexFields(s.engine.manifest.tables.t!, "by_a")!));
    expect(s.byA(a)).toEqual([3]);
  });

  test("an empty byte view over a zero-length ArrayBuffer is stored as an empty BLOB, cached or not", () => {
    const d = createNodeSqliteDriver();
    const s = setup(d);
    const empty = () => new Uint8Array(new ArrayBuffer(0));
    const id = s.run((ctx) => {
      const id = ctx.db.insert("t", { a: "x", b: empty(), n: 1 });
      expect(ctx.db.get(id).b).toEqual(new Uint8Array(0));
      return id;
    }) as string;
    expect(d.exec(`SELECT typeof("b") AS t FROM "t"`).rows[0]!.t).toBe("blob");
    s.run((ctx) => ctx.db.patch(id, { b: new Uint8Array([1]) }));
    s.run((ctx) => {
      ctx.db.patch(id, { b: empty() });
      expect(ctx.db.get(id).b).toEqual(new Uint8Array(0));
    });
    expect(d.exec(`SELECT typeof("b") AS t FROM "t"`).rows[0]!.t).toBe("blob");
    expect((s.engine.runQuery(Q((ctx) => ctx.db.get(id))).value as any).b).toEqual(new Uint8Array(0));
  });
});
