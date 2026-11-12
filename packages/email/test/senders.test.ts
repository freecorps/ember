// Sender rules: block (reject at SMTP), file as spam, allow; by address or domain, per mailbox or for all.
import { describe, expect, test } from "vitest";
import { email, senderCandidates, senderPattern } from "../src/index.ts";
import { inboxHarness } from "./harness.ts";

type H = ReturnType<typeof inboxHarness>;
const rule = (h: H, pattern: string, action: string, mailbox?: string | null) => h.mutate("@email/lib:setSenderRule", { pattern, action, ...(mailbox !== undefined ? { mailbox } : {}) });
const thread = (h: H, id: string) => h.query("@email/lib:thread", { threadId: id });

/** Drives the component's email() hook with a raw message. */
async function deliver(h: H, o: { from: string; to?: string; envelope?: string; replyTo?: string; dmarc?: string; subject?: string }) {
  const raw = [
    `Authentication-Results: mx.cloudflare.net; dkim=pass; dmarc=${o.dmarc ?? "pass"} header.from=x; spf=pass`,
    `From: ${o.from}`,
    ...(o.replyTo ? [`Reply-To: ${o.replyTo}`] : []),
    `To: ${o.to ?? "support@acme.test"}`,
    `Subject: ${o.subject ?? "Hello"}`,
    `Message-ID: <${Math.random()}@x.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body",
    "",
  ].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  let rejected: string | null = null;
  const msg = { from: o.envelope ?? o.from, to: o.to ?? "support@acme.test", headers: new Headers(), raw: new Response(bytes).body!, rawSize: bytes.length, setReject: (r: string) => void (rejected = r), forward: async () => ({}), reply: async () => ({}) };
  await (email as any).email.handler(h.ctxFor("@email/lib:send"), msg);
  return rejected as string | null;
}

describe("patterns", () => {
  test("addresses and domains, normalized; junk refused", () => {
    expect(senderPattern(" Ana@Acme.com ")).toEqual({ pattern: "ana@acme.com", kind: "address" });
    for (const d of ["acme.com", "@acme.com", "*.acme.com", "*@ACME.com", "acme.com."]) expect(senderPattern(d)).toEqual({ pattern: "acme.com", kind: "domain" });
    for (const bad of ["", "com", "a@b", "acme..com", "-acme.com", "ana@", "1.2.3.4", "a b.com"]) expect(() => senderPattern(bad)).toThrow();
  });
  test("candidates: address, address without +tag, each domain down to two labels", () => {
    expect(senderCandidates("Ana+promo@mail.eu.acme.com")).toEqual(["ana+promo@mail.eu.acme.com", "ana@mail.eu.acme.com", "mail.eu.acme.com", "eu.acme.com", "acme.com"]);
    expect(senderCandidates("<>")).toEqual([]);
  });
});

describe("sender rules", () => {
  test("set, list, update in place, remove; mailbox must exist", () => {
    const h = inboxHarness();
    const r = rule(h, "@spam.test", "spam", "support");
    expect(r).toMatchObject({ mailbox: "support", pattern: "spam.test", kind: "domain", action: "spam", hits: 0 });
    const g = rule(h, "eve@x.test", "reject");
    expect(g.mailbox).toBeNull();
    expect(h.query("@email/lib:senderRules", { mailbox: "support" }).page.map((x: any) => x.pattern)).toEqual(["spam.test"]);
    expect(h.query("@email/lib:senderRules", { mailbox: null }).page.map((x: any) => x.pattern)).toEqual(["eve@x.test"]);
    expect(h.query("@email/lib:senderRules", {}).page).toHaveLength(2);
    // Same pattern and mailbox: the same row, new action.
    const again = h.mutate("@email/lib:setSenderRule", { mailbox: "support", pattern: "spam.test", action: "reject", note: "  phishing " });
    expect(again).toMatchObject({ _id: r._id, action: "reject", note: "phishing" });
    expect(h.query("@email/lib:senderRules", { action: "reject" }).page).toHaveLength(2);
    expect(() => rule(h, "x.test", "spam", "nope")).toThrow(/not found/);
    expect(() => rule(h, "not a domain", "spam")).toThrow(/not an address or domain/);
    expect(h.mutate("@email/lib:removeSenderRule", { ruleId: r._id })).toBe(true);
    expect(h.mutate("@email/lib:removeSenderRule", { pattern: "EVE@x.test", mailbox: null })).toBe(true);
    expect(h.mutate("@email/lib:removeSenderRule", { pattern: "eve@x.test" })).toBe(false);
    expect(h.query("@email/lib:senderRules", {}).page).toHaveLength(0);
  });

  test("a spam rule files the message in a spam conversation, with no auto-reply and the reason on the message", async () => {
    const h = inboxHarness();
    const r = rule(h, "spam.test", "spam", "support");
    const before = h.sent.length;
    const m = h.ingest({ from: { email: "bob@mail.spam.test" }, envelopeFrom: "bob@mail.spam.test" });
    expect(m.status).toBe("spam");
    expect(m.autoReplyId).toBeNull();
    const t = thread(h, m.threadId);
    expect(t.thread.status).toBe("spam");
    expect(t.messages[0].spam).toEqual({ reason: "rule", rule: r._id, pattern: "spam.test", action: "spam" });
    expect(h.query("@email/lib:senderRules", { mailbox: "support" }).page[0]).toMatchObject({ hits: 1, lastHitAt: h.now() });
    // The other mailbox has no rule.
    expect(h.ingest({ mailbox: "privacy", from: { email: "bob@spam.test" }, envelopeFrom: "bob@spam.test" }).status).toBe("open");
    await h.tick();
    expect(h.sent.length).toBe(before);
  });

  test("a blocked sender never joins an open conversation; further spam joins the spam one", () => {
    const h = inboxHarness();
    const open = h.ingest({ from: { email: "ana@user.test" }, subject: "Order" });
    expect(open.status).toBe("open");
    rule(h, "ana@user.test", "spam", "support");
    const next = h.ingest({ from: { email: "ana@user.test" }, subject: "Re: Order" });
    expect(next.threadId).not.toBe(open.threadId);
    expect(next.status).toBe("spam");
    expect(thread(h, open.threadId).thread.status).toBe("open");
    const third = h.ingest({ from: { email: "ana@user.test" }, subject: "Order" });
    expect(third.threadId).toBe(next.threadId);
  });

  test("reject and spam on Reply-To and envelope too; the strongest wins", () => {
    const h = inboxHarness();
    rule(h, "bad.test", "spam");
    expect(h.ingest({ from: { email: "ok@user.test" }, replyTo: { email: "x@bad.test" } }).status).toBe("spam");
    expect(h.ingest({ from: { email: "ok2@user.test" }, envelopeFrom: "bounce@bad.test" }).status).toBe("spam");
    rule(h, "worse.test", "reject");
    const m = h.query("@email/lib:matchSender", { mailbox: "support", email: "a@worse.test" });
    expect(m.effective).toMatchObject({ action: "reject" });
  });

  test("allow: the most specific rule wins, only for a From that passed DMARC; it skips the per-hour limit", () => {
    const h = inboxHarness({ spamPerHour: 2 });
    rule(h, "acme-partner.test", "spam");
    rule(h, "boss@acme-partner.test", "allow", "support");
    expect(h.ingest({ from: { email: "boss@acme-partner.test" }, envelopeFrom: "boss@acme-partner.test" }).status).toBe("open");
    // Spoofed (DMARC failed): the allow does not count, the domain's rule does.
    expect(h.ingest({ from: { email: "boss@acme-partner.test" }, envelopeFrom: "boss@acme-partner.test", auth: { spf: "fail", dkim: "fail", dmarc: "fail" } }).status).toBe("spam");
    // Rate: an allowed sender is never spam by count.
    for (let i = 0; i < 4; i++) expect(h.ingest({ from: { email: "boss@acme-partner.test" }, envelopeFrom: "boss@acme-partner.test", subject: `n${i}` }).status).toBe("open");
    // Without a rule, the third new conversation within the hour is spam by rate.
    h.ingest({ from: { email: "z@user.test" }, envelopeFrom: "z@user.test", subject: "a" });
    h.ingest({ from: { email: "z@user.test" }, envelopeFrom: "z@user.test", subject: "b" });
    const r = h.ingest({ from: { email: "z@user.test" }, envelopeFrom: "z@user.test", subject: "c" });
    expect(r.status).toBe("spam");
    expect(thread(h, r.threadId).messages[0].spam).toEqual({ reason: "rate" });
  });

  test("matchSender lists every matching rule, most specific first, the mailbox's before the global one", () => {
    const h = inboxHarness();
    rule(h, "acme-x.test", "spam");
    rule(h, "acme-x.test", "reject", "support");
    rule(h, "ana@acme-x.test", "allow");
    const m = h.query("@email/lib:matchSender", { mailbox: "support", email: "ana@acme-x.test" });
    expect(m.rules.map((r: any) => [r.pattern, r.mailbox, r.action])).toEqual([
      ["ana@acme-x.test", null, "allow"],
      ["acme-x.test", "support", "reject"],
      ["acme-x.test", null, "spam"],
    ]);
    expect(m.effective.action).toBe("allow");
    expect(h.query("@email/lib:matchSender", { mailbox: "support", email: "ana@acme-x.test", verified: false }).effective.action).toBe("reject");
    expect(h.query("@email/lib:matchSender", { mailbox: "privacy", email: "bo@acme-x.test" }).effective.action).toBe("spam");
  });

  test("removing a mailbox removes its rules", () => {
    const h = inboxHarness();
    rule(h, "a.test", "spam", "privacy");
    rule(h, "b.test", "spam");
    h.mutate("@email/lib:removeMailbox", { name: "privacy" });
    expect(h.query("@email/lib:senderRules", {}).page.map((r: any) => r.pattern)).toEqual(["b.test"]);
  });
});

describe("email() hook", () => {
  test("a reject rule refuses the message before anything is stored, and counts the hit", async () => {
    const h = inboxHarness();
    const r = rule(h, "blocked.test", "reject", "support");
    expect(await deliver(h, { from: "Eve <eve@blocked.test>" })).toBe("Message rejected");
    expect(h.query("@email/lib:threads", { mailbox: "support" }).page).toHaveLength(0);
    expect(h.query("@email/lib:senderRules", { mailbox: "support" }).page[0]).toMatchObject({ _id: r._id, hits: 1 });
    // By envelope sender too, and by Reply-To.
    expect(await deliver(h, { from: "ok@user.test", envelope: "bounce@blocked.test" })).toBe("Message rejected");
    expect(await deliver(h, { from: "ok@user.test", replyTo: "eve@blocked.test" })).toBe("Message rejected");
    // Another mailbox, or an allowed address with DMARC: accepted.
    expect(await deliver(h, { from: "eve@blocked.test", to: "privacy@acme.test" })).toBeNull();
    rule(h, "friend@blocked.test", "allow", "support");
    expect(await deliver(h, { from: "friend@blocked.test" })).toBeNull();
    expect(await deliver(h, { from: "friend@blocked.test", dmarc: "fail" })).toBe("Message rejected");
    expect(h.query("@email/lib:threads", { mailbox: "support" }).page).toHaveLength(1);
  });
});
