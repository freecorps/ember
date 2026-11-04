import { describe, expect, test } from "bun:test";
import { defineSchema, defineTable, registerIndexKind, v, validate } from "cfx";
import { decodeId, encodeId, compareUtf8 } from "cfx/keys";
import { schema } from "./helpers";

describe("validators carry a runtime Shape", () => {
  test("shape is plain JSON", () => {
    const val = v.object({ a: v.string(), b: v.optional(v.array(v.union(v.literal("x"), v.int64()))), c: v.id("users") });
    expect(JSON.parse(JSON.stringify(val.shape))).toEqual({
      kind: "object",
      fields: {
        a: { shape: { kind: "string" }, optional: false },
        b: { shape: { kind: "array", item: { kind: "union", members: [{ kind: "literal", value: "x" }, { kind: "int64" }] } }, optional: true },
        c: { shape: { kind: "id", table: "users" }, optional: false },
      },
    });
  });
  test("validate", () => {
    const s = v.object({ a: v.string(), n: v.optional(v.int64()), o: v.object({ x: v.boolean() }) }).shape;
    expect(validate(s, { a: "x", o: { x: true } })).toEqual([]);
    expect(validate(s, { a: "x", n: 1, o: { x: true } })[0]!.path).toBe("n");
    expect(validate(s, { a: "x", o: {}, extra: 1 }).map((i) => i.path)).toEqual(["o.x", "extra"]);
  });
});

describe("defineTable / index-kind registry", () => {
  test("schema export lists every index kind (db, search, user plugin)", () => {
    const t = schema.export().tables.messages!;
    expect(t.indexes.map((i) => `${i.kind}:${i.name}`)).toEqual([
      "db:by_channel", "db:by_channel_likes", "db:by_edited", "search:search_body", "vector:by_embedding",
    ]);
  });
  test("bad index definitions fail at definition time", () => {
    expect(() => defineTable({ a: v.string() }).index("x", ["b" as any])).toThrow(/unknown field b/);
    expect(() => defineTable({ a: v.string() }).index("by_id" as any, ["a"])).toThrow(/reserved/);
    expect(() => defineTable({ a: v.number() }).searchIndex("s", { searchField: "a" })).toThrow(/must be v.string/);
    expect(() => defineTable({ e: v.array(v.string()) }).vectorIndex("s", { vectorField: "e", dimensions: 3 })).toThrow(/v.array\(v.float64/);
    expect(() => defineSchema({ _bad: defineTable({}) })).toThrow(/Invalid table name/);
  });
  test("a user plugin registers a new builder method", () => {
    registerIndexKind<{ field: string }>({
      kind: "geo", method: "geoIndex",
      parse: (name, config) => ({ kind: "geo", name, fields: [config.field] }),
      ddl: (layout, spec) => [{ type: "index", name: `${layout.table}__${spec.name}`, sql: `CREATE INDEX "${layout.table}__${spec.name}" ON "${layout.table}" (${layout.expr(spec.fields[0]!)})` }],
    });
    const t = (defineTable({ loc: v.string() }) as any).geoIndex("by_loc", { field: "loc" });
    expect(t.indexes).toEqual([{ kind: "geo", name: "by_loc", fields: ["loc"] }]);
    expect(() => registerIndexKind({ kind: "geo2", method: "index", parse: () => null as any, ddl: () => [] })).toThrow(/already exists/);
  });
});

describe("ids", () => {
  test("encode/decode table number, checksum rejects tampering", () => {
    for (const n of [1, 127, 128, 16383, 99999]) {
      const id = encodeId(n);
      expect(decodeId(id)).toBe(n);
      const flipped = id.slice(0, 5) + (id[5] === "a" ? "b" : "a") + id.slice(6);
      expect(decodeId(flipped)).toBeUndefined();
    }
    expect(encodeId(1).length).toBe(28);
  });
  test("utf8 order differs from utf16 order above U+FFFF", () => {
    expect(compareUtf8("\u{1F600}", "｡")).toBeGreaterThan(0); // emoji > halfwidth in UTF-8
    expect("\u{1F600}" < "｡").toBe(true); // ...but JS < says otherwise
  });
});
