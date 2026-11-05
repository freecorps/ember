import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerEntrySource } from "../src/build.ts";
import { codegen, type CodegenResult } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { componentBindings, rateLimitNamespace } from "../src/deploy/plan.ts";
import { componentQueues, queueBindings } from "../src/deploy/queues.ts";
import { discover } from "../src/modules.ts";
import { cleanup, sampleProject } from "./helpers.ts";

// A component living outside ember/ (like an npm package would).
const COUNTER = `import { componentBuilders, defineComponent, defineSchema, defineTable, v } from "@freecorps/ember-server";

const schema = defineSchema({ tables: { counters: defineTable({ key: v.string(), value: v.number() }).index("by_key", ["key"]) } });
const { query, mutation, internalMutation } = componentBuilders<typeof schema, { step: number }>();

export const counter = defineComponent({
  name: "counter",
  schema,
  config: v.object({ step: v.number() }),
  bindings: (config, name) => (config.step > 100 ? [{ type: "ratelimit" as const, name: "RL_" + name, limit: 10, period: 60 as const }] : []),
  // Hooks: a cron per install (relative fn), a queue it owns, the email() handler.
  crons: (config) => (config.step > 100 ? [{ name: "sweep", schedule: "0 3 * * *", shard: "global:main", fn: "lib:reset" }] : []),
  queues: { events: { consumer: { maxBatchSize: 5 }, handler: async (ctx, batch) => { batch.ackAll(); void ctx.component.config.step; } } },
  email: { match: (to) => to.startsWith("count@"), handler: async (_ctx, message) => message.setReject("no") },
  functions: {
    lib: {
      add: mutation({
        args: { key: v.string(), by: v.optional(v.number()) },
        handler: (ctx, { key, by }) => {
          const row = ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).unique();
          const value = (row?.value ?? 0) + (by ?? ctx.component.config.step);
          if (row) ctx.db.patch(row._id, { value });
          else ctx.db.insert("counters", { key, value });
          return value;
        },
      }),
      get: query({ args: { key: v.string() }, handler: (ctx, { key }) => ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).unique() }),
      reset: internalMutation({ args: {}, handler: () => null }),
    },
  },
});
`;

const APP_CONFIG = `import { defineApp } from "@freecorps/ember-server";
import { counter } from "../components/counter";

export default defineApp().use(counter, { name: "hits", config: { step: 1 } }).use(counter, { name: "big", config: { step: 500 } });
`;

const HTTP = `import { httpRouter } from "@freecorps/ember-server";
import { httpAction } from "./_generated/server";

const http = httpRouter();
http.route({ path: "/ping", method: "GET", handler: httpAction(async () => new Response("pong")) });
export default http;
`;

// Server code using the typed `components` references.
const USE = `import { components, mutation, query } from "./_generated/server";
import { v } from "@freecorps/ember-server";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};

export const hit = mutation({
  args: { key: v.string() },
  handler: (ctx, { key }) => {
    const n = ctx.runMutation(components.hits.lib.add, { key });
    assert<Equals<typeof n, number>>();
    return n;
  },
});

export const peek = query({
  args: { key: v.string() },
  handler: (ctx, { key }) => {
    const row = ctx.runQuery(components.big.lib.get, { key });
    return row?.value ?? 0;
  },
});
`;

// Every "// ERR" line must fail, and no other line.
const USE_ERROR = `import { components, mutation } from "./ember/_generated/server";

export const bad = mutation({
  args: {},
  handler: (ctx) => {
    ctx.runMutation(components.hits.lib.missing, { key: "a" }); // ERR unknown component function
    ctx.runMutation(components.hits.lib.add, { key: 1 }); // ERR wrong arg type
    ctx.runMutation(components.hits.lib.add, { key: "a", extra: true }); // ERR unknown arg
    ctx.runMutation(components.hits.lib.get, { key: "a" }); // ERR query used as a mutation
    ctx.runMutation(components.hits.lib.reset, {}); // ERR internal function of the component
    ctx.runMutation(components.nope.lib.add, { key: "a" }); // ERR component not installed
    const s: string = ctx.runMutation(components.hits.lib.add, { key: "a" }); // ERR wrong return type
    void s;
    return null;
  },
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
  return { lines: [...new Set(lines)].sort((a, b) => a - b), text: diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) };
}

describe("codegen with components", () => {
  let project: Project;
  let result: CodegenResult;
  const gen = (f: string) => readFileSync(join(project.generatedDir, f), "utf8");

  beforeAll(async () => {
    project = sampleProject("components");
    mkdirSync(join(project.root, "components"), { recursive: true });
    writeFileSync(join(project.root, "components", "counter.ts"), COUNTER);
    writeFileSync(join(project.dir, "ember.config.ts"), APP_CONFIG);
    writeFileSync(join(project.dir, "http.ts"), HTTP);
    writeFileSync(join(project.dir, "hits.ts"), USE);
    writeFileSync(join(project.root, "use_error.ts"), USE_ERROR);
    result = await codegen(project);
  }, 60_000);
  afterAll(() => cleanup(project));

  it("discovers ember.config.ts and http.ts (not as function modules) and wires them into the Worker entry", () => {
    const files = discover(project.dir);
    expect(files.appConfig).toMatch(/ember\.config\.ts$/);
    expect(files.http).toMatch(/http\.ts$/);
    expect(files.modules.map((m) => m.path)).not.toContain("http");
    const entry = workerEntrySource(files);
    expect(entry).toContain("import app from");
    expect(entry).toContain("import http from");
    expect(entry).toContain("createEmberWorker({ schema, functions, crons, auth, app, http })");
  });

  it("the manifest has the composed schema and the component functions; api/dataModel stay app-only", () => {
    expect(result.warnings).toEqual([]);
    const m = result.manifest;
    expect(Object.keys(m.schema.tables).sort()).toEqual(["big$counters", "hits$counters", "messages"]);
    expect(m.schema.components).toMatchObject({ hits: { component: "counter" }, big: { component: "counter", bindings: [{ type: "ratelimit", name: "RL_big" }] } });
    const comp = m.functions.filter((f) => f.component);
    expect(comp.map((f) => [f.name, f.component, f.visibility])).toEqual([
      ["@big/lib:add", "big", "public"],
      ["@big/lib:get", "big", "public"],
      ["@big/lib:reset", "big", "internal"],
      ["@hits/lib:add", "hits", "public"],
      ["@hits/lib:get", "hits", "public"],
      ["@hits/lib:reset", "hits", "internal"],
    ]);
    expect(gen("api.d.ts")).not.toContain("@hits");
    expect(gen("api.d.ts")).toContain("hits: {"); // the app's own module ember/hits.ts
    expect(gen("dataModel.d.ts")).not.toContain("counters");
    expect(gen("server.d.ts")).toContain('import type app from "../ember.config";');
    expect(gen("server.d.ts")).toContain("export declare const components: ComponentsApi<typeof app>;");
    expect(gen("server.js")).toContain("anyComponents as components");
  });

  it("typed component references check in server code", () => {
    expect(check(project, "ember/hits.ts").text).toEqual([]);
  });

  it("wrong component function names, arguments and visibility fail exactly on the // ERR lines", () => {
    const expected = USE_ERROR.split("\n")
      .map((l, i) => (l.includes("// ERR") ? i + 1 : 0))
      .filter(Boolean);
    expect(check(project, "use_error.ts").lines).toEqual(expected);
  });

  it("component crons are in the manifest with absolute names; queues and the email hook in manifest.components", () => {
    const m = result.manifest;
    expect(m.crons.filter((c) => c.name.startsWith("@"))).toEqual([{ name: "@big/sweep", schedule: "0 3 * * *", shard: "global:main", fn: "@big/lib:reset" }]);
    expect(m.schema.components).toMatchObject({
      hits: { queues: [{ name: "events", queue: "hits-events", binding: "EMBER_Q_HITS_EVENTS", consumer: { maxBatchSize: 5 } }], email: true },
      big: { queues: [{ name: "events", queue: "big-events", binding: "EMBER_Q_BIG_EVENTS" }], email: true },
    });
    const qs = componentQueues(m.schema.components as any, "chat", "prod");
    expect(qs.map((q) => [q.queue, q.binding])).toEqual([
      ["ember-chat-prod-hits-events", "EMBER_Q_HITS_EVENTS"],
      ["ember-chat-prod-big-events", "EMBER_Q_BIG_EVENTS"],
    ]);
    expect(queueBindings(qs)).toContainEqual({ type: "queue", name: "EMBER_Q_BIG_EVENTS", queue_name: "ember-chat-prod-big-events" });
    expect(() => componentQueues({ x: { queues: [{ name: "e", queue: "x".repeat(60), binding: "B" }] } }, "chat", "prod")).toThrow(/valid Cloudflare queue name/);
  });

  it("deploy turns component bindings into Rate Limiting bindings with a stable namespace per environment", () => {
    const b = componentBindings(result.manifest.schema.components as any, "chat", "prod");
    expect(b).toEqual([{ type: "ratelimit", name: "RL_big", namespace_id: rateLimitNamespace("chat", "prod", "RL_big"), simple: { limit: 10, period: 60 } }]);
    expect(rateLimitNamespace("chat", "prod", "RL_big")).not.toBe(rateLimitNamespace("chat", "dev", "RL_big"));
    expect(Number(b[0]!.type === "ratelimit" && b[0]!.namespace_id)).toBeGreaterThan(0);
    expect(() => componentBindings({ a: { bindings: [{ type: "ratelimit", name: "X", limit: 1, period: 30 }] } }, "p", "e")).toThrow(/period/);
    expect(componentBindings({ a: { bindings: [{ type: "send_email", name: "EMAIL", allowed_sender_addresses: ["x@y.z"] }] } }, "p", "e")).toEqual([
      { type: "send_email", name: "EMAIL", allowed_sender_addresses: ["x@y.z"] },
    ]);
  });
});

describe("codegen without ember.config.ts", () => {
  it("emits an empty components type", async () => {
    const project = sampleProject("nocomponents");
    try {
      await codegen(project);
      const dts = readFileSync(join(project.generatedDir, "server.d.ts"), "utf8");
      expect(dts).toContain("export declare const components: {};");
      expect(dts).not.toContain('from "../ember.config"');
    } finally {
      cleanup(project);
    }
  }, 60_000);
});
