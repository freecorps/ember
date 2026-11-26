// A minimal Model Context Protocol server: JSON-RPC 2.0 over stdio (one JSON message per line), with the methods a
// tools-only server needs: `initialize`, `ping`, `tools/list`, `tools/call` (and the `notifications/*` it may ignore).
// No SDK: the protocol surface is small and the CLI keeps its dependencies few. Spec:
// https://modelcontextprotocol.io/specification (versions 2024-11-05 through 2025-11-25 are accepted).

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Protocol versions this server speaks, newest first (`initialize` answers the client's when it is one of them). */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** A JSON Schema (the subset `validate` checks: what tool inputs use). */
export interface JsonSchema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: ReadonlyArray<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchema;
  default?: unknown;
}

/** What a tool returns: shown to the model as text, and (`structured`) as `structuredContent`. */
export interface ToolOutput {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  /** MCP tool annotations (hints for clients: read-only tools, destructive ones). */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  call(args: Record<string, unknown>): Promise<ToolOutput>;
}

/** An error a tool reports to the model (`isError: true`), rather than a protocol failure. */
export class ToolError extends Error {
  override name = "ToolError";
}

type Id = string | number;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: Id | null;
  method: string;
  params?: unknown;
}
export type JsonRpcResponse = { jsonrpc: "2.0"; id: Id | null; result: unknown } | { jsonrpc: "2.0"; id: Id | null; error: { code: number; message: string; data?: unknown } };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Checks `value` against `schema`; returns the problems (`args.limit: must be <= 100`), empty when it conforms. */
export function validate(schema: JsonSchema, value: unknown, at = "arguments"): string[] {
  const out: string[] = [];
  const t = schema.type;
  if (t === "object") {
    if (!isObject(value)) return [`${at}: must be an object`];
    for (const r of schema.required ?? []) if (value[r] === undefined) out.push(`${at}.${r}: is required`);
    for (const [k, v] of Object.entries(value)) {
      const p = schema.properties?.[k];
      if (!p) {
        if (schema.additionalProperties === false) out.push(`${at}.${k}: unknown property (known: ${Object.keys(schema.properties ?? {}).join(", ") || "none"})`);
        continue;
      }
      if (v !== undefined) out.push(...validate(p, v, `${at}.${k}`));
    }
    return out;
  }
  if (t === "array") {
    if (!Array.isArray(value)) return [`${at}: must be an array`];
    if (schema.items) value.forEach((x, i) => out.push(...validate(schema.items!, x, `${at}[${i}]`)));
    return out;
  }
  if (t === "string") {
    if (typeof value !== "string") return [`${at}: must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at}: must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${at}: must have at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push(`${at}: must match ${schema.pattern}`);
  } else if (t === "integer" || t === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (t === "integer" && !Number.isInteger(value))) return [`${at}: must be ${t === "integer" ? "an integer" : "a number"}`];
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: must be <= ${schema.maximum}`);
  } else if (t === "boolean" && typeof value !== "boolean") return [`${at}: must be a boolean`];
  if (schema.enum && !schema.enum.includes(value as string)) out.push(`${at}: must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(", ")}`);
  return out;
}

export interface McpServerOptions {
  name: string;
  version: string;
  title?: string;
  /** Server instructions for the model (`initialize` result). */
  instructions?: string;
  tools: McpTool[];
  /** Where tool failures that are not `ToolError`s are logged (stderr by default: stdout is the protocol). */
  log?: (line: string) => void;
}

/** The JSON-RPC side of an MCP server: `handle` one message (object or batch), get the response (null for notifications). */
export class McpServer {
  readonly tools: Map<string, McpTool>;
  private readonly log: (line: string) => void;
  private readonly o: McpServerOptions;
  constructor(o: McpServerOptions) {
    this.o = o;
    this.tools = new Map(o.tools.map((t) => [t.name, t]));
    this.log = o.log ?? ((l) => void process.stderr.write(`${l}\n`));
  }

  /** One line of input: a request, a notification, or a batch of them. */
  async handleLine(line: string): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error: not JSON" } };
    }
    if (Array.isArray(msg)) {
      if (!msg.length) return { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Invalid Request: empty batch" } };
      const out = (await Promise.all(msg.map((m) => this.handle(m)))).filter((r): r is JsonRpcResponse => r !== null);
      return out.length ? out : null;
    }
    return this.handle(msg);
  }

  async handle(msg: unknown): Promise<JsonRpcResponse | null> {
    if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      // A response from the client (we send no requests) or garbage: ignore responses, refuse the rest.
      if (isObject(msg) && msg.jsonrpc === "2.0" && ("result" in msg || "error" in msg)) return null;
      const id = isObject(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
      return { jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message: "Invalid Request: expected a JSON-RPC 2.0 request" } };
    }
    const req = msg as unknown as JsonRpcRequest;
    const notification = req.id === undefined || req.id === null;
    const id = notification ? null : req.id!;
    const ok = (result: unknown): JsonRpcResponse | null => (notification ? null : { jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string, data?: unknown): JsonRpcResponse | null => (notification ? null : { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
    switch (req.method) {
      case "initialize": {
        const asked = isObject(req.params) && typeof req.params.protocolVersion === "string" ? req.params.protocolVersion : undefined;
        const protocolVersion = asked && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return ok({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.o.name, version: this.o.version, ...(this.o.title ? { title: this.o.title } : {}) },
          ...(this.o.instructions ? { instructions: this.o.instructions } : {}),
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: [...this.tools.values()].map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
        });
      case "tools/call": {
        const p = req.params;
        if (!isObject(p) || typeof p.name !== "string") return fail(INVALID_PARAMS, "Invalid params: expected { name, arguments? }");
        const tool = this.tools.get(p.name);
        if (!tool) return fail(INVALID_PARAMS, `Unknown tool: ${p.name}`, { known: [...this.tools.keys()] });
        const args = p.arguments ?? {};
        // Input that does not match the schema is the model's to fix: a tool error it can read, not a protocol error.
        const problems = validate(tool.inputSchema, args);
        if (problems.length) return ok(toolResult({ text: `Invalid arguments for ${tool.name}:\n${problems.map((x) => `- ${x}`).join("\n")}`, isError: true }));
        try {
          return ok(toolResult(await tool.call(args as Record<string, unknown>)));
        } catch (e) {
          if (!(e instanceof ToolError)) this.log(`ember mcp: ${tool.name} failed: ${(e as Error).stack ?? String(e)}`);
          return ok(toolResult({ text: (e as Error).message || String(e), isError: true }));
        }
      }
      default:
        // Notifications (`notifications/initialized`, `notifications/cancelled`...) need no answer.
        if (notification) return null;
        return fail(METHOD_NOT_FOUND, `Method not found: ${req.method}`);
    }
  }
}

function toolResult(o: ToolOutput) {
  return { content: [{ type: "text", text: o.text }], ...(o.structured ? { structuredContent: o.structured } : {}), isError: o.isError === true };
}

/**
 * Serves `server` on a pair of streams (stdin/stdout by default) until the input ends. Requests are handled as they
 * arrive (a slow tool does not hold up `ping`); each response is one line. Anything the process prints with
 * `console.log` would corrupt the protocol, so it goes to stderr while serving.
 */
export async function serveStdio(server: McpServer, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const restore = output === process.stdout ? redirectConsole() : () => {};
  const pending = new Set<Promise<void>>();
  const write = (r: JsonRpcResponse | JsonRpcResponse[] | null) => {
    if (r !== null) output.write(`${JSON.stringify(r)}\n`);
  };
  try {
    const rl = createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const p = server.handleLine(line).then(write, (e: unknown) => write({ jsonrpc: "2.0", id: null, error: { code: INTERNAL_ERROR, message: (e as Error).message } }));
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }
    await Promise.all(pending);
  } finally {
    restore();
  }
}

function redirectConsole(): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  const toErr = (...a: unknown[]) => console.error(...a);
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
  return () => Object.assign(console, saved);
}
