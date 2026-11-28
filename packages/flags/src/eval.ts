// `@freecorps/ember-flags/eval`: the flag evaluator, pure and deterministic, with no import at all. The same function
// runs inside a shard's queries and mutations (over the `.replicated()` copy of the flags), in a browser or React
// Native app over a snapshot, and in tests. No clock, no randomness: the rollout bucket is a hash of
// `salt.key.unitId`, so a unit lands in the same bucket everywhere, every time.
//
//   evaluate(flag, { unitId: user._id, plan: "pro", appVersion: "2.4.1" })
//     1. missing flag      → the caller's default (`evaluateAll` skips it)
//     2. disabled          → defaultValue
//     3. first rule whose conditions all match → that rule's value
//     4. rollout           → `value` inside the rollout (bucket < percent), defaultValue outside (or without unitId)
//     5. otherwise         → `value`
//   `value` is the flag's "on" value: `true` for a boolean flag unless set, `defaultValue` for the other types.

/** The type of a flag's values. `json`: any JSON value (objects, arrays, strings, numbers, booleans, null). */
export type FlagType = "boolean" | "string" | "number" | "json";

/** A value of a flag of type `T`. */
export type FlagValueOf<T extends FlagType> = T extends "boolean" ? boolean : T extends "string" ? string : T extends "number" ? number : unknown;

/** One attribute of the evaluation context. Arrays match a condition when any element does (`roles: ["admin"]`). */
export type FlagAttribute = string | number | boolean | null | ReadonlyArray<string | number>;

/**
 * What a flag is evaluated for. `unitId` is the rollout unit (a user, an org, a device): without it the unit is outside
 * every rollout. Other attributes are matched by the rules (`plan`, `country`, `appVersion`, `email`).
 */
export type FlagContext = { readonly unitId?: string } & { readonly [attribute: string]: FlagAttribute | undefined };

export type ConditionOp = "eq" | "neq" | "in" | "notIn" | "startsWith" | "semverGte" | "semverLt";
export const CONDITION_OPS: readonly ConditionOp[] = ["eq", "neq", "in", "notIn", "startsWith", "semverGte", "semverLt"];

/** A scalar a condition compares with. */
export type ConditionScalar = string | number | boolean | null;

/**
 * One condition of a rule. `in`/`notIn` take a list; `eq`/`neq` a scalar; `startsWith` a string prefix; `semverGte`
 * and `semverLt` a `major.minor.patch[-prerelease]` version (an attribute that does not parse never matches). The
 * shape is checked when a rule is written (`ruleError`); a malformed condition never matches.
 *
 * Negative operators (`neq`, `notIn`) are the negation of the positive ones: a missing attribute, or an empty array,
 * satisfies them (a unit with no `plan` is not on `"free"`; `roles: []` has no `"admin"`). Add an `in`/`eq` condition
 * on the attribute too when it must be present.
 */
export type FlagCondition = { attr: string; op: ConditionOp; value: ConditionScalar | ConditionScalar[] };

/** A targeting rule: every condition must match (an empty list matches everyone); the first matching rule wins. */
export type FlagRule = { id?: string; description?: string; conditions: FlagCondition[]; value: unknown };

/** A percentage rollout: units whose bucket (0–9999) is below `percent × 100` get the flag's `value`. */
export type FlagRollout = { percent: number; salt: string };

/** A flag as stored (and replicated): what the evaluator needs, plus bookkeeping it ignores. */
export interface FlagDefinition {
  key: string;
  type: FlagType;
  /** Served when the flag is disabled and to units nothing targets (no rule matched, outside the rollout). */
  defaultValue: unknown;
  /** The "on" value (absent: `true` for a boolean flag, `defaultValue` otherwise). */
  value?: unknown;
  enabled: boolean;
  rules: FlagRule[];
  rollout?: FlagRollout;
  /** Returned by `forClient` (the flags a client may see). */
  clientVisible?: boolean;
  description?: string;
  updatedAt?: number;
  version?: number;
}

export type EvaluationReason = "missing" | "disabled" | "rule" | "rollout" | "outOfRollout" | "on";

export interface Evaluation<V = unknown> {
  value: V;
  reason: EvaluationReason;
  /** Index of the rule that matched (`reason: "rule"`). */
  rule?: number;
  /** The flag's version (`updatedAt`'s counter), when it exists. */
  version?: number;
}

/** The flag's "on" value: `value`, else `true` for a boolean flag, else `defaultValue`. */
export function onValue(flag: Pick<FlagDefinition, "type" | "value" | "defaultValue">): unknown {
  if (flag.value !== undefined) return flag.value;
  return flag.type === "boolean" ? true : flag.defaultValue;
}

/** Evaluates `flag` for `context`, with the reason. A missing flag (`null`/`undefined`) gives `fallback`. */
export function evaluateDetail<V = unknown>(flag: FlagDefinition | null | undefined, context: FlagContext = {}, fallback?: V): Evaluation<V> {
  if (!flag) return { value: fallback as V, reason: "missing" };
  const version = flag.version !== undefined ? { version: flag.version } : {};
  if (!flag.enabled) return { value: flag.defaultValue as V, reason: "disabled", ...version };
  for (let i = 0; i < flag.rules.length; i++) {
    const r = flag.rules[i]!;
    if (r.conditions.every((c) => matches(c, context[c.attr]))) return { value: r.value as V, reason: "rule", rule: i, ...version };
  }
  if (flag.rollout) {
    const unit = context.unitId;
    const inside = typeof unit === "string" && rolloutBucket(flag.rollout.salt, flag.key, unit) < percentToBuckets(flag.rollout.percent);
    return inside ? { value: onValue(flag) as V, reason: "rollout", ...version } : { value: flag.defaultValue as V, reason: "outOfRollout", ...version };
  }
  return { value: onValue(flag) as V, reason: "on", ...version };
}

/** The value of `flag` for `context` (`fallback` when the flag does not exist). */
export function evaluate<V = unknown>(flag: FlagDefinition | null | undefined, context: FlagContext = {}, fallback?: V): V {
  return evaluateDetail(flag, context, fallback).value;
}

/** Every flag of `flags` for `context`, by key. */
export function evaluateAll(flags: Iterable<FlagDefinition>, context: FlagContext = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of flags) out[f.key] = evaluate(f, context);
  return out;
}

// ------------------------------------------------------------------------------------------------ conditions

function matches(c: FlagCondition, attr: FlagAttribute | undefined): boolean {
  if (Array.isArray(attr)) {
    // Negative operators hold when no element matches the positive one (an empty array: none does). A malformed
    // operand (`neq` with a list, `notIn` with a scalar) never matches: its positive form would never match either.
    if (c.op === "neq") return !Array.isArray(c.value) && !attr.some((a) => matchScalar({ ...c, op: "eq" }, a));
    if (c.op === "notIn") return Array.isArray(c.value) && !attr.some((a) => matchScalar({ ...c, op: "in" }, a));
    return attr.some((a) => matchScalar(c, a));
  }
  return matchScalar(c, attr as ConditionScalar | undefined);
}

function matchScalar(c: FlagCondition, a: ConditionScalar | undefined): boolean {
  const list = Array.isArray(c.value) ? c.value : null;
  const one = Array.isArray(c.value) ? undefined : c.value;
  switch (c.op) {
    case "eq":
      return a !== undefined && !list && a === one;
    case "neq":
      return !list && a !== one;
    case "in":
      return a !== undefined && !!list && list.includes(a);
    case "notIn":
      return !!list && (a === undefined || !list.includes(a));
    case "startsWith":
      return typeof a === "string" && typeof one === "string" && a.startsWith(one);
    case "semverGte":
    case "semverLt": {
      const cmp = typeof a === "string" && typeof one === "string" ? compareSemver(a, one) : null;
      return cmp !== null && (c.op === "semverGte" ? cmp >= 0 : cmp < 0);
    }
    default:
      return false;
  }
}

const SEMVER = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Compares two versions (`1.2.3`, `1.2`, `v2`, `1.0.0-beta.2`): -1, 0, 1, or null when one does not parse. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const x = SEMVER.exec(a.trim());
  const y = SEMVER.exec(b.trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const p = Number(x[i] ?? 0);
    const q = Number(y[i] ?? 0);
    if (p !== q) return p < q ? -1 : 1;
  }
  const pa = x[4];
  const pb = y[4];
  if (pa === pb) return 0;
  if (pa === undefined) return 1; // a release sorts after its prereleases
  if (pb === undefined) return -1;
  const sa = pa.split(".");
  const sb = pb.split(".");
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const u = sa[i];
    const w = sb[i];
    if (u === undefined) return -1;
    if (w === undefined) return 1;
    const nu = /^\d+$/.test(u);
    const nw = /^\d+$/.test(w);
    if (nu && nw) {
      if (Number(u) !== Number(w)) return Number(u) < Number(w) ? -1 : 1;
    } else if (nu !== nw) return nu ? -1 : 1;
    else if (u !== w) return u < w ? -1 : 1;
  }
  return 0;
}

// ------------------------------------------------------------------------------------------------ rollout

/** Number of rollout buckets: a percent has two decimals of resolution. */
export const ROLLOUT_BUCKETS = 10_000;

const percentToBuckets = (percent: number): number => Math.round(Math.min(100, Math.max(0, percent)) * (ROLLOUT_BUCKETS / 100));

/**
 * The 32-bit hash of the rollout: FNV-1a over the string's UTF-16 code units, then murmur3's finalizer (so close
 * inputs spread over all bits). Same result in every JS runtime.
 */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193);
    h = Math.imul(h ^ (c >>> 8), 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The unit's bucket (0–9999) in a flag's rollout: `hash32(salt + "." + key + "." + unitId) % 10000`. */
export function rolloutBucket(salt: string, key: string, unitId: string): number {
  return hash32(`${salt}.${key}.${unitId}`) % ROLLOUT_BUCKETS;
}

// ------------------------------------------------------------------------------------------------ checks

/** Why `value` is not a value of a `type` flag, or null when it is. */
export function flagValueError(type: FlagType, value: unknown): string | null {
  switch (type) {
    case "boolean":
      return typeof value === "boolean" ? null : `expected a boolean, got ${describe(value)}`;
    case "string":
      return typeof value === "string" ? null : `expected a string, got ${describe(value)}`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `expected a finite number, got ${describe(value)}`;
    case "json":
      return value === undefined ? "expected a JSON value, got undefined" : jsonError(value, "");
    default:
      return `unknown flag type ${JSON.stringify(type)}`;
  }
}

/** Why the rule is malformed (path-prefixed), or null. Values are checked against the flag's type. */
export function ruleError(type: FlagType, rule: FlagRule, at = "rule"): string | null {
  if (!rule || typeof rule !== "object" || !Array.isArray(rule.conditions)) return `${at}: expected { conditions: [...], value }`;
  for (const [i, c] of rule.conditions.entries()) {
    const p = `${at}.conditions[${i}]`;
    if (!c || typeof c.attr !== "string" || !c.attr) return `${p}.attr must be a non-empty string`;
    if (!CONDITION_OPS.includes(c.op)) return `${p}.op must be one of ${CONDITION_OPS.join(", ")}`;
    if (c.op === "in" || c.op === "notIn") {
      if (!Array.isArray(c.value)) return `${p}.value must be a list for ${c.op}`;
    } else if (c.op === "startsWith" || c.op === "semverGte" || c.op === "semverLt") {
      if (typeof c.value !== "string") return `${p}.value must be a string for ${c.op}`;
      if (c.op !== "startsWith" && compareSemver(c.value, c.value) === null) return `${p}.value ${JSON.stringify(c.value)} is not a version`;
    } else if (Array.isArray(c.value) || (c.value !== null && !["string", "number", "boolean"].includes(typeof c.value))) return `${p}.value must be a string, number, boolean or null for ${c.op}`;
  }
  const v = flagValueError(type, rule.value);
  return v ? `${at}.value: ${v}` : null;
}

/**
 * Why `x` is not plain JSON (`JSON.stringify` would throw on it or change it), or null: null, booleans, strings,
 * finite numbers, arrays and plain objects of them. A `bigint`, bytes, a non-finite number are refused.
 */
function jsonError(x: unknown, at: string, depth = 0): string | null {
  const where = at ? ` at ${at}` : "";
  if (depth > 64) return `expected a JSON value nested at most 64 deep${where}`;
  if (x === null || typeof x === "boolean" || typeof x === "string") return null;
  if (typeof x === "number") return Number.isFinite(x) ? null : `expected a JSON value, got ${x}${where}`;
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) {
      const e = jsonError(x[i], `${at}[${i}]`, depth + 1);
      if (e) return e;
    }
    return null;
  }
  if (typeof x === "object") {
    const proto = Object.getPrototypeOf(x);
    if (proto !== Object.prototype && proto !== null) return `expected a JSON value, got ${describe(x)}${where}`;
    for (const [k, v] of Object.entries(x)) {
      if (v === undefined) continue; // dropped by JSON.stringify, as by the engine
      const e = jsonError(v, at ? `${at}.${k}` : k, depth + 1);
      if (e) return e;
    }
    return null;
  }
  return `expected a JSON value, got ${describe(x)}${where}`;
}

function describe(x: unknown): string {
  if (x === null) return "null";
  if (Array.isArray(x)) return "an array";
  if (typeof x === "object") return x instanceof ArrayBuffer || ArrayBuffer.isView(x) ? "bytes" : "an object";
  if (typeof x === "string") return `string ${JSON.stringify(x)}`;
  if (typeof x === "bigint") return `bigint ${x}n`;
  return typeof x === "number" || typeof x === "boolean" ? `${typeof x} ${String(x)}` : typeof x;
}
