// The outbox's screen in the Ember Dashboard (`defineComponent({ dashboard })`): the spec composes with absolute names,
// and the functions it names list emails by status, show one with its events, and retry a failed one.
import { composeApp, defineApp, defineSchema } from "@freecorps/ember-server";
import { describe, expect, test } from "vitest";
import { email } from "../src/index.ts";
import { fakeTransport, harness } from "./harness.ts";

describe("email dashboard", () => {
  test("the spec names the outbox, the email, retry/cancel and suppressions", async () => {
    const specs = composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(email, { config: {} }) }).dashboards;
    // The email component installs the rate limiter inside it: both screens, under their install paths.
    expect(specs.map((d) => d.key)).toEqual(["email", "email/rateLimit"]);
    expect(Object.keys(specs[0]!.functions).sort()).toEqual(["@email/dashboard:email", "@email/dashboard:outbox", "@email/lib:cancel", "@email/lib:retry", "@email/lib:stats", "@email/lib:suppress", "@email/lib:suppressions", "@email/lib:unsuppress"]);
    expect(Object.keys(specs[1]!.functions)).toContain("@email/@rateLimit/dashboard:buckets");
    const h = harness();
    let fail = true;
    fakeTransport(() => (fail ? new Error("smtp down") : ""));
    const id = h.mutate("@email/lib:send", { from: "app@acme.test", to: "ana@x.test", subject: "Hi", text: "hello", idempotencyKey: "k1" }) as { id: string } | string;
    const emailId = typeof id === "string" ? id : id.id;
    for (let i = 0; i < 10; i++) {
      await h.tick();
      h.advance(60 * 60_000);
    }
    const outbox = (args: object) => h.query("@email/dashboard:outbox", { paginationOpts: { numItems: 10, cursor: null }, ...args }) as { page: Array<{ _id: string; to: string; status: string; error: string | null }> };
    const failed = outbox({ status: "failed" }).page;
    expect(failed.map((e) => [e._id, e.to, e.status])).toEqual([[emailId, "ana@x.test", "failed"]]);
    expect(failed[0]!.error).toMatch(/smtp down/);
    const detail = h.query("@email/dashboard:email", { id: emailId }) as { subject: string; text: string; events: unknown[] };
    expect(detail).toMatchObject({ subject: "Hi", text: "hello" });
    expect(h.query("@email/dashboard:email", { id: "nope" })).toBeNull();
    // Retry: queued again, and delivered once the transport works.
    fail = false;
    expect(h.mutate("@email/lib:retry", { id: emailId })).toMatchObject({ ok: true, status: "queued" });
    await h.tick();
    expect(outbox({ status: "sent" }).page.map((e) => e._id)).toEqual([emailId]);
    expect(outbox({}).page).toHaveLength(1);
    // The detail shows the email's delivery events, oldest first.
    const events = (h.query("@email/dashboard:email", { id: emailId }) as { events: Array<{ at: number }> }).events;
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort((x, y) => x - y));
  });
});
