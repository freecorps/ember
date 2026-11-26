// The agent component end to end on the real engine (see harness.ts), with scripted models (no network).
import { mutationGeneric } from "@freecorps/ember-server";
import { beforeEach, describe, expect, test } from "vitest";
import { mockModel, withStreams, type AgentModel, type ModelRequest } from "../src/index.ts";
import { app, appWithoutSearch, functions, models, schema, slowTool, toolCalls } from "./app.ts";
import { harness } from "./harness.ts";

const setup = (opts: { beforeMutation?: (name: string, args: unknown) => Promise<void> | undefined } = {}) => harness({ schema, functions, app, ...opts });
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

  test("a long answer: deltas are compacted, so each re-run of the live query reads a bounded number of rows", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", { userId: "ana" }) as string;
    const chunks = Array.from({ length: 300 }, (_, i) => `w${i} `);
    models.current = mockModel([{ text: chunks }]);
    const streams = h.live("chat:messages", { threadId, paginationOpts: { numItems: 0, cursor: null }, streamArgs: { kind: "list" } });
    const pages = h.live("chat:messages", { threadId, paginationOpts: { numItems: 20, cursor: null } });
    const seen: string[] = [];
    let maxRows = 0;
    const orig = streams.onCommit.bind(streams);
    streams.onCommit = (changes: any[]) => {
      orig(changes);
      maxRows = Math.max(maxRows, count(h, "agent$deltas"));
      const live = withStreams(pages.value.page, streams.value.streams).at(-1);
      if (live?.streaming && live.text) seen.push(live.text);
    };
    h.mutate("chat:send", { threadId, text: "long one" });
    await h.tick();
    const full = chunks.join("");
    // Every state the subscriber saw is a prefix of the answer, one longer than the previous, and nothing is lost.
    expect(seen.length).toBe(300);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.length).toBeGreaterThan(seen[i - 1]!.length);
    expect(seen.every((t) => full.startsWith(t))).toBe(true);
    expect(seen.at(-1)).toBe(full);
    // Rows: at most 15 per level (300 batches → 3 levels) instead of up to 300; reads per re-run follow.
    expect(maxRows).toBeLessThanOrEqual(45);
    expect(streams.maxStreams).toBeLessThanOrEqual(45);
    // node:sqlite usage of the 300 re-runs: 45 452 rows read before compaction (1 + 2 + … + 300 deltas), 4 547 after.
    expect(streams.rowsRead).toBeLessThan(5000);
    expect(withStreams(pages.value.page, streams.value.streams).at(-1)).toMatchObject({ text: full, status: "success", streaming: false });
    expect(count(h, "agent$deltas")).toBe(0);
  });

  test("listMessages reads the thread id, not its row: thread writes (title, usage, lastOrder) re-run no page or stream", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", { userId: "ana" }) as string;
    h.mutate("chat:save", { threadId, text: "hi" });
    const pages = h.live("chat:messages", { threadId, paginationOpts: { numItems: 20, cursor: null } });
    const streams = h.live("chat:messages", { threadId, paginationOpts: { numItems: 0, cursor: null }, streamArgs: { kind: "list" } });
    h.mutate("chat:rename", { threadId, title: "Orders" });
    h.mutate("chat:rename", { threadId, title: "Orders (2)" });
    // Before: both re-ran on every thread write (the row was in their read set).
    expect({ pages: pages.reruns, streams: streams.reruns }).toEqual({ pages: 0, streams: 0 });
    // A message still re-runs the page; a thread id of another table or a deleted thread still gives an empty page.
    h.mutate("chat:save", { threadId, text: "again" });
    expect(pages.reruns).toBe(1);
    const none = { page: [], isDone: true, continueCursor: "" };
    expect(h.query("chat:messages", { threadId: "nope", paginationOpts: { numItems: 5, cursor: null } })).toEqual(none);
    // An id of another table (a message's) is no thread either: normalizeId gives null, it does not throw.
    const messageId = page(h, threadId).page[0]._id as string;
    expect(h.query("chat:messages", { threadId: messageId, paginationOpts: { numItems: 5, cursor: null } })).toEqual(none);
    expect(h.query("chat:messages", { threadId: messageId, paginationOpts: { numItems: 5, cursor: null }, streamArgs: { kind: "list" } })).toEqual({ ...none, streams: [] });
    h.mutate("chat:remove", { threadId });
    await h.tick();
    // A deleted thread answers as before (the row is read for an empty page only): same cursor as an id of no thread.
    expect(h.query("chat:messages", { threadId, paginationOpts: { numItems: 5, cursor: null } })).toEqual(none);
    expect((h.query("chat:messages", { threadId, paginationOpts: { numItems: 5, cursor: null }, streamArgs: { kind: "page" } }) as any)).toEqual({ ...none, streams: [] });
    expect((h.query("chat:messages", { threadId, paginationOpts: { numItems: 0, cursor: null }, streamArgs: { kind: "list" } }) as any).streams).toEqual([]);
  });

  test("deltas are pipelined: one appendDelta in flight at most, text arriving meanwhile coalesced, in order", async () => {
    let release: (() => void) | undefined;
    /** After the first write: each write is held for one timer turn. */
    let auto = false;
    let inFlight = 0;
    let maxInFlight = 0;
    const deltas: Array<{ seq: number; text: string }> = [];
    const h = setup({
      beforeMutation: (name, args) => {
        if (!name.endsWith("lib:appendDelta")) return undefined;
        deltas.push({ seq: (args as any).seq, text: (args as any).text });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<void>((r) => (auto ? setTimeout(r, 0) : (release = r))).then(() => void inFlight--);
      },
    });
    const threadId = h.mutate("chat:createThread", {}) as string;
    let resumed = 0;
    models.current = {
      provider: "mock",
      modelId: "slow-rpc",
      async *stream() {
        yield { type: "text-delta", text: "aaaaaaaa" }; // a batch: written (and held)
        // The stream goes on while that write is in flight: these coalesce into the next one.
        for (const t of ["b", "c", "d"]) yield { type: "text-delta", text: t };
        resumed = deltas.length;
        auto = true;
        release!(); // the first write returns: the coalesced text goes out at once (one more write, held)
        await new Promise((r) => setTimeout(r, 0));
        yield { type: "text-delta", text: "e" }; // that write is still in flight: "e" waits for it
        yield { type: "finish" };
      },
    };
    const { responseId } = h.mutate("chat:send", { threadId, text: "q" }) as any;
    await h.tick();
    expect(resumed).toBe(1); // the model was not paused by the write in flight
    expect(maxInFlight).toBe(1);
    expect(deltas).toEqual([{ seq: 0, text: "aaaaaaaa" }, { seq: 1, text: "bcd" }, { seq: 2, text: "e" }]);
    // The finish waited for the writes in flight (the one "bcd" chained included), then wrote the whole text.
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({ status: "success", text: "aaaaaaaabcde" });
    expect(count(h, "agent$deltas")).toBe(0);
  });

  test("a stream error while a delta is in flight: the failed message keeps all the streamed text", async () => {
    let release: (() => void) | undefined;
    const h = setup({ beforeMutation: (name) => (name.endsWith("lib:appendDelta") ? new Promise<void>((r) => (release = r)) : undefined) });
    const threadId = h.mutate("chat:createThread", {}) as string;
    models.current = {
      provider: "mock",
      modelId: "slow-rpc",
      async *stream() {
        yield { type: "text-delta", text: "aaaaaaaa" };
        yield { type: "text-delta", text: "bb" };
        setTimeout(() => release!(), 0); // the first write returns; then the rest is written by the flush
        setTimeout(() => release!(), 5);
        yield { type: "error", error: new Error("upstream 503") };
      },
    };
    const { responseId } = h.mutate("chat:send", { threadId, text: "q" }) as any;
    await h.tick();
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({ status: "failed", error: "upstream 503", text: "aaaaaaaabb" });
  });

  test("a delta write that throws: the text buffered while it ran is still written before the step fails", async () => {
    const seqs: number[] = [];
    const h = setup({
      beforeMutation: (name, args) => {
        if (!name.endsWith("lib:appendDelta")) return undefined;
        const seq = (args as any).seq as number;
        seqs.push(seq);
        return seq === 0 ? new Promise<void>((_, reject) => setTimeout(() => reject(new Error("rpc dropped")), 0)) : undefined;
      },
    });
    const threadId = h.mutate("chat:createThread", {}) as string;
    models.current = {
      provider: "mock",
      modelId: "flaky-rpc",
      async *stream() {
        yield { type: "text-delta", text: "aaaaaaaa" }; // a batch: its write throws
        yield { type: "text-delta", text: "bb" }; // buffered while that write runs
        await new Promise((r) => setTimeout(r, 5));
        yield { type: "text-delta", text: "c" }; // the failure is seen here and rethrown
      },
    };
    const { responseId } = h.mutate("chat:send", { threadId, text: "q" }) as any;
    await h.tick();
    expect(seqs).toEqual([0, 1]);
    // The chunk of the write that threw is lost (as before, when it was awaited inline); "bb" is not.
    expect(h.query("chat:message", { messageId: responseId })).toMatchObject({ status: "failed", error: "rpc dropped", text: "bb" });
    expect(count(h, "agent$deltas")).toBe(0);
  });

  test("abort and fail after compaction keep the exact streamed text", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    const chunks = Array.from({ length: 40 }, (_, i) => `${i},`);
    models.current = mockModel([{ text: chunks, error: "upstream 503" }]);
    const { responseId: failed } = h.mutate("chat:send", { threadId, text: "a" }) as any;
    await h.tick();
    expect(h.query("chat:message", { messageId: failed })).toMatchObject({ status: "failed", text: chunks.join("") });
    expect(count(h, "agent$deltas")).toBe(0);

    let n = 0;
    const words: string[] = [];
    models.current = {
      provider: "mock",
      modelId: "slow",
      async *stream() {
        for (;;) {
          const w = `${n} `;
          words.push(w);
          yield { type: "text-delta", text: w };
          if (++n === 37) h.mutate("chat:abort", { threadId });
        }
      },
    } as AgentModel;
    const { responseId: aborted } = h.mutate("chat:send", { threadId, text: "b" }) as any;
    await h.tick();
    // 37 batches written before the abort (the 38th write sees it and stops).
    expect(h.query("chat:message", { messageId: aborted })).toMatchObject({ status: "aborted", text: words.slice(0, 37).join("") });
    expect(count(h, "agent$deltas")).toBe(0);
  });

  test("compaction merges whatever rows a range holds, in seq order (gaps, rows left unmerged by an older version)", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    const call = (fn: string, args: unknown) => h.engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.runMutation(`@agent/lib:${fn}`, args) }) as any).value as any;
    const sent = call("send", { threadId, prompt: { parts: [{ type: "text", text: "q" }] }, generate: { action: "&chat:generate" } });
    const { runId } = call("start", { messageId: sent.responseId, recentMessages: 5 });
    const append = (seq: number) => expect(call("appendDelta", { messageId: sent.responseId, runId, seq, text: `${seq};` })).toBe(true);
    const streams = () => (h.query("chat:messages", { threadId, paginationOpts: { numItems: 0, cursor: null }, streamArgs: { kind: "list" } }) as any).streams as Array<{ seq: number; text: string }>;
    const joined = () => streams().map((d) => d.text).join("");
    // Seqs 3 and 9 never arrive: the boundary at 15 merges the 13 rows it finds.
    const sent1 = Array.from({ length: 16 }, (_, i) => i).filter((i) => i !== 3 && i !== 9);
    for (const seq of sent1) append(seq);
    expect(streams().map((d) => d.seq)).toEqual([0]);
    expect(joined()).toBe(sent1.map((i) => `${i};`).join(""));
    // An older version left seqs 16..19 as single rows; the boundary at 31 merges them with the new ones.
    for (let seq = 16; seq < 32; seq++) append(seq);
    expect(streams().map((d) => d.seq)).toEqual([0, 16]);
    for (let seq = 32; seq < 256; seq++) append(seq);
    expect(streams().map((d) => d.seq)).toEqual([0]); // level 2 at 255
    expect(joined()).toBe([...sent1, ...Array.from({ length: 240 }, (_, i) => i + 16)].map((i) => `${i};`).join(""));
    expect(call("fail", { messageId: sent.responseId, runId, error: "x" })).toBe(true);
    expect(h.query("chat:message", { messageId: sent.responseId })).toMatchObject({ status: "failed", text: expect.stringMatching(/^0;1;2;4;/) });
    expect(count(h, "agent$deltas")).toBe(0);
  });

  test("a boundary whose range is empty keeps its row as the block's one row; the next level merges it", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    const call = (fn: string, args: unknown) => h.engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.runMutation(`@agent/lib:${fn}`, args) }) as any).value as any;
    const sent = call("send", { threadId, prompt: { parts: [{ type: "text", text: "q" }] }, generate: { action: "&chat:generate" } });
    const { runId } = call("start", { messageId: sent.responseId, recentMessages: 5 });
    const append = (seq: number) => expect(call("appendDelta", { messageId: sent.responseId, runId, seq, text: `${seq};` })).toBe(true);
    const seqs = () => ((h.query("chat:messages", { threadId, paginationOpts: { numItems: 0, cursor: null }, streamArgs: { kind: "list" } }) as any).streams as Array<{ seq: number }>).map((d) => d.seq);
    // Seqs 0..14 never arrive: the boundary at 15 finds nothing and inserts its row at 15, standing for block [0, 16).
    append(15);
    expect(seqs()).toEqual([15]);
    for (let seq = 16; seq < 255; seq++) append(seq);
    expect(seqs().length).toBeLessThanOrEqual(30); // ≤ 15 per level: the row at 15 is one of the level-16 rows
    append(255); // the level-256 boundary merges [0, 255), the row at 15 included
    expect(seqs()).toEqual([15]);
    expect(call("fail", { messageId: sent.responseId, runId, error: "x" })).toBe(true);
    const want = Array.from({ length: 241 }, (_, i) => `${i + 15};`).join("");
    expect(h.query("chat:message", { messageId: sent.responseId })).toMatchObject({ status: "failed", text: want });
    expect(count(h, "agent$deltas")).toBe(0);
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

  test("the tool calls of one step run concurrently; results keep the call order", async () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", {}) as string;
    Object.assign(slowTool, { inFlight: 0, max: 0 });
    models.current = mockModel([
      { toolCalls: [{ toolName: "slow", args: { ms: 30 }, toolCallId: "s1" }, { toolName: "slow", args: { ms: 5 }, toolCallId: "s2" }, { toolName: "teleport", args: {}, toolCallId: "s3" }] },
      { text: "done" },
    ]);
    h.mutate("chat:send", { threadId, text: "go" });
    await h.tick();
    expect(slowTool.max).toBe(2);
    const tool = page(h, threadId).page.find((x: any) => x.role === "tool");
    expect(tool.parts.map((p: any) => [p.toolCallId, p.result])).toEqual([["s1", 30], ["s2", 5], ["s3", "Unknown tool teleport"]]);
    expect(thread(h, threadId).at(-1)).toMatchObject({ role: "assistant", status: "success", text: "done" });
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
    // Stopped by the first write after the abort: its result is seen at the next event (writes are pipelined).
    expect(after).toBeLessThanOrEqual(2);
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

// PR 3a (v0.10): node:sqlite usage (rows returned / changed) before → after in the comments (main at c95ae510).
describe("agent: fewer writes and reads (PR 3a)", () => {
  test("send: the response is inserted once with its job, and the turn just written is not read back", () => {
    const h = setup();
    const threadId = h.mutate("chat:createThread", { userId: "ana" }) as string;
    h.counters.clear();
    const r = h.mutate("chat:send", { threadId, text: "hi" }) as any;
    // before: 4 written (prompt, response, its patch with the job, the thread), 3 read; now 3 and 2.
    expect(h.counters.get("chat:send")).toMatchObject({ rowsWritten: 3, rowsRead: 2 });
    const job = h.jobs().find((j) => j.fn === "chat:generate")!;
    expect(h.sql(`SELECT "job", "stepOrder" FROM "agent$messages" WHERE "_id" = '${r.responseId ?? (job.args as any).messageId}'`)).toEqual([{ job: job.id, stepOrder: 1 }]);
    // Without a prompt the turn's last step is read (the response follows it).
    h.counters.clear();
    h.mutate("chat:save", { threadId, text: "more" });
    expect(h.counters.get("chat:save")!.rowsWritten).toBeLessThanOrEqual(2);
  });

  test("a tool step: the next assistant step takes action and onUsage from the tool message (no read back)", async () => {
    let clear = false;
    let h!: H;
    h = setup({
      beforeMutation: (name) => {
        // A tool message from before 0.10 (no action/onUsage on it): the step before it is read, as before.
        if (clear && name === "@agent/lib:toolResults") h.sql(`UPDATE "agent$messages" SET "action" = NULL, "onUsage" = NULL WHERE "role" = 'tool'`);
        return undefined;
      },
    });
    h.mutate("orders:seed", { orderId: "A-1", status: "shipped" });
    for (const old of [false, true]) {
      clear = old;
      const threadId = h.mutate("chat:createThread", { userId: "ana" }) as string;
      models.current = mockModel([{ text: "Let me check.", toolCalls: [{ toolName: "lookupOrder", args: { orderId: "A-1" }, toolCallId: "c1" }] }, { text: "Shipped.", usage: { inputTokens: 1, outputTokens: 1 } }]);
      h.mutate("chat:send", { threadId, text: "status?" });
      h.counters.clear();
      await h.tick();
      // before: 2 rows read (the tool message, then the step before it); now 1 (2 for a tool message from before).
      expect(h.counters.get("@agent/lib:toolResults")!.rowsRead).toBe(old ? 2 : 1);
      const steps = h.sql(`SELECT "role", "action" IS NOT NULL AS a, "onUsage" IS NOT NULL AS u FROM "agent$messages" WHERE "thread" = '${threadId}' AND "role" = 'assistant' ORDER BY "stepOrder"`);
      expect(steps).toEqual([{ role: "assistant", a: 1, u: 1 }, { role: "assistant", a: 1, u: 1 }]);
      expect(thread(h, threadId).at(-1)).toMatchObject({ role: "assistant", status: "success", text: "Shipped." });
    }
    // onUsage billed both steps of both turns (the second step's handle came from the tool message, or was read)
    expect((h.query("chat:usageRows", {}) as any[]).length).toBe(4);
  });

  test("full-text search is opt-in: the default install has no FTS5 index (no FTS rows per message) and refuses search", async () => {
    const h = harness({ schema, functions, app: appWithoutSearch });
    const fts = (x: H) => x.sql(`SELECT name FROM sqlite_master WHERE name LIKE 'agent$messages__search_text%'`);
    expect(fts(h)).toEqual([]);
    const threadId = h.mutate("chat:createThread", { userId: "ana" }) as string;
    h.mutate("chat:save", { threadId, text: "the order shipped" });
    expect(() => h.query("chat:search", { threadId, text: "order" })).toThrow(/full-text search is off/);
    // an agent with contextOptions.searchOtherMessages there: the step fails with the reason before it is streamed
    // (a throw in lib:start would leave it pending while its job is retried)
    models.current = mockModel([{ text: "never" }]);
    h.mutate("chat:send", { threadId, text: "where is my order?" });
    await h.tick();
    expect(thread(h, threadId).at(-1)).toMatchObject({ role: "assistant", status: "failed", text: "" });
    expect(h.sql(`SELECT "error", "job", "runId" FROM "agent$messages" WHERE "role" = 'assistant'`)).toEqual([{ error: expect.stringMatching(/full-text search is off/), job: null, runId: null }]);
    // `{ search: true }`: the same index as before 0.10 (searchable)
    const on = setup();
    expect(fts(on).length).toBeGreaterThan(0);
    const t2 = on.mutate("chat:createThread", { userId: "ana" }) as string;
    on.mutate("chat:save", { threadId: t2, text: "the order shipped" });
    expect((on.query("chat:search", { threadId: t2, text: "order" }) as any[]).map((m) => m.text)).toEqual(["the order shipped"]);
  });
});
