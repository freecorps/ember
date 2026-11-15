// `@freecorps/ember-agent/react`: a thread's messages with their streaming text, and smooth text reveal.
//
//   const { results, status, loadMore } = useThreadMessages(api.chat.messages, { threadId }, { initialNumItems: 20 });
//   results.map((m) => <Bubble key={m._id} text={m.text} streaming={m.streaming} />)
//
// The app query takes `{ threadId, paginationOpts, streamArgs }` and returns `assistant.listMessages(ctx, args)`.
// Pages come from `usePaginatedQuery`; a second live query of the same function (`streamArgs: { kind: "list" }`)
// carries the deltas of messages being streamed, so each batch reaches the client as one small row patch.

import { usePaginatedQuery, useQuery, type UsePaginatedQueryResult } from "@freecorps/ember-react";
import type { FunctionReference, PaginationOptions, Visibility } from "@freecorps/ember-values";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ListMessagesResult, StreamArgs } from "./agent.ts";
import type { AgentMessage } from "./component.ts";
import { withStreams, type UIMessage } from "./streams.ts";

export { withStreams, streamedTexts, type UIMessage } from "./streams.ts";

/** The app's messages query: `{ threadId, paginationOpts, streamArgs? }` → `assistant.listMessages(ctx, args)`. */
export type ThreadMessagesQuery<Args extends { threadId: string }> = FunctionReference<
  "query",
  Visibility,
  Args & { paginationOpts: PaginationOptions; streamArgs?: StreamArgs },
  ListMessagesResult,
  never,
  null
>;

type Opts = { initialNumItems: number; shard?: string; /** Default true. */ stream?: boolean };

type LooseUseQuery = (ref: unknown, args: unknown, opts?: unknown) => ListMessagesResult | undefined;
type LooseUsePaginated = (ref: unknown, args: unknown, opts: unknown) => UsePaginatedQueryResult<AgentMessage>;

/** Messages oldest first, the ones being streamed with their text so far (`streaming: true`). */
export function useThreadMessages<Args extends { threadId: string }>(
  ref: ThreadMessagesQuery<Args>,
  args: Args | "skip",
  opts: Opts,
): UsePaginatedQueryResult<UIMessage> {
  const shard = opts.shard === undefined ? {} : { shard: opts.shard };
  const pages = (usePaginatedQuery as unknown as LooseUsePaginated)(ref, args, { initialNumItems: opts.initialNumItems, ...shard });
  const live = args === "skip" || opts.stream === false ? "skip" : { ...args, paginationOpts: { numItems: 0, cursor: null }, streamArgs: { kind: "list" } };
  const streams = (useQuery as unknown as LooseUseQuery)(ref, live, shard);
  const results = useMemo(() => withStreams(pages.results, streams?.streams ?? []), [pages.results, streams]);
  return useMemo(() => ({ ...pages, results }), [pages, results]);
}

/**
 * Reveals `text` smoothly while it grows (streamed batches arrive every ~100 ms): about `charsPerSec` characters per
 * second, faster when far behind so it never lags more than ~1 s. Text that is not an extension of the previous
 * one is shown at once.
 */
export function useSmoothText(text: string, opts: { charsPerSec?: number; startStreaming?: boolean } = {}): [string, { isStreaming: boolean }] {
  const rate = opts.charsPerSec ?? 256;
  const [shown, setShown] = useState(() => (opts.startStreaming ? 0 : text.length));
  const state = useRef({ text, shown, last: 0 });
  useEffect(() => {
    const s = state.current;
    if (!text.startsWith(s.text.slice(0, Math.min(s.shown, text.length)))) s.shown = text.length;
    s.text = text;
    if (s.shown >= text.length) {
      s.shown = text.length;
      setShown(text.length);
      return;
    }
    let frame = 0;
    s.last = 0;
    const tick = (t: number) => {
      const dt = s.last ? Math.min(t - s.last, 100) : 16;
      s.last = t;
      const behind = s.text.length - s.shown;
      s.shown = Math.min(s.text.length, s.shown + Math.max(1, Math.round(Math.max(rate, behind) * (dt / 1000))));
      setShown(s.shown);
      if (s.shown < s.text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, rate]);
  const visible = text.slice(0, Math.min(shown, text.length));
  return [visible, { isStreaming: visible.length < text.length }];
}
