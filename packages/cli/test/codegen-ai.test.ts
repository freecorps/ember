// Codegen with external indexes (PLAN §6): `ctx.vectorSearch` / `ctx.aiSearch` are typed by the schema in server code
// (generated `action` builder), and an action returning their results gives clients `{ _id: Id<...>, _score }`.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codegen } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const SCHEMA = `import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    messages: defineTable({ channel: v.string(), author: v.string(), body: v.string(), edited: v.optional(v.boolean()) }).index("by_channel", ["channel"]),
    notes: defineTable({ title: v.string(), body: v.string(), lang: v.string(), stars: v.number(), vec: v.array(v.number()) })
      .vectorIndex("by_vec", { vectorField: "vec", dimensions: 32, filterFields: ["lang"] })
      .vectorIndex("semantic", { embed: "body", filterFields: ["stars"] })
      .aiSearchIndex("hybrid", { fields: ["title", "body"], filterFields: ["lang"] }),
  },
});
`;

const NOTES = `import { v } from "@freecorps/ember-server";
import { action } from "./_generated/server";

export const similar = action({
  args: { vector: v.array(v.number()), lang: v.optional(v.string()) },
  handler: (ctx, { vector, lang }) => ctx.vectorSearch("notes", "by_vec", { vector, limit: 5, ...(lang ? { filter: { lang } } : {}) }),
});

export const ask = action({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const semantic = await ctx.vectorSearch("notes", "semantic", { text: q, filter: { stars: { $gte: 3 } } });
    const hybrid = await ctx.aiSearch("notes", "hybrid", { query: q, filter: { lang: "pt" } });
    return { semantic, hybrid };
  },
});
`;

// Server-side mistakes: every "// ERR" line must fail, and no other line.
const SERVER_ERROR = `import { action } from "./ember/_generated/server";

export const bad = action({
  handler: async (ctx) => {
    await ctx.vectorSearch("notes", "nope", { vector: [1, 2, 3] }); // ERR unknown index
    await ctx.vectorSearch("notes", "by_vec", { text: "x" }); // ERR text needs embed
    await ctx.vectorSearch("notes", "by_vec", { vector: [1], filter: { stars: 1 } }); // ERR not a filter field
    await ctx.aiSearch("notes", "by_vec", { query: "x" }); // ERR not an aiSearch index
    await ctx.aiSearch("messages", "hybrid", { query: "x" }); // ERR index of another table
    await ctx.aiSearch("notes", "hybrid", { query: "x", filter: { lang: 2 } }); // ERR filter value type
    return null;
  },
});
`;

const CLIENT = `import { EmberClient } from "@freecorps/ember-client";
import { api } from "./ember/_generated/api";
import type { Id } from "./ember/_generated/dataModel";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};
declare const client: EmberClient;

export async function main() {
  const hits = await client.action(api.notes.similar, { vector: [1, 0, 0] });
  assert<Equals<typeof hits, { _id: Id<"notes">; _score: number }[]>>();
  const r = await client.action(api.notes.ask, { q: "reembolso" });
  assert<Equals<typeof r.hybrid, { _id: Id<"notes">; _score: number; text: string }[]>>();
}
`;

function check(project: Project, file: string) {
  const program = ts.createProgram([join(project.root, file)], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    customConditions: ["@freecorps/ember-source"],
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  });
  const sf = program.getSourceFile(join(project.root, file))!;
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === sf.fileName || d.file?.fileName.includes("_generated"));
  const lines = diags.map((d) => (d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : -1));
  return { lines: [...new Set(lines)].sort((a, b) => a - b), text: diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) };
}

describe("ember codegen with vectorIndex / aiSearchIndex", () => {
  let project: Project;
  beforeAll(async () => {
    project = sampleProject("codegen-ai");
    writeFileSync(join(project.dir, "schema.ts"), SCHEMA);
    writeFileSync(join(project.dir, "notes.ts"), NOTES);
    writeFileSync(join(project.root, "server_error.ts"), SERVER_ERROR);
    writeFileSync(join(project.root, "client.ts"), CLIENT);
    await codegen(project);
  });
  afterAll(() => cleanup(project));

  it("server code: searches are typed by table, index, query form and filter fields", () => {
    expect(check(project, "ember/notes.ts").text).toEqual([]);
    const expected = SERVER_ERROR.split("\n")
      .map((l, i) => (l.includes("// ERR") ? i + 1 : 0))
      .filter(Boolean);
    expect(check(project, "server_error.ts").lines).toEqual(expected);
  });

  it("client code: action results carry Id<table> and scores", () => {
    expect(check(project, "client.ts").text).toEqual([]);
  });
});
