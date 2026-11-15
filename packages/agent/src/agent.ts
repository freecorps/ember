// The app-side helper: `new Agent(components.agent, { model, instructions, tools, action })`. Mutations save prompts
// and schedule responses (sync, same transaction); `agent.action()` is the app's internalAction that runs the
// model (D6: I/O only in actions), streams deltas, executes tools and records usage.

import { createFunctionHandle, internalActionGeneric, v, type ActionCtx, type ArgsType, type ArgsValidator, type FileId, type FunctionReference, type PaginationOpts, type RegisteredAction } from "@freecorps/ember-server";
import { isValidator, toJsonSchema, withDefaults, type GenericValidator, type Visibility } from "@freecorps/ember-values";
import { aiSdk, isLanguageModel, type LanguageModelLike } from "./ai-sdk.ts";
import type { AgentMessage, AgentThread, ContextMessage, MessagePart, StreamDelta, Usage } from "./component.ts";
import type { AgentModel, ModelMessage, ModelPart, ModelToolSpec } from "./model.ts";

// ------------------------------------------------------------------------------------------------ component api

type Ref<T extends "query" | "mutation", A, R> = FunctionReference<T, "public", A, R>;
type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type PromptArg = { role?: "user" | "assistant" | "tool" | "system"; parts: MessagePart[]; metadata?: unknown };
type GenerateArg = { action: string; onUsage?: string; agentName?: string };
type Started = { runId: string; threadId: string; userId?: string; agentName?: string; context: ContextMessage[] };

/** What `components.<name>` of the agent component looks like (structural: any install name works). */
export interface AgentComponentApi {
  lib: {
    createThread: Ref<"mutation", { userId?: string; title?: string; summary?: string; metadata?: unknown }, string>;
    getThread: Ref<"query", { threadId: string }, AgentThread | null>;
    listThreads: Ref<"query", { userId?: string; paginationOpts: PaginationOpts }, Page<AgentThread>>;
    updateThread: Ref<"mutation", { threadId: string; patch: { title?: string; summary?: string; status?: "active" | "archived"; metadata?: unknown } }, AgentThread>;
    deleteThread: Ref<"mutation", { threadId: string }, boolean>;
    send: Ref<"mutation", { threadId: string; userId?: string; prompt?: PromptArg; generate?: GenerateArg }, { messageId?: string; responseId?: string; order: number }>;
    getMessage: Ref<"query", { messageId: string }, AgentMessage | null>;
    listMessages: Ref<"query", ListMessagesArgs, ListMessagesResult>;
    searchMessages: Ref<"query", { text: string; threadId?: string; userId?: string; limit?: number }, AgentMessage[]>;
    abort: Ref<"mutation", { threadId?: string; messageId?: string; reason?: string }, number>;
    retry: Ref<"mutation", { messageId: string }, boolean>;
    start: Ref<"mutation", { messageId: string; recentMessages: number; search?: { limit: number } }, Started | null>;
    appendDelta: Ref<"mutation", { messageId: string; runId: string; seq: number; text: string }, boolean>;
    finishStep: Ref<"mutation", { messageId: string; runId: string; parts: MessagePart[]; usage?: Usage; finishReason?: string; model?: string; provider?: string }, { ok: boolean; toolMessageId?: string }>;
    toolResults: Ref<"mutation", { messageId: string; runId: string; parts: MessagePart[]; next: boolean; model?: string }, { ok: boolean; nextMessageId?: string }>;
    fail: Ref<"mutation", { messageId: string; runId: string; error: string; usage?: Usage; model?: string; provider?: string }, boolean>;
  };
}

export type StreamArgs = { kind: "list" | "page" };
export type ListMessagesArgs = { threadId: string; paginationOpts?: PaginationOpts; streamArgs?: StreamArgs; excludeToolMessages?: boolean };
export type ListMessagesResult = Page<AgentMessage> & { streams?: StreamDelta[] };

/** What the app's `onUsage` mutation receives, once per model step (in the transaction that records it). */
export type UsageEvent = { threadId: string; messageId: string; userId?: string; agentName?: string; model?: string; provider?: string; usage: Usage };

// ------------------------------------------------------------------------------------------------ ctx shapes

/** Query/mutation ctx: the component's functions run synchronously, in the caller's transaction. */
type SyncCtx = { db: unknown; runQuery(fn: unknown, args?: unknown): unknown; runMutation?(fn: unknown, args?: unknown): unknown };
/** Action ctx: each call is its own transaction. */
type AsyncCtx = { runAction(fn: unknown, args?: unknown): Promise<unknown>; runQuery(fn: unknown, args?: unknown): Promise<unknown>; runMutation(fn: unknown, args?: unknown): Promise<unknown> };
type AnyCtx = SyncCtx | AsyncCtx;

function mutate<R>(ctx: AnyCtx, what: string, fn: unknown, args: unknown): R | Promise<R> {
  if (!ctx.runMutation) throw new Error(`agent.${what} needs a mutation or action ctx`);
  return ctx.runMutation(fn, args) as R | Promise<R>;
}

// ------------------------------------------------------------------------------------------------ tools

/** What a tool handler gets: the generation action's ctx plus where the call came from. */
export type ToolCtx = ActionCtx & { threadId: string; messageId: string; toolCallId: string; userId?: string; agentName: string };

export interface AgentTool<Args = unknown, Ret = unknown> {
  description?: string;
  args: ArgsValidator;
  handler: (ctx: ToolCtx, args: Args) => Ret | Promise<Ret>;
}

/**
 * A tool the model can call: `args` are Ember validators (sent to the model as JSON Schema, checked before the
 * handler runs; `.describe()` texts become descriptions). The handler runs in the generation action: it may
 * `ctx.runQuery` / `runMutation` / `runAction`. A throw becomes an error result the model sees.
 */
export function tool<A extends ArgsValidator, R>(def: { description?: string; args: A; handler: (ctx: ToolCtx, args: ArgsType<A>) => R | Promise<R> }): AgentTool<ArgsType<A>, R> {
  return def;
}

// ------------------------------------------------------------------------------------------------ options

type ActionRef = FunctionReference<"action", Visibility, { messageId: string }, unknown> | string;
type UsageRef = FunctionReference<"mutation", Visibility, UsageEvent, unknown> | string;

export interface AgentOptions {
  /** Saved on messages (`agentName`) and given to tools. */
  name: string;
  /** An AgentModel (`workersAi(...)`, `mockModel(...)`, `defineModel(...)`) or an AI SDK LanguageModel. */
  model: AgentModel | LanguageModelLike;
  /** System prompt. */
  instructions?: string;
  tools?: Record<string, AgentTool<never, unknown>>;
  /** Model calls per response (each tool round is one more). Default 1 without tools, 5 with. */
  maxSteps?: number;
  /** The app's export of `agent.action()` (e.g. `internal.assistant.generate`): what `sendMessage` schedules. */
  action: ActionRef;
  /** A mutation called with a `UsageEvent` for every step, in the transaction that records it (billing, limits). */
  onUsage?: UsageRef;
  contextOptions?: {
    /** Messages of the thread before the prompt sent to the model. Default 20. */
    recentMessages?: number;
    /** Also send up to `limit` older messages matching the prompt (full-text search over the thread). */
    searchOtherMessages?: { limit: number };
  };
  /** Delta batching: a write every `throttleMs` (default 100) or `maxChars` (default 400) characters. `false`: no deltas, one write per step. */
  streaming?: false | { throttleMs?: number; maxChars?: number };
  callSettings?: { temperature?: number; maxOutputTokens?: number };
}

export type SendMessageArgs = {
  threadId: string;
  /** The prompt as text (or `parts`, e.g. with files). Neither: answer the thread as it is (after `saveMessage`). */
  text?: string;
  parts?: MessagePart[];
  /** Overrides the thread's owner on the saved messages. */
  userId?: string;
  metadata?: unknown;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

type PreparedTool = { name: string; spec: ModelToolSpec; validator: GenericValidator; def: AgentTool<unknown, unknown> };

export class Agent {
  readonly model: AgentModel;
  private readonly tools: Map<string, PreparedTool>;

  constructor(
    readonly component: AgentComponentApi,
    readonly options: AgentOptions,
  ) {
    this.model = isLanguageModel(options.model) ? aiSdk(options.model) : options.model;
    this.tools = new Map(
      Object.entries(options.tools ?? {}).map(([name, t]) => {
        const validator: GenericValidator = isValidator(t.args) ? t.args : (v.object(t.args as Record<string, GenericValidator>) as GenericValidator);
        const spec: ModelToolSpec = { name, parameters: toJsonSchema(validator.shape) as Record<string, unknown> };
        if (t.description !== undefined) spec.description = t.description;
        return [name, { name, spec, validator, def: t as AgentTool<unknown, unknown> }];
      }),
    );
  }

  private get maxSteps() {
    return this.options.maxSteps ?? (this.tools.size ? 5 : 1);
  }

  // -------------------------------------------------------------------------------------------- threads

  createThread(ctx: SyncCtx, args?: { userId?: string; title?: string; summary?: string; metadata?: unknown }): string;
  createThread(ctx: AsyncCtx, args?: { userId?: string; title?: string; summary?: string; metadata?: unknown }): Promise<string>;
  createThread(ctx: AnyCtx, args: { userId?: string; title?: string; summary?: string; metadata?: unknown } = {}) {
    return mutate<string>(ctx, "createThread", this.component.lib.createThread, args);
  }

  getThread(ctx: SyncCtx, threadId: string): AgentThread | null;
  getThread(ctx: AsyncCtx, threadId: string): Promise<AgentThread | null>;
  getThread(ctx: AnyCtx, threadId: string) {
    return ctx.runQuery(this.component.lib.getThread, { threadId });
  }

  /** A user's threads, most recently updated first. */
  listThreads(ctx: SyncCtx, args: { userId?: string; paginationOpts: PaginationOpts }): Page<AgentThread>;
  listThreads(ctx: AsyncCtx, args: { userId?: string; paginationOpts: PaginationOpts }): Promise<Page<AgentThread>>;
  listThreads(ctx: AnyCtx, args: { userId?: string; paginationOpts: PaginationOpts }) {
    return ctx.runQuery(this.component.lib.listThreads, args);
  }

  updateThread(ctx: SyncCtx, threadId: string, patch: { title?: string; summary?: string; status?: "active" | "archived"; metadata?: unknown }): AgentThread;
  updateThread(ctx: AsyncCtx, threadId: string, patch: { title?: string; summary?: string; status?: "active" | "archived"; metadata?: unknown }): Promise<AgentThread>;
  updateThread(ctx: AnyCtx, threadId: string, patch: { title?: string; summary?: string; status?: "active" | "archived"; metadata?: unknown }) {
    return mutate<AgentThread>(ctx, "updateThread", this.component.lib.updateThread, { threadId, patch });
  }

  /** Deletes the thread, its messages and deltas (large threads finish in background batches). */
  deleteThread(ctx: SyncCtx, threadId: string): boolean;
  deleteThread(ctx: AsyncCtx, threadId: string): Promise<boolean>;
  deleteThread(ctx: AnyCtx, threadId: string) {
    return mutate<boolean>(ctx, "deleteThread", this.component.lib.deleteThread, { threadId });
  }

  // -------------------------------------------------------------------------------------------- messages

  private generateArg(): GenerateArg {
    const g: GenerateArg = { action: createFunctionHandle(this.options.action), agentName: this.options.name };
    if (this.options.onUsage !== undefined) g.onUsage = createFunctionHandle(this.options.onUsage);
    return g;
  }

  private sendArgs(a: SendMessageArgs, generate: boolean) {
    const out: { threadId: string; userId?: string; prompt?: PromptArg; generate?: GenerateArg } = { threadId: a.threadId };
    if (a.userId !== undefined) out.userId = a.userId;
    const parts = a.parts ?? (a.text !== undefined ? [{ type: "text" as const, text: a.text }] : undefined);
    if (parts) out.prompt = { parts, ...(a.metadata !== undefined ? { metadata: a.metadata } : {}) };
    if (generate) out.generate = this.generateArg();
    return out;
  }

  /**
   * Saves the user's message and schedules the response: an assistant message (`pending`, then `streaming`) and
   * the generation job, atomically with the caller's mutation (a mutation that fails afterwards leaves neither).
   */
  sendMessage(ctx: SyncCtx, args: SendMessageArgs): { messageId?: string; responseId: string; order: number };
  sendMessage(ctx: AsyncCtx, args: SendMessageArgs): Promise<{ messageId?: string; responseId: string; order: number }>;
  sendMessage(ctx: AnyCtx, args: SendMessageArgs) {
    return mutate(ctx, "sendMessage", this.component.lib.send, this.sendArgs(args, true));
  }

  /** Saves a message without generating a response (`role` default "user"). */
  saveMessage(ctx: SyncCtx, args: SendMessageArgs & { role?: "user" | "assistant" | "system" }): { messageId: string; order: number };
  saveMessage(ctx: AsyncCtx, args: SendMessageArgs & { role?: "user" | "assistant" | "system" }): Promise<{ messageId: string; order: number }>;
  saveMessage(ctx: AnyCtx, args: SendMessageArgs & { role?: "user" | "assistant" | "system" }) {
    const a = this.sendArgs(args, false);
    if (!a.prompt) throw new Error("agent.saveMessage needs text or parts");
    if (args.role) a.prompt.role = args.role;
    return mutate(ctx, "saveMessage", this.component.lib.send, a);
  }

  /**
   * Messages of a thread, newest first. `streamArgs: { kind: "list" }` returns only the live deltas (what
   * `useThreadMessages` subscribes to next to the pages); `{ kind: "page" }` adds the deltas of the page's
   * streaming messages (one query for both).
   */
  listMessages(ctx: SyncCtx, args: ListMessagesArgs): ListMessagesResult;
  listMessages(ctx: AsyncCtx, args: ListMessagesArgs): Promise<ListMessagesResult>;
  listMessages(ctx: AnyCtx, args: ListMessagesArgs) {
    const a: ListMessagesArgs = { threadId: args.threadId };
    if (args.paginationOpts) a.paginationOpts = args.paginationOpts;
    if (args.streamArgs) a.streamArgs = args.streamArgs;
    if (args.excludeToolMessages) a.excludeToolMessages = true;
    return ctx.runQuery(this.component.lib.listMessages, a);
  }

  getMessage(ctx: SyncCtx, messageId: string): AgentMessage | null;
  getMessage(ctx: AsyncCtx, messageId: string): Promise<AgentMessage | null>;
  getMessage(ctx: AnyCtx, messageId: string) {
    return ctx.runQuery(this.component.lib.getMessage, { messageId });
  }

  /** Full-text search over a thread's (or a user's) messages. */
  searchMessages(ctx: SyncCtx, args: { text: string; threadId?: string; userId?: string; limit?: number }): AgentMessage[];
  searchMessages(ctx: AsyncCtx, args: { text: string; threadId?: string; userId?: string; limit?: number }): Promise<AgentMessage[]>;
  searchMessages(ctx: AnyCtx, args: { text: string; threadId?: string; userId?: string; limit?: number }) {
    return ctx.runQuery(this.component.lib.searchMessages, args);
  }

  /** Stops a response: a pending one never runs; a streaming one keeps its text so far. Returns how many. */
  abort(ctx: SyncCtx, target: { threadId: string } | { messageId: string }, reason?: string): number;
  abort(ctx: AsyncCtx, target: { threadId: string } | { messageId: string }, reason?: string): Promise<number>;
  abort(ctx: AnyCtx, target: { threadId: string } | { messageId: string }, reason?: string) {
    return mutate<number>(ctx, "abort", this.component.lib.abort, { ...target, ...(reason !== undefined ? { reason } : {}) });
  }

  /** Runs a failed or aborted step again. */
  retry(ctx: SyncCtx, messageId: string): boolean;
  retry(ctx: AsyncCtx, messageId: string): Promise<boolean>;
  retry(ctx: AnyCtx, messageId: string) {
    return mutate<boolean>(ctx, "retry", this.component.lib.retry, { messageId });
  }

  // -------------------------------------------------------------------------------------------- generation

  /** The generation action: export it (`export const generate = assistant.action()`) and pass it as `action`. */
  action(): RegisteredAction<"internal", { messageId: string }, null> {
    return internalActionGeneric({
      args: { messageId: v.string() },
      handler: async (ctx: ActionCtx, { messageId }: { messageId: string }) => {
        await this.run(ctx, messageId);
        return null;
      },
    }) as RegisteredAction<"internal", { messageId: string }, null>;
  }

  /** Generates the response for a pending assistant message (what `action()` runs). */
  async run(ctx: ActionCtx, messageId: string): Promise<void> {
    const lib = this.component.lib;
    const ctxOpts = this.options.contextOptions ?? {};
    const started = await ctx.runMutation(lib.start, {
      messageId,
      recentMessages: ctxOpts.recentMessages ?? 20,
      ...(ctxOpts.searchOtherMessages ? { search: { limit: ctxOpts.searchOtherMessages.limit } } : {}),
    });
    if (!started) return; // aborted before it ran, or a duplicate delivery
    const { runId } = started;
    const model = this.model;
    const meta = { model: model.modelId, provider: model.provider };
    const history: ModelMessage[] = [];
    for (const m of started.context) history.push({ role: m.role, content: await this.modelParts(ctx, m.parts) });
    const streaming = this.options.streaming === false ? null : { throttleMs: this.options.streaming?.throttleMs ?? 100, maxChars: this.options.streaming?.maxChars ?? 400 };
    const specs = [...this.tools.values()].map((t) => t.spec);
    let current = messageId;

    for (let step = 0; step < this.maxSteps; step++) {
      const abort = new AbortController();
      let text = "";
      let reasoning = "";
      let pending = "";
      let seq = 0;
      let last = Date.now();
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      const calls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
      /** Writes the buffered text as one delta row; false once the message was aborted. */
      const flush = async () => {
        last = Date.now();
        if (!pending) return true;
        const chunk = pending;
        pending = "";
        return ctx.runMutation(lib.appendDelta, { messageId: current, runId, seq: seq++, text: chunk });
      };
      try {
        const events = await model.stream({ ...(this.options.instructions ? { system: this.options.instructions } : {}), messages: history, tools: specs, signal: abort.signal, env: ctx.env, ...this.options.callSettings });
        for await (const ev of events) {
          if (ev.type === "text-delta") {
            text += ev.text;
            if (!streaming) continue;
            pending += ev.text;
            if (pending.length >= streaming.maxChars || Date.now() - last >= streaming.throttleMs) {
              if (!(await flush())) {
                abort.abort();
                return;
              }
            }
          } else if (ev.type === "reasoning-delta") reasoning += ev.text;
          else if (ev.type === "tool-call") calls.push({ toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args });
          else if (ev.type === "finish") {
            usage = ev.usage;
            finishReason = ev.finishReason;
          } else if (ev.type === "error") throw ev.error instanceof Error ? ev.error : new Error(errorText(ev.error));
        }
        if (streaming && !(await flush())) return;
      } catch (e) {
        if (abort.signal.aborted) return;
        // What streamed so far stays on the failed message (`fail` keeps the deltas' text).
        await flush().catch(() => false);
        await ctx.runMutation(lib.fail, { messageId: current, runId, error: errorText(e), ...(usage ? { usage } : {}), ...meta });
        return;
      }

      const parts: MessagePart[] = [];
      if (reasoning) parts.push({ type: "reasoning", text: reasoning });
      if (text) parts.push({ type: "text", text });
      for (const c of calls) parts.push({ type: "tool-call", toolCallId: c.toolCallId, toolName: c.toolName, args: c.args ?? {} });
      const done = await ctx.runMutation(lib.finishStep, { messageId: current, runId, parts, ...(usage ? { usage } : {}), ...(finishReason !== undefined ? { finishReason } : {}), ...meta });
      if (!done.ok || !done.toolMessageId) return;
      history.push({ role: "assistant", content: parts.map((p) => p as ModelPart) });

      const results: MessagePart[] = [];
      for (const c of calls) results.push(await this.callTool(ctx, started, done.toolMessageId, c));
      const next = step + 1 < this.maxSteps;
      const r = await ctx.runMutation(lib.toolResults, { messageId: done.toolMessageId, runId, parts: results, next, model: model.modelId });
      if (!r.ok || !r.nextMessageId) return;
      history.push({ role: "tool", content: results.map((p) => p as ModelPart) });
      current = r.nextMessageId;
    }
  }

  private async callTool(ctx: ActionCtx, run: Started, messageId: string, c: { toolCallId: string; toolName: string; args: unknown }): Promise<MessagePart> {
    const base = { type: "tool-result" as const, toolCallId: c.toolCallId, toolName: c.toolName };
    const t = this.tools.get(c.toolName);
    if (!t) return { ...base, result: `Unknown tool ${c.toolName}`, isError: true };
    const args = withDefaults(t.validator.shape, c.args ?? {});
    const check = t.validator.validate(args);
    if (!check.ok) return { ...base, result: `Invalid arguments${check.path ? ` at ${check.path}` : ""}: ${check.message}`, isError: true };
    const toolCtx: ToolCtx = Object.assign(Object.create(ctx) as ActionCtx, {
      threadId: run.threadId,
      messageId,
      toolCallId: c.toolCallId,
      agentName: this.options.name,
      ...(run.userId !== undefined ? { userId: run.userId } : {}),
    });
    try {
      const result = await t.def.handler(toolCtx, args);
      return { ...base, result: result === undefined ? null : result };
    } catch (e) {
      return { ...base, result: errorText(e), isError: true };
    }
  }

  /** Stored parts → model parts (files become short-lived URLs). */
  private async modelParts(ctx: ActionCtx, parts: MessagePart[]): Promise<ModelPart[]> {
    const out: ModelPart[] = [];
    for (const p of parts) {
      if (p.type !== "file") {
        out.push(p);
        continue;
      }
      const url = await ctx.storage.getUrl(p.file as FileId);
      if (url) out.push({ type: "file", url, mimeType: p.mimeType, ...(p.filename !== undefined ? { filename: p.filename } : {}) });
    }
    return out;
  }
}
