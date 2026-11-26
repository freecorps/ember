/**
 * The agent component end to end in workerd: a WebSocket client (features rowdiff + vdiff) subscribes to the thread's
 * pages and to its live deltas, sends a prompt over HTTP; the shard's scheduler runs the generation action, which
 * streams from the Workers AI adapter (fake `run`, real SSE parsing), calls a tool, and writes delta batches. The
 * client rebuilds both values from the patches; the bytes of each delta patch frame are measured.
 */
import { SELF } from "cloudflare:test";
import { applyValueDiff, applyRowDiff } from "@freecorps/ember-values";
import { describe, expect, it } from "vitest";
import { withStreams } from "../../src/index.ts";
import { ANSWER, REASONING } from "./worker.ts";

const SHARD = "global:main";
const call = async (kind: "query" | "mutation", fn: string, args: unknown) => {
  const res = await SELF.fetch(`http://ember/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard: SHARD }) });
  const body = (await res.json()) as { ok: boolean; value?: any };
  if (!body.ok) throw new Error(`${kind} ${fn}: ${JSON.stringify(body)}`);
  return body.value;
};

async function socket() {
  const res = await SELF.fetch(`http://ember/ws?shard=${encodeURIComponent(SHARD)}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket!;
  ws.accept();
  const frames: Array<{ raw: string; m: any }> = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (e) => {
    const raw = String(e.data);
    if (raw === "pong") return;
    frames.push({ raw, m: JSON.parse(raw) });
    for (const w of waiters.splice(0)) w();
  });
  const until = async (pred: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timeout; frames: ${frames.map((f) => f.raw.slice(0, 200)).join("\n")}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  ws.send(JSON.stringify({ t: "hello", clientId: crypto.randomUUID(), protocol: 1, features: ["rowdiff", "vdiff"] }));
  await until(() => frames.some((f) => f.m.t === "ready"));
  return { ws, frames, until, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe("agent component in workerd", () => {
  it("streams a response with a tool call to a live subscription; small delta patches", async () => {
    await call("mutation", "orders:seed", { orderId: "A-1", status: "shipped" });
    const threadId = (await call("mutation", "chat:createThread", { userId: "ana" })) as string;
    const c = await socket();
    const pageArgs = { threadId, paginationOpts: { numItems: 20, cursor: null } };
    c.send({ t: "sub", qid: 1, fn: "chat:messages", args: pageArgs });
    c.send({ t: "sub", qid: 2, fn: "chat:messages", args: { ...pageArgs, paginationOpts: { numItems: 0, cursor: null }, streamArgs: { kind: "list" } } });
    await c.until(() => c.frames.filter((f) => f.m.t === "snap").length === 2);
    const values = new Map<number, any>(c.frames.filter((f) => f.m.t === "snap").map((f) => [f.m.qid, f.m.value]));

    // Rebuild both values from the patches, as the client does; remember every text the user would have seen.
    const seenBy = new Map<string, string[]>();
    const deltaFrames: number[] = [];
    let applied = 0;
    const apply = () => {
      for (const f of c.frames.slice(applied)) {
        applied++;
        if (f.m.t !== "patch") continue;
        for (const ch of f.m.changes) {
          const prev = values.get(ch.qid);
          values.set(ch.qid, ch.vdiff ? applyValueDiff(prev, ch.vdiff) : ch.diff ? applyRowDiff(prev, ch.diff) : ch.value);
        }
        if (f.m.changes.length === 1 && f.m.changes[0].qid === 2 && f.raw.includes('"text":')) deltaFrames.push(f.raw.length);
        const last = withStreams(values.get(1).page, values.get(2).streams).at(-1);
        if (last?.streaming && last.text) {
          const list = seenBy.get(last._id) ?? [];
          if (list.at(-1) !== last.text) list.push(last.text);
          seenBy.set(last._id, list);
        }
      }
    };
    const done = () => {
      apply();
      const page = values.get(1)?.page ?? [];
      return page.length >= 4 && page[0].role === "assistant" && page[0].status === "success";
    };

    await call("mutation", "chat:send", { threadId, text: "where is my order A-1?" });
    await c.until(done);

    const ui = withStreams(values.get(1).page, values.get(2).streams);
    expect(ui.map((m) => [m.role, m.status, m.text])).toEqual([
      ["user", "success", "where is my order A-1?"],
      ["assistant", "success", "Checking. "],
      ["tool", "success", ""],
      ["assistant", "success", ANSWER],
    ]);
    expect(ui[1]!.parts.map((p) => p.type)).toEqual(["text", "tool-call"]);
    expect(ui[2]!.parts[0]).toMatchObject({ type: "tool-result", toolName: "lookupOrder", result: { orderId: "A-1", status: "shipped" } });
    expect(ui[3]).toMatchObject({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider: "workers-ai", usage: { totalTokens: 60 } });
    // The patches rebuilt exactly what a fresh query returns.
    expect(values.get(1)).toEqual(await call("query", "chat:messages", pageArgs));
    expect(values.get(2).streams).toEqual([]);

    // The text of the answer grew batch by batch on the live subscription.
    const seen = seenBy.get(ui[3]!._id) ?? [];
    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.startsWith(seen[i - 1]!)).toBe(true);
    const avg = deltaFrames.reduce((a, b) => a + b, 0) / deltaFrames.length;
    const final = c.frames.filter((f) => f.m.t === "patch").at(-1)!.raw.length;
    console.log(`agent workerd: ${deltaFrames.length} delta patch frames, avg ${avg.toFixed(0)} B, max ${Math.max(...deltaFrames)} B; answer ${ANSWER.length} chars; finishing patch ${final} B`);
    expect(deltaFrames.length).toBeGreaterThanOrEqual(5);
    expect(avg).toBeLessThan(300);

    // Usage reached the app's onUsage (two steps of 60 tokens).
    expect((await call("query", "chat:usageRows", {})).filter((u: any) => u.userId === "ana").map((u: any) => u.total)).toEqual([60, 60]);
    expect((await call("query", "chat:thread", { threadId })).usage.totalTokens).toBe(120);
    c.ws.close();
  });

  it("a reasoning model: reasoning-delta streams in the delta rows and ends as a reasoning part", async () => {
    const threadId = (await call("mutation", "chat:createThread", {})) as string;
    const c = await socket();
    const pageArgs = { threadId, paginationOpts: { numItems: 20, cursor: null } };
    c.send({ t: "sub", qid: 1, fn: "chat:messages", args: pageArgs });
    c.send({ t: "sub", qid: 2, fn: "chat:messages", args: { ...pageArgs, paginationOpts: { numItems: 0, cursor: null }, streamArgs: { kind: "list" } } });
    await c.until(() => c.frames.filter((f) => f.m.t === "snap").length === 2);
    const values = new Map<number, any>(c.frames.filter((f) => f.m.t === "snap").map((f) => [f.m.qid, f.m.value]));
    const seen: string[] = [];
    let applied = 0;
    const done = () => {
      for (const f of c.frames.slice(applied)) {
        applied++;
        if (f.m.t !== "patch") continue;
        for (const ch of f.m.changes) values.set(ch.qid, ch.vdiff ? applyValueDiff(values.get(ch.qid), ch.vdiff) : ch.diff ? applyRowDiff(values.get(ch.qid), ch.diff) : ch.value);
        const last = withStreams(values.get(1).page, values.get(2).streams).at(-1);
        if (last?.streaming && last.reasoning && seen.at(-1) !== last.reasoning) seen.push(last.reasoning);
      }
      const page = values.get(1)?.page ?? [];
      return page.length >= 2 && page[0].role === "assistant" && page[0].status === "success";
    };
    await call("mutation", "chat:send", { threadId, text: "think: when does it arrive?" });
    await c.until(done);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!.startsWith(seen[i - 1]!)).toBe(true);
    const ui = withStreams(values.get(1).page, values.get(2).streams);
    expect(ui.at(-1)).toMatchObject({ text: "Friday.", reasoning: REASONING, streaming: false });
    expect(ui.at(-1)!.parts).toEqual([
      { type: "reasoning", text: REASONING },
      { type: "text", text: "Friday." },
    ]);
    c.ws.close();
  });

  it("abort from another request stops a streaming response mid-way", async () => {
    const threadId = (await call("mutation", "chat:createThread", {})) as string;
    const { responseId } = await call("mutation", "chat:send", { threadId, text: "tell me something long" });
    let m: any;
    for (let i = 0; i < 200; i++) {
      m = await call("query", "chat:messages", { threadId, paginationOpts: { numItems: 5, cursor: null }, streamArgs: { kind: "page" } });
      if (m.streams.length >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(m.streams.length).toBeGreaterThanOrEqual(2);
    expect(await call("mutation", "chat:abort", { threadId })).toBe(1);
    await new Promise((r) => setTimeout(r, 400)); // the action notices at its next write and stops
    const msg = await call("query", "chat:message", { messageId: responseId });
    expect(msg.status).toBe("aborted");
    expect(msg.text.length).toBeGreaterThan(0);
    expect(msg.text.length).toBeLessThan(ANSWER.length);
    expect(ANSWER.startsWith(msg.text)).toBe(true);
  });
});
