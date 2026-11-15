/**
 * The workerd test app: the same app as the node tests (test/app.ts), with the Workers AI adapter over a fake `run`
 * that streams SSE like Workers AI does (text chunks ~15 ms apart, usage in the last chunk; a tool call on the first
 * step of a prompt that mentions an order). Everything else is the real runtime: Worker, Shard DO, scheduler alarm,
 * action runner, WebSocket subscriptions with rowdiff/vdiff.
 */
import { createEmberWorker } from "@freecorps/ember-runtime";
import { workersAi, type WorkersAiBinding } from "../../src/index.ts";
import { app, functions, models, schema } from "../app.ts";

export { Shard } from "@freecorps/ember-runtime";

export const ANSWER = "Your order A-1 is shipped and should arrive on Friday, between nine and noon.";
const enc = new TextEncoder();

const fakeAi: WorkersAiBinding = {
  async run(_model, inputs) {
    const messages = inputs.messages as Array<{ role: string; content: string }>;
    const prompt = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const toolDone = messages.some((m) => m.role === "tool");
    const chunks: unknown[] =
      prompt.includes("order") && !toolDone
        ? [{ response: "Checking. " }, { tool_calls: [{ name: "lookupOrder", arguments: { orderId: "A-1" } }] }]
        : (ANSWER.match(/.{1,6}/g) ?? []).map((response) => ({ response }));
    chunks.push({ response: "", usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } });
    return new ReadableStream<Uint8Array>({
      async start(c) {
        for (const x of chunks) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(x)}\n\n`));
          await new Promise((r) => setTimeout(r, 15));
        }
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
  },
};

models.current = workersAi("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { ai: fakeAi, stream: true });

export default createEmberWorker({ schema, functions, app });
