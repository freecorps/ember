// Typed shards (docs/design/dx.md §3.6): `shard:` on functions → OnShard in api.d.ts, routing in api.js, shards.{js,d.ts},
// client options typed by kind, and codegen checks against defineSchema({ shards }).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codegen, type CodegenResult } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  shards: { room: defineShard({ key: v.id("rooms") }), org: defineShard({ key: v.string() }) },
  tables: {
    rooms: defineTable({ name: v.string() }),
    messages: defineTable({ roomId: v.id("rooms"), body: v.string() }).shard("room", "roomId").index("by_room", ["roomId"]),
  },
});
`;

const CHAT = `import { v } from "@freecorps/ember-server";
import { action, mutation, query } from "./_generated/server";

/** The room's messages. */
export const list = query({
  shard: { room: "roomId" },
  args: { roomId: v.id("rooms") },
  handler: (ctx, { roomId }) => ctx.db.query("messages").withIndex("by_room", (q) => q.eq("roomId", roomId)).collect(),
});

export const send = mutation({
  shard: { room: "roomId" },
  args: { roomId: v.id("rooms"), body: v.string() },
  handler: (ctx, { roomId, body }) => ctx.db.insert("messages", { roomId, body }),
});

/** Org-wide stats: the caller names the org shard. */
export const stats = query({ shard: "org", handler: () => 1 });

/** ctx.env is typed from defineApp({ env }). */
export const charge = action({
  handler: async (ctx) => {
    const key: string = ctx.env.STRIPE_KEY;
    const mode: "test" | "live" | undefined = ctx.env.MODE;
    // @ts-expect-error not a string
    const n: number = ctx.env.STRIPE_KEY;
    return { key, mode, n };
  },
});
`;

const APP = `import { defineApp, v } from "@freecorps/ember-server";

export default defineApp({ env: { STRIPE_KEY: v.string(), MODE: v.optional(v.union(v.literal("test"), v.literal("live"))) } });
`;

const CLIENT = `import { EmberClient } from "@freecorps/ember-client";
import { api } from "./ember/_generated/api";
import { shards } from "./ember/_generated/shards";
import type { Id } from "./ember/_generated/dataModel";

declare const client: EmberClient;
declare const roomId: Id<"rooms">;

export async function main() {
  await client.query(api.chat.list, { roomId });
  await client.query(api.chat.list, { roomId }, { shard: shards.room(roomId) });
  await client.mutation(api.chat.send, { roomId, body: "x" });
  await client.query(api.chat.stats, {}, { shard: shards.org("acme") });
  await client.query(api.chat.stats, {}, { shard: "org:acme" });
  await client.query(api.chat.stats); // ERR the org shard must be named
  await client.query(api.chat.stats, {}, { shard: "room:r1" }); // ERR wrong kind
  await client.query(api.chat.list, { roomId }, { shard: "org:acme" }); // ERR wrong kind
  shards.room("plain"); // ERR the room key is an Id<"rooms">
}
`;

function check(project: Project, file: string) {
  const program = ts.createProgram([join(project.root, file)], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, customConditions: ["@freecorps/ember-source"], skipLibCheck: true, types: [], lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  });
  const sf = program.getSourceFile(join(project.root, file))!;
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === sf.fileName || d.file?.fileName.includes("_generated"));
  return { lines: [...new Set(diags.map((d) => (d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : -1)))].sort((a, b) => a - b), text: diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) };
}

describe("codegen: typed shards", () => {
  let project: Project;
  let result: CodegenResult;
  const gen = (f: string) => readFileSync(join(project.generatedDir, f), "utf8");

  beforeAll(async () => {
    project = sampleProject("codegen-shards");
    writeFileSync(join(project.dir, "schema.ts"), SCHEMA);
    writeFileSync(join(project.dir, "messages.ts"), "export {};\n");
    writeFileSync(join(project.dir, "crons.ts"), "import { cronJobs } from \"@freecorps/ember-server\";\nexport default cronJobs();\n");
    writeFileSync(join(project.dir, "chat.ts"), CHAT);
    writeFileSync(join(project.dir, "ember.config.ts"), APP);
    writeFileSync(join(project.root, "client.ts"), CLIENT);
    result = await codegen(project);
  });
  afterAll(() => cleanup(project));

  it("types ctx.env from defineApp({ env }) (no type errors in the modules) and lists it in the manifest", () => {
    expect(result.warnings).toEqual([]);
    expect(result.manifest.env).toEqual([{ name: "STRIPE_KEY", optional: false }, { name: "MODE", optional: true }]);
  });

  it("records the shard in the manifest and the contract", () => {
    expect(result.manifest.functions.find((f) => f.name === "chat:list")!.shard).toEqual({ kind: "room", fromArg: "roomId" });
    expect(result.contracts.get("chat:list")).toMatch(/, never> & OnShard<"room", "roomId">$/);
    expect(result.contracts.get("chat:stats")).toBe('Query<{}, number, never> & OnShard<"org">');
    expect(gen("api.d.ts")).toContain('@shard org (pass { shard: "org:<key>" })');
  });

  it("api.js routes references; shards.js names shards", async () => {
    const { api } = (await import(join(project.generatedDir, "api.js"))) as { api: Record<string, Record<string, unknown>> };
    const SHARD = Symbol.for("ember.functionShard");
    expect((api.chat!.list as Record<symbol, unknown>)[SHARD]).toEqual({ kind: "room", fromArg: "roomId" });
    expect((api.chat!.stats as Record<symbol, unknown>)[SHARD]).toEqual({ kind: "org" });
    const { routeShard } = await import("@freecorps/ember-values");
    expect(routeShard(api.chat!.list as never, { roomId: "rooms_1" }, undefined, "global:main")).toBe("room:rooms_1");
    expect(routeShard(api.chat!.stats as never, {}, undefined, "global:main")).toBeUndefined();
    expect(routeShard(api.chat!.stats as never, {}, undefined, "org:x")).toBe("org:x");
    const { shards } = (await import(join(project.generatedDir, "shards.js"))) as { shards: Record<string, (k?: string) => string> };
    expect(shards.org!("acme")).toBe("org:acme");
    expect(shards.global!()).toBe("global:main");
    expect(gen("shards.d.ts")).toContain('room(key: Id<"rooms">): `room:${string}`;');
  });

  it("client options are typed by the shard kind", () => {
    const expected = CLIENT.split("\n").map((l, i) => (l.includes("// ERR") ? i + 1 : 0)).filter(Boolean);
    const r = check(project, "client.ts");
    expect(r.lines).toEqual(expected);
  });

  it("refuses unknown kinds and a routing argument that is not the shard key", async () => {
    writeFileSync(join(project.dir, "chat.ts"), CHAT.replace('shard: "org"', 'shard: "team"'));
    await expect(codegen(project)).rejects.toThrow(/chat:stats: shard "team" is not in defineSchema\(\{ shards \}\)/);
    writeFileSync(join(project.dir, "chat.ts"), CHAT.replace('args: { roomId: v.id("rooms") },', 'args: { roomId: v.number() },'));
    await expect(codegen(project)).rejects.toThrow(/argument roomId does not match the "room" shard key/);
    writeFileSync(join(project.dir, "chat.ts"), CHAT);
  });
});
