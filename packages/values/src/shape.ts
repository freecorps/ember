// Shape: the JSON description of a validator. It is the single source for runtime validation, DDL, migrations,
// codegen, JSON Schema and the client. Shapes are plain data: no closures, so a schema serialises verbatim.

export type LiteralValue = string | number | boolean | bigint;

export type Shape =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "int64" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "bytes" }
  | { kind: "file" }
  | { kind: "any" }
  | { kind: "id"; table: string }
  /** bigint literals are stored as `{ $int64: "..." }` so the shape stays JSON. */
  | { kind: "literal"; value: string | number | boolean | { $int64: string } }
  | { kind: "array"; item: Shape }
  | { kind: "record"; value: Shape }
  | { kind: "object"; fields: Record<string, FieldShape> }
  | { kind: "union"; members: Shape[] };

export type FieldShape = { shape: Shape; optional: boolean };

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
