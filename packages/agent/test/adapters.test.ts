// Model adapters against fakes of their wire shapes: the Workers AI binding (`run`, SSE streams) and AI SDK
// LanguageModels (v1, v2, v3 stream parts), no network.
import { describe, expect, test } from "vitest";
import { Agent, aiSdk, defineModel, generateObject, workersAi, type ModelEvent, type ModelRequest } from "../src/index.ts";
import { ThinkSplitter } from "../src/workers-ai.ts";
import { v } from "@freecorps/ember-server";

const enc = new TextEncoder();
const sseStream = (chunks: unknown[], split = 7) => {
  const text = chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(c) {
      // Split mid-line, like a network would.
      for (let i = 0; i < text.length; i += split) c.enqueue(enc.encode(text.slice(i, i + split)));
      c.close();
    },
  });
};
const partStream = (parts: unknown[]) =>
  new ReadableStream<unknown>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "Be brief.",
  messages: [
    { role: "user", content: [{ type: "text", text: "status of A-1?" }] },
    { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool-call", toolCallId: "c1", toolName: "lookupOrder", args: { orderId: "A-1" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "lookupOrder", result: { status: "shipped" } }] },
  ],
  tools: [{ name: "lookupOrder", description: "Finds an order", parameters: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] } }],
  signal: new AbortController().signal,
  env: {},
  ...over,
});

const collect = async (it: AsyncIterable<ModelEvent> | Promise<AsyncIterable<ModelEvent>>) => {
  const out: ModelEvent[] = [];
  for await (const e of await it) out.push(e);
  return out;
};

describe("workersAi", () => {
  test("with tools: one non-streamed run; messages, tools and tool calls in Workers AI's shapes; AI Gateway", async () => {
    const calls: Array<{ model: string; inputs: any; options: any }> = [];
    const ai = {
      run: async (model: string, inputs: any, options?: any) => {
        calls.push({ model, inputs, options });
        return { response: "", tool_calls: [{ name: "lookupOrder", arguments: { orderId: "B-2" } }], usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 } };
      },
    };
    const m = workersAi("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { gateway: { id: "support", skipCache: true }, maxTokens: 512 });
    expect(m).toMatchObject({ provider: "workers-ai", modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
    const events = await collect(m.stream(request({ env: { EMBER_AI: ai } })));
    expect(calls).toHaveLength(1);
    const { inputs, options } = calls[0]!;
    expect(options).toEqual({ gateway: { id: "support", skipCache: true } });
    expect(inputs.stream).toBeUndefined();
    expect(inputs.max_tokens).toBe(512);
    expect(inputs.tools).toEqual([{ name: "lookupOrder", description: "Finds an order", parameters: request().tools[0]!.parameters }]);
    expect(inputs.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "status of A-1?" },
      { role: "assistant", content: "checking", tool_calls: [{ id: "c1", type: "function", function: { name: "lookupOrder", arguments: '{"orderId":"A-1"}' } }] },
      { role: "tool", tool_call_id: "c1", name: "lookupOrder", content: '{"status":"shipped"}' },
    ]);
    expect(events).toEqual([
      { type: "tool-call", toolCallId: expect.any(String), toolName: "lookupOrder", args: { orderId: "B-2" } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 50, outputTokens: 7, totalTokens: 57 } },
    ]);
  });

  test("without tools: streams the SSE deltas (split mid-line) and reads usage from the last chunk", async () => {
    let inputs: any;
    const ai = {
      run: async (_m: string, i: any) => {
        inputs = i;
        return sseStream([{ response: "Hel" }, { response: "lo, " }, { response: "world" }, { response: "", usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }, "[DONE]"]);
      },
    };
    const events = await collect(workersAi("@cf/m", { ai }).stream(request({ tools: [], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })));
    expect(inputs.stream).toBe(true);
    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo, " },
      { type: "text-delta", text: "world" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } },
    ]);
  });

  test("stream: true with OpenAI-style chunks: tool call fragments merged by index", async () => {
    const ai = {
      run: async () =>
        sseStream([
          { choices: [{ delta: { content: "One sec" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "t9", function: { name: "lookupOrder", arguments: '{"order' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":"C-3"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
          "[DONE]",
        ]),
    };
    const events = await collect(workersAi("@cf/m", { ai, stream: true }).stream(request()));
    expect(events).toEqual([
      { type: "text-delta", text: "One sec" },
      { type: "tool-call", toolCallId: "t9", toolName: "lookupOrder", args: { orderId: "C-3" } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    ]);
  });

  test("reasoning: reasoning_content deltas and a <think> prefix (split across chunks) become reasoning-delta", async () => {
    const ai = {
      run: async () =>
        sseStream([
          { choices: [{ delta: { reasoning_content: "Look up " } }] },
          { choices: [{ delta: { reasoning_content: "the order." } }] },
          { choices: [{ delta: { content: "Shipped." } }] },
          "[DONE]",
        ]),
    };
    const events = await collect(workersAi("@cf/m", { ai, stream: true }).stream(request({ tools: [] })));
    expect(events.slice(0, 3)).toEqual([
      { type: "reasoning-delta", text: "Look up " },
      { type: "reasoning-delta", text: "the order." },
      { type: "text-delta", text: "Shipped." },
    ]);
    const r1 = { run: async () => sseStream([{ response: "<thi" }, { response: "nk>Hmm, " }, { response: "A-1 shipped</th" }, { response: "ink>\n\nIt" }, { response: " shipped." }, "[DONE]"]) };
    const ev2 = await collect(workersAi("@cf/deepseek", { ai: r1 }).stream(request({ tools: [] })));
    const join = (t: string) => ev2.filter((e) => e.type === t).map((e) => (e as { text: string }).text).join("");
    expect(join("reasoning-delta")).toBe("Hmm, A-1 shipped");
    expect(join("text-delta")).toBe("It shipped.");
    // Not streamed: the whole response at once.
    const once = { run: async () => ({ response: "<think>x</think>y", usage: {} }) };
    const ev3 = await collect(workersAi("@cf/deepseek", { ai: once, stream: false }).stream(request({ tools: [] })));
    expect(ev3.slice(0, 2)).toEqual([
      { type: "reasoning-delta", text: "x" },
      { type: "text-delta", text: "y" },
    ]);
    const plain = new ThinkSplitter();
    expect([...plain.push("  <"), ...plain.push("b>bold"), ...plain.end()]).toEqual([{ type: "text-delta", text: "  <b>bold" }]);
  });

  test("generateObject: response_format json_schema", async () => {
    let inputs: any;
    const ai = {
      run: async (_m: string, i: any) => {
        inputs = i;
        return { response: { city: "Lisbon" } };
      },
    };
    const r = await generateObject(workersAi("@cf/m", { ai }), { schema: { city: v.string() }, prompt: "capital of Portugal" });
    expect(r.object).toEqual({ city: "Lisbon" });
    expect(inputs.response_format).toEqual({ type: "json_schema", json_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } });
  });

  test("a missing binding is a clear error", async () => {
    await expect(collect(workersAi("@cf/m").stream(request()))).rejects.toThrow(/no Workers AI binding EMBER_AI/);
  });
});

describe("aiSdk (structural LanguageModel)", () => {
  const fake = (version: string, parts: unknown[]) => {
    const calls: any[] = [];
    return {
      calls,
      model: {
        specificationVersion: version,
        provider: "openai.chat",
        modelId: "gpt-test",
        doStream: async (options: any) => {
          calls.push(options);
          return { stream: partStream(parts) };
        },
      },
    };
  };

  test("v2: prompt (tool-call input, tool-result output), tools with inputSchema, stream parts mapped", async () => {
    const f = fake("v2", [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: "Hi " },
      { type: "text-delta", id: "1", delta: "there" },
      { type: "text-end", id: "1" },
      { type: "tool-call", toolCallId: "x1", toolName: "lookupOrder", input: '{"orderId":"D-4"}' },
      { type: "tool-call", toolCallId: "web", toolName: "web_search", input: "{}", providerExecuted: true },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
    ]);
    const m = aiSdk(f.model, { providerOptions: { openai: { store: false } } });
    expect(m).toMatchObject({ provider: "openai.chat", modelId: "gpt-test" });
    const events = await collect(m.stream(request({ temperature: 0.2, maxOutputTokens: 100 })));
    const o = f.calls[0];
    expect(o).toMatchObject({ temperature: 0.2, maxOutputTokens: 100, providerOptions: { openai: { store: false } }, abortSignal: expect.any(AbortSignal) });
    expect(o.tools).toEqual([{ type: "function", name: "lookupOrder", description: "Finds an order", inputSchema: request().tools[0]!.parameters }]);
    expect(o.prompt).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "status of A-1?" }] },
      { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool-call", toolCallId: "c1", toolName: "lookupOrder", input: { orderId: "A-1" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "lookupOrder", output: { type: "json", value: { status: "shipped" } } }] },
    ]);
    expect(events).toEqual([
      { type: "text-delta", text: "Hi " },
      { type: "text-delta", text: "there" },
      { type: "tool-call", toolCallId: "x1", toolName: "lookupOrder", args: { orderId: "D-4" } },
      { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } },
    ]);
  });

  test("v3: nested usage and finishReason { unified }; error parts surface", async () => {
    const f = fake("v3", [
      { type: "text-delta", id: "1", delta: "ok" },
      { type: "error", error: new Error("rate limited") },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: { inputTokens: { total: 11, noCache: 11 }, outputTokens: { total: 4, text: 4 } } },
    ]);
    const events = await collect(aiSdk(f.model).stream(request({ tools: [] })));
    expect(f.calls[0].tools).toBeUndefined();
    expect(events).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "error", error: expect.any(Error) },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } },
    ]);
  });

  test("v1: mode.tools with parameters, args/result prompt parts, textDelta and promptTokens", async () => {
    const f = fake("v1", [
      { type: "text-delta", textDelta: "yo" },
      { type: "tool-call", toolCallType: "function", toolCallId: "z", toolName: "lookupOrder", args: '{"orderId":"E-5"}' },
      { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 3, completionTokens: 2 } },
    ]);
    const events = await collect(aiSdk(f.model).stream(request({ maxOutputTokens: 9 })));
    const o = f.calls[0];
    expect(o).toMatchObject({ inputFormat: "messages", maxTokens: 9, mode: { type: "regular", tools: [{ type: "function", name: "lookupOrder", parameters: expect.any(Object) }] } });
    expect(o.prompt[2].content[1]).toEqual({ type: "tool-call", toolCallId: "c1", toolName: "lookupOrder", args: { orderId: "A-1" } });
    expect(o.prompt[3].content[0]).toEqual({ type: "tool-result", toolCallId: "c1", toolName: "lookupOrder", result: { status: "shipped" } });
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "tool-calls", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    expect(events[1]).toMatchObject({ type: "tool-call", args: { orderId: "E-5" } });
  });

  test("reasoning parts stream as reasoning-delta (v2 reasoning-delta, v1 reasoning)", async () => {
    const v2 = fake("v2", [
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: "think" },
      { type: "reasoning-end", id: "r" },
      { type: "text-delta", id: "1", delta: "answer" },
    ]);
    expect(await collect(aiSdk(v2.model).stream(request({ tools: [] })))).toEqual([
      { type: "reasoning-delta", text: "think" },
      { type: "text-delta", text: "answer" },
    ]);
    const v1 = fake("v1", [{ type: "reasoning", textDelta: "hmm" }]);
    expect(await collect(aiSdk(v1.model).stream(request({ tools: [] })))).toEqual([{ type: "reasoning-delta", text: "hmm" }]);
  });

  test("generateObject: responseFormat json (v2/v3), mode object-json (v1)", async () => {
    const schema = { n: v.number() };
    const v2 = fake("v2", [{ type: "text-delta", id: "1", delta: '{"n": 3}' }]);
    expect((await generateObject(v2.model, { schema, prompt: "three", name: "num" })).object).toEqual({ n: 3 });
    expect(v2.calls[0].responseFormat).toEqual({ type: "json", name: "num", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false } });
    expect(v2.calls[0].tools).toBeUndefined();
    const v1 = fake("v1", [{ type: "text-delta", textDelta: '{"n": 4}' }]);
    expect((await generateObject(v1.model, { schema, prompt: "four" })).object).toEqual({ n: 4 });
    expect(v1.calls[0].mode).toMatchObject({ type: "object-json", schema: { type: "object" } });
  });

  test("an Agent given an AI SDK model wraps it; defineModel turns generate into one step", async () => {
    const a = new Agent({ lib: {} } as never, { name: "x", model: fake("v2", []).model, action: "chat:generate" });
    expect(a.model).toMatchObject({ provider: "openai.chat", modelId: "gpt-test" });
    const m = defineModel({ provider: "p", modelId: "g", generate: async () => ({ text: "done", toolCalls: [{ toolName: "t", args: {} }], usage: { inputTokens: 2, outputTokens: 1 } }) });
    expect(await collect(m.stream(request()))).toEqual([
      { type: "text-delta", text: "done" },
      { type: "tool-call", toolCallId: expect.any(String), toolName: "t", args: {} },
      { type: "finish", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
    ]);
  });
});
