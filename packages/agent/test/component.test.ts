// The agent component end to end on the real engine (see harness.ts), with scripted models (no network).
import { beforeEach, describe, expect, test } from "vitest";
import { mockModel, withStreams, type AgentModel, type ModelRequest } from "../src/index.ts";
import { app, functions, models, schema, toolCalls } from "./app.ts";
import { harness } from "./harness.ts";

const setup = () => harness({ schema, functions, app });
type H = ReturnType<typeof setup>;

const page = (h: H, threadId: string, numItems = 50) => h.query("chat:messages", { threadId, paginationOpts: { numItems, cursor: null } }) as any;
/** Messages oldest first, as the UI shows them. */
const thread = (h: H, threadId: string) =>
  [...page(h, threadId).page].reverse().map((m: any) => ({ role: m.role, status: m.status, text: m.text, parts: m.parts.map((p: any) => p.type) }));
const count = (h: H, table: string) => Number(h.sql(`SELECT COUNT(*) AS n FROM "${table}"`)[0]!.n);

beforeEach(() => {
  toolCalls.length = 0;
  models.current = mockModel([{ text: "hello" }]);
});

describe("agent component", () => {
  test("sendMessage saves the prompt and schedules the response atomically; a failing caller leaves nothing", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", { userId: "ana", title: "Orders" }) as string;
    expect(() => h.mutate("chat:send", { threadId, text: "hi", fail: true })).toThrow("caller failed");
    expect(count(h, "agent$messages")).toBe(0);
    expect(h.jobs()).toEqual([]);

    const r = h.mutate("chat:send", { threadId, text: "where is my order?" }) as any;
    expect(r).toMatchObject({ messageId: expect.any(String), responseId: expect.any(String), order: 0 });
    expect(thread(h, threadId)).toEqual([
      { role: "user", status: "success", text: "where is my order?", parts: ["text"] },
      { role: "assistant", status: "pending", text: "", parts: [] },
    ]);
    expect(h.jobs().map((j) => j.fn)).toEqual(["chat:generate"]);
    await h.tick();
    expect(thread(h, threadId).at(-1)).toEqual({ role: "assistant", status: "success", text: "hello", parts: ["text"] });
    expect(page(h, threadId).page[0]).toMatchObject({ userId: "ana", agentName: "support", model: "mock-model", provider: "mock", finishReason: "stop" });
    expect(count(h, "agent$deltas")).toBe(0);
  });

  test("streaming: deltas reach a live subscription as small row patches; the page re-runs only at start and finish", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", { userId: "ana" }) as string;
    const text = "Your order A-1 left the warehouse this morning and should arrive on Friday.";
    models.current = mockModel([{ text }], { chunkSize: 4 });
    const pages = h.live("chat:messages", { threadId, paginationOpts: { numItems: 20, cursor: null } });
    const streams = h.live("chat:messages", { threadId, paginationOpts: { numItems: 0, cursor: null }, streamArgs: { kind: "list" } });
    const seen: string[] = [];
    const orig = streams.onCommit.bind(streams);
    streams.onCommit = (changes: any[]) => {
      orig(changes);
      const live = withStreams(pages.value.page, streams.value.streams).at(-1);
      if (live?.streaming && live.text && !seen.includes(live.text)) seen.push(live.text);
    };
    h.mutate("chat:send", { threadId, text: "where is it?" });
    const pageRunsBefore = pages.reruns;
    await h.tick();

    // Text grew in batches of ~8 characters (maxChars 8), each one visible to the subscriber.
    expect(seen.length).toBeGreaterThanOrEqual(Math.floor(text.length / 8) - 1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.startsWith(seen[i - 1]!)).toBe(true);
    expect(text.startsWith(seen.at(-1)!)).toBe(true);
    // The page query does not re-run per delta: start (pending → streaming) and finishStep only.
    expect(pages.reruns - pageRunsBefore).toBe(2);
    // One patch per delta row written (the first one sets the array, the others are rowdiff upserts).
    const deltaPatches = streams.patches.filter((p) => p.frame.includes('"text":'));
    expect(deltaPatches.length).toBe(seen.length);
    const avg = deltaPatches.reduce((s, p) => s + p.bytes, 0) / deltaPatches.length;
    console.log(`agent streaming: ${deltaPatches.length} delta patches, avg ${avg.toFixed(0)} bytes (kinds: ${[...new Set(deltaPatches.map((p) => p.kind))].join(",")}), example ${deltaPatches[1]?.frame}`);
    expect(avg).toBeLessThan(200);
    expect(withStreams(pages.value.page, streams.value.streams).at(-1)).toMatchObject({ text, status: "success", streaming: false });
    expect(streams.value.streams).toEqual([]);
  });

  test("tool calls: the model asks, the action runs the tool, records call and result, and loops", async () => {
    const h = setup();
    h.mutate("orders:seed", { orderId: "A-1", status: "shipped" });
    const threadId = h.mutate("chat:createThread", { userId: "ana" }) as string;
    const m = mockModel([{ text: "Let me check.", toolCalls: [{ toolName: "lookupOrder", args: { orderId: "A-1" }, toolCallId: "c1" }] }, { text: "Order A-1 is shipped." }]);
    models.current = m;
    h.mutate("chat:send", { threadId, text: "status of A-1?" });
    await h.tick();
    expect(thread(h, threadId)).toEqual([
      { role: "user", status: "success", text: "status of A-1?", parts: ["text"] },
      { role: "assistant", status: "success", text: "Let me check.", parts: ["text", "tool-call"] },
      { role: "tool", status: "success", text: "", parts: ["tool-result"] },
      { role: "assistant", status: "success", text: "Order A-1 is shipped.", parts: ["text"] },
    ]);
    expect(toolCalls).toEqual(["support:A-1"]);
    const tool = page(h, threadId).page.find((x: any) => x.role === "tool");
    expect(tool.parts[0]).toEqual({ type: "tool-result", toolCallId: "c1", toolName: "lookupOrder", result: { orderId: "A-1", status: "shipped" } });
    // The second call saw the instructions, the tool spec (JSON Schema from the validators) and the result.
    const second = m.requests[1]!;
    expect(second.system).toBe("You help users with their orders.");
    expect(second.tools.find((t) => t.name === "lookupOrder")).toMatchObject({ description: "Finds an order by id", parameters: { type: "object", properties: { orderId: { type: "string", description: "The order id, like A-1" } }, required: ["orderId"] } });
    expect(second.messages.map((x) => x.role)).toEqual(["user", "assistant", "tool"]);
    expect(second.messages[2]!.content[0]).toMatchObject({ type: "tool-result", toolCallId: "c1", result: { status: "shipped" } });
  });

  test("maxSteps bounds the loop; tool errors, unknown tools and bad arguments are recorded as error results", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    const m = mockModel([
      {
        toolCalls: [
          { toolName: "explode", args: {}, toolCallId: "e1" },
          { toolName: "teleport", args: {}, toolCallId: "e2" },
          { toolName: "lookupOrder", args: { orderId: 42 }, toolCallId: "e3" },
        ],
      },
    ]);
    models.current = m;
    h.mutate("chat:send", { threadId, text: "go" });
    await h.tick();
    expect(m.requests.length).toBe(3); // maxSteps: 3
    const msgs = [...page(h, threadId).page].reverse();
    expect(msgs.map((x: any) => x.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant", "tool"]);
    expect(msgs.at(-1)).toMatchObject({ role: "tool", status: "success", finishReason: "tool-calls" });
    const results = msgs[2].parts.map((p: any) => ({ id: p.toolCallId, isError: p.isError, result: p.result }));
    expect(results).toEqual([
      { id: "e1", isError: true, result: "tool exploded" },
      { id: "e2", isError: true, result: "Unknown tool teleport" },
      { id: "e3", isError: true, result: expect.stringMatching(/^Invalid arguments at orderId/) },
    ]);
    expect(toolCalls).toEqual([]);
  });

  test("a model error fails the message (streamed text kept); retry runs it again", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    models.current = mockModel([{ text: "Partial answ", error: "upstream 503" }], { chunkSize: 4 });
    const { responseId } = h.mutate("chat:send", { threadId, text: "q" }) as any;
    await h.tick();
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({ status: "failed", error: "upstream 503", text: "Partial answ" });
    expect(count(h, "agent$deltas")).toBe(0);
    expect(h.mutate("chat:retry", { messageId: "nope" })).toBe(false);

    models.current = mockModel([{ text: "Full answer." }]);
    expect(h.mutate("chat:retry", { messageId: responseId })).toBe(true);
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({ status: "pending", text: "" });
    await h.tick();
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({ status: "success", text: "Full answer." });
    expect(h.query("chat:message", { messageId: responseId })).not.toHaveProperty("error");
    expect(h.mutate("chat:retry", { messageId: responseId })).toBe(false); // succeeded: nothing to retry
  });

  test("abort: a pending response never runs; a streaming one stops at its next write and keeps its text", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    const { responseId: pending } = h.mutate("chat:send", { threadId, text: "first" }) as any;
    expect(h.mutate("chat:abort", { messageId: pending })).toBe(1);
    expect(h.jobs()).toEqual([]);
    expect(h.query("chat:message", { messageId: pending })).toMatchObject({ status: "aborted", error: "aborted" });

    let signal: AbortSignal | undefined;
    let after = 0;
    const streaming: AgentModel = {
      provider: "mock",
      modelId: "slow",
      async *stream(req: ModelRequest) {
        signal = req.signal;
        yield { type: "text-delta", text: "one two " };
        yield { type: "text-delta", text: "three " };
        h.mutate("chat:abort", { threadId }); // the user presses stop
        for (let i = 0; i < 10; i++) {
          after++;
          yield { type: "text-delta", text: "more words " };
        }
        yield { type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    };
    models.current = streaming;
    const { responseId } = h.mutate("chat:send", { threadId, text: "second" }) as any;
    await h.tick();
    expect(signal?.aborted).toBe(true);
    expect(after).toBeLessThanOrEqual(1); // stopped at the first write after the abort
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({ status: "aborted", text: "one two three " });
    expect(count(h, "agent$deltas")).toBe(0);
    // Retry after an abort works too.
    models.current = mockModel([{ text: "ok" }]);
    expect(h.mutate("chat:retry", { messageId: responseId })).toBe(true);
    await h.tick();
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({ status: "success", text: "ok" });
  });

  test("usage: per message and per thread; onUsage bills each step and drives a rate limit", async () => {
    const h = setup();
    h.mutate("orders:seed", { orderId: "A-1", status: "shipped" });
    const threadId = h.mutate("chat:createThread", { userId: "ana" }) as string;
    models.current = mockModel([
      { text: "checking", toolCalls: [{ toolName: "lookupOrder", args: { orderId: "A-1" } }], usage: { inputTokens: 300, outputTokens: 100 } },
      { text: "shipped", usage: { inputTokens: 500, outputTokens: 200 } },
    ]);
    expect(h.query("chat:budget", { userId: "ana" })).toMatchObject({ ok: true });
    h.mutate("chat:send", { threadId, text: "q" });
    await h.tick();
    expect(h.query("chat:usageRows", {})).toEqual([
      { userId: "ana", total: 400, model: "mock-model" },
      { userId: "ana", total: 700, model: "mock-model" },
    ]);
    expect((h.query("chat:thread", { threadId }) as any).usage).toEqual({ inputTokens: 800, outputTokens: 300, totalTokens: 1100 });
    const steps = [...page(h, threadId).page].reverse().filter((m: any) => m.role === "assistant");
    expect(steps.map((m: any) => m.usage.totalTokens)).toEqual([400, 700]);
    // 1100 tokens of a 1000-token budget: the next send would be refused until it refills.
    expect(h.query("chat:budget", { userId: "ana" })).toMatchObject({ ok: false, retryAfter: expect.any(Number) });
  });

  test("pagination: newest first, stable cursors; saveMessage does not generate", () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    for (let i = 0; i < 25; i++) h.mutate("chat:save", { threadId, text: `m${i}` });
    expect(h.jobs()).toEqual([]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r = h.query("chat:messages", { threadId, paginationOpts: { numItems: 10, cursor } }) as any;
      seen.push(...r.page.map((m: any) => m.text));
      cursor = r.continueCursor;
      if (r.isDone) break;
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `m${24 - i}`));
  });

  test("two threads are isolated: context, streams, abort", async () => {
    const h = setup();
    const a = h.mutate("chat:createThread", { userId: "ana" }) as string;
    const b = h.mutate("chat:createThread", { userId: "bia" }) as string;
    h.mutate("chat:save", { threadId: a, text: "secret of thread A" });
    const m = mockModel([{ text: "answer" }]);
    models.current = m;
    h.mutate("chat:send", { threadId: a, text: "question A" });
    h.mutate("chat:send", { threadId: b, text: "question B" });
    expect(h.mutate("chat:abort", { threadId: b })).toBe(1);
    await h.tick();
    expect(m.requests.length).toBe(1);
    expect(JSON.stringify(m.requests[0]!.messages)).toContain("secret of thread A");
    expect(thread(h, a).at(-1)).toMatchObject({ status: "success", text: "answer" });
    expect(thread(h, b)).toEqual([
      { role: "user", status: "success", text: "question B", parts: ["text"] },
      { role: "assistant", status: "aborted", text: "", parts: [] },
    ]);
    models.current = m;
    h.mutate("chat:send", { threadId: b, text: "again" });
    await h.tick();
    expect(JSON.stringify(m.requests[1]!.messages)).not.toContain("thread A");
    expect((h.query("chat:threads", { userId: "bia", paginationOpts: { numItems: 10, cursor: null } }) as any).page.map((t: any) => t._id)).toEqual([b]);
  });

  test("context: the last N messages plus older ones matching the prompt (full-text search)", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    h.mutate("chat:save", { threadId, text: "my favourite colour is turquoise" });
    for (let i = 0; i < 10; i++) h.mutate("chat:save", { threadId, text: `filler ${i}` });
    const m = mockModel([{ text: "turquoise!" }]);
    models.current = m;
    h.mutate("chat:send", { threadId, text: "what colour did I say? turquoise?" });
    await h.tick();
    const texts = m.requests[0]!.messages.map((x) => (x.content[0] as { text: string }).text);
    // 2 search hits at most (limit 2), then the 6 most recent messages (the prompt is the last).
    expect(texts[0]).toBe("my favourite colour is turquoise");
    expect(texts.slice(1)).toEqual(["filler 5", "filler 6", "filler 7", "filler 8", "filler 9", "what colour did I say? turquoise?"]);
    expect((h.query("chat:search", { threadId, text: "turquoise" }) as any[]).length).toBeGreaterThanOrEqual(2);
  });

  test("a duplicated generation job does nothing; deleteThread removes everything", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    const m = mockModel([{ text: "once" }]);
    models.current = m;
    const { responseId } = h.mutate("chat:send", { threadId, text: "q" }) as any;
    const job = h.jobs()[0]!;
    await h.tick();
    await h.runAction(job.fn, job.args); // at-least-once delivery
    expect(m.requests.length).toBe(1);
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({ status: "success", text: "once" });
    expect(h.mutate("chat:remove", { threadId })).toBe(true);
    await h.tick();
    expect(count(h, "agent$messages") + count(h, "agent$threads") + count(h, "agent$deltas")).toBe(0);
  });

  test("streamArgs page: one query returns the page and the deltas of its streaming messages", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    let snapshot: any;
    models.current = {
      provider: "mock",
      modelId: "m",
      async *stream() {
        yield { type: "text-delta", text: "abcdefghij" }; // ≥ maxChars: written at once
        yield { type: "text-delta", text: "klm" };
        snapshot = h.query("chat:messages", { threadId, paginationOpts: { numItems: 10, cursor: null }, streamArgs: { kind: "page" } });
        yield { type: "finish" };
      },
    };
    h.mutate("chat:send", { threadId, text: "q" });
    await h.tick();
    expect(withStreams(snapshot.page, snapshot.streams).at(-1)).toMatchObject({ status: "streaming", streaming: true, text: "abcdefghijklm" });
  });
});
