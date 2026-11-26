// `valueFingerprint`: a structural hash memoized per object (backend.ts), and the full comparison (`sameValue`) the
// store runs before a matching fingerprint skips a write — a collision never leaves a stale value stored.
import { describe, expect, it } from "vitest";
import { encodeJson } from "@freecorps/ember-values";
import { stableStringify } from "@freecorps/ember-client";
import { offlineQueries, schema } from "./app.ts";
import { fingerprintOfJson, hasFingerprint, hashValue, recordKey, sameValue, valueFingerprint } from "../src/backend.ts";
import { MemoryBackend, memoryStorage } from "../src/index.ts";

const SHARD = "org:acme";

describe("valueFingerprint", () => {
  const value = () => ({ page: [{ _id: "a", n: 1, tags: ["x", "y"], b: new Uint8Array([1, 2]) }, { _id: "b", n: 2n, z: null }], isDone: false, cursor: "c" });

  it("equal values (a structured clone) fingerprint alike; any change does not", () => {
    expect(valueFingerprint(value())).toBe(valueFingerprint(structuredClone(value())));
    const variants: unknown[] = [
      { ...value(), cursor: "d" },
      { ...value(), isDone: true },
      { ...value(), page: value().page.slice(1) },
      { ...value(), page: [{ ...value().page[0], n: 2 }, value().page[1]] },
      { ...value(), page: [{ ...value().page[0], b: new Uint8Array([1, 3]) }, value().page[1]] },
      { ...value(), page: [value().page[0], { ...value().page[1], n: 2 }] }, // 2n → 2
      { ...value(), page: [value().page[0], { ...value().page[1], n: "2" }] },
      { ...value(), page: [value().page[1], value().page[0]] },
    ];
    const fps = new Set([valueFingerprint(value()), ...variants.map(valueFingerprint)]);
    expect(fps.size).toBe(variants.length + 1);
  });

  it("follows the encoding: -0, NaN, undefined fields, key order", () => {
    expect(valueFingerprint(0)).not.toBe(valueFingerprint(-0));
    expect(valueFingerprint(NaN)).toBe(valueFingerprint(Number("x")));
    expect(valueFingerprint({ a: 1, b: undefined })).toBe(valueFingerprint({ a: 1 }));
    expect(valueFingerprint({ a: 1, b: 2 })).not.toBe(valueFingerprint({ b: 2, a: 1 }));
    expect(valueFingerprint([1, [2]])).not.toBe(valueFingerprint([[1], 2]));
    expect(valueFingerprint("")).not.toBe(valueFingerprint(null));
    expect(hashValue(Number.MAX_SAFE_INTEGER)).toBeLessThan(2 ** 53);
  });

  it("is memoized per object: a value reusing the rows of an earlier one hashes only what is new", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ _id: `r${i}`, body: "lorem ipsum ".repeat(20), i }));
    valueFingerprint(rows);
    const next = [...rows.slice(0, 1999), { ...rows[1999]!, i: -1 }];
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) valueFingerprint([...next]);
    const reused = performance.now() - t0;
    const t1 = performance.now();
    for (let k = 0; k < 20; k++) valueFingerprint(structuredClone(next));
    const fresh = performance.now() - t1;
    expect(valueFingerprint([...next])).toBe(valueFingerprint(structuredClone(next)));
    expect(reused).toBeLessThan(fresh);
  });

  it("is never one of the encoding-hash fingerprints older versions stored; both formats are recognized", () => {
    const v = value();
    const legacy = fingerprintOfJson(encodeJson(v));
    expect(legacy).toContain(".");
    expect(valueFingerprint(v)).not.toContain(".");
    expect(hasFingerprint(v, legacy)).toBe(true);
    expect(hasFingerprint(v, valueFingerprint(v))).toBe(true);
    expect(hasFingerprint({ ...v, cursor: "x" }, legacy)).toBe(false);
  });

  it("sameValue: encoding equality, compared in full", () => {
    expect(sameValue(value(), structuredClone(value()))).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(sameValue(0, -0)).toBe(false);
    expect(sameValue(NaN, NaN)).toBe(true);
    expect(sameValue(1n, 1)).toBe(false);
    expect(sameValue(new Uint8Array([1]), new Uint8Array([1]))).toBe(true);
    expect(sameValue(new Uint8Array([1]), [1])).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue({ a: [] }, { a: {} })).toBe(false);
  });
});

describe("the store coalesces the same value only when it is the same", () => {
  it("a matching fingerprint over a different value (a collision) is written, not skipped", async () => {
    const be = new MemoryBackend(schema);
    const args = { channel: "x" };
    const stored = [{ _id: "messages_1", _creationTime: 1, channel: "x", body: "old" }];
    const incoming = [{ _id: "messages_1", _creationTime: 1, channel: "x", body: "new" }];
    const key = recordKey(SHARD, "messages:count", stableStringify(args));
    // A record whose fingerprint is (as a collision would make it) the incoming value's.
    be.queries.set(key, {
      key,
      shard: SHARD,
      fn: "messages:count",
      args,
      argsJson: stableStringify(args),
      value: stored,
      version: 5,
      epoch: "E",
      owner: "u\u0000\u0000ana",
      updatedAt: Date.now(),
      ids: [],
      size: encodeJson(stored).length,
      fp: valueFingerprint(incoming),
    });
    const s = memoryStorage({ schema, queries: {}, backend: be });
    await s.load();
    const commits: unknown[] = [];
    const commit = be.commit.bind(be);
    be.commit = (shard, c) => (commits.push(c), commit(shard, c));
    await s.applyPatch({ shard: SHARD, fn: "messages:count", args, argsJson: stableStringify(args), value: incoming, version: 5, epoch: "E", identity: { subject: "ana" } });
    expect(commits).toHaveLength(1);
    const r = await s.runQueryLocally({ shard: SHARD, fn: "messages:count", args, argsJson: stableStringify(args), identity: { subject: "ana" } });
    expect(r?.value).toEqual(incoming);
    // The same value again: coalesced (no commit).
    await s.applyPatch({ shard: SHARD, fn: "messages:count", args, argsJson: stableStringify(args), value: structuredClone(incoming), version: 5, epoch: "E", identity: { subject: "ana" } });
    expect(commits).toHaveLength(1);
    await s.close();
  });

  it("a replicated value is coalesced after a restart too (its rows read back to compare)", async () => {
    const be = new MemoryBackend(schema);
    const args = { channel: "x" };
    const rows = [{ _id: "messages_1", _creationTime: 1, channel: "x", body: "one" }];
    const u = { shard: SHARD, fn: "messages:list", args, argsJson: stableStringify(args), value: rows, version: 3, epoch: "E", identity: { subject: "ana" } };
    const s1 = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s1.load();
    await s1.applyPatch(u);
    await s1.close();
    const s2 = memoryStorage({ schema, queries: offlineQueries, backend: be });
    await s2.load();
    let commits = 0;
    const commit = be.commit.bind(be);
    be.commit = (shard, c) => (commits++, commit(shard, c));
    await s2.applyPatch({ ...u, value: structuredClone(rows) });
    expect(commits).toBe(0);
    await s2.close();
  });
});
