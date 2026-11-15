// @vitest-environment happy-dom
// `@freecorps/ember-agent/react` against the client's FakeEmberServer: pages and the live deltas of the same query
// merged into messages with their streaming text; useSmoothText reveals growing text.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { EmberClient, anyApi, unsafeRef } from "@freecorps/ember-client";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { EmberProvider } from "@freecorps/ember-react";
import { afterEach, describe, expect, it } from "vitest";
import { useSmoothText, useThreadMessages, type ThreadMessagesQuery } from "../src/react.ts";

const api = anyApi as unknown as { chat: { messages: ThreadMessagesQuery<{ threadId: string }> } };

afterEach(cleanup);

function setup() {
  const server = new FakeEmberServer({
    queries: {
      // What `assistant.listMessages` returns: newest first; streamArgs "list" → only the deltas.
      "chat:messages": (db, a: any) => {
        if (a.streamArgs?.kind === "list") return { page: [], isDone: true, continueCursor: "", streams: db.where("deltas", "thread", a.threadId) };
        const page = db.where<any>("messages", "thread", a.threadId).sort((x, y) => y.order - x.order || y.stepOrder - x.stepOrder);
        return { page: page.slice(0, a.paginationOpts.numItems), isDone: true, continueCursor: "" };
      },
    },
    mutations: {
      "t:message": (db, m: any) => db.insert("messages", { parts: [], text: "", ...m }),
      "t:delta": (db, d: any) => db.insert("deltas", d),
      "t:finish": (db, a: any) => {
        for (const d of db.where<any>("deltas", "message", a.id)) db.delete("deltas", d._id);
        db.patch("messages", a.id, { status: "success", text: a.text, parts: [{ type: "text", text: a.text }] });
        return null;
      },
    },
  });
  const client = new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, heartbeat: false, defaultShard: "global:main", backoff: { initialMs: 5, maxMs: 10 } });
  return { server, client, mutate: (fn: string, args: Record<string, unknown>) => client.mutation(unsafeRef<"mutation">(fn), args) };
}

describe("useThreadMessages", () => {
  it("shows the streamed text of a message while it streams, then its final text", async () => {
    const { client, mutate } = setup();
    function Thread() {
      const { results } = useThreadMessages(api.chat.messages, { threadId: "t1" }, { initialNumItems: 10 });
      return (
        <ul>
          {results.map((m) => (
            <li key={m._id} data-testid="m">
              {m.role}:{m.streaming ? "…" : ""}
              {m.text}
            </li>
          ))}
        </ul>
      );
    }
    render(
      <EmberProvider client={client}>
        <Thread />
      </EmberProvider>,
    );
    await mutate("t:message", { thread: "t1", order: 0, stepOrder: 0, role: "user", status: "success", text: "hi" });
    const id = (await mutate("t:message", { thread: "t1", order: 0, stepOrder: 1, role: "assistant", status: "streaming" })) as string;
    const rows = () => screen.queryAllByTestId("m").map((e) => e.textContent);
    await waitFor(() => expect(rows()).toEqual(["user:hi", "assistant:…"]));
    await mutate("t:delta", { thread: "t1", message: id, seq: 0, text: "Hel" });
    await mutate("t:delta", { thread: "t1", message: id, seq: 1, text: "lo" });
    await waitFor(() => expect(rows()).toEqual(["user:hi", "assistant:…Hello"]));
    await mutate("t:finish", { id, text: "Hello!" });
    await waitFor(() => expect(rows()).toEqual(["user:hi", "assistant:Hello!"]));
    client.close();
  });
});

describe("useSmoothText", () => {
  it("reveals growing text over frames and shows unrelated text at once", async () => {
    let frames: FrameRequestCallback[] = [];
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => (frames.push(cb), frames.length);
    let t = 0;
    const step = () =>
      act(() => {
        const run = frames;
        frames = [];
        t += 50;
        for (const f of run) f(t);
      });
    function Smooth({ text }: { text: string }) {
      const [visible] = useSmoothText(text, { charsPerSec: 100, startStreaming: true });
      return <p data-testid="s">{visible}</p>;
    }
    const view = render(<Smooth text="" />);
    const shown = () => screen.getByTestId("s").textContent ?? "";
    view.rerender(<Smooth text="abcdefghijklmnopqrstuvwxyz" />);
    step();
    step();
    const partial = shown();
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(26);
    for (let i = 0; i < 40 && shown().length < 26; i++) step();
    expect(shown()).toBe("abcdefghijklmnopqrstuvwxyz");
    view.rerender(<Smooth text="something else" />);
    await waitFor(() => expect(shown()).toBe("something else"));
    globalThis.requestAnimationFrame = raf;
  });
});
