// Compact storage format 3 (storage.ts): compact tables without the `_k_by_creation_time` column. `by_creation_time`
// is read from `_rowid` with each row's key computed from `_creationTime` and `_id`. Format 2 tables keep working;
// the same operations on a format 2 and a format 3 table must give the same documents, cursors and read sets.

import { bytesToBase64, compareBytes, encodeKey, inKeyRange } from "@freecorps/ember-values";
import { describe, expect, test } from "vitest";
import { seededRandom } from "../src/ids.ts";
import { CREATION_KEY_CHUNK } from "../src/migrate.ts";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  createEngine,
  defineSchema,
  defineShard,
  defineTable,
  documentsIn,
  localSchema,
  mutationGeneric,
  prepareLocalDatabase,
  queryGeneric,
  REPLICATED_SOURCE,
  replicatedSnapshot,
  runLocalQuery,
  sqlLocalReader,
  sqlReplicaWriter,
  v,
  type Doc,
  type ReadSet,
  type RowChange,
  type SchemaDefinition,
} from "../src/index.ts";

type Driver = ReturnType<typeof createNodeSqliteDriver>;

const tables = {
  notes: defineTable({ text: v.string(), n: v.number(), tag: v.optional(v.string()) }).index("by_n", ["n"]),
};
const schema = defineSchema({ tables }) as unknown as SchemaDefinition;

type RangeOp = { op: "eq" | "gt" | "gte" | "lt" | "lte"; field: "_creationTime" | "_id"; value: unknown };
type Spec = {
  range?: RangeOp[];
  order: "asc" | "desc";
  tag?: string;
  mode: "take" | "first" | "collect" | "paginate" | "unique";
  n?: number;
  cursor?: string | null;
  endCursor?: string | null;
};

const runSpec = (db: any, spec: Spec): unknown => {
  let q = db.query("notes");
  if (spec.range) {
    q = q.withIndex("by_creation_time", (r: any) => {
      let x = r;
      for (const o of spec.range!) x = x[o.op](o.field, o.value);
      return x;
    });
  }
  q = q.order(spec.order);
  if (spec.tag !== undefined) q = q.filter((f: any) => f.eq(f.field("tag"), spec.tag));
  switch (spec.mode) {
    case "take":
      return q.take(spec.n ?? 1);
    case "first":
      return q.first();
    case "unique":
      return q.unique();
    case "collect":
      return q.collect();
    case "paginate":
      return q.paginate({ numItems: spec.n ?? 1, cursor: spec.cursor ?? null, ...(spec.endCursor !== undefined ? { endCursor: spec.endCursor } : {}) });
  }
};

const functions = {
  "q:run": queryGeneric({ args: { spec: v.any() }, handler: (ctx, a) => runSpec(ctx.db, a.spec as Spec) }),
  "m:insert": mutationGeneric({
    args: { docs: v.any() },
    handler: (ctx, a) => (a.docs as Array<{ text: string; n: number; tag?: string }>).map((d) => (ctx.db as any).insert("notes", d)),
  }),
  "m:patch": mutationGeneric({ args: { id: v.string(), value: v.any() }, handler: (ctx, a: { id: string; value: unknown }) => (ctx.db as any).patch(a.id, a.value) }),
  "m:replace": mutationGeneric({ args: { id: v.string(), value: v.any() }, handler: (ctx, a: { id: string; value: unknown }) => (ctx.db as any).replace(a.id, a.value) }),
  "m:delete": mutationGeneric({ args: { id: v.string() }, handler: (ctx, a: { id: string }) => (ctx.db as any).delete(a.id) }),
};

/** A shard on its own driver, with a settable clock and a seeded id source (same seed: same ids). */
function shard(o: { compactFormat?: 2 | 3; tableStorage?: "compact" | "classic"; driver?: Driver; schema?: SchemaDefinition; seed?: number; shardName?: string } = {}) {
  const driver = o.driver ?? createNodeSqliteDriver();
  const clock = { now: 1_700_000_000_000 };
  const engine = createEngine({
    schema: o.schema ?? schema,
    functions,
    driver,
    now: () => clock.now,
    random: seededRandom(o.seed ?? 7),
    ...(o.compactFormat ? { compactFormat: o.compactFormat } : {}),
    ...(o.tableStorage ? { tableStorage: o.tableStorage } : {}),
    ...(o.shardName ? { shardName: () => o.shardName } : {}),
  });
  const report = engine.migrate();
  const sql = (s: string, ...p: any[]) => driver.exec(s, ...p).rows;
  const ddl = (table = "notes") => String(sql(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table)[0]?.sql ?? "");
  const marker = () => sql(`SELECT value FROM _ember_meta WHERE key = 'storage'`)[0]?.value;
  return { driver, engine, clock, report, sql, ddl, marker };
}
type Shard = ReturnType<typeof shard>;

// A table's CREATE TABLE text; "" (no such table) is neither.
const isV3 = (ddl: string) => ddl.startsWith("CREATE TABLE") && !/"_id" TEXT NOT NULL UNIQUE/.test(ddl) && !ddl.includes("_k_by_creation_time");
const isV2 = (ddl: string) => ddl.startsWith("CREATE TABLE") && !/"_id" TEXT NOT NULL UNIQUE/.test(ddl) && ddl.includes("_k_by_creation_time");
const keyOf = (d: { _creationTime: number; _id: string }) => encodeKey([d._creationTime, d._id]);
const errorOf = (fn: () => unknown): { ok: true; value: unknown } | { ok: false; code: unknown } => {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, code: (e as { code?: unknown }).code ?? String(e) };
  }
};

/** Every document of the table, in `by_creation_time` key order, from the rows themselves (the oracle). */
const oracle = (s: Shard): Doc[] =>
  (s.engine.runQuery(queryGeneric({ handler: (ctx) => (ctx.db as any).query("notes").withIndex("by_n").collect() }) as any).value as Doc[])
    .slice()
    .sort((a, b) => compareBytes(keyOf(a), keyOf(b)));

/** What a spec should return, computed from the oracle (documents only; cursors are checked against format 2). */
function expected(all: Doc[], spec: Spec): Doc[] | undefined {
  if (spec.cursor || spec.endCursor !== undefined || spec.mode === "paginate" || spec.mode === "unique") return undefined;
  let lo: Uint8Array = new Uint8Array(0);
  let hi: Uint8Array = Uint8Array.of(0xff);
  if (spec.range) {
    const eqs = spec.range.filter((r) => r.op === "eq").map((r) => r.value);
    const lower = spec.range.find((r) => r.op === "gt" || r.op === "gte");
    const upper = spec.range.find((r) => r.op === "lt" || r.op === "lte");
    const p = encodeKey(eqs);
    lo = lower ? (lower.op === "gte" ? encodeKey([...eqs, lower.value]) : Uint8Array.from([...encodeKey([...eqs, lower.value]), 0xff])) : p;
    hi = upper ? (upper.op === "lt" ? encodeKey([...eqs, upper.value]) : Uint8Array.from([...encodeKey([...eqs, upper.value]), 0xff])) : Uint8Array.from([...p, 0xff]);
  }
  let docs = all.filter((d) => inKeyRange(keyOf(d), lo, hi));
  if (spec.order === "desc") docs = docs.reverse();
  if (spec.tag !== undefined) docs = docs.filter((d) => d.tag === spec.tag);
  if (spec.mode === "first") return docs.slice(0, 1);
  if (spec.mode === "take") return docs.slice(0, spec.n ?? 1);
  return docs;
}

/** Runs `spec` on both shards: same outcome, same read set; format 3 also matches the oracle. */
function same(a: Shard, b: Shard, spec: Spec, all?: Doc[]): { value: unknown; readSet: ReadSet } | undefined {
  // `usage` aside: rows read may differ by the row past a cursor (see "rows read" below).
  const run = (s: Shard) => () => {
    const { value, readSet } = s.engine.runQuery("q:run", { spec });
    return { value, readSet };
  };
  // The oracle first: where it has an answer (even []), both queries must succeed, not just fail alike.
  const want = all ? expected(all, spec) : undefined;
  const ra = errorOf(run(a));
  const rb = errorOf(run(b));
  expect(rb, JSON.stringify(spec)).toEqual(ra);
  if (want) expect(rb.ok, JSON.stringify(spec)).toBe(true);
  if (!ra.ok || !rb.ok) return undefined;
  const va = ra.value as { value: unknown; readSet: ReadSet };
  const vb = rb.value as { value: unknown; readSet: ReadSet };
  expect(vb.readSet, JSON.stringify(spec)).toEqual(va.readSet);
  if (want) {
    const got = (spec.mode === "first" ? (vb.value === null ? [] : [vb.value]) : vb.value) as Doc[];
    expect(got.map((d) => d._id), JSON.stringify(spec)).toEqual(want.map((d) => d._id));
  }
  return vb;
}

/** The same random operations on both shards (same clock, same ids). */
function randomOps(shards: Shard[], seed: number, count: number) {
  const r = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const ids: string[] = [];
  const tags = ["a", "b", undefined] as const;
  for (let i = 0; i < count; i++) {
    // Clock moves: frozen (same-µs bursts), sub-µs, a few ms, or backwards (an earlier clock never goes back in time).
    const step = pick([0, 0, 0.0004, 0.001, 0.0015, 1, 3, -50]);
    for (const s of shards) s.clock.now += step;
    const x = r();
    const call = (name: string, args: Record<string, unknown>) => {
      const out = shards.map((s) => errorOf(() => s.engine.runMutation(name, args)));
      for (const o of out.slice(1)) expect(o).toEqual(out[0]);
      return out[0]!;
    };
    if (x < 0.5 || ids.length < 3) {
      const k = 1 + Math.floor(r() * 4);
      const docs = Array.from({ length: k }, () => {
        const tag = pick(tags);
        return { text: `t${i}`, n: Math.floor(r() * 5), ...(tag ? { tag } : {}) };
      });
      const res = call("m:insert", { docs });
      if (res.ok) ids.push(...((res.value as { value: string[] }).value));
    } else if (x < 0.7) {
      const tag = pick(tags);
      call("m:patch", { id: pick(ids), value: { n: Math.floor(r() * 5), tag } });
    } else if (x < 0.8) {
      call("m:replace", { id: pick(ids), value: { text: "r", n: Math.floor(r() * 5) } });
    } else {
      const i = Math.floor(r() * ids.length);
      call("m:delete", { id: ids[i]! });
      ids.splice(i, 1);
    }
  }
}

/** Bounds worth trying around the stored creation times: exact hits, neighbours, and the edges of the number line. */
function boundValues(all: Doc[], r: () => number): unknown[] {
  const cts = all.map((d) => d._creationTime);
  const some = cts.length ? Array.from({ length: 6 }, () => cts[Math.floor(r() * cts.length)]!) : [];
  return [
    ...some,
    ...some.map((c) => c + 0.0005),
    ...some.map((c) => c - 0.001),
    ...(cts.length ? [cts[0]!, cts[cts.length - 1]!, cts[0]! - 1, cts[cts.length - 1]! + 1] : []),
    0,
    -0,
    -1,
    Infinity,
    -Infinity,
    NaN,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    Number.MIN_VALUE,
  ];
}

function querySpecs(all: Doc[], seed: number): Spec[] {
  const r = seededRandom(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const values = boundValues(all, r);
  const specs: Spec[] = [];
  const modes: Array<Pick<Spec, "mode" | "n">> = [{ mode: "collect" }, { mode: "first" }, { mode: "take", n: 0 }, { mode: "take", n: 1 }, { mode: "take", n: 3 }];
  for (const order of ["asc", "desc"] as const) {
    for (const m of modes) specs.push({ order, ...m });
    for (const tag of ["a", "b"]) specs.push({ order, tag, mode: "take", n: 2 });
    for (let i = 0; i < 25; i++) {
      const lower = r() < 0.7 ? { op: pick(["gt", "gte"] as const), field: "_creationTime" as const, value: pick(values) } : undefined;
      const upper = r() < 0.7 ? { op: pick(["lt", "lte"] as const), field: "_creationTime" as const, value: pick(values) } : undefined;
      specs.push({ order, range: [...(lower ? [lower] : []), ...(upper ? [upper] : [])], ...pick(modes), ...(r() < 0.2 ? { tag: "a" } : {}) });
    }
    // eq on `_creationTime`, then a bound on `_id` (the second field of the key).
    for (let i = 0; i < 8 && all.length; i++) {
      const d = pick(all);
      const id = pick([d._id, d._id.slice(0, -1), `${d._id}\u0000`, "", "zzz", pick(all)._id]);
      const range: RangeOp[] = [{ op: "eq", field: "_creationTime", value: d._creationTime }];
      if (r() < 0.8) range.push({ op: pick(["gt", "gte", "lt", "lte"] as const), field: "_id", value: id });
      specs.push({ order, range, mode: "collect" });
      specs.push({ order, range: [{ op: "eq", field: "_creationTime", value: d._creationTime }, { op: "eq", field: "_id", value: d._id }], mode: "unique" });
    }
  }
  return specs;
}

/** Walks every page (numItems `n`): same pages and cursors on both shards, the pages joined = collect(), and every page replayed with its endCursor gives the same page. */
function walk(a: Shard, b: Shard, base: Omit<Spec, "mode" | "n" | "cursor">, n: number): string[] {
  const collected = same(a, b, { ...base, mode: "collect" })!.value as Doc[];
  const pages: Doc[] = [];
  const cursors: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const p = same(a, b, { ...base, mode: "paginate", n, cursor })!.value as { page: Doc[]; isDone: boolean; continueCursor: string };
    pages.push(...p.page);
    // The page again, bounded by its own end: what a reactive paginated query re-runs.
    const replay = same(a, b, { ...base, mode: "paginate", n, cursor, endCursor: p.continueCursor })!.value as { page: Doc[] };
    expect(replay.page.map((d) => d._id)).toEqual(p.page.map((d) => d._id));
    cursors.push(p.continueCursor);
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  expect(pages.map((d) => d._id)).toEqual(collected.map((d) => d._id));
  return cursors;
}

describe("compact format 3: DDL and storage marker", () => {
  test("a new shard creates format 3 tables (no key column, no index) and marks the shard 3", () => {
    const s = shard();
    expect(isV3(s.ddl())).toBe(true);
    expect(s.sql(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes' AND sql IS NOT NULL`).map((r: any) => r.name)).toEqual(["notes__by_n"]);
    expect(s.marker()).toBe("3");
    const createStep = (s.report.steps as any[]).find((x) => x.op === "createTable");
    expect(createStep.compact).toBe(3);
    // Same schema again: nothing planned (no key column to add back, no staged by_creation_time).
    expect(s.engine.planMigration().steps.filter((x) => x.op !== "noop")).toEqual([]);
  });

  test("compactFormat: 2 keeps creating format 2 tables (with the key column) and the marker 2", () => {
    const s = shard({ compactFormat: 2 });
    expect(isV2(s.ddl())).toBe(true);
    expect(s.marker()).toBe("2");
  });

  test("an insert writes no key column; a patch never touches it; rows written are the same as format 2", () => {
    const v2 = shard({ compactFormat: 2 });
    const v3 = shard();
    const written = (s: Shard, fn: () => unknown) => {
      let n = 0;
      const exec = s.driver.exec.bind(s.driver);
      s.driver.exec = (q: string, ...p: any[]) => {
        const r = exec(q, ...p);
        n += r.rowsWritten;
        return r;
      };
      try {
        fn();
      } finally {
        s.driver.exec = exec;
      }
      return n;
    };
    const ins = (s: Shard) => written(s, () => s.engine.runMutation("m:insert", { docs: [{ text: "x", n: 1 }] }));
    expect(ins(v3)).toBe(ins(v2));
    const id3 = (v3.engine.runMutation("m:insert", { docs: [{ text: "y", n: 1 }] }).value as string[])[0]!;
    const id2 = (v2.engine.runMutation("m:insert", { docs: [{ text: "y", n: 1 }] }).value as string[])[0]!;
    expect(written(v3, () => v3.engine.runMutation("m:patch", { id: id3, value: { text: "z" } }))).toBe(written(v2, () => v2.engine.runMutation("m:patch", { id: id2, value: { text: "z" } })));
    expect(written(v3, () => v3.engine.runMutation("m:patch", { id: id3, value: { n: 2 } }))).toBe(written(v2, () => v2.engine.runMutation("m:patch", { id: id2, value: { n: 2 } })));
    expect(Object.keys(v3.sql(`SELECT * FROM notes LIMIT 1`)[0]!)).not.toContain("_k_by_creation_time");
    expect(v2.sql(`SELECT count(*) AS n FROM notes WHERE _k_by_creation_time IS NULL`)[0]!.n).toBe(0);
  });

  test("bytes: a format 3 row is smaller by the key it no longer stores", () => {
    const sizes = (format: 2 | 3) => {
      const s = shard({ compactFormat: format });
      for (let i = 0; i < 20; i++) s.engine.runMutation("m:insert", { docs: Array.from({ length: 100 }, (_, k) => ({ text: `note ${i}-${k}`, n: k })) });
      s.driver.exec("VACUUM");
      const pages = Number(s.sql(`PRAGMA page_count`)[0]!.page_count) * Number(s.sql(`PRAGMA page_size`)[0]!.page_size);
      const key = format === 2 ? Number(s.sql(`SELECT avg(length(_k_by_creation_time)) AS b FROM notes`)[0]!.b) : 0;
      return { pages, key };
    };
    const v2 = sizes(2);
    const v3 = sizes(3);
    // [_creationTime, _id]: 1 + 8 (number) + 1 + 32 ("notes_" + 26) + 1 (string) = 43 bytes.
    expect(v2.key).toBe(43);
    expect(v3.pages).toBeLessThan(v2.pages);
    // About the key and its record header byte per row (2000 rows), give or take page fill.
    expect((v2.pages - v3.pages) / 2000).toBeGreaterThan(v2.key * 0.6);
  });
});

describe("compact format 3: same results, cursors and read sets as format 2", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`random writes and queries (seed ${seed})`, () => {
      const a = shard({ compactFormat: 2, seed });
      const b = shard({ seed });
      expect(isV2(a.ddl()) && isV3(b.ddl())).toBe(true);
      randomOps([a, b], seed * 101, 60);
      const all = oracle(b);
      expect(oracle(a).map((d) => d._id)).toEqual(all.map((d) => d._id));
      // The invariant both formats read through: `_rowid` order is key order, `_rowid` is `_creationTime` in µs.
      const rows = b.sql(`SELECT _rowid, _creationTime, _id FROM notes ORDER BY _rowid`) as Array<{ _rowid: number; _creationTime: number; _id: string }>;
      expect(rows.map((x) => x._id)).toEqual(all.map((d) => d._id));
      for (const x of rows) expect(x._creationTime).toBe(x._rowid / 1000);
      // Every query, on both.
      const readSets: ReadSet[] = [];
      for (const spec of querySpecs(all, seed * 7)) {
        const out = same(a, b, spec, all);
        if (out) readSets.push(out.readSet);
      }
      // Pagination: every page size, both orders, with and without bounds and filters; cursors stay format-free.
      const mid = all[Math.floor(all.length / 2)]?._creationTime ?? 0;
      for (const order of ["asc", "desc"] as const) {
        for (const n of [1, 2, 3, 7]) {
          walk(a, b, { order }, n);
          walk(a, b, { order, tag: "a" }, n);
          walk(a, b, { order, range: [{ op: "gte", field: "_creationTime", value: mid }] }, n);
          walk(a, b, { order, range: [{ op: "gt", field: "_creationTime", value: mid }, { op: "lte", field: "_creationTime", value: mid + 5 }] }, n);
        }
      }
      // Invalidation: the same writes affect the same recorded reads.
      for (let i = 0; i < 6; i++) {
        const before = (s: Shard) => s.clock.now;
        expect(before(a)).toBe(before(b));
        const changes = [a, b].map((s) => s.engine.runMutation("m:insert", { docs: [{ text: "late", n: i, tag: "a" }] }).changes as RowChange[]);
        expect(changes[1]).toEqual(changes[0]);
        for (const rs of readSets) expect(b.engine.matches(rs, changes[1]!)).toBe(a.engine.matches(rs, changes[0]!));
        for (const s of [a, b]) s.clock.now += i % 2 ? 0 : 0.3;
      }
    });
  }

  test("a cursor of a format 2 table continues on a format 3 one (and back): cursors are keys, not formats", () => {
    const a = shard({ compactFormat: 2 });
    const b = shard();
    randomOps([a, b], 99, 40);
    for (const order of ["asc", "desc"] as const) {
      let cursor: string | null = null;
      for (let i = 0; i < 50; i++) {
        const from = i % 2 ? a : b;
        const other = i % 2 ? b : a;
        const spec: Spec = { order, mode: "paginate", n: 3, cursor };
        const p = from.engine.runQuery("q:run", { spec }).value as any;
        expect(other.engine.runQuery("q:run", { spec }).value).toEqual(p);
        if (p.isDone) break;
        cursor = p.continueCursor;
      }
    }
  });

  test("forged cursors: any bytes give the same page (or the same error) on both", () => {
    const a = shard({ compactFormat: 2 });
    const b = shard();
    randomOps([a, b], 5, 30);
    const all = oracle(b);
    const r = seededRandom(3);
    const nanKey = Uint8Array.from([0x04, 0xff, 0xf8, 0, 0, 0, 0, 0, 1]);
    const negNanKey = Uint8Array.from([0x04, 0x00, 0x07, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]);
    const keys: Uint8Array[] = [
      new Uint8Array(0),
      Uint8Array.of(0x04),
      Uint8Array.of(0x04, 0xc2),
      Uint8Array.of(0x03),
      Uint8Array.of(0x07, 0x61, 0),
      Uint8Array.of(0xff),
      nanKey,
      negNanKey,
      Uint8Array.from([...nanKey, 0x07, 0x61, 0]),
      encodeKey([-0]),
      encodeKey([0]),
      encodeKey([Infinity]),
      encodeKey([-Infinity]),
      ...all.slice(0, 5).flatMap((d) => [keyOf(d), Uint8Array.from([...keyOf(d), 0]), encodeKey([d._creationTime]), encodeKey([d._creationTime, d._id.slice(0, 10)])]),
      ...Array.from({ length: 20 }, () => Uint8Array.from({ length: Math.floor(r() * 20) }, () => Math.floor(r() * 256))),
    ];
    for (const k of keys) {
      const cursor = "k" + bytesToBase64(k, true);
      for (const order of ["asc", "desc"] as const) {
        same(a, b, { order, mode: "paginate", n: 4, cursor });
        same(a, b, { order, mode: "paginate", n: 4, cursor: null, endCursor: cursor });
        same(a, b, { order, mode: "paginate", n: 2, cursor, endCursor: cursor });
      }
    }
    for (const bad of ["x", "k!!", "kAAAA="]) same(a, b, { order: "asc", mode: "paginate", n: 1, cursor: bad });
  });

  test("rows read: the same as format 2, except one row past a cursor (node:sqlite counts rows returned)", () => {
    const a = shard({ compactFormat: 2 });
    const b = shard();
    // Dense rowids (one ms, many docs): the ±2 µs window around a cursor holds neighbours.
    for (let i = 0; i < 10; i++) for (const s of [a, b]) s.engine.runMutation("m:insert", { docs: Array.from({ length: 20 }, (_, k) => ({ text: "x", n: k })) });
    const reads = (s: Shard, spec: Spec) => s.engine.runQuery("q:run", { spec }).usage!.rowsRead;
    for (const order of ["asc", "desc"] as const) {
      expect(reads(b, { order, mode: "take", n: 10 })).toBe(reads(a, { order, mode: "take", n: 10 }));
      expect(reads(b, { order, mode: "first" })).toBe(reads(a, { order, mode: "first" }));
      expect(reads(b, { order, mode: "collect" })).toBe(reads(a, { order, mode: "collect" }));
      let cursor: string | null = null;
      let ra = 0;
      let rb = 0;
      let pages = 0;
      for (;;) {
        const spec: Spec = { order, mode: "paginate", n: 25, cursor };
        ra += reads(a, spec);
        const r = b.engine.runQuery("q:run", { spec });
        rb += r.usage!.rowsRead;
        pages++;
        const p = r.value as any;
        if (p.isDone) break;
        cursor = p.continueCursor;
      }
      // node:sqlite counts the rows a statement returns: format 3 returns the cursor's own row (format 2 drops it in
      // SQL; DO SQLite bills both for it, since it reads it either way).
      expect(rb).toBeLessThanOrEqual(ra + pages);
      // Not a property of format 3 but a floor for any correct scan: format 2's SQL filters on the exact key, so it
      // returns only rows of the page (and the peek); a scan returning fewer rows could not have produced that page.
      expect(rb).toBeGreaterThanOrEqual(ra);
    }
    // `gt` a stored creation time: strict in SQL, no extra row.
    const ct = (b.sql(`SELECT _creationTime FROM notes ORDER BY _rowid LIMIT 1 OFFSET 50`)[0] as any)._creationTime as number;
    const spec: Spec = { order: "asc", range: [{ op: "gt", field: "_creationTime", value: ct }], mode: "take", n: 5 };
    expect(reads(b, spec)).toBe(reads(a, spec));
  });

  test("a scan that skips more rows than its slack still returns exact results (it goes on from the last _rowid)", () => {
    // Several rows at one `_creationTime` (the engine never writes that: each `_rowid` is its own µs), so the
    // `_creationTime` superset lets more than one row below a cursor through. Written directly, keeping key order =
    // `_rowid` order (same time, ids increasing with the rowid).
    const b = shard();
    b.engine.runMutation("m:insert", { docs: Array.from({ length: 5 }, (_, k) => ({ text: "x", n: k })) });
    const rows = b.sql(`SELECT _rowid, _id, _creationTime FROM notes ORDER BY _rowid`) as any[];
    const ct = rows[0]._creationTime as number;
    b.driver.exec(`UPDATE notes SET _creationTime = ? WHERE _rowid <= ?`, ct, rows[2]._rowid);
    const docs = oracle(b);
    expect(docs.map((d) => d._id)).toEqual(rows.map((x) => x._id));
    const cursor = "k" + bytesToBase64(keyOf(docs[1]!), true);
    const statements: string[] = [];
    const exec = b.driver.exec.bind(b.driver);
    b.driver.exec = (q: string, ...p: any[]) => {
      if (q.includes('ORDER BY "_rowid"')) statements.push(q);
      return exec(q, ...p);
    };
    try {
      // Peeks 2 rows: the first statement asks for 3 (one of slack), gets docs[0..2] and keeps only docs[2].
      const p = b.engine.runQuery("q:run", { spec: { order: "asc", mode: "paginate", n: 1, cursor } }).value as any;
      expect(p.page.map((d: Doc) => d._id)).toEqual([docs[2]!._id]);
      expect(p.isDone).toBe(false);
      expect(statements.length).toBe(2);
      statements.length = 0;
      const rest = b.engine.runQuery("q:run", { spec: { order: "asc", mode: "paginate", n: 10, cursor } }).value as any;
      expect(rest.page.map((d: Doc) => d._id)).toEqual(docs.slice(2).map((d) => d._id));
      // desc from the last of the three: docs[1] skipped... and docs[0] returned.
      const down = b.engine.runQuery("q:run", { spec: { order: "desc", mode: "paginate", n: 5, cursor: "k" + bytesToBase64(keyOf(docs[2]!), true) } }).value as any;
      expect(down.page.map((d: Doc) => d._id)).toEqual([docs[1]!._id, docs[0]!._id]);
      const eq = b.engine.runQuery("q:run", { spec: { order: "desc", range: [{ op: "eq", field: "_creationTime", value: ct }, { op: "lt", field: "_id", value: docs[2]!._id }], mode: "take", n: 1 } }).value as Doc[];
      expect(eq.map((d) => d._id)).toEqual([docs[1]!._id]);
    } finally {
      b.driver.exec = exec;
    }
  });
});

describe("compact format 3: deploys, migrations and rollbacks", () => {
  test("an existing format 2 shard keeps its tables; a new table is format 3 and the marker becomes 3 with it", () => {
    const driver = createNodeSqliteDriver();
    const old = shard({ driver, compactFormat: 2 });
    old.engine.runMutation("m:insert", { docs: [{ text: "a", n: 1 }, { text: "b", n: 2 }] });
    expect(old.marker()).toBe("2");
    // New runtime, same schema: nothing to do, the table stays format 2 and keeps writing its key column.
    const same1 = shard({ driver });
    expect(same1.report.changed).toBe(false);
    expect(same1.marker()).toBe("2");
    same1.engine.runMutation("m:insert", { docs: [{ text: "c", n: 3 }] });
    expect(isV2(same1.ddl())).toBe(true);
    expect(same1.sql(`SELECT count(*) AS n FROM notes WHERE _k_by_creation_time IS NULL`)[0]!.n).toBe(0);
    // A field added to the format 2 table: the plan does not touch its key column.
    const widerNotes = defineTable({ text: v.string(), n: v.number(), tag: v.optional(v.string()), extra: v.optional(v.string()) }).index("by_n", ["n"]);
    const wider = defineSchema({ tables: { notes: widerNotes } }) as unknown as SchemaDefinition;
    const s2 = shard({ driver, schema: wider });
    expect((s2.report.steps as any[]).filter((x) => x.op === "createIndex" || x.op === "dropIndex")).toEqual([]);
    expect(s2.marker()).toBe("2");
    // A new table: format 3, and the marker, in the migration's transaction.
    const more = defineSchema({ tables: { notes: widerNotes, extra: defineTable({ a: v.string() }) } }) as unknown as SchemaDefinition;
    const s3 = shard({ driver, schema: more });
    expect(isV2(s3.ddl("notes"))).toBe(true);
    expect(isV3(s3.ddl("extra"))).toBe(true);
    expect(s3.marker()).toBe("3");
    expect((s3.engine.runQuery("q:run", { spec: { order: "asc", mode: "collect" } }).value as Doc[]).map((d) => d.text)).toEqual(["a", "b", "c"]);
    // A later boot: nothing left to do, both formats served.
    const s4 = shard({ driver, schema: more });
    expect(s4.report.changed).toBe(false);
    expect(s4.engine.planMigration().steps.filter((x) => x.op !== "noop")).toEqual([]);
  });

  test("the marker and the format 3 table commit together: a failing migration leaves neither", () => {
    const driver = createNodeSqliteDriver();
    const old = shard({ driver, compactFormat: 2 });
    old.engine.runMutation("m:insert", { docs: [{ text: "a", n: 1 }] });
    // The same migration, with a step that fails after the new table is created.
    const more = defineSchema({ tables: { ...tables, extra: defineTable({ a: v.string() }) } }) as unknown as SchemaDefinition;
    const e = createEngine({ schema: more, functions, driver });
    const plan = e.planMigration();
    // Fails at the end of the migration's transaction, once both the table and the marker "3" are written in it.
    const transaction = driver.transaction.bind(driver);
    let seen = false;
    driver.transaction = <T,>(fn: () => T): T =>
      transaction(() => {
        const out = fn();
        if (!seen && driver.exec(`SELECT name FROM sqlite_master WHERE name = 'extra'`).rows.length && old.marker() === "3") {
          seen = true;
          throw new Error("boom");
        }
        return out;
      });
    try {
      expect(() => e.migrate()).toThrow(/boom/);
    } finally {
      driver.transaction = transaction;
    }
    expect(seen).toBe(true);
    expect(plan.steps.find((x) => x.op === "createTable")).toMatchObject({ table: "extra", compact: 3 });
    expect(driver.exec(`SELECT name FROM sqlite_master WHERE name = 'extra'`).rows).toEqual([]);
    expect(old.marker()).toBe("2");
  });

  test("a shard still converting classic tables creates format 2 tables until the conversion is done", () => {
    const driver = createNodeSqliteDriver();
    const classic = shard({ driver, tableStorage: "classic" });
    classic.engine.runMutation("m:insert", { docs: [{ text: "a", n: 1 }, { text: "b", n: 2 }] });
    expect(classic.marker()).toBeUndefined();
    // Holding the conversion back (an index backfill in progress): new tables are format 2, no marker yet.
    driver.exec(`INSERT INTO _ember_indexes (tbl, name, kind, cursor, until) VALUES ('notes', 'by_n', 'db', 0, 0)`);
    const more = defineSchema({ tables: { ...tables, extra: defineTable({ a: v.string() }) } }) as unknown as SchemaDefinition;
    const s = shard({ driver, schema: more });
    expect(s.report.compacted).toBeUndefined();
    expect(isV2(s.ddl("extra"))).toBe(true);
    expect(s.marker()).toBeUndefined();
    expect(s.engine.storageBehind()).toBe(true);
    // The backfill finishes: the conversion runs (to format 2, as before) and marks the shard 2.
    while (!s.engine.backfillStep(100).done);
    expect(s.marker()).toBe("2");
    expect(isV2(s.ddl("notes"))).toBe(true);
    expect(s.sql(`SELECT count(*) AS n FROM notes WHERE _legacy = 1`)[0]!.n).toBe(2);
    // The next table is format 3.
    const most = defineSchema({ tables: { ...tables, extra: defineTable({ a: v.string() }), third: defineTable({ b: v.string() }) } }) as unknown as SchemaDefinition;
    const s2 = shard({ driver, schema: most });
    expect(isV3(s2.ddl("third"))).toBe(true);
    expect(isV2(s2.ddl("extra"))).toBe(true);
    expect(s2.marker()).toBe("3");
  });

  test("compactFormat: 3 cannot skip a pending conversion: format 2 tables until it is done, then format 3", () => {
    const driver = createNodeSqliteDriver();
    const classic = shard({ driver, tableStorage: "classic" });
    classic.engine.runMutation("m:insert", { docs: [{ text: "a", n: 1 }] });
    driver.exec(`INSERT INTO _ember_indexes (tbl, name, kind, cursor, until) VALUES ('notes', 'by_n', 'db', 0, 0)`);
    const more = defineSchema({ tables: { ...tables, extra: defineTable({ a: v.string() }) } }) as unknown as SchemaDefinition;
    const s = shard({ driver, schema: more, compactFormat: 3 });
    expect(isV2(s.ddl("extra"))).toBe(true);
    expect(s.marker()).toBeUndefined();
    expect(s.engine.storageBehind()).toBe(true);
    // The conversion still runs once the backfill is done.
    while (!s.engine.backfillStep(100).done);
    expect(isV2(s.ddl("notes"))).toBe(true);
    expect(s.marker()).toBe("2");
    const most = defineSchema({ tables: { ...tables, extra: defineTable({ a: v.string() }), third: defineTable({ b: v.string() }) } }) as unknown as SchemaDefinition;
    const s2 = shard({ driver, schema: most, compactFormat: 3 });
    expect(isV3(s2.ddl("third"))).toBe(true);
    expect(s2.marker()).toBe("3");
  });

  test("a format 3 table with data: a new index is staged and backfilled, by_creation_time is never touched", () => {
    const driver = createNodeSqliteDriver();
    const s = shard({ driver });
    s.engine.runMutation("m:insert", { docs: Array.from({ length: 30 }, (_, k) => ({ text: `x${k}`, n: k % 3 })) });
    const next = defineSchema({ tables: { notes: defineTable({ text: v.string(), n: v.number(), tag: v.optional(v.string()) }).index("by_n", ["n"]).index("by_text", ["text"]) } }) as unknown as SchemaDefinition;
    const s2 = shard({ driver, schema: next });
    expect((s2.report.steps as any[]).filter((x) => x.op === "createIndex").map((x) => x.index)).toEqual(["by_text"]);
    while (!s2.engine.backfillStep(7).done);
    expect(isV3(s2.ddl())).toBe(true);
    const all = oracle(s2);
    expect((s2.engine.runQuery("q:run", { spec: { order: "desc", mode: "collect" } }).value as Doc[]).map((d) => d._id)).toEqual(all.map((d) => d._id).reverse());
  });

  test("an empty format 3 table rebuilt for a type change is format 3 again, and the marker stays 3", () => {
    const driver = createNodeSqliteDriver();
    expect(shard({ driver }).marker()).toBe("3");
    const next = defineSchema({ tables: { notes: defineTable({ text: v.number(), n: v.number(), tag: v.optional(v.string()) }).index("by_n", ["n"]) } }) as unknown as SchemaDefinition;
    const s = shard({ driver, schema: next });
    expect((s.report.steps as any[]).find((x) => x.op === "rebuildTable")).toMatchObject({ compact: 3 });
    expect(isV3(s.ddl())).toBe(true);
    expect(s.marker()).toBe("3");
    // Rebuilt again as classic (it becomes .replicated()): the marker is never lowered (other format 3 tables may exist).
    const replicated = defineSchema({ tables: { notes: defineTable({ text: v.number(), n: v.number(), tag: v.optional(v.string()) }).index("by_n", ["n"]).replicated() } }) as unknown as SchemaDefinition;
    const s2 = shard({ driver, schema: replicated, shardName: "global:main" });
    expect((s2.report.steps as any[]).find((x) => x.op === "rebuildTable")?.compact).toBeUndefined();
    expect(/"_id" TEXT NOT NULL UNIQUE/.test(s2.ddl())).toBe(true);
    expect(s2.marker()).toBe("3");
  });

  test("an empty format 2 table rebuilt in a converted shard becomes format 3, with the marker, in the same migration", () => {
    const driver = createNodeSqliteDriver();
    expect(shard({ driver, compactFormat: 2 }).marker()).toBe("2");
    const next = defineSchema({ tables: { notes: defineTable({ text: v.number(), n: v.number(), tag: v.optional(v.string()) }).index("by_n", ["n"]) } }) as unknown as SchemaDefinition;
    const s = shard({ driver, schema: next });
    expect((s.report.steps as any[]).find((x) => x.op === "rebuildTable")).toMatchObject({ compact: 3 });
    expect(isV3(s.ddl())).toBe(true);
    expect(s.marker()).toBe("3");
  });

  test("import begin turns a format 3 table with data into classic storage with every key computed", () => {
    const driver = createNodeSqliteDriver();
    const s = shard({ driver });
    // More rows than two chunks, not a multiple of one: the last chunk is short.
    const n = CREATION_KEY_CHUNK * 2 + 10;
    for (let i = 0; i < n; i += 25) s.engine.runMutation("m:insert", { docs: Array.from({ length: Math.min(25, n - i) }, (_, k) => ({ text: `x${i + k}`, n: (i + k) % 4 })) });
    const before = s.engine.runQuery("q:run", { spec: { order: "desc", mode: "collect" } }).value as Doc[];
    const writes: Array<{ sql: string; params: number; rows: number }> = [];
    const exec = driver.exec.bind(driver);
    driver.exec = (q: string, ...p: any[]) => {
      const r = exec(q, ...p);
      if (/^\s*(INSERT|UPDATE)/i.test(q) && q.includes("notes__declassing")) writes.push({ sql: q, params: p.length, rows: r.rowsWritten });
      return r;
    };
    try {
      s.engine.importer.begin({ tables: ["notes"] } as any);
    } finally {
      driver.exec = exec;
    }
    // One INSERT per chunk (each row written once, with its key), no UPDATE, at most 100 bound parameters each.
    expect(writes.map((w) => w.sql.trimStart().slice(0, 6).toUpperCase())).toEqual(["INSERT", "INSERT", "INSERT"]);
    expect(writes.map((w) => w.rows)).toEqual([CREATION_KEY_CHUNK, CREATION_KEY_CHUNK, 10]);
    expect(Math.max(...writes.map((w) => w.params))).toBeLessThanOrEqual(100);
    expect(before.length).toBe(n);
    expect(/"_id" TEXT NOT NULL UNIQUE/.test(s.ddl())).toBe(true);
    expect(s.sql(`SELECT count(*) AS n FROM notes WHERE _k_by_creation_time IS NULL`)[0]!.n).toBe(0);
    const rows = s.sql(`SELECT _id, _creationTime, _k_by_creation_time AS k FROM notes`) as any[];
    for (const r of rows) expect(new Uint8Array(r.k)).toEqual(keyOf(r));
    expect(s.engine.runQuery("q:run", { spec: { order: "desc", mode: "collect" } }).value).toEqual(before);
    const p = s.engine.runQuery("q:run", { spec: { order: "asc", mode: "paginate", n: 5, cursor: null } }).value as any;
    expect(p.page.map((d: Doc) => d._id)).toEqual(before.slice().reverse().slice(0, 5).map((d) => d._id));
  });

  test("a format 3 table that becomes .replicated() in global:main keeps its rows; the snapshot is in creation order", () => {
    const shards = { org: defineShard({ key: v.string() }) };
    const plain = defineSchema({ tables: { rates: defineTable({ k: v.string() }) }, shards }) as unknown as SchemaDefinition;
    const replicated = defineSchema({ tables: { rates: defineTable({ k: v.string() }).replicated() }, shards }) as unknown as SchemaDefinition;
    const driver = createNodeSqliteDriver();
    const fns = { "r:add": mutationGeneric({ args: { k: v.string() }, handler: (ctx, a: { k: string }) => (ctx.db as any).insert("rates", a) }) };
    const clock = { now: 1_700_000_000_000 };
    const e1 = createEngine({ schema: plain, functions: fns, driver, now: () => clock.now, shardName: () => REPLICATED_SOURCE });
    e1.migrate();
    // Same-µs bursts, a backwards clock: creation order is still `_rowid` order.
    for (const [i, step] of [0, 0, -5, 0.0003, 2, 0, -1].entries()) {
      clock.now += step;
      e1.runMutation("r:add", { k: `k${i}` });
    }
    const e2 = createEngine({ schema: replicated, functions: fns, driver, now: () => clock.now, shardName: () => REPLICATED_SOURCE });
    e2.migrate();
    expect(isV3(String(driver.exec(`SELECT sql FROM sqlite_master WHERE name = 'rates'`).rows[0]!.sql))).toBe(true);
    const snap = replicatedSnapshot((q, ...p) => driver.exec(q, ...p).rows, replicated.manifest, "org");
    const ordered = (e2.runQuery(queryGeneric({ handler: (ctx) => (ctx.db as any).query("rates").collect() }) as any).value as Doc[]).map((d) => d._id);
    expect(snap.map((r) => r.id)).toEqual(ordered);
    expect(snap.map((r) => (r.doc as any).k)).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6"]);
  });
});

describe("compact format 3: offline (local query execution over a classic replica)", () => {
  test("the same query code gives the same results and cursors locally as on the server", () => {
    const s = shard();
    randomOps([s], 42, 50);
    const all = oracle(s);
    const ls = localSchema(schema.manifest);
    const local = createNodeSqliteDriver();
    prepareLocalDatabase(local, ls);
    const w = sqlReplicaWriter(local, ls);
    for (const { table, doc } of documentsIn(schema.manifest, all)) w.upsert(table, doc);
    const reader = sqlLocalReader(local, ls);
    const runLocal = (spec: Spec) => runLocalQuery(functions["q:run"] as any, { spec }, { schema: ls, reader });
    for (const spec of querySpecs(all, 11)) {
      const server = errorOf(() => s.engine.runQuery("q:run", { spec }));
      const here = errorOf(() => runLocal(spec));
      if (!server.ok || !here.ok) {
        expect(here.ok).toBe(server.ok);
        continue;
      }
      expect((here.value as any).value).toEqual((server.value as any).value);
      expect((here.value as any).readSet).toEqual((server.value as any).readSet);
    }
    // A server cursor continues locally, page after page.
    for (const order of ["asc", "desc"] as const) {
      let cursor: string | null = null;
      for (let i = 0; i < 100; i++) {
        const spec: Spec = { order, mode: "paginate", n: 4, cursor };
        const p = s.engine.runQuery("q:run", { spec }).value as any;
        expect(runLocal(spec).value).toEqual(p);
        if (p.isDone) break;
        cursor = p.continueCursor;
      }
    }
  });
});
