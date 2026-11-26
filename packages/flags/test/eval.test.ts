// The pure evaluator (`@freecorps/ember-flags/eval`): rule order, types, conditions, and the rollout hash's
// determinism and distribution.
import { describe, expect, test } from "vitest";
import { compareSemver, evaluate, evaluateAll, evaluateDetail, flagValueError, hash32, rolloutBucket, ruleError, type FlagDefinition } from "../src/eval.ts";

const flag = (f: Partial<FlagDefinition> & Pick<FlagDefinition, "key">): FlagDefinition => ({ type: "boolean", defaultValue: false, enabled: true, rules: [], ...f });

describe("evaluate", () => {
  test("missing, disabled, on: the fallback, defaultValue, the on value", () => {
    expect(evaluateDetail(null, {}, "fb")).toEqual({ value: "fb", reason: "missing" });
    expect(evaluateDetail(flag({ key: "a", enabled: false, version: 3 }))).toEqual({ value: false, reason: "disabled", version: 3 });
    // A boolean flag's on value is true unless set; other types serve defaultValue unless `value` is set.
    expect(evaluateDetail(flag({ key: "a" }))).toEqual({ value: true, reason: "on" });
    expect(evaluate(flag({ key: "a", value: false }))).toBe(false);
    expect(evaluate(flag({ key: "s", type: "string", defaultValue: "classic" }))).toBe("classic");
    expect(evaluate(flag({ key: "s", type: "string", defaultValue: "classic", value: "new" }))).toBe("new");
    expect(evaluate(flag({ key: "n", type: "number", defaultValue: 10, value: 25 }))).toBe(25);
    expect(evaluate(flag({ key: "j", type: "json", defaultValue: { limits: [1] }, value: { limits: [1, 2] } }))).toEqual({ limits: [1, 2] });
  });

  test("rules: the first match wins, in order; a disabled flag ignores them", () => {
    const f = flag({
      key: "theme",
      type: "string",
      defaultValue: "classic",
      value: "fresh",
      rules: [
        { conditions: [{ attr: "plan", op: "eq", value: "enterprise" }], value: "corporate" },
        { conditions: [{ attr: "plan", op: "in", value: ["pro", "enterprise"] }, { attr: "country", op: "eq", value: "BR" }], value: "verde" },
        { conditions: [{ attr: "email", op: "startsWith", value: "qa+" }], value: "debug" },
      ],
    });
    expect(evaluateDetail(f, { plan: "enterprise", country: "BR" })).toEqual({ value: "corporate", reason: "rule", rule: 0 });
    expect(evaluateDetail(f, { plan: "pro", country: "BR" })).toEqual({ value: "verde", reason: "rule", rule: 1 });
    expect(evaluate(f, { plan: "pro", country: "US" })).toBe("fresh");
    expect(evaluate(f, { email: "qa+1@x.test" })).toBe("debug");
    expect(evaluate({ ...f, enabled: false }, { plan: "enterprise" })).toBe("classic");
    // An empty condition list matches everyone.
    expect(evaluate(flag({ key: "x", rules: [{ conditions: [], value: false }] }))).toBe(false);
  });

  test("conditions: neq/notIn, missing attributes, arrays, numbers, semver", () => {
    const one = (c: FlagDefinition["rules"][number]["conditions"][number], ctx: Record<string, unknown>) => evaluate(flag({ key: "k", rules: [{ conditions: [c], value: false }] }), ctx as never);
    expect(one({ attr: "plan", op: "neq", value: "free" }, { plan: "pro" })).toBe(false);
    expect(one({ attr: "plan", op: "neq", value: "free" }, { plan: "free" })).toBe(true);
    expect(one({ attr: "plan", op: "neq", value: "free" }, {})).toBe(false); // missing ≠ "free"
    expect(one({ attr: "plan", op: "eq", value: "free" }, {})).toBe(true); // missing never equals
    expect(one({ attr: "plan", op: "notIn", value: ["free"] }, {})).toBe(false);
    expect(one({ attr: "seats", op: "in", value: [5, 10] }, { seats: 10 })).toBe(false);
    expect(one({ attr: "seats", op: "eq", value: 10 }, { seats: "10" })).toBe(true); // no coercion
    // Arrays: positive operators match any element, negative ones hold when no element matches.
    expect(one({ attr: "roles", op: "eq", value: "admin" }, { roles: ["viewer", "admin"] })).toBe(false);
    expect(one({ attr: "roles", op: "neq", value: "admin" }, { roles: ["viewer", "admin"] })).toBe(true);
    expect(one({ attr: "roles", op: "notIn", value: ["admin", "owner"] }, { roles: ["viewer"] })).toBe(false);
    expect(one({ attr: "appVersion", op: "semverGte", value: "2.4.0" }, { appVersion: "2.10.1" })).toBe(false);
    expect(one({ attr: "appVersion", op: "semverGte", value: "2.4.0" }, { appVersion: "2.3.9" })).toBe(true);
    expect(one({ attr: "appVersion", op: "semverLt", value: "2.4.0" }, { appVersion: "2.4.0-beta.1" })).toBe(false);
    expect(one({ attr: "appVersion", op: "semverLt", value: "2.4.0" }, { appVersion: "garbage" })).toBe(true); // never matches
  });

  test("compareSemver", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("v1.2", "1.2.0")).toBe(0);
    expect(compareSemver("1.10.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-beta", "1.0.0-alpha.9")).toBe(1);
    expect(compareSemver("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(compareSemver("x", "1.0.0")).toBeNull();
  });

  test("evaluateAll by key", () => {
    expect(evaluateAll([flag({ key: "a" }), flag({ key: "b", enabled: false })], {})).toEqual({ a: true, b: false });
  });
});

describe("rollout", () => {
  const rolled = (percent: number, salt = "s1") => flag({ key: "newCheckout", rollout: { percent, salt } });
  const ids = Array.from({ length: 10_000 }, (_, i) => `user_${i}`);

  test("deterministic: the same unit, salt and key give the same bucket; no unitId is outside", () => {
    expect(rolloutBucket("s1", "newCheckout", "user_42")).toBe(rolloutBucket("s1", "newCheckout", "user_42"));
    expect(hash32("abc")).toBe(hash32("abc"));
    // A fixed value, so the hash can never change silently (it would reshuffle every rollout).
    expect(hash32("s1.newCheckout.user_42")).toBe(4217725852);
    const f = rolled(50);
    expect(ids.slice(0, 200).map((u) => evaluate(f, { unitId: u }))).toEqual(ids.slice(0, 200).map((u) => evaluate(f, { unitId: u })));
    expect(evaluateDetail(f, {})).toEqual({ value: false, reason: "outOfRollout" });
    expect(evaluateDetail(rolled(0), { unitId: "user_1" }).reason).toBe("outOfRollout");
    expect(evaluateDetail(rolled(100), { unitId: "user_1" })).toEqual({ value: true, reason: "rollout" });
  });

  test.each([1, 10, 25, 50, 90])("distribution: %d%% of 10k ids within ±3%%", (percent) => {
    const inside = ids.filter((u) => evaluate(rolled(percent), { unitId: u }) === true).length;
    expect(Math.abs(inside / ids.length - percent / 100)).toBeLessThan(0.03);
  });

  test("raising the percent keeps everyone already inside; a new salt reshuffles", () => {
    const at = (p: number, salt = "s1") => new Set(ids.filter((u) => evaluate(rolled(p, salt), { unitId: u })));
    const ten = at(10);
    const twenty = at(20);
    for (const u of ten) expect(twenty.has(u)).toBe(true);
    const other = at(10, "s2");
    const kept = [...ten].filter((u) => other.has(u)).length;
    // Independent draws of 10%: about 10% of the first set is in the second (far from 100%).
    expect(kept / ten.size).toBeLessThan(0.2);
    expect(Math.abs(other.size / ids.length - 0.1)).toBeLessThan(0.03);
    // Different flags with the same salt are independent too (the key is in the hash).
    const otherFlag = new Set(ids.filter((u) => evaluate({ ...rolled(10), key: "otherFlag" }, { unitId: u })));
    expect([...ten].filter((u) => otherFlag.has(u)).length / ten.size).toBeLessThan(0.2);
  });

  test("rules come before the rollout", () => {
    const f = flag({ key: "k", rollout: { percent: 0, salt: "s" }, rules: [{ conditions: [{ attr: "staff", op: "eq", value: true }], value: true }] });
    expect(evaluate(f, { unitId: "u", staff: true })).toBe(true);
    expect(evaluate(f, { unitId: "u" })).toBe(false);
  });
});

describe("checks", () => {
  test("values against the flag type", () => {
    expect(flagValueError("boolean", true)).toBeNull();
    expect(flagValueError("boolean", "true")).toMatch(/expected a boolean/);
    expect(flagValueError("number", Number.NaN)).toMatch(/finite number/);
    expect(flagValueError("string", 1)).toMatch(/expected a string/);
    expect(flagValueError("json", null)).toBeNull();
  });
  test("rules", () => {
    expect(ruleError("boolean", { conditions: [{ attr: "a", op: "eq", value: 1 }], value: true })).toBeNull();
    expect(ruleError("boolean", { conditions: [], value: "yes" })).toMatch(/rule.value: expected a boolean/);
    expect(ruleError("string", { conditions: [{ attr: "a", op: "in", value: "x" }], value: "v" })).toMatch(/must be a list/);
    expect(ruleError("string", { conditions: [{ attr: "v", op: "semverGte", value: "latest" }], value: "v" })).toMatch(/is not a version/);
    expect(ruleError("string", { conditions: [{ attr: "", op: "eq", value: 1 }], value: "v" })).toMatch(/attr must be/);
  });
});
