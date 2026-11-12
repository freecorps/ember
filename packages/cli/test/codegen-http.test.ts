// Typed HTTP routes → _generated/http (typed fetch client), OpenAPI, the AI guide and the args shapes for clients
// (docs/design/dx.md §3.10–3.12).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codegen, type CodegenResult } from "../src/codegen/index.ts";
import { openApi } from "../src/codegen/openapi.ts";
import type { Project } from "../src/config.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const HTTP = `import { httpRouter, v } from "@freecorps/ember-server";
import { errors } from "./errors";

export default httpRouter().route({
  method: "GET",
  path: "/channels/:channel/messages",
  description: "The latest messages of a channel",
  params: { channel: v.string() },
  query: { limit: v.number().int().min(1).max(100).default(20) },
  returns: v.array(v.object({ body: v.string(), at: v.number() })),
  errors: [errors.MessageTooLong],
  handler: async (ctx, { params, query }) => {
    void ctx;
    return [{ body: params.channel + query.limit, at: 1 }];
  },
}).route({
  method: "POST",
  path: "/channels/:channel/messages",
  params: { channel: v.string() },
  body: { body: v.string().min(1).max(2000).describe("Markdown text") },
  returns: v.object({ id: v.string() }),
  handler: async (_ctx, { body }) => ({ id: body.body }),
});
`;

const CLIENT = `import { createHttpClient } from "./ember/_generated/http";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};
const http = createHttpClient({ url: "https://x.dev" });

export async function main() {
  const list = await http.request("GET /channels/:channel/messages", { params: { channel: "a" }, query: { limit: 5 } });
  assert<Equals<typeof list, { body: string; at: number }[]>>();
  await http.request("GET /channels/:channel/messages", { params: { channel: "a" } });
  const sent = await http.request("POST /channels/:channel/messages", { params: { channel: "a" }, body: { body: "hi" } });
  assert<Equals<typeof sent, { id: string }>>();
  await http.request("GET /channels/:channel/messages"); // ERR params required
  await http.request("POST /channels/:channel/messages", { params: { channel: "a" } }); // ERR body required
  await http.request("GET /nope", {}); // ERR unknown route
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

describe("codegen: typed HTTP routes, OpenAPI, AI guide", () => {
  let project: Project;
  let result: CodegenResult;
  const gen = (f: string) => readFileSync(join(project.generatedDir, f), "utf8");

  beforeAll(async () => {
    project = sampleProject("codegen-http");
    writeFileSync(join(project.dir, "http.ts"), HTTP);
    writeFileSync(join(project.root, "client.ts"), CLIENT);
    result = await codegen(project);
  });
  afterAll(() => cleanup(project));

  it("lists typed routes in the manifest and types them in http.d.ts", () => {
    expect(result.warnings).toEqual([]);
    expect(result.manifest.routes?.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /channels/:channel/messages", "POST /channels/:channel/messages"]);
    expect(gen("http.d.ts")).toContain('"GET /channels/:channel/messages": {');
    expect(gen("http.d.ts")).toContain("/** integer, 1..100. @default 20 */\n      limit?: number;");
    expect(gen("http.d.ts")).toContain("/** Markdown text. 1–2000 characters */\n      body: string;");
  });

  it("client calls type-check exactly (// ERR lines fail)", () => {
    const expected = CLIENT.split("\n").map((l, i) => (l.includes("// ERR") ? i + 1 : 0)).filter(Boolean);
    expect(check(project, "client.ts").lines).toEqual(expected);
  });

  it("the generated client builds URLs, encodes bodies and decodes typed errors", async () => {
    const { createHttpClient } = (await import(join(project.generatedDir, "http.js"))) as { createHttpClient: (o: unknown) => { request(r: string, i?: unknown): Promise<unknown> } };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === "POST") return new Response(JSON.stringify({ error: { code: "MessageTooLong", message: "too long", data: { max: 1 }, kind: "app" } }), { status: 400 });
      return new Response(JSON.stringify([{ body: "x", at: 1 }]), { status: 200 });
    };
    const http = createHttpClient({ url: "https://x.dev/", fetch, headers: async () => ({ authorization: "Bearer t" }) });
    expect(await http.request("GET /channels/:channel/messages", { params: { channel: "a b" }, query: { limit: 5 } })).toEqual([{ body: "x", at: 1 }]);
    expect(calls[0]!.url).toBe("https://x.dev/channels/a%20b/messages?limit=5");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer t");
    await expect(http.request("POST /channels/:channel/messages", { params: { channel: "a" }, body: { body: "zz" } })).rejects.toMatchObject({ code: "MessageTooLong", kind: "app", data: { max: 1 }, outcome: "rejected" });
    expect(calls[1]!.init.body).toBe('{"body":"zz"}');
  });

  it("OpenAPI: functions and routes, with refinements and error schemas", () => {
    const doc = openApi(result.manifest, { title: "chat" }) as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/api/mutation/messages:send"].post.requestBody.content["application/json"].schema).toMatchObject({ type: "object", required: ["channel", "author", "body"] });
    expect(doc.paths["/api/mutation/messages:send"].post.responses["400"].content["application/json"].schema.properties.error.oneOf[0]).toEqual({ $ref: "#/components/schemas/MessageTooLong" });
    const get = doc.paths["/channels/{channel}/messages"].get;
    expect(get.parameters).toEqual([
      { name: "channel", in: "path", required: true, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { anyOf: [{ type: "integer", minimum: 1, maximum: 100 }, expect.anything()] } },
    ]);
    expect(doc.paths["/channels/{channel}/messages"].post.requestBody.content["application/json"].schema.properties.body).toMatchObject({ minLength: 1, maxLength: 2000, description: "Markdown text" });
    expect(doc.components.schemas.MessageTooLong.properties.data).toMatchObject({ type: "object", required: ["max"] });
  });

  it("writes the AI guide and the client args shapes", async () => {
    const guide = gen("ai/guidelines.md");
    expect(guide).toContain("# This Ember app, for coding agents");
    expect(guide).toContain("### `messages`");
    expect(guide).toContain("- `by_channel` (channel)");
    expect(guide).toContain("- `MessageTooLong` — data `{ max: number; }`: This message is too long.");
    expect(guide).toMatch(/- `api\.messages\.send` — Mutation<\{ channel: string; author: string; body: string; \}, \{ id: Id<"messages">; at: number; \}, E\.MessageTooLong>/);
    expect(guide).toContain("- `GET /channels/:channel/messages`: The latest messages of a channel");
    const { argShapes } = (await import(join(project.generatedDir, "validators.js"))) as { argShapes: Record<string, unknown> };
    expect(Object.keys(argShapes).sort()).toEqual(["messages:count", "messages:digest", "messages:edit", "messages:list", "messages:send"]);
  });
});
