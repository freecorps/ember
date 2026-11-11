// The email component on the real engine (node:sqlite), with a fake transport: send atomic with the caller,
// idempotency, suppressions, rate limit, scheduled sends, delivery retries, header fallback, events (dedup, out of
// order, before finish, bounces → suppression), inbound threading, spam, auto-replies, hooks, inbox queries.
import { createFunctionHandle } from "@freecorps/ember-server";
import { TransportError } from "../src/index.ts";
import { describe, expect, test } from "vitest";
import { event, fakeTransport, harness, inbound, inboxHarness, probe } from "./harness.ts";

describe("sending", () => {
  test("send is atomic with the calling mutation; delivery goes through the transport", async () => {
    const h = harness();
    const sent = fakeTransport();
    expect(() => h.mutate("app:signup", { email: "ana@user.test", fail: true })).toThrow("rollback");
    expect(h.query("app:users")).toBe(0);
    expect(h.query("@email/lib:list", {}).page).toEqual([]);
    expect(h.jobs()).toEqual([]);

    const r = h.mutate("app:signup", { email: "ana@user.test" });
    expect(r).toMatchObject({ status: "queued" });
    await h.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: { email: "hello@acme.test", name: "Acme" }, to: [{ email: "ana@user.test" }], subject: "Welcome", html: "<p>Hi</p>", text: "Hi", headers: { "X-Campaign": "welcome" } });
    expect(h.get(r.id)).toMatchObject({ status: "sent", messageId: "mid-1", attempts: 1 });
    expect(h.query("@email/lib:stats", {})).toEqual({ sent: 1 });
  });

  test("idempotency keys return the first email; validation errors", () => {
    const h = harness();
    fakeTransport();
    const a = h.mutate("app:signup", { email: "ana@user.test", key: "k1" });
    const b = h.mutate("app:signup", { email: "bob@user.test", key: "k1" });
    expect(b).toEqual({ id: a.id, status: "queued", duplicate: true });
    expect(() => h.mutate("@email/lib:send", { from: "x@acme.test", to: "bad", subject: "s", text: "t" })).toThrow(/Invalid email address/);
    expect(() => h.mutate("@email/lib:send", { from: "x@acme.test", to: "a@b.io", text: "t" })).toThrow(/subject is required/);
    expect(() => h.mutate("@email/lib:send", { from: "x@acme.test", to: "a@b.io", subject: "s", text: "t", headers: { Bcc: "x@y.z" } })).toThrow(/use the API field/);
    expect(() => h.mutate("@email/lib:send", { from: "x@acme.test", to: Array.from({ length: 51 }, (_, i) => `u${i}@b.io`), subject: "s", text: "t" })).toThrow(/at most 50/);
  });

  test("per-project rate limit (nested rateLimit component, same transaction)", () => {
    const h = harness();
    fakeTransport();
    for (let i = 0; i < 3; i++) h.mutate("@email/lib:send", { project: "p1", from: "x@acme.test", to: `u${i}@b.io`, subject: "s", text: "t" });
    expect(() => h.mutate("@email/lib:send", { project: "p1", from: "x@acme.test", to: "u9@b.io", subject: "s", text: "t" })).toThrow(/rate limit for project p1/);
    // Another project has its own bucket.
    expect(h.mutate("@email/lib:send", { project: "p2", from: "x@acme.test", to: "u9@b.io", subject: "s", text: "t" }).status).toBe("queued");
  });

  test("scheduled sends wait for sendAt and can be canceled", async () => {
    const h = harness();
    const sent = fakeTransport();
    const a = h.mutate("app:signup", { email: "ana@user.test", sendAt: h.now() + 60_000 });
    const b = h.mutate("app:signup", { email: "bob@user.test", sendAt: h.now() + 60_000 });
    expect(a.status).toBe("scheduled");
    await h.tick();
    expect(sent).toHaveLength(0);
    expect(h.mutate("@email/lib:cancel", { id: b.id })).toEqual({ ok: true, status: "canceled" });
    h.advance(60_000);
    await h.tick();
    expect(sent.map((m) => m.to[0]!.email)).toEqual(["ana@user.test"]);
    expect(h.get(b.id).status).toBe("canceled");
  });

  test("transient errors retry with backoff; permanent errors fail; a duplicate job does not resend", async () => {
    const h = harness({ maxAttempts: 3 });
    const sent = fakeTransport((_m, n) => (n < 2 ? new TransportError("busy", "E_RATE_LIMIT_EXCEEDED", false) : ""));
    const r = h.mutate("app:signup", { email: "ana@user.test" });
    await h.tick();
    expect(h.get(r.id)).toMatchObject({ status: "queued", attempts: 1, error: { code: "E_RATE_LIMIT_EXCEEDED" } });
    h.advance(30_000);
    await h.tick();
    h.advance(60_000);
    await h.tick();
    expect(h.get(r.id)).toMatchObject({ status: "sent", attempts: 3 });
    expect(h.get(r.id).error).toBeUndefined();
    // The same delivery job again (queues are at-least-once): claim refuses, nothing is sent.
    await h.runAction("@email/lib:deliver", { emailId: r.id });
    expect(sent).toHaveLength(3);

    const h2 = harness();
    fakeTransport(() => new TransportError("unverified", "E_SENDER_NOT_VERIFIED", true));
    const f = h2.mutate("app:signup", { email: "bob@user.test" });
    await h2.tick();
    expect(h2.get(f.id)).toMatchObject({ status: "failed", error: { code: "E_SENDER_NOT_VERIFIED" } });
    expect(h2.mutate("@email/lib:retry", { id: f.id })).toEqual({ ok: true, status: "queued" });
  });

  test("headers Email Service refuses are dropped (threading and X- kept first)", async () => {
    const h = harness();
    const sent = fakeTransport((m) => (m.headers?.["Auto-Submitted"] ? new TransportError("no", "E_HEADER_NOT_ALLOWED", true) : ""));
    const r = h.mutate("@email/lib:send", { from: "x@acme.test", to: "a@b.io", subject: "s", text: "t", headers: { "Auto-Submitted": "auto-replied", "In-Reply-To": "<a@b>", "X-Tag": "1" } });
    await h.tick();
    expect(sent[1]!.headers).toEqual({ "In-Reply-To": "<a@b>", "X-Tag": "1" });
    expect(h.get(r.id)).toMatchObject({ status: "sent", droppedHeaders: ["Auto-Submitted"] });
  });

  test("stored templates render at delivery (layout, data, text)", async () => {
    const h = harness({ layout: { brand: "Acme" } });
    const sent = fakeTransport();
    h.mutate("@email/lib:upsertTemplate", { name: "welcome", subject: "Welcome {{name}}", html: "<p>Hello {{name}}</p>" });
    expect(() => h.mutate("@email/lib:upsertTemplate", { name: "bad", subject: "x", html: "{{#if}}" })).toThrow(/Unclosed/);
    h.mutate("@email/lib:send", { from: "x@acme.test", to: "a@b.io", template: { name: "welcome", data: { name: "<Ana>" } } });
    await h.tick();
    expect(sent[0]!.subject).toBe("Welcome <Ana>");
    expect(sent[0]!.html).toContain("Hello &lt;Ana&gt;");
    expect(sent[0]!.html).toContain(">Acme<");
    expect(sent[0]!.text).toBe("Hello <Ana>");
    expect(h.query("@email/lib:render", { name: "welcome", data: { name: "B" } }).subject).toBe("Welcome B");
    expect(() => h.mutate("@email/lib:send", { from: "x@acme.test", to: "a@b.io", template: { name: "nope" } })).toThrow(/template nope not found/);
  });

  test("the sweep cron fails sends that never finished (no blind resend)", () => {
    const h = harness();
    fakeTransport();
    const r = h.mutate("app:signup", { email: "ana@user.test" });
    h.mutate("@email/lib:claim", { emailId: r.id });
    expect(h.mutate("@email/lib:sweep", {})).toBe(0);
    h.advance(11 * 60_000);
    expect(h.mutate("@email/lib:sweep", {})).toBe(1);
    expect(h.get(r.id)).toMatchObject({ status: "failed", error: { code: "E_DELIVERY_UNKNOWN" } });
  });
});

describe("delivery events", () => {
  test("delivered; duplicates ignored; a late deferred does not go back; hooks run", async () => {
    const h = harness();
    fakeTransport();
    const r = h.mutate("app:signup", { email: "ana@user.test" });
    await h.tick();
    const out = h.mutate("@email/lib:applyEvents", { events: [event("delivered", "mid-1"), event("delivered", "mid-1"), event("deferred", "mid-1")] });
    expect(out).toEqual([{ status: "delivered" }, { duplicate: true }, { status: "delivered" }]);
    expect(h.get(r.id).status).toBe("delivered");
    expect(h.query("@email/lib:events", { id: r.id }).map((e: any) => [e.type, e.duplicates ?? 0])).toEqual([["delivered", 1], ["deferred", 0]]);
    expect(h.query("app:seen", { kind: "event" }).map((e: any) => e.type)).toEqual(["delivered", "deferred"]);
  });

  test("hard bounces and complaints suppress the recipient for the project; soft bounces do not", async () => {
    const h = harness();
    fakeTransport();
    h.mutate("app:signup", { email: "ana@user.test" });
    h.mutate("@email/lib:send", { from: "x@acme.test", to: "soft@user.test", subject: "s", text: "t" });
    await h.tick();
    h.mutate("@email/lib:applyEvents", { events: [event("bounced", "mid-1", { bounceType: "hard" }), event("bounced", "mid-2", { bounceType: "soft", recipient: "soft@user.test" })] });
    expect(h.query("@email/lib:suppressions", {}).page.map((s: any) => [s.email, s.reason])).toEqual([["ana@user.test", "hard_bounce"]]);
    // The next email to her is not sent (and not rate limited).
    const again = h.mutate("app:signup", { email: "ana@user.test" });
    expect(again).toMatchObject({ status: "suppressed", suppressed: ["ana@user.test"] });
    expect(h.mutate("@email/lib:unsuppress", { email: "ana@user.test" })).toBe(true);
  });

  test("suppressed To recipients are never sent to, even when every To is suppressed and Cc/Bcc remain", async () => {
    const h = harness();
    const sent = fakeTransport();
    h.mutate("@email/lib:suppress", { email: "gone@user.test" });
    // Every To suppressed, Cc left: the Cc become the To; the suppressed address is nowhere in the message.
    const a = h.mutate("@email/lib:send", { from: "x@acme.test", to: "gone@user.test", cc: "cc@user.test", bcc: "bcc@user.test", subject: "s", text: "t" });
    expect(a).toMatchObject({ status: "queued", suppressed: ["gone@user.test"] });
    // Only Bcc left: never promoted (that would expose them), so nothing is sent.
    const b = h.mutate("@email/lib:send", { from: "x@acme.test", to: "gone@user.test", bcc: "bcc@user.test", subject: "s", text: "t" });
    expect(b).toMatchObject({ status: "suppressed", suppressed: ["gone@user.test"] });
    await h.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: [{ email: "cc@user.test" }], bcc: [{ email: "bcc@user.test" }] });
    expect(sent[0]!.cc).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("gone@user.test");
    expect(JSON.stringify(h.get(a.id).to)).not.toContain("gone@user.test");
    expect(h.get(b.id).to).toEqual([]);
  });

  test("an address suppressed while the email waits (scheduled or in backoff) is not sent to", async () => {
    const h = harness();
    const sent = fakeTransport();
    const at = h.now() + 60_000;
    const a = h.mutate("@email/lib:send", { from: "x@acme.test", to: "ana@user.test", cc: "bob@user.test", subject: "s", text: "t", sendAt: at });
    const b = h.mutate("@email/lib:send", { from: "x@acme.test", to: "ana@user.test", bcc: "carl@user.test", subject: "s", text: "t", sendAt: at });
    expect([a.status, b.status]).toEqual(["scheduled", "scheduled"]);
    h.mutate("@email/lib:suppress", { email: "ana@user.test" }); // e.g. a hard bounce of an earlier email
    h.advance(60_000);
    await h.tick();
    // a: the Cc becomes the To; b: only Bcc left, so nothing is sent.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: [{ email: "bob@user.test" }] });
    expect(JSON.stringify(sent)).not.toContain("ana@user.test");
    expect(h.get(a.id)).toMatchObject({ status: "sent", suppressed: ["ana@user.test"] });
    expect(h.get(b.id)).toMatchObject({ status: "suppressed", suppressed: ["ana@user.test"], to: [] });
  });

  test("an event that arrives before the send is recorded is applied when it is", async () => {
    const h = harness();
    fakeTransport();
    h.mutate("@email/lib:applyEvents", { events: [event("delivered", "mid-1")] });
    const r = h.mutate("app:signup", { email: "ana@user.test" });
    await h.tick();
    expect(h.get(r.id).status).toBe("delivered");
  });

  test("a hard bounce or complaint that arrives before the send is recorded still suppresses the recipient", async () => {
    const h = harness();
    fakeTransport();
    h.mutate("@email/lib:applyEvents", {
      events: [event("bounced", "mid-1", { bounceType: "hard" }), event("complained", "mid-2", { recipient: "bob@user.test" }), event("bounced", "mid-3", { bounceType: "soft", recipient: "soft@user.test" })],
    });
    const a = h.mutate("app:signup", { email: "ana@user.test" });
    const b = h.mutate("app:signup", { email: "bob@user.test" });
    h.mutate("app:signup", { email: "soft@user.test" });
    await h.tick();
    expect(h.get(a.id).status).toBe("bounced");
    expect(h.get(b.id).status).toBe("complained");
    expect(h.query("@email/lib:suppressions", {}).page.map((s: any) => [s.email, s.reason]).sort()).toEqual([
      ["ana@user.test", "hard_bounce"],
      ["bob@user.test", "complaint"],
    ]);
    // The app's onEvent hook sees the raced events too.
    expect(h.query("app:seen", { kind: "event" }).map((e: any) => e.type)).toEqual(["bounced", "complained", "bounced"]);
    expect(h.mutate("app:signup", { email: "ana@user.test" })).toMatchObject({ status: "suppressed" });
  });
});

// ------------------------------------------------------------------ inbound

describe("inbound mail", () => {
  test("retention: closed and spam conversations past their mailbox's days are deleted with their messages; others stay", () => {
    const DAY = 86_400_000;
    const h = inboxHarness();
    h.mutate("@email/lib:upsertMailbox", { name: "support", address: "support@acme.test", retention: { closedDays: 30, spamDays: 7 } });
    expect(() => h.mutate("@email/lib:upsertMailbox", { name: "privacy", address: "privacy@acme.test", retention: { closedDays: 0 } })).toThrow(/whole number of days/);
    expect(() => h.mutate("@email/lib:upsertMailbox", { name: "privacy", address: "privacy@acme.test", retention: { spamDays: 1.5 } })).toThrow(/whole number of days/);
    const closed = h.ingest({ subject: "Closed one" });
    h.ingest({ subject: "Closed one", messageId: "c2@user.test" });
    const open = h.ingest({ subject: "Still open", from: { email: "bob@user.test" } });
    const spam = h.ingest({ subject: "Spam one", from: { email: "eve@user.test" } });
    const other = h.mutate("@email/lib:ingest", { message: inbound({ mailbox: "privacy", to: [{ email: "privacy@acme.test" }], subject: "No policy" }) });
    h.mutate("@email/lib:setStatus", { threadId: closed.threadId, status: "closed" });
    h.mutate("@email/lib:setStatus", { threadId: spam.threadId, status: "spam" });
    h.mutate("@email/lib:setStatus", { threadId: other.threadId, status: "closed" });

    // Upserting without `retention` keeps it.
    h.mutate("@email/lib:upsertMailbox", { name: "support", address: "support@acme.test", displayName: "Acme Support" });
    expect(h.query("@email/lib:mailboxes", {}).find((m: any) => m.name === "support").retention).toEqual({ closedDays: 30, spamDays: 7 });

    h.advance(8 * DAY);
    expect(h.mutate("@email/lib:purge", {})).toEqual({ threads: 1, messages: 1, more: false });
    expect(h.query("@email/lib:thread", { threadId: spam.threadId })).toBeNull();

    // The clock runs from the status change too: written on day 8 but closed on day 38, it goes on day 68 (30 days after closing).
    const late = h.ingest({ subject: "Closed late", from: { email: "zoe@user.test" } });
    h.advance(30 * DAY);
    h.mutate("@email/lib:setStatus", { threadId: late.threadId, status: "closed" });
    h.advance(1 * DAY); // day 39: the first closed one (day 0) is past 30 days, the late one is not
    expect(h.mutate("@email/lib:purge", {})).toEqual({ threads: 1, messages: 2, more: false });
    expect(h.query("@email/lib:thread", { threadId: closed.threadId })).toBeNull();
    expect(h.query("@email/lib:thread", { threadId: late.threadId })).not.toBeNull();
    expect(h.query("@email/lib:thread", { threadId: open.threadId })).not.toBeNull();
    expect(h.query("@email/lib:thread", { threadId: other.threadId })).not.toBeNull();
    h.advance(28 * DAY); // day 67
    expect(h.mutate("@email/lib:purge", {})).toMatchObject({ threads: 0 });
    h.advance(1 * DAY); // day 68: 30 days since it was closed
    expect(h.mutate("@email/lib:purge", {})).toMatchObject({ threads: 1 });
    expect(h.query("@email/lib:thread", { threadId: late.threadId })).toBeNull();

    // More than one pass holds: it deletes a scan's worth, says there is more, and schedules itself.
    const many = Array.from({ length: 201 }, (_, i) => h.ingest({ subject: `Bulk ${i}`, from: { email: `bulk${i}@user.test` } }));
    for (const r of many) h.mutate("@email/lib:setStatus", { threadId: r.threadId, status: "closed" });
    h.advance(31 * DAY);
    expect(h.mutate("@email/lib:purge", {})).toEqual({ threads: 200, messages: 200, more: true });
    expect(h.mutate("@email/lib:purge", {})).toEqual({ threads: 1, messages: 1, more: false });

    // null clears the policy: nothing more is deleted.
    h.mutate("@email/lib:upsertMailbox", { name: "support", address: "support@acme.test", retention: null });
    h.mutate("@email/lib:setStatus", { threadId: open.threadId, status: "closed" });
    h.advance(400 * DAY);
    expect(h.mutate("@email/lib:purge", {})).toEqual({ threads: 0, messages: 0, more: false });
    expect(h.query("@email/lib:unread", {})).toMatchObject({ support: { threads: 1 } });
  });

  test("deleteThread: the thread and its messages go now, a long thread's messages in batches; counts follow", async () => {
    const h = inboxHarness();
    const keep = h.ingest({ subject: "Keep me", from: { email: "keep@user.test" }, text: "keepword" });
    const gone = h.ingest({ subject: "Delete me", text: "zapword" });
    for (let i = 0; i < 501; i++) h.mutate("@email/lib:note", { threadId: gone.threadId, text: `zapword note ${i}` });
    expect(h.query("@email/lib:unread", {})).toMatchObject({ support: { threads: 2 } });
    // A reply scheduled for later, one queued now, and the thread's auto-reply (still queued, no tick yet): none goes
    // once the thread is deleted.
    h.advance(60_000); // past the harness's send rate limit (the auto-replies used it)
    const later = h.mutate("@email/lib:reply", { threadId: gone.threadId, text: "later", sendAt: Date.UTC(2100, 0, 1) });
    const now = h.mutate("@email/lib:reply", { threadId: gone.threadId, text: "now" });
    expect(h.mutate("@email/lib:deleteThread", { threadId: gone.threadId })).toEqual({ deleted: true, mailbox: "support", canceled: 3 });
    expect(h.get(later.emailId).status).toBe("canceled");
    expect(h.get(now.emailId).status).toBe("canceled");
    expect(h.query("@email/lib:thread", { threadId: gone.threadId })).toBeNull();
    expect(h.query("@email/lib:unread", {})).toMatchObject({ support: { threads: 1 } });
    // 502 messages: 500 went with the thread, the rest in the job it scheduled; search never lists those left over
    // (their thread is gone).
    expect(h.query("@email/lib:search", { query: "zapword" })).toEqual([]);
    expect(h.jobs().filter((j: any) => String(j.fn).includes("dropMessages"))).toHaveLength(1);
    await h.tick();
    expect(h.jobs().filter((j: any) => String(j.fn).includes("dropMessages"))).toHaveLength(0);
    // Only the other thread's auto-reply went out.
    expect(h.sent.filter((m: any) => m.subject.includes("Delete me"))).toEqual([]);
    expect(h.sent.filter((m: any) => m.subject.includes("Keep me"))).toHaveLength(1);
    expect(h.query("@email/lib:search", { query: "zapword" })).toEqual([]);
    expect(h.query("@email/lib:search", { query: "keepword" })).toHaveLength(1);
    expect(h.query("@email/lib:thread", { threadId: keep.threadId })).not.toBeNull();
    expect(h.mutate("@email/lib:deleteThread", { threadId: gone.threadId })).toEqual({ deleted: false });
    expect(h.mutate("@email/lib:deleteThread", { threadId: "nope" })).toEqual({ deleted: false });
  });

  test("routing: mailbox addresses and plus-addressed tokens", () => {
    const h = inboxHarness();
    expect(h.query("@email/lib:route", { to: "SUPPORT@acme.test" })).toEqual({ mailbox: "support", tag: null });
    expect(h.query("@email/lib:route", { to: "support+t_abc@acme.test" })).toEqual({ mailbox: "support", tag: "t_abc" });
    expect(h.query("@email/lib:route", { to: "sales@acme.test" })).toBeNull();
    expect(() => h.mutate("@email/lib:upsertMailbox", { name: "dup", address: "support@acme.test" })).toThrow(/already belongs/);
  });

  test("catch-all: a domain's catch-all mailbox takes its addresses no mailbox has; one per domain; absent keeps, false clears", () => {
    const h = inboxHarness();
    h.mutate("@email/lib:upsertMailbox", { name: "geral", address: "geral@acme.test", catchAll: true });
    expect(h.query("@email/lib:route", { to: "sales@acme.test" })).toEqual({ mailbox: "geral", tag: null });
    expect(h.query("@email/lib:route", { to: "Postmaster+x@ACME.test" })).toEqual({ mailbox: "geral", tag: null });
    // An address a mailbox has still goes to it; another domain has no catch-all.
    expect(h.query("@email/lib:route", { to: "support+t_abc@acme.test" })).toEqual({ mailbox: "support", tag: "t_abc" });
    expect(h.query("@email/lib:route", { to: "sales@else.test" })).toBeNull();
    expect(() => h.mutate("@email/lib:upsertMailbox", { name: "privacy", address: "privacy@acme.test", catchAll: true })).toThrow(/already has a catch-all: mailbox geral/);
    h.mutate("@email/lib:upsertMailbox", { name: "geral", address: "geral@acme.test", displayName: "Geral" });
    expect(h.query("@email/lib:route", { to: "sales@acme.test" })).toEqual({ mailbox: "geral", tag: null });
    h.mutate("@email/lib:upsertMailbox", { name: "geral", address: "geral@acme.test", catchAll: false });
    expect(h.query("@email/lib:route", { to: "sales@acme.test" })).toBeNull();
    expect(h.query("@email/lib:mailboxes", {}).find((m: any) => m.name === "geral").catchAll).toBeUndefined();
  });

  test("upsertMailbox has patch semantics: absent fields keep their stored value, null clears", () => {
    const h = inboxHarness();
    const box = () => h.query("@email/lib:mailboxes", {}).find((m: any) => m.name === "support");
    h.mutate("@email/lib:upsertMailbox", { name: "support", address: "support@acme.test" });
    expect(box()).toMatchObject({ displayName: "Acme Support", autoReply: { subject: "Re: {{subject}} [#{{number}}]" } });
    h.mutate("@email/lib:upsertMailbox", { name: "support", address: "help@acme.test", autoReply: null });
    expect(box()).toMatchObject({ address: "help@acme.test", displayName: "Acme Support" });
    expect(box().autoReply).toBeUndefined();
    h.mutate("@email/lib:upsertMailbox", { name: "support", address: "help@acme.test", displayName: null });
    expect(box().displayName).toBeUndefined();
  });

  test("a new conversation: ticket number, unread, auto-reply (threaded, no Reply-To), onInbound hook", async () => {
    const h = inboxHarness();
    const r = h.ingest({ messageId: "first@user.test" });
    expect(r).toMatchObject({ mailbox: "support", number: 1, newThread: true, status: "open" });
    expect(h.query("app:seen", { kind: "inbound" })).toMatchObject([{ number: 1, newThread: true, snippet: "Where is my order?" }]);
    await h.tick();
    expect(h.sent).toHaveLength(1);
    const thread = h.query("@email/lib:thread", { threadId: r.threadId }).thread;
    expect(h.sent[0]).toMatchObject({
      from: { email: "support@acme.test", name: "Acme Support" },
      to: [{ email: "ana@user.test" }],
      subject: "Re: Order 42 is late [#1]",
      text: "Hi Ana, we got your message (#1).",
      headers: { "Auto-Submitted": "auto-replied", "In-Reply-To": "<first@user.test>", References: "<first@user.test>" },
    });
    expect(h.sent[0]!.replyTo).toBeUndefined();
    expect(thread.token).toBeTruthy();
    expect(h.query("@email/lib:unread", {})).toEqual({ support: { unread: 1, threads: 1 }, privacy: { unread: 0, threads: 0 } });
    // The same message again (redelivery): nothing new.
    expect(h.ingest({ messageId: "first@user.test" })).toMatchObject({ duplicate: true });
  });

  test("replyToken: true puts the thread token in the Reply-To of replies, composes and auto-replies", async () => {
    const h = inboxHarness({ replyToken: true });
    const r = h.ingest({ messageId: "tok@user.test" });
    await h.tick();
    const token = h.query("@email/lib:thread", { threadId: r.threadId }).thread.token;
    expect(h.sent[0]).toMatchObject({ replyTo: { email: `support+t_${token}@acme.test` } });
    h.mutate("@email/lib:reply", { threadId: r.threadId, text: "On it." });
    await h.tick();
    expect(h.sent[h.sent.length - 1]).toMatchObject({ replyTo: { email: `support+t_${token}@acme.test` } });
  });

  test("threading: token from any sender; references only with DMARC pass from the contact; subject window", () => {
    const h = inboxHarness();
    const first = h.ingest({ messageId: "a1@user.test" });
    const token = h.query("@email/lib:thread", { threadId: first.threadId }).thread.token;
    // (1) token, from someone else
    expect(h.ingest({ tag: `t_${token}`, from: { email: "boss@user.test" }, subject: "fwd" }).threadId).toBe(first.threadId);
    // (2) In-Reply-To with dmarc pass from the contact
    expect(h.ingest({ inReplyTo: "a1@user.test", subject: "something else" }).threadId).toBe(first.threadId);
    // ...but not from a stranger, nor without DMARC
    expect(h.ingest({ inReplyTo: "a1@user.test", subject: "x1", from: { email: "eve@evil.test" } }).threadId).not.toBe(first.threadId);
    expect(h.ingest({ inReplyTo: "a1@user.test", subject: "x2", auth: { spf: "fail", dkim: "fail", dmarc: "fail" } }).threadId).not.toBe(first.threadId);
    // (3) same contact + subject ("Re:" stripped)
    expect(h.ingest({ subject: "RE: Order 42 is late" }).threadId).toBe(first.threadId);
    h.mutate("@email/lib:setStatus", { threadId: first.threadId, status: "closed" });
    expect(h.ingest({ subject: "Re: Order 42 is late" }).threadId).not.toBe(first.threadId);
  });

  test("threading: a reference to another contact's message does not stop the search of older references", () => {
    const h = inboxHarness();
    const mine = h.ingest({ messageId: "ana-1@user.test", subject: "Refund" });
    const other = h.ingest({ messageId: "bob-1@user.test", from: { email: "bob@user.test" }, subject: "Shipping" });
    // In-Reply-To points at Bob's thread (Ana was CC'd there); References still carry Ana's own thread.
    const r = h.ingest({ inReplyTo: "bob-1@user.test", references: ["ana-1@user.test", "bob-1@user.test"], subject: "something new" });
    expect(r.threadId).toBe(mine.threadId);
    expect(r.threadId).not.toBe(other.threadId);
  });

  test("no auto-reply to automated mail or no-reply senders; spam after N messages per hour", async () => {
    const h = inboxHarness({ spamPerHour: 3 });
    h.ingest({ autoSubmitted: true, subject: "out of office" });
    h.ingest({ from: { email: "no-reply@shop.test" }, subject: "receipt" });
    await h.tick();
    expect(h.sent).toHaveLength(0);
    const flood = [1, 2, 3, 4].map((i) => h.ingest({ from: { email: "spam@bad.test" }, subject: `buy ${i}` }));
    expect(flood.map((r) => r.status)).toEqual(["open", "open", "open", "spam"]);
  });

  test("a refused auto-reply or a throwing onInbound hook never loses the inbound message", async () => {
    const h = inboxHarness({ rateLimit: { rate: 1, period: 3_600_000 }, hooks: { onInbound: createFunctionHandle("hooks:boom") } });
    const a = h.ingest({ from: { email: "a@user.test" }, subject: "one" });
    const b = h.ingest({ from: { email: "b@user.test" }, subject: "two" }); // auto-reply refused by the rate limit
    expect(a.autoReplyId).toBeTruthy();
    expect(b.autoReplyId).toBeNull();
    expect(h.query("@email/lib:thread", { threadId: b.threadId }).messages).toHaveLength(1);
    expect(probe.boom).toBe(2); // the hook ran (and threw) for both
    expect(h.query("app:seen", { kind: "boom" })).toEqual([]); // its writes were undone
  });

  test("inbox: the auto-reply and the reply cite Message-IDs as the sender wrote them", async () => {
    // Gmail ids are mixed case and Gmail threads only on an exact match; lookups stay lowercased.
    const h = inboxHarness();
    const id = "CA+ae4=BmfLy@mail.gmail.com";
    const root = "Root-1@Mail.Gmail.com";
    const r = h.ingest({ messageId: id.toLowerCase(), messageIdRaw: id, references: [root.toLowerCase()], referencesRaw: [root] });
    await h.tick();
    expect(h.sent[0]!.headers).toMatchObject({ "In-Reply-To": `<${id}>`, References: `<${id}>` });
    h.mutate("@email/lib:reply", { threadId: r.threadId, text: "On it." });
    await h.tick();
    expect(h.sent[h.sent.length - 1]!.headers).toEqual({ "In-Reply-To": `<${id}>`, References: `<${root}> <${id}>` });
    // The answer to that reply still finds the thread (lookups are case-insensitive).
    expect(h.ingest({ messageId: "n2@user.test", inReplyTo: id.toLowerCase(), subject: "other" }).threadId).toBe(r.threadId);
    // A raw id that is not the same id as the lookup one is ignored.
    const odd = h.ingest({ from: { email: "bob@user.test" }, messageId: "x1@user.test", messageIdRaw: "Other@user.test", subject: "odd" });
    const m = h.query("@email/lib:thread", { threadId: odd.threadId }).messages[0];
    expect(m.messageIdHeader).toBe("x1@user.test");
    expect(m).not.toHaveProperty("messageIdRaw");
  });

  test("inbox: reply (threading headers, waiting), note, mark read, search, pagination by status", async () => {
    const h = inboxHarness();
    const r = h.ingest({ messageId: "q1@user.test", references: ["root@user.test"], text: "My invoice is wrong" });
    await h.tick(); // auto-reply
    const reply = h.mutate("@email/lib:reply", { threadId: r.threadId, text: "We fixed it.", author: "agent-1" });
    await h.tick();
    const last = h.sent[h.sent.length - 1]!;
    expect(last).toMatchObject({ subject: "Re: Order 42 is late", headers: { "In-Reply-To": "<q1@user.test>", References: "<root@user.test> <q1@user.test>" } });
    expect(last.text).toContain("We fixed it.\n\n");
    expect(last.text).toContain("> My invoice is wrong");
    expect(h.get(reply.emailId).threadId).toBe(r.threadId);
    h.mutate("@email/lib:note", { threadId: r.threadId, text: "customer is VIP", author: "agent-1" });
    const t = h.query("@email/lib:thread", { threadId: r.threadId });
    expect(t.thread).toMatchObject({ status: "waiting", messageCount: 3, unreadCount: 1 });
    expect(t.messages.map((m: any) => m.direction)).toEqual(["inbound", "outbound", "note"]);
    h.mutate("@email/lib:markRead", { threadId: r.threadId });
    expect(h.query("@email/lib:unread", { mailboxes: ["support"] })).toEqual({ support: { unread: 0, threads: 1 } });
    // Hits carry the thread's state: a client acts on them (archive/reopen, read/unread) without loading the thread.
    expect(h.query("@email/lib:search", { query: "invoice", mailbox: "support" })).toMatchObject([{ threadId: r.threadId, direction: "inbound", status: "waiting", unreadCount: 0 }]);
    h.mutate("@email/lib:assign", { threadId: r.threadId, assignee: "u-bia", assigneeName: "Bia" });
    expect(h.query("@email/lib:search", { query: "invoice", mailbox: "support" })[0]).toMatchObject({ assignee: "u-bia", assigneeName: "Bia" });
    expect(h.query("@email/lib:search", { query: "invoice", mailbox: "privacy" })).toEqual([]);
    expect(h.query("@email/lib:threads", { mailbox: "support", status: "waiting" }).page).toHaveLength(1);
    expect(h.query("@email/lib:threads", { mailbox: "support", status: "open" }).page).toHaveLength(0);
    // A customer answer reopens it.
    h.ingest({ subject: "Re: Order 42 is late" });
    expect(h.query("@email/lib:thread", { threadId: r.threadId }).thread.status).toBe("open");
  });

  test("inbox: the Sent view lists threads the mailbox wrote in, by its latest send, once each, in pages", async () => {
    const h = inboxHarness();
    const a = h.ingest({ messageId: "s1@user.test", subject: "First" });
    h.advance(60_000);
    const b = h.ingest({ messageId: "s2@user.test", from: { email: "bia@user.test", name: "Bia" }, subject: "Second" });
    h.advance(60_000);
    // Received only, and a note: neither is sent mail.
    h.ingest({ messageId: "s3@user.test", from: { email: "caio@user.test" }, subject: "Third" });
    h.mutate("@email/lib:note", { threadId: b.threadId, text: "internal" });
    expect(h.query("@email/lib:sent", { mailbox: "support" })).toEqual({ page: [], next: null });
    h.advance(60_000);
    h.mutate("@email/lib:reply", { threadId: a.threadId, text: "One." });
    h.advance(60_000);
    h.mutate("@email/lib:reply", { threadId: b.threadId, text: "Two." });
    h.advance(60_000);
    const c = h.mutate("@email/lib:compose", { mailbox: "support", to: ["dora@user.test"], subject: "New", text: "Three." });
    h.advance(60_000);
    // A second send in the first thread moves it to the top, and it is listed once.
    h.mutate("@email/lib:reply", { threadId: a.threadId, text: "Four." });
    const all = h.query("@email/lib:sent", { mailbox: "support" });
    expect(all.page.map((t: any) => t._id)).toEqual([a.threadId, c.threadId, b.threadId]);
    expect(all.next).toBeNull();
    expect(all.page[0].lastSentAt).toBe(h.now());
    // Pages of one: each thread once, at its latest send, never again on a later page.
    const seen: string[] = [];
    let before: number | undefined;
    for (let i = 0; i < 5; i++) {
      const p = h.query("@email/lib:sent", { mailbox: "support", limit: 1, ...(before !== undefined ? { before } : {}) });
      seen.push(...p.page.map((t: any) => t._id));
      if (p.next === null) break;
      before = p.next;
    }
    expect(seen).toEqual([a.threadId, c.threadId, b.threadId]);
    expect(h.query("@email/lib:sent", { mailbox: "privacy" })).toEqual({ page: [], next: null });
    expect(h.query("@email/lib:sent", { mailbox: "nope" })).toEqual({ page: [], next: null });
    expect(() => h.query("@email/lib:sent", { mailbox: "support", before: "garbage" })).toThrow(/cursor/);
  });

  test("inbox: Sent pages never drop or repeat threads whose latest sends share a millisecond", () => {
    const h = inboxHarness();
    const ids = ["x1", "x2", "x3"].map((id, i) => h.ingest({ messageId: `${id}@user.test`, from: { email: `p${i}@user.test` }, subject: `S${i}` }).threadId);
    h.advance(60_000);
    // Three sends in the same millisecond.
    for (const id of ids) h.mutate("@email/lib:reply", { threadId: id, text: "ok" });
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 6; i++) {
      const p = h.query("@email/lib:sent", { mailbox: "support", limit: 1, ...(before !== undefined ? { before } : {}) });
      seen.push(...p.page.map((t: any) => t._id));
      if (p.next === null) break;
      before = p.next;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(3);
  });

  test("inbox: mark unread, assign, compose a new conversation (threaded answers), recent threads with messages", async () => {
    const h = inboxHarness();
    const r = h.ingest({ messageId: "u1@user.test" });
    h.mutate("@email/lib:markRead", { threadId: r.threadId });
    h.mutate("@email/lib:markUnread", { threadId: r.threadId });
    expect(h.query("@email/lib:unread", { mailboxes: ["support"] })).toEqual({ support: { unread: 1, threads: 1 } });
    h.mutate("@email/lib:assign", { threadId: r.threadId, assignee: "user-1", assigneeName: "Bia" });
    expect(h.query("@email/lib:thread", { threadId: r.threadId }).thread).toMatchObject({ assignee: "user-1", assigneeName: "Bia" });
    h.mutate("@email/lib:assign", { threadId: r.threadId, assignee: null });
    expect(h.query("@email/lib:thread", { threadId: r.threadId }).thread.assignee).toBeUndefined();

    await h.tick();
    const c = h.mutate("@email/lib:compose", { mailbox: "support", to: ["Caio <caio@user.test>"], cc: ["Dora <dora@user.test>"], subject: "Your refund", text: "It is on its way.", author: "Bia" });
    expect(c).toMatchObject({ number: 2, status: "queued" });
    await h.tick();
    const t = h.query("@email/lib:thread", { threadId: c.threadId });
    expect(t.thread).toMatchObject({ number: 2, status: "waiting", contact: "caio@user.test", contactName: "Caio", messageCount: 1, unreadCount: 0 });
    // The stored message keeps who was copied, like the sent email.
    expect(t.messages).toMatchObject([{ direction: "outbound", author: "Bia", text: "It is on its way.", cc: [{ email: "dora@user.test", name: "Dora" }] }]);
    const out = h.sent[h.sent.length - 1]!;
    expect(out).toMatchObject({ subject: "Your refund", to: [{ email: "caio@user.test", name: "Caio" }], cc: [{ email: "dora@user.test", name: "Dora" }] });
    expect(out.replyTo).toBeUndefined();
    // The provider's id is the email's Message-ID: the thread's message records it (normalized, like inbound ones).
    const mid = h.get(c.emailId).messageId as string;
    expect(t.messages[0].messageIdHeader).toBe(mid.toLowerCase());
    // The customer's answer cites it (no token, a new subject, DMARC failing at a forwarder): it joins the composed
    // thread. So does the copied person's; a stranger citing it starts a new thread.
    expect(h.ingest({ from: { email: "caio@user.test" }, subject: "about that", inReplyTo: mid.toLowerCase(), auth: { spf: "fail", dkim: "fail", dmarc: "fail" } }).threadId).toBe(c.threadId);
    expect(h.ingest({ from: { email: "dora@user.test" }, subject: "me too", references: [mid.toLowerCase()] }).threadId).toBe(c.threadId);
    expect(h.ingest({ from: { email: "eve@evil.test" }, subject: "hi", inReplyTo: mid.toLowerCase() }).threadId).not.toBe(c.threadId);
    // A stranger naming the contact in a Reply-To does not pass for them, with DMARC (for the stranger's own domain)
    // or without.
    expect(h.ingest({ from: { email: "eve@evil.test" }, replyTo: { email: "caio@user.test" }, subject: "hi dmarc", inReplyTo: mid.toLowerCase() }).threadId).not.toBe(c.threadId);
    expect(h.ingest({ from: { email: "eve@evil.test" }, replyTo: { email: "caio@user.test" }, subject: "hi again", inReplyTo: mid.toLowerCase(), auth: { spf: "fail", dkim: "fail", dmarc: "fail" } }).threadId).not.toBe(c.threadId);
    expect(() => h.mutate("@email/lib:compose", { mailbox: "nope", to: ["a@b.test"], subject: "x", text: "y" })).toThrow(/not found/);
    expect(() => h.mutate("@email/lib:compose", { mailbox: "support", to: [], subject: "x", text: "y" })).toThrow(/recipient/);

    // Attachments: files already stored in the shard go with the email and stay on the thread's message.
    h.advance(60_000); // past the test's rate limit (3 a minute)
    const pdf = h.storeFile("application/pdf", 2048);
    const withFile = h.mutate("@email/lib:compose", { mailbox: "support", to: ["eva@user.test"], subject: "Contract", text: "Attached.", attachments: [{ filename: "contract.pdf", contentType: "application/pdf", file: pdf }] });
    expect(h.get(withFile.emailId).attachments).toEqual([{ filename: "contract.pdf", contentType: "application/pdf", file: pdf }]);
    const sentMsg = h.query("@email/lib:thread", { threadId: withFile.threadId }).messages[0];
    expect(sentMsg.attachments).toEqual([{ filename: "contract.pdf", contentType: "application/pdf", file: pdf, size: 2048 }]);
    h.advance(60_000);
    const png = h.storeFile("image/png", 10);
    const rep = h.mutate("@email/lib:reply", { threadId: c.threadId, text: "And the receipt.", attachments: [{ filename: "receipt.png", contentType: "image/png", file: png }] });
    expect(h.get(rep.emailId).attachments).toMatchObject([{ filename: "receipt.png", file: png }]);
    expect(h.query("@email/lib:thread", { threadId: c.threadId }).messages.find((m: any) => m._id === rep.messageId).attachments).toMatchObject([{ filename: "receipt.png", size: 10 }]);
    expect(() => h.mutate("@email/lib:compose", { mailbox: "support", to: ["eva@user.test"], subject: "x", text: "y", attachments: [{ filename: "a", contentType: "x/y", file: "not-a-file" }] })).toThrow();
    // A file sent as a link: no MIME part, but the message holds it (refcount, the thread shows it).
    h.advance(60_000);
    const big = h.storeFile("video/mp4", 300 * 1024 * 1024);
    const linked = h.mutate("@email/lib:reply", { threadId: c.threadId, text: "Video: https://mail.test/link", attachments: [{ filename: "demo.mp4", contentType: "video/mp4", file: big, link: true }] });
    expect(h.get(linked.emailId).attachments ?? []).toEqual([]);
    expect(h.query("@email/lib:thread", { threadId: c.threadId }).messages.find((m: any) => m._id === linked.messageId).attachments).toEqual([{ filename: "demo.mp4", contentType: "video/mp4", file: big, size: 300 * 1024 * 1024, link: true }]);

    const recent = h.query("@email/lib:recent", { mailboxes: ["support", "privacy"], threads: 10 });
    expect(recent.threads.map((x: any) => x.number)).toEqual([2, 6, 5, 4, 3, 1]);
    expect(recent.messages.filter((m: any) => m.threadId === c.threadId).map((m: any) => m.direction)).toEqual(["outbound", "inbound", "inbound", "outbound", "outbound"]);
  });

  test("inbox mail looks like a person wrote it: no card in replies, composes and auto-replies; API templates keep it", async () => {
    const CARD = ["border-top:4px", "background:#f4f5f7", "max-width:600px"];
    const noCard = (html: string | undefined) => {
      expect(html).toContain('<meta name="color-scheme" content="light dark">');
      for (const c of CARD) expect(html).not.toContain(c);
    };
    const h = inboxHarness({ layout: { brand: "Acme" }, rateLimit: { rate: 100, period: 60_000 } });
    h.mutate("@email/lib:upsertMailbox", { name: "privacy", address: "privacy@acme.test", autoReply: { subject: "Re: {{subject}}", text: "x", html: "<p>Got it, {{name}}. See https://acme.test/privacy</p>" } });
    const r = h.ingest({ messageId: "m1@user.test", from: { email: "marina@user.test", name: "Marina Costa" }, text: "Oi,\n\nO pedido não chegou." });
    h.mutate("@email/lib:ingest", { message: inbound({ mailbox: "privacy", to: [{ email: "privacy@acme.test" }], from: { email: "leo@user.test", name: "Leo" }, messageId: "p1@user.test" }) });
    await h.tick();
    const auto = h.sent.find((m) => m.to[0]!.email === "marina@user.test")!;
    noCard(auto.html);
    expect(auto.html).toContain('<p style="margin:0 0 12px 0">Hi Marina Costa, we got your message (#1).</p>');
    const custom = h.sent.find((m) => m.to[0]!.email === "leo@user.test")!;
    noCard(custom.html);
    expect(custom.html).toContain("<p>Got it, Leo. See https://acme.test/privacy</p>");

    // Reply: text body, signature, a localized quote header; Gmail's signature and quote blocks.
    const at = h.query("@email/lib:thread", { threadId: r.threadId }).messages[0].at;
    const rep = h.mutate("@email/lib:reply", { threadId: r.threadId, text: "Oi Marina,\n\nJá reenviamos: https://acme.test/t/1", signature: { text: "Bia\nAcme Support" }, quoteHeader: "Em 5 de nov. de 2026, Marina Costa escreveu:" });
    await h.tick();
    let out = h.sent[h.sent.length - 1]!;
    noCard(out.html);
    expect(out.text).toBe("Oi Marina,\n\nJá reenviamos: https://acme.test/t/1\n\n-- \nBia\nAcme Support\n\nEm 5 de nov. de 2026, Marina Costa escreveu:\n\n> Oi,\n>\n> O pedido não chegou.");
    expect(out.html).toContain('<a href="https://acme.test/t/1">https://acme.test/t/1</a>');
    expect(out.html).toContain('<div class="gmail_signature" data-smartmail="gmail_signature">Bia<br>Acme Support</div>');
    expect(out.html).toContain('<div class="gmail_quote"><div class="gmail_attr">Em 5 de nov. de 2026, Marina Costa escreveu:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">');
    // The thread keeps what the person wrote: no signature, no quote, no stored HTML for a text reply.
    const stored = () => h.query("@email/lib:thread", { threadId: r.threadId }).messages.at(-1);
    expect(stored()).toMatchObject({ _id: rep.messageId, text: "Oi Marina,\n\nJá reenviamos: https://acme.test/t/1" });
    expect(stored().html).toBeUndefined();

    // Without quoteHeader: the English default.
    h.mutate("@email/lib:reply", { threadId: r.threadId, text: "Again." });
    await h.tick();
    out = h.sent[h.sent.length - 1]!;
    expect(out.text).toContain(`\n\nOn ${new Date(at).toUTCString()}, Marina Costa <marina@user.test> wrote:\n\n> Oi,`);

    // A rich body from the composer: sanitized, kept on the message; an HTML signature sanitized too.
    h.mutate("@email/lib:reply", {
      threadId: r.threadId,
      text: "Hello bold",
      bodyHtml: '<p style="color:red" onclick="x()">Hello <b>bold</b> <a href="javascript:alert(1)">bad</a> <a href="https://ok.test" target="_blank">ok</a></p><script>alert(1)</script><img src=x onerror=alert(1)><blockquote>open',
      signature: { text: "Bia", html: '<b>Bia</b><iframe src="https://evil.test"></iframe><a href="mailto:bia@acme.test" style="x">mail</a>' },
    });
    await h.tick();
    out = h.sent[h.sent.length - 1]!;
    noCard(out.html);
    expect(out.html).toContain('<p>Hello <b>bold</b> bad <a href="https://ok.test">ok</a></p><blockquote>open</blockquote><br><span class="gmail_signature_prefix">-- </span><br><div class="gmail_signature" data-smartmail="gmail_signature"><b>Bia</b><a href="mailto:bia@acme.test">mail</a></div>');
    expect(out.html).not.toMatch(/script|onerror|onclick|iframe|javascript:|style="color/);
    expect(out.text).toMatch(/^Hello bold\n\n-- \nBia\n\nOn /);
    expect(stored().html).toBe('<p>Hello <b>bold</b> bad <a href="https://ok.test">ok</a></p><blockquote>open</blockquote>');

    // A whole document in `html` still goes as is (backward compatible); not together with bodyHtml.
    h.mutate("@email/lib:reply", { threadId: r.threadId, text: "Doc", html: "<html><body>Doc</body></html>", signature: { text: "Bia" } });
    await h.tick();
    out = h.sent[h.sent.length - 1]!;
    expect(out.html).toBe("<html><body>Doc</body></html>");
    expect(out.text).toMatch(/^Doc\n\n-- \nBia\n\nOn /);
    expect(() => h.mutate("@email/lib:reply", { threadId: r.threadId, text: "x", html: "<p>x</p>", bodyHtml: "<p>x</p>" })).toThrow(/not both/);
    expect(() => h.mutate("@email/lib:reply", { threadId: r.threadId, text: "x", bodyHtml: "x".repeat(200_001) })).toThrow(/bodyHtml/);
    expect(() => h.mutate("@email/lib:reply", { threadId: r.threadId, text: "x", signature: { text: "x".repeat(5_001) } })).toThrow(/signature/);

    // Compose (the inbox's forward too): plain layout, signature, no quote.
    const c = h.mutate("@email/lib:compose", { mailbox: "support", to: ["dora@user.test"], subject: "Fwd: Order", text: "See below.\n\n---------- Forwarded message ---------\nOi", signature: { text: "Bia" } });
    await h.tick();
    out = h.sent[h.sent.length - 1]!;
    noCard(out.html);
    expect(out.text).toBe("See below.\n\n---------- Forwarded message ---------\nOi\n\n-- \nBia");
    expect(out.html).not.toContain("gmail_quote");
    expect(h.query("@email/lib:thread", { threadId: c.threadId }).messages[0].html).toBeUndefined();
    h.mutate("@email/lib:compose", { mailbox: "support", to: ["dora@user.test"], subject: "Rich", text: "Rich", bodyHtml: "<ul><li><em>one</em></li></ul>" });
    await h.tick();
    out = h.sent[h.sent.length - 1]!;
    noCard(out.html);
    expect(out.html).toContain("<ul><li><em>one</em></li></ul>");
    expect(() => h.mutate("@email/lib:compose", { mailbox: "support", to: ["dora@user.test"], subject: "x", text: "x", html: "<p>x</p>", bodyHtml: "<p>x</p>" })).toThrow(/not both/);

    // Transactional mail through the API (a stored template with the install layout) keeps the card.
    h.mutate("@email/lib:upsertTemplate", { name: "welcome", subject: "Welcome", html: "<p>Hello</p>" });
    h.mutate("@email/lib:send", { from: "x@acme.test", to: "a@b.io", template: { name: "welcome" } });
    await h.tick();
    out = h.sent[h.sent.length - 1]!;
    for (const k of CARD) expect(out.html).toContain(k);
  });
});
