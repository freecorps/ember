// hooks.onScreen: the app's filter judges an inbound message in the email() handler, before anything is stored.
import { createFunctionHandle } from "@freecorps/ember-server";
import { beforeEach, describe, expect, test } from "vitest";
import { email, screenVerdictOf } from "../src/index.ts";
import { inboxHarness, probe } from "./harness.ts";

type H = ReturnType<typeof inboxHarness>;
const hooks = { onInbound: createFunctionHandle("hooks:inbound"), onEvent: createFunctionHandle("hooks:event"), onScreen: createFunctionHandle("hooks:screen") };
const screened = (config: Record<string, unknown> = {}) => inboxHarness({ hooks, ...config });
const threads = (h: H) => h.query("@email/lib:threads", { mailbox: "support" }).page as any[];
const thread = (h: H, id: string) => h.query("@email/lib:thread", { threadId: id });

/** Drives the component's email() hook with a raw message (an HTML body and a PDF attachment when asked). */
async function deliver(h: H, o: { from: string; subject?: string; dmarc?: string; inReplyTo?: string; attach?: boolean; html?: string }) {
  const boundary = "b0undary";
  const raw = [
    `Authentication-Results: mx.cloudflare.net; dkim=pass; dmarc=${o.dmarc ?? "pass"} header.from=x; spf=pass`,
    "Received: from mx.evil.test (10.0.0.1)",
    `From: ${o.from}`,
    "To: support@acme.test",
    `Subject: ${o.subject ?? "Hello"}`,
    `Message-ID: <${Math.random()}@x.test>`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    o.html ? "Content-Type: text/html; charset=utf-8" : "Content-Type: text/plain; charset=utf-8",
    "",
    o.html ?? "Body",
    ...(o.attach ? [`--${boundary}`, "Content-Type: application/pdf", 'Content-Disposition: attachment; filename="nota.pdf"', "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQK"] : []),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const bytes = new TextEncoder().encode(raw);
  let rejected: string | null = null;
  const msg = { from: o.from.replace(/.*<|>.*/g, ""), to: "support@acme.test", headers: new Headers(), raw: new Response(bytes).body!, rawSize: bytes.length, setReject: (r: string) => void (rejected = r), forward: async () => ({}), reply: async () => ({}) };
  await (email as any).email.handler(h.ctxFor("@email/lib:send"), msg);
  return rejected as string | null;
}

beforeEach(() => {
  probe.screen = () => null;
  probe.screened = [];
});

describe("hooks.onScreen", () => {
  test("gets the parsed message (attachments without content, headers); null files it as usual", async () => {
    const h = screened();
    expect(await deliver(h, { from: "Ana <ana@user.test>", subject: "Nota fiscal", attach: true, html: "<p>Veja <a href='https://x.test/a'>aqui</a></p>" })).toBeNull();
    expect(probe.screened).toHaveLength(1);
    const m = probe.screened[0];
    expect(m).toMatchObject({ mailbox: "support", recipient: "support@acme.test", envelopeFrom: "ana@user.test", from: { email: "ana@user.test", name: "Ana" }, subject: "Nota fiscal", auth: { dmarc: "pass" } });
    expect(m.html).toContain("https://x.test/a");
    expect(m.attachments).toEqual([{ filename: "nota.pdf", contentType: "application/pdf", size: 9, inline: false }]);
    expect(m.headers.find((x: any) => x.key === "received")?.value).toContain("mx.evil.test");
    expect(threads(h)).toHaveLength(1);
    expect(threads(h)[0].status).toBe("open");
    await h.tick();
    expect(h.sent).toHaveLength(1); // the auto-reply
  });

  test("spam: a new conversation in Spam with the filter's reason, and no auto-reply", async () => {
    const h = screened();
    probe.screen = () => ({ action: "spam", category: "phishing", score: 9.5, signals: ["link-mismatch", "new-domain"] });
    expect(await deliver(h, { from: "nfe@loca30.evil.test", subject: "NF-e 123" })).toBeNull();
    const [t] = threads(h);
    expect(t.status).toBe("spam");
    expect(thread(h, t._id).messages[0].spam).toEqual({ reason: "filter", category: "phishing", score: 9.5, signals: ["link-mismatch", "new-domain"] });
    await h.tick();
    expect(h.sent).toHaveLength(0);
  });

  test("reject refuses the message before anything is stored", async () => {
    const h = screened();
    probe.screen = () => ({ action: "reject", category: "malware" });
    expect(await deliver(h, { from: "x@evil.test" })).toBe("Message rejected");
    expect(threads(h)).toHaveLength(0);
  });

  test("a throw, a timeout or an unknown answer files the message as usual", async () => {
    const h = screened({ screenTimeoutMs: 20 });
    probe.screen = () => {
      throw new Error("app bug");
    };
    expect(await deliver(h, { from: "a@user.test", subject: "one" })).toBeNull();
    probe.screen = () => new Promise((r) => setTimeout(() => r({ action: "spam", category: "late" }), 200));
    expect(await deliver(h, { from: "b@user.test", subject: "two" })).toBeNull();
    probe.screen = () => ({ action: "quarantine" });
    expect(await deliver(h, { from: "c@user.test", subject: "three" })).toBeNull();
    expect(threads(h).map((t) => t.status)).toEqual(["open", "open", "open"]);
  });

  test("not called when a sender rule decides (an allowed sender with DMARC, a blocked one)", async () => {
    const h = screened();
    probe.screen = () => ({ action: "reject", category: "x" });
    h.mutate("@email/lib:setSenderRule", { pattern: "friend@user.test", action: "allow", mailbox: "support" });
    h.mutate("@email/lib:setSenderRule", { pattern: "spam.test", action: "spam", mailbox: "support" });
    expect(await deliver(h, { from: "friend@user.test" })).toBeNull();
    expect(await deliver(h, { from: "x@spam.test" })).toBeNull();
    expect(probe.screened).toHaveLength(0);
    expect(threads(h).map((t) => t.status).sort()).toEqual(["open", "spam"]);
    // An allow without DMARC does not count: the filter judges it.
    expect(await deliver(h, { from: "friend@user.test", dmarc: "fail", subject: "other" })).toBe("Message rejected");
  });

  test("a filtered message joins an open conversation by citation, never by subject alone", async () => {
    const h = screened();
    // An open conversation with ana about "Pedido 42".
    const first = h.ingest({ messageId: "a1@user.test", subject: "Pedido 42" });
    probe.screen = () => ({ action: "spam", category: "spam" });
    // Same contact and subject, no citation: a conversation of its own, in Spam.
    expect(await deliver(h, { from: "Ana <ana@user.test>", subject: "Re: Pedido 42" })).toBeNull();
    // Citing her message, DMARC pass: it joins (the filter can be wrong about a real answer), and nothing changes.
    expect(await deliver(h, { from: "Ana <ana@user.test>", subject: "Re: Pedido 42", inReplyTo: "a1@user.test" })).toBeNull();
    const t = thread(h, first.threadId);
    expect(t.thread.status).toBe("open");
    expect(t.messages).toHaveLength(2);
    expect((t.messages as any[]).every((m) => !m.spam)).toBe(true);
    const all = threads(h);
    expect(all.map((t) => t.status).sort()).toEqual(["open", "spam"]);
  });
});

describe("screenVerdictOf", () => {
  test("keeps known actions, trims and caps the rest", () => {
    expect(screenVerdictOf(null)).toBeNull();
    expect(screenVerdictOf({ action: "allow" })).toBeNull();
    expect(screenVerdictOf({ action: "spam" })).toEqual({ action: "spam", category: "filter" });
    expect(screenVerdictOf({ action: "reject", category: " phishing ", score: Number.NaN, signals: ["a", 1, "", "b".repeat(300)] })).toEqual({ action: "reject", category: "phishing", signals: ["a", "b".repeat(120)] });
  });
});
