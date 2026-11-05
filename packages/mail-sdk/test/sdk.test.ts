import { describe, expect, test } from "vitest";
import { EmberMail } from "../src/index.ts";

function fake(status = 200, reply: unknown = { id: "e1" }) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: any }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method!, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(reply, { status });
  }) as typeof fetch;
  return { calls, f };
}

describe("EmberMail", () => {
  test("emails.send: bearer key, Idempotency-Key, Resend aliases, bytes attachments as base64", async () => {
    const { calls, f } = fake();
    const mail = new EmberMail("em_x", { baseUrl: "https://mail.test/", fetch: f });
    const r = await mail.emails.send(
      { from: "a@acme.test", to: ["b@x.test"], subject: "s", html: "<p>h</p>", replyTo: "r@acme.test", scheduledAt: new Date("2026-12-01T00:00:00Z"), attachments: [{ filename: "a.txt", content: new TextEncoder().encode("hi") }] },
      { idempotencyKey: "k1" },
    );
    expect(r).toEqual({ data: { id: "e1" }, error: null });
    expect(calls[0]!.url).toBe("https://mail.test/emails");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer em_x");
    expect(calls[0]!.headers.get("idempotency-key")).toBe("k1");
    expect(calls[0]!.body).toEqual({ from: "a@acme.test", to: ["b@x.test"], subject: "s", html: "<p>h</p>", reply_to: "r@acme.test", scheduled_at: "2026-12-01T00:00:00.000Z", attachments: [{ filename: "a.txt", content: "aGk=" }] });
  });

  test("errors come back as { data: null, error } (never thrown)", async () => {
    const { f } = fake(422, { statusCode: 422, name: "validation_error", message: "to is required" });
    const mail = new EmberMail("em_x", { baseUrl: "https://mail.test", fetch: f });
    expect(await mail.emails.get("nope")).toEqual({ data: null, error: { statusCode: 422, name: "validation_error", message: "to is required" } });
    const down = new EmberMail("em_x", { baseUrl: "https://mail.test", fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
    expect((await down.domains.list()).error).toMatchObject({ name: "network_error", message: "offline" });
  });

  test("paths of the other resources", async () => {
    const { calls, f } = fake(200, {});
    const mail = new EmberMail("em_x", { baseUrl: "https://mail.test", fetch: f });
    await mail.batch.send([{ from: "a@acme.test", to: "b@x.test", subject: "s", text: "t" }]);
    await mail.domains.verify("d 1", { enable_routing: true });
    await mail.inbox.threads({ mailbox: "support", status: "open", limit: 10 });
    await mail.inbox.reply("t1", "thanks");
    await mail.apiKeys.remove("k1");
    expect(calls.map((c) => `${c.method} ${c.url.slice("https://mail.test".length)}`)).toEqual([
      "POST /emails/batch",
      "POST /domains/d%201/verify",
      "GET /inbox/threads?mailbox=support&status=open&limit=10",
      "POST /inbox/threads/t1/reply",
      "DELETE /api-keys/k1",
    ]);
  });
});
