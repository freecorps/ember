// Shape (JSON validator description) → TypeScript type text. Mirrors `Infer<>` in @freecorps/ember-values.

import type { Checks, FieldShape, Shape } from "@freecorps/ember-values";

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const propKey = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

export function shapeToTs(shape: Shape, indent = ""): string {
  switch (shape.kind) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "int64":
      return "bigint";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "bytes":
      return "Uint8Array";
    case "file":
      return "FileId";
    case "any":
      return "any";
    case "id":
      return `Id<${JSON.stringify(shape.table)}>`;
    case "literal": {
      const x = shape.value;
      return typeof x === "object" ? `${x.$int64}n` : JSON.stringify(x);
    }
    case "array": {
      const item = shapeToTs(shape.item, indent);
      return shape.item.kind === "union" ? `Array<${item}>` : `${item}[]`;
    }
    case "record":
      return `Record<string, ${shapeToTs(shape.value, indent)}>`;
    case "union":
      return shape.members.map((m) => shapeToTs(m, indent)).join(" | ");
    case "object": {
      const entries = Object.entries(shape.fields);
      if (!entries.length) return "{}";
      const inner = indent + "  ";
      return `{\n${entries.map(([k, f]) => `${fieldDoc(f, inner)}${inner}${propKey(k)}${f.optional ? "?" : ""}: ${shapeToTs(f.shape, inner)};`).join("\n")}\n${indent}}`;
    }
  }
}

/** What a field's refinements mean, in words (hover text): "1–200 characters, email". */
export function checksText(c: Checks | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  const range = (lo: number | undefined, hi: number | undefined, unit: string) =>
    lo !== undefined && hi !== undefined ? `${lo}–${hi} ${unit}` : lo !== undefined ? `at least ${lo} ${unit}` : hi !== undefined ? `at most ${hi} ${unit}` : null;
  const chars = range(c.minLength, c.maxLength, "characters");
  if (chars) out.push(chars);
  const items = range(c.minItems, c.maxItems, "items");
  if (items) out.push(items);
  if (c.int) out.push("integer");
  if (c.min !== undefined || c.max !== undefined) out.push(c.min !== undefined && c.max !== undefined ? `${c.min}..${c.max}` : c.min !== undefined ? `>= ${c.min}` : `<= ${c.max}`);
  if (c.format) out.push(c.format);
  if (c.pattern !== undefined) out.push(`matches /${c.pattern}/${c.flags ?? ""}`);
  return out;
}

function fieldDoc(f: FieldShape, indent: string): string {
  const parts: string[] = [];
  if (f.description) parts.push(f.description.replace(/\*\//g, "*\\/"));
  const checks = checksText((f.shape as { checks?: Checks }).checks);
  if (checks.length) parts.push(checks.join(", "));
  if (f.default !== undefined) parts.push(`@default ${JSON.stringify(f.default)}`);
  return parts.length ? `${indent}/** ${parts.join(". ")} */\n` : "";
}
