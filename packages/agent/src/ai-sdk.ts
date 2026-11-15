// Any Vercel AI SDK provider model (`openai("gpt-5")`, `anthropic(...)`, `createWorkersAI(...)(...)`) as an AgentModel,
// without depending on `ai`: the LanguageModel specification (v1, v2, v3) is read structurally. The model's
// `doStream` is called directly (the agent runs the tool loop, the provider only does one step).

import { newToolCallId, usageOf, type AgentModel, type ModelEvent, type ModelMessage, type ModelPart, type ModelRequest } from "./model.ts";

/** The part of an AI SDK LanguageModel (V1/V2/V3) the adapter uses. */
export interface LanguageModelLike {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
  doStream(options: Record<string, unknown>): PromiseLike<{ stream: ReadableStream<unknown> }>;
}

export const isLanguageModel = (x: unknown): x is LanguageModelLike =>
  typeof x === "object" && x !== null && typeof (x as LanguageModelLike).specificationVersion === "string" && typeof (x as LanguageModelLike).doStream === "function";

type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec | undefined => (typeof x === "object" && x !== null ? (x as Rec) : undefined);
const parseArgs = (a: unknown): unknown => {
  if (typeof a !== "string") return a ?? {};
  try {
    return JSON.parse(a);
  } catch {
    return a;
  }
};

/** The agent's messages as an AI SDK prompt (`LanguageModelV1Prompt` or V2/V3). */
export function toAiSdkPrompt(system: string | undefined, messages: ModelMessage[], v1: boolean): Rec[] {
  const out: Rec[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "system") {
      out.push({ role: "system", content: m.content.map((p) => (p.type === "text" ? p.text : "")).join("") });
      continue;
    }
    const content = m.content.flatMap((p: ModelPart): Rec[] => {
      switch (p.type) {
        case "text":
          return [{ type: "text", text: p.text }];
        case "reasoning":
          return m.role === "assistant" ? [{ type: "reasoning", text: p.text }] : [];
        case "file":
          return v1 ? [{ type: "file", data: new URL(p.url), mimeType: p.mimeType }] : [{ type: "file", data: new URL(p.url), mediaType: p.mimeType, ...(p.filename ? { filename: p.filename } : {}) }];
        case "tool-call":
          return [v1 ? { type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, args: p.args } : { type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: p.args }];
        case "tool-result":
          if (v1) return [{ type: "tool-result", toolCallId: p.toolCallId, toolName: p.toolName, result: p.result, ...(p.isError ? { isError: true } : {}) }];
          return [
            {
              type: "tool-result",
              toolCallId: p.toolCallId,
              toolName: p.toolName,
              output: p.isError ? { type: "error-text", value: typeof p.result === "string" ? p.result : JSON.stringify(p.result) } : typeof p.result === "string" ? { type: "text", value: p.result } : { type: "json", value: p.result ?? null },
            },
          ];
      }
    });
    out.push({ role: m.role, content });
  }
  return out;
}

/** `{ inputTokens, outputTokens }` (v2), `{ inputTokens: { total }, outputTokens: { total } }` (v3), `{ promptTokens, completionTokens }` (v1). */
function sdkUsage(u: unknown) {
  const r = rec(u);
  if (!r) return undefined;
  const n = (x: unknown): number | undefined => (typeof x === "number" ? x : typeof rec(x)?.total === "number" ? (rec(x)!.total as number) : undefined);
  const inputTokens = n(r.inputTokens) ?? n(r.promptTokens) ?? 0;
  const outputTokens = n(r.outputTokens) ?? n(r.completionTokens) ?? 0;
  return usageOf({ inputTokens, outputTokens, totalTokens: n(r.totalTokens) ?? inputTokens + outputTokens });
}
const finishOf = (f: unknown) => (typeof f === "string" ? f : typeof rec(f)?.unified === "string" ? (rec(f)!.unified as string) : undefined);

/** Wraps an AI SDK LanguageModel (V1, V2 or V3). `settings` are passed to every call (e.g. `providerOptions`). */
export function aiSdk(model: LanguageModelLike, settings: Record<string, unknown> = {}): AgentModel {
  const v1 = model.specificationVersion === "v1";
  return {
    provider: model.provider,
    modelId: model.modelId,
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      const tools = req.tools.map((t) => (v1 ? { type: "function", name: t.name, description: t.description, parameters: t.parameters } : { type: "function", name: t.name, description: t.description, inputSchema: t.parameters }));
      const options: Rec = { ...settings, prompt: toAiSdkPrompt(req.system, req.messages, v1), abortSignal: req.signal };
      if (v1) {
        options.inputFormat = "messages";
        options.mode = { type: "regular", ...(tools.length ? { tools } : {}) };
        if (req.maxOutputTokens !== undefined) options.maxTokens = req.maxOutputTokens;
      } else {
        if (tools.length) options.tools = tools;
        if (req.maxOutputTokens !== undefined) options.maxOutputTokens = req.maxOutputTokens;
      }
      if (req.temperature !== undefined) options.temperature = req.temperature;
      const { stream } = await model.doStream(options);
      const reader = stream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const p = rec(value);
          if (!p) continue;
          switch (p.type) {
            case "text-delta": {
              const text = typeof p.delta === "string" ? p.delta : typeof p.textDelta === "string" ? p.textDelta : "";
              if (text) yield { type: "text-delta", text };
              break;
            }
            case "reasoning":
            case "reasoning-delta": {
              const text = typeof p.delta === "string" ? p.delta : typeof p.textDelta === "string" ? p.textDelta : "";
              if (text) yield { type: "reasoning-delta", text };
              break;
            }
            case "tool-call":
              // Provider-executed tools (web search on some providers) are not the agent's to run.
              if (p.providerExecuted === true) break;
              yield { type: "tool-call", toolCallId: typeof p.toolCallId === "string" ? p.toolCallId : newToolCallId(), toolName: String(p.toolName), args: parseArgs(p.input ?? p.args) };
              break;
            case "finish": {
              const usage = sdkUsage(p.usage);
              const finishReason = finishOf(p.finishReason);
              yield { type: "finish", ...(finishReason !== undefined ? { finishReason } : {}), ...(usage ? { usage } : {}) };
              break;
            }
            case "error":
              yield { type: "error", error: p.error };
              break;
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
