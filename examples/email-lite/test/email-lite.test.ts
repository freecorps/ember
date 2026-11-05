// email-lite on workerd: a mailbox, a send through the simulated send_email binding, a delivery event through the
// component's local queue, and inbound mail through the Worker's email() handler (thread, attachment in R2, reply).
import { createExecutionContext, env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "./worker.ts";

const BASE = "http://email-lite.test";
const api = async (method: string, path: string, body?: unknown, token = "admin-secret") => {
  const r = await SELF.fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as any };
};
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function inbound(from: string, to: string, raw: string) {
  const bytes = new TextEncoder().encode(raw);
  const out = { rejected: null as string | null };
  const msg = { from, to, headers: new Headers(), raw: new Response(bytes).body!, rawSize: bytes.length, setReject: (r: string) => void (out.rejected = r), forward: async () => ({}), reply: async () => ({}) };
  return { msg, out };
}
const mime = (o: { from: string; to: string; subject: string; text: string; id: string }) =>
  [
    "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=user.test; dmarc=pass header.from=user.test; spf=pass",
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Message-ID: <${o.id}>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="xx"',
    "",
    "--xx",
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.text,
    "--xx",
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    btoa("%PDF-1.4 fake"),
    "--xx--",
    "",
  ].join("\r\n");

describe("email-lite", () => {
  it("needs the admin token", async () => {
    expect((await api("GET", "/mailboxes", undefined, "nope")).status).toBe(401);
  });

  it("send → sent (idempotent) → delivered through the component's queue", async () => {
    const s = await api("POST", "/send", { from: "hello@acme.test", to: "ana@user.test", subject: "hi", text: "x", idempotencyKey: "k1" });
    expect(s.status).toBe(200);
    expect((await api("POST", "/send", { from: "hello@acme.test", to: "ana@user.test", subject: "hi", text: "x", idempotencyKey: "k1" })).body).toMatchObject({ id: s.body.id, duplicate: true });
    const sent = await until(() => api("GET", `/emails/${s.body.id}`), (r) => r.body.email?.status === "sent");
    const messageId = sent.body.email.messageId;
    expect(messageId).toBeTruthy();
    await env.EMBER_Q_EMAIL_EVENTS.send({
      type: "cf.email.sending.message.delivered",
      source: { type: "email.sending", zoneId: "z", domain: "acme.test" },
      payload: { eventId: "ev-1", messageId, sender: "hello@acme.test", recipient: "ana@user.test", terminal: true },
      metadata: { accountId: "acc", eventSubscriptionId: "s", eventSchemaVersion: 1, eventTimestamp: new Date().toISOString() },
    });
    const done = await until(() => api("GET", `/emails/${s.body.id}`), (r) => r.body.email?.status === "delivered");
    expect(done.body.events).toMatchObject([{ type: "delivered", terminal: true }]);
  });

  it("inbound: email() → mailbox thread with the attachment in R2; unknown addresses rejected; reply threads", async () => {
    expect((await api("POST", "/mailboxes", { name: "support", address: "support@acme.test", displayName: "Acme Support" })).status).toBe(200);
    const m = inbound("ana@user.test", "support@acme.test", mime({ from: '"Ana" <ana@user.test>', to: "support@acme.test", subject: "Invoice wrong", text: "My invoice total is wrong.", id: "in-1@user.test" }));
    await worker.email(m.msg as never, env as never, createExecutionContext());
    expect(m.out.rejected).toBeNull();
    const nope = inbound("ana@user.test", "sales@acme.test", mime({ from: "ana@user.test", to: "sales@acme.test", subject: "x", text: "x", id: "in-2@user.test" }));
    await worker.email(nope.msg as never, env as never, createExecutionContext());
    expect(nope.out.rejected).toBe("Address not found");

    const threads = (await api("GET", "/threads?mailbox=support")).body.page;
    expect(threads).toMatchObject([{ number: 1, subject: "Invoice wrong", contact: "ana@user.test", status: "open", unreadCount: 1 }]);
    const full = (await api("GET", `/threads/${threads[0]._id}`)).body;
    expect(full.messages[0]).toMatchObject({ direction: "inbound", text: "My invoice total is wrong.", auth: { dkim: "pass", dmarc: "pass" }, attachments: [{ filename: "invoice.pdf" }] });
    expect((await env.EMBER_FILES.list()).objects.length).toBeGreaterThanOrEqual(2); // the .eml and the PDF
    const reply = await api("POST", `/threads/${threads[0]._id}/reply`, { text: "Fixed!" });
    expect(reply.status).toBe(200);
    expect((await api("GET", `/threads/${threads[0]._id}`)).body.thread.status).toBe("waiting");
  });
});
