// `.replicated()` tables (PLAN §22 L5) through codegen: typed like any table (documents, ids, indexes), with
// `ctx.db.replicaStatus` and `ctx.shards` typed in the modules; writes stay allowed in the types (the runtime refuses
// them outside global:main with `ReadOnlyTable`).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codegen, type CodegenResult } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  shards: { org: defineShard({ key: v.string() }) },
  tables: {
    fxRates: defineTable({ base: v.string(), quote: v.string(), rate: v.number() }).index("by_pair", ["base", "quote"]).replicated(),
    plans: defineTable({ name: v.string() }).replicated({ to: ["org"] }),
    quotes: defineTable({ org: v.string(), rateId: v.id("fxRates"), amount: v.number() }).shard("org", "org"),
  },
});
`;

const RATES = `import { v } from "@freecorps/ember-server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalQuery, mutation, query } from "./_generated/server";

export const rate = query({
  shard: "org",
  args: { base: v.string(), quote: v.string() },
  handler: (ctx, { base, quote }) => {
    const r: Doc<"fxRates"> | null = ctx.db.query("fxRates").withIndex("by_pair", (q) => q.eq("base", base).eq("quote", quote)).first();
    const s = ctx.db.replicaStatus("fxRates");
    const state: "source" | "off" | "pending" | "syncing" | "ready" = s.state;
    const at: number | null = s.updatedAt;
    return { rate: r?.rate ?? null, state, at, seq: s.seq };
  },
});

export const convert = mutation({
  shard: { org: "org" },
  args: { org: v.string(), rateId: v.id("fxRates"), amount: v.number() },
  handler: (ctx, { org, rateId, amount }): Id<"quotes"> => {
    const r = ctx.db.get(rateId);
    return ctx.db.insert("quotes", { org, rateId, amount: amount * (r?.rate ?? 0) });
  },
});

export const count = internalQuery({ shard: "org", args: {}, handler: (ctx) => ctx.db.query("quotes").collect().length });

export const report = action({
  handler: async (ctx) => {
    const page = await ctx.shards.list("org", { limit: 10 });
    const out = await ctx.shards.fanOut("org", internal.rates.count, {}, { concurrency: 4 });
    const first = out[0];
    const n: number = first && first.ok ? first.value : 0;
    return { shards: page.shards.map((s) => s.shard), next: page.next, n };
  },
});
`;

describe("codegen: .replicated() tables", () => {
  let project: Project;
  let result: CodegenResult;
  const gen = (f: string) => readFileSync(join(project.generatedDir, f), "utf8");

  beforeAll(async () => {
    project = sampleProject("codegen-replicated");
    writeFileSync(join(project.dir, "schema.ts"), SCHEMA);
    writeFileSync(join(project.dir, "messages.ts"), "export {};\n");
    writeFileSync(join(project.dir, "crons.ts"), "import { cronJobs } from \"@freecorps/ember-server\";\nexport default cronJobs();\n");
    writeFileSync(join(project.dir, "rates.ts"), RATES);
    result = await codegen(project);
  });
  afterAll(() => cleanup(project));

  it("types them like any table, and ctx.db.replicaStatus / ctx.shards in the modules", () => {
    expect(result.warnings).toEqual([]);
    expect((result.manifest.schema as { tables: Record<string, { replicated?: unknown }> }).tables.fxRates!.replicated).toEqual({});
    expect((result.manifest.schema as { tables: Record<string, { replicated?: unknown }> }).tables.plans!.replicated).toEqual({ to: ["org"] });
    expect(gen("dataModel.d.ts")).toMatch(/fxRates/);
    expect(result.contracts.get("rates:report")!.replace(/\s+/g, " ")).toMatch(/shards: string\[\]; next: string \| null; n: number;/);
  });
});
