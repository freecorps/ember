// The email component on the real engine (node:sqlite), with a fake transport: send atomic with the caller,
// idempotency, suppressions, rate limit, scheduled sends, delivery retries, header fallback, events (dedup, out of
// order, before finish, bounces → suppression), inbound threading, spam, auto-replies, hooks, inbox queries.
import {
  anyComponents,
  checkAccess,
  composeApp,
  createEngine,
  createFunctionHandle,
  defineApp,
  defineSchema,
  defineTable,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  resolveReference,
  splitFunctionName,
  v,
  type Job,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { afterEach, describe, expect, test } from "vitest";
import { Email, email, setEmailTransport, TransportError, type OutboundMessage } from "../src/index.ts";

const mail = new Email(anyComponents.email);
const schema = defineSchema({ tables: { users: defineTable({ email: v.string() }), seen: defineTable({ kind: v.string(), data: v.any() }) } });

const inboundArgs = { threadId: v.string(), messageId: v.string(), mailbox: v.string(), number: v.number(), newThread: v.boolean(), status: v.string(), from: v.any(), subject: v.string(), snippet: v.string(), autoSubmitted: v.boolean() };
const fns = {
  app: {
    signup: mutationGeneric({
      args: { email: v.string(), fail: v.optional(v.boolean()), key: v.optional(v.string()), sendAt: v.optional(v.number()) },
      handler: (ctx: any, a: any) => {
        ctx.db.insert("users", { email: a.email });
        const r = mail.send(ctx, {
          from: "Acme <hello@acme.test>",
          to: a.email,
          subject: "Welcome",
          html: "<p>Hi</p>",
          ...(a.key ? { idempotencyKey: a.key } : {}),
          ...(a.sendAt ? { sendAt: a.sendAt } : {}),
          headers: { "X-Campaign": "welcome" },
        });
        if (a.fail) throw new Error("rollback");
        return r;
      },
    }),
    users: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("users").collect().length }),
    seen: queryGeneric({ args: { kind: v.string() }, handler: (ctx: any, a: any) => ctx.db.query("seen").collect().filter((r: any) => r.kind === a.kind).map((r: any) => r.data) }),
    onInbound: internalMutationGeneric({ args: { event: v.optional(v.any()) }, handler: () => null }),
  },
  // The component calls these through function handles (config.hooks), in the same transaction.
  hooks: {
    inbound: internalMutationGeneric({
      args: inboundArgs,
      handler: (ctx: any, a: any) => ctx.db.insert("seen", { kind: "inbound", data: a }),
    }),
    boom: internalMutationGeneric({
      args: inboundArgs,
      handler: (ctx: any) => {
        ctx.db.insert("seen", { kind: "boom", data: 1 });
        probe.boom++;
        throw new Error("app bug");
      },
    }),
    event: internalMutationGeneric({
      args: { emailId: v.string(), project: v.string(), type: v.string(), status: v.string(), recipient: v.union(v.string(), v.null()), tags: v.any() },
      handler: (ctx: any, a: any) => ctx.db.insert("seen", { kind: "event", data: a }),
    }),
  },
};

function harness(config: Record<string, unknown> = {}) {
  let now = 1_800_000_000_000;
  const app = defineApp().use(email, {
    config: {
      rateLimit: { rate: 3, period: 60_000 },
      hooks: { onInbound: createFunctionHandle("hooks:inbound"), onEvent: createFunctionHandle("hooks:event") },
      ...config,
    } as any,
  });
  const composed = composeApp({ schema, functions: fns, app });
  const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), now: () => now });
  engine.migrate();
  const all = new Map(Object.entries(composed.functions));
  let jobs: Job[] = [];
  const mutate = (name: string, args: unknown) => {
    const r = engine.runMutation(name, args);
    jobs.push(...r.scheduled);
    if (r.cancelled?.length) jobs = jobs.filter((j) => !r.cancelled.includes(j.id));
    return r.value as any;
  };
  const query = (name: string, args: unknown = {}) => engine.runQuery(name, args).value as any;
  const ctxFor = (name: string): any => {
    const path = splitFunctionName(name).path;
    const res = (ref: unknown) => {
      const r = resolveReference(path, ref as any);
      checkAccess(all as any, r);
      return r.name;
    };
    return {
      runQuery: async (ref: unknown, a?: unknown) => query(res(ref), a ?? {}),
      runMutation: async (ref: unknown, a?: unknown) => mutate(res(ref), a ?? {}),
      scheduler: { runAfter: async (ms: number, ref: unknown, a?: unknown) => jobs.push({ id: `j${jobs.length}`, fn: res(ref), args: a ?? {}, runAt: now + ms, kind: "action" }) },
      storage: { get: async () => null, store: async () => "x" },
      env: {},
      now,
      ...(path.length ? { component: { name: path.join("/"), config: composed.configs.get(path.join("/")) } } : {}),
    };
  };
  const runAction = async (name: string, args: unknown) => (all.get(name) as any).handler(ctxFor(name), args);
  const tick = async () => {
    for (;;) {
      const due = jobs.filter((j) => j.runAt <= now).sort((a, b) => a.runAt - b.runAt)[0];
      if (!due) return;
      jobs = jobs.filter((j) => j !== due);
      if (due.kind === "mutation") mutate(due.fn, due.args);
      else await runAction(due.fn, due.args);
    }
  };
  const get = (id: string) => query("@email/lib:get", { id });
  return { engine, mutate, query, tick, get, jobs: () => jobs, advance: (ms: number) => (now += ms), now: () => now, runAction };
}

/** A transport that records messages; `script` decides each call's outcome. */
function fakeTransport(script: (m: OutboundMessage, n: number) => string | Error = () => "") {
  const sent: OutboundMessage[] = [];
  setEmailTransport(() => ({
    async send(m) {
      const r = script(m, sent.length);
      sent.push(m);
      if (r instanceof Error) throw r;
      return { messageId: r || `mid-${sent.length}` };
    },
  }));
  return sent;
}
afterEach(() => setEmailTransport(null));
const probe = { boom: 0 };

const event = (type: string, messageId: string, extra: Record<string, unknown> = {}, eventId = `${type}-${messageId}`) => ({
  eventId,
  type,
  messageId,
  recipient: "ana@user.test",
  sender: "hello@acme.test",
  terminal: type !== "deferred",
  at: 1,
  raw: {},
  ...extra,
});

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

  test("an event that arrives before the send is recorded is applied when it is", async () => {
    const h = harness();
    fakeTransport();
    h.mutate("@email/lib:applyEvents", { events: [event("delivered", "mid-1")] });
    const r = h.mutate("app:signup", { email: "ana@user.test" });
    await h.tick();
    expect(h.get(r.id).status).toBe("delivered");
  });
});

// ------------------------------------------------------------------ inbound

const inbound = (o: Partial<Record<string, any>> = {}) => ({
  mailbox: "support",
  envelopeFrom: "ana@user.test",
  messageId: `m-${Math.random()}@user.test`,
  references: [],
  from: { email: "ana@user.test", name: "Ana" },
  to: [{ email: "support@acme.test" }],
  cc: [],
  subject: "Order 42 is late",
  text: "Where is my order?",
  truncated: false,
  attachments: [],
  droppedAttachments: 0,
  auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
  autoSubmitted: false,
  ...o,
});

function inboxHarness(config: Record<string, unknown> = {}) {
  const h = harness(config);
  const sent = fakeTransport();
  h.mutate("@email/lib:upsertMailbox", {
    name: "support",
    address: "Support@Acme.test",
    displayName: "Acme Support",
    autoReply: { subject: "Re: {{subject}} [#{{number}}]", text: "Hi {{name}}, we got your message (#{{number}})." },
  });
  h.mutate("@email/lib:upsertMailbox", { name: "privacy", address: "privacy@acme.test" });
  return { ...h, sent, ingest: (o: Partial<Record<string, any>> = {}) => h.mutate("@email/lib:ingest", { message: inbound(o) }) };
}

describe("inbound mail", () => {
  test("routing: mailbox addresses and plus-addressed tokens", () => {
    const h = inboxHarness();
    expect(h.query("@email/lib:route", { to: "SUPPORT@acme.test" })).toEqual({ mailbox: "support", tag: null });
    expect(h.query("@email/lib:route", { to: "support+t_abc@acme.test" })).toEqual({ mailbox: "support", tag: "t_abc" });
    expect(h.query("@email/lib:route", { to: "sales@acme.test" })).toBeNull();
    expect(() => h.mutate("@email/lib:upsertMailbox", { name: "dup", address: "support@acme.test" })).toThrow(/already belongs/);
  });

  test("a new conversation: ticket number, unread, auto-reply (threaded, with token), onInbound hook", async () => {
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
      replyTo: { email: `support+t_${thread.token}@acme.test` },
      subject: "Re: Order 42 is late [#1]",
      text: "Hi Ana, we got your message (#1).",
      headers: { "Auto-Submitted": "auto-replied", "In-Reply-To": "<first@user.test>", References: "<first@user.test>" },
    });
    expect(h.query("@email/lib:unread", {})).toEqual({ support: { unread: 1, threads: 1 }, privacy: { unread: 0, threads: 0 } });
    // The same message again (redelivery): nothing new.
    expect(h.ingest({ messageId: "first@user.test" })).toMatchObject({ duplicate: true });
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
    expect(h.query("@email/lib:search", { query: "invoice", mailbox: "support" })).toMatchObject([{ threadId: r.threadId, direction: "inbound" }]);
    expect(h.query("@email/lib:search", { query: "invoice", mailbox: "privacy" })).toEqual([]);
    expect(h.query("@email/lib:threads", { mailbox: "support", status: "waiting" }).page).toHaveLength(1);
    expect(h.query("@email/lib:threads", { mailbox: "support", status: "open" }).page).toHaveLength(0);
    // A customer answer reopens it.
    h.ingest({ subject: "Re: Order 42 is late" });
    expect(h.query("@email/lib:thread", { threadId: r.threadId }).thread.status).toBe("open");
  });
});
