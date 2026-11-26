# @freecorps/ember-webhooks

Outbound webhooks for [Ember](https://github.com/freecorps/ember):

- [Standard Webhooks](https://www.standardwebhooks.com) signatures (HMAC-SHA256, WebCrypto) with secret rotation;
- retries with exponential backoff and jitter, and `Retry-After` honoured;
- a circuit breaker per endpoint, a dead-letter state and one-call replays.

A send is queued **in the caller's mutation**, so there is no paid invoice without its webhook. The HTTP calls are
actions run by a nested [`@freecorps/ember-workpool`](../workpool), with bounded parallelism per shard.

```sh
npm install @freecorps/ember-webhooks
```

## Install and send

```ts
// ember/ember.config.ts
import { webhooks } from "@freecorps/ember-webhooks";
export default defineApp().use(webhooks); // or .use(webhooks, { config: { retrySchedule: [...], breaker: { threshold: 5 } } })

// ember/billing.ts
import { Webhooks } from "@freecorps/ember-webhooks";
const hooks = new Webhooks(components.webhooks);

export const addEndpoint = mutation({
  args: { url: v.string() },
  handler: (ctx, a) => hooks.createEndpoint(ctx, { url: a.url, events: ["invoice.*"] }), // → { endpointId, secret }
});

export const pay = mutation({
  args: { invoiceId: v.id("invoices") },
  handler: (ctx, a) => {
    ctx.db.patch(a.invoiceId, { paid: true });
    hooks.send(ctx, "invoice.paid", { invoiceId: a.invoiceId }); // same transaction
  },
});
```

Endpoints and deliveries live in the **caller's shard**: an org shard holds that org's endpoints, and
`send` there reaches them.

## Receive

```ts
import { verifyWebhook } from "@freecorps/ember-webhooks/verify"; // WebCrypto only: Workers, Node ≥ 20, Deno, Bun

const event = await verifyWebhook(secret, request.headers, await request.text()); // throws WebhookVerificationError
```

Headers: `webhook-id` (the same on every attempt and replay, so dedupe on it), `webhook-timestamp` (seconds) and
`webhook-signature: v1,<base64 HMAC-SHA256(id.timestamp.body)>`. After `rotateSecret`, the new secret signs, and the
previous one also signs for the grace period (24 h by default). Older secrets still in their grace period keep
signing until their own expiry (at most 5 sign at once; `graceMs: 0` revokes every old one). Both signatures go space-separated in
`webhook-signature`, as the Standard Webhooks spec defines, so a receiver holding either secret verifies.

## Delivery

| Answer | What happens |
| --- | --- |
| 2xx | `delivered` |
| network error, timeout (10 s), 408, 429, 5xx | `failed`, then the next retry: 5 s, 30 s, 2 min, 10 min, 1 h, 6 h, 24 h (±20%). A `Retry-After` replaces the delay. After the last one: `dead` (`retrySchedule: []`: no retry) |
| any other status (3xx are not followed) | `dead` at once |

- **Circuit breaker:** 10 consecutive failed attempts open an endpoint's breaker. While it is open, new deliveries
  and due retries wait as `pending` (held) and are not attempted. After the cooldown (1 min by default) one held
  delivery goes as a half-open probe. If it succeeds, the breaker closes and every held delivery goes. If it fails,
  the breaker opens again. Attempts already queued check the breaker (and the enabled bit) when they start, so a
  backlog does not reach the endpoint while the breaker is open.
- **Replays:** `replay(deliveryId)` re-sends a dead, failed or delivered delivery. `replayDead(endpointId)` re-sends
  every dead delivery of an endpoint. A replay keeps the same `webhook-id` and starts a new round of retries.
- **Disabling an endpoint** makes `send` skip it and holds its retries. Enabling it closes the breaker and releases
  them.
- **Limits:** payloads up to 1 MiB, stored once per send. Payloads over 8 KB move to R2 (`ctx.storage`) on their first
  attempt. The first 1 KB of each response is kept. Delivered and dead deliveries are deleted after 30 days.

The Ember Dashboard has a **Webhooks** screen (per shard):
- endpoints, with an enabled switch, "Rotate secret" behind a typed confirmation, and "Replay dead";
- deliveries filtered by status, each with its attempt timeline and a **Replay** action.

## Cost

- A send writes 1 message row and 1 delivery row per matching endpoint, plus one workpool item each, in the caller's
  transaction. It reads every enabled endpoint of the shard to match events.
- Each attempt is one action plus one settling mutation that updates the delivery and the endpoint's breaker. A retry
  adds one scheduled job.

Contract: `docs/design/contracts.md`, section "Webhooks".
