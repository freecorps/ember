// Validators v2 (docs/design/dx.md §3.10): refinements, descriptions, defaults, composition, Standard Schema.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  hasDefaults,
  storageShape,
  toJsonSchema,
  v,
  withDefaults,
  type Infer,
  type ObjectInputType,
  type ObjectType,
} from "../src/index.ts";

describe("refinements", () => {
  it("strings: length, email, url, uuid, regex", () => {
    const name = v.string().min(1).max(5);
    expect(name.validate("ana").ok).toBe(true);
    expect(name.validate("")).toMatchObject({ ok: false, message: "Must not be empty" });
    expect(name.validate("abcdef")).toMatchObject({ ok: false, message: "Expected at most 5 characters, got 6" });
    expect(v.string().max(2).validate("😀😀").ok).toBe(true); // code points
    expect(v.string().email().validate("a@b.co").ok).toBe(true);
    expect(v.string().email().validate("nope").ok).toBe(false);
    expect(v.string().url().validate("https://x.dev/a").ok).toBe(true);
    expect(v.string().url().validate("javascript:alert(1)").ok).toBe(false);
    expect(v.string().uuid().validate("123e4567-e89b-12d3-a456-426614174000").ok).toBe(true);
    expect(v.string().regex(/^[a-z]+$/i).validate("Abc").ok).toBe(true);
    expect(v.string().regex(/^[a-z]+$/).validate("Abc")).toMatchObject({ ok: false, message: "Expected to match /^[a-z]+$/" });
    expect(name.shape).toEqual({ kind: "string", checks: { minLength: 1, maxLength: 5 } });
    expect(() => v.string().min(-1)).toThrow(/non-negative integer/);
  });

  it("numbers and arrays", () => {
    const qty = v.number().int().min(1).max(10);
    expect(qty.validate(3).ok).toBe(true);
    expect(qty.validate(3.5)).toMatchObject({ ok: false, message: "Expected an integer, got 3.5" });
    expect(qty.validate(0).ok).toBe(false);
    expect(v.number().positive().validate(0).ok).toBe(false);
    expect(v.number().nonnegative().validate(0).ok).toBe(true);
    expect(v.number().min(0).validate(Number.NaN).ok).toBe(false);
    const tags = v.array(v.string().min(1)).nonempty().max(2);
    expect(tags.validate(["a"]).ok).toBe(true);
    expect(tags.validate([])).toMatchObject({ ok: false, message: "Expected at least 1 items, got 0" });
    expect(tags.validate(["a", ""])).toMatchObject({ ok: false, path: "[1]" });
    expectTypeOf<Infer<typeof tags>>().toEqualTypeOf<string[]>();
  });

  it("refinements and descriptions do not change storage", () => {
    const o = v.object({ email: v.string().email().describe("Where we write"), n: v.optional(v.number().int()) });
    expect(storageShape(o.shape)).toEqual(v.object({ email: v.string(), n: v.optional(v.number()) }).shape);
    expect(o.shape.kind === "object" && o.shape.fields.email!.description).toBe("Where we write");
  });
});

describe(".default() (function arguments)", () => {
  const args = { limit: v.number().int().default(20), tag: v.optional(v.string()), q: v.string() };
  it("is optional for callers and set for handlers", () => {
    expectTypeOf<ObjectInputType<typeof args>>().toEqualTypeOf<{ q: string; limit?: number; tag?: string }>();
    expectTypeOf<ObjectType<typeof args>>().toEqualTypeOf<{ q: string; limit: number; tag?: string }>();
    const shape = v.object(args).shape;
    expect(withDefaults(shape, { q: "x" })).toEqual({ q: "x", limit: 20 });
    const given = { q: "x", limit: 5 };
    expect(withDefaults(shape, given)).toBe(given); // untouched when nothing is missing
    expect(hasDefaults(shape)).toBe(true);
    expect(withDefaults(v.object({ big: v.int64().default(7n) }).shape, {})).toEqual({ big: 7n });
  });
  it("refuses an invalid default", () => {
    expect(() => v.number().int().default(1.5)).toThrow(/default is invalid/);
  });
  it("v.optional and partial() keep a default; v.nullable wants it outside", () => {
    const o = v.object({ n: v.optional(v.number().default(1).describe("N")), s: v.string() });
    expect(o.fields.n.defaultValue).toBe(1);
    expect(o.fields.n.description).toBe("N");
    expect(withDefaults(o.shape, { s: "x" })).toEqual({ s: "x", n: 1 });
    expectTypeOf<ObjectType<typeof o.fields>>().toEqualTypeOf<{ n: number; s: string }>();
    expect(withDefaults(o.partial().shape, {})).toEqual({ n: 1 });
    expect(() => v.nullable(v.number().default(1))).toThrow(/after v.nullable/);
    expect(withDefaults(v.object({ x: v.nullable(v.number()).default(null) }).shape, {})).toEqual({ x: null });
  });
  it("fills defaults inside arrays, records and unions", () => {
    const item = v.object({ a: v.number(), b: v.number().default(2) });
    expect(withDefaults(v.object({ xs: v.array(item) }).shape, { xs: [{ a: 1 }, { a: 3, b: 4 }] })).toEqual({ xs: [{ a: 1, b: 2 }, { a: 3, b: 4 }] });
    expect(withDefaults(v.record(item).shape, { k: { a: 1 } })).toEqual({ k: { a: 1, b: 2 } });
    const u = v.object({ u: v.union(v.null(), item) });
    expect(withDefaults(u.shape, { u: { a: 1 } })).toEqual({ u: { a: 1, b: 2 } });
    const exact = { u: null };
    expect(withDefaults(u.shape, exact)).toBe(exact);
  });
  it("a default is stored with its nested defaults filled", () => {
    const inner = v.object({ a: v.number().default(1) });
    const o = v.object({ inner: inner.default({} as never), xs: v.array(inner).default([{}] as never) });
    expect(withDefaults(o.shape, {})).toEqual({ inner: { a: 1 }, xs: [{ a: 1 }] });
    expect(inner.default({} as never)["~standard"].validate(undefined)).toEqual({ value: { a: 1 } });
  });
  it("callers may omit defaults of a v.object() and of nested objects", () => {
    const o = v.object({ inner: v.object({ n: v.number().default(1) }), m: v.string().default("x") });
    expectTypeOf<ObjectInputType<typeof o.fields>>().toEqualTypeOf<{ inner: { n?: number }; m?: string }>();
  });
});

describe("Standard Schema and JSON Schema", () => {
  it("implements ~standard", () => {
    const o = v.object({ a: v.object({ b: v.array(v.number().min(1)) }) });
    expect(o["~standard"].vendor).toBe("ember");
    expect(o["~standard"].validate({ a: { b: [1] } })).toEqual({ value: { a: { b: [1] } } });
    expect(o["~standard"].validate({ a: { b: [1, 0] } })).toEqual({ issues: [{ message: "Expected at least 1, got 0", path: ["a", "b", 1] }] });
  });
  it("~standard fills defaults (what forms get is what the handler gets)", () => {
    expect(v.object({ n: v.number().default(3), s: v.string() })["~standard"].validate({ s: "x" })).toEqual({ value: { s: "x", n: 3 } });
    expect(v.number().default(3)["~standard"].validate(undefined)).toEqual({ value: 3 });
  });
  it("JSON Schema: regex flags inline, $float only when the refinements accept it", () => {
    expect(toJsonSchema(v.string().regex(/^[a-z]+$/i).shape)).toEqual({ type: "string", pattern: "(?i:^[a-z]+$)" });
    expect(toJsonSchema(v.string().regex(/^a$/gu).shape)).toEqual({ type: "string", pattern: "^a$" });
    expect(() => v.string().regex(/a/y)).toThrow(/sticky/);
    expect(toJsonSchema(v.number().int().min(1).shape)).toEqual({ type: "integer", minimum: 1 });
    const floats = (s: ReturnType<typeof toJsonSchema>) => ((s.anyOf as { properties: { $float: { enum: string[] } } }[])[1]!).properties.$float.enum;
    expect(floats(toJsonSchema(v.number().shape))).toEqual(["NaN", "Infinity", "-Infinity", "-0"]);
    expect(floats(toJsonSchema(v.number().nonnegative().shape))).toEqual(["Infinity", "-0"]);
  });
  it("carries refinements, descriptions and defaults", () => {
    const s = toJsonSchema(v.object({ email: v.string().email().max(100).describe("Contact"), n: v.number().int().min(0).default(1), xs: v.array(v.string()).nonempty() }).shape);
    expect(s).toMatchObject({
      properties: {
        email: { type: "string", format: "email", maxLength: 100, description: "Contact" },
        n: { anyOf: [{ type: "integer", minimum: 0 }, expect.anything()], default: 1 },
        xs: { type: "array", minItems: 1 },
      },
      required: ["email", "xs"],
    });
  });
});
