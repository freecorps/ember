// Micro-benchmark of the hot paths of PR 2A (not run in CI). Public APIs only, so the same file measures before and
// after a change. V8 (what workerd runs), from source:
//
//   node --conditions=@freecorps/ember-source --experimental-transform-types --no-warnings scripts/bench-hot-path.ts [filter]

import {
  bytesToBase64,
  decodeKey,
  encodeJson,
  encodeKey,
  encodeParts,
  parseValue,
  rangeFor,
  rowDiffJson,
  encodeWithDocs,
  v,
  validate,
  valueSize,
} from "../packages/values/src/index.ts";
import { coerceRow } from "../packages/server/src/sqlQuery.ts";
import { compileSql, createEngine, createMatchIndex, defineSchema, defineTable, mutationGeneric, queryGeneric } from "../packages/server/src/index.ts";
import { createNodeSqliteDriver } from "../packages/server/src/testing.ts";

const filter = process.argv[2];

function bench(name: string, fn: () => unknown, ms = 400): void {
  if (filter && !name.includes(filter)) return;
  let sink: unknown;
  // Warm-up (JIT), then as many batches as fit in `ms`.
  for (let i = 0; i < 2000; i++) sink = fn();
  let n = 0;
  const t0 = performance.now();
  let t = t0;
  while (t - t0 < ms) {
    for (let i = 0; i < 200; i++) sink = fn();
    n += 200;
    t = performance.now();
  }
  const ns = ((t - t0) * 1e6) / n;
  if (sink === Symbol.for("never")) console.log(sink);
  console.log(`${name.padEnd(44)} ${ns.toFixed(0).padStart(9)} ns/op`);
}

// ------------------------------------------------------------------------------------------------ values

const ascii = "general-channel-name";
const unicode = "ação 漢字 😀 naïve";
bench("encodeKey [ascii, number, id]", () => encodeKey([ascii, 42.5, "msg_01J9Z3ABCDEFGHJKMNPQRSTVWX"]));
bench("encodeKey [unicode string]", () => encodeKey([unicode]));
bench("encodeKey [bigint, bool, null]", () => encodeKey([123456789012345n, true, null]));
bench("encodeKey [object]", () => encodeKey([{ b: 1, a: "x", c: [1, 2, 3] }]));
bench("rangeFor eq+gte+lt", () => rangeFor([ascii], { op: "gte", value: 10 }, { op: "lt", value: 20 }));
bench("rangeFor eq only", () => rangeFor([ascii, 5]));
const k1 = encodeKey([ascii, 42.5, "msg_01J9Z3ABCDEFGHJKMNPQRSTVWX"]);
const k2 = encodeKey([unicode, new Uint8Array([1, 0, 2, 3])]);
bench("decodeKey [ascii, number, id]", () => decodeKey(k1));
bench("decodeKey [unicode, bytes]", () => decodeKey(k2));

const doc = v.object({
  channel: v.string(),
  author: v.string(),
  body: v.string().max(2000),
  email: v.string().email(),
  slug: v.string().regex(/^[a-z-]+$/),
  likes: v.number(),
  meta: v.optional(v.object({ edited: v.boolean(), tags: v.array(v.string()) })),
});
const value = { channel: ascii, author: "users_01J9Z3ABCDEFGHJKMNPQRSTVWX", body: "hello world ".repeat(20), email: "ada@x.dev", slug: "a-b-c", likes: 3, meta: { edited: false, tags: ["a", "b"] } };
bench("validate object doc", () => validate(doc.shape, value));
const event = v.union(
  v.object({ type: v.literal("a"), x: v.number() }),
  v.object({ type: v.literal("b"), y: v.string() }),
  v.object({ type: v.literal("c"), z: v.boolean() }),
  v.object({ type: v.literal("d"), w: v.null() }),
  v.object({ type: v.literal("e"), u: v.array(v.number()) }),
);
const strShape = v.string().min(3).max(64).shape;
bench("validate string min/max (40 chars)", () => validate(strShape, "a-forty-character-long-string-0123456789"));
const reShape = v.string().regex(/^[a-z0-9-]+$/).shape;
bench("validate string regex", () => validate(reShape, "a-forty-character-long-string-0123456789"));
bench("validate discriminated union (last)", () => validate(event.shape, { type: "e", u: [1, 2] }));

const docs = Array.from({ length: 50 }, (_, i) => ({ _id: `msg_${i}`, _creationTime: 1700000000000 + i, channel: ascii, body: `message ${i}`, likes: i }));
const page = { page: docs, isDone: false, continueCursor: "abc" };
const plain = { title: "x", count: 3, nested: { a: [1, 2, 3], b: { c: "d" } }, tags: ["a", "b", "c"] };
bench("encodeParts paginate (50 docs)", () => encodeParts(page));
bench("encodeParts plain object (no docs)", () => encodeParts(plain));
const enc = encodeWithDocs(docs);
const docs2 = docs.map((d, i) => (i % 7 === 0 ? { ...d, likes: d.likes + 1 } : d)).reverse();
const enc2 = encodeWithDocs(docs2);
bench("rowDiffJson 50 docs (reversed, 8 changed)", () => rowDiffJson(docs, enc.docs!, docs2, enc2.docs!, enc2.json));
const escaped = encodeJson({ ...value, body: "line\u0001break \ud800 lone", meta: { edited: true, tags: ["\u0002"] } });
bench("parseValue with \\u escapes", () => parseValue(escaped));
const tagged = encodeJson({ ...value, n: 5n, b: new Uint8Array(32) });
bench("parseValue with tags", () => parseValue(tagged));
const kb = new Uint8Array(1024).map((_, i) => i * 7);
bench("bytesToBase64 1 KiB", () => bytesToBase64(kb));
bench("valueSize doc", () => valueSize(value));

// ------------------------------------------------------------------------------------------------ server

const schema = defineSchema({
  tables: {
    messages: defineTable({
      channel: v.string(),
      author: v.string(),
      body: v.string(),
      likes: v.number(),
      tags: v.array(v.string()),
      meta: v.optional(v.object({ edited: v.boolean() })),
    })
      .index("by_channel", ["channel"])
      .index("by_author", ["author"])
      .index("by_channel_likes", ["channel", "likes"])
      .index("by_edited", ["meta.edited"]),
    items: defineTable({ kind: v.string(), n: v.number(), done: v.boolean(), payload: v.string(), tags: v.array(v.string()) }).index("by_kind", ["kind"]),
  },
});
const driver = createNodeSqliteDriver();
let clock = 1_700_000_000_000;
const engine = createEngine({ schema, driver, now: () => (clock += 1) });
engine.migrate();
const mutate = (fn: (ctx: any) => unknown) => engine.runMutation(mutationGeneric({ handler: fn as any }) as any, {});
const id = (mutate((ctx) => ctx.db.insert("messages", { channel: ascii, author: "a", body: "hi", likes: 0, tags: ["x"] })) as { value: string }).value;
for (let i = 0; i < 50; i++) mutate((ctx) => ctx.db.insert("messages", { channel: ascii, author: `a${i}`, body: `m${i}`, likes: i, tags: [] }));
for (let i = 0; i < 1000; i++) mutate((ctx) => ctx.db.insert("items", { kind: ["a", "b", "c", "d"][i % 4], n: i, done: i % 3 === 0, payload: "x".repeat(200) + i, tags: ["t"] }));
bench("engine patch (one column field)", () => mutate((ctx) => ctx.db.patch(id, { body: `b${clock}` })));
bench("engine increment", () => mutate((ctx) => ctx.db.increment(id, "likes", 1)));
const query = (fn: (ctx: any) => unknown) => engine.runQuery(queryGeneric({ handler: fn as any }) as any, {});
bench("engine query db.get", () => query((ctx) => ctx.db.get(id)));
bench("engine query withIndex take(10)", () => query((ctx) => ctx.db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", ascii)).take(10)));
bench("engine query filter take(10) (1 in 10 match)", () => query((ctx) => ctx.db.query("items").filter((q: any) => q.and(q.eq(q.field("kind"), "b"), q.gte(q.field("n"), 500))).take(10)));
bench("engine query filter collect (1000 rows, 12 match)", () => query((ctx) => ctx.db.query("items").filter((q: any) => q.and(q.eq(q.field("done"), true), q.gt(q.field("n"), 960))).collect()));
bench("engine query withIndex + filter collect", () => query((ctx) => ctx.db.query("items").withIndex("by_kind", (q: any) => q.eq("kind", "c")).filter((q: any) => q.lt(q.field("n"), 100)).collect()));
bench("engine mutation filter first (scan 1000)", () => mutate((ctx) => ctx.db.query("items").filter((q: any) => q.eq(q.field("n"), 999)).first()));
bench("engine query db.sql", () => query((ctx) => ctx.db.sql`SELECT count(*) AS n FROM messages WHERE likes > ${5}`));
bench("compileSql (no cache)", () => compileSql(["SELECT channel, count(*) AS n FROM messages WHERE likes > ", " GROUP BY channel"], [5], ["messages"]));
const rowShape = v.object({ channel: v.string(), n: v.number(), ok: v.boolean(), big: v.int64() }).shape;
bench("coerceRow", () => coerceRow(rowShape, { channel: "x", n: 3, ok: 1, big: "12" }));

const mi = createMatchIndex<string>(schema);
const rs = (query((ctx) => ctx.db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", ascii)).take(10)) as { readSet: any }).readSet;
for (let i = 0; i < 1000; i++) mi.set(`k${i}`, rs);
bench("matchIndex.set same read set (1000 keys)", () => mi.set("k7", rs));
const before = { _id: id, _creationTime: 1, channel: ascii, author: "a", body: "x", likes: 1, tags: [] };
const change = { table: "messages", id, before, after: { ...before, body: "y" } };
bench("matchIndex.match update (non-key field)", () => mi.match([change as any]));
const batchItems = Array.from({ length: 10 }, (_, i) => ({ name: mutationGeneric({ handler: ((ctx: any) => ctx.db.patch(id, { likes: i })) as any }) as any, args: {} }));
bench("engine runMutationBatch 10 patches", () => engine.runMutationBatch(batchItems as any));
bench("engine empty mutation", () => mutate(() => null));
bench("engine empty query", () => query(() => null));
