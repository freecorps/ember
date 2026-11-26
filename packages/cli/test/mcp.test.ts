// `ember mcp`: the JSON-RPC/MCP protocol (handshake, tools/list, errors, stdio framing) and every tool, on the sample
// project of `ember init` (code tools) and fakes of the runtime's admin endpoints / Cloudflare (live tools).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../src/config.ts";
import { emberMcpServer, McpServer, PROTOCOL_VERSIONS, serveStdio, validate, type JsonSchema } from "../src/mcp/index.ts";
import { fakeAccount } from "./fake-account.ts";
import { cleanup, sampleProject } from "./helpers.ts";

let project: Project;
beforeAll(() => {
  project = sampleProject("mcp");
  // A deployed prod and a preview (`ember run --env` / resolveBaseUrl read .ember/deployments.json).
  mkdirSync(project.stateDir, { recursive: true });
  writeFileSync(join(project.stateDir, "deployments.json"), JSON.stringify({ prod: { worker: "ember-chat-prod", url: "https://ember-chat-prod.acme.workers.dev", versionId: "v1", at: "x" } }));
});
afterAll(() => cleanup(project));

const DEV = "http://127.0.0.1:8787";

/** The admin endpoints the live tools call, recorded. */
function fakeRuntime() {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: url.href, method: init?.method ?? "GET", ...(body ? { body } : {}) });
    const auth = (init?.headers as Record<string, string>)?.authorization;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (auth !== "Bearer adm") return json({ ok: false, error: { code: "unauthorized", message: "bad admin token" } }, 401);
    if (url.pathname === "/api/_ember/run") {
      if (body.fn === "messages:send" && body.args.body === "") return json({ ok: false, error: { code: "ValidationError", message: "body: empty" }, ms: 0.4, type: "mutation", as: null }, 400);
      return json({ ok: true, value: body.fn === "messages:list" ? [{ _id: "m1", body: "hi" }] : "m2", ms: 1.25, type: "query", as: body.as?.subject ?? null });
    }
    if (url.pathname === "/api/_ember/data") {
      if (!url.searchParams.get("table")) return json({ ok: true, tables: [{ name: "messages", kind: "schema", rows: 3 }] });
      const after = url.searchParams.get("cursor");
      return json(after ? { ok: true, table: "messages", kind: "schema", rows: [{ _id: "m3" }], cursor: null, done: true } : { ok: true, table: "messages", kind: "schema", rows: [{ _id: "m1" }, { _id: "m2" }], cursor: "2", done: false });
    }
    if (url.pathname === "/api/_ember/status")
      return json({ ok: true, expectedVersion: "v".repeat(64), shards: [{ shard: url.searchParams.get("shard"), expectedVersion: "v".repeat(64), schemaVersion: "v".repeat(64), ready: true, staged: [], migrationError: null, version: 9, databaseSize: 4096 }], restores: [] });
    if (url.pathname === "/api/_ember/inspect")
      return json({ ok: true, shard: { epoch: "e", subs: 1, queries: 1, dormant: 0, jobs: [], finishedJobs: 0, alarm: null, backfilling: false, bookmarks: 0, files: { total: 0 }, outbox: { pending: 0, inFlight: 0, parked: 0 } } });
    return json({ ok: false, error: { code: "not_found", message: url.pathname } }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

let nextId = 1;
const rpc = async (s: McpServer, method: string, params?: unknown) => (await s.handle({ jsonrpc: "2.0", id: nextId++, method, ...(params !== undefined ? { params } : {}) })) as any;
const call = async (s: McpServer, name: string, args: Record<string, unknown> = {}) => (await rpc(s, "tools/call", { name, arguments: args })).result as { content: Array<{ type: string; text: string }>; structuredContent?: any; isError: boolean };

function server(extra: Parameters<typeof emberMcpServer>[1] = {}) {
  const rt = fakeRuntime();
  return { rt, s: emberMcpServer(project, { adminToken: "adm", fetch: rt.fetchImpl, devUrl: () => DEV, ...extra }) };
}

describe("MCP protocol", () => {
  it("initialize: negotiates the protocol version and announces tools; notifications get no answer; ping", async () => {
    const { s } = server();
    const init = await rpc(s, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.jsonrpc).toBe("2.0");
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(init.result.serverInfo).toMatchObject({ name: "ember", title: "Ember (chat)" });
    expect(init.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(init.result.instructions).toMatch(/"local" \(default\) is the project's running `ember dev`/);
    // A version the server does not speak: it answers with its newest.
    expect((await rpc(s, "initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
    expect(await s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect((await rpc(s, "ping")).result).toEqual({});
  });

  it("tools/list: every tool with a description and an object input schema", async () => {
    const { s } = server();
    const { tools } = (await rpc(s, "tools/list")).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["schema", "functions", "types", "run", "data", "shards", "logs", "metrics", "codegen"]);
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
    expect(tools.find((t: { name: string }) => t.name === "run").annotations).toMatchObject({ destructiveHint: true });
    expect(tools.find((t: { name: string }) => t.name === "data").annotations).toMatchObject({ readOnlyHint: true });
  });

  it("JSON-RPC errors: parse, invalid request, unknown method, unknown tool; bad arguments are a tool error", async () => {
    const { s } = server();
    expect(((await s.handleLine("{nope")) as any).error.code).toBe(-32700);
    expect(((await s.handleLine(JSON.stringify({ id: 1, method: "ping" }))) as any).error.code).toBe(-32600);
    expect((await rpc(s, "resources/list")).error.code).toBe(-32601);
    expect((await rpc(s, "tools/call", { name: "nope" })).error).toMatchObject({ code: -32602, message: "Unknown tool: nope" });
    const bad = await call(s, "data", { limit: 500, table: 3, extra: true });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/arguments\.limit: must be <= 200/);
    expect(bad.content[0]!.text).toMatch(/arguments\.table: must be a string/);
    expect(bad.content[0]!.text).toMatch(/arguments\.extra: unknown property/);
    expect((await call(s, "types", {})).content[0]!.text).toMatch(/arguments\.name: is required/);
    // A batch: one answer per request, none for the notification.
    const batch = (await s.handleLine(JSON.stringify([{ jsonrpc: "2.0", id: "a", method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]))) as any[];
    expect(batch).toEqual([{ jsonrpc: "2.0", id: "a", result: {} }]);
    // A response from the client (the server sends no requests) is ignored.
    expect(await s.handle({ jsonrpc: "2.0", id: 9, result: {} })).toBeNull();
  });

  it("validate: the JSON Schema subset tool inputs use", () => {
    const schema: JsonSchema = { type: "object", properties: { n: { type: "integer", minimum: 1 }, s: { type: "string", pattern: "^a", enum: ["ab", "ac"] }, l: { type: "array", items: { type: "boolean" } } }, required: ["n"], additionalProperties: false };
    expect(validate(schema, { n: 1, s: "ab", l: [true] })).toEqual([]);
    expect(validate(schema, { n: 1.5 })).toEqual(["arguments.n: must be an integer"]);
    expect(validate(schema, { n: 0, s: "b", l: [1] })).toEqual(["arguments.n: must be >= 1", "arguments.s: must match ^a", 'arguments.s: must be one of "ab", "ac"', "arguments.l[0]: must be a boolean"]);
    expect(validate(schema, [])).toEqual(["arguments: must be an object"]);
  });

  it("stdio: one JSON message per line in, one per line out; console.log never reaches the protocol stream", async () => {
    const { s } = server();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (b: Buffer) => lines.push(...b.toString().split("\n").filter(Boolean)));
    const done = serveStdio(s, input, output);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    input.end();
    await done;
    const msgs = lines.map((l) => JSON.parse(l));
    expect(msgs.map((m) => m.id).sort()).toEqual([1, 2]);
    expect(msgs.find((m) => m.id === 1).result.protocolVersion).toBe("2025-11-25");
    expect(msgs.find((m) => m.id === 2).result.tools).toHaveLength(9);
  });
});

describe("MCP tools", () => {
  it("schema, functions, types: from the code on disk", async () => {
    const { s } = server();
    const schema = await call(s, "schema");
    expect(schema.isError).toBe(false);
    const messages = schema.structuredContent.tables.find((t: { name: string }) => t.name === "messages");
    expect(messages.shard).toBe("global");
    expect(messages.indexes).toContainEqual({ name: "by_channel", kind: "db", fields: ["channel"] });
    expect(schema.content[0]!.text).toMatch(/index by_channel \[db\] \(channel\)/);
    expect((await call(s, "schema", { table: "nope" })).content[0]!.text).toMatch(/No table nope \(tables: messages\)/);

    const fns = await call(s, "functions", { type: "mutation" });
    expect(fns.structuredContent.functions.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(["messages:send", "messages:edit", "messages:trim"]));
    expect(fns.structuredContent.functions.every((f: { type: string }) => f.type === "mutation")).toBe(true);
    expect((await call(s, "functions", { visibility: "internal" })).structuredContent.functions.map((f: { name: string }) => f.name)).toEqual(["messages:trim"]);

    const t = await call(s, "types", { name: "messages.send" });
    expect(t.structuredContent.name).toBe("messages:send");
    expect(t.content[0]!.text).toMatch(/^messages:send \(public mutation/);
    expect(t.structuredContent.contract).toMatch(/body/);
    expect((await call(s, "types", { name: "messages:sendd" })).content[0]!.text).toMatch(/No function messages:sendd/);
  }, 120_000);

  it("run: local ember dev by default, through the admin function runner", async () => {
    const { s, rt } = server();
    const r = await call(s, "run", { fn: "messages:list", args: { channel: "general" } });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({ ok: true, env: "local", shard: "global:main", value: [{ _id: "m1", body: "hi" }], ms: 1.25 });
    expect(rt.calls.at(-1)).toEqual({ url: `${DEV}/api/_ember/run`, method: "POST", body: { fn: "messages:list", args: { channel: "general" }, shard: "global:main" } });
    // A mutation runs on the local dev without any confirmation; acting as a user passes `as`.
    expect((await call(s, "run", { fn: "messages:send", args: { channel: "c", body: "x" }, as: { subject: "u1" } })).structuredContent.value).toBe("m2");
    expect(rt.calls.at(-1)!.body.as).toEqual({ subject: "u1" });
    // The function's own failure: a tool error with its code.
    const failed = await call(s, "run", { fn: "messages:send", args: { channel: "c", body: "" } });
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).toMatch(/ValidationError: body: empty/);
    expect((await call(s, "run", { fn: "nope:x" })).content[0]!.text).toMatch(/No function nope:x/);
  }, 120_000);

  it("run on a deployed environment: off without --allow-run; mutations need confirm: <env>", async () => {
    const off = server({ allowEnv: ["prod"] });
    const denied = await call(off.s, "run", { fn: "messages:list", env: "prod" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toMatch(/--allow-run prod/);
    expect(off.rt.calls).toHaveLength(0);

    const on = server({ allowRun: ["prod"] });
    // A query needs only the flag.
    expect((await call(on.s, "run", { fn: "messages:list", env: "prod" })).structuredContent.env).toBe("prod");
    expect(on.rt.calls.at(-1)!.url).toBe("https://ember-chat-prod.acme.workers.dev/api/_ember/run");
    const n = on.rt.calls.length;
    const unconfirmed = await call(on.s, "run", { fn: "messages:send", env: "prod", args: { channel: "c", body: "x" } });
    expect(unconfirmed.isError).toBe(true);
    expect(unconfirmed.content[0]!.text).toMatch(/changes real data\. Ask the user, then call again with confirm: "prod"/);
    expect((await call(on.s, "run", { fn: "messages:send", env: "prod", args: { channel: "c", body: "x" }, confirm: "dev" })).isError).toBe(true);
    expect(on.rt.calls).toHaveLength(n);
    expect((await call(on.s, "run", { fn: "messages:send", env: "prod", args: { channel: "c", body: "x" }, confirm: "prod" })).isError).toBe(false);
    expect(on.rt.calls).toHaveLength(n + 1);
    // An unknown environment, or no ember dev running.
    expect((await call(on.s, "run", { fn: "messages:list", env: "staging" })).content[0]!.text).toMatch(/Unknown environment "staging"/);
    const noDev = server({ devUrl: () => null });
    expect((await call(noDev.s, "run", { fn: "messages:list" })).content[0]!.text).toMatch(/No `ember dev` is running/);
    const noToken = emberMcpServer(project, { fetch: fakeRuntime().fetchImpl, devUrl: () => DEV, adminToken: "" });
    expect((await call(noToken, "run", { fn: "messages:list" })).content[0]!.text).toMatch(/EMBER_ADMIN_TOKEN/);
  }, 120_000);

  it("data: tables of a shard, then pages of a table; deployed environments need --allow-env", async () => {
    const { s, rt } = server();
    const tables = await call(s, "data", {});
    expect(tables.structuredContent.tables).toEqual([{ name: "messages", kind: "schema", rows: 3 }]);
    const page = await call(s, "data", { table: "messages", limit: 2 });
    expect(page.structuredContent).toMatchObject({ table: "messages", rows: [{ _id: "m1" }, { _id: "m2" }], cursor: "2", done: false });
    expect(page.content[0]!.text).toMatch(/more: cursor "2"/);
    expect(rt.calls.at(-1)!.url).toBe(`${DEV}/api/_ember/data?shard=global%3Amain&table=messages&limit=2`);
    const last = await call(s, "data", { table: "messages", cursor: "2" });
    expect(last.structuredContent).toMatchObject({ rows: [{ _id: "m3" }], cursor: null, done: true });
    expect((await call(s, "data", { env: "prod" })).content[0]!.text).toMatch(/--allow-env prod/);
    const prod = server({ allowEnv: ["prod"] });
    expect((await call(prod.s, "data", { env: "prod" })).structuredContent.env).toBe("prod");
  });

  it("shards: one shard live (local or deployed); the catalog of a deployed environment", async () => {
    const cf = fakeAccount();
    const { D1Registry } = await import("../src/registry.ts");
    const reg = await D1Registry.open(cf.client, "ember-registry");
    await reg.exec("INSERT INTO shards (project, env, shard, kind, key, schema_version, db_size, last_write, reported_at) VALUES ('chat', 'prod', 'org:acme', 'org', 'acme', 'v', 2048, 1, 1)");
    const { s } = server({ allowEnv: ["prod"], registry: async () => reg });
    const live = await call(s, "shards", { shard: "org:acme" });
    expect(live.structuredContent).toMatchObject({ env: "local", shard: "org:acme", status: { databaseSize: 4096, version: 9 } });
    expect(live.content[0]!.text).toMatch(/size\s+4\.0 KiB/);
    const cat = await call(s, "shards", { env: "prod" });
    expect(cat.structuredContent.shards).toEqual([expect.objectContaining({ shard: "org:acme", dbSize: 2048 })]);
    expect((await call(s, "shards", {})).content[0]!.text).toMatch(/not the local `ember dev`/);
  });

  it("logs: tails the deployed Worker for a few seconds and returns the lines", async () => {
    const cf = fakeAccount();
    const events = [
      { outcome: "ok", eventTimestamp: Date.UTC(2026, 10, 26, 12), event: { request: { url: "https://x/api/query", method: "POST" } }, logs: [{ message: ['ember:exec {"fn":"messages:list","shard":"global:main","status":"ok","kind":"query","durationMs":2}'], level: "log", timestamp: 1 }], exceptions: [] },
      { outcome: "exception", eventTimestamp: Date.UTC(2026, 10, 26, 12), event: { request: { url: "https://x/api/mutation", method: "POST" } }, logs: [], exceptions: [{ name: "Error", message: "boom", timestamp: 1 }] },
    ];
    class FakeWs {
      private l: Record<string, Array<(e: any) => void>> = {};
      constructor() {
        setTimeout(() => {
          this.emit("open", {});
          for (const e of events) this.emit("message", { data: JSON.stringify(e) });
        }, 5);
      }
      addEventListener(t: string, f: (e: any) => void) {
        (this.l[t] ??= []).push(f);
      }
      private emit(t: string, e: unknown) {
        for (const f of this.l[t] ?? []) f(e);
      }
      send() {}
      close() {
        this.emit("close", {});
      }
    }
    const { s } = server({ allowEnv: ["prod"], client: () => cf.client, WebSocket: FakeWs as never });
    const r = await call(s, "logs", { env: "prod", seconds: 1 });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ env: "prod", worker: "ember-chat-prod", events: 2 });
    expect(r.content[0]!.text).toMatch(/boom/);
    expect(cf.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /workers/scripts/ember-chat-prod/tails", "DELETE /workers/scripts/ember-chat-prod/tails/tail-1"]);
    expect((await call(s, "logs", { env: "local" })).content[0]!.text).toMatch(/name a deployed environment/);
    expect((await call(s, "logs", { env: "dev" })).content[0]!.text).toMatch(/--allow-env dev/);
  });

  it("metrics: per function of a deployed environment", async () => {
    const asked: unknown[] = [];
    const stat = { project: "chat", env: "prod", fn: "messages:list", kind: "query", timing: "rpc", calls: 120, errors: 3, errorRate: 0.025, p50: 1.5, p95: 9.25, rowsRead: 1200, rowsWritten: 0, avgRowsRead: 10, bytesOut: 1, limitPeaks: {} };
    const { s } = server({ allowEnv: ["prod"], metrics: async (o) => (asked.push(o), [stat as never]) });
    const r = await call(s, "metrics", { env: "prod", hours: 6 });
    expect(asked).toEqual([{ env: "prod", hours: 6 }]);
    expect(r.structuredContent.functions).toEqual([{ fn: "messages:list", kind: "query", calls: 120, errorRate: 0.025, p50: 1.5, p95: 9.25, avgRowsRead: 10 }]);
    expect(r.content[0]!.text).toMatch(/messages:list\s+query\s+120\s+2\.5\s+1\.50\s+9\.25\s+10\.0/);
  });

  it("codegen: check reports, a run writes; errors are tool errors", async () => {
    const { s } = server();
    const check = await call(s, "codegen", { check: true });
    expect(check.content[0]!.text).toMatch(/^codegen --check: \d+ functions, 1 tables/);
    const r = await call(s, "codegen");
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ ok: true, errors: [] });
    expect((await call(s, "codegen", { check: true })).structuredContent.stale).toEqual([]);
    const broken = emberMcpServer(project, { codegen: async () => Promise.reject(new Error("schema.ts: boom")) });
    const b = await call(broken, "codegen");
    expect([b.isError, b.content[0]!.text]).toEqual([true, "codegen failed: schema.ts: boom"]);
  }, 120_000);
});

describe("ember mcp (the CLI process)", () => {
  it("serves the project over stdio: initialize, tools/list, a call; stdout carries only protocol lines", async () => {
    const bin = fileURLToPath(new URL("../bin/ember.js", import.meta.url));
    const child = spawn(process.execPath, [bin, "mcp", "--allow-env", "prod"], { cwd: project.root, env: { ...process.env, EMBER_ADMIN_TOKEN: "" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "functions", arguments: { visibility: "internal" } } });
    // Answers come as their tools finish: wait for all three, then close stdin (the server exits at end of input).
    for (let i = 0; i < 600 && stdout.split("\n").filter(Boolean).length < 3; i++) await new Promise((r) => setTimeout(r, 100));
    child.stdin.end();
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code, stderr).toBe(0);
    const msgs = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(msgs.map((m) => m.id).sort()).toEqual([1, 2, 3]);
    expect(msgs.find((m) => m.id === 1).result.instructions).toMatch(/Deployed environments this server may read: prod/);
    expect(msgs.find((m) => m.id === 2).result.tools).toHaveLength(9);
    expect(msgs.find((m) => m.id === 3).result.structuredContent.functions.map((f: { name: string }) => f.name)).toEqual(["messages:trim"]);
    expect(stderr).toMatch(/ember mcp: chat on stdio/);
  }, 120_000);
});

