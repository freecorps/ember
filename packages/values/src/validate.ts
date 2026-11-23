import { literalValue, type Checks, type Shape } from "./shape.ts";
import { fromJSONValue } from "./json.ts";

export type ValidationResult = { ok: true } | { ok: false; path: string; message: string };

export interface ValidateOptions {
  /** Resolves the table an id belongs to (undefined = not a valid id). Without it, ids are only checked as strings. */
  tableOfId?: (id: string) => string | undefined;
  /**
   * Ids `tableOfId` does not resolve but that are accepted anyway (any table): foreign ids (an import kept them as
   * they were) where the table-number map is not at hand, like the Worker or a client replica. The shard checks them.
   */
  acceptId?: (id: string) => boolean;
}

export const isPlainObject = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== "object" || x === null || Array.isArray(x) || x instanceof Uint8Array) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

/**
 * Validates `value` against `shape`. Returns the first problem with a path (`a.b[2]`), or `{ ok: true }`.
 * Object fields that are `undefined` count as absent (like Convex).
 */
/** The options of a call that passes none (shared: no allocation per call). */
const NO_OPTS: ValidateOptions = Object.freeze({});

export function validate(shape: Shape, value: unknown, options: ValidateOptions = NO_OPTS): ValidationResult {
  // The compiled predicate decides (no allocation on the valid path); only a failure walks the shape again to build
  // its path and message, so the result is the interpreter's exactly.
  if (compiled(shape)(value, options)) return OK;
  return check(shape, value, "", options) ?? OK;
}

/** The interpreter alone (the reference the compiled predicates are tested against). */
export function validateInterpreted(shape: Shape, value: unknown, options: ValidateOptions = NO_OPTS): ValidationResult {
  return check(shape, value, "", options) ?? OK;
}

/** The compiled predicate alone: valid or not, no issue (the tests check it agrees with the interpreter both ways). */
export function validateCompiled(shape: Shape, value: unknown, options: ValidateOptions = NO_OPTS): boolean {
  return compiled(shape)(value, options);
}

// ---------------------------------------------------------------------------------------------- compiled predicates
//
// `validate` runs on every argument, document write and `returns` check, re-runs of reactive queries included. The
// interpreter builds a path string per object field and array item even when everything is valid; a predicate
// compiled once per Shape (closures: Workers have no `new Function`) only answers valid / invalid.

type Pred = (value: unknown, options: ValidateOptions) => boolean;
const predicates = new WeakMap<Shape, Pred>();

function compiled(shape: Shape): Pred {
  let p = predicates.get(shape);
  if (!p) predicates.set(shape, (p = compile(shape)));
  return p;
}

const hasOwn = Object.prototype.hasOwnProperty;

/** Code points of `s` (what `[...s].length` counts), without the array. */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

function compile(shape: Shape): Pred {
  switch (shape.kind) {
    case "any":
      return (v) => valueOk(v);
    case "string": {
      const c = shape.checks;
      if (!c) return (v) => typeof v === "string";
      const min = c.minLength;
      const max = c.maxLength;
      const lengths = min !== undefined || max !== undefined;
      // The same tests as `checkString`, chosen once: the format's, and the pattern's RegExp (made on first use, as the
      // interpreter does, so a shape whose strings are never checked never compiles it).
      const format = formatTest(c.format);
      const pattern = c.pattern;
      let re: RegExp | undefined;
      return (v) => {
        if (typeof v !== "string") return false;
        if (lengths) {
          const n = codePoints(v);
          if ((min !== undefined && n < min) || (max !== undefined && n > max)) return false;
        }
        if (format && !format(v)) return false;
        if (pattern !== undefined) {
          re ??= patternOf(pattern, c.flags);
          re.lastIndex = 0;
          if (!re.test(v)) return false;
        }
        return true;
      };
    }
    case "file":
      return (v) => typeof v === "string";
    case "number": {
      const c = shape.checks;
      if (!c) return (v) => typeof v === "number";
      return (v) => typeof v === "number" && !(c.int && !Number.isInteger(v)) && !(c.min !== undefined && !(v >= c.min)) && !(c.max !== undefined && !(v <= c.max));
    }
    case "int64":
      return (v) => typeof v === "bigint" && v >= INT64_MIN && v <= INT64_MAX;
    case "boolean":
      return (v) => typeof v === "boolean";
    case "null":
      return (v) => v === null;
    case "bytes":
      return (v) => v instanceof Uint8Array;
    case "literal": {
      const lit = literalValue(shape);
      return (v) => v === lit || Object.is(v, lit);
    }
    case "id": {
      const table = shape.table;
      return (v, o) => {
        if (typeof v !== "string" || !o.tableOfId) return typeof v === "string";
        const t = o.tableOfId(v);
        return t === table || (t === undefined && !!o.acceptId?.(v));
      };
    }
    case "array": {
      const item = compiled(shape.item);
      const min = shape.checks?.minItems;
      const max = shape.checks?.maxItems;
      return (v, o) => {
        if (!Array.isArray(v)) return false;
        if ((min !== undefined && v.length < min) || (max !== undefined && v.length > max)) return false;
        for (let i = 0; i < v.length; i++) if (!item(v[i], o)) return false;
        return true;
      };
    }
    case "record": {
      const value = compiled(shape.value);
      return (v, o) => {
        if (!isPlainObject(v)) return false;
        for (const k in v) {
          if (!hasOwn.call(v, k)) continue;
          const x = v[k];
          if (x === undefined) continue;
          if (k.startsWith("$") || !value(x, o)) return false;
        }
        return true;
      };
    }
    case "object": {
      const fields = shape.fields;
      const list = Object.entries(fields).map(([k, f]) => ({ k, optional: f.optional, pred: compiled(f.shape) }));
      // One pass over the value's own fields. Not for a field named like an Object.prototype member ("constructor"):
      // the two-pass form below reads it through the prototype when the value lacks it, as the interpreter does.
      if (!list.some((f) => f.k in Object.prototype)) {
        const byName = new Map(list.map((f) => [f.k, f]));
        let required = 0;
        for (const f of list) if (!f.optional) required++;
        return (v, o) => {
          if (!isPlainObject(v)) return false;
          let seen = 0;
          for (const k in v) {
            if (!hasOwn.call(v, k)) continue;
            const x = v[k];
            if (x === undefined) continue;
            const f = byName.get(k);
            if (f === undefined) {
              // Same test as the interpreter (`k in fields`).
              if (!(k in fields)) return false;
              continue;
            }
            if (!f.pred(x, o)) return false;
            if (!f.optional) seen++;
          }
          return seen === required;
        };
      }
      return (v, o) => {
        if (!isPlainObject(v)) return false;
        for (let i = 0; i < list.length; i++) {
          const f = list[i]!;
          const x = v[f.k];
          if (x === undefined) {
            if (!f.optional) return false;
          } else if (!f.pred(x, o)) return false;
        }
        // Same test as the interpreter (`k in fields`).
        for (const k in v) if (hasOwn.call(v, k) && !(k in fields) && v[k] !== undefined) return false;
        return true;
      };
    }
    case "union": {
      const members = shape.members.map(compiled);
      // Objects told apart by a literal field (`type: "a" | "b" | ...`): only the member with the value's literal can
      // match, so it alone is tried.
      const d = discriminant(shape.members);
      if (d) {
        const { field, byLiteral } = d;
        return (v, o) => {
          if (!isPlainObject(v)) return false;
          const m = byLiteral.get(v[field]);
          return m !== undefined && members[m]!(v, o);
        };
      }
      return (v, o) => {
        for (let i = 0; i < members.length; i++) if (members[i]!(v, o)) return true;
        return false;
      };
    }
  }
}

/**
 * A field every member of a union of objects requires as a literal, with a different literal per member (as Map
 * keys: SameValueZero, which agrees with the literal check `v === lit || Object.is(v, lit)`); undefined if none.
 */
function discriminant(members: readonly Shape[]): { field: string; byLiteral: Map<unknown, number> } | undefined {
  if (members.length < 2 || !members.every((m) => m.kind === "object")) return undefined;
  const objects = members as Array<Extract<Shape, { kind: "object" }>>;
  candidates: for (const field of Object.keys(objects[0]!.fields)) {
    if (field in Object.prototype) continue;
    const byLiteral = new Map<unknown, number>();
    for (let i = 0; i < objects.length; i++) {
      const f = hasOwn.call(objects[i]!.fields, field) ? objects[i]!.fields[field] : undefined;
      if (!f || f.optional || f.shape.kind !== "literal") continue candidates;
      const lit = literalValue(f.shape);
      if (byLiteral.has(lit)) continue candidates;
      byLiteral.set(lit, i);
    }
    return { field, byLiteral };
  }
  return undefined;
}

/** `checkValue(value) === undefined`, without paths. */
function valueOk(value: unknown): boolean {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "bigint":
      return value >= INT64_MIN && value <= INT64_MAX;
    case "object": {
      if (value === null || value instanceof Uint8Array) return true;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) if (value[i] === undefined || !valueOk(value[i])) return false;
        return true;
      }
      if (!isPlainObject(value)) return false;
      for (const k in value) {
        if (!hasOwn.call(value, k)) continue;
        const x = value[k];
        if (x === undefined) continue;
        if (k.startsWith("$") || !valueOk(x)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

const OK = Object.freeze({ ok: true as const });
type Issue = { ok: false; path: string; message: string };

const at = (path: string, message: string): Issue => ({ ok: false, path: path || "$", message });
const join = (path: string, k: string) => (path ? `${path}.${k}` : k);

function check(shape: Shape, value: unknown, path: string, options: ValidateOptions): Issue | undefined {
  switch (shape.kind) {
    case "any":
      return checkValue(value, path);
    case "string":
      return typeof value === "string" ? (shape.checks ? checkString(shape.checks, value, path) : undefined) : at(path, `Expected string, got ${describe(value)}`);
    case "file":
      return typeof value === "string" ? undefined : at(path, `Expected file id, got ${describe(value)}`);
    case "number":
      return typeof value === "number" ? (shape.checks ? checkNumber(shape.checks, value, path) : undefined) : at(path, `Expected number, got ${describe(value)}`);
    case "int64":
      if (typeof value !== "bigint") return at(path, `Expected bigint, got ${describe(value)}`);
      return value < INT64_MIN || value > INT64_MAX ? at(path, "int64 out of range") : undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : at(path, `Expected boolean, got ${describe(value)}`);
    case "null":
      return value === null ? undefined : at(path, `Expected null, got ${describe(value)}`);
    case "bytes":
      return value instanceof Uint8Array ? undefined : at(path, `Expected bytes (Uint8Array), got ${describe(value)}`);
    case "literal": {
      const lit = literalValue(shape);
      return value === lit || Object.is(value, lit)
        ? undefined
        : at(path, `Expected ${typeof lit === "bigint" ? `${lit}n` : JSON.stringify(lit)}, got ${describe(value)}`);
    }
    case "id": {
      if (typeof value !== "string") return at(path, `Expected Id<"${shape.table}">, got ${describe(value)}`);
      if (options.tableOfId) {
        const table = options.tableOfId(value);
        if (table !== shape.table && !(table === undefined && options.acceptId?.(value))) return at(path, `Expected Id<"${shape.table}">, got an id of ${table ?? "no table"}`);
      }
      return undefined;
    }
    case "array": {
      if (!Array.isArray(value)) return at(path, `Expected array, got ${describe(value)}`);
      if (shape.checks?.minItems !== undefined && value.length < shape.checks.minItems) return at(path, `Expected at least ${shape.checks.minItems} items, got ${value.length}`);
      if (shape.checks?.maxItems !== undefined && value.length > shape.checks.maxItems) return at(path, `Expected at most ${shape.checks.maxItems} items, got ${value.length}`);
      for (let i = 0; i < value.length; i++) {
        const r = check(shape.item, value[i], `${path}[${i}]`, options);
        if (r) return r;
      }
      return undefined;
    }
    case "record": {
      if (!isPlainObject(value)) return at(path, `Expected object, got ${describe(value)}`);
      for (const [k, item] of Object.entries(value)) {
        if (item === undefined) continue;
        const bad = checkKey(k, join(path, k));
        if (bad) return bad;
        const r = check(shape.value, item, join(path, k), options);
        if (r) return r;
      }
      return undefined;
    }
    case "object": {
      if (!isPlainObject(value)) return at(path, `Expected object, got ${describe(value)}`);
      for (const [k, f] of Object.entries(shape.fields)) {
        const item = value[k];
        if (item === undefined) {
          if (!f.optional) return at(join(path, k), "Missing required field");
        } else {
          const r = check(f.shape, item, join(path, k), options);
          if (r) return r;
        }
      }
      for (const k of Object.keys(value)) {
        if (!(k in shape.fields) && value[k] !== undefined) return at(join(path, k), "Unexpected field");
      }
      return undefined;
    }
    case "union": {
      let deepest: Issue | undefined;
      for (const m of shape.members) {
        const r = check(m, value, path, options);
        if (!r) return undefined;
        if (!deepest || r.path.length > deepest.path.length) deepest = r;
      }
      // Report the member that got furthest (most useful for unions of objects); fall back to a generic message.
      return deepest && deepest.path !== (path || "$") ? deepest : at(path, `Value matches no member of the union (${describe(value)})`);
    }
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const patterns = new Map<string, RegExp>();

function patternOf(pattern: string, flags: string | undefined): RegExp {
  const key = `${flags ?? ""}/${pattern}`;
  let re = patterns.get(key);
  if (!re) patterns.set(key, (re = new RegExp(pattern, flags)));
  return re;
}

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** The test of a `format` (what `checkString` accepts), or undefined when it has none. */
function formatTest(format: Checks["format"]): ((value: string) => boolean) | undefined {
  switch (format) {
    case "email":
      return (v) => EMAIL.test(v);
    case "uuid":
      return (v) => UUID.test(v);
    case "url":
      return isHttpUrl;
    default:
      return undefined;
  }
}

function checkString(c: Checks, value: string, path: string): Issue | undefined {
  if (c.minLength !== undefined || c.maxLength !== undefined) {
    // Code points (`[...value].length`), counted without the array.
    const n = codePoints(value);
    if (c.minLength !== undefined && n < c.minLength) return at(path, c.minLength === 1 ? "Must not be empty" : `Expected at least ${c.minLength} characters, got ${n}`);
    if (c.maxLength !== undefined && n > c.maxLength) return at(path, `Expected at most ${c.maxLength} characters, got ${n}`);
  }
  if (c.format === "email" && !EMAIL.test(value)) return at(path, "Expected an email address");
  if (c.format === "uuid" && !UUID.test(value)) return at(path, "Expected a UUID");
  if (c.format === "url") {
    try {
      const u = new URL(value);
      if (u.protocol !== "http:" && u.protocol !== "https:") return at(path, "Expected an http(s) URL");
    } catch {
      return at(path, "Expected a URL");
    }
  }
  if (c.pattern !== undefined) {
    const re = patternOf(c.pattern, c.flags);
    re.lastIndex = 0;
    if (!re.test(value)) return at(path, `Expected to match /${c.pattern}/${c.flags ?? ""}`);
  }
  return undefined;
}

function checkNumber(c: Checks, value: number, path: string): Issue | undefined {
  if (c.int && !Number.isInteger(value)) return at(path, `Expected an integer, got ${value}`);
  if (c.min !== undefined && !(value >= c.min)) return at(path, `Expected at least ${c.min}, got ${value}`);
  if (c.max !== undefined && !(value <= c.max)) return at(path, `Expected at most ${c.max}, got ${value}`);
  return undefined;
}

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

function checkKey(k: string, path: string): Issue | undefined {
  if (k.startsWith("$")) return at(path, "Field names may not start with '$'");
  return undefined;
}

/** Whether `value` is any Ember value (for v.any()). */
function checkValue(value: unknown, path: string): Issue | undefined {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return undefined;
    case "bigint":
      return value < INT64_MIN || value > INT64_MAX ? at(path, "int64 out of range") : undefined;
    case "object": {
      if (value === null || value instanceof Uint8Array) return undefined;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          if (value[i] === undefined) return at(`${path}[${i}]`, "undefined is not allowed in arrays");
          const r = checkValue(value[i], `${path}[${i}]`);
          if (r) return r;
        }
        return undefined;
      }
      if (!isPlainObject(value)) return at(path, `Unsupported value ${describe(value)}`);
      for (const [k, x] of Object.entries(value)) {
        if (x === undefined) continue;
        const bad = checkKey(k, join(path, k)) ?? checkValue(x, join(path, k));
        if (bad) return bad;
      }
      return undefined;
    }
    default:
      return at(path, `Unsupported value ${describe(value)}`);
  }
}

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (value instanceof Uint8Array) return "bytes";
  if (typeof value === "object") return isPlainObject(value) ? "object" : (value.constructor?.name ?? "object");
  return typeof value;
}

/**
 * `value` with the defaults of `shape` filled in (object fields with a `default` that are absent), recursively through
 * objects, array items, record values and unions (the defaults of the first member the value matches). Returns `value` itself when nothing is missing. Function arguments only (validate after).
 */
export function withDefaults(shape: Shape, value: unknown): unknown {
  // Most shapes have no default anywhere: nothing to walk (memoized per shape).
  if (!hasDefaultsMemo(shape)) return value;
  switch (shape.kind) {
    case "object": {
      if (!isPlainObject(value)) return value;
      let out: Record<string, unknown> | null = null;
      for (const [k, f] of Object.entries(shape.fields)) {
        const cur = value[k];
        const next = cur === undefined ? (f.default !== undefined ? fromJSONValue(f.default) : cur) : withDefaults(f.shape, cur);
        if (next !== cur) (out ??= { ...value })[k] = next;
      }
      return out ?? value;
    }
    case "array": {
      if (!Array.isArray(value)) return value;
      let out: unknown[] | null = null;
      value.forEach((x, i) => {
        const next = withDefaults(shape.item, x);
        if (next !== x) (out ??= [...value])[i] = next;
      });
      return out ?? value;
    }
    case "record": {
      if (!isPlainObject(value)) return value;
      let out: Record<string, unknown> | null = null;
      for (const [k, x] of Object.entries(value)) {
        const next = withDefaults(shape.value, x);
        if (next !== x) (out ??= { ...value })[k] = next;
      }
      return out ?? value;
    }
    case "union": {
      if (!shape.members.some(hasDefaults)) return value;
      const m = shape.members.find((x) => validate(x, value).ok); // an absent defaulted field still validates
      return m ? withDefaults(m, value) : value;
    }
    default:
      return value;
  }
}

const defaultsOf = new WeakMap<Shape, boolean>();
function hasDefaultsMemo(shape: Shape): boolean {
  let v = defaultsOf.get(shape);
  if (v === undefined) defaultsOf.set(shape, (v = hasDefaults(shape)));
  return v;
}

/** Whether a shape uses `default` anywhere (schemas refuse them: defaults are for function arguments). */
export function hasDefaults(shape: Shape): boolean {
  switch (shape.kind) {
    case "object":
      return Object.values(shape.fields).some((f) => f.default !== undefined || hasDefaults(f.shape));
    case "array":
      return hasDefaults(shape.item);
    case "record":
      return hasDefaults(shape.value);
    case "union":
      return shape.members.some(hasDefaults);
    default:
      return false;
  }
}
