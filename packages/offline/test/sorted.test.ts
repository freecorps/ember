// scanSorted (memory and TinyBase backends) answers exactly what filtering every row with inKeyRange did.
import { describe, expect, it } from "vitest";
import { compareBytes, inKeyRange } from "@freecorps/ember-values";
import { scanSorted, type KeyedRow } from "../src/sorted.ts";

describe("scanSorted", () => {
  it("matches a full filter for random keys, bounds, directions and limits", () => {
    let seed = 11;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const key = () => Uint8Array.from({ length: 1 + rnd(3) }, () => rnd(4));
    for (let round = 0; round < 300; round++) {
      const rows: KeyedRow[] = Array.from({ length: rnd(30) }, (_, i) => ({ key: key(), doc: { _id: `d${i}`, _creationTime: i } }));
      rows.sort((a, b) => compareBytes(a.key, b.key));
      const lo = key();
      const hi = key();
      const asc = rnd(2) === 0;
      const limit = rnd(40);
      const all = rows.filter((r) => inKeyRange(r.key, lo, hi));
      expect(scanSorted(rows, lo, hi, asc, limit)).toEqual((asc ? all : all.reverse()).slice(0, limit));
    }
  });
});
