// Shape (JSON validator description) → TypeScript type text. Mirrors `Infer<>` in @freecorps/ember-values.

import type { Shape } from "@freecorps/ember-values";

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
      return `{\n${entries.map(([k, f]) => `${inner}${propKey(k)}${f.optional ? "?" : ""}: ${shapeToTs(f.shape, inner)};`).join("\n")}\n${indent}}`;
    }
  }
}
