// @vitest-environment happy-dom
// `@freecorps/ember-presence/react` over the client's fake server: each hook re-renders only for its own aspect, the
// hooks of one room share one channel, and it is left after the last one unmounts.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { EmberClient } from "@freecorps/ember-client";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { EmberProvider } from "@freecorps/ember-react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Presence } from "../src/index.ts";
import { useCursors, usePresence, useTyping } from "../src/react.ts";

afterEach(cleanup);

const renders = { members: 0, typing: 0, cursors: 0 };

function Members() {
  renders.members++;
  const { members, status } = usePresence<{ name: string }>("room:r", { state: { name: "Ana" } });
  return <p data-testid="members">{`${status}:${members.map((m) => `${m.user}${m.self ? "*" : ""}=${m.state?.name ?? ""}`).sort().join(",")}`}</p>;
}
function Typing() {
  renders.typing++;
  const { typing } = useTyping("room:r");
  return <p data-testid="typing">{typing.map((t) => t.user).join(",")}</p>;
}
function Cursors() {
  renders.cursors++;
  const { cursors } = useCursors("room:r");
  return <p data-testid="cursors">{cursors.map((c) => `${c.user}@${c.at.x},${c.at.y}`).join(",")}</p>;
}

describe("presence hooks", () => {
  it("members, typing and cursors; a cursor move re-renders only the cursors", async () => {
    const server = new FakeEmberServer({ ephemeral: true });
    const make = (user: string) => new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, heartbeat: false, defaultShard: "global:main", backoff: { initialMs: 5, maxMs: 10 }, auth: () => `user:${user}` });
    const client = make("ana");
    const other = make("bia");
    const bia = new Presence<{ name: string }>(other, "room:r", { state: { name: "Bia" }, cursorThrottleMs: 0 });
    render(
      <StrictMode>
        <EmberProvider client={client}>
          <Members />
          <Typing />
          <Cursors />
        </EmberProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId("members").textContent).toBe("joined:ana*=Ana,bia=Bia"));
    // One join on ana's socket for the three hooks (StrictMode remounts included).
    const anaWs = server.history.filter((ws) => ws.identity?.subject === "ana");
    expect(anaWs.flatMap((ws) => ws.sent).filter((m) => typeof m === "object" && m.t === "join")).toHaveLength(1);

    bia.setTyping(true);
    await waitFor(() => expect(screen.getByTestId("typing").textContent).toBe("bia"));
    const before = { ...renders };
    for (let i = 1; i <= 5; i++) {
      await act(async () => {
        bia.moveCursor({ x: i, y: i * 2 });
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    await waitFor(() => expect(screen.getByTestId("cursors").textContent).toBe("bia@5,10"));
    expect(renders.members).toBe(before.members);
    expect(renders.typing).toBe(before.typing);
    expect(renders.cursors).toBeGreaterThan(before.cursors);

    cleanup();
    await waitFor(() => expect(bia.members().map((m) => m.user)).toEqual(["bia"]));
    bia.close();
    client.close();
    other.close();
  });
});
