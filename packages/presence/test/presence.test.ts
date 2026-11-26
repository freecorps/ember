// Presence over the client's fake server (feature "ephemeral"): members, typing (with expiry), throttled cursors,
// late joiners, and the payload validators the shard checks.
import { EmberClient } from "@freecorps/ember-client";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { checkChannelValue, defineApp } from "@freecorps/ember-server";
import { v } from "@freecorps/ember-values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Presence, presenceChannel, presenceMessage } from "../src/index.ts";

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const x of open.splice(0)) x.close();
});

const until = (cond: () => unknown, timeout = 2000) =>
  vi.waitFor(
    () => {
      if (!cond()) throw new Error("condition not met");
    },
    { timeout, interval: 2 },
  );

function setup() {
  const server = new FakeEmberServer({ ephemeral: true });
  const client = (user: string) => {
    const c = new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, heartbeat: false, defaultShard: "room:1", backoff: { initialMs: 5, maxMs: 10 }, auth: () => `user:${user}` });
    open.push(c);
    return c;
  };
  const presence = <S = unknown>(c: EmberClient, opts: ConstructorParameters<typeof Presence<S>>[2] = {}) => {
    const p = new Presence<S>(c, "room:1", opts);
    open.push(p);
    return p;
  };
  const pubs = () => server.history.flatMap((ws) => ws.sent).filter((m) => typeof m === "object" && m.t === "pub");
  return { server, client, presence, pubs };
}

describe("Presence", () => {
  it("members of the room, with their state; a member that leaves goes", async () => {
    const { client, presence } = setup();
    const a = presence<{ name: string }>(client("ana"), { state: { name: "Ana" } });
    const bc = client("bia");
    const b = presence<{ name: string }>(bc, { state: { name: "Bia" } });
    await until(() => a.members().length === 2 && b.members().length === 2);
    expect(a.members().map((m) => [m.user, m.state?.name, m.self])).toEqual([
      ["ana", "Ana", true],
      ["bia", "Bia", false],
    ]);
    let changes = 0;
    a.subscribeMembers(() => changes++);
    b.setState({ name: "Bia B." });
    await until(() => a.members().find((m) => m.user === "bia")?.state?.name === "Bia B.");
    bc.close();
    await until(() => a.members().length === 1);
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it("typing: on, refreshed, off; expires when not refreshed; its own indicator is not listed", async () => {
    const { client, presence } = setup();
    const a = presence(client("ana"), { typingTimeoutMs: 200 });
    const b = presence(client("bia"), { typingTimeoutMs: 200 });
    await until(() => a.status() === "joined" && b.status() === "joined" && a.members().length === 2);
    b.setTyping(true);
    await until(() => a.typing().length === 1);
    expect(a.typing()[0]).toMatchObject({ user: "bia", key: b.key });
    expect(b.typing()).toEqual([]);
    // Still typing after the timeout: refreshed at half of it.
    await new Promise((r) => setTimeout(r, 300));
    expect(a.typing()).toHaveLength(1);
    b.setTyping(false);
    await until(() => a.typing().length === 0);
    // A sender that vanishes without "off": the indicator expires.
    b.setTyping(true);
    await until(() => a.typing().length === 1);
    const internal = b as unknown as { typingTimer: ReturnType<typeof setTimeout> | null };
    if (internal.typingTimer) clearTimeout(internal.typingTimer);
    internal.typingTimer = null;
    await until(() => a.typing().length === 0, 1_000);
  });

  it("cursors are throttled (the last position always goes); a late joiner gets them; a leaving member's cursor goes", async () => {
    const { client, presence, pubs } = setup();
    const a = presence(client("ana"), { cursorThrottleMs: 40 });
    const bc = client("bia");
    const b = presence(bc, { cursorThrottleMs: 40 });
    await until(() => a.members().length === 2 && b.members().length === 2);
    let renders = 0;
    a.subscribeCursors(() => renders++);
    let memberChanges = 0;
    a.subscribeMembers(() => memberChanges++);
    for (let i = 0; i <= 20; i++) b.moveCursor({ x: i, y: i });
    await until(() => a.cursors()[0]?.at.x === 20);
    const sent = pubs().filter((m) => (m as { data: { k: string } }).data.k === "cursor");
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(renders).toBeLessThanOrEqual(2);
    expect(memberChanges).toBe(0); // a cursor never touches the member list
    // A late joiner learns where b's cursor is.
    const c = presence(client("caio"));
    await until(() => c.cursors()[0]?.at.x === 20);
    bc.close();
    await until(() => a.cursors().length === 0 && c.cursors().length === 0);
  });

  it("the payload validators: typing and cursor messages, a custom cursor", () => {
    expect(presenceMessage().shape.kind).toBe("union");
    const app = defineApp({ channels: { "room:*": presenceChannel({ authorize: () => true, state: v.object({ name: v.string() }), cursor: v.object({ x: v.number(), y: v.number(), page: v.string() }) }) } });
    const def = app.channels["room:*"]!;
    expect(checkChannelValue(def, "payload", { k: "typing", key: "k", on: true })).toBeNull();
    expect(checkChannelValue(def, "payload", { k: "cursor", key: "k", at: null })).toBeNull();
    expect(checkChannelValue(def, "payload", { k: "cursor", key: "k", at: { x: 1, y: 2, page: "/a" } })).toBeNull();
    expect(checkChannelValue(def, "payload", { k: "cursor", key: "k", at: { x: 1, y: 2 } })).not.toBeNull();
    expect(checkChannelValue(def, "payload", { k: "shout", key: "k" })).not.toBeNull();
    expect(checkChannelValue(def, "payload", { k: "typing", key: "x".repeat(65), on: true })).not.toBeNull();
    expect(checkChannelValue(def, "state", { name: "Ana" })).toBeNull();
    expect(checkChannelValue(def, "state", { name: 1 })).not.toBeNull();
  });
});
