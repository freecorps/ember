// `v.*` validators. Each is a frozen `{ shape, isOptional }` plus a `validate` helper; the TypeScript type
// (`Infer<V>`) and the dotted field paths of objects are phantom type parameters.

import type { FieldShape, LiteralValue, Shape } from "./shape.ts";
import { validate, type ValidateOptions, type ValidationResult } from "./validate.ts";

export type Optionality = "required" | "optional";

/** A document id: a string at runtime (`<prefix>_<ulid>`), tagged with its table at the type level. */
export type GenericId<TableName extends string> = string & { readonly __tableName: TableName };
/** A file reference (metadata row id; bytes live in R2). */
export type FileId = string & { readonly __file: true };

export interface Validator<T, Opt extends Optionality = "required", FieldPaths extends string = never> {
  readonly shape: Shape;
  readonly isOptional: Opt;
  /** Validates a runtime value against this validator. */
  validate(value: unknown, options?: ValidateOptions): ValidationResult;
  /** Phantom: never set at runtime. */
  readonly type?: T;
  /** Phantom: dotted paths into this value (objects only), for index field typing. */
  readonly fieldPaths?: FieldPaths;
}

export type GenericValidator = Validator<any, Optionality, any>;
export type Infer<V extends GenericValidator> = V extends Validator<infer T, any, any> ? T : never;
export type PropertyValidators = Record<string, GenericValidator>;

export type Expand<T> = T extends object ? (T extends infer O ? { [K in keyof O]: O[K] } : never) : T;

type RequiredKeys<F extends PropertyValidators> = {
  [K in keyof F]: F[K]["isOptional"] extends "optional" ? never : K;
}[keyof F];
type OptionalKeys<F extends PropertyValidators> = Exclude<keyof F, RequiredKeys<F>>;

export type ObjectType<F extends PropertyValidators> = Expand<
  { [K in RequiredKeys<F>]: Infer<F[K]> } & { [K in OptionalKeys<F>]?: Infer<F[K]> }
>;

/** "a" | "a.b" | ... for an object validator's fields (nested objects recurse, everything else is a leaf). */
export type ObjectFieldPaths<F extends PropertyValidators> = {
  [K in keyof F & string]: K | JoinPath<K, NonNullable<F[K]["fieldPaths"]>>;
}[keyof F & string];
type JoinPath<K extends string, P> = [P] extends [never] ? never : P extends string ? `${K}.${P}` : never;

export type ObjectValidator<F extends PropertyValidators> = Validator<ObjectType<F>, "required", ObjectFieldPaths<F>>;

function make<T, Opt extends Optionality = "required", P extends string = never>(
  shape: Shape,
  isOptional: Opt = "required" as Opt,
): Validator<T, Opt, P> {
  const self = {
    shape,
    isOptional,
    validate: (value: unknown, options?: ValidateOptions) =>
      isOptional === "optional" && value === undefined ? { ok: true as const } : validate(shape, value, options),
  };
  return Object.freeze(self) as Validator<T, Opt, P>;
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function objectShape(fields: PropertyValidators): Shape {
  const out: Record<string, FieldShape> = {};
  for (const [k, f] of Object.entries(fields)) {
    if (!FIELD_NAME.test(k)) throw new Error(`Invalid field name ${JSON.stringify(k)}: use [A-Za-z_][A-Za-z0-9_]*`);
    if (!f || typeof f !== "object" || !("shape" in f)) throw new Error(`Field ${k} is not a validator`);
    out[k] = { shape: f.shape, optional: f.isOptional === "optional" };
  }
  return { kind: "object", fields: out };
}

export const v = {
  string: () => make<string>({ kind: "string" }),
  /** IEEE-754 double. Alias: `v.float64()`. */
  number: () => make<number>({ kind: "number" }),
  float64: () => make<number>({ kind: "number" }),
  /** 64-bit signed integer, a `bigint` at runtime. */
  int64: () => make<bigint>({ kind: "int64" }),
  boolean: () => make<boolean>({ kind: "boolean" }),
  null: () => make<null>({ kind: "null" }),
  bytes: () => make<Uint8Array>({ kind: "bytes" }),
  file: () => make<FileId>({ kind: "file" }),
  any: () => make<any>({ kind: "any" }),
  id: <const TableName extends string>(table: TableName) => make<GenericId<TableName>>({ kind: "id", table }),
  literal: <const L extends LiteralValue>(value: L) =>
    make<L>({ kind: "literal", value: typeof value === "bigint" ? { $int64: value.toString() } : value }),
  array: <V extends GenericValidator>(item: V) => make<Infer<V>[]>({ kind: "array", item: item.shape }),
  record: <V extends GenericValidator>(value: V) =>
    make<Record<string, Infer<V>>>({ kind: "record", value: value.shape }),
  object: <F extends PropertyValidators>(fields: F) =>
    make<ObjectType<F>, "required", ObjectFieldPaths<F>>(objectShape(fields)),
  union: <const Vs extends GenericValidator[]>(...members: Vs) => {
    if (members.length === 0) throw new Error("v.union() needs at least one member");
    return make<Infer<Vs[number]>, "required", NonNullable<Vs[number]["fieldPaths"]>>({
      kind: "union",
      members: members.map((m) => m.shape),
    });
  },
  optional: <V extends GenericValidator>(inner: V) =>
    make<Infer<V>, "optional", NonNullable<V["fieldPaths"]>>(inner.shape, "optional"),
  /** Shorthand for `v.union(inner, v.null())`. */
  nullable: <V extends GenericValidator>(inner: V) =>
    make<Infer<V> | null, "required", NonNullable<V["fieldPaths"]>>({
      kind: "union",
      members: [inner.shape, { kind: "null" }],
    }),
};

/** Builds a validator from a Shape (e.g. one read back from a manifest). */
export function validatorFromShape(shape: Shape, optional = false): GenericValidator {
  return make<any, Optionality, any>(shape, optional ? "optional" : "required");
}

export function isValidator(x: unknown): x is GenericValidator {
  return typeof x === "object" && x !== null && "shape" in x && "isOptional" in x;
}
