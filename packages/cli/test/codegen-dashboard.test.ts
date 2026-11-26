// Dashboard screens in the codegen manifest (contracts.md "Telas declarativas"): a component's spec and the app's,
// with absolute function names, outside the schema hash; the app names its functions through ./_generated/api.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codegen, type CodegenResult } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const COUNTER = `import { componentBuilders, defineComponent, defineSchema, defineTable, v } from "@freecorps/ember-server";

const schema = defineSchema({ tables: { counters: defineTable({ key: v.string(), value: v.number() }).index("by_key", ["key"]) } });
const { query, mutation } = componentBuilders<typeof schema, undefined>();

const lib = {
  list: query({ args: {}, handler: (ctx) => ctx.db.query("counters").collect() }),
  reset: mutation({ args: { key: v.string() }, handler: (ctx, { key }) => {
    const row = ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (row) ctx.db.delete(row._id);
    return null;
  } }),
};

export const counter = defineComponent({
  name: "counter",
  schema,
  functions: { lib },
  dashboard: {
    label: "Counters",
    icon: "gauge",
    tabs: [{ id: "all", label: "All", blocks: [{ kind: "table", query: lib.list, columns: [{ label: "Key", path: "key" }, { label: "Value", path: "value", format: "number" }], rowActions: [{ label: "Reset", fn: lib.reset, fromRow: { key: "key" }, destructive: true }] }] }],
  },
});
`;

const APP_CONFIG = `import { defineApp } from "@freecorps/ember-server";
import { counter } from "../components/counter";
import { api, internal } from "./_generated/api";

export default defineApp({
  dashboard: {
    label: "Messages",
    scope: "global",
    tabs: [{ id: "channel", label: "Channel", blocks: [
      { kind: "stats", query: api.messages.count, args: { channel: "general" }, items: [{ label: "Messages", path: "", format: "number" }] },
      { kind: "table", query: api.messages.list, columns: [{ label: "Body", path: "body" }] },
      { kind: "actions", actions: [{ label: "Clean", fn: internal.messages.clean, args: { channel: "general" } }] },
    ] }],
  },
}).use(counter, { name: "hits" });
`;

const CLEAN = `import { v } from "@freecorps/ember-server";
import { components, internalMutation } from "./_generated/server";

export const clean = internalMutation({ args: { channel: v.string() }, handler: (ctx, { channel }) => {
  ctx.runMutation(components.hits.lib.reset, { key: channel });
  return null;
} });
`;

describe("codegen: dashboards", () => {
  let project: Project;
  let result: CodegenResult;

  beforeAll(async () => {
    project = sampleProject("dashboards");
    mkdirSync(join(project.root, "components"), { recursive: true });
    writeFileSync(join(project.root, "components", "counter.ts"), COUNTER);
    writeFileSync(join(project.dir, "ember.config.ts"), APP_CONFIG);
    // The app's own function next to the sample's messages module.
    const messages = readFileSync(join(project.dir, "messages.ts"), "utf8");
    writeFileSync(join(project.dir, "messages.ts"), messages.replace('import { action, internalMutation, mutation, query } from "./_generated/server";', 'import { action, components, internalMutation, mutation, query } from "./_generated/server";') + CLEAN.split("\n").slice(2).join("\n"));
    result = await codegen(project);
  }, 60_000);
  afterAll(() => cleanup(project));

  it("the manifest carries the app's spec and the install's, with absolute names", () => {
    const d = result.manifest.dashboards!;
    expect(d.map((x) => [x.key, x.component, x.scope, x.label])).toEqual([
      ["", null, "global", "Messages"],
      ["hits", "counter", "shard", "Counters"],
    ]);
    expect(Object.keys(d[0]!.functions)).toEqual(["messages:clean", "messages:count", "messages:list"]);
    expect(d[1]!.tabs[0]!.blocks[0]).toMatchObject({ query: "@hits/lib:list", rowActions: [{ fn: "@hits/lib:reset", fromRow: { key: "key" }, destructive: true }] });
    expect(d[1]!.functions["@hits/lib:reset"]).toMatchObject({ type: "mutation", destructive: true, args: { kind: "object" } });
    const written = JSON.parse(readFileSync(join(project.generatedDir, "manifest.json"), "utf8")) as { dashboards: unknown };
    expect(written.dashboards).toEqual(d);
    // The schema (and its hash) says nothing about screens.
    expect(JSON.stringify(result.manifest.schema)).not.toContain("Counters");
  });

  it("ember.config.ts naming functions through ./_generated/api type-checks (no cycle with components)", () => {
    const program = ts.createProgram([join(project.dir, "ember.config.ts"), join(project.dir, "messages.ts")], {
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
    const diags = ts.getPreEmitDiagnostics(program).filter((x) => x.file?.fileName.startsWith(project.root));
    expect(diags.map((x) => `${x.file?.fileName}: ${ts.flattenDiagnosticMessageText(x.messageText, "\n")}`)).toEqual([]);
  });

  it("a spec naming a function the app does not have fails codegen", async () => {
    writeFileSync(join(project.dir, "ember.config.ts"), APP_CONFIG.replace("internal.messages.clean", "internal.messages.gone"));
    await expect(codegen(project)).rejects.toThrow(/defineApp: dashboard tabs\[0\]\.blocks\[2\]\.actions\[0\]\.fn: messages:gone is not a function of this app/);
    writeFileSync(join(project.dir, "ember.config.ts"), APP_CONFIG);
  });
});
