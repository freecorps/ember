// The outbox's screen in the Ember Dashboard (`defineComponent({ dashboard })`): the spec composes with absolute names,
// and the functions it names list emails by status, show one with its events, and retry a failed one.
import { composeApp, defineApp, defineSchema } from "@freecorps/ember-server";
import { describe, expect, test } from "vitest";
import { EMBED_SDK_SCRIPT } from "@freecorps/ember-dashboard-sdk";
import { email } from "../src/index.ts";
import { PREVIEW_PAGE, PREVIEW_ROUTE } from "../src/preview.ts";
import { fakeTransport, harness } from "./harness.ts";

describe("email dashboard", () => {
  test("the spec names the outbox, the email, retry/cancel and suppressions", async () => {
    const specs = composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(email, { config: {} }) }).dashboards;
    // The email component installs the rate limiter inside it: both screens, under their install paths.
    expect(specs.map((d) => d.key)).toEqual(["email", "email/rateLimit"]);
    expect(Object.keys(specs[0]!.functions).sort()).toEqual(["@email/dashboard:email", "@email/dashboard:outbox", "@email/dashboard:preview", "@email/lib:cancel", "@email/lib:retry", "@email/lib:stats", "@email/lib:suppress", "@email/lib:suppressions", "@email/lib:unsuppress"]);
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

describe("email preview (embed block)", () => {
  test("the Preview tab embeds the component's own GET route, which serves a static page with the SDK inline", async () => {
    const app = composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(email, { config: {} }) });
    const spec = app.dashboards.find((d) => d.key === "email")!;
    const block = spec.tabs.find((t) => t.id === "preview")!.blocks[0]!;
    expect(block).toMatchObject({ kind: "embed", id: "preview", route: PREVIEW_ROUTE, path: `/email${PREVIEW_ROUTE}`, height: "auto", functions: { "dashboard:outbox": "@email/dashboard:outbox", "dashboard:preview": "@email/dashboard:preview" } });
    expect(spec.functions["@email/dashboard:preview"]).toMatchObject({ type: "query" });
    const route = app.routes.find((r) => r.path === `/email${PREVIEW_ROUTE}`)!;
    expect(route).toMatchObject({ method: "GET", scope: ["email"] });
    const res = (await route.handler.handler(null as never, new Request(`https://app.test/email${PREVIEW_ROUTE}`))) as Response;
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toBe(PREVIEW_PAGE);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // The SDK, then the page's script: both inline (the dashboard allows them by hash), nothing loaded from a URL.
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.map((m) => m[1])).toEqual(["", ""]);
    expect(scripts[0]![2]).toBe(EMBED_SDK_SCRIPT);
    expect(() => new Function(scripts[1]![2]!)).not.toThrow();
    expect(scripts[1]![2]).toContain(`dash.query("dashboard:preview"`);
    expect(html).not.toMatch(/\bsrc=|\bhref=|\bon[a-z]+=/i);
  });

  test("dashboard:preview returns the email's sanitized HTML (or its text)", async () => {
    const h = harness();
    fakeTransport(() => "");
    const r = h.mutate("@email/lib:send", { from: "app@acme.test", to: "ana@x.test", subject: "Hi", html: `<p onclick="x()">Hello <script>alert(1)</script><a href="javascript:x">link</a></p>`, text: "Hello", idempotencyKey: "k-preview" }) as { id: string } | string;
    const id = typeof r === "string" ? r : r.id;
    const p = h.query("@email/dashboard:preview", { id }) as { subject: string; html: string; text: string };
    expect(p).toMatchObject({ subject: "Hi", to: "ana@x.test", text: "Hello" });
    expect(p.html).toContain("Hello");
    expect(p.html).not.toMatch(/script|onclick|javascript:/i);
    expect(h.query("@email/dashboard:preview", { id: "nope" })).toBeNull();
  });
});
