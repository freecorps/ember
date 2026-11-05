// Domain onboarding against a fake Cloudflare API: what is automated, what is left to the zone owner, and that
// nothing outside the domain is touched (other rules, the zone's routing settings).
import { describe, expect, it } from "vitest";
import { ensureEventSubscription, ensureSending, ensureWorkerRule, findZone, routingState, type CfCreds } from "../src/cloudflare.ts";

function fakeCf(opts: { routingEnabled?: boolean; subdomains?: string[] } = {}) {
  const calls: string[] = [];
  const state = {
    sending: [] as Array<{ tag: string; name: string; enabled: boolean }>,
    rules: [{ id: "r-other", enabled: true, matchers: [{ type: "literal", field: "to", value: "ops@acme.test" }], actions: [{ type: "forward", value: ["x@y.z"] }] }] as any[],
    subs: [] as any[],
  };
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace("/client/v4", "");
    const m = `${init.method ?? "GET"} ${path}`;
    calls.push(m + u.search);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (m === "GET /zones") return ok(u.searchParams.get("name") === "acme.test" ? [{ id: "z1", name: "acme.test" }] : []);
    if (m === "GET /zones/z1/email/sending/subdomains") return ok(state.sending);
    if (m === "POST /zones/z1/email/sending/subdomains") {
      const s = { tag: "s1", name: body.name, enabled: true };
      state.sending.push(s);
      return ok(s);
    }
    if (m === "GET /zones/z1/email/sending/subdomains/s1/dns") return ok([{ name: `cf-bounce.${state.sending[0]!.name}`, type: "MX", content: "route1.mx.cloudflare.net.", priority: 77, ttl: 1 }]);
    if (m === "GET /zones/z1/email/routing")
      return ok({ enabled: opts.routingEnabled ?? true, status: "ready", subdomains: (opts.subdomains ?? []).map((name) => ({ name, enabled: true, status: "ready" })) });
    if (m === "GET /zones/z1/email/routing/dns") return ok({ records: [{ name: u.searchParams.get("subdomain") ?? "acme.test", type: "MX", content: "route1.mx.cloudflare.net.", priority: 77 }] });
    if (m === "GET /zones/z1/email/routing/rules") return ok(state.rules);
    if (m === "POST /zones/z1/email/routing/rules") {
      const r = { id: `r${state.rules.length}`, ...body };
      state.rules.push(r);
      return ok(r);
    }
    if (m === "GET /accounts/acc/queues") return ok([{ queue_id: "q1", queue_name: "ember-mail-prod-email-events" }]);
    if (m === "GET /accounts/acc/event_subscriptions/subscriptions") return ok(state.subs);
    if (m === "POST /accounts/acc/event_subscriptions/subscriptions") {
      state.subs.push({ id: "sub1", ...body });
      return ok({ id: "sub1" });
    }
    return Response.json({ success: false, errors: [{ code: 7003, message: `unexpected ${m}` }] }, { status: 400 });
  }) as typeof fetch;
  const c: CfCreds = { accountId: "acc", apiToken: "t", fetch: f };
  return { c, calls, state };
}

describe("domain onboarding (Cloudflare API)", () => {
  it("finds the zone of a subdomain; sending onboarding is idempotent and returns its records", async () => {
    const { c, calls } = fakeCf();
    expect(await findZone(c, "mail.acme.test")).toEqual({ id: "z1", name: "acme.test" });
    expect(await findZone(c, "nope.test")).toBeNull();
    const a = await ensureSending(c, "z1", "mail.acme.test");
    expect(a.created).toBe(true);
    expect(a.records).toEqual([{ type: "MX", name: "cf-bounce.mail.acme.test", value: "route1.mx.cloudflare.net.", priority: 77, ttl: 1, purpose: "sending" }]);
    const b = await ensureSending(c, "z1", "mail.acme.test");
    expect(b.created).toBe(false);
    expect(calls.filter((x) => x.startsWith("POST")).length).toBe(1);
  });

  it("receiving: a subdomain not in the zone's routing subdomains is reported, not enabled", async () => {
    const { c, calls } = fakeCf({ subdomains: [] });
    const r = await routingState(c, { id: "z1", name: "acme.test" }, "mail.acme.test");
    expect(r).toMatchObject({ enabled: false, status: "subdomain_missing" });
    expect(r.note).toMatch(/Subdomains/);
    expect(calls.some((x) => x.startsWith("POST") || x.startsWith("DELETE") || x.startsWith("PATCH"))).toBe(false);
    const off = await routingState(fakeCf({ routingEnabled: false }).c, { id: "z1", name: "acme.test" }, "mail.acme.test");
    expect(off.status).toBe("zone_disabled");
    const ready = await routingState(fakeCf({ subdomains: ["mail.acme.test"] }).c, { id: "z1", name: "acme.test" }, "mail.acme.test");
    expect(ready).toMatchObject({ enabled: true, status: "ready", records: [{ name: "mail.acme.test", purpose: "receiving" }] });
  });

  it("routing rules: one literal rule per address to this Worker; an address routed elsewhere is left alone", async () => {
    const { c, state } = fakeCf();
    expect(await ensureWorkerRule(c, "z1", "support@acme.test", "ember-mail-prod")).toEqual({ id: "r1", created: true });
    expect(await ensureWorkerRule(c, "z1", "support@acme.test", "ember-mail-prod")).toEqual({ id: "r1", created: false });
    await expect(ensureWorkerRule(c, "z1", "ops@acme.test", "ember-mail-prod")).rejects.toThrow(/not changing it/);
    expect(state.rules[0]).toMatchObject({ id: "r-other", actions: [{ type: "forward" }] });
    expect(state.rules[1]).toMatchObject({ matchers: [{ type: "literal", field: "to", value: "support@acme.test" }], actions: [{ type: "worker", value: ["ember-mail-prod"] }] });
  });

  it("delivery events: an email.sending subscription per domain → the component queue (once)", async () => {
    const { c, state } = fakeCf();
    expect(await ensureEventSubscription(c, "z1", "mail.acme.test", "ember-mail-prod-email-events")).toEqual({ id: "sub1", created: true });
    expect(state.subs[0]).toMatchObject({ source: { type: "email.sending", zone_id: "z1", domain: "mail.acme.test" }, destination: { type: "queues.queue", queue_id: "q1" } });
    expect(state.subs[0].events).toContain("message.bounced");
    expect(await ensureEventSubscription(c, "z1", "mail.acme.test", "ember-mail-prod-email-events")).toEqual({ id: "sub1", created: false });
  });
});
