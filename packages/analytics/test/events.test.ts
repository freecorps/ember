// Batch validation and limits, and the event → Analytics Engine data point mapping (the layout sql.ts reads).
import { describe, expect, test } from "vitest";
import { BatchError, checkBatch, checkLayout, columnOf, MAX_EVENTS, MAX_EXTRA_BYTES, MAX_PAST_MS, MAX_PROP_LENGTH, parseBatch, toDataPoint, type TrackedEvent } from "../src/index.ts";

const now = Date.UTC(2026, 10, 26, 12, 0, 0);
const ok = (events: unknown[], o: Partial<Parameters<typeof checkBatch>[1]> = {}) => checkBatch({ events }, { now, ...o });
const refused = (body: unknown, re: RegExp) => {
  expect(() => checkBatch(body, { now })).toThrow(BatchError);
  expect(() => checkBatch(body, { now })).toThrow(re);
};

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("batch validation", () => {
  test("a valid batch: defaults filled, server time for a missing ts", () => {
    const [e] = ok([{ name: "signed_up", props: { plan: "pro", seats: 3, trial: true }, anonymousId: "a-1" }]);
    expect(e).toEqual({ name: "signed_up", props: { plan: "pro", seats: 3, trial: true }, ts: now, receivedAt: now, anonymousId: "a-1", userId: "" });
  });

  test("the batch's shape: an object with a non-empty events array, nothing else, at most 50", () => {
    refused(null, /object/);
    refused([], /object/);
    refused({ events: "x" }, /array/);
    refused({ events: [] }, /empty/);
    refused({ events: [{ name: "a" }], extra: 1 }, /unknown field "extra"/);
    refused({ events: Array.from({ length: MAX_EVENTS + 1 }, () => ({ name: "a" })) }, /at most 50/);
    expect(ok(Array.from({ length: MAX_EVENTS }, () => ({ name: "a" })))).toHaveLength(MAX_EVENTS);
    expect(() => ok([{ name: "a" }, { name: "b" }], { maxEvents: 1 })).toThrow(/at most 1/);
  });

  test("event names: a closed alphabet, no quotes or backslashes, up to 64", () => {
    for (const name of ["page view", "Checkout.Completed", "a:b/c-d_e", "x".repeat(64)]) expect(ok([{ name }])[0]!.name).toBe(name);
    for (const name of ["", " lead", "trail ", "1st", "a'b", 'a"b', "a\\b", "a;b", "x".repeat(65), "é", "a\nb", 7]) refused({ events: [{ name }] }, /invalid event name/);
  });

  test("props are flat, with identifier keys, capped in count; long strings are cut, not refused", () => {
    refused({ events: [{ name: "a", props: [] }] }, /props must be an object/);
    refused({ events: [{ name: "a", props: { nested: { x: 1 } } }] }, /flat/);
    refused({ events: [{ name: "a", props: { list: [1] } }] }, /flat/);
    refused({ events: [{ name: "a", props: { n: null } }] }, /flat/);
    refused({ events: [{ name: "a", props: { "bad key": 1 } }] }, /invalid key/);
    refused({ events: [{ name: "a", props: { ["k".repeat(41)]: 1 } }] }, /invalid key/);
    refused({ events: [{ name: "a", props: { x: Number.POSITIVE_INFINITY } }] }, /finite/);
    refused({ events: [{ name: "a", props: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) }] }, /at most 20/);
    const [e] = ok([{ name: "a", props: { label: "y".repeat(1000) } }]);
    expect((e!.props.label as string).length).toBe(MAX_PROP_LENGTH);
  });

  test("ts: a client time within the window is kept; one outside is replaced by the server's", () => {
    expect(ok([{ name: "a", ts: now - 1000.7 }])[0]!.ts).toBe(Math.floor(now - 1000.7));
    expect(ok([{ name: "a", ts: now - MAX_PAST_MS - 1 }])[0]!.ts).toBe(now);
    expect(ok([{ name: "a", ts: now + 2 * 3600_000 }])[0]!.ts).toBe(now);
    refused({ events: [{ name: "a", ts: "yesterday" }] }, /ts must be a number/);
  });

  test("ids: anonymous ids have a closed alphabet; userId only from the identity unless trusted", () => {
    refused({ events: [{ name: "a", anonymousId: "a b" }] }, /anonymousId/);
    refused({ events: [{ name: "a", anonymousId: "x".repeat(65) }] }, /anonymousId/);
    // Not trusted (the default): a userId in the body is checked, then dropped.
    expect(ok([{ name: "a", userId: "mallory" }])[0]!.userId).toBe("");
    expect(ok([{ name: "a", userId: "u1" }], { trustUserId: true })[0]!.userId).toBe("u1");
    // A signed-in identity always wins over the body.
    expect(ok([{ name: "a", userId: "mallory" }], { identity: "user_42", trustUserId: true })[0]!.userId).toBe("user_42");
    expect(ok([{ name: "a" }], { identity: "user_42" })[0]!.userId).toBe("user_42");
    refused({ events: [{ name: "a", userId: "" }] }, /userId/);
  });

  test("parseBatch: JSON text (what text/plain beacons send)", () => {
    expect(parseBatch('{"events":[{"name":"a"}]}', { now })).toHaveLength(1);
    expect(() => parseBatch("{not json", { now })).toThrow(/not JSON/);
  });
});

describe("data points", () => {
  const e: TrackedEvent = { name: "checkout", props: { plan: "pro", amount: 49.5, seats: 3, coupon: "X", trial: false }, ts: now - 5, receivedAt: now, anonymousId: "anon", userId: "u1" };

  test("index = name; blobs name, ids, source, country, install, extra props JSON; doubles ts", () => {
    const p = toDataPoint(e, { install: "analytics", source: "client", country: "BR" });
    expect(p.indexes).toEqual(["checkout"]);
    expect(p.blobs).toEqual(["checkout", "u1", "anon", "client", "BR", "analytics", JSON.stringify({ plan: "pro", amount: 49.5, seats: 3, coupon: "X", trial: false })]);
    expect(p.doubles).toEqual([now - 5]);
  });

  test("declared dimensions get blob8.., declared measures double2..; the rest stays in blob7", () => {
    const layout = { dimensions: ["plan", "trial", "region"], measures: ["amount", "seats", "missing"] };
    const p = toDataPoint(e, { install: "analytics", source: "server", ...layout });
    expect(p.blobs.slice(7)).toEqual(["pro", "false", ""]);
    expect(p.doubles).toEqual([now - 5, 49.5, 3, 0]);
    expect(JSON.parse(p.blobs[6]!)).toEqual({ coupon: "X" });
    expect(columnOf(layout, "plan")).toBe("blob8");
    expect(columnOf(layout, "region")).toBe("blob10");
    expect(columnOf(layout, "seats")).toBe("double3");
    expect(columnOf(layout, "coupon")).toBeNull();
    // A string in a measure column is not a number: it stays with the extra props.
    expect(JSON.parse(toDataPoint({ ...e, props: { amount: "free" } }, { install: "a", source: "client", ...layout }).blobs[6]!)).toEqual({ amount: "free" });
  });

  test("no props: blob7 is empty; the extra JSON is capped by whole props, never cut mid-JSON", () => {
    expect(toDataPoint({ ...e, props: {} }, { install: "a", source: "client" }).blobs[6]).toBe("");
    const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v".repeat(200)]));
    const json = toDataPoint({ ...e, props: big }, { install: "a", source: "client" }).blobs[6]!;
    expect(bytes(json)).toBeLessThanOrEqual(MAX_EXTRA_BYTES);
    const kept = JSON.parse(json) as Record<string, string>;
    expect(Object.keys(kept).length).toBeGreaterThan(5);
    expect(Object.keys(kept)).toEqual(Object.keys(big).slice(0, Object.keys(kept).length));
    // The size counted as it grows is the JSON's: a prop that ends exactly at the cap is kept, one byte more is not.
    const sizeOf = (p: Record<string, unknown>) => bytes(JSON.stringify(p));
    const base = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "v".repeat(200)]));
    for (const extra of [0, 1]) {
      const room = MAX_EXTRA_BYTES - sizeOf(base) - ',"last":""'.length;
      const props = { ...base, n: 1.5, t: true, last: "w".repeat(room - ',"n":1.5,"t":true'.length + extra) };
      const out = toDataPoint({ ...e, props }, { install: "a", source: "client" }).blobs[6]!;
      expect(bytes(out)).toBeLessThanOrEqual(MAX_EXTRA_BYTES);
      expect(Object.keys(JSON.parse(out) as object).includes("last")).toBe(extra === 0);
      if (extra === 0) expect(bytes(out)).toBe(MAX_EXTRA_BYTES);
    }
    // In UTF-8 bytes, not UTF-16 code units: 3 props of 256 CJK characters are ~800 code units but ~2300 bytes.
    const cjk = { a: "語".repeat(256), b: "語".repeat(256), c: "語".repeat(256) };
    expect(JSON.stringify(cjk).length).toBeLessThan(MAX_EXTRA_BYTES);
    const cut = toDataPoint({ ...e, props: cjk }, { install: "a", source: "client" }).blobs[6]!;
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_EXTRA_BYTES);
    expect(Object.keys(JSON.parse(cut) as object)).toEqual(["a", "b"]);
    // The exact-limit rule holds in bytes too: a multi-byte prop that ends exactly at the cap is kept.
    const two = { a: "語".repeat(256), b: "語".repeat(256) };
    const room = MAX_EXTRA_BYTES - bytes(JSON.stringify(two)) - bytes(',"z":""');
    expect(Object.keys(JSON.parse(toDataPoint({ ...e, props: { ...two, z: "x".repeat(room) } }, { install: "a", source: "client" }).blobs[6]!) as object)).toEqual(["a", "b", "z"]);
    expect(Object.keys(JSON.parse(toDataPoint({ ...e, props: { ...two, z: "x".repeat(room + 1) } }, { install: "a", source: "client" }).blobs[6]!) as object)).toEqual(["a", "b"]);
  });

  test("__proto__ is not a prop key (a plain object would lose it); sparse batches are refused", () => {
    const body = JSON.parse('{"events":[{"name":"a","props":{"__proto__":"x"}}]}') as unknown;
    expect(() => checkBatch(body, { now: 1 })).toThrow(/invalid key/);
    expect(() => checkLayout({ dimensions: ["__proto__"] })).toThrow(/invalid prop/);
    expect(() => checkBatch({ events: new Array(2) }, { now: 1 })).toThrow(/events\[0\] is missing/);
    const holey: unknown[] = [{ name: "a" }];
    holey[2] = { name: "b" };
    expect(() => checkBatch({ events: holey }, { now: 1 })).toThrow(/events\[1\] is missing/);
  });

  test("layouts: identifiers, no repeats, within the column counts", () => {
    expect(() => checkLayout({ dimensions: Array.from({ length: 14 }, (_, i) => `d${i}`) })).toThrow(/13/);
    expect(() => checkLayout({ measures: Array.from({ length: 20 }, (_, i) => `m${i}`) })).toThrow(/19/);
    expect(() => checkLayout({ dimensions: ["a"], measures: ["a"] })).toThrow(/twice/);
    expect(() => checkLayout({ dimensions: ["bad-name"] })).toThrow(/invalid prop/);
    expect(() => checkLayout({ dimensions: ["a", "b"], measures: ["c"] })).not.toThrow();
  });
});
