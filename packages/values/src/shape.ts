// Shape: the JSON description of a validator. It is the single source for runtime validation, DDL, migrations,
// codegen, JSON Schema and the client. Shapes are plain data: no closures, so a schema serialises verbatim.

export type LiteralValue = string | number | boolean | bigint;

/**
 * Refinements of a string, number or array (docs/design/dx.md §3.10): checked on every validation, serialisable (no
 * closures), and carried to clients, JSON Schema and OpenAPI. They never change how a value is stored.
 */
export type Checks = {
  /** Strings. */
  minLength?: number;
  maxLength?: number;
  /** A RegExp source (and its flags). */
  pattern?: string;
  flags?: string;
  format?: "email" | "url" | "uuid";
  /** Numbers (inclusive). */
  min?: number;
  max?: number;
  int?: true;
  /** Arrays. */
  minItems?: number;
  maxItems?: number;
};

export type Shape =
  | { kind: "string"; checks?: Checks }
  | { kind: "number"; checks?: Checks }
  | { kind: "int64" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "bytes" }
  | { kind: "file" }
  | { kind: "any" }
  | { kind: "id"; table: string }
  /** bigint literals are stored as `{ $int64: "..." }` so the shape stays JSON. */
  | { kind: "literal"; value: string | number | boolean | { $int64: string } }
  | { kind: "array"; item: Shape; checks?: Checks }
  | { kind: "record"; value: Shape }
  | { kind: "object"; fields: Record<string, FieldShape> }
  | { kind: "union"; members: Shape[] };

/**
 * One field of an object. `default` (function arguments only): the value an absent field takes before the handler runs
 * (JSON with tags, see `toJSONValue`); the field is optional for callers. `description`: shown in generated types.
 */
export type FieldShape = { shape: Shape; optional: boolean; default?: unknown; description?: string };

/** The shape without refinements, defaults and descriptions: what storage and migrations compare. */
export function storageShape(shape: Shape): Shape {
  switch (shape.kind) {
    case "string":
    case "number":
      return { kind: shape.kind };
    case "array":
      return { kind: "array", item: storageShape(shape.item) };
    case "record":
      return { kind: "record", value: storageShape(shape.value) };
    case "union":
      return { kind: "union", members: shape.members.map(storageShape) };
    case "object":
      return { kind: "object", fields: Object.fromEntries(Object.entries(shape.fields).map(([k, f]) => [k, { shape: storageShape(f.shape), optional: f.optional }])) };
    default:
      return shape;
  }
}

export type ObjectShape = Extract<Shape, { kind: "object" }>;

/** The runtime value of a literal shape. */
export function literalValue(shape: Extract<Shape, { kind: "literal" }>): LiteralValue {
  const x = shape.value;
  return typeof x === "object" ? BigInt(x.$int64) : x;
}

/** Follows a dotted path through object shapes; undefined when the path leaves an object. */
export function shapeAtPath(shape: Shape, path: string): FieldShape | undefined {
  let cur: FieldShape | undefined = { shape, optional: false };
  let optional = false;
  for (const part of path.split(".")) {
    if (!cur) return undefined;
    const s: Shape = cur.shape;
    if (s.kind === "object") {
      cur = s.fields[part];
      if (cur?.optional) optional = true;
    } else if (s.kind === "union") {
      // Union of objects: the field exists if any member has it; optional unless all members require it.
      const hits = s.members.filter((m): m is ObjectShape => m.kind === "object" && part in m.fields);
      if (!hits.length) return undefined;
      const fs = hits.map((m) => m.fields[part]!);
      optional ||= fs.length !== s.members.length || fs.some((f) => f.optional);
      const shapes = fs.map((f) => f.shape);
      cur = { shape: shapes.length === 1 ? shapes[0]! : { kind: "union", members: shapes }, optional };
    } else return undefined;
  }
  return cur && { shape: cur.shape, optional };
}
