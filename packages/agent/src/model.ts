// The model interface the agent drives: one call = one step (text deltas, tool calls, usage). Small on purpose:
// adapters turn Workers AI (`workersAi`) and any Vercel AI SDK LanguageModel (`aiSdk`, structural) into it, and a test
// can script one (`mockModel`).

import type { Usage } from "./component.ts";

export type { Usage };

/** JSON Schema (2020-12) of a tool's arguments. */
export type JsonSchemaObject = Record<string, unknown>;

export type ModelPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  /** A file: `url` is a short-lived download URL of the stored file (`ctx.storage.getUrl`). */
  | { type: "file"; url: string; mimeType: string; filename?: string };

export type ModelMessage = { role: "user" | "assistant" | "tool" | "system"; content: ModelPart[] };

export type ModelToolSpec = { name: string; description?: string; parameters: JsonSchemaObject };

export interface ModelRequest {
  /** The agent's instructions. */
  system?: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  /** Aborted when the message is aborted (or the step must stop). */
  signal: AbortSignal;
  /** The action's `ctx.env` (bindings such as `EMBER_AI`, secrets). */
  env: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Ask for JSON matching `schema` (`generateObject`): AI SDK `responseFormat` (v2/v3; `mode: object-json` in v1),
   * Workers AI `response_format: { type: "json_schema" }`. A model that ignores it is still validated.
   */
  responseFormat?: { type: "json"; schema: JsonSchemaObject; name?: string; description?: string };
}

export type ModelEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "finish"; finishReason?: string; usage?: Usage }
  | { type: "error"; error: unknown };

export interface AgentModel {
  readonly provider: string;
  readonly modelId: string;
  /** One step: text deltas as they come, tool calls when complete, then `finish` with the usage. */
  stream(request: ModelRequest): AsyncIterable<ModelEvent> | Promise<AsyncIterable<ModelEvent>>;
}

/** What a non-streaming model returns for one step. */
export type GenerateResult = {
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ toolCallId?: string; toolName: string; args: unknown }>;
  finishReason?: string;
  usage?: Partial<Usage>;
};

export function usageOf(u: Partial<Usage> | undefined): Usage | undefined {
  if (!u) return undefined;
  const inputTokens = num(u.inputTokens);
  const outputTokens = num(u.outputTokens);
  return { inputTokens, outputTokens, totalTokens: u.totalTokens !== undefined ? num(u.totalTokens) : inputTokens + outputTokens };
}
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

let callSeq = 0;
export const newToolCallId = () => `call_${Date.now().toString(36)}_${(callSeq++).toString(36)}`;

/** A model from a `stream` function, or from a `generate` function (its text arrives as one delta). */
export function defineModel(def: {
  provider: string;
  modelId: string;
  stream?: AgentModel["stream"];
  generate?: (request: ModelRequest) => Promise<GenerateResult>;
}): AgentModel {
  const { stream, generate } = def;
  if (stream) return { provider: def.provider, modelId: def.modelId, stream };
  if (!generate) throw new Error("defineModel needs stream or generate");
  return {
    provider: def.provider,
    modelId: def.modelId,
    async *stream(request) {
      const r = await generate(request);
      if (r.reasoning) yield { type: "reasoning-delta", text: r.reasoning };
      if (r.text) yield { type: "text-delta", text: r.text };
      for (const c of r.toolCalls ?? []) yield { type: "tool-call", toolCallId: c.toolCallId ?? newToolCallId(), toolName: c.toolName, args: c.args };
      const usage = usageOf(r.usage);
      yield { type: "finish", ...(r.finishReason !== undefined ? { finishReason: r.finishReason } : {}), ...(usage ? { usage } : {}) };
    },
  };
}

// ------------------------------------------------------------------------------------------------ mock

export type MockStep = {
  /** Streamed as these chunks (a string is split into `chunkSize`-char pieces). */
  text?: string | string[];
  /** Reasoning streamed before the text, as `reasoning-delta` chunks (split like `text`). */
  reasoning?: string | string[];
  toolCalls?: Array<{ toolName: string; args: unknown; toolCallId?: string }>;
  usage?: Partial<Usage>;
  finishReason?: string;
  /** Throws after streaming the text (a model / network error). */
  error?: string;
  /** With `error`: the HTTP status the error carries (`status`, as provider errors do: 429, 503, ...). */
  errorStatus?: number;
  /** With `error`: its `Retry-After` header (seconds or an HTTP date). */
  retryAfter?: string;
  /** Waits this long between chunks (ms). */
  delayMs?: number;
};

/**
 * A scripted model for tests (no network): each call plays the next step (the last one repeats). `requests` keeps
 * what each call was sent; a step can be a function of the request.
 */
export function mockModel(steps: Array<MockStep | ((request: ModelRequest) => MockStep)>, opts: { chunkSize?: number; modelId?: string } = {}): AgentModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const size = opts.chunkSize ?? 4;
  return {
    provider: "mock",
    modelId: opts.modelId ?? "mock-model",
    requests,
    async *stream(request) {
      requests.push(request);
      const pick = steps[Math.min(requests.length - 1, steps.length - 1)];
      if (!pick) throw new Error("mockModel: no steps");
      const step = typeof pick === "function" ? pick(request) : pick;
      const split = (x: string | string[] | undefined) => (typeof x === "string" ? (x.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []) : (x ?? []));
      const chunks = split(step.text);
      for (const text of split(step.reasoning)) {
        if (request.signal.aborted) throw new Error("aborted");
        if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
        yield { type: "reasoning-delta", text };
      }
      for (const text of chunks) {
        if (request.signal.aborted) throw new Error("aborted");
        if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
        yield { type: "text-delta", text };
      }
      if (step.error) {
        const e = new Error(step.error) as Error & { status?: number; responseHeaders?: Record<string, string> };
        if (step.errorStatus !== undefined) e.status = step.errorStatus;
        if (step.retryAfter !== undefined) e.responseHeaders = { "retry-after": step.retryAfter };
        throw e;
      }
      for (const c of step.toolCalls ?? []) yield { type: "tool-call", toolCallId: c.toolCallId ?? newToolCallId(), toolName: c.toolName, args: c.args };
      const text = chunks.join("");
      const usage = usageOf(step.usage ?? { inputTokens: JSON.stringify(request.messages).length >> 2, outputTokens: text.length >> 2 });
      yield { type: "finish", finishReason: step.finishReason ?? (step.toolCalls?.length ? "tool-calls" : "stop"), ...(usage ? { usage } : {}) };
    },
  };
}

// ------------------------------------------------------------------------------------------------ retry

/**
 * Retries of a model call that fails before its first delta (`text-delta`, `reasoning-delta` or `tool-call`): only
 * errors that say they may pass (HTTP 408, 409, 429, 5xx, or `isRetryable: true` as AI SDK errors have). Once a delta
 * went out the step is not repeated (the text is already on the message): the error fails it as before.
 */
export type RetryOptions = {
  /** Calls in all, the first included. Default 3. */
  maxAttempts?: number;
  /** Wait before the first retry, doubled each time (with jitter). Default 500 ms. */
  initialBackoffMs?: number;
  /** Upper bound of a wait, `Retry-After` included (a longer one is not waited for: the error goes up). Default 20 s. */
  maxBackoffMs?: number;
  /** Decides what is retryable instead of the default (status / `isRetryable`). */
  retryable?: (error: unknown) => boolean;
};

type Rec = Record<string, unknown>;
const recOf = (x: unknown): Rec | undefined => (typeof x === "object" && x !== null ? (x as Rec) : undefined);

/** The HTTP status an error carries: `status`, `statusCode`, `response.status`, or a cause's. */
export function errorStatus(e: unknown, depth = 0): number | undefined {
  const r = recOf(e);
  if (!r || depth > 3) return undefined;
  for (const k of ["status", "statusCode"]) if (typeof r[k] === "number") return r[k] as number;
  const res = recOf(r.response);
  if (typeof res?.status === "number") return res.status;
  return errorStatus(r.cause, depth + 1);
}

/** Retryable by default: 408, 409, 429, 5xx, or an error that says so (`isRetryable`). */
export function isRetryableError(e: unknown): boolean {
  const r = recOf(e);
  if (typeof r?.isRetryable === "boolean") return r.isRetryable;
  const status = errorStatus(e);
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

/** `Retry-After` (seconds or an HTTP date) of an error, in ms: `responseHeaders`, `headers` (object or `Headers`), `response.headers`. */
export function retryAfterMs(e: unknown, now = Date.now()): number | undefined {
  const r = recOf(e);
  if (!r) return undefined;
  const header = (h: unknown): string | undefined => {
    if (!h) return undefined;
    if (typeof (h as { get?: unknown }).get === "function") return ((h as { get(k: string): string | null }).get("retry-after") ?? undefined) || undefined;
    const o = recOf(h);
    if (!o) return undefined;
    for (const [k, v] of Object.entries(o)) if (k.toLowerCase() === "retry-after" && typeof v === "string") return v;
    return undefined;
  };
  const raw = header(r.responseHeaders) ?? header(r.headers) ?? header(recOf(r.response)?.headers);
  if (raw === undefined) return typeof r.retryAfter === "number" ? r.retryAfter * 1000 : undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** `model` with retries before the first delta (`RetryOptions`). `onRetry` is told about each one (logs, tests). */
export function withRetry(model: AgentModel, options: RetryOptions = {}, onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void): AgentModel {
  const max = Math.max(1, options.maxAttempts ?? 3);
  const initial = options.initialBackoffMs ?? 500;
  const cap = options.maxBackoffMs ?? 20_000;
  const retryable = options.retryable ?? isRetryableError;
  return {
    // Read through: a model whose provider / id can change (a delegating model) stays accurate.
    get provider() {
      return model.provider;
    },
    get modelId() {
      return model.modelId;
    },
    async *stream(request) {
      for (let attempt = 1; ; attempt++) {
        let emitted = false;
        try {
          for await (const ev of await model.stream(request)) {
            if (ev.type === "error" && !emitted) throw ev.error;
            if (ev.type === "text-delta" || ev.type === "reasoning-delta" || ev.type === "tool-call") emitted = true;
            yield ev;
          }
          return;
        } catch (e) {
          if (emitted || request.signal.aborted || attempt >= max || !retryable(e)) throw e;
          const after = retryAfterMs(e);
          if (after !== undefined && after > cap) throw e;
          const backoff = initial * 2 ** (attempt - 1);
          const delayMs = Math.min(cap, after ?? backoff * (0.5 + Math.random() / 2));
          onRetry?.({ attempt, delayMs, error: e });
          await sleep(delayMs, request.signal);
        }
      }
    },
  };
}
