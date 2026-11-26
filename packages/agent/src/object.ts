// `generateObject`: one model call that must answer with JSON matching an Ember validator. The validator's JSON Schema
// (`toJsonSchema`, from @freecorps/ember-values) goes to the model as its response format, and the answer is parsed
// and validated (defaults applied) before it is returned: a model that ignores the format still cannot hand back
// something the validator rejects.

import { isValidator, toJsonSchema, v, withDefaults, type GenericValidator, type Infer, type ObjectType, type PropertyValidators } from "@freecorps/ember-values";
import { aiSdk, isLanguageModel, type LanguageModelLike } from "./ai-sdk.ts";
import { withRetry, type AgentModel, type ModelMessage, type RetryOptions, type Usage } from "./model.ts";

/** A validator (`v.object({...})`, `v.array(...)`, ...) or an object of validators (`{ title: v.string() }`). */
export type ObjectSchema = GenericValidator | PropertyValidators;
/** The value an `ObjectSchema` accepts. */
export type SchemaType<S extends ObjectSchema> = S extends GenericValidator ? Infer<S> : S extends PropertyValidators ? ObjectType<S> : never;

export type GenerateObjectOptions<S extends ObjectSchema> = {
  schema: S;
  /** The user's request (one user message), or `messages` for a whole conversation. */
  prompt?: string;
  messages?: ModelMessage[];
  system?: string;
  /** Name and description of the object, for providers that take them (AI SDK `responseFormat`). */
  name?: string;
  description?: string;
  /** Bindings for the model (`ctx.env` in an action: `EMBER_AI` for `workersAi`). */
  env?: Record<string, unknown>;
  signal?: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
  /** Retries before the first delta on 429/5xx (`RetryOptions`). Default on; `false` turns it off. */
  retry?: RetryOptions | false;
};

export type GenerateObjectResult<T> = { object: T; text: string; usage?: Usage; finishReason?: string };

/** The model's answer was not JSON, or not what the schema accepts. `text` is what it said. */
export class ObjectGenerationError extends Error {
  override readonly name = "ObjectGenerationError";
  constructor(
    message: string,
    readonly text: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

/** The JSON in a model's answer: the whole text, a fenced ```json block, or the outermost object / array in it. */
export function parseJsonAnswer(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const body = fenced ? fenced[1]! : t;
  try {
    return JSON.parse(body);
  } catch {
    const starts = [body.indexOf("{"), body.indexOf("[")].filter((i) => i >= 0);
    if (!starts.length) throw new ObjectGenerationError("the model did not answer with JSON", text);
    const from = Math.min(...starts);
    const to = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    try {
      return JSON.parse(body.slice(from, to + 1));
    } catch {
      throw new ObjectGenerationError("the model did not answer with valid JSON", text);
    }
  }
}

/**
 * `toJsonSchema` describes the wire form, where a number may also be `{ $float: "NaN" | ... }`: a model never has to
 * write that (nor could JSON mode providers accept the extra branch), so it is dropped from the schema sent.
 */
export function modelJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(modelJsonSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const o = schema as Record<string, unknown>;
  const branches = o.anyOf;
  if (Array.isArray(branches) && branches.length === 2) {
    const tag = (branches[1] as { properties?: Record<string, unknown> } | null)?.properties;
    if (tag && Object.keys(tag).length === 1 && "$float" in tag) return modelJsonSchema(branches[0]);
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, modelJsonSchema(x)]));
}

const toValidator = (s: ObjectSchema): GenericValidator => (isValidator(s) ? s : (v.object(s as Record<string, GenericValidator>) as GenericValidator));

/** Runs `model` once for an object matching `schema` (validated: `ObjectGenerationError` otherwise). */
export async function generateObject<S extends ObjectSchema>(model: AgentModel | LanguageModelLike, opts: GenerateObjectOptions<S>): Promise<GenerateObjectResult<SchemaType<S>>> {
  const base = isLanguageModel(model) ? aiSdk(model) : model;
  const m = opts.retry === false ? base : withRetry(base, opts.retry ?? {});
  const validator = toValidator(opts.schema);
  const schema = modelJsonSchema(toJsonSchema(validator.shape)) as Record<string, unknown>;
  const messages: ModelMessage[] = [...(opts.messages ?? []), ...(opts.prompt !== undefined ? [{ role: "user" as const, content: [{ type: "text" as const, text: opts.prompt }] }] : [])];
  if (!messages.length) throw new Error("generateObject needs a prompt or messages");
  // The schema in the instructions too: Workers AI models and providers without a JSON mode still see it.
  const system = [opts.system, `Answer only with a JSON value that matches this JSON Schema:\n${JSON.stringify(schema)}`].filter(Boolean).join("\n\n");
  const events = await m.stream({
    system,
    messages,
    tools: [],
    signal: opts.signal ?? new AbortController().signal,
    env: opts.env ?? {},
    responseFormat: { type: "json", schema, ...(opts.name !== undefined ? { name: opts.name } : {}), ...(opts.description !== undefined ? { description: opts.description } : {}) },
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
  });
  let text = "";
  let usage: Usage | undefined;
  let finishReason: string | undefined;
  for await (const ev of events) {
    if (ev.type === "text-delta") text += ev.text;
    else if (ev.type === "finish") {
      usage = ev.usage;
      finishReason = ev.finishReason;
    } else if (ev.type === "error") throw ev.error instanceof Error ? ev.error : new Error(typeof ev.error === "string" ? ev.error : JSON.stringify(ev.error));
  }
  const value = withDefaults(validator.shape, parseJsonAnswer(text));
  const check = validator.validate(value);
  if (!check.ok) throw new ObjectGenerationError(`the model's object does not match the schema${check.path ? ` at ${check.path}` : ""}: ${check.message}`, text, check.path);
  const out: GenerateObjectResult<SchemaType<S>> = { object: value as SchemaType<S>, text };
  if (usage) out.usage = usage;
  if (finishReason !== undefined) out.finishReason = finishReason;
  return out;
}
