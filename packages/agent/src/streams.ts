// Client-side helpers (no server imports at runtime): merge the streamed deltas into the messages they belong to.

import type { AgentMessage, MessagePart, StreamDelta } from "./component.ts";

export type { AgentMessage, StreamDelta, MessagePart };

/**
 * A message with its streamed text so far; `streaming` while the model is still writing it. `reasoning`: the model's
 * reasoning (streamed so far, or the message's `reasoning` parts once it finished), when it has one.
 */
export type UIMessage<M extends AgentMessage = AgentMessage> = M & { streaming: boolean; reasoning?: string };

/** Deltas of each message, joined in `seq` order. */
export function streamedTexts(deltas: readonly StreamDelta[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, s] of streamed(deltas)) out.set(id, s.text);
  return out;
}

/** Text and reasoning of each message's deltas, joined in `seq` order. */
export function streamed(deltas: readonly StreamDelta[]): Map<string, { text: string; reasoning: string }> {
  const by = new Map<string, StreamDelta[]>();
  for (const d of deltas) {
    const list = by.get(d.message);
    if (list) list.push(d);
    else by.set(d.message, [d]);
  }
  const out = new Map<string, { text: string; reasoning: string }>();
  for (const [id, list] of by) {
    list.sort((a, b) => a.seq - b.seq);
    out.set(id, { text: list.map((d) => d.text).join(""), reasoning: list.map((d) => d.reasoning ?? "").join("") });
  }
  return out;
}

const reasoningOf = (parts: readonly MessagePart[]) =>
  parts
    .filter((p): p is Extract<MessagePart, { type: "reasoning" }> => p.type === "reasoning")
    .map((p) => p.text)
    .join("");

/**
 * `messages` (any order) with the streamed text (and reasoning) of the ones still pending or streaming. A message that
 * finished keeps its own text (deltas left over from an older snapshot are ignored). Returned oldest first.
 */
export function withStreams<M extends AgentMessage>(messages: readonly M[], deltas: readonly StreamDelta[] = []): UIMessage<M>[] {
  const live = streamed(deltas);
  return [...messages]
    .sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder)
    .map((m) => {
      const streaming = m.status === "streaming" || m.status === "pending";
      const s = streaming ? live.get(m._id) : undefined;
      if (s === undefined) {
        const reasoning = reasoningOf(m.parts);
        return reasoning ? { ...m, streaming, reasoning } : { ...m, streaming };
      }
      const parts: MessagePart[] = [
        ...(s.reasoning ? [{ type: "reasoning" as const, text: s.reasoning }] : []),
        ...m.parts.filter((p) => p.type !== "text" && (!s.reasoning || p.type !== "reasoning")),
        ...(s.text ? [{ type: "text" as const, text: s.text }] : []),
      ];
      const out: UIMessage<M> = { ...m, text: s.text, parts, streaming: true };
      if (s.reasoning) out.reasoning = s.reasoning;
      return out;
    });
}
