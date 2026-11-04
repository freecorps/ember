import { compareBytes, inKeyRange } from "@freecorps/ember-values";
import { describe, expect, it } from "vitest";
import { createNodeSqliteDriver } from "../testing/index.ts";
import {
  defineSchema,
  defineTable,
  docKey,
  documentsIn,
  indexFields,
  jsSearch,
  localQueryRegistry,
  localSchema,
  mutationGeneric,
  prepareLocalDatabase,
  queryGeneric,
  runLocalQuery,
  sqlLocalReader,
  sqlReplicaWriter,
  v,
  type Doc,
  type LocalReader,
  type QueryCtx,
} from "../src/index.ts";
import { fresh, schema, withUser } from "./fixtures.ts";

const q = <R>(handler: (ctx: QueryCtx, args: any) => R, args: Record<string, any> = {}) => queryGeneric({ args, handler: handler as any }) as any;

const queries = {
  byChannel: q((ctx, { channel }) => ctx.db.query("messages").withIndex("by_channel", (r: any) => r.eq("channel", channel)).collect(), { channel: v.string() }),
  topLiked: q(
    (ctx, { channel, min }) =>
      ctx.db
        .query("messages")
        .withIndex("by_channel_likes", (r: any) => r.eq("channel", channel).gte("likes", min))
        .order("desc")
        .filter((f: any) => f.neq(f.field("body"), "skip me"))
        .take(3),
    { channel: v.string(), min: v.number() },
  ),
  page: q(
    (ctx, { cursor }) => ctx.db.query("messages").withIndex("by_channel", (r: any) => r.eq("channel", "a")).paginate({ numItems: 2, cursor }),
    { cursor: v.union(v.string(), v.null()) },
  ),
  withAuthor: q((ctx, { id }) => {
    const m = ctx.db.get(id);
    return m && { message: m, author: ctx.db.get((m as any).author) };
  }, { id: v.id("messages") }),
  search: q(
    (ctx, { text }) => (ctx.db.query("messages") as any).withSearchIndex("search_body", (s: any) => s.search("body", text).eq("channel", "a")).collect(),
    { text: v.string() },
  ),
  whoami: q((ctx) => ctx.auth.getUserIdentity()?.subject ?? null),
};

/** A server shard with data, and a local SQLite replica holding every row the server queries returned. */
function setup() {
  const s = fresh({ functions: queries });
  const author = withUser(s);
  const bodies = ["ação rápida", "acao lenta", "skip me", "Nada a ver", "rapido demais", "uma ação"];
  bodies.forEach((body, i) => s.insert("messages", { channel: i % 3 === 2 ? "b" : "a", author, body, likes: i * 10 }));
  const all = s.run((db) => [...db.query("users").collect(), ...db.query("messages").collect()]).value as Doc[];

  const local = createNodeSqliteDriver();
  prepareLocalDatabase(local, schema);
  const w = sqlReplicaWriter(local, schema);
  for (const { table, doc } of documentsIn(schema.manifest, all)) w.upsert(table, doc);
  const reader = sqlLocalReader(local, schema);
  const runLocal = (name: keyof typeof queries, args: Record<string, unknown> = {}, r: LocalReader = reader) =>
    runLocalQuery(queries[name], args, { schema, reader: r }).value;
  const runServer = (name: keyof typeof queries, args: Record<string, unknown> = {}) => s.engine.runQuery(name, args).value;
  return { s, author, all, local, w, runLocal, runServer };
}

/** A LocalReader over plain arrays (what an IndexedDB adapter does with IDBKeyRange). */
function memoryReader(docs: Doc[]): LocalReader {
  return {
    scan(table, index, lo, hi, asc, limit) {
      const fields = indexFields(schema.manifest.tables[table]!, index)!;
      const rows = docs
        .filter((d) => d._id.startsWith(schema.manifest.tables[table]!.idPrefix + "_"))
        .map((doc) => ({ key: docKey(doc, fields), doc }))
        .filter((r) => inKeyRange(r.key, lo, hi))
        .sort((a, b) => compareBytes(a.key, b.key));
      if (!asc) rows.reverse();
      return rows.slice(0, limit);
    },
    get: (_t, id) => docs.find((d) => d._id === id) ?? null,
    pluginQuery: (table, _kind, spec, arg) =>
      jsSearch(docs.filter((d) => d._id.startsWith(schema.manifest.tables[table]!.idPrefix + "_")), spec, arg as any),
  };
}

describe("local query execution", () => {
  it("runs the same query code over a local SQLite replica with the same results as the server", () => {
    const { runLocal, runServer, all } = setup();
    expect(runLocal("byChannel", { channel: "a" })).toEqual(runServer("byChannel", { channel: "a" }));
    expect(runLocal("topLiked", { channel: "a", min: 10 })).toEqual(runServer("topLiked", { channel: "a", min: 10 }));
    const p1 = runServer("page", { cursor: null }) as any;
    expect(runLocal("page", { cursor: null })).toEqual(p1);
    // Pagination cursors are encoded keys: a server cursor continues locally.
    expect(runLocal("page", { cursor: p1.continueCursor })).toEqual(runServer("page", { cursor: p1.continueCursor }));
    const id = all.find((d) => (d as any).body === "uma ação")!._id;
    expect(runLocal("withAuthor", { id })).toEqual(runServer("withAuthor", { id }));
  });

  it("searches locally through FTS5 with unicode61 remove_diacritics 2, like the server", () => {
    const { runLocal, runServer } = setup();
    const bodies = (x: unknown) => (x as Doc[]).map((d) => (d as any).body);
    for (const text of ["acao", "AÇÃO", "rap", "nada"]) {
      expect(bodies(runLocal("search", { text }))).toEqual(bodies(runServer("search", { text })));
    }
    expect(bodies(runLocal("search", { text: "acao" })).sort()).toEqual(["acao lenta", "ação rápida"]);
  });

  it("keeps FTS5 in sync with replicated updates and deletes", () => {
    const { runLocal, w, all } = setup();
    const doc = all.find((d) => (d as any).body === "acao lenta")! as Doc;
    w.upsert("messages", { ...doc, body: "outra coisa" } as Doc);
    expect((runLocal("search", { text: "outra" }) as Doc[]).map((d) => d._id)).toEqual([doc._id]);
    expect((runLocal("search", { text: "lenta" }) as Doc[]).length).toBe(0);
    w.delete("messages", doc._id);
    expect((runLocal("search", { text: "outra" }) as Doc[]).length).toBe(0);
  });

  it("runs over any LocalReader (IndexedDB-style ranges, JS search)", () => {
    const { runLocal, runServer, all } = setup();
    const r = memoryReader(all);
    expect(runLocal("byChannel", { channel: "a" }, r)).toEqual(runServer("byChannel", { channel: "a" }));
    expect(runLocal("topLiked", { channel: "a", min: 0 }, r)).toEqual(runServer("topLiked", { channel: "a", min: 0 }));
    const ids = (x: unknown) => (x as Doc[]).map((d) => d._id).sort();
    for (const text of ["acao", "rap", "nada", "zzz"]) expect(ids(runLocal("search", { text }, r))).toEqual(ids(runServer("search", { text })));
  });

  it("passes the local identity and refuses what only the server has", () => {
    const { local } = setup();
    const reader = sqlLocalReader(local, schema);
    expect(runLocalQuery(queries.whoami, {}, { schema, reader, identity: { subject: "ada" } }).value).toBe("ada");
    const agg = q((ctx) => (ctx.db as any).aggregate("messages", "x"));
    const sql = q((ctx) => (ctx.db as any).sql`SELECT 1`);
    const files = q((ctx) => ctx.storage.getUrl("x" as any));
    for (const fn of [agg, sql, files]) expect(() => runLocalQuery(fn, {}, { schema, reader })).toThrow(expect.objectContaining({ code: "OfflineUnsupported" }));
    expect(() => runLocalQuery(queries.byChannel, {}, { schema, reader })).toThrow(expect.objectContaining({ code: "ValidationError" }));
    expect(() => localQueryRegistry({ m: { send: mutationGeneric({ handler: () => null }) } })).toThrow(/only query/);
    expect([...localQueryRegistry({ messages: { list: queries.byChannel } }).keys()]).toEqual(["messages:list"]);
  });

  it("accepts a manifest JSON (codegen's manifest.json) as the schema", () => {
    const { all, runServer } = setup();
    const fromJson = localSchema(JSON.parse(JSON.stringify(schema.manifest)));
    const local = createNodeSqliteDriver();
    prepareLocalDatabase(local, fromJson);
    const w = sqlReplicaWriter(local, fromJson);
    for (const { table, doc } of documentsIn(fromJson.manifest, all)) w.upsert(table, doc);
    const reader = sqlLocalReader(local, fromJson);
    expect(runLocalQuery(queries.search, { text: "acao" }, { schema: fromJson, reader }).value).toEqual(runServer("search", { text: "acao" }));
  });

  it("finds complete documents in results and skips projections", () => {
    const { all } = setup();
    const msg = all.find((d) => d._id.startsWith("msg_"))!;
    const found = documentsIn(schema.manifest, {
      page: [msg, { _id: msg._id, _creationTime: msg._creationTime, body: "projection" }],
      nested: { author: all[0] },
      other: { _id: "nope_01J00000000000000000000000", _creationTime: 1 },
    });
    expect(found.map((f) => f.table)).toEqual(["messages", "users"]);
    // documents embedded under a document-like object (here a message whose `author` id was replaced by the joined
    // user row, so the outer object is no longer a valid message) are still found
    const user = all[0]!;
    expect(documentsIn(schema.manifest, [{ ...msg, author: user }]).map((f) => f.doc._id)).toEqual([user._id]);
    expect(documentsIn(schema.manifest, { _id: msg._id, _creationTime: 1, body: "x" })).toEqual([]);
  });

  it("migrates a local replica, and resets it when the server's planner would refuse", () => {
    const { local } = setup();
    const compatible = defineSchema({
      tables: {
        users: defineTable({ name: v.string(), email: v.string(), admin: v.boolean(), nick: v.optional(v.string()) }).index("by_email", ["email"]),
      },
    });
    // dropping `messages` and adding an optional field is allowed
    expect(prepareLocalDatabase(local, compatible).reset).toBe(false);
    expect(local.exec(`SELECT count(*) AS n FROM users`).rows[0]!.n).toBe(1);
    const refused = defineSchema({ tables: { users: defineTable({ name: v.string(), email: v.string(), admin: v.boolean(), age: v.number() }) } });
    expect(prepareLocalDatabase(local, refused).reset).toBe(true);
    expect(local.exec(`SELECT count(*) AS n FROM users`).rows[0]!.n).toBe(0);
  });
});
