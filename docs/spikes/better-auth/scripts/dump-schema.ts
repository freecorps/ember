/**
 * Codegen prototype: what our CLI would do for the auth section of schema.ts.
 * Evaluates the auth config WITHOUT a DB, asks Better Auth for the merged
 * schema and writes:
 *   generated/auth-schema.json  raw merged BetterAuthDBSchema (core+plugins)
 *   generated/auth-schema.sql   SQLite DDL for the auth DO
 *   generated/auth-tables.ts    engine-style defineTable/v declarations
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { getAuthTables } from "better-auth/db";
import type { DBFieldAttribute } from "@better-auth/core/db";
import { authConfig } from "../src/auth-config.ts";
import { schemaDDL, tableSpecs } from "../src/ddl.ts";

const options = authConfig();
const tables = getAuthTables(options);
const out = new URL("../generated/", import.meta.url);
mkdirSync(out, { recursive: true });

writeFileSync(
  new URL("auth-schema.json", out),
  JSON.stringify(tables, (_k, v) => (typeof v === "function" ? `[fn ${v.name || "anonymous"}]` : v), 2),
);
writeFileSync(new URL("auth-schema.sql", out), schemaDDL(options).join(";\n\n") + ";\n");

const vFor = (f: DBFieldAttribute): string => {
  const t = f.type;
  let base: string;
  if (Array.isArray(t)) base = `v.union(${t.map((l) => `v.literal(${JSON.stringify(l)})`).join(", ")})`;
  else if (t === "string") base = "v.string()";
  else if (t === "number") base = f.bigint ? "v.int64()" : "v.number()";
  else if (t === "boolean") base = "v.boolean()";
  else if (t === "date") base = "v.number() /* epoch ms */";
  else if (t === "json") base = "v.any()";
  else if (t === "string[]") base = "v.array(v.string())";
  else if (t === "number[]") base = "v.array(v.number())";
  else base = "v.any()";
  if (f.references) base = `v.id(${JSON.stringify(f.references.model)}) /* ${f.references.onDelete ?? "cascade"} */`;
  return f.required === false ? `v.optional(v.union(v.null(), ${base}))` : base;
};

const lines: string[] = [
  "// AUTO-GENERATED from Better Auth options. Do not edit.",
  'import { defineTable, v } from "@engine/schema";',
  "",
  "export const authTables = {",
];
for (const spec of tableSpecs(options)) {
  const t = tables[spec.key]!;
  lines.push(`  ${JSON.stringify(spec.key)}: defineTable({`);
  for (const [k, f] of Object.entries(t.fields)) lines.push(`    ${f.fieldName ?? k}: ${vFor(f)},`);
  lines.push(`  }, { table: ${JSON.stringify(spec.name)}, owner: "auth", readonly: true })`);
  for (const i of spec.indexes) lines.push(`    .index(${JSON.stringify(i.name)}, ${JSON.stringify(i.columns)})`);
  for (const c of spec.columns.filter((c) => c.unique)) lines.push(`    .unique(${JSON.stringify(c.name)})`);
  lines[lines.length - 1] += ",";
}
lines.push("};", "");
writeFileSync(new URL("auth-tables.ts", out), lines.join("\n"));

const summary = Object.fromEntries(
  Object.entries(tables).map(([k, t]) => [k, Object.keys(t.fields).length]),
);
console.log("tables (field counts):", summary);
console.log("wrote generated/auth-schema.{json,sql}, generated/auth-tables.ts");
