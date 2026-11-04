// `v` validators: each carries a runtime Shape (plain JSON data, used by the DDL compiler, codegen, wire
// validation and schema diffing) and phantom type parameters (used by TypeScript inference). Nothing is a
// closure, so a schema serialises to JSON and can be diffed / stored / shipped to the server verbatim.

export type Shape =
  | { kind: "string" }
  | { kind: "float64" }
  | { kind: "int64" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "any" }
  | { kind: "id"; table: string }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; item: Shape }
  | { kind: "record"; value: Shape }
  | { kind: "object"; fields: Record<string, FieldShape> }
  | { kind: "union"; members: Shape[] };

export type FieldShape = { shape: Shape; optional: boolean };

export type Optionality = "required" | "optional";

/** Branded id: a string at runtime, tagged with its table at the type level. */
export type GenericId<TableName extends string> = string & { __tableName: TableName };

export interface Validator<T, Opt extends Optionality = "required", FieldPaths extends string = never> {
  readonly shape: Shape;
  readonly isOptional: Opt;
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
  return Object.freeze({ shape, isOptional }) as Validator<T, Opt, P>;
}

export const v = {
  string: () => make<string>({ kind: "string" }),
  number: () => make<number>({ kind: "float64" }),
  float64: () => make<number>({ kind: "float64" }),
  int64: () => make<bigint>({ kind: "int64" }),
  boolean: () => make<boolean>({ kind: "boolean" }),
  null: () => make<null>({ kind: "null" }),
  any: () => make<any>({ kind: "any" }),
  id: <const TableName extends string>(table: TableName) =>
    make<GenericId<TableName>>({ kind: "id", table }),
  literal: <const L extends string | number | boolean>(value: L) => make<L>({ kind: "literal", value }),
  array: <V extends GenericValidator>(item: V) => make<Infer<V>[]>({ kind: "array", item: item.shape }),
  record: <V extends GenericValidator>(value: V) =>
    make<Record<string, Infer<V>>>({ kind: "record", value: value.shape }),
  object: <F extends PropertyValidators>(fields: F) =>
    make<ObjectType<F>, "required", ObjectFieldPaths<F>>({
      kind: "object",
      fields: Object.fromEntries(
        Object.entries(fields).map(([k, f]) => [k, { shape: f.shape, optional: f.isOptional === "optional" }]),
      ),
    }),
  union: <const Vs extends GenericValidator[]>(...members: Vs) =>
    make<Infer<Vs[number]>, "required", NonNullable<Vs[number]["fieldPaths"]>>({
      kind: "union",
      members: members.map((m) => m.shape),
    }),
  optional: <V extends GenericValidator>(inner: V) =>
    make<Infer<V>, "optional", NonNullable<V["fieldPaths"]>>(inner.shape, "optional"),
};

// ------------------------------------------------------------------------------------------------ runtime check

export type Issue = { path: string; message: string };

export type IdResolver = (id: string) => string | undefined; // id -> table name

/** Validates `value` against `shape`; returns issues (empty = valid). Ids are checked with `tableOfId`. */
export function validate(shape: Shape, value: unknown, tableOfId?: IdResolver, path = ""): Issue[] {
  const bad = (message: string): Issue[] => [{ path: path || "(root)", message }];
  switch (shape.kind) {
    case "any":
      return [];
    case "string":
      return typeof value === "string" ? [] : bad("Expected string");
    case "float64":
      return typeof value === "number" ? [] : bad("Expected number");
    case "int64":
      return typeof value === "bigint" ? [] : bad("Expected bigint");
    case "boolean":
      return typeof value === "boolean" ? [] : bad("Expected boolean");
    case "null":
      return value === null ? [] : bad("Expected null");
    case "literal":
      return value === shape.value ? [] : bad(`Expected ${JSON.stringify(shape.value)}`);
    case "id": {
      if (typeof value !== "string") return bad(`Expected Id<"${shape.table}">`);
      if (tableOfId && tableOfId(value) !== shape.table) return bad(`Expected Id<"${shape.table}">`);
      return [];
    }
    case "array":
      if (!Array.isArray(value)) return bad("Expected array");
      return value.flatMap((item, i) => validate(shape.item, item, tableOfId, `${path}[${i}]`));
    case "record":
      if (!isPlainObject(value)) return bad("Expected object");
      return Object.entries(value).flatMap(([k, item]) => validate(shape.value, item, tableOfId, join(path, k)));
    case "object": {
      if (!isPlainObject(value)) return bad("Expected object");
      const issues: Issue[] = [];
      for (const [k, f] of Object.entries(shape.fields)) {
        const item = (value as Record<string, unknown>)[k];
        if (item === undefined) {
          if (!f.optional) issues.push({ path: join(path, k), message: "Missing required field" });
        } else issues.push(...validate(f.shape, item, tableOfId, join(path, k)));
      }
      for (const k of Object.keys(value)) {
        if (!(k in shape.fields) && (value as Record<string, unknown>)[k] !== undefined) {
          issues.push({ path: join(path, k), message: "Unexpected field" });
        }
      }
      return issues;
    }
    case "union":
      return shape.members.some((m) => validate(m, value, tableOfId, path).length === 0)
        ? []
        : bad("Value matches no member of the union");
  }
}

const join = (path: string, k: string) => (path ? `${path}.${k}` : k);
export const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

// ------------------------------------------------------------------------------------------- JSON with int64

/** JSON encoding that survives bigint (`{"$int64":"..."}`), as Convex does with `$integer`. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, x) => (typeof x === "bigint" ? { $int64: x.toString() } : x));
}
export function fromJson(text: string): any {
  return JSON.parse(text, (_k, x) =>
    isPlainObject(x) && typeof x.$int64 === "string" && Object.keys(x).length === 1 ? BigInt(x.$int64) : x,
  );
}
