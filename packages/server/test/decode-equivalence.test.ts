// PR 4B-3a: `decodeRow` with the compiled plan for rows whose `_json` holds fields, against the general path it
// replaced (verbatim below). Same documents, same field order, same values; a field named like an Object.prototype
// member is read as an own property (before, the prototype's member was read or kept data dropped).

import { describe, expect, it } from "vitest";
import { encodeJson, fromSqlValue, parseValue, v, type ObjectShape } from "@freecorps/ember-values";
import { decodeRow, encodeFields, layoutOf, type Layout } from "../src/layout.ts";
import type { SqlRow } from "../src/driver.ts";
import { prng } from "./fixtures.ts";

/**
 * `decodeRow`'s general path before PR 4B-3a, verbatim; with `ownOnly`, reading own properties only (a prototype-less
 * JSON, `hasOwn` for kept data), so a field named like an Object.prototype member is never the prototype's member.
 */
function refDecodeRow(layout: Layout, row: SqlRow, ownOnly = false): Record<string, unknown> {
  let json = typeof row._json === "string" && row._json !== "{}" ? (parseValue(row._json) as Record<string, unknown>) : {};
  if (ownOnly) json = Object.assign(Object.create(null) as Record<string, unknown>, json);
  const doc: Record<string, unknown> = { _id: String(row._id), _creationTime: Number(row._creationTime) };
  for (const field of layout.fieldOrder) {
    const c = layout.column(field);
    if (c) {
      if (field in json) doc[field] = json[field];
      else {
        const x = fromSqlValue(c.spec.cls, row[field]);
        if (x !== undefined) doc[field] = x;
        else if (c.spec.nullable) doc[field] = null;
      }
    } else if (json[field] !== undefined) doc[field] = json[field];
  }
  for (const k in json) if (!(ownOnly ? Object.prototype.hasOwnProperty.call(doc, k) : k in doc) && !layout.column(k)) doc[k] = json[k];
  return doc;
}

const shapes: ObjectShape[] = [
  v.object({
    s: v.string(),
    n: v.optional(v.number()),
    nb: v.union(v.boolean(), v.null()),
    big: v.optional(v.int64()),
    o: v.optional(v.object({ x: v.number() })),
    b: v.optional(v.bytes()),
    any: v.optional(v.any()),
    tags: v.array(v.string()),
  }).shape as ObjectShape,
  v.object({ a: v.number(), z: v.optional(v.string()) }).shape as ObjectShape,
  // A field named like an Object.prototype member.
  v.object({ toString: v.optional(v.string()), s: v.string() }).shape as ObjectShape,
];

const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
function randomField(r: () => number): unknown {
  return pick(r, [NaN, -0, Infinity, 1.5, "x", true, null, 7n, [1, "a"], { x: 2 }, new Uint8Array([1, 2]), undefined]);
}
/** A value of the column's class (or null / absent, or an escaped float): what a validated document holds. */
function columnValue(r: () => number, cls: string | undefined): unknown {
  switch (cls) {
    case "text":
      return pick(r, ["x", "", "ação", undefined]);
    case "real":
      return pick(r, [1.5, 0, -0, NaN, Infinity, undefined]);
    case "int64":
      return pick(r, [7n, -1n, undefined]);
    case "boolean":
      return pick(r, [true, false, null, undefined]);
    case "bytes":
      return pick(r, [new Uint8Array([1, 2]), undefined]);
    default:
      return randomField(r);
  }
}

describe("decodeRow: the plan on rows with JSON gives the general path's documents", () => {
  it("random rows: escaped column values, fields outside the schema, `{}` and non-string `_json`", () => {
    const r = prng(77);
    for (const shape of shapes) {
      const layout = layoutOf("t", shape);
      for (let i = 0; i < 3000; i++) {
        const doc: Record<string, unknown> = {};
        for (const f of layout.fieldOrder) if (r() < 0.8) doc[f] = columnValue(r, layout.column(f)?.spec.cls);
        // Kept data: fields the schema no longer has.
        for (const k of ["old", "zz", "1", "toString"]) if (r() < 0.15) Object.defineProperty(doc, k, { value: randomField(r) ?? 1, enumerable: true, writable: true, configurable: true });
        const row: SqlRow = { _id: `t_${i}`, _creationTime: i, ...encodeFields(layout, doc) };
        if (r() < 0.05) row._json = null;
        // A column whose value is also in `_json` (an escape), even when the column holds one.
        if (r() < 0.1 && typeof row._json === "string") row._json = encodeJson({ ...(parseValue(row._json) as object), [pick(r, layout.fieldOrder)]: randomField(r) ?? 0 });
        const got = decodeRow(layout, row);
        // Own properties only: the general path's reads with a prototype-less JSON and `hasOwn` for kept data.
        const want = refDecodeRow(layout, row, true);
        expect(Object.keys(got)).toEqual(Object.keys(want));
        expect(encodeJson(got)).toBe(encodeJson(want));
        expect(got).toEqual(want);
        for (const x of Object.values(got)) expect(typeof x).not.toBe("function");
        // Without a field named like an Object.prototype member, the same text as before, verbatim.
        if (!layout.fieldOrder.includes("toString") && !Object.prototype.hasOwnProperty.call(doc, "toString")) {
          expect(encodeJson(got)).toBe(encodeJson(refDecodeRow(layout, row)));
        }
      }
    }
  });

  it("a field named like an Object.prototype member is the stored value, never the prototype's", () => {
    // Kept data (not in the schema) named `toString` / `constructor` / `__proto__` survives the read.
    const ab = layoutOf("t", v.object({ a: v.number(), z: v.optional(v.string()) }).shape as ObjectShape);
    const kept = decodeRow(ab, { _id: "t_1", _creationTime: 1, a: 1, z: null, _json: '{"toString":"x","constructor":2,"__proto__":{"p":1}}' });
    expect(Object.keys(kept)).toEqual(["_id", "_creationTime", "a", "toString", "constructor", "__proto__"]);
    expect(kept.toString).toBe("x");
    expect(kept.constructor).toBe(2);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
    expect(encodeJson(kept)).toBe('{"_id":"t_1","_creationTime":1,"a":1,"toString":"x","constructor":2,"__proto__":{"p":1}}');
    // A schema field `toString`: its column's value, or absent; not Object.prototype.toString.
    const ts = layoutOf("t", v.object({ toString: v.optional(v.string()), s: v.string() }).shape as ObjectShape);
    for (const json of ["{}", '{"old":1}']) {
      expect(Object.keys(decodeRow(ts, { _id: "t_1", _creationTime: 1, toString: null, s: "a", _json: json }))).not.toContain("toString");
      expect(decodeRow(ts, { _id: "t_1", _creationTime: 1, toString: "v", s: "a", _json: json }).toString).toBe("v");
    }
  });
});
