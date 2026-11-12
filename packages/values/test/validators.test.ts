import { describe, expect, expectTypeOf, test } from "vitest";
import {
  columnSpecFor,
  decodeJson,
  encodeJson,
  encodeJsonStable,
  ESCAPE,
  fromJSONValue,
  fromSqlValue,
  parseValue,
  shapeAtPath,
  stringifyValue,
  toJSONValue,
  toJsonSchema,
  toSqlValue,
  v,
  validate,
  validatorFromShape,
  valueSize,
  type FileId,
  type GenericId,
  type Infer,
} from "../src/index.ts";

describe("v.*", () => {
  const message = v.object({
    channel: v.id("channels"),
    body: v.string(),
    likes: v.number(),
    big: v.int64(),
    flag: v.boolean(),
    nothing: v.null(),
    raw: v.bytes(),
    attachment: v.optional(v.file()),
    kind: v.union(v.literal("text"), v.literal("image")),
    tags: v.array(v.string()),
    counts: v.record(v.number()),
    meta: v.optional(v.object({ edited: v.boolean(), at: v.optional(v.number()) })),
    extra: v.any(),
  });

  test("Infer", () => {
    type M = Infer<typeof message>;
    expectTypeOf<M>().toEqualTypeOf<{
      channel: GenericId<"channels">;
      body: string;
      likes: number;
      big: bigint;
      flag: boolean;
      nothing: null;
      raw: Uint8Array;
      kind: "text" | "image";
      tags: string[];
      counts: Record<string, number>;
      extra: unknown;
      attachment?: FileId;
      meta?: { edited: boolean; at?: number };
    }>();
    type Paths = NonNullable<(typeof message)["fieldPaths"]>;
    expectTypeOf<"meta.edited">().toMatchTypeOf<Paths>();
    expectTypeOf<"body">().toMatchTypeOf<Paths>();
  });

  const good = {
    channel: "channels_01J",
    body: "hi",
    likes: 1,
    big: 2n,
    flag: true,
    nothing: null,
    raw: new Uint8Array([1]),
    kind: "text",
    tags: ["a"],
    counts: { x: 1 },
    extra: { anything: [1, "x", null] },
  };

  test("validate ok and error paths", () => {
    expect(message.validate(good)).toEqual({ ok: true });
    expect(message.validate({ ...good, meta: { edited: "no" } })).toMatchObject({ ok: false, path: "meta.edited" });
    expect(message.validate({ ...good, tags: ["a", 1] })).toMatchObject({ ok: false, path: "tags[1]" });
    expect(message.validate({ ...good, big: 1 })).toMatchObject({ ok: false, path: "big" });
    expect(message.validate({ ...good, kind: "video" })).toMatchObject({ ok: false, path: "kind" });
    expect(message.validate({ ...good, surprise: 1 })).toMatchObject({ ok: false, path: "surprise", message: "Unexpected field" });
    const { body: _b, ...missing } = good;
    expect(message.validate(missing)).toMatchObject({ ok: false, path: "body", message: "Missing required field" });
    expect(message.validate({ ...good, meta: undefined })).toEqual({ ok: true });
    expect(message.validate({ ...good, extra: new Date() })).toMatchObject({ ok: false, path: "extra" });
    expect(message.validate({ ...good, counts: { $x: 1 } })).toMatchObject({ ok: false, path: "counts.$x" });
    expect(message.validate({ ...good, big: 2n ** 63n })).toMatchObject({ ok: false });
  });

  test("ids are checked against their table when a resolver is given", () => {
    const tableOfId = (id: string) => id.slice(0, id.lastIndexOf("_"));
    expect(v.id("users").validate("users_01", { tableOfId })).toEqual({ ok: true });
    expect(v.id("users").validate("posts_01", { tableOfId })).toMatchObject({ ok: false });
  });

  test("literals, unions, optional", () => {
    expect(v.literal(0).validate(-0)).toEqual({ ok: true });
    expect(v.literal(1n).validate(1n)).toEqual({ ok: true });
    expect(v.literal(1n).validate(1)).toMatchObject({ ok: false });
    expect(v.optional(v.string()).validate(undefined)).toEqual({ ok: true });
    const u = v.union(v.object({ t: v.literal("a"), x: v.number() }), v.object({ t: v.literal("b") }));
    expect(u.validate({ t: "a", x: "1" })).toMatchObject({ ok: false, path: "x" });
    expect(() => v.object({ "bad-name": v.string() })).toThrow(/Invalid field name/);
  });

  test("shapes are JSON and round-trip into validators", () => {
    const json = JSON.parse(JSON.stringify(message.shape));
    expect(json).toEqual(message.shape);
    expect(validatorFromShape(json).validate(good)).toEqual({ ok: true });
    expect(validate(v.literal(5n).shape, 5n)).toEqual({ ok: true });
  });

  test("shapeAtPath", () => {
    expect(shapeAtPath(message.shape, "meta.edited")).toEqual({ shape: { kind: "boolean" }, optional: true });
    expect(shapeAtPath(message.shape, "body")).toEqual({ shape: { kind: "string" }, optional: false });
    expect(shapeAtPath(message.shape, "body.x")).toBeUndefined();
  });

  test("toJsonSchema", () => {
    const s = toJsonSchema(v.object({ a: v.string(), b: v.optional(v.int64()), c: v.array(v.literal("x")) }).shape);
    expect(s).toMatchObject({
      type: "object",
      required: ["a", "c"],
      additionalProperties: false,
      properties: { a: { type: "string" }, b: { properties: { $int64: { type: "string" } } }, c: { type: "array", items: { const: "x" } } },
    });
  });
});

describe("JSON values", () => {
  test("round trip of values JSON cannot carry", () => {
    const x = { a: 1n, b: new Uint8Array([0, 255]), c: [NaN, Infinity, -Infinity, -0, 1.5], d: { e: null }, u: undefined };
    const json = stringifyValue(x);
    expect(JSON.parse(json)).toEqual({
      a: { $int64: "1" },
      b: { $bytes: "AP8=" },
      c: [{ $float: "NaN" }, { $float: "Infinity" }, { $float: "-Infinity" }, { $float: "-0" }, 1.5],
      d: { e: null },
    });
    const back = parseValue(json) as any;
    expect(back.a).toBe(1n);
    expect([...back.b]).toEqual([0, 255]);
    expect(Object.is(back.c[3], -0)).toBe(true);
    expect(Number.isNaN(back.c[0])).toBe(true);
    expect(fromJSONValue(toJSONValue("x"))).toBe("x");
    expect(decodeJson(encodeJson({ n: 5n }))).toEqual({ n: 5n });
    expect(encodeJsonStable({ b: 1, a: { d: 2n, c: 1 } })).toBe('{"a":{"c":1,"d":{"$int64":"2"}},"b":1}');
  });
});

describe("SQL column mapping", () => {
  test("column classes", () => {
    const f = (shape: any, optional = false) => columnSpecFor({ shape, optional });
    expect(f(v.string().shape)).toMatchObject({ cls: "text", sqlType: "TEXT", nullable: false });
    expect(f(v.id("t").shape, true)).toMatchObject({ cls: "text", optional: true });
    expect(f(v.int64().shape)).toMatchObject({ cls: "int64", sqlType: "TEXT" });
    expect(f(v.boolean().shape)).toMatchObject({ cls: "boolean", sqlType: "INTEGER" });
    expect(f(v.bytes().shape)).toMatchObject({ cls: "bytes", sqlType: "BLOB" });
    expect(f(v.nullable(v.number()).shape)).toMatchObject({ cls: "real", nullable: true });
    expect(f(v.nullable(v.number()).shape, true)).toBeUndefined(); // optional + nullable -> JSON
    expect(f(v.union(v.literal("a"), v.literal("b")).shape)).toMatchObject({ cls: "text" });
    expect(f(v.union(v.string(), v.int64()).shape)).toBeUndefined(); // both TEXT but different classes
    expect(f(v.object({}).shape)).toBeUndefined();
  });

  test("conversions", () => {
    expect(toSqlValue("boolean", true)).toBe(1);
    expect(fromSqlValue("boolean", 0)).toBe(false);
    expect(toSqlValue("int64", -(2n ** 63n))).toBe("-9223372036854775808");
    expect(fromSqlValue("int64", "-9223372036854775808")).toBe(-(2n ** 63n));
    expect(toSqlValue("real", NaN)).toBe(ESCAPE);
    expect(toSqlValue("real", -0)).toBe(ESCAPE);
    expect(toSqlValue("real", 1.5)).toBe(1.5);
    expect(fromSqlValue("text", null)).toBeUndefined();
    expect(valueSize({ a: "é" })).toBeGreaterThan(4);
  });
});
