// PR 4B-3a: `decodeRow` with the compiled plan for rows whose `_json` holds fields, against the general path it
// replaced (verbatim below). Same documents, same field order, same values.

import { describe, expect, it } from "vitest";
import { encodeJson, fromSqlValue, parseValue, v, type ObjectShape } from "@freecorps/ember-values";
import { decodeRow, encodeFields, layoutOf, type Layout } from "../src/layout.ts";
import type { SqlRow } from "../src/driver.ts";
import { prng } from "./fixtures.ts";

/** `decodeRow`'s general path before PR 4B-3a, verbatim. */
function refDecodeRow(layout: Layout, row: SqlRow): Record<string, unknown> {
  const json = typeof row._json === "string" && row._json !== "{}" ? (parseValue(row._json) as Record<string, unknown>) : {};
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
  for (const k in json) if (!(k in doc) && !layout.column(k)) doc[k] = json[k];
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
  // A field named like an Object.prototype member: no plan, the general path (unchanged).
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
        const want = refDecodeRow(layout, row);
        expect(Object.keys(got)).toEqual(Object.keys(want));
        // (A field named `toString` reads Object.prototype's through the parsed JSON on both paths: no JSON text.)
        if (!Object.prototype.hasOwnProperty.call(got, "toString")) expect(encodeJson(got)).toBe(encodeJson(want));
        expect(got).toEqual(want);
      }
    }
  });
});
