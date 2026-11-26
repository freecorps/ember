// Reasoning streamed in deltas, retries before the first delta, and generateObject (scripted models, real engine).
import { v } from "@freecorps/ember-server";
import { isValidator, toJsonSchema } from "@freecorps/ember-values";
import { beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import { Agent, generateObject, mockModel, modelJsonSchema, ObjectGenerationError, parseJsonAnswer, retryAfterMs, withRetry, withStreams, type AgentModel, type ModelEvent, type ModelRequest } from "../src/index.ts";
import { app, functions, models, schema, toolCalls } from "./app.ts";
import { harness } from "./harness.ts";

const setup = () => harness({ schema, functions, app });

beforeEach(() => {
  toolCalls.length = 0;
  models.current = mockModel([{ text: "hello" }]);
});

/** A model whose calls throw `errors[i]` (before any delta) until they run out; then it streams `text`. */
function flaky(errors: Array<Record<string, unknown> | null>, text = "Recovered answer.", after?: { text: string; error: Record<string, unknown> }) {
  const calls: number[] = [];
  const model: AgentModel = {
    provider: "flaky",
    modelId: "flaky-1",
    async *stream(): AsyncGenerator<ModelEvent> {
      calls.push(Date.now());
      const e = errors[calls.length - 1];
      if (after && calls.length === 1) {
        yield { type: "text-delta", text: after.text };
        throw Object.assign(new Error(String(after.error.message ?? "boom")), after.error);
      }
      if (e) throw Object.assign(new Error(String(e.message ?? "boom")), e);
      yield { type: "text-delta", text };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
  return { model, calls };
}

describe("reasoning-delta", () => {
  test("reasoning streams in the delta rows next to the text; the final message has a reasoning part", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    const reasoning = "The user asks about A-1. I should check the order first.";
    const text = "Your order shipped.";
    models.current = mockModel([{ reasoning, text }], { chunkSize: 4 });
    const pages = h.live("chat:messages", { threadId, paginationOpts: { numItems: 20, cursor: null } });
    const streams = h.live("chat:messages", { threadId, paginationOpts: { numItems: 0, cursor: null }, streamArgs: { kind: "list" } });
    const seen: Array<{ reasoning: string; text: string }> = [];
    const orig = streams.onCommit.bind(streams);
    streams.onCommit = (changes: any[]) => {
      orig(changes);
      const live = withStreams(pages.value.page, streams.value.streams).at(-1);
      if (live?.streaming) seen.push({ reasoning: live.reasoning ?? "", text: live.text });
    };
    const { responseId } = h.mutate("chat:send", { threadId, text: "where is A-1?" }) as any;
    await h.tick();
    // Reasoning first (the model streams it before the answer), growing batch by batch, then the text.
    expect(seen.length).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.reasoning.startsWith(seen[i - 1]!.reasoning)).toBe(true);
      expect(seen[i]!.text.startsWith(seen[i - 1]!.text)).toBe(true);
    }
    expect(seen.some((s) => s.reasoning.length > 0 && s.text === "")).toBe(true);
    expect(reasoning.startsWith(seen.at(-1)!.reasoning)).toBe(true);
    const done = h.query("chat:message", { messageId: responseId }) as any;
    expect(done).toMatchObject({ status: "success", text });
    expect(done.parts).toEqual([
      { type: "reasoning", text: reasoning },
      { type: "text", text },
    ]);
    expect(withStreams([done]).at(-1)).toMatchObject({ reasoning, streaming: false });
    expect(streams.value.streams).toEqual([]);
  });

  test("a step that fails mid-reasoning keeps the streamed reasoning (and compaction joins it in order)", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    // 40 reasoning chunks of 1 char (maxChars 8 → a delta per ~8): crosses a compaction boundary (16 batches).
    const reasoning = "abcdefghijklmnopqrstuvwxyz0123456789ABCD".repeat(4);
    models.current = mockModel([{ reasoning, text: "Partial", error: "upstream broke" }], { chunkSize: 1 });
    const { responseId } = h.mutate("chat:send", { threadId, text: "q" }) as any;
    await h.tick();
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({
      status: "failed",
      text: "Partial",
      parts: [
        { type: "reasoning", text: reasoning },
        { type: "text", text: "Partial" },
      ],
    });
  });
});

describe("retry before the first delta", () => {
  test("429 / 503 before any delta are retried (Retry-After honoured); the step succeeds", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    const f = flaky([
      { status: 429, responseHeaders: { "Retry-After": "0" } },
      { statusCode: 503, message: "overloaded", responseHeaders: { "retry-after": "0" } },
    ]);
    models.current = f.model;
    const { responseId } = h.mutate("chat:send", { threadId, text: "q" }) as any;
    await h.tick();
    expect(f.calls.length).toBe(3);
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({ status: "success", text: "Recovered answer." });
  });

  test("an error after the first delta is not retried (no repeated text); a 400 is not retried", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    const f = flaky([], "never", { text: "Half an ans", error: { status: 503, message: "upstream 503" } });
    models.current = f.model;
    const a = h.mutate("chat:send", { threadId, text: "q" }) as any;
    await h.tick();
    expect(f.calls.length).toBe(1);
    expect(h.query("chat:message", { messageId: a.responseId })).toMatchObject({ status: "failed", error: "upstream 503", text: "Half an ans" });

    const g = flaky([{ status: 400, message: "bad request" }]);
    models.current = g.model;
    const b = h.mutate("chat:send", { threadId, text: "again" }) as any;
    await h.tick();
    expect(g.calls.length).toBe(1);
    expect(h.query("chat:message", { messageId: b.responseId })).toMatchObject({ status: "failed", error: "bad request" });
  });

  test("withRetry: attempts bound, backoff doubles, an error event before the first delta counts, isRetryable wins", async () => {
    const delays: number[] = [];
    let n = 0;
    const always: AgentModel = {
      provider: "p",
      modelId: "m",
      async *stream() {
        n++;
        yield { type: "error", error: { status: 500 } };
      },
    };
    const req = { messages: [], tools: [], signal: new AbortController().signal, env: {} } satisfies ModelRequest;
    const m = withRetry(always, { maxAttempts: 4, initialBackoffMs: 1, maxBackoffMs: 3 }, (r) => delays.push(r.delayMs));
    await expect(
      (async () => {
        for await (const _ of await m.stream(req));
      })(),
    ).rejects.toMatchObject({ status: 500 });
    expect(n).toBe(4);
    expect(delays.length).toBe(3);
    expect(delays.every((d) => d <= 3)).toBe(true);
    // An error that says it is not retryable is not, whatever its status.
    n = 0;
    const no: AgentModel = { ...always, stream: async function* () { n++; throw Object.assign(new Error("x"), { status: 503, isRetryable: false }); } };
    await expect((async () => { for await (const _ of await withRetry(no).stream(req)); })()).rejects.toThrow("x");
    expect(n).toBe(1);
    // A Retry-After longer than maxBackoffMs is not waited for.
    n = 0;
    const long: AgentModel = { ...always, stream: async function* () { n++; throw Object.assign(new Error("slow down"), { status: 429, headers: new Headers({ "retry-after": "120" }) }); } };
    await expect((async () => { for await (const _ of await withRetry(long, { maxBackoffMs: 1000 }).stream(req)); })()).rejects.toThrow("slow down");
    expect(n).toBe(1);
    expect(retryAfterMs({ response: { headers: new Headers({ "Retry-After": "2" }) } })).toBe(2000);
    expect(retryAfterMs({ responseHeaders: { "retry-after": new Date(Date.now() + 5000).toUTCString() } })).toBeGreaterThan(3000);
  });

  test("retry: false turns it off", async () => {
    const f = flaky([{ status: 503, responseHeaders: { "retry-after": "0" } }]);
    const a = new Agent((await import("@freecorps/ember-server")).anyComponents.agent as any, { name: "x", model: f.model, action: "chat:generate", retry: false });
    await expect(a.generateObject({ env: {} }, { schema: { n: v.number() }, prompt: "?" })).rejects.toThrow("boom");
    expect(f.calls.length).toBe(1);
  });
});

describe("generateObject", () => {
  const recipe = v.object({ title: v.string(), minutes: v.number(), tags: v.optional(v.array(v.string())), vegan: v.boolean().default(false) });

  test("sends the validator's JSON Schema as the response format and returns the validated object (defaults applied)", async () => {
    const m = mockModel([{ text: '```json\n{"title":"Soup","minutes":20}\n```', usage: { inputTokens: 5, outputTokens: 7 } }]);
    const r = await generateObject(m, { schema: recipe, prompt: "a quick soup", system: "You are a chef." });
    expect(r.object).toEqual({ title: "Soup", minutes: 20, vegan: false });
    expectTypeOf(r.object).toEqualTypeOf<{ title: string; minutes: number; tags?: string[]; vegan: boolean }>();
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    const sent = m.requests[0]!;
    expect(sent.responseFormat).toEqual({ type: "json", schema: modelJsonSchema(toJsonSchema(recipe.shape)) });
    expect(JSON.stringify(sent.responseFormat)).not.toContain("$float");
    expect(sent.system).toMatch(/^You are a chef\.\n\nAnswer only with a JSON value/);
    expect(sent.messages).toEqual([{ role: "user", content: [{ type: "text", text: "a quick soup" }] }]);
  });

  test("an answer the schema rejects, or that is not JSON, is an ObjectGenerationError with the text", async () => {
    await expect(generateObject(mockModel([{ text: '{"title":"Soup","minutes":"twenty"}' }]), { schema: recipe, prompt: "?" })).rejects.toMatchObject({
      name: "ObjectGenerationError",
      path: expect.stringContaining("minutes"),
      text: '{"title":"Soup","minutes":"twenty"}',
    });
    await expect(generateObject(mockModel([{ text: "I cannot do that." }]), { schema: recipe, prompt: "?" })).rejects.toBeInstanceOf(ObjectGenerationError);
    expect(parseJsonAnswer('Sure! Here it is: {"a": [1, 2]} Hope it helps.')).toEqual({ a: [1, 2] });
    expect(parseJsonAnswer("[1,2]")).toEqual([1, 2]);
    expect(parseJsonAnswer('{"a":1} see [docs]')).toEqual({ a: 1 });
  });

  test("int64 and bytes fields: the tagged wire values the JSON Schema asks for are decoded before the check", async () => {
    const schema = v.object({ id: v.int64(), blob: v.bytes(), n: v.number() });
    const r = await generateObject(mockModel([{ text: '{"id":{"$int64":"9007199254740993"},"blob":{"$bytes":"AQID"},"n":1}' }]), { schema, prompt: "?" });
    expect(r.object).toEqual({ id: 9007199254740993n, blob: new Uint8Array([1, 2, 3]), n: 1 });
    await expect(generateObject(mockModel([{ text: '{"id":{"$int64":"twelve"},"blob":{"$bytes":"AQID"},"n":1}' }]), { schema, prompt: "?" })).rejects.toBeInstanceOf(ObjectGenerationError);
  });

  test("an object of validators with fields named shape and isOptional is a field map, not a validator", async () => {
    const schema = { shape: v.string(), isOptional: v.boolean() };
    const r = await generateObject(mockModel([{ text: '{"shape":"round","isOptional":true}' }]), { schema, prompt: "?" });
    expect(r.object).toEqual({ shape: "round", isOptional: true });
    expect(isValidator(schema)).toBe(false);
    expect(isValidator(v.object(schema))).toBe(true);
  });

  test("an object of validators works as the schema; Agent.generateObject uses the agent's model and instructions", async () => {
    const m = mockModel([{ text: '{"priority":"high","reason":"refund"}' }]);
    const a = new Agent((await import("@freecorps/ember-server")).anyComponents.agent as any, { name: "triage", model: m, instructions: "Triage tickets.", action: "chat:generate" });
    const r = await a.generateObject({ env: { X: 1 } }, { schema: { priority: v.union(v.literal("low"), v.literal("high")), reason: v.string() }, prompt: "I want my money back" });
    expectTypeOf(r.object).toEqualTypeOf<{ priority: "low" | "high"; reason: string }>();
    expect(r.object).toEqual({ priority: "high", reason: "refund" });
    expect(m.requests[0]!.system).toMatch(/^Triage tickets\./);
    expect(m.requests[0]!.env).toEqual({ X: 1 });
  });
});
