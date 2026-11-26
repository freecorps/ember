// Forms generated from `v.*` validators (the args shape the runtime lists): the function runner and the declarative
// screens' filters and action forms.

export type Shape =
  | { kind: "string" | "number" | "int64" | "boolean" | "null" | "bytes" | "file" | "any" }
  | { kind: "id"; table: string }
  | { kind: "literal"; value: unknown }
  | { kind: "array"; item: Shape }
  | { kind: "record"; value: Shape }
  | { kind: "object"; fields: Record<string, { shape: Shape; optional: boolean; default?: unknown; description?: string }> }
  | { kind: "union"; members: Shape[] };

export type ObjectShape = Extract<Shape, { kind: "object" }>;

export type FieldKind = { kind: "text" | "number" | "boolean" | "json"; options?: unknown[] };

/** How the form edits a field: simple shapes get an input; anything else is a JSON input. */
export function fieldKind(shape: Shape): FieldKind {
  if (shape.kind === "string" || shape.kind === "id") return { kind: "text" };
  if (shape.kind === "number") return { kind: "number" };
  if (shape.kind === "boolean") return { kind: "boolean" };
  if (shape.kind === "literal") return { kind: "text", options: [shape.value] };
  if (shape.kind === "union" && shape.members.every((m) => m.kind === "literal")) return { kind: "text", options: shape.members.map((m) => (m as { value: unknown }).value) };
  return { kind: "json" };
}

/** The args object from the form's raw inputs: blanks omitted; JSON fields parsed. Throws on a bad JSON field. */
export function argsFromForm(shape: ObjectShape, raw: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(shape.fields)) {
    const v = raw[k];
    if (v === undefined || v === "") continue;
    const kind = fieldKind(f.shape);
    if (kind.kind === "number") out[k] = Number(v);
    else if (kind.kind === "boolean") out[k] = v === "true";
    else if (kind.options) out[k] = kind.options.find((o) => String(o) === v) ?? v;
    else if (kind.kind === "json") {
      try {
        out[k] = JSON.parse(v);
      } catch {
        throw new Error(`${k}: not valid JSON`);
      }
    } else out[k] = v;
  }
  return out;
}

