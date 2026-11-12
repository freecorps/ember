// `v.*` validators. Each is a frozen `{ shape, isOptional }` plus a `validate` helper; the TypeScript type
// (`Infer<V>`) and the dotted field paths of objects are phantom type parameters.

import type { Checks, FieldShape, LiteralValue, Shape } from "./shape.ts";
import { validate, type ValidateOptions, type ValidationResult } from "./validate.ts";
import { toJSONValue } from "./json.ts";

export type Optionality = "required" | "optional";

/** A document id: a string at runtime (`<prefix>_<ulid>`), tagged with its table at the type level. */
export type GenericId<TableName extends string> = string & { readonly __tableName: TableName };
/** A file reference (metadata row id; bytes live in R2). */
export type FileId = string & { readonly __file: true };

/** The Standard Schema v1 interface (https://standardschema.dev): `v.*` validators plug into form libraries as is. */
export interface StandardSchemaV1<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "ember";
    validate(value: unknown): { readonly value: T; readonly issues?: undefined } | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey> }> };
    readonly types?: { readonly input: T; readonly output: T };
  };
}

export interface Validator<T, Opt extends Optionality = "required", FieldPaths extends string = never, D extends boolean = false> extends StandardSchemaV1<T> {
  readonly shape: Shape;
  readonly isOptional: Opt;
  /** Validates a runtime value against this validator. */
  validate(value: unknown, options?: ValidateOptions): ValidationResult;
  /** Shown in the generated types (JSDoc of the field) and in JSON Schema / OpenAPI. */
  readonly description?: string;
  /** `.default(value)`: the value (JSON with tags) an absent argument takes. */
  readonly defaultValue?: unknown;
  /** A copy with a description. */
  describe(text: string): this;
  /**
   * Function arguments: the value the handler gets when the caller leaves the field out (optional for callers,
   * always set in the handler). Not allowed in table schemas.
   */
  default(value: T): Validator<T, "optional", FieldPaths, true>;
  /** Phantom: never set at runtime. */
  readonly type?: T;
  /** Phantom: dotted paths into this value (objects only), for index field typing. */
  readonly fieldPaths?: FieldPaths;
  /** Phantom: has a default. */
  readonly __default?: D;
}

/** `v.string()`: refinements chain (`v.string().min(1).max(200).email()`). */
export interface StringValidator<T extends string = string> extends Validator<T> {
  /** At least `n` characters (code points). */
  min(n: number): this;
  /** At most `n` characters (code points). */
  max(n: number): this;
  /** Not empty (`min(1)`). */
  nonempty(): this;
  email(): this;
  /** An http(s) URL. */
  url(): this;
  uuid(): this;
  /** Matches the regular expression (its source and flags are kept: no closures). */
  regex(re: RegExp): this;
}
/** `v.number()`: `int()`, `min()`, `max()` (inclusive). */
export interface NumberValidator extends Validator<number> {
  int(): this;
  min(n: number): this;
  max(n: number): this;
  /** `> 0`. */
  positive(): this;
  /** `>= 0`. */
  nonnegative(): this;
}
/** `v.array(item)`: `min()`, `max()` items. */
export interface ArrayValidator<T> extends Validator<T[]> {
  min(n: number): this;
  max(n: number): this;
  nonempty(): this;
}

export type GenericValidator = Validator<any, Optionality, any, boolean>;
export type Infer<V extends GenericValidator> = V extends Validator<infer T, any, any, any> ? T : never;
export type PropertyValidators = Record<string, GenericValidator>;

export type Expand<T> = T extends object ? (T extends infer O ? { [K in keyof O]: O[K] } : never) : T;

/** Required in the value a handler sees: not optional, or optional with a default. */
type RequiredKeys<F extends PropertyValidators> = {
  [K in keyof F]: F[K]["isOptional"] extends "optional" ? (NonNullable<F[K]["__default"]> extends true ? K : never) : K;
}[keyof F];
type OptionalKeys<F extends PropertyValidators> = Exclude<keyof F, RequiredKeys<F>>;
/** Required for callers: not optional (a default makes it optional). */
type InputRequiredKeys<F extends PropertyValidators> = { [K in keyof F]: F[K]["isOptional"] extends "optional" ? never : K }[keyof F];

/** The value (what a handler gets: defaults filled in). */
export type ObjectType<F extends PropertyValidators> = Expand<
  { [K in RequiredKeys<F>]: Infer<F[K]> } & { [K in OptionalKeys<F>]?: Infer<F[K]> }
>;
/** What callers pass (fields with a default are optional). */
export type ObjectInputType<F extends PropertyValidators> = Expand<
  { [K in InputRequiredKeys<F>]: Infer<F[K]> } & { [K in Exclude<keyof F, InputRequiredKeys<F>>]?: Infer<F[K]> }
>;

/** "a" | "a.b" | ... for an object validator's fields (nested objects recurse, everything else is a leaf). */
export type ObjectFieldPaths<F extends PropertyValidators> = {
  [K in keyof F & string]: K | JoinPath<K, NonNullable<F[K]["fieldPaths"]>>;
}[keyof F & string];
type JoinPath<K extends string, P> = [P] extends [never] ? never : P extends string ? `${K}.${P}` : never;

/** `v.object(fields)`: a validator plus its `fields` and the composition helpers (each returns a new validator). */
export interface ObjectValidator<F extends PropertyValidators> extends Validator<ObjectType<F>, "required", ObjectFieldPaths<F>> {
  readonly fields: F;
  /** Only the given fields. */
  pick<const K extends keyof F & string>(...keys: K[]): ObjectValidator<Expand<Pick<F, K>>>;
  /** Every field but the given ones. */
  omit<const K extends keyof F & string>(...keys: K[]): ObjectValidator<Expand<Omit<F, K>>>;
  /** Every field optional. */
  partial(): ObjectValidator<{ [K in keyof F]: OptionalOf<F[K]> }>;
  /** These fields added (or replaced). */
  extend<const G extends PropertyValidators>(fields: G): ObjectValidator<Expand<Omit<F, keyof G> & G>>;
}
type OptionalOf<V extends GenericValidator> = V extends Validator<infer T, any, infer P, any> ? Validator<T, "optional", P> : never;

type Meta = { description?: string; defaultValue?: unknown };

/** Standard Schema paths: `a.b[2]` → ["a", "b", 2]. */
const pathSegments = (path: string): PropertyKey[] =>
  path === "$" || path === ""
    ? []
    : path
        .split(/\.|\[(\d+)\]/)
        .filter((x) => x !== undefined && x !== "")
        .map((x) => (/^\d+$/.test(x) ? Number(x) : x));

function make<T, Opt extends Optionality = "required", P extends string = never>(shape: Shape, isOptional: Opt = "required" as Opt, meta: Meta = {}): Validator<T, Opt, P> {
  const check = (value: unknown, options?: ValidateOptions): ValidationResult =>
    isOptional === "optional" && value === undefined ? { ok: true as const } : validate(shape, value, options);
  const self: Record<string, unknown> = {
    shape,
    isOptional,
    validate: check,
    describe: (text: string) => make(shape, isOptional, { ...meta, description: text }),
    default: (value: unknown) => {
      const r = validate(shape, value);
      if (!r.ok) throw new Error(`.default(): the default is invalid${r.path !== "$" ? ` at ${r.path}` : ""}: ${r.message}`);
      return make(shape, "optional", { ...meta, defaultValue: toJSONValue(value) });
    },
    "~standard": Object.freeze({
      version: 1,
      vendor: "ember",
      validate: (value: unknown) => {
        const r = check(value);
        return r.ok ? { value } : { issues: [{ message: r.message, path: pathSegments(r.path) }] };
      },
    }),
  };
  if (meta.description !== undefined) self.description = meta.description;
  if (meta.defaultValue !== undefined) self.defaultValue = meta.defaultValue;
  // Refinements of strings, numbers and arrays: each returns a new validator with one more check.
  if (shape.kind === "string" || shape.kind === "number" || shape.kind === "array") {
    const refine = (c: Checks) => make(withChecks(shape, c), isOptional, meta);
    const n = (name: string, x: unknown) => {
      if (typeof x !== "number" || !Number.isFinite(x) || (shape.kind !== "number" && (x < 0 || !Number.isInteger(x)))) throw new Error(`.${name}(): expected a ${shape.kind === "number" ? "finite number" : "non-negative integer"}`);
      return x;
    };
    if (shape.kind === "string") {
      Object.assign(self, {
        min: (x: number) => refine({ minLength: n("min", x) }),
        max: (x: number) => refine({ maxLength: n("max", x) }),
        nonempty: () => refine({ minLength: 1 }),
        email: () => refine({ format: "email" }),
        url: () => refine({ format: "url" }),
        uuid: () => refine({ format: "uuid" }),
        regex: (re: RegExp) => {
          if (!(re instanceof RegExp)) throw new Error(".regex(): expected a RegExp");
          return refine({ pattern: re.source, ...(re.flags ? { flags: re.flags.replace("g", "") } : {}) });
        },
      });
    } else if (shape.kind === "number") {
      Object.assign(self, {
        int: () => refine({ int: true }),
        min: (x: number) => refine({ min: n("min", x) }),
        max: (x: number) => refine({ max: n("max", x) }),
        positive: () => refine({ min: Number.MIN_VALUE }),
        nonnegative: () => refine({ min: 0 }),
      });
    } else {
      Object.assign(self, {
        min: (x: number) => refine({ minItems: n("min", x) }),
        max: (x: number) => refine({ maxItems: n("max", x) }),
        nonempty: () => refine({ minItems: 1 }),
      });
    }
  }
  return Object.freeze(self) as unknown as Validator<T, Opt, P>;
}

function withChecks(shape: Shape, c: Checks): Shape {
  const prev = (shape as { checks?: Checks }).checks ?? {};
  return { ...shape, checks: { ...prev, ...c } } as Shape;
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function objectShape(fields: PropertyValidators): Shape {
  const out: Record<string, FieldShape> = {};
  for (const [k, f] of Object.entries(fields)) {
    if (!FIELD_NAME.test(k)) throw new Error(`Invalid field name ${JSON.stringify(k)}: use [A-Za-z_][A-Za-z0-9_]*`);
    if (!f || typeof f !== "object" || !("shape" in f)) throw new Error(`Field ${k} is not a validator`);
    const field: FieldShape = { shape: f.shape, optional: f.isOptional === "optional" };
    if (f.defaultValue !== undefined) field.default = f.defaultValue;
    if (f.description !== undefined) field.description = f.description;
    out[k] = field;
  }
  return { kind: "object", fields: out };
}

export const v = {
  string: () => make<string>({ kind: "string" }) as StringValidator,
  /** IEEE-754 double. Alias: `v.float64()`. */
  number: () => make<number>({ kind: "number" }) as NumberValidator,
  float64: () => make<number>({ kind: "number" }) as NumberValidator,
  /** 64-bit signed integer, a `bigint` at runtime. */
  int64: () => make<bigint>({ kind: "int64" }),
  boolean: () => make<boolean>({ kind: "boolean" }),
  null: () => make<null>({ kind: "null" }),
  bytes: () => make<Uint8Array>({ kind: "bytes" }),
  file: () => make<FileId>({ kind: "file" }),
  /** Any value (`unknown` in TypeScript: narrow it before use). `v.unsafeAny()` types it as `any`. */
  any: () => make<unknown>({ kind: "any" }),
  /** Any value, typed `any` (no checking at all downstream). Prefer `v.any()`. */
  unsafeAny: () => make<any>({ kind: "any" }),
  id: <const TableName extends string>(table: TableName) => make<GenericId<TableName>>({ kind: "id", table }),
  literal: <const L extends LiteralValue>(value: L) =>
    make<L>({ kind: "literal", value: typeof value === "bigint" ? { $int64: value.toString() } : value }),
  array: <V extends GenericValidator>(item: V) => make<Infer<V>[]>({ kind: "array", item: item.shape }) as ArrayValidator<Infer<V>>,
  record: <V extends GenericValidator>(value: V) =>
    make<Record<string, Infer<V>>>({ kind: "record", value: value.shape }),
  object: <F extends PropertyValidators>(fields: F): ObjectValidator<F> => objectValidator(fields),
  union: <const Vs extends GenericValidator[]>(...members: Vs) => {
    if (members.length === 0) throw new Error("v.union() needs at least one member");
    return make<Infer<Vs[number]>, "required", NonNullable<Vs[number]["fieldPaths"]>>({
      kind: "union",
      members: members.map((m) => m.shape),
    });
  },
  optional: <V extends GenericValidator>(inner: V) =>
    make<Infer<V>, "optional", NonNullable<V["fieldPaths"]>>(inner.shape, "optional", inner.description !== undefined ? { description: inner.description } : {}),
  /** Shorthand for `v.union(inner, v.null())`. */
  nullable: <V extends GenericValidator>(inner: V) =>
    make<Infer<V> | null, "required", NonNullable<V["fieldPaths"]>>({
      kind: "union",
      members: [inner.shape, { kind: "null" }],
    }),
};

function objectValidator<F extends PropertyValidators>(fields: F): ObjectValidator<F> {
  const base = make<ObjectType<F>, "required", ObjectFieldPaths<F>>(objectShape(fields));
  const pick = (keys: string[], keep: boolean) => {
    for (const k of keys) if (!(k in fields)) throw new Error(`v.object(): no field ${JSON.stringify(k)}`);
    return objectValidator(Object.fromEntries(Object.entries(fields).filter(([k]) => keys.includes(k) === keep)) as PropertyValidators);
  };
  return Object.freeze({
    ...base,
    fields,
    pick: (...keys: string[]) => pick(keys, true),
    omit: (...keys: string[]) => pick(keys, false),
    partial: () =>
      objectValidator(Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.isOptional === "optional" ? f : v.optional(f)])) as PropertyValidators),
    extend: (more: PropertyValidators) => objectValidator({ ...fields, ...more }),
  }) as unknown as ObjectValidator<F>;
}

/** `args.paginationOpts` of a paginated query (what `usePaginatedQuery` sends): `{ numItems, cursor, endCursor? }`. */
export const paginationOptsValidator = v.object({
  numItems: v.number(),
  cursor: v.nullable(v.string()),
  endCursor: v.optional(v.nullable(v.string())),
});

/** What `.paginate()` returns, for a `returns:` validator. */
export function paginationResultValidator<V extends GenericValidator>(item: V) {
  return v.object({ page: v.array(item), isDone: v.boolean(), continueCursor: v.string() });
}

/** Builds a validator from a Shape (e.g. one read back from a manifest). */
export function validatorFromShape(shape: Shape, optional = false): GenericValidator {
  return make<any, Optionality, any>(shape, optional ? "optional" : "required");
}

export function isValidator(x: unknown): x is GenericValidator {
  return typeof x === "object" && x !== null && "shape" in x && "isOptional" in x;
}
