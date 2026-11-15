// Client-side helpers (no server imports at runtime): merge the streamed deltas into the messages they belong to.

import type { AgentMessage, MessagePart, StreamDelta } from "./component.ts";

export type { AgentMessage, StreamDelta, MessagePart };

/** A message with its streamed text so far; `streaming` while the model is still writing it. */
export type UIMessage<M extends AgentMessage = AgentMessage> = M & { streaming: boolean };

/** Deltas of each message, joined in `seq` order. */
export function streamedTexts(deltas: readonly StreamDelta[]): Map<string, string> {
  const by = new Map<string, StreamDelta[]>();
  for (const d of deltas) {
    const list = by.get(d.message);
    if (list) list.push(d);
    else by.set(d.message, [d]);
  }
  const out = new Map<string, string>();
  for (const [id, list] of by) {
    list.sort((a, b) => a.seq - b.seq);
    out.set(id, list.map((d) => d.text).join(""));
  }
  return out;
}

/**
 * `messages` (any order) with the streamed text of the ones still pending or streaming. A message that finished
 * keeps its own text (deltas left over from an older snapshot are ignored). Returned oldest first.
 */
export function withStreams<M extends AgentMessage>(messages: readonly M[], deltas: readonly StreamDelta[] = []): UIMessage<M>[] {
  const texts = streamedTexts(deltas);
  return [...messages]
    .sort((a, b) => a.order - b.order || a.stepOrder - b.stepOrder)
    .map((m) => {
      const live = m.status === "streaming" || m.status === "pending";
      const text = live ? texts.get(m._id) : undefined;
      if (text === undefined) return { ...m, streaming: live };
      const parts: MessagePart[] = [...m.parts.filter((p) => p.type !== "text"), { type: "text", text }];
      return { ...m, text, parts, streaming: true };
    });
}
