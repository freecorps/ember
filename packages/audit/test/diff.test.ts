// The diff an audit row keeps: changed fields only, redaction, the byte cap.
import { encodeJson } from "@freecorps/ember-values";
import { describe, expect, test } from "vitest";
import { auditDiff, capDiff, REDACTED, TRUNCATED } from "../src/index.ts";

const sys = { _id: "users_1", _creationTime: 1 };
const size = (x: unknown) => new TextEncoder().encode(encodeJson(x)).byteLength;

describe("auditDiff", () => {
  test("an update keeps only the fields that changed (deep equality; system fields never)", () => {
    const before = { ...sys, name: "Ana", email: "a@x.test", tags: ["a", "b"], profile: { city: "Rio", zip: 1 } };
    const after = { ...sys, name: "Ana", email: "ana@x.test", tags: ["a", "b"], profile: { zip: 1, city: "Rio" } };
    expect(auditDiff(before, after)).toEqual({ diff: { email: { from: "a@x.test", to: "ana@x.test" } }, truncated: false, omitted: 0 });
    // A field added (no `from`) and one removed (no `to`).
    expect(auditDiff({ ...sys, a: 1 }, { ...sys, b: 2 })!.diff).toEqual({ b: { to: 2 }, a: { from: 1 } });
    // Nothing audited changed: no row.
    expect(auditDiff(before, { ...before })).toBeNull();
  });

  test("insert: every field as `to`; delete: every field as `from`", () => {
    expect(auditDiff(null, { ...sys, name: "Ana", n: 1n })!.diff).toEqual({ name: { to: "Ana" }, n: { to: 1n } });
    expect(auditDiff({ ...sys, name: "Ana" }, null)!.diff).toEqual({ name: { from: "Ana" } });
    // An insert with no audited field still is an event (an empty diff).
    expect(auditDiff(null, { ...sys, secret: 1 }, { fields: ["name"] })!.diff).toEqual({});
  });

  test("fields and ignore choose what is audited; a change only to other fields writes nothing", () => {
    const before = { ...sys, name: "Ana", lastSeenAt: 1, role: "user" };
    const after = { ...sys, name: "Ana", lastSeenAt: 2, role: "admin" };
    expect(auditDiff(before, after, { fields: ["role"] })!.diff).toEqual({ role: { from: "user", to: "admin" } });
    expect(auditDiff(before, after, { ignore: ["lastSeenAt"] })!.diff).toEqual({ role: { from: "user", to: "admin" } });
    expect(auditDiff(before, { ...before, lastSeenAt: 3 }, { ignore: ["lastSeenAt"] })).toBeNull();
  });

  test("redacted fields: the change is recorded, never the value", () => {
    const d = auditDiff({ ...sys, passwordHash: "old-hash", name: "A" }, { ...sys, passwordHash: "new-hash", name: "B" }, { redact: ["passwordHash"] })!;
    expect(d.diff).toEqual({ passwordHash: { from: REDACTED, to: REDACTED }, name: { from: "A", to: "B" } });
    expect(JSON.stringify(encodeJson(d))).not.toMatch(/hash"/);
    expect(auditDiff(null, { ...sys, token: "t0k" }, { redact: ["token"] })!.diff).toEqual({ token: { to: REDACTED } });
    // Same value written again: not a change, not recorded.
    expect(auditDiff({ ...sys, token: "x", n: 1 }, { ...sys, token: "x", n: 2 }, { redact: ["token"] })!.diff).toEqual({ n: { from: 1, to: 2 } });
  });

  test("the size cap: whole changes while they fit, then truncated values, then fields left out", () => {
    const big = "x".repeat(3000);
    const d = auditDiff({ ...sys, a: 1, body: "old" }, { ...sys, a: 2, body: big, c: "small" }, { maxBytes: 1024 })!;
    expect(d.truncated).toBe(true);
    expect(d.diff).toEqual({ a: { from: 1, to: 2 }, body: { from: TRUNCATED, to: TRUNCATED }, c: { to: "small" } });
    expect(size(d.diff)).toBeLessThanOrEqual(1024);
    // Too many fields for even their names: the rest is counted, never stored.
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field_with_a_long_name_${i}`, { to: i }]));
    const r = capDiff(many, 512);
    expect(size(r.diff)).toBeLessThanOrEqual(512);
    expect(r.omitted).toBeGreaterThan(150);
    expect(Object.keys(r.diff).length + r.omitted).toBe(200);
    // Under the cap: untouched.
    expect(capDiff({ a: { to: 1 } })).toEqual({ diff: { a: { to: 1 } }, truncated: false, omitted: 0 });
  });
});
