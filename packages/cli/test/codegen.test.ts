import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codegen, type CodegenResult } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { cleanup, sampleProject } from "./helpers.ts";

// A client of the generated API: exact types, and no server code in the program.
const CLIENT = `import { EmberClient } from "@freecorps/ember-client";
import { api } from "./ember/_generated/api";
import type { Doc, Id } from "./ember/_generated/dataModel";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};
declare const client: EmberClient;

export async function main() {
  const list = await client.query(api.messages.list, { channel: "general", limit: 10 });
  assert<Equals<typeof list, Doc<"messages">[]>>();
  const n = await client.query(api.messages.count, { channel: "general" });
  assert<Equals<typeof n, number>>();
  const sent = await client.mutation(api.messages.send, { channel: "a", author: "b", body: "c" });
  assert<Equals<typeof sent, { id: Id<"messages">; at: number }>>();
  const channel = await client.mutation(api.messages.edit, { id: sent.id, body: "x" });
  assert<Equals<typeof channel, string | null>>();
  const doc: Doc<"messages"> = list[0]!;
  assert<Equals<typeof doc.edited, boolean | undefined>>();
}
`;

// Every "// ERR" line must fail, and no other line.
const CLIENT_ERROR = `import { EmberClient } from "@freecorps/ember-client";
import { api, internal } from "./ember/_generated/api";
import type { Doc, Id } from "./ember/_generated/dataModel";

declare const client: EmberClient;

export async function main() {
  await client.query(api.messages.list, { channel: 1 }); // ERR wrong arg type
  await client.query(api.messages.list, { channel: "a", nope: 1 }); // ERR unknown arg
  await client.query(api.messages.missing, {}); // ERR unknown function
  await client.mutation(api.messages.list, { channel: "a" }); // ERR query used as mutation
  await client.query(api.messages.trim, {}); // ERR internal function is not in api
  await client.mutation(api.messages.edit, { id: "plain", body: "x" }); // ERR plain string is not an Id
  const n: string = await client.query(api.messages.count, { channel: "a" }); // ERR wrong return type
  const d: Doc<"messages"> = { _id: "x" as Id<"messages">, _creationTime: 1, channel: "a", author: "b", body: 2 }; // ERR field type
  const bad: Doc<"nope"> | null = null; // ERR unknown table
  void internal.messages.trim;
  void n;
  void d;
  void bad;
}
`;

// Server code can schedule through the generated (static) references.
const SERVER_USE = `import { internal } from "./ember/_generated/api";
import { mutation } from "./ember/_generated/server";

export const later = mutation({
  args: {},
  handler: (ctx) => ctx.scheduler.runAfter(1000, internal.messages.trim, { channel: "general", keep: 10 }),
});
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
  const files = program.getSourceFiles().map((s) => s.fileName);
  return { diags, lines: [...new Set(lines)].sort((a, b) => a - b), files, text: diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) };
}

describe("ember codegen", () => {
  let project: Project;
  let result: CodegenResult;
  const gen = (f: string) => readFileSync(join(project.generatedDir, f), "utf8");

  beforeAll(async () => {
    project = sampleProject("codegen");
    writeFileSync(join(project.root, "client.ts"), CLIENT);
    writeFileSync(join(project.root, "client_error.ts"), CLIENT_ERROR);
    writeFileSync(join(project.root, "server_use.ts"), SERVER_USE);
    result = await codegen(project);
  });
  afterAll(() => cleanup(project));

  it("emits static api/dataModel types and a manifest", () => {
    expect(result.warnings).toEqual([]);
    expect(gen("api.d.ts")).toMatchSnapshot("api.d.ts");
    expect(gen("dataModel.d.ts")).toMatchSnapshot("dataModel.d.ts");
    // Client-facing files import nothing but each other.
    expect(gen("api.d.ts").match(/from "([^"]+)"/g)).toEqual(['from "./dataModel"']);
    expect(gen("dataModel.d.ts")).not.toMatch(/^import/m);
    const m = JSON.parse(gen("manifest.json"));
    expect(m.functions.map((f: any) => [f.name, f.type, f.visibility, !!f.returns])).toEqual([
      ["messages:count", "query", "public", true],
      ["messages:digest", "action", "public", false],
      ["messages:edit", "mutation", "public", false],
      ["messages:list", "query", "public", false],
      ["messages:send", "mutation", "public", false],
      ["messages:trim", "mutation", "internal", false],
    ]);
    expect(m.crons).toEqual([{ name: "trim-general", schedule: "0 * * * *", shard: "global:main", fn: "messages:trim" }]);
    expect(m.schema.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent (rewrites nothing when unchanged)", async () => {
    expect((await codegen(project)).written).toEqual([]);
  });

  it("client code type-checks with exact types and without loading server code", () => {
    const r = check(project, "client.ts");
    expect(r.text).toEqual([]);
    const own = r.files.filter((f) => !f.includes("/typescript/lib/"));
    expect(own.some((f) => f.endsWith("/ember/messages.ts") || f.endsWith("/ember/schema.ts"))).toBe(false);
    expect(own.some((f) => f.includes("/server/src/"))).toBe(false);
  });

  it("generated references work with server APIs (scheduler)", () => {
    expect(check(project, "server_use.ts").text).toEqual([]);
  });

  it("client mistakes fail exactly on the // ERR lines", () => {
    const expected = CLIENT_ERROR.split("\n")
      .map((l, i) => (l.includes("// ERR") ? i + 1 : 0))
      .filter(Boolean);
    expect(check(project, "client_error.ts").lines).toEqual(expected);
  });
});
