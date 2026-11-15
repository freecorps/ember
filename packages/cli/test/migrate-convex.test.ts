// `ember migrate convex` (PLAN §22 L9): the fixture Convex app (test/fixtures/convex-app/convex, written for these
// tests) converts to the golden tree in test/fixtures/convex-app/expected; the result passes `ember codegen` and
// `tsc --noEmit` except where the report says a human must decide; converted functions behave in `emberTest`; and
// the single rewrites hold on small snippets. `UPDATE_GOLDEN=1` rewrites the golden tree.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { anyApi, type SchemaDefinition, type GenericShards, type GenericTables } from "@freecorps/ember-server";
import { emberTest } from "@freecorps/ember-testing";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RENAMED, SAME_NAME, VALUES_ONLY } from "../src/migrate/apis.ts";
import { migrateConvex, verifyMigration, type MigrateResult } from "../src/migrate/index.ts";
import { TMP } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/convex-app/convex", import.meta.url));
const EXPECTED = fileURLToPath(new URL("./fixtures/convex-app/expected", import.meta.url));

function tree(dir: string, root = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    if (name === "_generated" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tree(p, root, out);
    else out[relative(root, p).split(sep).join("/")] = readFileSync(p, "utf8");
  }
  return out;
}

/** Runs the codemod (dry run) on `files` and returns the result. */
function snippet(name: string, files: Record<string, string>): MigrateResult {
  const dir = join(TMP, `migrate-${name}-${process.pid}`, "convex");
  rmSync(dir, { recursive: true, force: true });
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  try {
    return migrateConvex({ src: dir, dryRun: true });
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
}

const SERVER_IMPORTS = 'import { query, mutation, internalMutation, action } from "./_generated/server";\nimport { v } from "convex/values";\n';

describe("ember migrate convex: the API tables", () => {
  it("names only things @freecorps/ember-server (or -values) exports", () => {
    const exportsOf = (file: string) => {
      const p = ts.createProgram([file], {
        noEmit: true,
        allowImportingTsExtensions: true,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        customConditions: ["@freecorps/ember-source"],
      });
      const c = p.getTypeChecker();
      return new Set(c.getExportsOfModule(c.getSymbolAtLocation(p.getSourceFile(file)!)!).map((s) => s.name));
    };
    const server = exportsOf(fileURLToPath(new URL("../../server/src/index.ts", import.meta.url)));
    const values = exportsOf(fileURLToPath(new URL("../../values/src/index.ts", import.meta.url)));
    const wanted = [...SAME_NAME, ...Object.values(RENAMED).filter((n) => !VALUES_ONLY.has(n) || n === "JSONValue"), "AppError", "isAppError", "FileId", "FileMetadata", "defineErrors"];
    expect(wanted.filter((n) => !server.has(n))).toEqual([]);
    expect([...VALUES_ONLY].filter((n) => !values.has(n))).toEqual([]);
  });
});

describe("ember migrate convex: the fixture app", () => {
  const out = join(TMP, `migrate-convex-${process.pid}`, "ember");
  let r: MigrateResult;
  beforeAll(() => {
    rmSync(join(out, ".."), { recursive: true, force: true });
    r = migrateConvex({ src: FIXTURE, out });
  });
  afterAll(() => rmSync(join(out, ".."), { recursive: true, force: true }));

  it("writes the golden ember/ tree", () => {
    const got = tree(out);
    if (process.env.UPDATE_GOLDEN) {
      rmSync(EXPECTED, { recursive: true, force: true });
      cpSync(out, EXPECTED, { recursive: true });
    }
    expect(Object.keys(got)).toEqual(Object.keys(tree(EXPECTED)));
    for (const [f, text] of Object.entries(tree(EXPECTED))) expect(got[f], f).toBe(text);
    expect(got["auth.config.ts"]).toBeUndefined();
  });

  it("reports what needs a decision", () => {
    const manual = r.findings.filter((f) => f.severity === "manual").map((f) => `${f.file}:${f.code}`);
    expect(manual.sort()).toEqual(["auth.config.ts:auth-config", "lib/notify.ts:mixed-io", "notes.ts:async-handler"]);
    expect(r.manual).toBe(3);
    const review = r.findings.filter((f) => f.severity === "review").map((f) => `${f.file}:${f.code}`);
    expect(review).toEqual(expect.arrayContaining(["node/hash.ts:use-node", "notes.ts:error-without-code", "files.ts:upload-url", "functions.ts:custom-ctx"]));
    expect(r.report).toContain("## Needs a decision");
    expect(r.report).toContain("notifyWebhook mixes database access and I/O");
    expect(r.report).toContain("`node:crypto`");
    expect(r.sync.blocked).toBe(2);
    expect(r.errors.map((e) => e.code)).toEqual(["NotAMember", "NoteTooLong", "TeamNotFound", "Unauthenticated", "AppError"]);
    expect(r.triggers.map((t) => t.name)).toEqual(["notesTrigger", "notesTrigger2"]);
  });

  it("passes ember codegen and tsc --noEmit, except where the report says so", async () => {
    const v = await verifyMigration(out, { compilerOptions: { customConditions: ["@freecorps/ember-source"], types: ["node"] } });
    expect(v.codegenError).toBeUndefined();
    // The only type error: the mutation that awaits the I/O helper (reported as async-handler).
    expect(r.findings.find((f) => f.code === "async-handler")!.message).toContain("createAndNotify");
    expect(v.diagnostics.length, v.diagnostics.join("\n")).toBeGreaterThan(0);
    const lines = readFileSync(join(out, "notes.ts"), "utf8").split("\n");
    for (const d of v.diagnostics) {
      const m = /^notes\.ts:(\d+): /.exec(d);
      expect(m, d).not.toBeNull();
      expect(lines[Number(m![1]) - 1]).toContain("createAndNotify");
    }
  });

  it("runs the converted functions in emberTest", async () => {
    const load = async (p: string) => (await import(pathToFileURL(join(out, p)).href)) as Record<string, unknown>;
    const schema = (await load("schema.ts")).default as SchemaDefinition<GenericTables, GenericShards>;
    const modules = { notes: await load("notes.ts"), files: await load("files.ts"), jobs: await load("jobs.ts"), maintenance: await load("maintenance.ts"), triggers: await load("triggers.ts") };
    const t = emberTest({ schema, modules });
    const { teamId } = await t.run((ctx) => {
      const userId = ctx.db.insert("users", { name: "Ana", tokenIdentifier: "ana" });
      const teamId = ctx.db.insert("teams", { name: "core", limits: {} });
      ctx.db.insert("members", { teamId, userId, role: "owner" });
      ctx.db.insert("audit", { table: "old", op: "x", at: 0 });
      return { teamId };
    });
    const ana = t.withIdentity({ subject: "ana" });
    const api = anyApi;
    const id = await ana.mutation(api.notes.create, { teamId, body: "hello" });
    expect(await t.run((ctx) => ctx.db.query("audit").collect().map((a) => a.op))).toEqual(expect.arrayContaining(["insert", `touch ${teamId}`]));
    expect(t.scheduled()).toHaveLength(1);
    expect(await t.query(api.jobs.job, { id: t.scheduled()[0]!.id })).toEqual({ state: "pending", total: 1 });
    await t.finishScheduled();
    expect(await t.run((ctx) => (ctx.db.get(id) as { views: bigint }).views)).toBe(1n);
    expect(await ana.query(api.notes.list, { teamId })).toEqual([{ _id: id, body: "hello", author: "Ana" }]);
    expect(await ana.query(api.notes.stats, { teamId })).toEqual({ members: 1, notes: 1, me: "Ana" });
    expect(await ana.query(api.notes.mine, {})).toEqual([teamId]);
    expect(await t.mutation(api.maintenance.cleanup, {})).toBe(1);

    const fail = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return { code: (e as { code: string }).code, data: (e as { data: unknown }).data };
      }
      throw new Error("expected an error");
    };
    expect(await fail(ana.mutation(api.notes.create, { teamId, body: "x".repeat(501) }))).toEqual({ code: "NoteTooLong", data: "NOTE_TOO_LONG" });
    expect(await fail(t.mutation(api.notes.create, { teamId, body: "hi" }))).toEqual({ code: "Unauthenticated", data: { code: "UNAUTHENTICATED", message: "Sign in first" } });
    expect(await fail(ana.mutation(api.notes.create, { teamId, body: "  " }))).toEqual({ code: "AppError", data: "empty note from Ana" });
  });

  it("is idempotent: converting the output again changes nothing", () => {
    const again = migrateConvex({ src: out, inPlace: true, dryRun: true });
    expect(Object.keys(again.outputs)).toEqual([]);
    expect(again.findings.filter((f) => f.code === "async-handler" || f.code === "mixed-io")).toHaveLength(2);
  });
});

describe("ember migrate convex: rewrites", () => {
  it("follows recursion, destructured ctx, consts, methods and callbacks", () => {
    const r = snippet("edge", {
      "edge.ts": `${SERVER_IMPORTS}import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
interface OrgCtx extends QueryCtx { orgId: string }
async function depth(ctx: QueryCtx, id: Id<"nodes">, n = 0): Promise<number> {
  const node = await ctx.db.get(id);
  if (!node?.parent) return n;
  return await depth(ctx, node.parent, n + 1);
}
export async function byOrg({ db }: OrgCtx, orgId: string) {
  const reader = db;
  return await reader.query("nodes").filter((q) => q.eq(q.field("org"), orgId)).collect();
}
export const removeAll = mutation({
  args: { ids: v.array(v.id("nodes")) },
  async handler(ctx, { ids }) {
    const loads = ids.map((id) => ctx.db.get(id));
    const docs = await Promise.all(loads);
    await Promise.all(ids.map(async (id) => { await ctx.db.delete(id); }));
    ids.forEach(async (id) => { await ctx.db.patch(id, { gone: true }); });
    return docs.length;
  },
});
export const d = query({ args: { id: v.id("nodes") }, handler: (ctx, { id }) => depth(ctx, id) });
export const later = mutation(async (ctx: MutationCtx) => {
  const first = await ctx.db.query("nodes").first();
  await new Promise((r) => setTimeout(r, 10));
  return first;
});
`,
    });
    const text = r.outputs["edge.ts"]!;
    expect(text).toContain("function depth(ctx: QueryCtx, id: Id<\"nodes\">, n = 0): number {\n  const node = ctx.db.get(id);");
    expect(text).toContain("  return depth(ctx, node.parent, n + 1);");
    expect(text).toContain("export function byOrg({ db }: OrgCtx, orgId: string) {\n  const reader = db;\n  return reader.query");
    expect(text).toContain("  handler(ctx, { ids }) {\n    const loads = ids.map((id) => ctx.db.get(id));\n    const docs = loads;\n    ids.map((id) => { ctx.db.delete(id); });\n    ids.forEach((id) => { ctx.db.patch(id, { gone: true }); });");
    expect(text).toContain("export const later = mutation(async (ctx: MutationCtx) => {\n  const first = await ctx.db"); // untouched: it waits on a timer
    expect(r.findings.map((f) => f.code)).toEqual(["async-handler"]);
    expect(r.findings[0]!.message).toContain("new Promise");
  });

  it("ctx.db.system on _scheduled_functions → ctx.scheduler.get/list", () => {
    const r = snippet("scheduled", {
      "jobs.ts": `${SERVER_IMPORTS}import type { Id } from "./_generated/dataModel";
export const status = query({
  args: { id: v.id("_scheduled_functions") },
  handler: async (ctx, { id }) => {
    const job = await ctx.db.system.get("_scheduled_functions", id);
    const all = await ctx.db.system.query("_scheduled_functions").collect();
    const pending = await ctx.db.system.query("_scheduled_functions").filter((q) => q.eq(q.field("state.kind"), "pending")).collect();
    const typed: Id<"_scheduled_functions"> = id;
    return { job, n: all.length, p: pending.length, typed };
  },
});
`,
    });
    const text = r.outputs["jobs.ts"]!;
    expect(text).toContain("const job = ctx.scheduler.get(id);");
    expect(text).toContain("const all = ctx.scheduler.list({ limit: 1000 /* at most 1000 jobs: Convex's .collect() returned all of them */ });");
    expect(r.findings.find((f) => f.code === "scheduler-list")!).toMatchObject({ severity: "review", message: expect.stringContaining("no cursor") });
    expect(text).toContain("args: { id: v.string() }");
    expect(text).toContain("const typed: string = id;");
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["scheduler-get", "scheduler-list", "system-table", "scheduled-id"]));
    expect(r.findings.find((f) => f.code === "system-table")!.severity).toBe("manual");
  });

  it("leaves helpers that do I/O or await unknown promises, and reports them", () => {
    const r = snippet("blocked", {
      "a.ts": `${SERVER_IMPORTS}import type { QueryCtx, ActionCtx } from "./_generated/server";
import { lookup } from "some-lib";
export async function viaLib(ctx: QueryCtx) {
  const doc = await ctx.db.query("t").first();
  return await lookup(doc);
}
export async function both(ctx: QueryCtx | ActionCtx) {
  return await ctx.runQuery("x" as never);
}
export const q = query(async (ctx) => {
  const rows = await Promise.allSettled([ctx.db.query("t").collect()]);
  return rows.length;
});
export const act = action(async (ctx) => await ctx.runQuery("x" as never));
`,
    });
    const text = r.outputs["a.ts"] ?? "";
    expect(text).toContain("export async function viaLib(ctx: QueryCtx) {\n  const doc = await ctx.db"); // untouched
    expect(text).toContain("export const act = action(async (ctx) => await ctx.runQuery");
    const codes = r.findings.map((f) => `${f.code}:${f.severity}`);
    expect(codes).toEqual(expect.arrayContaining(["mixed-io:manual", "mixed-ctx:manual", "async-handler:manual"]));
    expect(r.findings.find((f) => f.code === "mixed-io")!.message).toContain("lookup(doc)");
  });

  it("converts convex-helpers customQuery({ args, input }) into .use({ args, handler })", () => {
    const r = snippet("custom", {
      "fns.ts": `import { customQuery } from "convex-helpers/server/customFunctions";
import { query } from "./_generated/server";
import { v } from "convex/values";
export const withOrg = customQuery(query, {
  args: { orgId: v.string() },
  input: async (ctx, { orgId }) => {
    const org = await ctx.db.query("orgs").filter((q) => q.eq(q.field("slug"), orgId)).unique();
    return { ctx: { org }, args: {} };
  },
});
`,
    });
    const text = r.outputs["fns.ts"]!;
    expect(text).toContain("export const withOrg = query.use({\n  args: { orgId: v.string() },\n  handler: (ctx, args) => ({ ctx: ((ctx, { orgId }) => {");
    expect(text).toContain("})(ctx, args).ctx }),\n});");
    expect(text).not.toContain("convex-helpers");
    expect(text).not.toContain("await");
  });

  it("reports identity fields Ember keeps in claims, convex.config.ts and unknown convex-helpers", () => {
    const r = snippet("misc", {
      "me.ts": `${SERVER_IMPORTS}import { getAll } from "convex-helpers/server/relationships";
export const me = query(async (ctx) => {
  const identity = await ctx.auth.getUserIdentity();
  const docs = await getAll(ctx.db, []);
  return { email: identity?.email, tok: identity?.tokenIdentifier, sub: identity?.subject, docs };
});
`,
      "convex.config.ts": `import { defineApp } from "convex/server";\nexport default defineApp();\n`,
    });
    const codes = r.findings.map((f) => f.code);
    expect(codes.filter((c) => c === "identity-field")).toHaveLength(2);
    expect(codes).toEqual(expect.arrayContaining(["convex-config", "convex-helpers"]));
    expect(r.files.find((f) => f.file === "convex.config.ts")!.status).toBe("skipped");
  });

  it("maps imports: renamed types, DataModel and components to _generated/server, unknown names kept and reported", () => {
    const r = snippet("imports", {
      "lib.ts": `import type { GenericQueryCtx, UserIdentity, DocumentByName } from "convex/server";
import type { DataModel } from "./_generated/dataModel";
import { components } from "./_generated/api";
export type Q = GenericQueryCtx<DataModel>;
export type U = UserIdentity;
export type D = DocumentByName<DataModel, "t">;
export const c = components;
`,
    });
    const text = r.outputs["lib.ts"]!;
    expect(text).toContain('import type { DocumentByName } from "convex/server";');
    expect(text).toContain('import type { QueryCtx as GenericQueryCtx, Identity as UserIdentity } from "@freecorps/ember-server";');
    expect(text).toContain('import { type DataModel, components } from "./_generated/server";');
    expect(r.findings.find((f) => f.code === "unsupported-api")!.message).toContain("DocumentByName");
  });

  it("--in-place writes the defineTriggers default appended to an existing triggers.ts", () => {
    const dir = join(TMP, `migrate-inplace-${process.pid}`, "convex");
    rmSync(join(dir, ".."), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const registry = "// Nothing to rewrite here.\nexport const tables = [\"notes\"];\n";
    writeFileSync(join(dir, "triggers.ts"), registry);
    writeFileSync(
      join(dir, "fns.ts"),
      `import { Triggers } from "convex-helpers/server/triggers";
import { customCtx, customMutation } from "convex-helpers/server/customFunctions";
import type { DataModel } from "./_generated/dataModel";
import { mutation as raw } from "./_generated/server";
const triggers = new Triggers<DataModel>();
triggers.register("notes", async (ctx, change) => {
  if (change.operation === "insert") await ctx.db.insert("audit", { op: "insert" });
});
export const mutation = customMutation(raw, customCtx(triggers.wrapDB));
`,
    );
    try {
      const r = migrateConvex({ src: dir, inPlace: true });
      const text = readFileSync(join(dir, "triggers.ts"), "utf8");
      expect(text).toBe(`import { defineTriggers } from "./_generated/server";\nimport { notesTrigger } from "./fns";\n${registry}\nexport default defineTriggers({\n  notes: [notesTrigger],\n});\n`);
      expect(r.written).toContain(join(dir, "triggers.ts"));
      expect(r.files.find((f) => f.file === "triggers.ts")).toMatchObject({ status: "converted", changes: { triggers: 1 } });
      expect(readFileSync(join(dir, "fns.ts"), "utf8")).toContain("export const notesTrigger = ");
      // Again: nothing left to write.
      expect(migrateConvex({ src: dir, inPlace: true }).written).toEqual([]);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  it("fails --check style when manual items remain (CLI)", async () => {
    const dir = join(TMP, `migrate-cli-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "convex"), { recursive: true });
    writeFileSync(join(dir, "convex", "a.ts"), `${SERVER_IMPORTS}export const m = mutation(async (ctx) => { await fetch("https://x"); });\n`);
    const { migrateCommand } = await import("../src/migrate/command.ts");
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await migrateCommand(["convex", "--dry-run", "--report", "r.md"])).toBe(0);
      expect(await migrateCommand(["convex", "--dry-run", "--check", "--report", "r.md"])).toBe(1);
      expect(readFileSync(join(dir, "r.md"), "utf8")).toContain("async-handler");
      expect(existsSync(join(dir, "ember"))).toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
