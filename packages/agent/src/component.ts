// The agent component (PLAN §12, §22 L12): threads, messages and streaming deltas in the caller's shard.
//
// One response, per user prompt (all in the shard of the thread):
//   lib:send (mutation, in the caller's transaction) ─ user message + assistant placeholder (pending) + a job that
//       runs the app's generation action (a function handle: `agent.action()`, exported by the app)
//   app action ─ lib:start (pending → streaming, fenced by a fresh runId; returns the context window)
//       → model stream → lib:appendDelta (small `deltas` rows, every ~100 ms; returns false once aborted)
//       → lib:finishStep (final parts, usage, onUsage handle in the same transaction; deltas deleted)
//       → tool calls: a `tool` message (streaming while the tools run) → lib:toolResults → next assistant step
//   lib:abort ─ pending: job cancelled; streaming: the partial text is kept, status "aborted"; the action stops at
//       its next write (every write is fenced by status + runId).
// Text being streamed lives in `deltas`, not in the message row: a live `listMessages` query sees each batch as one
// small inserted row (rowdiff/vdiff patch), and the message row changes once, when the step finishes.
// Deltas are compacted as they come (DELTA_FANOUT): every 16th batch merges the 15 rows before it into one, every
// 256th merges those, and so on, so a re-run of the live query reads a few dozen rows at most instead of every batch
// of the answer so far (that was O(K) per batch, O(K²) per answer and subscriber).

import {
  componentBuilders,
  defineComponent,
  defineSchema,
  defineTable,
  EmberError,
  paginationOptsValidator,
  v,
  type ComponentCtx,
  type DataModelFromSchema,
  type GenericId,
  type Infer,
  unsafeRef,
  type PatchValue,
} from "@freecorps/ember-server";

export const usageValidator = v.object({ inputTokens: v.number(), outputTokens: v.number(), totalTokens: v.number() });

/** One part of a message: text, reasoning, a tool call, a tool result, or a file (`v.file()`, refcounted). */
export const partValidator = v.union(
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({ type: v.literal("reasoning"), text: v.string() }),
  v.object({ type: v.literal("tool-call"), toolCallId: v.string(), toolName: v.string(), args: v.any() }),
  v.object({ type: v.literal("tool-result"), toolCallId: v.string(), toolName: v.string(), result: v.any(), isError: v.optional(v.boolean()) }),
  v.object({ type: v.literal("file"), file: v.file(), mimeType: v.string(), filename: v.optional(v.string()) }),
);

export const roleValidator = v.union(v.literal("user"), v.literal("assistant"), v.literal("tool"), v.literal("system"));
export const messageStatusValidator = v.union(v.literal("pending"), v.literal("streaming"), v.literal("success"), v.literal("failed"), v.literal("aborted"));
export const streamArgsValidator = v.optional(v.object({ kind: v.union(v.literal("list"), v.literal("page")) }));

export type MessagePart = Infer<typeof partValidator>;
export type MessageRole = Infer<typeof roleValidator>;
export type MessageStatus = Infer<typeof messageStatusValidator>;
export type Usage = Infer<typeof usageValidator>;

const schema = defineSchema({
  tables: {
    threads: defineTable({
      /** Owner (the app's user id, opaque here). Access control is the app's: it checks this before calling. */
      userId: v.optional(v.string()),
      title: v.optional(v.string()),
      summary: v.optional(v.string()),
      status: v.union(v.literal("active"), v.literal("archived")),
      metadata: v.optional(v.any()),
      /** Token totals of every model call in the thread. */
      usage: usageValidator,
      /** `order` of the last prompt (the next one gets +1). */
      lastOrder: v.number(),
      updatedAt: v.number(),
    })
      .index("by_user", ["userId", "updatedAt"])
      // The dashboard's thread list (`dashboard:threads`): every thread by activity, and one status by activity.
      .index("by_updated", ["updatedAt"])
      .index("by_status", ["status", "updatedAt"]),
    messages: defineTable({
      thread: v.id("threads"),
      userId: v.optional(v.string()),
      agentName: v.optional(v.string()),
      /** One per prompt: the user message and every step of its response share it. */
      order: v.number(),
      /** 0 = the prompt; 1, 2, ... = the response's steps (assistant / tool). */
      stepOrder: v.number(),
      role: roleValidator,
      parts: v.array(partValidator),
      /** The text parts joined (what `searchMessages` and the context search look at). */
      text: v.string(),
      status: messageStatusValidator,
      model: v.optional(v.string()),
      provider: v.optional(v.string()),
      usage: v.optional(usageValidator),
      finishReason: v.optional(v.string()),
      error: v.optional(v.string()),
      metadata: v.optional(v.any()),
      /** The generation run that owns this message while it streams (fences duplicate or stale actions). */
      runId: v.optional(v.string()),
      /** Pending generation job (cancelled by abort). */
      job: v.optional(v.string()),
      /** Handle of the app's generation action (`agent.action()`), kept for `retry`. */
      action: v.optional(v.string()),
      /** Handle of the app's usage mutation (`onUsage`), called in the transaction that records a step's usage. */
      onUsage: v.optional(v.string()),
    })
      .index("by_thread", ["thread", "order", "stepOrder"])
      .index("by_thread_status", ["thread", "status"])
      // Only for an install with `{ search: true }` (`omitIndexes` below): FTS5 rows on every message write otherwise.
      .searchIndex("search_text", { searchField: "text", filterFields: ["thread", "userId"] }),
    /**
     * Text of messages being streamed, in batches; deleted when the step finishes, fails or is aborted. `reasoning`:
     * the model's reasoning streamed in the same batch (absent when there was none).
     */
    deltas: defineTable({ thread: v.id("threads"), message: v.id("messages"), seq: v.number(), text: v.string(), reasoning: v.optional(v.string()) })
      // One index serves both a message's deltas (thread + message) and a thread's purge (thread alone).
      .index("by_thread", ["thread", "message", "seq"]),
  },
});

export type AgentInstallConfig = {
  /**
   * Ask `ember deploy` for the Workers AI binding `EMBER_AI` (what `workersAi()` uses). Default true; set false when
   * the app only uses other providers.
   */
  workersAi?: boolean;
  /**
   * Full-text search over messages (`searchMessages`, `contextOptions.searchOtherMessages`): a `searchIndex` (FTS5)
   * kept by every message insert and text change. Default false since 0.10: an install without it writes no FTS rows,
   * and search there fails with `ValidationError`. Set true to keep it (an install that searched before: the same
   * index, so nothing is rebuilt when it is set in the deploy that upgrades); turning it on later backfills it.
   */
  search?: boolean;
};

const SEARCH_OFF = "agent: full-text search is off; install the component with { config: { search: true } }";
const searchOn = (ctx: { component: { config: AgentInstallConfig | undefined } }) => ctx.component.config?.search === true;
/** The search index, only in an install with `{ search: true }`. */
function checkSearch(ctx: { component: { config: AgentInstallConfig | undefined } }) {
  if (!searchOn(ctx)) throw new EmberError("ValidationError", SEARCH_OFF);
}

const { query, mutation, internalMutation, internalQuery } = componentBuilders<typeof schema, AgentInstallConfig | undefined>();

type DM = DataModelFromSchema<typeof schema>;
type Ctx = ComponentCtx<typeof schema, AgentInstallConfig | undefined>["mutation"];
type ReadCtx = ComponentCtx<typeof schema, AgentInstallConfig | undefined>["query"];
type MessageDoc = DM["messages"]["document"];
type ThreadDoc = DM["threads"]["document"];
type DeltaDoc = DM["deltas"]["document"];
type MId = GenericId<"messages">;
/** A patch (an `undefined` field is removed). */
type MessagePatch = PatchValue<Omit<MessageDoc, "_id" | "_creationTime">>;
type TId = GenericId<"threads">;

/** A message as the helpers return it (no internal run fields). */
export type AgentMessage = {
  _id: string;
  _creationTime: number;
  threadId: string;
  order: number;
  stepOrder: number;
  role: MessageRole;
  parts: MessagePart[];
  text: string;
  status: MessageStatus;
  userId?: string;
  agentName?: string;
  model?: string;
  provider?: string;
  usage?: Usage;
  finishReason?: string;
  error?: string;
  metadata?: unknown;
};

export type AgentThread = {
  _id: string;
  _creationTime: number;
  userId?: string;
  title?: string;
  summary?: string;
  status: "active" | "archived";
  metadata?: unknown;
  usage: Usage;
  updatedAt: number;
};

/**
 * A batch of streamed text: `text` of the deltas of a message, in `seq` order, is what has streamed so far (and
 * `reasoning`, the model's reasoning so far, when it streams one).
 */
export type StreamDelta = { _id: string; message: string; seq: number; text: string; reasoning?: string };

/** A message as the model sees it (context window). */
export type ContextMessage = { _id: string; role: MessageRole; parts: MessagePart[]; order: number; stepOrder: number };

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const DELETE_BATCH = 200;
/**
 * Delta compaction factor: the batch with seq `n` where `n + 1` is a multiple of 16^k (k ≥ 1) merges the rows of
 * seqs `[n + 1 - 16^k, n]` into the first one. Rows per streaming message stay under 15 per level (16^level ≥ batches).
 */
export const DELTA_FANOUT = 16;

/** At most 500 characters of a timeline detail (null when empty). */
const clip = (s: string): string | null => (s.length > 500 ? `${s.slice(0, 500)}…` : s || null);

/** A message with no text (a tool call, a tool result): its tool parts, one line each (args/result as JSON, bounded). */
function toolSummary(parts: readonly MessagePart[]): string {
  const json = (x: unknown) => {
    try {
      const s = JSON.stringify(x) ?? "";
      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    } catch {
      return "…";
    }
  };
  return parts
    .map((p) => (p.type === "tool-call" ? `→ ${p.toolName}(${json(p.args)})` : p.type === "tool-result" ? `← ${p.toolName}${p.isError ? " (error)" : ""}: ${json(p.result)}` : null))
    .filter((x): x is string => x !== null)
    .join("\n");
}

const textOf = (parts: readonly MessagePart[]) =>
  parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

function publicMessage(m: MessageDoc): AgentMessage {
  const out: AgentMessage = { _id: m._id, _creationTime: m._creationTime, threadId: m.thread, order: m.order, stepOrder: m.stepOrder, role: m.role, parts: m.parts, text: m.text, status: m.status };
  if (m.userId !== undefined) out.userId = m.userId;
  if (m.agentName !== undefined) out.agentName = m.agentName;
  if (m.model !== undefined) out.model = m.model;
  if (m.provider !== undefined) out.provider = m.provider;
  if (m.usage !== undefined) out.usage = m.usage;
  if (m.finishReason !== undefined) out.finishReason = m.finishReason;
  if (m.error !== undefined) out.error = m.error;
  if (m.metadata !== undefined) out.metadata = m.metadata;
  return out;
}

function publicThread(t: ThreadDoc): AgentThread {
  const out: AgentThread = { _id: t._id, _creationTime: t._creationTime, status: t.status, usage: t.usage, updatedAt: t.updatedAt };
  if (t.userId !== undefined) out.userId = t.userId;
  if (t.title !== undefined) out.title = t.title;
  if (t.summary !== undefined) out.summary = t.summary;
  if (t.metadata !== undefined) out.metadata = t.metadata;
  return out;
}

const publicDelta = (d: DeltaDoc): StreamDelta => (d.reasoning ? { _id: d._id, message: d.message, seq: d.seq, text: d.text, reasoning: d.reasoning } : { _id: d._id, message: d.message, seq: d.seq, text: d.text });

function thread(ctx: ReadCtx, id: string): ThreadDoc | null {
  const tid = ctx.db.normalizeId("threads", id);
  return tid ? ctx.db.get(tid) : null;
}
function message(ctx: ReadCtx, id: string): MessageDoc | null {
  const mid = ctx.db.normalizeId("messages", id);
  return mid ? ctx.db.get(mid) : null;
}
function mustThread(ctx: ReadCtx, id: string): ThreadDoc {
  const t = thread(ctx, id);
  if (!t) throw new EmberError("ValidationError", `agent: unknown thread ${id}`);
  return t;
}
const isHandle = (s: string | undefined) => s === undefined || s.startsWith("&");

const deltasOf = (ctx: ReadCtx, m: { _id: MId; thread: GenericId<"threads"> }) =>
  ctx.db.query("deltas").withIndex("by_thread", (q) => q.eq("thread", m.thread).eq("message", m._id)).collect();
/** Deletes the deltas of `m` and returns their text and reasoning (in seq order): one read for both. */
function takeDeltas(ctx: Ctx, m: { _id: MId; thread: GenericId<"threads"> }): { text: string; reasoning: string } {
  let text = "";
  let reasoning = "";
  for (const d of deltasOf(ctx, m)) {
    text += d.text;
    if (d.reasoning) reasoning += d.reasoning;
    ctx.db.delete(d._id);
  }
  return { text, reasoning };
}
const clearDeltas = (ctx: Ctx, m: { _id: MId; thread: GenericId<"threads"> }) => void takeDeltas(ctx, m);

/** Writes batch `seq` of `m`, merging it with the batches before it on a compaction boundary (DELTA_FANOUT). */
function writeDelta(ctx: Ctx, m: { _id: MId; thread: GenericId<"threads"> }, seq: number, text: string, reasoning?: string) {
  let span = 1;
  while (Number.isSafeInteger(seq) && seq >= 0 && (seq + 1) % (span * DELTA_FANOUT) === 0) span *= DELTA_FANOUT;
  const row = { thread: m.thread, message: m._id, seq, text, ...(reasoning ? { reasoning } : {}) };
  if (span === 1) {
    ctx.db.insert("deltas", row);
    return;
  }
  // The rows of [seq + 1 - span, seq): already merged into at most 15 per level below `span`.
  const rows = ctx.db.query("deltas").withIndex("by_thread", (q) => q.eq("thread", m.thread).eq("message", m._id).gte("seq", seq + 1 - span).lt("seq", seq)).collect();
  const [first, ...rest] = rows;
  if (!first) {
    ctx.db.insert("deltas", row);
    return;
  }
  const merged = rows.map((d) => d.reasoning ?? "").join("") + (reasoning ?? "");
  ctx.db.patch(first._id, { text: rows.map((d) => d.text).join("") + text, ...(merged ? { reasoning: merged } : {}) });
  for (const d of rest) ctx.db.delete(d._id);
}

const addUsage = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens });

/**
 * Adds a step's usage to its thread (with `thread`: more fields for the same write) and calls the app's onUsage handle
 * (in this transaction; a throw is undone and logged).
 */
function recordUsage(ctx: Ctx, m: MessageDoc, usage: Usage | undefined, model: string | undefined, provider: string | undefined, thread?: { updatedAt: number }) {
  if (!usage) {
    if (thread) ctx.db.patch(m.thread, thread);
    return;
  }
  const t = ctx.db.get(m.thread);
  if (t) ctx.db.patch(t._id, { ...thread, usage: addUsage(t.usage, usage) });
  if (!m.onUsage) return;
  try {
    ctx.runMutation(unsafeRef<"mutation">(m.onUsage), {
      threadId: m.thread,
      messageId: m._id,
      ...(m.userId !== undefined ? { userId: m.userId } : {}),
      ...(m.agentName !== undefined ? { agentName: m.agentName } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { provider } : {}),
      usage,
    });
  } catch (e) {
    console.error(`agent: onUsage for message ${m._id} failed: ${errorText(e)}`);
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The context window for the message at (order, stepOrder): the last `recent` messages before it, plus search hits. */
function contextFor(ctx: ReadCtx, m: MessageDoc, recent: number, search: { text: string; limit: number } | undefined): ContextMessage[] {
  const usable = (x: MessageDoc) => x.status === "success" || (x.status === "aborted" && x.text !== "");
  const sameTurn = ctx.db
    .query("messages")
    .withIndex("by_thread", (q) => q.eq("thread", m.thread).eq("order", m.order).lt("stepOrder", m.stepOrder))
    .collect()
    .filter(usable);
  const earlier: MessageDoc[] = [];
  if (recent > sameTurn.length) {
    for (const x of ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("thread", m.thread).lt("order", m.order)).order("desc").take(recent * 2)) {
      if (!usable(x)) continue;
      earlier.push(x);
      if (earlier.length + sameTurn.length >= recent) break;
    }
    earlier.reverse();
  }
  let window = [...earlier, ...sameTurn].slice(-Math.max(recent, sameTurn.length));
  // A window never starts in the middle of a tool exchange (providers reject a tool result without its call).
  while (window.length && (window[0]!.role === "tool" || (window[0]!.role === "assistant" && window[0]!.parts.some((p) => p.type === "tool-call") && window[0]!.order !== m.order))) window = window.slice(1);
  const out: ContextMessage[] = [];
  if (search && search.limit > 0 && search.text.trim()) {
    const inWindow = new Set(window.map((x) => x._id));
    const first = window[0];
    const before = (x: MessageDoc) => !first || x.order < first.order || (x.order === first.order && x.stepOrder < first.stepOrder);
    // `start` refused a search before writing anything; this guards any other caller.
    checkSearch(ctx);
    const hits = ctx.db
      .query("messages")
      .withSearchIndex("search_text", (q) => q.search("text", search.text).eq("thread", m.thread))
      .take(search.limit + recent + 1)
      .filter((x) => !inWindow.has(x._id) && x._id !== m._id && (x.role === "user" || x.role === "assistant") && x.text !== "" && usable(x) && before(x))
      .slice(0, search.limit)
      .sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);
    // Text only: a hit's tool calls would have no results in the window.
    for (const x of hits) out.push({ _id: x._id, role: x.role, parts: [{ type: "text", text: x.text }], order: x.order, stepOrder: x.stepOrder });
  }
  for (const x of window) out.push({ _id: x._id, role: x.role, parts: x.parts, order: x.order, stepOrder: x.stepOrder });
  return out;
}

function deleteSome(ctx: Ctx, t: TId): boolean {
  let n = 0;
  for (const d of ctx.db.query("deltas").withIndex("by_thread", (q) => q.eq("thread", t)).take(DELETE_BATCH)) {
    ctx.db.delete(d._id);
    n++;
  }
  for (const m of ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("thread", t)).take(DELETE_BATCH - n)) {
    if (m.job) ctx.scheduler.cancel(m.job);
    ctx.db.delete(m._id);
    n++;
  }
  return n >= DELETE_BATCH;
}

/** Stops a pending or streaming message: the job is cancelled, the streamed text kept. */
function stop(ctx: Ctx, m: MessageDoc, reason: string) {
  if (m.job) ctx.scheduler.cancel(m.job);
  const patch: MessagePatch = { status: "aborted", error: reason, job: undefined };
  const { text, reasoning } = takeDeltas(ctx, m);
  if ((text || reasoning) && m.status === "streaming" && m.role === "assistant") {
    patch.parts = [
      ...(reasoning ? [{ type: "reasoning" as const, text: reasoning }] : []),
      ...m.parts.filter((p) => p.type !== "text" && (!reasoning || p.type !== "reasoning")),
      ...(text ? [{ type: "text" as const, text }] : []),
    ];
    patch.text = text;
  }
  ctx.db.patch(m._id, patch);
}

/** The streaming message of run `runId`, or null when it was aborted, finished or taken by another run. */
function owned(ctx: ReadCtx, id: string, runId: string): MessageDoc | null {
  const m = message(ctx, id);
  return m && m.status === "streaming" && m.runId === runId ? m : null;
}

const generationValidator = v.object({
  /** Handle of the app's generation action (`agent.action()`). */
  action: v.string(),
  onUsage: v.optional(v.string()),
  agentName: v.optional(v.string()),
});

function schedule(ctx: Ctx, id: MId, action: string): string {
  return ctx.scheduler.runAfter(0, action, { messageId: id });
}

export const functions = {
  lib: {
    createThread: mutation({
      args: { userId: v.optional(v.string()), title: v.optional(v.string()), summary: v.optional(v.string()), metadata: v.optional(v.any()) },
      returns: v.string(),
      handler: (ctx, a) => {
        const doc: Omit<ThreadDoc, "_id" | "_creationTime"> = { status: "active", usage: ZERO, lastOrder: -1, updatedAt: ctx.now };
        if (a.userId !== undefined) doc.userId = a.userId;
        if (a.title !== undefined) doc.title = a.title;
        if (a.summary !== undefined) doc.summary = a.summary;
        if (a.metadata !== undefined) doc.metadata = a.metadata;
        return ctx.db.insert("threads", doc);
      },
    }),

    getThread: query({
      args: { threadId: v.string() },
      handler: (ctx, { threadId }): AgentThread | null => {
        const t = thread(ctx, threadId);
        return t ? publicThread(t) : null;
      },
    }),

    /** Threads of a user, most recently updated first. */
    listThreads: query({
      args: { userId: v.optional(v.string()), paginationOpts: paginationOptsValidator },
      handler: (ctx, { userId, paginationOpts }) => {
        const r = ctx.db
          .query("threads")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .order("desc")
          .paginate(paginationOpts);
        return { ...r, page: r.page.map(publicThread) };
      },
    }),

    updateThread: mutation({
      args: {
        threadId: v.string(),
        patch: v.object({ title: v.optional(v.string()), summary: v.optional(v.string()), status: v.optional(v.union(v.literal("active"), v.literal("archived"))), metadata: v.optional(v.any()) }),
      },
      handler: (ctx, { threadId, patch }): AgentThread => {
        const t = mustThread(ctx, threadId);
        ctx.db.patch(t._id, { ...patch, updatedAt: ctx.now });
        return publicThread(ctx.db.get(t._id)!);
      },
    }),

    /** Deletes a thread with its messages and deltas (in batches: big threads finish in scheduled jobs). */
    deleteThread: mutation({
      args: { threadId: v.string() },
      returns: v.boolean(),
      handler: (ctx, { threadId }) => {
        const t = thread(ctx, threadId);
        if (!t) return false;
        if (deleteSome(ctx, t._id)) ctx.scheduler.runAfter(0, "lib:deleteBatch", { threadId: t._id });
        else ctx.db.delete(t._id);
        return true;
      },
    }),

    deleteBatch: internalMutation({
      args: { threadId: v.id("threads") },
      handler: (ctx, { threadId }) => {
        if (deleteSome(ctx, threadId)) ctx.scheduler.runAfter(0, "lib:deleteBatch", { threadId });
        else if (ctx.db.get(threadId)) ctx.db.delete(threadId);
      },
    }),

    /**
     * Saves a prompt (optional) and, with `generate`, an assistant placeholder plus the job that streams it — all in
     * the caller's transaction. Without `prompt`, the response answers the thread as it is.
     */
    send: mutation({
      args: {
        threadId: v.string(),
        userId: v.optional(v.string()),
        prompt: v.optional(v.object({ role: v.optional(roleValidator), parts: v.array(partValidator), metadata: v.optional(v.any()) })),
        generate: v.optional(generationValidator),
      },
      handler: (ctx, a): { messageId?: string; responseId?: string; order: number } => {
        const t = mustThread(ctx, a.threadId);
        if (!a.prompt && !a.generate) throw new EmberError("ValidationError", "agent: send needs a prompt or generate");
        if (a.generate && (!a.generate.action.startsWith("&") || !isHandle(a.generate.onUsage))) {
          throw new EmberError("ValidationError", "agent: generate.action and onUsage must be function handles");
        }
        const userId = a.userId ?? t.userId;
        let order = t.lastOrder;
        let messageId: MId | undefined;
        if (a.prompt) {
          order = t.lastOrder + 1;
          const doc: Omit<MessageDoc, "_id" | "_creationTime"> = { thread: t._id, order, stepOrder: 0, role: a.prompt.role ?? "user", parts: a.prompt.parts, text: textOf(a.prompt.parts), status: "success" };
          if (userId !== undefined) doc.userId = userId;
          if (a.prompt.metadata !== undefined) doc.metadata = a.prompt.metadata;
          messageId = ctx.db.insert("messages", doc);
        }
        const out: { messageId?: string; responseId?: string; order: number } = { order: Math.max(order, 0) };
        if (messageId) out.messageId = messageId;
        if (a.generate) {
          if (order < 0) throw new EmberError("ValidationError", "agent: nothing to answer in an empty thread");
          // After a prompt inserted here, the turn holds only it (step 0): no read for the next step. A prompt opens
          // order `lastOrder + 1`, which nothing holds yet: only `send` creates orders, and it always moves
          // `lastOrder` to them; a response without a prompt, tool messages and next steps use an existing order.
          const last = messageId
            ? undefined
            : ctx.db
                .query("messages")
                .withIndex("by_thread", (q) => q.eq("thread", t._id).eq("order", order))
                .order("desc")
                .first();
          const action = a.generate.action;
          const doc: Omit<MessageDoc, "_id" | "_creationTime"> = { thread: t._id, order, stepOrder: (last?.stepOrder ?? 0) + 1, role: "assistant", parts: [], text: "", status: "pending", action };
          if (userId !== undefined) doc.userId = userId;
          if (a.generate.agentName !== undefined) doc.agentName = a.generate.agentName;
          if (a.generate.onUsage !== undefined) doc.onUsage = a.generate.onUsage;
          // Written once, with the job that generates it (no insert and then a patch).
          out.responseId = ctx.db.insert("messages", (rid) => ({ ...doc, job: schedule(ctx, rid, action) }));
        }
        ctx.db.patch(t._id, { lastOrder: Math.max(order, t.lastOrder), updatedAt: ctx.now });
        return out;
      },
    }),

    getMessage: query({
      args: { messageId: v.string() },
      handler: (ctx, { messageId }): AgentMessage | null => {
        const m = message(ctx, messageId);
        return m ? publicMessage(m) : null;
      },
    }),

    /**
     * Messages of a thread, newest first (`paginationOpts`). `streamArgs: { kind: "list" }` returns only the deltas of
     * messages being streamed (`streams`, an empty page); `{ kind: "page" }` returns the page plus the deltas of its
     * streaming messages, for a client that reads both from one query.
     */
    listMessages: query({
      args: { threadId: v.string(), paginationOpts: v.optional(paginationOptsValidator), streamArgs: streamArgsValidator, excludeToolMessages: v.optional(v.boolean()) },
      handler: (ctx, a): { page: AgentMessage[]; isDone: boolean; continueCursor: string; streams?: StreamDelta[] } => {
        // The id only, not the thread row: a read of it would re-run every page and stream subscription on each
        // thread write (`lastOrder`/`updatedAt` per message, usage, title). Same result: a thread's messages and
        // deltas are deleted before its row (`deleteThread`), so a thread that is gone has none. Only an empty page
        // reads the row, so a thread that is gone keeps its answer (cursor "", as an id of no thread).
        const tid = ctx.db.normalizeId("threads", a.threadId);
        if (a.streamArgs?.kind === "list") {
          const streams = tid ? ctx.db.query("deltas").withIndex("by_thread", (q) => q.eq("thread", tid)).collect().map(publicDelta) : [];
          return { page: [], isDone: true, continueCursor: "", streams };
        }
        if (!tid) return { page: [], isDone: true, continueCursor: "", ...(a.streamArgs ? { streams: [] } : {}) };
        const r = ctx.db
          .query("messages")
          .withIndex("by_thread", (q) => q.eq("thread", tid))
          .order("desc")
          .paginate(a.paginationOpts ?? { numItems: 50, cursor: null });
        if (!r.page.length && !ctx.db.get(tid)) return { page: [], isDone: true, continueCursor: "", ...(a.streamArgs ? { streams: [] } : {}) };
        const docs = a.excludeToolMessages ? r.page.filter((m) => m.role !== "tool") : r.page;
        const out: { page: AgentMessage[]; isDone: boolean; continueCursor: string; streams?: StreamDelta[] } = { page: docs.map(publicMessage), isDone: r.isDone, continueCursor: r.continueCursor };
        if (a.streamArgs?.kind === "page") out.streams = docs.filter((m) => m.status === "streaming").flatMap((m) => deltasOf(ctx, m).map(publicDelta));
        return out;
      },
    }),

    /** Full-text search over a thread's (or a user's) messages, best first. */
    searchMessages: query({
      args: { text: v.string(), threadId: v.optional(v.string()), userId: v.optional(v.string()), limit: v.optional(v.number()) },
      handler: (ctx, a): AgentMessage[] => {
        if (a.threadId === undefined && a.userId === undefined) throw new EmberError("ValidationError", "agent: searchMessages needs threadId or userId");
        checkSearch(ctx);
        const t = a.threadId === undefined ? undefined : thread(ctx, a.threadId);
        if (a.threadId !== undefined && !t) return [];
        return ctx.db
          .query("messages")
          .withSearchIndex("search_text", (q) => {
            let s = q.search("text", a.text);
            if (t) s = s.eq("thread", t._id);
            if (a.userId !== undefined) s = s.eq("userId", a.userId);
            return s;
          })
          .take(Math.min(a.limit ?? 10, 100))
          .map(publicMessage);
      },
    }),

    /** Aborts the pending/streaming messages of a thread, or one message. Returns how many. */
    abort: mutation({
      args: { threadId: v.optional(v.string()), messageId: v.optional(v.string()), reason: v.optional(v.string()) },
      returns: v.number(),
      handler: (ctx, a) => {
        const reason = a.reason ?? "aborted";
        if (a.messageId !== undefined) {
          const m = message(ctx, a.messageId);
          if (!m || (m.status !== "pending" && m.status !== "streaming")) return 0;
          stop(ctx, m, reason);
          return 1;
        }
        if (a.threadId === undefined) throw new EmberError("ValidationError", "agent: abort needs threadId or messageId");
        const t = thread(ctx, a.threadId);
        if (!t) return 0;
        let n = 0;
        for (const status of ["pending", "streaming"] as const) {
          for (const m of ctx.db.query("messages").withIndex("by_thread_status", (q) => q.eq("thread", t._id).eq("status", status)).collect()) {
            stop(ctx, m, reason);
            n++;
          }
        }
        return n;
      },
    }),

    /** Runs a failed or aborted assistant step again (same handle). False when it cannot be retried. */
    retry: mutation({
      args: { messageId: v.string() },
      returns: v.boolean(),
      handler: (ctx, { messageId }) => {
        const m = message(ctx, messageId);
        if (!m || m.role !== "assistant" || !m.action || (m.status !== "failed" && m.status !== "aborted")) return false;
        clearDeltas(ctx, m);
        ctx.db.patch(m._id, { status: "pending", parts: [], text: "", error: undefined, usage: undefined, finishReason: undefined, runId: undefined, job: schedule(ctx, m._id, m.action) });
        return true;
      },
    }),

    // ------------------------------------------------------------------- the generation run (called by agent.action())

    /** pending → streaming, owned by a fresh runId; returns the context window. Null: aborted, or a duplicate job. */
    start: mutation({
      args: { messageId: v.string(), recentMessages: v.number(), search: v.optional(v.object({ limit: v.number() })) },
      handler: (ctx, a): { runId: string; threadId: string; userId?: string; agentName?: string; context: ContextMessage[] } | null => {
        const m = message(ctx, a.messageId);
        if (!m || m.status !== "pending") return null;
        // `contextOptions.searchOtherMessages` on an install without search: checked before the message is touched,
        // and the step fails with the reason (a throw would leave it pending while its job is retried and gives up).
        if (a.search && !searchOn(ctx)) {
          ctx.db.patch(m._id, { status: "failed", error: SEARCH_OFF, job: undefined });
          return null;
        }
        const runId = `${ctx.now.toString(36)}-${Math.floor(ctx.random() * 2 ** 48).toString(36)}`;
        ctx.db.patch(m._id, { status: "streaming", runId, job: undefined });
        // The prompt of this turn is what the context search looks for.
        const prompt = a.search ? ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("thread", m.thread).eq("order", m.order).eq("stepOrder", 0)).unique() : null;
        const context = contextFor(ctx, m, a.recentMessages, a.search && prompt ? { text: prompt.text, limit: a.search.limit } : undefined);
        return { runId, threadId: m.thread, ...(m.userId !== undefined ? { userId: m.userId } : {}), ...(m.agentName !== undefined ? { agentName: m.agentName } : {}), context };
      },
    }),

    /** A batch of streamed text. False once the message was aborted (or another run owns it): the action stops. */
    appendDelta: mutation({
      args: { messageId: v.string(), runId: v.string(), seq: v.number(), text: v.string(), reasoning: v.optional(v.string()) },
      returns: v.boolean(),
      handler: (ctx, a) => {
        const m = owned(ctx, a.messageId, a.runId);
        if (!m) return false;
        writeDelta(ctx, m, a.seq, a.text, a.reasoning);
        return true;
      },
    }),

    /**
     * A finished model step: final parts and usage (onUsage in this transaction), deltas deleted. With tool calls,
     * a `tool` message is opened (streaming while the tools run) and returned.
     */
    finishStep: mutation({
      args: {
        messageId: v.string(),
        runId: v.string(),
        parts: v.array(partValidator),
        usage: v.optional(usageValidator),
        finishReason: v.optional(v.string()),
        model: v.optional(v.string()),
        provider: v.optional(v.string()),
      },
      handler: (ctx, a): { ok: boolean; toolMessageId?: string } => {
        const m = owned(ctx, a.messageId, a.runId);
        if (!m) return { ok: false };
        clearDeltas(ctx, m);
        const patch: MessagePatch = { parts: a.parts, text: textOf(a.parts), status: "success", runId: undefined };
        if (a.usage) patch.usage = a.usage;
        if (a.finishReason !== undefined) patch.finishReason = a.finishReason;
        if (a.model !== undefined) patch.model = a.model;
        if (a.provider !== undefined) patch.provider = a.provider;
        ctx.db.patch(m._id, patch);
        recordUsage(ctx, m, a.usage, a.model, a.provider, { updatedAt: ctx.now });
        if (!a.parts.some((p) => p.type === "tool-call")) return { ok: true };
        const tool: Omit<MessageDoc, "_id" | "_creationTime"> = { thread: m.thread, order: m.order, stepOrder: m.stepOrder + 1, role: "tool", parts: [], text: "", status: "streaming", runId: a.runId };
        if (m.userId !== undefined) tool.userId = m.userId;
        if (m.agentName !== undefined) tool.agentName = m.agentName;
        // Carried for the next assistant step (`toolResults`), so it does not read this step back.
        if (m.action !== undefined) tool.action = m.action;
        if (m.onUsage !== undefined) tool.onUsage = m.onUsage;
        return { ok: true, toolMessageId: ctx.db.insert("messages", tool) };
      },
    }),

    /** Tool results of a step; with `next`, opens the next assistant step (streaming, same run). */
    toolResults: mutation({
      args: { messageId: v.string(), runId: v.string(), parts: v.array(partValidator), next: v.boolean(), model: v.optional(v.string()) },
      handler: (ctx, a): { ok: boolean; nextMessageId?: string } => {
        const m = owned(ctx, a.messageId, a.runId);
        if (!m) return { ok: false };
        ctx.db.patch(m._id, { parts: a.parts, status: "success", runId: undefined, ...(a.next ? {} : { finishReason: "tool-calls" }) });
        if (!a.next) return { ok: true };
        // The step's own action/onUsage (`finishStep` copies them on the tool message); a tool message from before
        // 0.10 has neither: read from the step before it. That step always exists: `finishStep` inserts a tool message
        // only right after the assistant step it answers (stepOrder + 1, so never step 0), and a turn's messages are
        // deleted only with the whole thread.
        const prev =
          m.action !== undefined
            ? m
            : ctx.db
                .query("messages")
                .withIndex("by_thread", (q) => q.eq("thread", m.thread).eq("order", m.order).lt("stepOrder", m.stepOrder))
                .order("desc")
                .first();
        const doc: Omit<MessageDoc, "_id" | "_creationTime"> = { thread: m.thread, order: m.order, stepOrder: m.stepOrder + 1, role: "assistant", parts: [], text: "", status: "streaming", runId: a.runId };
        if (m.userId !== undefined) doc.userId = m.userId;
        if (m.agentName !== undefined) doc.agentName = m.agentName;
        if (prev?.action !== undefined) doc.action = prev.action;
        if (prev?.onUsage !== undefined) doc.onUsage = prev.onUsage;
        return { ok: true, nextMessageId: ctx.db.insert("messages", doc) };
      },
    }),

    /** The step failed (model error): the streamed text is kept, status "failed" (`retry` runs it again). */
    fail: mutation({
      args: { messageId: v.string(), runId: v.string(), error: v.string(), usage: v.optional(usageValidator), model: v.optional(v.string()), provider: v.optional(v.string()) },
      returns: v.boolean(),
      handler: (ctx, a) => {
        const m = owned(ctx, a.messageId, a.runId);
        if (!m) return false;
        const { text, reasoning } = takeDeltas(ctx, m);
        const parts: MessagePart[] = [...(reasoning ? [{ type: "reasoning" as const, text: reasoning }] : []), ...(text ? [{ type: "text" as const, text }] : [])];
        const patch: MessagePatch = { status: "failed", error: a.error, runId: undefined, parts, text };
        if (a.usage) patch.usage = a.usage;
        if (a.model !== undefined) patch.model = a.model;
        if (a.provider !== undefined) patch.provider = a.provider;
        ctx.db.patch(m._id, patch);
        recordUsage(ctx, m, a.usage, a.model, a.provider);
        return true;
      },
    }),
  },
};

// ------------------------------------------------------------------------------------------------ dashboard

/** What the dashboard's screen reads (module `dashboard`, internal: never part of the component's API). */
const dashboardFunctions = {
  /**
   * Threads in this shard by activity, most recent first: one user's (`by_user`; a status filters that user's), one
   * status's (`by_status`) or all (`by_updated`). Each page is a range of an index, never a scan of the table.
   */
  threads: internalQuery({
    args: { userId: v.optional(v.string()), status: v.optional(v.union(v.literal("active"), v.literal("archived"))), paginationOpts: paginationOptsValidator },
    handler: (ctx, a) => {
      const q =
        a.userId !== undefined
          ? ctx.db.query("threads").withIndex("by_user", (r) => r.eq("userId", a.userId)).order("desc")
          : a.status !== undefined
            ? ctx.db.query("threads").withIndex("by_status", (r) => r.eq("status", a.status!)).order("desc")
            : ctx.db.query("threads").withIndex("by_updated").order("desc");
      const page = (a.userId !== undefined && a.status !== undefined ? q.filter((f) => f.eq(f.field("status"), a.status!)) : q).paginate(a.paginationOpts);
      return {
        ...page,
        // `lastOrder` is the order of the last prompt, -1 before the first one.
        page: page.page.map((t) => ({ _id: t._id, userId: t.userId ?? null, title: t.title ?? null, status: t.status, prompts: t.lastOrder + 1, tokens: t.usage.totalTokens ?? null, updatedAt: t.updatedAt })),
      };
    },
  }),
  /** One thread with its last 100 messages, oldest first (a timeline); null when unknown. */
  thread: internalQuery({
    args: { threadId: v.string() },
    handler: (ctx, { threadId }) => {
      const t = thread(ctx, threadId);
      if (!t) return null;
      const messages = ctx.db
        .query("messages")
        .withIndex("by_thread", (q) => q.eq("thread", t._id))
        .order("desc")
        .take(100)
        .reverse()
        .map((m) => ({ at: m._creationTime, title: `${m.role}${m.agentName ? ` (${m.agentName})` : ""}${m.model ? ` · ${m.model}` : ""}`, status: m.status, detail: m.error ?? clip(m.text || toolSummary(m.parts)) }));
      return { ...publicThread(t), messages };
    },
  }),
};

export const agent = defineComponent({
  name: "agent",
  schema,
  functions: { ...functions, dashboard: dashboardFunctions },
  // The threads' screen in the Ember Dashboard (contracts.md "Telas declarativas"): threads live per shard.
  dashboard: {
    label: "Agent",
    icon: "bot",
    description: "Threads and their messages (a timeline of prompts, steps and tool calls); archive or delete a thread.",
    tabs: [
      {
        id: "threads",
        label: "Threads",
        blocks: [
          {
            kind: "table",
            id: "threads",
            query: dashboardFunctions.threads,
            columns: [
              { label: "Title", path: "title" },
              { label: "User", path: "userId", format: "code" },
              { label: "Status", path: "status", format: "badge" },
              { label: "Prompts", path: "prompts", format: "number" },
              { label: "Tokens", path: "tokens", format: "number" },
              { label: "Updated", path: "updatedAt", format: "ago" },
            ],
            detail: {
              query: dashboardFunctions.thread,
              fromRow: { threadId: "_id" },
              sections: [
                { kind: "kv", items: [{ label: "Title", path: "title" }, { label: "Summary", path: "summary" }, { label: "Status", path: "status", format: "badge" }, { label: "Usage", path: "usage", format: "json" }] },
                { kind: "timeline", label: "Messages", path: "messages", time: "at", title: "title", status: "status", detail: "detail" },
              ],
            },
            rowActions: [
              { id: "archive", label: "Archive", fn: functions.lib.updateThread, args: { patch: { status: "archived" } }, fromRow: { threadId: "_id" } },
              { id: "delete", label: "Delete", fn: functions.lib.deleteThread, fromRow: { threadId: "_id" }, destructive: true, description: "Deletes the thread with its messages." },
            ],
          },
        ],
      },
    ],
  },
  config: v.optional(v.object({ workersAi: v.optional(v.boolean()), search: v.optional(v.boolean()) })),
  bindings: (config) => (config?.workersAi === false ? [] : [{ type: "ai", name: "EMBER_AI" }]),
  // The FTS5 index only where search is on (AgentInstallConfig.search).
  omitIndexes: (config) => (config?.search === true ? [] : ["messages.search_text"]),
});
