// docs/design/dx.md: the contract codegen emits (errors, names, docs, navigation) and its guarantees (a fixed point on
// a fresh clone, --check, --strict), checked through the TypeScript compiler and language service like an editor would.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codegen, type CodegenResult } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const ERRORS = `import { defineErrors, v } from "@freecorps/ember-server";

export const errors = defineErrors({
  MessageTooLong: { data: v.object({ max: v.number() }), message: "This message is too long." },
  RoomNotFound: { data: v.object({ roomId: v.string() }) },
  Forbidden: {},
  Banned: { data: v.object({ until: v.number() }) },
});
`;

const LIB = `import { errors } from "../errors";
import type { MutationCtx } from "../_generated/server";

/** Throws unless the author may post (a helper: its errors reach the callers' contracts). */
export function assertCanPost(ctx: MutationCtx, author: string) {
  if (author === "spam") throw errors.Banned({ until: ctx.now + 1000 });
}
`;

const ROOMS = `import { v } from "@freecorps/ember-server";
import { internal } from "./_generated/api";
import { internalQuery, mutation, query } from "./_generated/server";
import { errors } from "./errors";
import { assertCanPost } from "./lib/guard";

/** A summary card for a room. */
export type RoomSummary = { channel: string; count: number; last: string | null };

export const summary = internalQuery({
  args: { channel: v.string() },
  handler: (ctx, { channel }): RoomSummary => {
    const all = ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", channel)).collect();
    if (!all.length) throw errors.RoomNotFound({ roomId: channel });
    return { channel, count: all.length, last: all.at(-1)?.body ?? null };
  },
});

/** Depends on another function's result: needs the fixed point on a fresh clone. */
export const card = query({
  args: { channel: v.string() },
  handler: (ctx, { channel }) => ctx.runQuery(internal.rooms.summary, { channel }),
});

/** Declares its errors: a contract. */
export const post = mutation({
  args: { channel: v.string(), author: v.string(), body: v.string() },
  errors: [errors.MessageTooLong, errors.Banned],
  handler: (ctx, { channel, author, body }) => {
    assertCanPost(ctx, author);
    if (body.length > 10) ctx.fail.MessageTooLong({ max: 10 });
    return ctx.db.insert("messages", { channel, author, body });
  },
});

/** Throws an error it does not declare (a warning; an error with --strict). */
export const close = mutation({
  args: { channel: v.string() },
  errors: [],
  handler: (_ctx, { channel }) => {
    if (channel === "general") throw errors.Forbidden();
    return null;
  },
});

/** Catches what it calls: nothing leaks into its contract. */
export const safe = mutation({
  args: { author: v.string() },
  handler: (ctx, { author }) => {
    try {
      assertCanPost(ctx, author);
      return true;
    } catch {
      return false;
    }
  },
});
`;

// A client of the generated API: exact types, typed errors, no server code.
const CLIENT = `import { EmberClient, isError, type Errors } from "@freecorps/ember-client";
import { api } from "./ember/_generated/api";
import { errors } from "./ember/_generated/errors";
import type { RoomSummary } from "./ember/_generated/types";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};
declare const client: EmberClient;

export async function main() {
  const card = await client.query(api.rooms.card, { channel: "a" });
  assert<Equals<typeof card, RoomSummary>>();
  assert<Equals<Errors<typeof api.rooms.card>["code"], "RoomNotFound">>();
  assert<Equals<Errors<typeof api.rooms.post>["code"], "Banned" | "MessageTooLong">>();
  assert<Equals<Errors<typeof api.rooms.close>["code"], "Forbidden">>();
  assert<Equals<Errors<typeof api.rooms.safe>, never>>();
  assert<Equals<Errors<typeof api.messages.send>["code"], "MessageTooLong">>();
  try {
    await client.mutation(api.rooms.post, { channel: "a", author: "b", body: "c" });
  } catch (e) {
    if (isError(e, api.rooms.post, "MessageTooLong")) assert<Equals<typeof e.data, { max: number }>>();
    if (isError(e, api.rooms.post, "Banned")) assert<Equals<typeof e.data, { until: number }>>();
    if (errors.RoomNotFound.is(e)) assert<Equals<typeof e.data, { roomId: string }>>();
    if (isError(e, errors.Forbidden)) assert<Equals<typeof e.data, undefined>>();
  }
}
`;

// Every "// ERR" line must fail, and no other line.
const CLIENT_ERROR = `import { EmberClient, isError, unsafeRef } from "@freecorps/ember-client";
import { api } from "./ember/_generated/api";

declare const client: EmberClient;

export async function main(e: unknown) {
  await client.query(api.rooms.card); // ERR required args omitted
  await client.mutation(api.rooms.post); // ERR required args omitted
  await client.query("rooms:card", { channel: "a" }); // ERR string reference
  await client.query(unsafeRef("rooms:card"), { channel: "a" });
  if (isError(e, api.rooms.post, "RoomNotFound")) void e; // ERR not an error of rooms.post
  await client.query(api.messages.list, { channel: "a" });
  await client.query(api.messages.list); // ERR required args omitted
}
`;

function check(project: Project, file: string) {
  const program = ts.createProgram([join(project.root, file)], OPTIONS);
  const sf = program.getSourceFile(join(project.root, file))!;
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === sf.fileName || d.file?.fileName.includes("_generated"));
  const lines = diags.map((d) => (d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : -1));
  const files = program.getSourceFiles().map((s) => s.fileName);
  return { lines: [...new Set(lines)].sort((a, b) => a - b), files, text: diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) };
}

const OPTIONS: ts.CompilerOptions = {
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
};

/** Go to Definition at `marker` in `file`, as VS Code asks the TS language service. */
function definitionAt(project: Project, file: string, marker: string) {
  const path = join(project.root, file);
  const text = readFileSync(path, "utf8");
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [path],
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8")) : undefined),
    getCurrentDirectory: () => project.root,
    getCompilationSettings: () => OPTIONS,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  const defs = ls.getDefinitionAtPosition(path, text.indexOf(marker) + marker.length - 1) ?? [];
  const quick = ls.getQuickInfoAtPosition(path, text.indexOf(marker) + marker.length - 1);
  return {
    defs: defs.map((d) => {
      const src = readFileSync(d.fileName, "utf8");
      return { file: d.fileName, line: ts.createSourceFile(d.fileName, src, ts.ScriptTarget.Latest).getLineAndCharacterOfPosition(d.textSpan.start).line + 1 };
    }),
    hover: quick ? ts.displayPartsToString(quick.displayParts) : "",
    docs: quick ? ts.displayPartsToString(quick.documentation) : "",
    tags: (quick?.tags ?? []).map((t) => `@${t.name} ${ts.displayPartsToString(t.text ?? [])}`.trim()),
  };
}

/** Go to Definition through a real tsserver (what VS Code runs: it maps .d.ts positions through declaration maps). */
async function tsserverDefinition(project: Project, file: string, marker: string): Promise<Array<{ file: string; line: number }>> {
  const path = join(project.root, file);
  const text = readFileSync(path, "utf8");
  const at = text.indexOf(marker) + marker.length - 1;
  const before = text.slice(0, at).split("\n");
  const line = before.length;
  const offset = before.at(-1)!.length + 1;
  const tsserver = createRequire(import.meta.url).resolve("typescript/lib/tsserver.js");
  const p = spawn(process.execPath, [tsserver, "--disableAutomaticTypingAcquisition"], { stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const responses: Array<{ request_seq?: number; command?: string; body?: unknown; type: string }> = [];
  p.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    for (;;) {
      const m = /Content-Length: (\d+)\r\n\r\n/.exec(buf);
      if (!m) break;
      const start = m.index + m[0].length;
      const len = Number(m[1]);
      if (Buffer.byteLength(buf.slice(start)) < len) break;
      const body = Buffer.from(buf.slice(start)).subarray(0, len).toString("utf8");
      buf = Buffer.from(buf.slice(start)).subarray(len).toString("utf8");
      responses.push(JSON.parse(body));
    }
  });
  const send = (seq: number, command: string, args: unknown) => p.stdin.write(JSON.stringify({ seq, type: "request", command, arguments: args }) + "\n");
  try {
    send(1, "open", { file: path });
    send(2, "definition", { file: path, line, offset });
    const deadline = Date.now() + 30_000;
    while (!responses.some((r) => r.request_seq === 2) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const r = responses.find((x) => x.request_seq === 2) as { body?: Array<{ file: string; start: { line: number } }> } | undefined;
    return (r?.body ?? []).map((d) => ({ file: d.file, line: d.start.line }));
  } finally {
    p.kill();
  }
}

describe("codegen DX (docs/design/dx.md)", () => {
  let project: Project;
  let result: CodegenResult;
  const gen = (f: string) => readFileSync(join(project.generatedDir, f), "utf8");

  beforeAll(async () => {
    project = sampleProject("codegen-dx");
    writeFileSync(join(project.dir, "errors.ts"), ERRORS);
    mkdirSync(join(project.dir, "lib"), { recursive: true });
    writeFileSync(join(project.dir, "lib", "guard.ts"), LIB);
    writeFileSync(join(project.dir, "rooms.ts"), ROOMS);
    writeFileSync(join(project.root, "client.ts"), CLIENT);
    writeFileSync(join(project.root, "client_error.ts"), CLIENT_ERROR);
    // What an editor reads (tsserver picks the options from here).
    writeFileSync(
      join(project.root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowImportingTsExtensions: true, customConditions: ["@freecorps/ember-source"], skipLibCheck: true, types: [] }, files: ["client.ts"] }),
    );
    // A fresh clone: no _generated at all, one run.
    rmSync(project.generatedDir, { recursive: true, force: true });
    result = await codegen(project);
  });
  afterAll(() => { if (!process.env.KEEP) cleanup(project); });

  it("converges in one run on a fresh clone (no `any` from functions calling functions)", () => {
    expect(gen("api.d.ts")).toContain("card: Query<{\n      channel: string;\n    }, RoomSummary, E.RoomNotFound>;");
    expect(gen("api.d.ts")).toContain("count: Query<{\n      channel: string;\n    }, number, never>;");
    expect(gen("api.d.ts")).not.toMatch(/\bany\b/);
    expect(gen("types.d.ts")).toContain("export type RoomSummary = {\n  channel: string;\n  count: number;\n  last: string | null;\n};");
  });

  it("infers errors from handlers, helpers and callees; declared lists are contracts", () => {
    const m = result.manifest;
    const fn = (n: string) => m.functions.find((f) => f.name === n)!;
    expect(fn("rooms:summary").errors).toEqual(["RoomNotFound"]);
    expect(fn("rooms:card").errors).toEqual(["RoomNotFound"]);
    expect(fn("rooms:post")).toMatchObject({ errors: ["Banned", "MessageTooLong"], errorsDeclared: true });
    expect(fn("rooms:safe").errors).toBeUndefined();
    expect(fn("messages:send").errors).toEqual(["MessageTooLong"]);
    expect(result.warnings.filter((w) => !w.includes("node_modules"))).toEqual([expect.stringMatching(/^rooms:close may throw Forbidden \(ember\/rooms\.ts:\d+\) but does not declare it in `errors`$/)]);
    expect(m.errors?.map((e) => e.code)).toEqual(["MessageTooLong", "RoomNotFound", "Forbidden", "Banned"]);
  });

  it("emits errors for clients (types and runtime refs, no server code)", async () => {
    expect(gen("errors.d.ts")).toContain('export type Banned = { readonly code: "Banned"; readonly data: {\n  until: number;\n} };');
    expect(gen("errors.d.ts")).toContain('export type Forbidden = { readonly code: "Forbidden"; readonly data: undefined };');
    const mod = (await import(join(project.generatedDir, "errors.js"))) as { errors: Record<string, { code: string; is(e: unknown): boolean }> };
    expect(mod.errors.Banned!.is({ kind: "app", code: "Banned", data: { until: 1 } })).toBe(true);
    expect(mod.errors.Banned!.is({ kind: "system", code: "Banned" })).toBe(false);
  });

  it("client code type-checks: typed results and errors, without loading server code", () => {
    const r = check(project, "client.ts");
    expect(r.text).toEqual([]);
    const own = r.files.filter((f) => !f.includes("/typescript/lib/"));
    expect(own.some((f) => /\/ember\/(rooms|messages|errors|schema)\.ts$/.test(f))).toBe(false);
  });

  it("client mistakes fail exactly on the // ERR lines", () => {
    const expected = CLIENT_ERROR.split("\n")
      .map((l, i) => (l.includes("// ERR") ? i + 1 : 0))
      .filter(Boolean);
    expect(check(project, "client_error.ts").lines).toEqual(expected);
  });

  it("Go to Definition on api.rooms.post opens the handler (tsserver + api.d.ts.map)", async () => {
    const defs = await tsserverDefinition(project, "client.ts", "api.rooms.post");
    expect(defs).toEqual([{ file: join(project.dir, "rooms.ts"), line: ROOMS.split("\n").findIndex((l) => l.startsWith("export const post")) + 1 }]);
  });

  it("hover shows the contract, the docs and the errors", () => {
    const d = definitionAt(project, "client.ts", "api.rooms.post");
    expect(d.hover).toMatch(/^\(property\) post: Mutation<\{/);
    expect(d.hover).toBe('(property) post: Mutation<{\n    channel: string;\n    author: string;\n    body: string;\n}, Id<"messages">, Banned | MessageTooLong>');
    expect(d.docs).toBe("Declares its errors: a contract.");
    expect(d.tags).toEqual(["@throws {Banned}", "@throws {MessageTooLong} This message is too long.", expect.stringMatching(/^@source ember\/rooms\.ts:\d+$/)]);
  });

  it("is idempotent, and --check tells whether the files are up to date", async () => {
    expect((await codegen(project)).written).toEqual([]);
    expect((await codegen(project, { check: true })).stale).toEqual([]);
    writeFileSync(join(project.dir, "rooms.ts"), ROOMS.replace("count: number;", "count: number; extra: boolean;").replace("last: all.at(-1)?.body ?? null }", "last: all.at(-1)?.body ?? null, extra: true }"));
    const r = await codegen(project, { check: true });
    // RoomSummary is printed by name: only its definition changes.
    expect(r.stale).toEqual(["types.d.ts"]);
    expect(gen("types.d.ts")).not.toContain("extra");
    writeFileSync(join(project.dir, "rooms.ts"), ROOMS);
  });

  it("--strict fails on undeclared errors of public functions and on untyped results", async () => {
    const r = await codegen(project, { strict: true, check: true });
    expect(r.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^rooms:close may throw Forbidden/),
        expect.stringMatching(/^rooms:card throws RoomNotFound .*declare them/),
        expect.stringMatching(/^messages:send throws MessageTooLong .*declare them/),
      ]),
    );
    expect(r.errors.some((e) => e.startsWith("rooms:summary"))).toBe(false); // internal
  });

  it("prints a function's contract (ember types)", () => {
    expect(result.contracts.get("rooms:post")).toBe("Mutation<{\n  channel: string;\n  author: string;\n  body: string;\n}, Id<\"messages\">, E.Banned | E.MessageTooLong>");
  });
});
