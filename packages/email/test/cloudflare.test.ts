// @freecorps/ember-email/cloudflare: domain onboarding against a fake Cloudflare API: what is automated, what is left to the zone owner, and that
// nothing outside the domain is touched (other rules, the zone's routing settings).
import { describe, expect, it } from "vitest";
import { destroyDomain, emailResources, ensureCatchAllRule, ensureEventSubscription, ensureSending, ensureWorkerRule, findZone, resolveAccountId, routingState, syncDomain, type CfCreds } from "../src/cloudflare/index.ts";

function fakeCf(opts: { routingEnabled?: boolean; subdomains?: string[]; routingDns?: { status: number; code: number }; sendingEnabled?: boolean } = {}) {
  const subdomains = [...(opts.subdomains ?? [])];
  const calls: string[] = [];
  const state = {
    sending: [] as Array<{ tag: string; name: string; enabled: boolean }>,
    rules: [{ id: "r-other", enabled: true, matchers: [{ type: "literal", field: "to", value: "ops@acme.test" }], actions: [{ type: "forward", value: ["x@y.z"] }] }] as any[],
    subs: [] as any[],
    catchAll: { enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] } as any,
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
      const s = { tag: "s1", name: body.name, enabled: opts.sendingEnabled ?? true };
      state.sending.push(s);
      return ok(s);
    }
    if (m === "GET /zones/z1/email/sending/subdomains/s1/dns") return ok([{ name: `cf-bounce.${state.sending[0]!.name}`, type: "MX", content: "route1.mx.cloudflare.net.", priority: 77, ttl: 1 }]);
    if (m === "GET /zones/z1/email/routing")
      return ok({ enabled: opts.routingEnabled ?? true, status: "ready", subdomains: subdomains.map((name) => ({ name, enabled: true, status: "ready" })) });
    if (m === "GET /zones/z1/email/routing/dns" && opts.routingDns) return Response.json({ success: false, errors: [{ code: opts.routingDns.code, message: "no" }] }, { status: opts.routingDns.status });
    if (m === "POST /zones/z1/email/routing/dns") {
      subdomains.push(body.name);
      return ok({});
    }
    if (m.startsWith("DELETE ")) return ok({ id: path.split("/").pop() });
    if (m === "GET /zones/z1/email/routing/dns") return ok({ records: [{ name: u.searchParams.get("subdomain") ?? "acme.test", type: "MX", content: "route1.mx.cloudflare.net.", priority: 77 }] });
    if (m === "GET /zones/z1/email/routing/rules") return ok(state.rules);
    if (m === "POST /zones/z1/email/routing/rules") {
      const r = { id: `r${state.rules.length}`, ...body };
      state.rules.push(r);
      return ok(r);
    }
    if (m === "GET /zones/z1/email/routing/rules/catch_all") return ok(state.catchAll);
    if (m === "PUT /zones/z1/email/routing/rules/catch_all") {
      state.catchAll = body;
      return ok(body);
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

  it("receiving: only a missing records view (404) is tolerated; auth/rate-limit/outage errors surface", async () => {
    const zone = { id: "z1", name: "acme.test" };
    const missing = await routingState(fakeCf({ subdomains: ["mail.acme.test"], routingDns: { status: 404, code: 1000 } }).c, zone, "mail.acme.test");
    expect(missing).toMatchObject({ enabled: true, status: "ready", records: [] });
    for (const status of [403, 429, 500]) {
      await expect(routingState(fakeCf({ subdomains: ["mail.acme.test"], routingDns: { status, code: 10000 } }).c, zone, "mail.acme.test")).rejects.toMatchObject({ name: "CfError", status });
    }
  });

  it("routing rules: one literal rule per address to this Worker; an address routed elsewhere is left alone", async () => {
    const { c, state } = fakeCf();
    expect(await ensureWorkerRule(c, "z1", "support@acme.test", "ember-mail-prod")).toEqual({ id: "r1", created: true });
    expect(await ensureWorkerRule(c, "z1", "support@acme.test", "ember-mail-prod")).toEqual({ id: "r1", created: false });
    await expect(ensureWorkerRule(c, "z1", "ops@acme.test", "ember-mail-prod")).rejects.toThrow(/not changing it/);
    expect(state.rules[0]).toMatchObject({ id: "r-other", actions: [{ type: "forward" }] });
    expect(state.rules[1]).toMatchObject({ matchers: [{ type: "literal", field: "to", value: "support@acme.test" }], actions: [{ type: "worker", value: ["ember-mail-prod"] }] });
  });

  it("catch-all: the zone's rule → this Worker when the apex has a catch-all mailbox; off again without one; never one routed elsewhere", async () => {
    const { c, state } = fakeCf();
    const { worker, eventsQueue } = emailResources("mail", "prod");
    const deps = { prev: null, mailboxes: ["geral@acme.test"], worker, queue: eventsQueue, catchAll: true };
    const d = await syncDomain(c, { name: "acme.test" }, deps);
    expect(d).toMatchObject({ status: "verified", catchAll: worker });
    expect(state.catchAll).toEqual({ enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [worker] }] });
    expect(await ensureCatchAllRule(c, "z1", worker)).toEqual({ created: false });
    // A subdomain cannot have one (the rule is the zone's).
    const { c: c2, state: s2 } = fakeCf({ subdomains: ["mail.acme.test"] });
    expect((await syncDomain(c2, { name: "mail.acme.test" }, { ...deps, mailboxes: ["x@mail.acme.test"] })).notes.join(" ")).toMatch(/only acme.test can have one/);
    expect(s2.catchAll.enabled).toBe(false);
    // No catch-all mailbox any more: the rule goes back off; destroyDomain does the same.
    const off = await syncDomain(c, { name: "acme.test" }, { ...deps, prev: d, catchAll: false });
    expect(off.catchAll).toBeUndefined();
    expect(state.catchAll).toMatchObject({ enabled: false, actions: [{ type: "drop" }] });
    const on = await syncDomain(c, { name: "acme.test" }, { ...deps, prev: off });
    expect(await destroyDomain(c, on)).toEqual([]);
    expect(state.catchAll).toMatchObject({ enabled: false, actions: [{ type: "drop" }] });
    // A catch-all forwarding elsewhere is left alone.
    state.catchAll = { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "forward", value: ["boss@else.test"] }] };
    expect((await syncDomain(c, { name: "acme.test" }, deps)).notes.join(" ")).toMatch(/routes mail elsewhere/);
    expect(state.catchAll.actions[0].type).toBe("forward");
  });

  it("delivery events: an email.sending subscription per domain → the component queue (once)", async () => {
    const { c, state } = fakeCf();
    expect(await ensureEventSubscription(c, "z1", "mail.acme.test", "ember-mail-prod-email-events")).toEqual({ id: "sub1", created: true });
    expect(state.subs[0]).toMatchObject({ source: { type: "email.sending", zone_id: "z1", domain: "mail.acme.test" }, destination: { type: "queues.queue", queue_id: "q1" } });
    expect(state.subs[0].events).toContain("message.bounced");
    expect(await ensureEventSubscription(c, "z1", "mail.acme.test", "ember-mail-prod-email-events")).toEqual({ id: "sub1", created: false });
  });

  it("syncDomain: sending + routing subdomain (only when asked) + one rule per mailbox of the domain + event subscription; destroyDomain undoes it", async () => {
    const { c, calls, state } = fakeCf({ subdomains: [] });
    const { worker, eventsQueue } = emailResources("mail", "prod");
    const deps = { prev: null, mailboxes: ["Support@Mail.acme.test", "privacy@mail.acme.test", "other@else.test"], worker, queue: eventsQueue };
    const pending = await syncDomain(c, { name: "Mail.Acme.test" }, deps);
    expect(pending).toMatchObject({ name: "mail.acme.test", status: "pending", routingStatus: "subdomain_missing", ruleIds: [], subscriptionId: "sub1", createdSending: true });
    expect(calls).not.toContain("POST /zones/z1/email/routing/dns");
    const d = await syncDomain(c, { name: "mail.acme.test", enableRouting: true }, { ...deps, prev: pending });
    expect(d).toMatchObject({ status: "verified", routingStatus: "ready", ruleIds: ["r1", "r2"], subscriptionId: "sub1", createdSending: true });
    expect(d.notes.join(" ")).toMatch(/only the dashboard can remove it/);
    expect(state.rules.slice(1).map((r) => r.matchers[0].value)).toEqual(["support@mail.acme.test", "privacy@mail.acme.test"]);
    expect(state.subs).toHaveLength(1);
    // Idempotent: nothing new on a re-sync.
    const again = await syncDomain(c, { name: "mail.acme.test" }, { ...deps, prev: d });
    expect(again.ruleIds).toEqual(["r1", "r2"]);
    expect(calls.filter((x) => x.startsWith("POST")).length).toBe(5); // sending, subscription, routing subdomain, 2 rules
    // A re-sync that lost its state (prev: null) still finds the rules already pointing at this Worker.
    const fresh = await syncDomain(c, { name: "mail.acme.test" }, { ...deps, prev: null });
    expect(fresh.ruleIds).toEqual(["r1", "r2"]);
    calls.length = 0;
    expect(await destroyDomain(c, again)).toEqual([]);
    expect(calls.filter((x) => x.startsWith("DELETE"))).toEqual([
      "DELETE /zones/z1/email/routing/rules/r1",
      "DELETE /zones/z1/email/routing/rules/r2",
      "DELETE /zones/z1/email/sending/subdomains/s1",
      "DELETE /accounts/acc/event_subscriptions/subscriptions/sub1",
    ]);
  });

  it("syncDomain: a domain outside the account's zones fails with a note; no subscription before sending is enabled", async () => {
    const out = await syncDomain(fakeCf().c, { name: "nope.test" }, { prev: null, mailboxes: [], worker: "w", queue: "q" });
    expect(out).toMatchObject({ status: "failed", records: [] });
    expect(out.notes[0]).toMatch(/not in a zone/);
    await expect(syncDomain(fakeCf().c, { name: "not a domain" }, { prev: null, mailboxes: [], worker: "w", queue: "q" })).rejects.toThrow(/invalid domain/);
    const { c, state } = fakeCf({ sendingEnabled: false, subdomains: ["mail.acme.test"] });
    const d = await syncDomain(c, { name: "mail.acme.test", receiving: false }, { prev: null, mailboxes: [], worker: "w", queue: "ember-mail-prod-email-events" });
    expect(d).toMatchObject({ status: "pending", receiving: false });
    expect(state.subs).toHaveLength(0);
  });

  it("destroyDomain: a sending domain it did not create stays; 404s are fine; other errors are returned", async () => {
    const calls: string[] = [];
    const c: CfCreds = { accountId: "acc", apiToken: "t", fetch: (async (u: string, init: RequestInit = {}) => {
      const p = new URL(u).pathname.replace("/client/v4", "");
      calls.push(`${init.method} ${p}`);
      if (p.endsWith("/r1")) return Response.json({ success: false, errors: [{ code: 1, message: "gone" }] }, { status: 404 });
      return Response.json({ success: false, errors: [{ code: 10000, message: "auth" }] }, { status: 403 });
    }) as typeof fetch };
    const errors = await destroyDomain(c, { name: "a.test", zoneId: "z", sendingTag: "s", createdSending: false, status: "verified", sending: true, receiving: true, records: [], ruleIds: ["r1", "r2"], subscriptionId: "sub", notes: [] });
    expect(calls).toEqual(["DELETE /zones/z/email/routing/rules/r1", "DELETE /zones/z/email/routing/rules/r2", "DELETE /accounts/acc/event_subscriptions/subscriptions/sub"]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^rule r2: .*403/);
  });

  it("resolveAccountId: CLOUDFLARE_ACCOUNT_ID or the token's only account (clear errors otherwise); emailResources names", async () => {
    const accounts = (result: unknown, status = 200) => (async () => Response.json({ success: status === 200, errors: status === 200 ? [] : [{ message: "bad token" }], result }, { status })) as unknown as typeof fetch;
    await expect(resolveAccountId("t", { env: {}, fetch: accounts([]) })).rejects.toThrow(/sees no account: set CLOUDFLARE_ACCOUNT_ID/);
    await expect(resolveAccountId("t", { env: {}, fetch: accounts([{ id: "a" }, { id: "b" }]) })).rejects.toThrow(/2 accounts/);
    await expect(resolveAccountId("t", { env: {}, fetch: accounts(null, 403) })).rejects.toThrow(/403 bad token/);
    expect(await resolveAccountId("t", { env: {}, fetch: accounts([{ id: "a" }]) })).toBe("a");
    expect(await resolveAccountId("t", { env: { CLOUDFLARE_ACCOUNT_ID: "x" }, fetch: accounts([]) })).toBe("x");
    expect(emailResources("mail", "prod")).toEqual({ worker: "ember-mail-prod", eventsQueue: "ember-mail-prod-email-events" });
    expect(emailResources("app", "dev", "mailer").eventsQueue).toBe("ember-app-dev-mailer-events");
  });
});
