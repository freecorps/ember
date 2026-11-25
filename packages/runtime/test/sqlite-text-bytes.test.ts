// DO SQLite round-trips what the engine's write path assumes (engine.ts `keyChanged`, `writtenRow`): a TEXT value with
// an embedded NUL comes back whole (no truncation at the NUL), and an empty BLOB stays an empty BLOB (not NULL). The
// real engine over `DoSqlDriver`: insert, patch other fields, patch the indexed field, read back; stored `_k_*` checked.
import { runInDurableObject } from "cloudflare:test";
import { createEngine, defineSchema, defineTable, docKey, indexFields, mutationGeneric, queryGeneric, v } from "@freecorps/ember-server";
import { describe, expect, it } from "vitest";
import { DoSqlDriver } from "../src/sql-driver.ts";
import { shardStub } from "./helpers.ts";

const schema = defineSchema({
  tables: { nulprobe: defineTable({ a: v.string(), b: v.bytes(), n: v.number() }).index("by_a", ["a"]) },
});
const M = (handler: (ctx: any, a: any) => unknown) => mutationGeneric({ handler }) as any;
const Q = (handler: (ctx: any, a: any) => unknown) => queryGeneric({ handler }) as any;

describe("DO SQLite: NUL in TEXT, empty BLOB", () => {
  it("raw driver: TEXT with NUL reads back whole; empty BLOB is a blob", async () => {
    await runInDurableObject(shardStub(`nul-raw-${crypto.randomUUID()}`), async (_inst, state) => {
      const sql = state.storage.sql;
      const row = sql.exec("SELECT ? AS s, length(CAST(? AS BLOB)) AS l, typeof(?) AS t, ? AS e", "z\u0000tail", "z\u0000tail", new Uint8Array(0), new Uint8Array(0)).one();
      expect(row.s).toBe("z\u0000tail");
      expect(row.l).toBe(6);
      expect(row.t).toBe("blob");
      expect(new Uint8Array(row.e as ArrayBuffer).length).toBe(0);
      // A view over a zero-length ArrayBuffer (node:sqlite on Node 22 binds it as NULL) is a blob here too.
      expect(sql.exec("SELECT typeof(?) AS t", new Uint8Array(new ArrayBuffer(0))).one().t).toBe("blob");
    });
  });

  it("engine: insert, patch other fields, patch the indexed field; value and _k_* stay right", async () => {
    await runInDurableObject(shardStub(`nul-engine-${crypto.randomUUID()}`), async (_inst, state) => {
      const driver = new DoSqlDriver(state.storage);
      const engine = createEngine({ schema, driver, functions: {} });
      engine.migrate();
      const run = (h: (ctx: any) => unknown) => engine.runMutation(M(h), {}).value;
      const byA = (a: string) => engine.runQuery(Q((ctx) => ctx.db.query("nulprobe").withIndex("by_a", (q: any) => q.eq("a", a)).collect())).value as any[];
      const stored = () => state.storage.sql.exec(`SELECT * FROM "nulprobe"`).toArray()[0]!;
      const check = (a: string, n: number) => {
        const row = stored();
        expect(row.a).toBe(a);
        const fields = indexFields(engine.manifest.tables.nulprobe!, "by_a")!;
        expect(new Uint8Array(row["_k_by_a"] as ArrayBuffer)).toEqual(docKey({ a, _creationTime: row._creationTime, _id: id } as any, fields));
        expect(byA(a).map((d) => d.n)).toEqual([n]);
      };

      const id = run((ctx) => ctx.db.insert("nulprobe", { a: "z\u0000tail", b: new Uint8Array(new ArrayBuffer(0)), n: 1 })) as string;
      // Read back in the same mutation (write-through cache) and in a new one (storage).
      const same = run((ctx) => ctx.db.get(id)) as any;
      expect(same.a).toBe("z\u0000tail");
      expect(same.b).toEqual(new Uint8Array(0));
      check("z\u0000tail", 1);
      expect(byA("z")).toEqual([]);

      // Patch another field; then a replace that copies the indexed value as it was read.
      const got = run((ctx) => {
        ctx.db.patch(id, { n: 2 });
        return ctx.db.get(id);
      }) as any;
      expect(got.b).toEqual(new Uint8Array(0));
      check("z\u0000tail", 2);
      run((ctx) => {
        const d = ctx.db.get(id);
        ctx.db.replace(id, { a: d.a, b: d.b, n: 3 });
      });
      check("z\u0000tail", 3);
      expect(state.storage.sql.exec(`SELECT typeof("b") AS t FROM "nulprobe"`).one().t).toBe("blob");

      // Patch the indexed field (to another NUL string, then to a plain one).
      run((ctx) => ctx.db.patch(id, { a: "y\u0000other" }));
      check("y\u0000other", 3);
      expect(byA("z\u0000tail")).toEqual([]);
      run((ctx) => ctx.db.patch(id, { a: "plain" }));
      check("plain", 3);
      const last = engine.runQuery(Q((ctx) => ctx.db.get(id))).value as any;
      expect(last.b).toEqual(new Uint8Array(0));
    });
  });
});
