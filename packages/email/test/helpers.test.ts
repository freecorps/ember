import { describe, expect, test } from "vitest";
import {
  authResultsFrom,
  bareMessageId,
  bareMessageIdList,
  emailLayout,
  htmlToText,
  isNoReplySender,
  messageIdList,
  nextStatus,
  normalizeMessageId,
  parseAddress,
  parseAddressList,
  parseDeliveryEvent,
  parseInbound,
  renderStored,
  renderTemplate,
  replySubject,
  restTransport,
  splitPlus,
  subjectKey,
  bindingTransport,
  TransportError,
  withPlus,
} from "../src/index.ts";

describe("addresses", () => {
  test("parse display names and bare addresses; reject injection", () => {
    expect(parseAddress('"Ana, Support" <Ana@Example.com>')).toEqual({ email: "ana@example.com", name: "Ana, Support" });
    expect(parseAddress("Bob <bob@x.io>")).toEqual({ email: "bob@x.io", name: "Bob" });
    expect(parseAddress({ email: "c@x.io", name: "C" })).toEqual({ email: "c@x.io", name: "C" });
    expect(() => parseAddress("bob@x.io\r\nBcc: evil@x.io")).toThrow();
    expect(() => parseAddress("not an address")).toThrow();
    expect(parseAddressList(["a@x.io", "A@x.io", "b@x.io"]).map((a) => a.email)).toEqual(["a@x.io", "b@x.io"]);
  });

  test("plus addressing, subjects, message ids, no-reply senders", () => {
    expect(splitPlus("support+t_abc@x.io")).toEqual({ base: "support@x.io", tag: "t_abc" });
    expect(splitPlus("Support@x.io")).toEqual({ base: "support@x.io", tag: null });
    expect(withPlus("support@x.io", "t_1")).toBe("support+t_1@x.io");
    expect(subjectKey("RE: Fwd: [#12] Hello   World")).toBe("hello world");
    expect(subjectKey("AW: Re[2]: ok")).toBe("ok");
    expect(replySubject("Hello")).toBe("Re: Hello");
    expect(replySubject("re: Hello")).toBe("re: Hello");
    expect(normalizeMessageId("<ABC@x.io>")).toBe("abc@x.io");
    expect(messageIdList("<a@x> <B@y>")).toEqual(["a@x", "b@y"]);
    // As written, for the headers of a reply (Gmail compares Message-IDs exactly).
    expect(bareMessageId(" <CA+ae4=Bm@mail.gmail.com> ")).toBe("CA+ae4=Bm@mail.gmail.com");
    expect(bareMessageId("")).toBeNull();
    expect(bareMessageIdList("<a@X> <B@y>")).toEqual(["a@X", "B@y"]);
    expect(isNoReplySender("no-reply@x.io")).toBe(true);
    expect(isNoReplySender("noreply+abc@x.io")).toBe(true);
    expect(isNoReplySender("mailer-daemon@x.io")).toBe(true);
    expect(isNoReplySender("ana@x.io")).toBe(false);
  });
});

describe("templates", () => {
  test("escape by default, raw with triple braces, if/else/unless/each, dotted paths", () => {
    const src = "Hi {{user.name}}! {{{badge}}} {{#if vip}}VIP{{else}}regular{{/if}}{{#unless vip}}!{{/unless}} <ul>{{#each items}}<li>{{@index}}:{{name}}</li>{{/each}}</ul>";
    expect(renderTemplate(src, { user: { name: "<Ana>" }, badge: "<b>1</b>", vip: false, items: [{ name: "a" }, { name: "b&c" }] })).toBe(
      "Hi &lt;Ana&gt;! <b>1</b> regular! <ul><li>0:a</li><li>1:b&amp;c</li></ul>",
    );
    expect(renderTemplate("{{missing}}|{{#if empty}}x{{/if}}", { empty: [] })).toBe("|");
    expect(() => renderTemplate("{{#if a}}", {})).toThrow(/Unclosed/);
    expect(() => renderTemplate("{{/if}}", {})).toThrow(/Unexpected/);
  });

  test("stored templates: subject unescaped and single-line, layout, text derived from html", () => {
    const r = renderStored({ subject: "Welcome, {{name}}\n!", html: "<p>Hello <b>{{name}}</b></p><a href=\"https://x.io/a\">Open</a>", layout: { brand: "Acme", footer: "Acme Inc." } }, { name: "Tom & Jerry" });
    expect(r.subject).toBe("Welcome, Tom & Jerry !");
    expect(r.html).toContain("Tom &amp; Jerry");
    expect(r.html).toContain("Acme Inc.");
    expect(r.html.startsWith("<!doctype html>")).toBe(true);
    expect(r.text).toBe("Hello Tom & Jerry\nOpen (https://x.io/a)");
    expect(emailLayout("<p>x</p>", { color: "red;background:url(x)" })).toContain("#e8590c"); // only hex colors
    expect(htmlToText("<style>p{}</style><p>a</p><p>b<br>c</p>")).toBe("a\nb\nc");
  });
});

describe("delivery events", () => {
  const ev = (type: string, payload: Record<string, unknown> = {}) => ({
    type: `cf.email.sending.message.${type}`,
    source: { type: "email.sending", zoneId: "z", domain: "x.io" },
    payload: { eventId: `e-${type}`, messageId: "m1", sender: "a@x.io", recipient: "B@y.io", terminal: type !== "deferred", ...payload },
    metadata: { accountId: "acc", eventSubscriptionId: "s", eventSchemaVersion: 1, eventTimestamp: "2026-11-05T00:00:00.000Z" },
  });

  test("parses Email Service events; ignores other messages", () => {
    expect(parseDeliveryEvent(ev("bounced", { bounce: { type: "hard", classification: "x", reason: "no such user" } }))).toMatchObject({
      eventId: "e-bounced",
      type: "bounced",
      messageId: "m1",
      recipient: "b@y.io",
      bounceType: "hard",
      reason: "no such user",
      terminal: true,
      at: Date.parse("2026-11-05T00:00:00.000Z"),
    });
    expect(parseDeliveryEvent(ev("deferred"))!.terminal).toBe(false);
    expect(parseDeliveryEvent({ type: "something.else" })).toBeNull();
    expect(parseDeliveryEvent({ type: "cf.email.sending.message.delivered", payload: {} })).toBeNull();
  });

  test("status only moves forward (out-of-order safe)", () => {
    expect(nextStatus("sent", "deferred")).toBe("delivery_delayed");
    expect(nextStatus("delivered", "deferred")).toBe("delivered");
    expect(nextStatus("delivered", "complained")).toBe("complained");
    expect(nextStatus("bounced", "delivered")).toBe("bounced");
  });
});

describe("inbound MIME", () => {
  const raw = [
    "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com; spf=pass smtp.mailfrom=example.com",
    "Authentication-Results: evil.example; dmarc=pass",
    'From: "Ana Souza" <Ana@Example.com>',
    "To: support@acme.test",
    "Subject: =?UTF-8?Q?Ol=C3=A1?= help",
    "Message-ID: <M1@example.com>",
    "In-Reply-To: <prev@acme.test>",
    "References: <first@acme.test> <prev@acme.test>",
    "Auto-Submitted: auto-replied",
    "Date: Wed, 04 Nov 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello there",
    "--b1",
    'Content-Type: text/plain; name="notes.txt"',
    'Content-Disposition: attachment; filename="notes.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa("file body"),
    "--b1--",
    "",
  ].join("\r\n");

  test("headers, bodies, attachments, Cloudflare auth results, auto-submitted", async () => {
    const p = await parseInbound(raw);
    expect(p).toMatchObject({
      messageId: "m1@example.com",
      messageIdRaw: "M1@example.com",
      inReplyTo: "prev@acme.test",
      references: ["first@acme.test", "prev@acme.test"],
      referencesRaw: ["first@acme.test", "prev@acme.test"],
      from: { email: "ana@example.com", name: "Ana Souza" },
      to: [{ email: "support@acme.test" }],
      subject: "Olá help",
      text: "Hello there",
      autoSubmitted: true,
      auth: { dkim: "pass", dmarc: "pass", spf: "pass" },
      date: Date.parse("2026-11-04T10:00:00Z"),
    });
    expect(p.attachments).toHaveLength(1);
    expect(p.attachments[0]).toMatchObject({ filename: "notes.txt", contentType: "text/plain", inline: false });
    expect(new TextDecoder().decode(p.attachments[0]!.content)).toBe("file body");
  });

  test("only the first Authentication-Results from mx.cloudflare.net is trusted; caps", async () => {
    expect(authResultsFrom([{ key: "authentication-results", value: "evil.example; dmarc=pass" }])).toEqual({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
  });

  test("Cloudflare's real header: policy.dmarc is not the result, comments are ignored, any spf/dkim pass wins", () => {
    // Captured in production (docs/spikes/remote/mail-prod.md), addresses anonymized.
    const value =
      "mx.cloudflare.net; dkim=pass header.d=mail.example.com header.s=cf-bounce header.b=AAAAAAAA dkim=pass header.d=cloudflare-smtp.net header.s=cf2024-1 header.b=BBBBBBBB dmarc=pass header.from=mail.example.com policy.dmarc=reject; spf=none (mx.cloudflare.net: no SPF records found for postmaster@bg-jh.cloudflare-smtp.net; dmarc=fail) smtp.helo=bg-jh.cloudflare-smtp.net; spf=pass (mx.cloudflare.net: domain of x@cf-bounce.mail.example.com designates 104.30.16.97 as permitted sender) smtp.mailfrom=x@cf-bounce.mail.example.com; arc=none smtp.remote-ip=104.30.16.97";
    expect(authResultsFrom([{ key: "authentication-results", value }])).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
    expect(authResultsFrom([{ key: "authentication-results", value: "mx.cloudflare.net; spf=pass smtp.mailfrom=a@x.io; spf=fail smtp.helo=x.io; dkim=fail header.d=x.io; dmarc=fail header.from=x.io policy.dmarc=none" }])).toEqual({ spf: "pass", dkim: "fail", dmarc: "fail" });
    expect(authResultsFrom([{ key: "authentication-results", value: "mx.cloudflare.net; dmarc=none header.from=x.io policy.dmarc=none" }]).dmarc).toBe("none");
  });

  test("parse caps", async () => {
    const p = await parseInbound(raw, { maxText: 5, maxAttachments: 0 });
    expect(p.text).toBe("Hello");
    expect(p.truncated).toBe(true);
    expect(p.attachments).toEqual([]);
    expect(p.droppedAttachments).toBe(1);
  });
});

describe("transports", () => {
  const msg = { from: { email: "a@x.io", name: "A" }, to: [{ email: "b@y.io" }], subject: "s", text: "t", replyTo: { email: "r@x.io" } };

  test("binding: structured message, messageId, permanent vs transient codes", async () => {
    const calls: unknown[] = [];
    const ok = bindingTransport({ send: async (m) => (calls.push(m), { messageId: "mid-1" }) });
    expect(await ok.send(msg)).toEqual({ messageId: "mid-1" });
    expect(calls[0]).toEqual({ from: { email: "a@x.io", name: "A" }, to: "b@y.io", replyTo: "r@x.io", subject: "s", text: "t" });
    const perm = bindingTransport({ send: async () => Promise.reject(Object.assign(new Error("nope"), { code: "E_SENDER_NOT_VERIFIED" })) });
    await expect(perm.send(msg)).rejects.toMatchObject({ code: "E_SENDER_NOT_VERIFIED", permanent: true });
    const temp = bindingTransport({ send: async () => Promise.reject(Object.assign(new Error("slow down"), { code: "E_RATE_LIMIT_EXCEEDED" })) });
    await expect(temp.send(msg)).rejects.toMatchObject({ code: "E_RATE_LIMIT_EXCEEDED", permanent: false });
  });

  test("REST: snake_case reply_to, bearer token, message_id; 429 is transient", async () => {
    const seen: any[] = [];
    const t = restTransport({
      accountId: "acc",
      apiToken: "tok",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init, body: JSON.parse(String(init.body)) });
        return Response.json({ success: true, errors: [], result: { message_id: "rest-1", delivered: ["b@y.io"], queued: [], permanent_bounces: [] } });
      }) as typeof fetch,
    });
    expect(await t.send(msg)).toEqual({ messageId: "rest-1" });
    expect(seen[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/email/sending/send");
    expect(new Headers(seen[0].init.headers).get("authorization")).toBe("Bearer tok");
    expect(seen[0].body.reply_to).toBe("r@x.io");
    const busy = restTransport({ accountId: "a", apiToken: "t", fetch: (async () => Response.json({ success: false, errors: [{ code: 10004, message: "throttled" }] }, { status: 429 })) as typeof fetch });
    await expect(busy.send(msg)).rejects.toBeInstanceOf(TransportError);
    await expect(busy.send(msg)).rejects.toMatchObject({ permanent: false });
    // A just-onboarded domain answers E_SENDER_DOMAIN_NOT_AVAILABLE with a 4xx: retried, not failed.
    const rest4xx = (code: string | number, message: string) =>
      restTransport({ accountId: "a", apiToken: "t", fetch: (async () => Response.json({ success: false, errors: [{ code, message }] }, { status: 400 })) as typeof fetch });
    await expect(rest4xx("E_SENDER_DOMAIN_NOT_AVAILABLE", "domain not available").send(msg)).rejects.toMatchObject({ code: "E_SENDER_DOMAIN_NOT_AVAILABLE", permanent: false });
    await expect(rest4xx(10000, "E_SENDER_DOMAIN_NOT_AVAILABLE: sending domain is not available yet").send(msg)).rejects.toMatchObject({ permanent: false });
    // Other 4xx stay permanent.
    await expect(rest4xx(10001, "invalid recipient").send(msg)).rejects.toMatchObject({ permanent: true });
    await expect(rest4xx("E_SENDER_NOT_VERIFIED", "not verified").send(msg)).rejects.toMatchObject({ permanent: true });
  });
});
