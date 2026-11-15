import Stripe from "stripe";
import { serve } from "./_serve.js";

export default serve({
  async run() {
    // No httpClient option: the "workerd"/"worker" export of stripe picks its fetch client by itself.
    const stripe = new Stripe("sk_test_fake", { maxNetworkRetries: 0 });
    const customer = await stripe.customers.create({ email: "a@example.test" });
    const secret = "whsec_test";
    const payload = JSON.stringify({ id: "evt_1", object: "event", type: "customer.created", data: { object: customer } });
    const header = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
    const ev = await stripe.webhooks.constructEventAsync(payload, header, secret, undefined, Stripe.createSubtleCryptoProvider());
    return { customer: customer.id, event: ev.type };
  },
});
