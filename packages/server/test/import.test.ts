// Import with foreign ids (PLAN §22 L4): Convex id decoding, tables pinned to classic storage, raw batched upserts
// with exact `_creationTime`, mixed Ember/foreign ids, derived state rebuilt by `finish()`, files with their original
// storage ids, the verify hash and local execution.

import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  checkImportDoc,
  classicTables,
  convexTableNumber,
  createEngine,
  DocSetHash,
  defineSchema,
  defineTable,
  isConvexId,
  localSchema,
  makeConvexId,
  mutationGeneric,
  queryGeneric,
  runLocalQuery,
  seededRandom,
  v,
  type Doc,
  type LocalReader,
} from "../src/index.ts";

const schema = defineSchema({
  shards: {},
  tables: {
    orgs: defineTable({ name: v.string() }),
    tasks: defineTable({ orgId: v.id("orgs"), title: v.string(), points: v.number(), done: v.boolean(), big: v.optional(v.int64()), raw: v.optional(v.bytes()), file: v.optional(v.file()) })
      .index("by_org", ["orgId"])
      .searchIndex("search_title", { searchField: "title" })
      .aggregate("per_org", { by: ["orgId"], count: true, sum: ["points"] }),
  },
});

const ORGS = 10001;
const TASKS = 10002;
const STORAGE = 28;
const rnd = seededRandom(7);
const orgId = () => makeConvexId(ORGS, rnd);
const taskId = () => makeConvexId(TASKS, rnd);
const fileId = () => makeConvexId(STORAGE, rnd);
const foreignIds = { convex: { [ORGS]: "orgs", [TASKS]: "tasks" } };

const getQ = queryGeneric({ args: { id: v.id("tasks") }, handler: (ctx: any, { id }: any) => ctx.db.get(id) }) as any;
const listQ = queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("tasks").collect() }) as any;
const byOrgQ = queryGeneric({ args: { org: v.id("orgs") }, handler: (ctx: any, { org }: any) => ctx.db.query("tasks").withIndex("by_org", (q: any) => q.eq("orgId", org)).collect() }) as any;
const aggQ = queryGeneric({ args: { org: v.id("orgs") }, handler: (ctx: any, { org }: any) => ctx.db.aggregate("tasks", "per_org").get([org]) }) as any;
const searchQ = queryGeneric({ args: { q: v.string() }, handler: (ctx: any, { q }: any) => ctx.db.query("tasks").withSearchIndex("search_title", (s: any) => s.search("title", q)).collect() }) as any;
const metaQ = queryGeneric({ args: { id: v.string() }, handler: (ctx: any, { id }: any) => ctx.storage.getMetadata(id) }) as any;
const addTask = mutationGeneric({ args: { orgId: v.id("orgs"), title: v.string() }, handler: (ctx: any, a: any) => ctx.db.insert("tasks", { ...a, points: 1, done: false }) }) as any;
const patchTask = mutationGeneric({ args: { id: v.id("tasks"), title: v.string() }, handler: (ctx: any, { id, title }: any) => ctx.db.patch(id, { title }) }) as any;

function setup(driver = createNodeSqliteDriver()) {
  const engine = createEngine({ schema, driver, storage: { shard: () => "org:acme" } });
  engine.migrate();
  return { driver, engine, sql: (s: string, ...p: any[]) => driver.exec(s, ...p).rows };
}

describe("Convex ids", () => {
  test("the id from Convex's public file-metadata docs decodes (a 1-byte varint, 19 bytes)", () => {
    expect(convexTableNumber("3k7ty84apk2zy00ay4st1n5p9kh7tf8")).toBe(28);
  });

  test("our encoder round-trips every varint length (31–37 characters)", () => {
    for (const [n, len] of [[1, 31], [127, 31], [128, 32], [10001, 32], [16383, 32], [16384, 34], [2 ** 21 - 1, 34], [2 ** 21, 36], [2 ** 28, 37], [2 ** 32 - 1, 37]] as const) {
      const id = makeConvexId(n, rnd);
      expect(id).toHaveLength(len);
      expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]+$/);
      expect(convexTableNumber(id)).toBe(n);
    }
  });

  test("structure is checked: alphabet, length, padding bits, minimal varint; Ember ids are not foreign", () => {
    const id = makeConvexId(10001, rnd);
    expect(isConvexId(id)).toBe(true);
    expect(isConvexId(id.toUpperCase())).toBe(false);
    expect(isConvexId(id.slice(0, -1))).toBe(false);
    expect(isConvexId(`${id}0`)).toBe(false);
    expect(isConvexId(id.slice(0, 5) + "i" + id.slice(6))).toBe(false);
    // A 31-character id (19 bytes) ends with 3 padding bits: they must be zero.
    const A = "0123456789abcdefghjkmnpqrstvwxyz";
    const short = makeConvexId(1, rnd);
    expect(isConvexId(short.slice(0, 30) + A[A.indexOf(short[30]!) | 1])).toBe(false);
    // Two-byte varint.
    expect(convexTableNumber(makeConvexId(128, rnd))).toBe(128);
    expect(isConvexId("tasks_01J9Z3ABCDEFGHJKMNPQRSTVWX")).toBe(false);
    expect(isConvexId(42)).toBe(false);
  });
});

describe("engine import", () => {
  test("begin pins the tables to classic storage; compaction never converts them", () => {
    const { engine, driver, sql } = setup();
    expect(sql(`SELECT sql FROM sqlite_master WHERE name = 'tasks'`)[0]!.sql).not.toMatch(/UNIQUE/);
    expect(engine.importer.begin({ foreignIds, tables: ["orgs", "tasks"] }).converted).toEqual(["orgs", "tasks"]);
    expect(sql(`SELECT sql FROM sqlite_master WHERE name = 'tasks'`)[0]!.sql).toMatch(/"_id" TEXT NOT NULL UNIQUE/);
    expect([...classicTables(driver)]).toEqual(["orgs", "tasks"]);
    // A new engine on the same database (a reboot) keeps them classic.
    const again = createEngine({ schema, driver });
    const report = again.migrate();
    expect(report.compacted ?? []).toEqual([]);
    expect(sql(`SELECT sql FROM sqlite_master WHERE name = 'tasks'`)[0]!.sql).toMatch(/UNIQUE/);
    expect(again.storageBehind()).toBe(false);
    expect(engine.importer.begin({ foreignIds, tables: ["tasks"] }).converted).toEqual([]);
    expect(() => engine.importer.begin({ foreignIds: { convex: { [ORGS]: "tasks" } }, tables: [] })).toThrow(/table number 10001 is orgs/);
  });

  test("a compact table with Ember documents converts to classic keeping them readable", () => {
    const { engine } = setup();
    const org = engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.db.insert("orgs", { name: "native" }) }) as any).value as string;
    const t = engine.runMutation(addTask, { orgId: org, title: "native task" }).value as string;
    engine.importer.begin({ foreignIds, tables: ["orgs", "tasks"] });
    expect(engine.runQuery(getQ, { id: t }).value).toMatchObject({ _id: t, title: "native task" });
    expect(engine.runQuery(searchQ, { q: "native" }).value).toHaveLength(1);
    expect(engine.runQuery(aggQ, { org }).value).toMatchObject({ count: 1, sum: { points: 1 } });
  });

  test("documents keep their ids and exact _creationTime; Ember ids and foreign ids live in one table", () => {
    const { engine } = setup();
    engine.importer.begin({ foreignIds, tables: ["orgs", "tasks"] });
    const o1 = orgId();
    expect(engine.importer.documents("orgs", [{ _id: o1, _creationTime: 1700000000000.123, name: "Acme" }])).toEqual({ written: 1, invalid: [] });
    // Sub-ms floats as Convex stores them, out of order, two with the same ms.
    const cts = [1700697415295.742, 1700000000001.5, 1700697415295.7417, 0.1 + 0.2, 1e15 + 0.25, 1700000000001.0000002];
    const docs = cts.map((ct, i) => ({ _id: taskId(), _creationTime: ct, orgId: o1, title: `t${i}`, points: i + 0.1, done: i % 2 === 0, big: BigInt(2) ** 60n + BigInt(i), raw: Uint8Array.of(i, 255) }));
    expect(engine.importer.documents("tasks", docs).written).toBe(docs.length);
    const listed = engine.runQuery(listQ).value as Doc[];
    // by_creation_time: Convex's order, (_creationTime, _id).
    const want = [...docs].sort((a, b) => a._creationTime - b._creationTime || (a._id < b._id ? -1 : 1));
    expect(listed.map((d) => d._id)).toEqual(want.map((d) => d._id));
    for (const d of docs) expect(engine.runQuery(getQ, { id: d._id }).value).toEqual(d);
    expect(listed.map((d) => d._creationTime)).toEqual(want.map((d) => d._creationTime));
    // tableOfId, v.id() args and indexes with foreign references.
    expect(engine.tableOfId(o1)).toBe("orgs");
    expect(engine.tableOfId(docs[0]!._id)).toBe("tasks");
    expect(engine.tableOfId(makeConvexId(55555, rnd))).toBeUndefined();
    expect(() => engine.runQuery(getQ, { id: o1 })).toThrow(/Expected Id<"tasks">/);
    expect(engine.runQuery(byOrgQ, { org: o1 }).value).toHaveLength(docs.length);
    // New documents get Ember ids, next to the imported ones; writes reference foreign ids.
    const mine = engine.runMutation(addTask, { orgId: o1, title: "new one" }).value as string;
    expect(mine).toMatch(/^tasks_/);
    engine.runMutation(patchTask, { id: docs[2]!._id, title: "patched" });
    expect(engine.runQuery(getQ, { id: docs[2]!._id }).value).toMatchObject({ title: "patched", _creationTime: cts[2] });
    const all = engine.runQuery(listQ).value as Doc[];
    expect(all.map((d) => d._id)).toContain(mine);
    expect(all).toHaveLength(docs.length + 1);
    // Re-import overwrites (idempotent upsert).
    expect(engine.importer.documents("tasks", [docs[2]!]).written).toBe(1);
    expect(engine.runQuery(getQ, { id: docs[2]!._id }).value).toMatchObject({ title: "t2" });
  });

  test("invalid documents are reported (strict: nothing is written)", () => {
    const { engine } = setup();
    engine.importer.begin({ foreignIds, tables: ["orgs", "tasks"] });
    const o1 = orgId();
    const good = { _id: taskId(), _creationTime: 1, orgId: o1, title: "ok", points: 1, done: true };
    const bad = [
      { _id: taskId(), _creationTime: 2, orgId: o1, title: 5, points: 1, done: true },
      { _id: orgId(), _creationTime: 3, orgId: o1, title: "wrong table", points: 1, done: true },
      { _id: makeConvexId(4242, rnd), _creationTime: 3, orgId: o1, title: "unknown table number", points: 1, done: true },
      { _id: taskId(), orgId: o1, title: "no ct", points: 1, done: true },
      { _id: taskId(), _creationTime: 4, orgId: taskId(), title: "ref to the wrong table", points: 1, done: true },
      { _id: taskId(), _creationTime: 5, _internal: 1, orgId: o1, title: "system field", points: 1, done: true },
    ];
    expect(() => engine.importer.documents("tasks", [good, ...bad], { strict: true })).toThrow(/6 invalid/);
    expect(engine.runQuery(listQ).value).toEqual([]);
    const r = engine.importer.documents("tasks", [good, ...bad]);
    expect(r.written).toBe(1);
    expect(r.invalid.map((x) => x.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.invalid[0]!.message).toMatch(/title/);
    expect(r.invalid[1]!.message).toMatch(/id of orgs/);
    expect(r.invalid[2]!.message).toMatch(/table-number map/);
    expect(() => engine.importer.documents("orgs", [{ _id: orgId(), _creationTime: 1, name: "x" }])).not.toThrow();
    const fresh = setup();
    expect(() => fresh.engine.importer.documents("tasks", [good])).toThrow(/import begin/);
    // Deletes too: a table still in compact storage has no `_id` column (not a raw SQLite error).
    expect(() => fresh.engine.importer.delete("tasks", [good._id])).toThrow(expect.objectContaining({ code: "ImportNotBegun" }));
    // The check the shard runs is the one `ember import` runs before uploading (dry run, verify).
    const tableOfId = (id: string): string | undefined => (isConvexId(id) ? (foreignIds.convex as Record<string, string>)[String(convexTableNumber(id))] : undefined);
    const shape = schema.manifest.tables.tasks!.document;
    expect(typeof checkImportDoc("tasks", shape, good, { tableOfId, documentSize: 1 << 20 })).toBe("object");
    expect(bad.map((d) => checkImportDoc("tasks", shape, d, { tableOfId, documentSize: 1 << 20 }))).toEqual(r.invalid.map((x) => x.message));
    expect(checkImportDoc("tasks", shape, good, { tableOfId, documentSize: 10 })).toMatch(/limit 10/);
  });

  test("finish re-stages aggregates (backfill refills them); search follows the writes; deletes", () => {
    const { engine } = setup();
    engine.importer.begin({ foreignIds, tables: ["orgs", "tasks"] });
    const o1 = orgId();
    const docs = Array.from({ length: 1200 }, (_, i) => ({ _id: taskId(), _creationTime: 1000 + i, orgId: o1, title: i === 7 ? "needle here" : `task ${i}`, points: 2, done: false }));
    for (let i = 0; i < docs.length; i += 500) engine.importer.documents("tasks", docs.slice(i, i + 500));
    expect(engine.runQuery(searchQ, { q: "needle" }).value).toHaveLength(1);
    const fin = engine.importer.finish();
    expect(fin.staged).toEqual([{ table: "tasks", index: "per_org" }]);
    expect(() => engine.runQuery(aggQ, { org: o1 })).toThrow(/still backfilling/);
    let p;
    do p = engine.backfillStep(500);
    while (!p.done);
    expect(engine.runQuery(aggQ, { org: o1 }).value).toMatchObject({ count: 1200, sum: { points: 2400 } });
    expect(engine.importer.delete("tasks", [docs[7]!._id, docs[8]!._id, "nope"])).toEqual({ deleted: 2 });
    expect(engine.runQuery(searchQ, { q: "needle" }).value).toHaveLength(0);
    engine.importer.finish();
    do p = engine.backfillStep(500);
    while (!p.done);
    expect(engine.runQuery(aggQ, { org: o1 }).value).toMatchObject({ count: 1198 });
    // A second finish with nothing written stages nothing.
    expect(engine.importer.finish()).toEqual({ staged: [], refcounts: null });
  });

  test("files keep their original storage id; refcounts are recounted; unreferenced imports are not collected", () => {
    const { engine, sql } = setup();
    engine.importer.begin({ foreignIds, tables: ["orgs", "tasks"] });
    const [f1, f2] = [fileId(), fileId()];
    const sha = (c: string) => c.repeat(64);
    expect(engine.importer.files([
      { id: f1, sha256: sha("a"), size: 10, contentType: "image/png", createdAt: 1700697415295.742 },
      { id: f2, sha256: sha("b"), size: 20, contentType: null, createdAt: 1 },
    ])).toEqual({ written: 2 });
    const o1 = orgId();
    engine.importer.documents("tasks", [
      { _id: taskId(), _creationTime: 1, orgId: o1, title: "a", points: 1, done: false, file: f1 },
      { _id: taskId(), _creationTime: 2, orgId: o1, title: "b", points: 1, done: false, file: f1 },
    ]);
    expect(engine.importer.finish().refcounts).toBe(1);
    expect(sql(`SELECT id, refcount, zero_since, key, state FROM _files ORDER BY refcount DESC`)).toEqual([
      { id: f1, refcount: 2, zero_since: null, key: `f/${Buffer.from("org:acme").toString("base64url")}/${sha("a")}`, state: "ready" },
      { id: f2, refcount: 0, zero_since: null, key: `f/${Buffer.from("org:acme").toString("base64url")}/${sha("b")}`, state: "ready" },
    ]);
    expect(engine.runQuery(metaQ, { id: f1 }).value).toMatchObject({ storageId: f1, sha256: sha("a"), size: 10, contentType: "image/png" });
  });

  test("the verify hash is order-independent and matches one computed from the source documents", () => {
    const { engine } = setup();
    engine.importer.begin({ foreignIds, tables: ["orgs", "tasks"] });
    const o1 = orgId();
    const docs = Array.from({ length: 30 }, (_, i) => ({ _id: taskId(), _creationTime: 1e12 + i / 3, orgId: o1, title: `t${i}`, points: i, done: i > 3, ...(i % 3 ? { big: BigInt(i) } : {}) }));
    engine.importer.documents("tasks", [...docs].reverse());
    const local = new DocSetHash();
    for (const d of docs) local.add(d);
    const remote = new DocSetHash();
    let after = 0;
    for (;;) {
      const page = engine.importer.hash("tasks", after, 7);
      remote.merge(page);
      if (page.next === null) break;
      after = page.next;
    }
    expect({ count: remote.count, sum: remote.sum }).toEqual({ count: 30, sum: local.sum });
    const other = new DocSetHash();
    for (const d of docs) other.add({ ...d, title: d.title === "t3" ? "T3" : d.title });
    expect(other.sum).not.toBe(local.sum);
  });
});

describe("local execution", () => {
  const ls = localSchema(schema.manifest);
  const t1 = taskId();
  const o1 = orgId();
  const doc = { _id: t1, _creationTime: 5, orgId: o1, title: "x", points: 1, done: false } as Doc;
  const reader: LocalReader = { scan: () => [], get: (table, id) => (table === "tasks" && id === t1 ? doc : null) };

  test("foreign ids resolve through the map, or through the replica without it", () => {
    expect(runLocalQuery(getQ, { id: t1 }, { schema: ls, reader, foreignIds }).value).toEqual(doc);
    expect(runLocalQuery(getQ, { id: t1 }, { schema: ls, reader }).value).toEqual(doc);
    // With the map, an id of another table is refused (like the server); without it, the replica decides.
    expect(() => runLocalQuery(getQ, { id: o1 }, { schema: ls, reader, foreignIds })).toThrow(/Expected Id<"tasks">/);
    const missing = runLocalQuery(getQ, { id: taskId() }, { schema: ls, reader });
    expect(missing.value).toBeNull();
    // Unknown foreign ids are watched in every table.
    expect(new Set(missing.readSet.map((r) => r.table))).toEqual(new Set(["orgs", "tasks"]));
  });
});
