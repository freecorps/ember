// Workers AI as an AgentModel: `env.EMBER_AI.run(model, { messages, tools, stream })` (PLAN §13), optionally through an
// AI Gateway. Text streams as server-sent events (`data: {"response": "..."}`); Workers AI documents tool calls on
// the non-streamed response (`tool_calls: [{ name, arguments }]`), so by default a step with tools is not streamed.
// OpenAI-compatible chunks (`choices[0].delta`) are understood too.

import { newToolCallId, usageOf, type AgentModel, type ModelEvent, type ModelMessage, type ModelPart, type ModelRequest } from "./model.ts";

/** The Workers AI binding (`Ai`), structurally. */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export type WorkersAiOptions = {
  /** Binding name in `ctx.env`. Default `EMBER_AI` (the agent component asks `ember deploy` for it). */
  binding?: string;
  /** A binding object instead of a name (tests, or a binding from elsewhere). */
  ai?: WorkersAiBinding;
  /** `"auto"` (default): stream unless the step offers tools. `true`: always (tool calls read from the chunks). */
  stream?: boolean | "auto";
  maxTokens?: number;
  temperature?: number;
  /** AI Gateway (`{ gateway: { id, skipCache, cacheTtl } }` of `run`): logs, caching, rate limits, fallbacks. */
  gateway?: { id: string; skipCache?: boolean; cacheTtl?: number; [k: string]: unknown };
  /** Extra model inputs (top_p, seed, ...). */
  extra?: Record<string, unknown>;
};

type WaiMessage = { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string };

const textOf = (parts: ModelPart[]) =>
  parts
    .map((p) => (p.type === "text" ? p.text : p.type === "file" ? `[file ${p.filename ?? ""} (${p.mimeType}): ${p.url}]` : ""))
    .filter(Boolean)
    .join("\n");
const json = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x ?? null));

/** The agent's messages in Workers AI's chat format. */
export function toWorkersAiMessages(system: string | undefined, messages: ModelMessage[]): WaiMessage[] {
  const out: WaiMessage[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "tool") {
      for (const p of m.content) if (p.type === "tool-result") out.push({ role: "tool", tool_call_id: p.toolCallId, name: p.toolName, content: json(p.isError ? { error: p.result } : p.result) });
      continue;
    }
    const calls = m.content.filter((p): p is Extract<ModelPart, { type: "tool-call" }> => p.type === "tool-call");
    const msg: WaiMessage = { role: m.role, content: textOf(m.content) };
    if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.toolCallId, type: "function", function: { name: c.toolName, arguments: json(c.args) } }));
    out.push(msg);
  }
  return out;
}

const parseArgs = (a: unknown): unknown => {
  if (typeof a !== "string") return a ?? {};
  try {
    return JSON.parse(a);
  } catch {
    return a;
  }
};

type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec | undefined => (typeof x === "object" && x !== null ? (x as Rec) : undefined);

function waiUsage(u: unknown) {
  const r = rec(u);
  if (!r) return undefined;
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : undefined);
  const inputTokens = n("prompt_tokens") ?? n("input_tokens") ?? 0;
  const outputTokens = n("completion_tokens") ?? n("output_tokens") ?? 0;
  return usageOf({ inputTokens, outputTokens, totalTokens: n("total_tokens") ?? inputTokens + outputTokens });
}

/** `[{ name, arguments }]` (Workers AI) or `[{ id, function: { name, arguments } }]` (OpenAI). */
function toolCallsOf(list: unknown): Array<{ toolCallId: string; toolName: string; args: unknown }> {
  if (!Array.isArray(list)) return [];
  return list.flatMap((c) => {
    const r = rec(c);
    const f = rec(r?.function) ?? r;
    const name = f?.name;
    if (typeof name !== "string") return [];
    return [{ toolCallId: typeof r?.id === "string" ? r.id : newToolCallId(), toolName: name, args: parseArgs(f?.arguments) }];
  });
}

async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          // a keep-alive or partial line: skip
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** `reasoning_content` / `reasoning` of an OpenAI-style message or delta (reasoning models on Workers AI). */
function reasoningField(r: Rec | undefined): string | undefined {
  const x = r?.reasoning_content ?? r?.reasoning;
  return typeof x === "string" && x ? x : undefined;
}

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * Splits a text stream that starts with `<think>…</think>` (DeepSeek R1 style models) into reasoning and text deltas,
 * across chunk boundaries. Text that does not start with the tag (whitespace aside) is all text.
 */
export class ThinkSplitter {
  /** `after`: just past `</think>`, dropping whitespace until the first other character (in this chunk or a later one). */
  private state: "start" | "think" | "after" | "text" = "start";
  private buf = "";

  push(chunk: string): ModelEvent[] {
    this.buf += chunk;
    const out: ModelEvent[] = [];
    for (;;) {
      if (this.state === "start") {
        const t = this.buf.trimStart();
        if (t.startsWith(OPEN)) {
          this.buf = t.slice(OPEN.length);
          this.state = "think";
          continue;
        }
        if (OPEN.startsWith(t)) return out; // maybe the tag, still arriving
        this.state = "text";
        continue;
      }
      if (this.state === "think") {
        const end = this.buf.indexOf(CLOSE);
        if (end >= 0) {
          if (end > 0) out.push({ type: "reasoning-delta", text: this.buf.slice(0, end) });
          this.buf = this.buf.slice(end + CLOSE.length);
          this.state = "after";
          continue;
        }
        // Keep what could be the start of `</think>`; the rest is reasoning.
        let keep = 0;
        for (let k = Math.min(CLOSE.length - 1, this.buf.length); k > 0; k--) if (CLOSE.startsWith(this.buf.slice(-k))) {
          keep = k;
          break;
        }
        const text = this.buf.slice(0, this.buf.length - keep);
        if (text) out.push({ type: "reasoning-delta", text });
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      if (this.state === "after") {
        this.buf = this.buf.replace(/^\s+/, "");
        if (!this.buf) return out;
        this.state = "text";
      }
      if (this.buf) out.push({ type: "text-delta", text: this.buf });
      this.buf = "";
      return out;
    }
  }

  /** What is left at the end of the stream. */
  end(): ModelEvent[] {
    const rest = this.buf;
    this.buf = "";
    if (!rest) return [];
    return [{ type: this.state === "think" ? "reasoning-delta" : "text-delta", text: rest }];
  }
}

/**
 * A Workers AI text-generation model: `workersAi("@cf/meta/llama-3.3-70b-instruct-fp8-fast")`. Uses `ctx.env.EMBER_AI`
 * (or `binding` / `ai`); `gateway` routes through an AI Gateway.
 */
export function workersAi(model: string, opts: WorkersAiOptions = {}): AgentModel {
  const bindingName = opts.binding ?? "EMBER_AI";
  return {
    provider: "workers-ai",
    modelId: model,
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      const ai = opts.ai ?? (req.env[bindingName] as WorkersAiBinding | undefined);
      if (!ai || typeof ai.run !== "function") throw new Error(`workersAi: no Workers AI binding ${bindingName} in ctx.env (the agent component asks ember deploy for EMBER_AI; locally use ember dev --remote)`);
      const streaming = opts.stream === true || ((opts.stream ?? "auto") === "auto" && req.tools.length === 0);
      const inputs: Record<string, unknown> = { messages: toWorkersAiMessages(req.system, req.messages), ...(opts.extra ?? {}) };
      if (req.tools.length) inputs.tools = req.tools.map((t) => ({ name: t.name, description: t.description ?? "", parameters: t.parameters }));
      const maxTokens = req.maxOutputTokens ?? opts.maxTokens;
      const temperature = req.temperature ?? opts.temperature;
      if (maxTokens !== undefined) inputs.max_tokens = maxTokens;
      if (temperature !== undefined) inputs.temperature = temperature;
      if (streaming) inputs.stream = true;
      if (req.responseFormat) inputs.response_format = { type: "json_schema", json_schema: req.responseFormat.schema };
      const result = await ai.run(model, inputs, opts.gateway ? { gateway: opts.gateway } : undefined);

      if (!streaming || !(result instanceof ReadableStream)) {
        const r = rec(result) ?? {};
        const choice = rec(Array.isArray(r.choices) ? r.choices[0] : undefined);
        const msg = rec(choice?.message);
        const raw = typeof r.response === "string" ? r.response : typeof msg?.content === "string" ? msg.content : r.response !== undefined && r.response !== null ? JSON.stringify(r.response) : "";
        const field = reasoningField(msg) ?? reasoningField(r);
        const split = new ThinkSplitter();
        const parts = [...split.push(raw), ...split.end()];
        if (field) yield { type: "reasoning-delta", text: field };
        // A reasoning field and a `<think>` block in the content are the same reasoning: the field wins.
        for (const ev of parts) if (!field || ev.type !== "reasoning-delta") yield ev;
        const calls = toolCallsOf(r.tool_calls ?? msg?.tool_calls);
        for (const c of calls) yield { type: "tool-call", ...c };
        const usage = waiUsage(r.usage);
        yield { type: "finish", finishReason: calls.length ? "tool-calls" : typeof choice?.finish_reason === "string" ? choice.finish_reason : "stop", ...(usage ? { usage } : {}) };
        return;
      }

      let usage: ReturnType<typeof waiUsage>;
      let finishReason: string | undefined;
      const flat: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
      const indexed = new Map<number, { id?: string; name?: string; args: string }>();
      const think = new ThinkSplitter();
      /** A reasoning field was streamed: a `<think>` block in the content would repeat it (the field wins). */
      let fieldSeen = false;
      const content = function* (text: string): Generator<ModelEvent> {
        for (const ev of think.push(text)) if (!fieldSeen || ev.type !== "reasoning-delta") yield ev;
      };
      for await (const chunk of sse(result as ReadableStream<Uint8Array>, req.signal)) {
        const c = rec(chunk);
        if (!c) continue;
        if (c.usage) usage = waiUsage(c.usage) ?? usage;
        // `response` (Workers AI format) or `choices[0].delta.content` (OpenAI format): a chunk with both carries the
        // same text twice, so `response` is taken and the delta's content skipped.
        const response = typeof c.response === "string" && c.response ? c.response : null;
        const choice = rec(Array.isArray(c.choices) ? c.choices[0] : undefined);
        const delta = rec(choice?.delta);
        // The chunk's reasoning field first: a `<think>` block in this very chunk's content is the same reasoning.
        const thought = reasoningField(delta);
        if (thought) {
          fieldSeen = true;
          yield { type: "reasoning-delta", text: thought };
        }
        if (response) yield* content(response);
        if (Array.isArray(c.tool_calls)) flat.push(...toolCallsOf(c.tool_calls));
        if (!choice) continue;
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
        if (!response && typeof delta?.content === "string" && delta.content) yield* content(delta.content);
        // OpenAI-style tool call fragments, merged by index.
        for (const t of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
          const r = rec(t);
          const i = typeof r?.index === "number" ? r.index : indexed.size;
          const cur = indexed.get(i) ?? { args: "" };
          const f = rec(r?.function);
          if (typeof r?.id === "string") cur.id = r.id;
          if (typeof f?.name === "string") cur.name = f.name;
          if (typeof f?.arguments === "string") cur.args += f.arguments;
          indexed.set(i, cur);
        }
      }
      for (const ev of think.end()) if (!fieldSeen || ev.type !== "reasoning-delta") yield ev;
      for (const c of flat) yield { type: "tool-call", ...c };
      for (const c of indexed.values()) if (c.name) yield { type: "tool-call", toolCallId: c.id ?? newToolCallId(), toolName: c.name, args: parseArgs(c.args || "{}") };
      yield { type: "finish", finishReason: flat.length || indexed.size ? "tool-calls" : (finishReason ?? "stop"), ...(usage ? { usage } : {}) };
    },
  };
}
