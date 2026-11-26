// PR 3b on DO SQLite (workerd): `.filter()` pushed to SQLite gives the same documents, read sets and usage as JS,
// with `rowsRead` as the Durable Object counts it; `DoSqlDriver.execRaw` gives `exec`'s rows as arrays.
import { runInDurableObject } from "cloudflare:test";
import { createEngine, mutationGeneric, queryGeneric } from "@freecorps/ember-server";
import { describe, expect, it } from "vitest";
import { getEmberConfig } from "../src/config.ts";
import { DoSqlDriver } from "../src/sql-driver.ts";
import { shardStub } from "./helpers.ts";

function prng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const STRINGS = ["", "a", "b", "ab", "é", "ação", "😀", "￿", "", "z😀", "\ud800", "10", "9"];
const NUMBERS = [0, -0, 1, -1, 2.5, 1e21, NaN, Infinity, -Infinity, 3, 42];
const LITERALS = [...STRINGS, ...NUMBERS, true, false, null, undefined, 0n, 7n];
const CMP = ["eq", "neq", "lt", "lte", "gt", "gte"] as const;

type Q = Record<string, (...a: unknown[]) => unknown>;
/** A random filter over `fields` (mostly a literal of the field's type), built with the handler's `q`. */
function randomFilter(r: () => number, q: Q, fields: Record<string, readonly unknown[]>, depth = 0): unknown {
  const k = r();
  if (depth < 2 && k < 0.15) return q.and!(randomFilter(r, q, fields, depth + 1), randomFilter(r, q, fields, depth + 1));
  if (depth < 2 && k < 0.27) return q.or!(randomFilter(r, q, fields, depth + 1), randomFilter(r, q, fields, depth + 1));
  if (depth < 2 && k < 0.33) return q.not!(randomFilter(r, q, fields, depth + 1));
  const f = pick(r, Object.keys(fields));
  const lit = r() < 0.75 ? pick(r, fields[f]!) : pick(r, LITERALS);
  const args = r() < 0.8 ? [q.field!(f), lit] : [lit, q.field!(f)];
  return q[pick(r, CMP)]!(...args);
}

const normalize = (x: unknown): unknown =>
  JSON.parse(JSON.stringify(x, (_, y) => (typeof y === "bigint" ? `${y}n` : y instanceof Uint8Array ? [...y] : Number.isNaN(y) ? "NaN" : Object.is(y, -0) ? "-0" : y)));

describe("filter pushdown on DO SQLite", () => {
  it("on × off: the same documents, cursors, read sets, rowsRead and documentsRead", async () => {
    const out = await runInDurableObject(shardStub("pushdown:do"), (_i, state) => {
      const cfg = getEmberConfig();
      const driver = new DoSqlDriver(state.storage);
      const on = createEngine({ schema: cfg.schema, functions: cfg.functions, driver, filterPushdown: true });
      const off = createEngine({ schema: cfg.schema, functions: cfg.functions, driver, filterPushdown: false });
      on.migrate();
      const r = prng(21);
      on.runMutation(
        mutationGeneric({
          handler: (ctx: any) => {
            for (let i = 0; i < 160; i++) {
              ctx.db.insert("wide", { a: pick(r, STRINGS), b: pick(r, NUMBERS), c: pick(r, STRINGS) });
              const note: Record<string, unknown> = { room: pick(r, ["r1", "r2"]), body: pick(r, STRINGS) };
              if (r() < 0.6) note.private = r() < 0.5;
              if (r() < 0.5) note.owner = pick(r, STRINGS);
              ctx.db.insert("notes", note);
            }
            return null;
          },
        }) as any,
        {},
      );
      const diffs: unknown[] = [];
      let compared = 0;
      let nonEmpty = 0;
      for (let i = 0; i < 120; i++) {
        const seed = Math.floor(r() * 1e9);
        const n = pick(r, [1, 5, 20]);
        const order = r() < 0.5 ? "asc" : "desc";
        const table = r() < 0.5 ? "wide" : "notes";
        const fields: Record<string, readonly unknown[]> =
          table === "wide"
            ? { a: STRINGS, b: NUMBERS, c: STRINGS, _creationTime: NUMBERS }
            : { room: ["r1", "r2", "r3"], body: STRINGS, private: [true, false, undefined], owner: [...STRINGS, undefined] };
        const index = table === "wide" ? pick(r, [undefined, "by_a", "by_b"]) : pick(r, [undefined, "by_room"]);
        // The filter is built inside the handler (the real `q`), the same on both engines (same seed).
        const run = (e: typeof on, what: string) => {
          try {
            const res = e.runQuery(
              queryGeneric({
                handler: (ctx: any) => {
                  const rr = prng(seed);
                  let qy = ctx.db.query(table);
                  if (index === "by_a") qy = qy.withIndex("by_a", (q: any) => q.gte("a", "a"));
                  if (index === "by_b") qy = qy.withIndex("by_b", (q: any) => q.lt("b", 40));
                  if (index === "by_room") qy = qy.withIndex("by_room", (q: any) => q.eq("room", "r1"));
                  qy = qy.order(order).filter((q: any) => randomFilter(rr, q, fields));
                  if (what === "take") return qy.take(n);
                  if (what === "collect") return qy.collect();
                  return qy.paginate({ numItems: n, cursor: null });
                },
              }) as any,
              {},
            );
            return normalize({ value: res.value, readSet: res.readSet, usage: res.usage });
          } catch (e) {
            return `error ${(e as Error).message}`;
          }
        };
        for (const what of ["take", "collect", "paginate"]) {
          const a = run(on, what);
          const b = run(off, what);
          compared++;
          if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ i, what, table, index, a, b });
          if (what === "collect" && Array.isArray((a as { value?: unknown }).value) && ((a as { value: unknown[] }).value.length > 0)) nonEmpty++;
        }
      }
      return { diffs: diffs.slice(0, 3), compared, nonEmpty };
    });
    expect(out.diffs).toEqual([]);
    expect(out.compared).toBe(360);
    expect(out.nonEmpty).toBeGreaterThan(30);
  });

  it("execRaw: exec's rows as arrays (a new array per row, BLOBs as Uint8Array), the same counters", async () => {
    const out = await runInDurableObject(shardStub("pushdown:raw"), (_i, state) => {
      const d = new DoSqlDriver(state.storage);
      d.exec("CREATE TABLE t (v INTEGER PRIMARY KEY, w TEXT, b BLOB)");
      d.exec("INSERT INTO t(v, w, b) VALUES (1, 'a', x'0102'), (2, 'b', NULL), (3, 'c', x'')");
      const c0 = JSON.stringify(d.counters);
      const objects = d.exec("SELECT v, w, b FROM t ORDER BY v");
      const c1 = JSON.stringify(d.counters);
      const arrays = d.execRaw("SELECT v, w, b FROM t ORDER BY v");
      const c2 = JSON.parse(JSON.stringify(d.counters));
      const none = d.execRaw("UPDATE t SET w = 'z' WHERE v = 2");
      return {
        objects: objects.rows.map((r) => [r.v, r.w, r.b instanceof Uint8Array ? [...r.b] : r.b]),
        arrays: arrays.rows.map((r) => [r[0], r[1], r[2] instanceof Uint8Array ? [...r[2]] : r[2]]),
        distinct: new Set(arrays.rows).size,
        // Independent rows: writing into one changes no other, nor what a later read gives (row 2 is the UPDATE's 'z').
        independent: (() => {
          arrays.rows[0]![1] = "changed";
          return [arrays.rows.map((r) => r[1]), d.execRaw("SELECT w FROM t ORDER BY v").rows.map((r) => r[0])];
        })(),
        blobType: arrays.rows[0]![2] instanceof Uint8Array,
        read: [objects.rowsRead, arrays.rowsRead],
        select: [JSON.parse(c1).select[0] - JSON.parse(c0).select[0], c2.select[0] - JSON.parse(c1).select[0]],
        rowsSelected: [JSON.parse(c1).select[1] - JSON.parse(c0).select[1], c2.select[1] - JSON.parse(c1).select[1]],
        none: { rows: none.rows, written: none.rowsWritten },
      };
    });
    expect(out.arrays).toEqual(out.objects);
    expect(out.arrays).toEqual([
      [1, "a", [1, 2]],
      [2, "b", null],
      [3, "c", []],
    ]);
    expect(out.distinct).toBe(3);
    expect(out.independent).toEqual([
      ["changed", "b", "c"],
      ["a", "z", "c"],
    ]);
    expect(out.blobType).toBe(true);
    expect(out.read[1]).toBe(out.read[0]);
    expect(out.select).toEqual([1, 1]);
    expect(out.rowsSelected[1]).toBe(out.rowsSelected[0]);
    expect(out.none).toEqual({ rows: [], written: 1 });
  });

  it("execRaw copies each row: a cursor that reuses one array per step still gives every row", () => {
    // What the DO cursor does not promise: a fresh array per step. A cursor that rewrites one array in place.
    const data: unknown[][] = [
      [1, "a", new Uint8Array([1, 2]).buffer],
      [2, "b", null],
      [3, "c", new ArrayBuffer(0)],
    ];
    const cursor = {
      columnNames: ["v", "w", "b"],
      rowsRead: 3,
      rowsWritten: 0,
      *raw() {
        const shared: unknown[] = [];
        for (const r of data) {
          shared.length = 0;
          shared.push(...r);
          yield shared;
        }
      },
    };
    const storage = { sql: { exec: () => cursor } } as unknown as DurableObjectStorage;
    const rows = new DoSqlDriver(storage).execRaw("SELECT v, w, b FROM t").rows;
    expect(rows.map((r) => [r[0], r[1], r[2] instanceof Uint8Array ? [...r[2]] : r[2]])).toEqual([
      [1, "a", [1, 2]],
      [2, "b", null],
      [3, "c", []],
    ]);
  });
});
