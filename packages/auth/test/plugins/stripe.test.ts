/**
 * stripe: a Stripe customer for every sign-up (created from the Auth DO through the Stripe SDK's fetch client, here the
 * fake API), a checkout through `/subscription/upgrade`, and signed webhooks that activate and update the subscription.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PRICE_PRO, stripeClient } from "./auth.config.ts";
import { deferred, stripeApi } from "./fakes.ts";
import { Client, ORIGIN, password, query, rnd, signedUp, until } from "./helpers.ts";
import { worker } from "../helpers.ts";

const SECRET = "whsec_test_ember_plugins";

async function webhook(event: unknown, secret = SECRET) {
  const payload = JSON.stringify(event);
  const signature = await stripeClient.webhooks.generateTestHeaderStringAsync({ payload, secret });
  const res = await worker.fetch(`${ORIGIN}/api/auth/stripe/webhook`, { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body: payload });
  return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
}

const event = (type: string, object: unknown) => ({ id: `evt_${rnd()}`, object: "event", type, api_version: "2025-01-01", created: Math.floor(Date.now() / 1000), data: { object }, livemode: false, pending_webhooks: 0, request: null });

describe("stripe", () => {
  it("customer on sign-up, checkout, signed webhooks: checkout.session.completed and customer.subscription.updated", async () => {
    const before = stripeApi.calls.length;
    const { c, user, email } = await signedUp("stripe");
    expect(stripeApi.calls.slice(before)).toContain("POST /v1/customers");
    const session = (await c.req("/api/auth/get-session?disableCookieCache=true")).json;
    const customerId = session.user.stripeCustomerId as string;
    expect(stripeApi.customers.get(customerId)).toMatchObject({ email });

    // The profile outbox carries the new field to the app (it is plain data, not a secret), in write order: the
    // plugin sets it in its own `user.create.after`, which must not overtake the `create` (an upserting `users.sync`
    // would end on the stale `create`, without the customer id).
    const profiles = await until(async () => (await query("app:profiles", { userId: user.id })).body.value as { event: string; user: Record<string, unknown> }[], (p) => p.length >= 2);
    expect(profiles.map((p) => [p.event, p.user.stripeCustomerId ?? null])).toEqual([["create", null], ["update", customerId]]);

    const upgrade = await c.req("/api/auth/subscription/upgrade", { body: { plan: "pro", successUrl: "/billing/ok", cancelUrl: "/billing/cancel" } });
    expect(upgrade.status, upgrade.text).toBe(200);
    expect(upgrade.json.url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const checkout = stripeApi.checkouts.at(-1)!;
    expect(checkout).toMatchObject({ customer: customerId, client_reference_id: user.id, metadata: { userId: user.id } });
    const subscriptionId = checkout.metadata.subscriptionId!;
    const list = async () => (await c.req("/api/auth/subscription/list")).json as Array<{ id: string; status: string; plan: string; cancelAtPeriodEnd: boolean; stripeSubscriptionId?: string }>;
    const row = () =>
      runInDurableObject(env.AUTH.get(env.AUTH.idFromName("auth")), (_o, state) => state.storage.sql.exec(`SELECT status, referenceId FROM subscription WHERE id = ?`, subscriptionId).toArray()[0]);
    expect(await row()).toEqual({ status: "incomplete", referenceId: user.id });

    // A webhook with a bad signature is refused before anything is read.
    const sub = stripeApi.subscription({ id: `sub_${rnd()}`, customer: customerId, priceId: PRICE_PRO, status: "active", metadata: { subscriptionId } });
    const completed = event("checkout.session.completed", { id: checkout.id, object: "checkout.session", mode: "subscription", customer: customerId, subscription: sub.id, client_reference_id: user.id, metadata: checkout.metadata });
    expect((await webhook(completed, "whsec_wrong")).status).toBe(400);
    expect((await row())?.status).toBe("incomplete");

    // Signed: the plugin reads the subscription back from Stripe and activates the row.
    expect(await webhook(completed)).toMatchObject({ status: 200, json: { success: true } });
    expect(stripeApi.calls).toContain(`GET /v1/subscriptions/${sub.id}`);
    expect((await list()).find((s) => s.id === subscriptionId)).toMatchObject({ status: "active", plan: "pro", stripeSubscriptionId: sub.id, cancelAtPeriodEnd: false });

    const updated = stripeApi.subscription({ id: sub.id, customer: customerId, priceId: PRICE_PRO, status: "active", cancelAtPeriodEnd: true, metadata: { subscriptionId } });
    expect((await webhook(event("customer.subscription.updated", updated))).status).toBe(200);
    expect((await list()).find((s) => s.id === subscriptionId)).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
  });

  it("a slow Stripe does not block the Auth DO: other sign-ins are served while a sign-up waits on customer creation", async () => {
    const other = await signedUp("stripe-bystander");
    const gate = deferred();
    stripeApi.hold = gate.promise;
    const before = stripeApi.calls.length;
    try {
      const email = `slow-${rnd()}@example.test`;
      const pending = new Client().req("/api/auth/sign-up/email", { body: { email, password, name: "Slow" } });
      expect(await until(async () => stripeApi.calls.slice(before), (calls) => calls.includes("POST /v1/customers"))).toContain("POST /v1/customers");
      const t0 = Date.now();
      expect((await new Client().req("/api/auth/sign-in/email", { body: { email: other.email, password } })).status).toBe(200);
      expect((await other.c.req("/api/auth/get-session?disableCookieCache=true")).json.user.email).toBe(other.email);
      expect(Date.now() - t0).toBeLessThan(2_000);
      gate.resolve();
      expect((await pending).status).toBe(200);
    } finally {
      // Released here too, so a failed assertion above never leaves the sign-up hanging on the fake.
      gate.resolve();
      stripeApi.hold = null;
    }
  });
});
