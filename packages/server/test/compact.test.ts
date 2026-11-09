// Compact storage (storage.ts): one row written per inserted document, `_rowid` = `_creationTime` in µs, the id
// carries the rowid; conversion of classic tables keeps every id, document, order, index, search and aggregate.

import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import { idMicros, makeIdMicros, parseId } from "../src/ids.ts";
import { createEngine, defineSchema, defineTable, mutationGeneric, queryGeneric, v, type QueryCtx, type SchemaDefinition } from "../src/index.ts";

const M = (handler: (db: any) => unknown) => mutationGeneric({ handler: (ctx: any) => handler(ctx.db) }) as any;
const Q = (handler: (db: any) => unknown) => queryGeneric({ handler: (ctx: QueryCtx) => handler(ctx.db) }) as any;

const schema = defineSchema({
  tables: {
    notes: defineTable({ text: v.string(), n: v.number(), tag: v.optional(v.string()) })
      .index("by_n", ["n"])
      .searchIndex("search_text", { searchField: "text" })
      .aggregate("per_tag", { by: ["tag"], count: true, sum: ["n"] }),
  },
});

function setup(opts: { tableStorage?: "compact" | "classic"; now?: () => number; driver?: ReturnType<typeof createNodeSqliteDriver>; schema?: SchemaDefinition<any, any> } = {}) {
  const driver = opts.driver ?? createNodeSqliteDriver();
  const engine = createEngine({ schema: opts.schema ?? schema, driver, ...(opts.now ? { now: opts.now } : {}), ...(opts.tableStorage ? { tableStorage: opts.tableStorage } : {}) });
  const report = engine.migrate();
  const run = (h: (db: any) => unknown) => engine.runMutation(M(h)).value;
  const read = (h: (db: any) => unknown) => engine.runQuery(Q(h)).value;
  const sql = (s: string, ...p: any[]) => driver.exec(s, ...p).rows;
  const written = (fn: () => unknown) => {
    let n = 0;
    const exec = driver.exec.bind(driver);
    driver.exec = (s: string, ...p: any[]) => {
      const r = exec(s, ...p);
      n += r.rowsWritten;
      return r;
    };
    try {
      fn();
    } finally {
      driver.exec = exec;
    }
    return n;
  };
  return { driver, engine, report, run, read, sql, written };
}

describe("ids", () => {
  test("a compact id carries its µs and is a valid, time-sortable ULID", () => {
    const rnd = () => 0.5;
    for (const us of [0, 999, 1_000, 1_700_000_000_000_123, 1_700_000_000_000_999]) {
      const id = makeIdMicros("note", us, rnd);
      expect(parseId(id)?.prefix).toBe("note");
      expect(idMicros(id)).toBe(us);
    }
    const ids = [1_000_001, 1_000_002, 1_000_999, 1_001_000].map((us) => makeIdMicros("n", us, Math.random));
    expect([...ids].sort()).toEqual(ids);
  });
});

describe("compact tables", () => {
  test("DDL: no _id index, no by_creation_time index", () => {
    const s = setup();
    const ddl = s.sql(`SELECT name, sql FROM sqlite_master WHERE tbl_name = 'notes' AND type IN ('table', 'index')`) as Array<{ name: string; sql: string | null }>;
    expect(ddl.find((r) => r.name === "notes")!.sql).toMatch(/"_id" TEXT NOT NULL,/);
    expect(ddl.map((r) => r.name)).not.toContain("notes__by_creation_time");
    expect(ddl.map((r) => r.name)).toContain("notes__by_n");
    expect(s.sql(`SELECT value FROM _ember_meta WHERE key = 'storage'`)[0]?.value).toBe("2");
  });

  test("an insert is one statement on the document's table (node:sqlite counts rows, not index entries: see the runtime's rows-written test)", () => {
    const plain = setup({ schema: defineSchema({ tables: { t: defineTable({ a: v.string() }) } }) });
    expect(plain.written(() => plain.run((db) => db.insert("t", { a: "x" })))).toBe(1);
    const indexes = (s: ReturnType<typeof setup>) => s.sql(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 't' AND sql IS NOT NULL`).map((r: any) => r.name);
    expect(indexes(plain)).toEqual([]);
    const classic = setup({ tableStorage: "classic", schema: defineSchema({ tables: { t: defineTable({ a: v.string() }) } }) });
    expect(indexes(classic)).toEqual(["t__by_creation_time"]);
  });

  test("rowid = creation µs, unique and increasing even inside one millisecond", () => {
    const s = setup({ now: () => 1_700_000_000_000 });
    const ids = s.run((db) => Array.from({ length: 5 }, (_, i) => db.insert("notes", { text: `t${i}`, n: i }))) as string[];
    const rows = s.sql(`SELECT _rowid, _id, _creationTime FROM notes ORDER BY _rowid`) as any[];
    expect(rows.map((r) => r._id)).toEqual(ids);
    rows.forEach((r, i) => {
      expect(r._rowid).toBe(1_700_000_000_000_000 + i);
      expect(idMicros(r._id)).toBe(r._rowid);
      expect(Math.round(r._creationTime * 1000)).toBe(r._rowid);
    });
    for (const id of ids) expect((s.read((db) => db.get(id)) as any)._id).toBe(id);
  });

  test("by_creation_time: order, bounds and pagination match the classic table", () => {
    let t = 1_700_000_000_000;
    const clock = () => (t += 0.4);
    const compact = setup({ now: clock });
    t = 1_700_000_000_000;
    const classic = setup({ now: clock, tableStorage: "classic" });
    for (const s of [compact, classic]) {
      t = 1_700_000_000_000;
      for (let i = 0; i < 40; i++) s.run((db) => db.insert("notes", { text: `t${i}`, n: i % 7 }));
    }
    const strip = (docs: any[]) => docs.map((d) => d.text);
    const cases: Array<(db: any) => unknown> = [
      (db) => db.query("notes").collect(),
      (db) => db.query("notes").order("desc").collect(),
      (db) => db.query("notes").order("desc").take(7),
      (db) => db.query("notes").withIndex("by_creation_time", (q: any) => q.gt("_creationTime", 1_700_000_000_004)).collect(),
      (db) => db.query("notes").withIndex("by_creation_time", (q: any) => q.gte("_creationTime", 1_700_000_000_004).lt("_creationTime", 1_700_000_000_009)).collect(),
      (db) => db.query("notes").withIndex("by_creation_time", (q: any) => q.lte("_creationTime", 1_700_000_000_002)).order("desc").collect(),
      (db) => db.query("notes").withIndex("by_creation_time", (q: any) => q.eq("_creationTime", 1_700_000_000_002)).collect(),
      (db) => db.query("notes").filter((q: any) => q.eq(q.field("n"), 3)).collect(),
    ];
    for (const c of cases) {
      const a = compact.read(c) as any[];
      const b = classic.read(c) as any[];
      expect(strip(a)).toEqual(strip(b));
    }
    // Pagination: every page, both directions.
    for (const order of ["asc", "desc"] as const) {
      const pages = (s: typeof compact) => {
        const out: string[][] = [];
        let cursor: string | null = null;
        for (;;) {
          const p = s.read((db) => db.query("notes").order(order).paginate({ numItems: 6, cursor })) as any;
          out.push(p.page.map((d: any) => d.text));
          if (p.isDone) return out;
          cursor = p.continueCursor;
        }
      };
      expect(pages(compact)).toEqual(pages(classic));
    }
  });

  test("patch, replace, delete, search and aggregates work on compact rows", () => {
    const s = setup();
    const [a, b] = s.run((db) => [db.insert("notes", { text: "hello world", n: 1, tag: "x" }), db.insert("notes", { text: "bye world", n: 2, tag: "x" })]) as string[];
    s.run((db) => db.patch(a, { n: 10 }));
    s.run((db) => db.replace(b, { text: "bye moon", n: 3, tag: "y" }));
    expect((s.read((db) => db.get(a)) as any).n).toBe(10);
    expect((s.read((db) => db.query("notes").withSearchIndex("search_text", (q: any) => q.search("text", "world")).collect()) as any[]).map((d) => d._id)).toEqual([a]);
    expect((s.read((db) => db.aggregate("notes", "per_tag").get(["x"])) as any).count).toBe(1);
    s.run((db) => db.delete(a));
    expect(s.read((db) => db.get(a))).toBeNull();
    expect((s.read((db) => db.aggregate("notes", "per_tag").get(["x"])) as any).count).toBe(0);
  });

  test("a reopened engine keeps rowids increasing past the stored ones, even with a clock behind", () => {
    const driver = createNodeSqliteDriver();
    const one = setup({ driver, now: () => 2_000_000_000_000 });
    const first = one.run((db) => db.insert("notes", { text: "a", n: 1 })) as string;
    const two = setup({ driver, now: () => 1_000_000_000_000 });
    const second = two.run((db) => db.insert("notes", { text: "b", n: 2 })) as string;
    expect(idMicros(second)!).toBeGreaterThan(idMicros(first)!);
    expect((two.read((db) => db.query("notes").collect()) as any[]).map((d) => d.text)).toEqual(["a", "b"]);
  });
});

describe("classic -> compact conversion", () => {
  test("keeps ids, documents, order, indexes, search and aggregates; old ids read through the legacy index", () => {
    const driver = createNodeSqliteDriver();
    let t = 1_700_000_000_000;
    // Classic engines restarted inside one millisecond hand out the same `_creationTime`: the conversion spreads them.
    const classicA = setup({ driver, tableStorage: "classic", now: () => t });
    const ids: string[] = [];
    ids.push(...(classicA.run((db) => [db.insert("notes", { text: "alpha one", n: 1, tag: "x" }), db.insert("notes", { text: "beta", n: 2, tag: "x" })]) as string[]));
    const classicB = setup({ driver, tableStorage: "classic", now: () => t });
    ids.push(classicB.run((db) => db.insert("notes", { text: "gamma one", n: 3, tag: "y" })) as string);
    t += 5;
    ids.push(classicB.run((db) => db.insert("notes", { text: "delta", n: 4 })) as string);
    const before = classicB.read((db) => db.query("notes").collect()) as any[];
    const order = before.map((d) => d._id);
    expect(new Set(before.map((d) => Math.round(d._creationTime * 1000))).size).toBeLessThan(before.length);

    t += 5;
    const s = setup({ driver, now: () => t });
    expect(s.report.compacted).toEqual(["notes"]);
    expect(s.sql(`SELECT value FROM _ember_meta WHERE key = 'storage'`)[0]?.value).toBe("2");
    expect(s.sql(`SELECT sql FROM sqlite_master WHERE name = 'notes__by_id'`)[0]?.sql).toMatch(/WHERE "_legacy" IS NOT NULL/);

    // Same documents (a spread `_creationTime` moves by at most a few µs), same order, every old id readable.
    const after = s.read((db) => db.query("notes").collect()) as any[];
    expect(after.map((d) => d._id)).toEqual(order);
    after.forEach((d, i) => {
      expect({ ...d, _creationTime: 0 }).toEqual({ ...before[i], _creationTime: 0 });
      expect(Math.abs(d._creationTime - before[i]._creationTime)).toBeLessThan(0.01);
    });
    for (const id of ids) expect((s.read((db) => db.get(id)) as any)?._id).toBe(id);
    expect((s.read((db) => db.query("notes").withIndex("by_n", (q: any) => q.gte("n", 3)).collect()) as any[]).map((d) => d.n)).toEqual([3, 4]);
    expect((s.read((db) => db.query("notes").withSearchIndex("search_text", (q: any) => q.search("text", "one")).collect()) as any[]).length).toBe(2);
    expect((s.read((db) => db.aggregate("notes", "per_tag").get(["x"])) as any).count).toBe(2);

    // New rows: compact ids, one row each plus the user index, never in the legacy index.
    const fresh = s.run((db) => db.insert("notes", { text: "epsilon one", n: 5, tag: "x" })) as string;
    expect(idMicros(fresh)).toBe(Number(s.sql(`SELECT _rowid FROM notes WHERE _id = ?`, fresh)[0]!._rowid));
    expect(s.sql(`SELECT _legacy FROM notes WHERE _id = ?`, fresh)[0]!._legacy).toBeNull();
    expect((s.read((db) => db.query("notes").collect()) as any[]).map((d) => d._id)).toEqual([...order, fresh]);
    expect((s.read((db) => db.aggregate("notes", "per_tag").get(["x"])) as any).count).toBe(3);
    s.run((db) => db.patch(ids[0], { n: 100 }));
    expect((s.read((db) => db.get(ids[0])) as any).n).toBe(100);

    // A later migrate (same schema) has nothing left to do; the plan keeps the legacy index.
    const again = setup({ driver, now: () => t });
    expect(again.report.compacted).toBeUndefined();
    expect(again.engine.planMigration().steps.filter((x) => x.op !== "noop")).toEqual([]);
    expect(again.engine.storageBehind()).toBe(false);
  });

  test("an empty classic table becomes compact without a legacy index", () => {
    const driver = createNodeSqliteDriver();
    setup({ driver, tableStorage: "classic" });
    const s = setup({ driver });
    expect(s.report.compacted).toEqual(["notes"]);
    expect(s.sql(`SELECT name FROM sqlite_master WHERE name = 'notes__by_id'`)).toEqual([]);
    const id = s.run((db) => db.insert("notes", { text: "a", n: 1 })) as string;
    expect((s.read((db) => db.get(id)) as any).text).toBe("a");
  });

  test("a classic table with a backfill in progress waits for a later migrate", () => {
    const driver = createNodeSqliteDriver();
    const base = defineSchema({ tables: { notes: defineTable({ text: v.string(), n: v.number() }) } });
    const c = setup({ driver, tableStorage: "classic", schema: base });
    c.run((db) => db.insert("notes", { text: "a", n: 1 }));
    const withIndex = defineSchema({ tables: { notes: defineTable({ text: v.string(), n: v.number() }).index("by_n", ["n"]) } });
    const s = setup({ driver, schema: withIndex });
    expect(s.report.compacted).toBeUndefined();
    expect(s.engine.storageBehind()).toBe(true);
    let last;
    do last = s.engine.backfillStep(10);
    while (!last.done);
    // The same engine converts the table as soon as the backfill is done.
    expect(last.compacted).toEqual(["notes"]);
    expect(s.engine.storageBehind()).toBe(false);
    expect((s.read((db) => db.query("notes").withIndex("by_n", (q: any) => q.eq("n", 1)).collect()) as any[]).length).toBe(1);
    const id = s.run((db) => db.insert("notes", { text: "b", n: 2 })) as string;
    expect((s.read((db) => db.get(id)) as any).text).toBe("b");
  });

  test("a table skipped by a conversion error does not stop the others, and a later schema change retries it", () => {
    const driver = createNodeSqliteDriver();
    const two = defineSchema({ tables: { a: defineTable({ x: v.string() }), b: defineTable({ x: v.string() }) } });
    const c = setup({ driver, tableStorage: "classic", schema: two });
    c.run((db) => [db.insert("a", { x: "1" }), db.insert("b", { x: "2" })]);
    // A stray column the schema does not know: "b" cannot convert yet.
    driver.exec(`ALTER TABLE "b" ADD COLUMN "_stray" TEXT`);
    const s = setup({ driver, schema: two });
    expect(s.report.compacted).toEqual(["a"]);
    expect(s.engine.storageBehind()).toBe(false);
    driver.exec(`ALTER TABLE "b" DROP COLUMN "_stray"`);
    const next = defineSchema({ tables: { a: defineTable({ x: v.string() }), b: defineTable({ x: v.string(), y: v.optional(v.string()) }) } });
    const later = setup({ driver, schema: next });
    expect(later.report.compacted).toEqual(["b"]);
  });
});
