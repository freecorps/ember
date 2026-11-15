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
  toolCalls?: Array<{ toolName: string; args: unknown; toolCallId?: string }>;
  usage?: Partial<Usage>;
  finishReason?: string;
  /** Throws after streaming the text (a model / network error). */
  error?: string;
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
      const chunks = typeof step.text === "string" ? (step.text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []) : (step.text ?? []);
      for (const text of chunks) {
        if (request.signal.aborted) throw new Error("aborted");
        if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
        yield { type: "text-delta", text };
      }
      if (step.error) throw new Error(step.error);
      for (const c of step.toolCalls ?? []) yield { type: "tool-call", toolCallId: c.toolCallId ?? newToolCallId(), toolName: c.toolName, args: c.args };
      const text = chunks.join("");
      const usage = usageOf(step.usage ?? { inputTokens: JSON.stringify(request.messages).length >> 2, outputTokens: text.length >> 2 });
      yield { type: "finish", finishReason: step.finishReason ?? (step.toolCalls?.length ? "tool-calls" : "stop"), ...(usage ? { usage } : {}) };
    },
  };
}
