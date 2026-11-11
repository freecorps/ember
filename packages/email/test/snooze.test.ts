// Snooze (wake-up job, back as new, woken by an answer), scheduled sends (list, cancel) and presence (expiring rows
// deleted by a job, so subscribers see them go).
import { describe, expect, test } from "vitest";
import { fakeTransport, inboxHarness } from "./harness.ts";
import { TransportError } from "../src/index.ts";

const MIN = 60_000;
const noLimit = { rateLimit: { rate: 1_000_000, period: 60_000 } };
const ids = (r: any) => r.page.map((t: any) => t._id);
const list = (h: ReturnType<typeof inboxHarness>, args: Record<string, unknown> = {}) => ids(h.query("@email/lib:threads", { mailbox: "support", ...args }));
const kinds = (h: ReturnType<typeof inboxHarness>, threadId: string) => h.query("@email/lib:activity", { threadId }).map((e: any) => [e.kind, e.author ?? null, e.data]);

describe("snooze", () => {
  test("out of lists and counts until it wakes; then on top, unread and open; events", async () => {
    const h = inboxHarness(noLimit);
    const tag = h.mutate("@email/lib:createTag", { mailbox: "support", name: "Bug" });
    const a = h.ingest({ subject: "A", from: { email: "a@user.test" } }).threadId;
    h.advance(1);
    const b = h.ingest({ subject: "B", from: { email: "b@user.test" } }).threadId;
    h.mutate("@email/lib:setTags", { threadId: a, tags: [tag] });
    h.mutate("@email/lib:assign", { threadId: a, assignee: "u1" });
    h.mutate("@email/lib:markRead", { threadId: a });
    h.mutate("@email/lib:setStatus", { threadId: a, status: "waiting" });
    await h.tick();

    expect(() => h.mutate("@email/lib:snooze", { threadId: a, until: h.now() - 1 })).toThrow(/future/);
    expect(() => h.mutate("@email/lib:snooze", { threadId: a, until: h.now() + 400 * 86_400_000 })).toThrow(/366 days/);
    const until = h.now() + 60 * MIN;
    expect(h.mutate("@email/lib:snooze", { threadId: a, until: h.now() + 10 * MIN, author: "Bia" })).toBeGreaterThan(0);
    h.mutate("@email/lib:snooze", { threadId: a, until, author: "Bia" }); // re-snooze: one wake-up job only
    expect(h.jobs().filter((j) => j.fn === "@email/lib:wake")).toHaveLength(1);

    expect(list(h)).toEqual([b]);
    for (const f of [{ status: "waiting" }, { assignee: "u1" }, { unread: false }, { tag }]) expect(list(h, f)).toEqual([]);
    expect(list(h, { snoozed: true })).toEqual([a]);
    expect(list(h, { snoozed: true, tag })).toEqual([a]);
    expect(list(h, { snoozed: true, status: "open" })).toEqual([]);
    const c = h.query("@email/lib:counts", { mailbox: "support", assignee: "u1" });
    expect(c.all.threads).toBe(1);
    expect(c.snoozed).toEqual({ threads: 1, unread: 0, unreadThreads: 0 });
    expect(c.assignee.all.threads).toBe(0);
    expect(c.assignee.snoozed.threads).toBe(1);
    expect(c.tags[tag].snoozed.threads).toBe(1);
    expect(h.query("@email/lib:thread", { threadId: a }).thread).toMatchObject({ snoozed: true, snoozedUntil: until });

    h.advance(59 * MIN);
    await h.tick();
    expect(list(h)).toEqual([b]);
    h.advance(MIN);
    await h.tick();
    // Back as new: on top, unread, open.
    expect(list(h)).toEqual([a, b]);
    const t = h.query("@email/lib:thread", { threadId: a }).thread;
    expect(t).toMatchObject({ status: "open", unreadCount: 1, hasUnread: true, lastMessageAt: until });
    expect(t.snoozed).toBeUndefined();
    expect(t.snoozedUntil).toBeUndefined();
    expect(list(h, { tag, unread: true })).toEqual([a]);
    expect(h.query("@email/lib:counts", { mailbox: "support" }).snoozed.threads).toBe(0);
    expect(kinds(h, a).slice(-4)).toEqual([
      ["snoozed", "Bia", { until: until - 50 * MIN }],
      ["snoozed", "Bia", { until, previous: until - 50 * MIN }],
      ["unsnoozed", null, { reason: "time", until }],
      ["status", null, { from: "waiting", to: "open" }],
    ]);
  });

  test("an answer wakes it at once; null wakes it by hand; the job then does nothing; deleting cancels it", async () => {
    const h = inboxHarness(noLimit);
    const r = h.ingest({ messageId: "q1@user.test" });
    h.mutate("@email/lib:snooze", { threadId: r.threadId, until: h.now() + 60 * MIN });
    h.advance(MIN);
    h.ingest({ inReplyTo: "q1@user.test", subject: "Re: Order 42 is late" });
    expect(list(h)).toEqual([r.threadId]);
    expect(h.jobs().filter((j) => j.fn === "@email/lib:wake")).toEqual([]);
    expect(kinds(h, r.threadId).map((e: any) => e[0])).toEqual(["snoozed", "unsnoozed"]);
    expect(kinds(h, r.threadId)[1][2]).toMatchObject({ reason: "inbound" });

    h.mutate("@email/lib:snooze", { threadId: r.threadId, until: h.now() + 60 * MIN });
    h.mutate("@email/lib:snooze", { threadId: r.threadId, until: null, author: "Bia" });
    h.mutate("@email/lib:snooze", { threadId: r.threadId, until: null }); // not snoozed: nothing
    expect(kinds(h, r.threadId).map((e: any) => [e[0], e[1]]).slice(-2)).toEqual([
      ["snoozed", null],
      ["unsnoozed", "Bia"],
    ]);
    const before = h.query("@email/lib:thread", { threadId: r.threadId }).thread.lastMessageAt;
    h.advance(61 * MIN);
    await h.tick();
    expect(h.query("@email/lib:thread", { threadId: r.threadId }).thread.lastMessageAt).toBe(before);

    // A stray wake-up (re-snoozed later) does nothing.
    h.mutate("@email/lib:snooze", { threadId: r.threadId, until: h.now() + 60 * MIN });
    expect(h.mutate("@email/lib:wake", { threadId: r.threadId })).toBe(false);
    h.mutate("@email/lib:deleteThread", { threadId: r.threadId });
    expect(h.jobs().filter((j) => j.fn === "@email/lib:wake")).toEqual([]);
  });

  test("lib:maintain wakes a snooze whose wake-up never ran", () => {
    const h = inboxHarness(noLimit);
    const r = h.ingest({});
    h.mutate("@email/lib:snooze", { threadId: r.threadId, until: h.now() + MIN });
    h.advance(3 * MIN); // the job is never run here
    expect(h.mutate("@email/lib:maintain", {})).toEqual({ filled: 0, more: false, woken: 1 });
    expect(list(h)).toEqual([r.threadId]);
  });
});

describe("scheduled sends", () => {
  test("compose and reply with sendAt: listed, marked on the message, sent on time; cancelScheduled removes the message", async () => {
    const h = inboxHarness(noLimit);
    await h.tick();
    const at = h.now() + 30 * MIN;
    const c = h.mutate("@email/lib:compose", { mailbox: "support", to: ["caio@user.test"], subject: "Later", text: "First", sendAt: at, author: "Bia" });
    expect(c.status).toBe("scheduled");
    h.advance(1);
    const r1 = h.mutate("@email/lib:reply", { threadId: c.threadId, text: "Second", sendAt: at + MIN, author: "Bia" });
    h.advance(1);
    const r2 = h.mutate("@email/lib:reply", { threadId: c.threadId, text: "Third", sendAt: at + 2 * MIN, author: "Caio" });
    const sched = h.query("@email/lib:scheduled", { threadId: c.threadId });
    expect(sched.map((x: any) => [x.emailId, x.sendAt, x.author])).toEqual([
      [c.emailId, at, "Bia"],
      [r1.emailId, at + MIN, "Bia"],
      [r2.emailId, at + 2 * MIN, "Caio"],
    ]);
    expect(sched[0]).toMatchObject({ subject: "Later", to: [{ email: "caio@user.test" }], messageId: c.messageId, snippet: "First" });
    const msgs = () => h.query("@email/lib:thread", { threadId: c.threadId }).messages;
    expect(msgs().map((m: any) => m.scheduledFor)).toEqual([at, at + MIN, at + 2 * MIN]);

    // Cancel the last one: its message goes, the thread's summary comes from what is left.
    expect(h.mutate("@email/lib:cancelScheduled", { emailId: r2.emailId, author: "Caio" })).toEqual({ ok: true, status: "canceled", messageId: r2.messageId });
    expect(h.get(r2.emailId).status).toBe("canceled");
    expect(msgs().map((m: any) => m.text)).toEqual(["First", "Second"]);
    const t = h.query("@email/lib:thread", { threadId: c.threadId }).thread;
    expect(t).toMatchObject({ messageCount: 2, snippet: "Second", lastMessageAt: msgs()[1].at });
    expect(h.query("@email/lib:scheduled", { threadId: c.threadId })).toHaveLength(2);

    // On time they go; the marker goes with them.
    h.advance(31 * MIN);
    await h.tick();
    expect(h.get(c.emailId).status).toBe("sent");
    expect(h.get(r1.emailId).status).toBe("sent");
    expect(msgs().map((m: any) => m.scheduledFor)).toEqual([undefined, undefined]);
    expect(h.query("@email/lib:scheduled", { threadId: c.threadId })).toEqual([]);
    expect(h.mutate("@email/lib:cancelScheduled", { emailId: c.emailId })).toEqual({ ok: false, status: "sent" });
    expect(() => h.mutate("@email/lib:cancelScheduled", { emailId: "nope" })).toThrow(/not found/);
    expect(h.sent.map((m: any) => m.text?.split("\n")[0])).toEqual(["First", "Second"]);

    const log = kinds(h, c.threadId).filter((e: any) => e[0].startsWith("scheduled"));
    expect(log).toEqual([
      ["scheduled", "Bia", { emailId: c.emailId, messageId: c.messageId, sendAt: at }],
      ["scheduled", "Bia", { emailId: r1.emailId, messageId: r1.messageId, sendAt: at + MIN }],
      ["scheduled", "Caio", { emailId: r2.emailId, messageId: r2.messageId, sendAt: at + 2 * MIN }],
      ["scheduled_canceled", "Caio", { emailId: r2.emailId, messageId: r2.messageId }],
    ]);
  });

  test("canceling an unsent reply gives the turn back to the team: waiting goes back to open", () => {
    const h = inboxHarness(noLimit);
    const t = h.ingest({}).threadId;
    const r = h.mutate("@email/lib:reply", { threadId: t, text: "Later", sendAt: h.now() + 30 * MIN });
    expect(h.query("@email/lib:thread", { threadId: t }).thread.status).toBe("waiting");
    expect(h.mutate("@email/lib:cancelScheduled", { emailId: r.emailId, author: "Bia" })).toMatchObject({ ok: true, status: "canceled" });
    expect(h.query("@email/lib:thread", { threadId: t }).thread.status).toBe("open");

    // Set to waiting by hand before the reply: the cancel leaves it as the person set it.
    h.advance(1);
    h.mutate("@email/lib:setStatus", { threadId: t, status: "waiting" });
    h.advance(1);
    const r2 = h.mutate("@email/lib:reply", { threadId: t, text: "Later again", sendAt: h.now() + 30 * MIN });
    expect(h.mutate("@email/lib:cancelScheduled", { emailId: r2.emailId })).toMatchObject({ ok: true });
    expect(h.query("@email/lib:thread", { threadId: t }).thread.status).toBe("waiting");

    // Two unsent replies: canceling the first leaves the second, so the thread stays waiting.
    const t2 = h.ingest({ subject: "Other", from: { email: "zeca@user.test" }, envelopeFrom: "zeca@user.test" }).threadId;
    h.advance(1);
    const a1 = h.mutate("@email/lib:reply", { threadId: t2, text: "One", sendAt: h.now() + 30 * MIN });
    h.advance(1);
    h.mutate("@email/lib:reply", { threadId: t2, text: "Two", sendAt: h.now() + 30 * MIN });
    expect(h.mutate("@email/lib:cancelScheduled", { emailId: a1.emailId })).toMatchObject({ ok: true });
    expect(h.query("@email/lib:thread", { threadId: t2 }).thread.status).toBe("waiting");
  });

  test("a queued email already tried (back from a transient failure) is not canceled", async () => {
    const h = inboxHarness(noLimit);
    fakeTransport(() => new TransportError("busy", "E_RATE_LIMIT_EXCEEDED", false));
    const t = h.ingest({}).threadId;
    const r = h.mutate("@email/lib:reply", { threadId: t, text: "Now" });
    await h.tick();
    expect(h.get(r.emailId)).toMatchObject({ status: "queued", attempts: 1 });
    expect(h.mutate("@email/lib:cancelScheduled", { emailId: r.emailId })).toEqual({ ok: false, status: "queued" });
    expect(h.query("@email/lib:thread", { threadId: t }).messages.map((m: any) => m.text)).toContain("Now");
  });

  test("canceling a composed conversation's only email deletes the conversation; lib:cancel clears the marker", () => {
    const h = inboxHarness(noLimit);
    const c = h.mutate("@email/lib:compose", { mailbox: "support", to: ["dora@user.test"], subject: "Soon", text: "x", sendAt: h.now() + MIN });
    expect(h.mutate("@email/lib:cancelScheduled", { emailId: c.emailId })).toEqual({ ok: true, status: "canceled", messageId: c.messageId, threadDeleted: true });
    expect(h.query("@email/lib:thread", { threadId: c.threadId })).toBeNull();
    expect(h.query("@email/lib:counts", { mailbox: "support" }).all.threads).toBe(0);
    const d = h.mutate("@email/lib:compose", { mailbox: "support", to: ["eva@user.test"], subject: "Soon", text: "y", sendAt: h.now() + MIN });
    h.mutate("@email/lib:cancel", { id: d.emailId });
    expect(h.query("@email/lib:thread", { threadId: d.threadId }).messages[0].scheduledFor).toBeUndefined();
  });
});

describe("presence", () => {
  test("viewing and replying rows expire by a job; heartbeats keep them; null leaves; deleting the thread clears them", async () => {
    const h = inboxHarness(noLimit);
    const t = h.ingest({}).threadId;
    const who = () => h.query("@email/lib:presence", { threadId: t });
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "u1", name: "Bia", state: "viewing" });
    h.advance(1000);
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "u2", name: "Caio", state: "replying" });
    expect(who()).toEqual([
      { userId: "u1", name: "Bia", state: "viewing", since: h.now() - 1000 },
      { userId: "u2", name: "Caio", state: "replying", since: h.now() },
    ]);
    // A heartbeat early in the TTL writes nothing.
    const r = h.engine.runMutation("@email/lib:setPresence", { threadId: t, userId: "u2", name: "Caio", state: "replying" });
    expect(r.scheduled).toEqual([]);
    // Heartbeats every 10 s keep u2; u1 stops and is gone 30 s after its last one.
    for (let i = 0; i < 4; i++) {
      h.advance(10_000);
      h.mutate("@email/lib:setPresence", { threadId: t, userId: "u2", name: "Caio", state: "replying" });
      await h.tick();
    }
    expect(who().map((p: any) => p.userId)).toEqual(["u2"]);
    // Switching state resets `since`.
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "u2", name: "Caio", state: "viewing" });
    expect(who()).toEqual([{ userId: "u2", name: "Caio", state: "viewing", since: h.now() }]);
    // A shorter TTL than before still expires on time, even sent early in the current TTL with nothing else changed.
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "u2", name: "Caio", state: "viewing", ttlMs: 5_000 });
    h.advance(5_000);
    await h.tick();
    expect(who()).toEqual([]);
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "u2", name: "Caio", state: "viewing" });
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "u2", name: "Caio", state: "replying", ttlMs: 5_000 });
    h.advance(5_000);
    await h.tick();
    expect(who()).toEqual([]);

    h.mutate("@email/lib:setPresence", { threadId: t, userId: "u1", name: "Bia", state: "viewing" });
    h.mutate("@email/lib:setPresence", { threadId: t, userId: "u1", name: "Bia", state: null });
    expect(who()).toEqual([]);
    expect(h.jobs().filter((j) => j.fn === "@email/lib:expirePresence")).toEqual([]);

    h.mutate("@email/lib:setPresence", { threadId: t, userId: "u1", name: "Bia", state: "viewing" });
    h.mutate("@email/lib:deleteThread", { threadId: t });
    expect(who()).toEqual([]);
    await h.tick();
    h.advance(60_000);
    await h.tick();
    expect(() => h.mutate("@email/lib:setPresence", { threadId: t, userId: "u1", name: "Bia", state: "viewing" })).toThrow(/thread not found/);
  });
});
