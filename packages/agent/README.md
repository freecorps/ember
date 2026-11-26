# @freecorps/ember-agent

AI assistants for Ember apps, as a component. You get threads and messages stored in the caller's shard, responses
streamed to every live client through ordinary reactive queries, tool calls, and token usage tracking. Models can
be Workers AI (`env.EMBER_AI`, optionally through an AI Gateway) or any Vercel AI SDK model your app passes in.
The `ai` package is not a dependency.

## Setup

```ts
// ember/ember.config.ts
import { agent } from "@freecorps/ember-agent";
export default defineApp().use(agent);          // ember deploy binds Workers AI as EMBER_AI ({ config: { workersAi: false } } to skip)
// full-text search (searchMessages, contextOptions.searchOtherMessages) is opt-in: .use(agent, { config: { search: true } })

// ember/assistant.ts
import { Agent, tool, vStreamArgs, workersAi } from "@freecorps/ember-agent";
import { components, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

export const assistant = new Agent(components.agent, {
  name: "support",
  model: workersAi("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),      // or openai("gpt-5"), anthropic(...) from the AI SDK
  instructions: "You help users with their orders. Be brief.",
  tools: {
    lookupOrder: tool({
      description: "Finds an order by id",
      args: { orderId: v.string().describe("Like A-1") },
      handler: (ctx, { orderId }) => ctx.runQuery(internal.orders.get, { orderId }),
    }),
  },
  maxSteps: 5,
  action: internal.assistant.generate,                                 // the export below
  onUsage: internal.assistant.usage,                                   // optional
});

/** Runs the model (an internalAction): streams, calls tools, records usage. */
export const generate = assistant.action();

export const send = mutation({
  args: { threadId: v.string(), text: v.string() },
  handler: (ctx, a) => {
    mustOwn(ctx, a.threadId);                                          // access control is yours (below)
    return assistant.sendMessage(ctx, a);                              // saves the prompt + schedules the response, atomically
  },
});

export const messages = query({
  args: { threadId: v.string(), paginationOpts: paginationOptsValidator, streamArgs: vStreamArgs },
  handler: (ctx, a) => {
    mustOwn(ctx, a.threadId);
    return assistant.listMessages(ctx, a);
  },
});
```

```tsx
// client
import { useSmoothText, useThreadMessages } from "@freecorps/ember-agent/react";

const { results, status, loadMore } = useThreadMessages(api.assistant.messages, { threadId }, { initialNumItems: 20 });
// results: oldest first; a message being written has `streaming: true` and its text so far
function Bubble({ m }) {
  const [text] = useSmoothText(m.text, { startStreaming: m.streaming });
  return <p>{text}</p>;
}
```

## How a response runs

1. `sendMessage` (in your mutation) writes the user message, an assistant message in `pending` status, and a job
   for your `generate` action, all in the same transaction. If the mutation fails afterwards, none of them exist.
2. The action moves the message to `streaming` and claims it with a fresh run id. It loads the context window and
   calls the model.
3. While text (and, for models that expose it, reasoning) arrives, it writes **deltas** in small batches: every `streaming.throttleMs` (200 ms by default) or
   `maxChars` (4000) characters, at most one write in flight: the stream is not paused by it, and text that arrives
   meanwhile joins the next batch. Deltas are rows of their own, so the message row is untouched while it streams.
   A live `listMessages` subscription gets each batch as one inserted row through the rowdiff/vdiff patches.
   Measured (`test/workerd`): about 234 bytes per delta patch frame, envelope included. That cost is fixed, plus
   the new text, however long the answer gets. The message row changes once, when the step finishes, and that
   final patch was 739 bytes for a 77-character answer with a tool step.
   Deltas are compacted as they arrive: every 16th batch merges the 15 rows before it into one (every 256th merges
   those), so a re-run of the live query reads at most 15 rows per level, not every batch so far (300 batches:
   ~4.5k rows read in total instead of ~45k). The merging patch carries the merged text once.
4. When the step finishes, its final parts and usage are saved and the deltas are deleted. The `onUsage` mutation
   runs in that same transaction.
5. If the model asked for tools, the action validates the arguments and runs the handlers concurrently (`ctx.runQuery`,
   `runMutation`, `runAction`, and the thread, message and user ids). It saves a `tool` message with the results,
   then runs the next step. This repeats up to `maxSteps` model calls.

**Statuses:** `pending` → `streaming` → `success` | `failed` | `aborted`.
- **Model errors:** a call that fails **before its first delta** with 429 or 5xx (or an error marked `isRetryable`,
  as AI SDK errors are) is retried, waiting `Retry-After` when the error has one: `retry: { maxAttempts: 3,
  initialBackoffMs: 500, maxBackoffMs: 20_000 }` by default, `retry: false` to turn it off. After the first delta
  (text, reasoning or a tool call) the step is not repeated: the message becomes `failed` with `error`, and the text
  streamed so far is kept. `assistant.retry(ctx, messageId)` runs it again.
- **Tool errors:** a throw, an unknown tool or invalid arguments become a `tool-result` with `isError: true`. The
  model sees it and goes on.
- **Abort:** `assistant.abort(ctx, { threadId } | { messageId })`. A pending response never runs. A streaming one
  keeps its text so far, and the action stops at its next write: every write is fenced by status and run id, and
  the model call gets an `AbortSignal`.
- **Duplicate deliveries:** actions are at-least-once, so the same job can arrive twice. The second delivery
  finds the message no longer `pending` and does nothing.

## Data model

All tables live in the shard of whoever calls, next to the app's tables:

| Table | Contents |
|---|---|
| `threads` | `userId`, `title`, `summary`, `status` (active/archived), `metadata`, `usage` totals |
| `messages` | `order` (one per prompt), `stepOrder`, `role` (user/assistant/tool/system), `parts`, `text`, `status`, `model`, `provider`, `usage`, `finishReason`, `error` |
| `deltas` | `message`, `seq`, `text`, `reasoning`: batches of text (and reasoning) still being streamed |

**Parts:**
- `text` and `reasoning`
- `tool-call` (`toolCallId`, `toolName`, `args`)
- `tool-result` (`result`, `isError`)
- `file` (`file: v.file()`, `mimeType`, `filename`). Files are refcounted like any `v.file()` field and reach
  the model as short-lived URLs.

`text` has a full-text index (`searchMessages`, and the optional context search) only when the component is installed
with `{ config: { search: true } }` (since 0.10). Without it no FTS5 index exists, so message writes cost no FTS rows,
and `searchMessages` fails with `ValidationError` (an agent with `searchOtherMessages` there gets its step `failed`
with that error, before it streams). An install that searched before sets the option in the deploy that
upgrades: it is the same index, so nothing is rebuilt; turning it on later backfills it.

## Context

`contextOptions.recentMessages` (default 20) sets how many messages of the thread before the prompt are sent.
Failed messages are skipped, and a tool exchange is never cut in half.

`searchOtherMessages: { limit }` also sends older messages of the thread that match the prompt, using the FTS5
`searchIndex` (needs `{ search: true }`). Vector search is not offered: the component's tables would need an embedding model and dimensions
fixed at install. Use your own `vectorIndex` in a tool if you need it.

## Models

- `workersAi(model, { binding?, gateway?, stream?, maxTokens?, temperature? })`. By default it reads
  `ctx.env.EMBER_AI`. Locally that binding only exists with `ember dev --remote`. Workers AI documents tool calls
  on the non-streamed response, so a step that offers tools is not streamed unless you set `stream: true`.
- An AI SDK `LanguageModel` (specification v1, v2 or v3), passed as `model` or wrapped with `aiSdk(model,
  settings)`. Only `doStream` is used: the agent runs the tool loop itself.
- `defineModel({ stream } | { generate })` for anything else, and `mockModel(steps)` for tests (scripted text and
  reasoning deltas, tool calls, usage and errors with a status / `Retry-After`).
- `withRetry(model, retryOptions)`: the retry wrapper the agent uses, for your own calls.

**Reasoning.** Models that expose their reasoning stream it as `reasoning-delta` events: AI SDK reasoning parts
(v1 `reasoning`, v2/v3 `reasoning-delta`), Workers AI `reasoning_content` deltas (OpenAI-style chunks) and a leading
`<think>…</think>` (DeepSeek R1 style). It goes into the same delta rows as the text (`reasoning` column), so a live
subscription sees it grow; the finished message keeps it as a `reasoning` part (a failed or aborted one too).
`useThreadMessages` / `withStreams` give each message a `reasoning` string.

## Structured output: `generateObject`

```ts
const recipe = v.object({ title: v.string(), minutes: v.number(), tags: v.optional(v.array(v.string())) });
// in an action: one model call, nothing saved to a thread
const { object } = await assistant.generateObject(ctx, { schema: recipe, prompt: "a quick soup" });
// object: { title: string; minutes: number; tags?: string[] }
// or with any model: generateObject(workersAi("@cf/..."), { schema: { city: v.string() }, prompt, env: ctx.env })
```

The validator's JSON Schema (`toJsonSchema` of `@freecorps/ember-values`, without the wire-only `$float` branch) goes
to the model as its response format (AI SDK `responseFormat` / v1 `object-json` mode, Workers AI
`response_format: { type: "json_schema" }`) and into the system prompt. The answer is parsed (plain, fenced
` ```json `, or the outermost object in the text), defaults are applied, and it is validated: a mismatch throws
`ObjectGenerationError` with the model's `text` and the failing `path`. Retries before the first delta apply.

## Usage, billing and rate limits

Usage is recorded on three levels:
- every assistant step stores its `usage` (`inputTokens`, `outputTokens`, `totalTokens`);
- every thread stores the sum;
- `onUsage` gets a `UsageEvent` for every step, in the transaction that records it.

A throw in `onUsage` is undone and logged, and the step is still saved. With `@freecorps/ember-rate-limit`:

```ts
const limiter = new RateLimiter(components.rateLimit, { tokens: { kind: "token bucket", rate: 50_000, period: HOUR, maxReserved: 1_000_000 } });

export const usage = internalMutation({
  args: { threadId: v.string(), messageId: v.string(), userId: v.optional(v.string()), agentName: v.optional(v.string()),
          model: v.optional(v.string()), provider: v.optional(v.string()), usage: v.object({ inputTokens: v.number(), outputTokens: v.number(), totalTokens: v.number() }) },
  handler: (ctx, e) => {
    if (e.userId) limiter.limit(ctx, "tokens", { key: e.userId, count: e.usage.totalTokens, reserve: true });   // may go negative
  },
});

// in send: refuse while the user's budget is negative
if (!limiter.check(ctx, "tokens", { key: me }).ok) throw new Error("Token budget exhausted");
```

## Access control

The component does not check who is calling. Threads carry a `userId`, and your functions check it before calling
the helpers (`assistant.getThread(ctx, threadId)?.userId === me`). Clients never call component functions directly.

## Concurrency

Each response is one action job on the shard's scheduler. To cap concurrent model calls (an API budget, a
provider's rate limit), throttle in `send` with `@freecorps/ember-rate-limit`. Running the generation through a
bounded pool is a planned follow-up.
