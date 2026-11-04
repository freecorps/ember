import { literalValue, type Shape } from "./shape.ts";

export type ValidationResult = { ok: true } | { ok: false; path: string; message: string };

export interface ValidateOptions {
  /** Resolves the table an id belongs to (undefined = not a valid id). Without it, ids are only checked as strings. */
  tableOfId?: (id: string) => string | undefined;
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
export function validate(shape: Shape, value: unknown, options: ValidateOptions = {}): ValidationResult {
  const issue = check(shape, value, "", options);
  return issue ?? OK;
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
      return typeof value === "string" ? undefined : at(path, `Expected string, got ${describe(value)}`);
    case "file":
      return typeof value === "string" ? undefined : at(path, `Expected file id, got ${describe(value)}`);
    case "number":
      return typeof value === "number" ? undefined : at(path, `Expected number, got ${describe(value)}`);
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
        if (table !== shape.table) return at(path, `Expected Id<"${shape.table}">, got an id of ${table ?? "no table"}`);
      }
      return undefined;
    }
    case "array": {
      if (!Array.isArray(value)) return at(path, `Expected array, got ${describe(value)}`);
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
