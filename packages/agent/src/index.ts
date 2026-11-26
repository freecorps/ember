/**
 * `@freecorps/ember-agent`: AI agents as an Ember component (PLAN §12, §22 L12) — persistent threads, responses
 * streamed to live queries, tool calls, usage tracking.
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(agent);
 *
 *   // ember/assistant.ts
 *   export const assistant = new Agent(components.agent, {
 *     name: "support",
 *     model: workersAi("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),   // or an AI SDK model: openai("gpt-5")
 *     instructions: "You help users with their orders.",
 *     tools: { lookupOrder: tool({ args: { orderId: v.string() }, handler: (ctx, { orderId }) => ctx.runQuery(internal.orders.get, { orderId }) }) },
 *     action: internal.assistant.generate,
 *   });
 *   export const generate = assistant.action();                         // runs the model (an internalAction)
 *   export const send = mutation({ args: { threadId: v.string(), text: v.string() }, handler: (ctx, a) => assistant.sendMessage(ctx, a) });
 *   export const messages = query({ args: { threadId: v.string(), paginationOpts: paginationOptsValidator, streamArgs: vStreamArgs },
 *     handler: (ctx, a) => assistant.listMessages(ctx, a) });
 *
 *   // client: useThreadMessages(api.assistant.messages, { threadId }, { initialNumItems: 20 })  (@freecorps/ember-agent/react)
 *
 * Access control is the app's: check the thread's `userId` before calling the helpers.
 */
import { streamArgsValidator } from "./component.ts";

export {
  agent,
  functions as agentFunctions,
  partValidator,
  usageValidator,
  roleValidator,
  messageStatusValidator,
  streamArgsValidator,
  type AgentInstallConfig,
  type AgentMessage,
  type AgentThread,
  type ContextMessage,
  type MessagePart,
  type MessageRole,
  type MessageStatus,
  type StreamDelta,
  type Usage,
} from "./component.ts";
export { Agent, tool, type AgentComponentApi, type AgentOptions, type AgentTool, type ToolCtx, type SendMessageArgs, type UsageEvent, type ListMessagesArgs, type ListMessagesResult, type StreamArgs } from "./agent.ts";
export {
  defineModel,
  mockModel,
  usageOf,
  withRetry,
  isRetryableError,
  errorStatus,
  retryAfterMs,
  type AgentModel,
  type ModelEvent,
  type ModelMessage,
  type ModelPart,
  type ModelRequest,
  type ModelToolSpec,
  type GenerateResult,
  type MockStep,
  type RetryOptions,
} from "./model.ts";
export { generateObject, parseJsonAnswer, modelJsonSchema, ObjectGenerationError, type ObjectSchema, type SchemaType, type GenerateObjectOptions, type GenerateObjectResult } from "./object.ts";
export { workersAi, toWorkersAiMessages, type WorkersAiBinding, type WorkersAiOptions } from "./workers-ai.ts";
export { aiSdk, isLanguageModel, toAiSdkPrompt, type LanguageModelLike } from "./ai-sdk.ts";
export { withStreams, streamedTexts, streamed, type UIMessage } from "./streams.ts";

/** `streamArgs` of the app's messages query (what `useThreadMessages` sends). */
export const vStreamArgs = streamArgsValidator;
