# @freecorps/ember-email

Email as an [Ember](https://github.com/freecorps/ember) component, on Cloudflare Email Service (sending) and Email
Routing (receiving). It runs in your own Cloudflare account.

```ts
// ember/ember.config.ts
import { defineApp, createFunctionHandle } from "@freecorps/ember-server";
import { email } from "@freecorps/ember-email";

export default defineApp().use(email, {
  config: {
    domains: ["acme.com"],                                 // inbound domains routed to this Worker
    rateLimit: { rate: 100, period: 60_000 },              // per project
    hooks: { onInbound: createFunctionHandle("support:onInbound") },
  },
});
```

```ts
// ember/users.ts
import { Email } from "@freecorps/ember-email";
import { components, mutation } from "./_generated/server";
const email = new Email(components.email);

export const signup = mutation({
  args: { address: v.string(), name: v.string() },
  handler: (ctx, a) => {
    const id = ctx.db.insert("users", a);
    // Commits (or rolls back) with the insert; delivered by an action right after.
    email.send(ctx, { from: "Acme <hello@acme.com>", to: a.address, template: { name: "welcome", data: { name: a.name } }, idempotencyKey: `welcome:${id}` });
    return id;
  },
});
```

## What it does

- **Send.** `lib:send` / `email.send(ctx, ...)` is a mutation: atomic with the caller, optionally `sendAt`. It also
  handles idempotency keys per project, suppressions per project (hard bounces and complaints are added
  automatically), and a per-project token-bucket rate limit (nested `rateLimit` component, same transaction).
  Delivery goes through the `send_email` binding (the deploy adds it) or the REST API, with retries. Headers the
  provider refuses are dropped, keeping threading and `X-` headers.
- **Templates** are stored in the shard and use a small Mustache-like engine (`{{var}}`, `{{{raw}}}`, `#if`/`#each`)
  with a responsive layout. React Email works too: render it in an action and pass `html`.
- **Delivery events.** The component owns a Queue (`ember-<project>-<env>-email-events`). Point an Email Service
  event subscription for your sending domain at it. Events are deduplicated by `eventId`, the status only moves
  forward, and `lib:get` is reactive.
- **Inbound.** The component hooks the Worker's `email()` handler:
  - It routes mailbox addresses (`support@`, `privacy@`) and plus-addressed thread tokens. Unknown addresses are
    rejected.
  - It stores the raw `.eml` and the attachments in files (R2), and parses the message with `postal-mime`.
  - It reads DKIM, DMARC and SPF from Cloudflare's `Authentication-Results`.
  - It threads messages like a mail client, with no token in the Reply-To by default:
    - an answer that cites an email the mailbox sent joins its thread when the sender is the thread's contact or one
      of that email's recipients (In-Reply-To / References against the Message-ID the provider gave it, recorded when
      the send succeeds; DMARC not required, since only those recipients have that id);
    - a citation of an inbound message counts with DMARC pass from the contact;
    - then the same contact and subject, within 30 days, if the thread is not closed or spam;
    - a plus-addressed token (`support+t_…@`) still threads from any sender.
  - `replyToken: true` in the install config puts that token in the Reply-To of replies, composed emails and
    auto-replies, as before 0.5.4.
  - It handles spam per sender per hour and auto-replies without loops.
  - Your `onInbound` hook runs in the same transaction (tickets, push).
- **Inbox queries** for dashboards and mobile apps: `threads`, `thread`, `unread` (aggregate), `search`
  (`searchIndex`), `reply`, `note`, `markRead`, `markUnread`, `setStatus`, `assign`, `compose` (a new conversation
  from the mailbox, answers join it as above), `recent` (latest threads with their messages, for offline replicas) and
  `sent` (the mailbox's Sent view: threads it wrote in, by its latest send, paged with `before`).
  `reply` and `compose` take `attachments: [{ filename, contentType, file }]`, files already stored in the shard
  (uploaded with `ctx.storage.generateUploadUrl`). They go with the email and stay on the thread's outbound message
  (with their size). Mind the provider's message size: for a large file, put a download link in the text
  (`ctx.storage.getUrl(file, { download, expiresIn })`) and pass it with `link: true`. The email then has no MIME part
  for it, and the message still holds the file (the thread lists it, and it is not collected).

## Domains: `@freecorps/ember-email/cloudflare`

Puts a domain on Cloudflare for the component and removes it again. It only needs `fetch`, so it runs in a Worker
(with its own API token secret) or on an operator's machine (no token in the Worker). It has no storage, HTTP API
or keys: you keep the returned state.

```ts
import { destroyDomain, emailResources, resolveAccountId, syncDomain } from "@freecorps/ember-email/cloudflare";

const c = { apiToken, accountId: await resolveAccountId(apiToken, { env: process.env }) };
const { worker, eventsQueue } = emailResources("acme", "prod"); // ember-acme-prod, ember-acme-prod-email-events
let d = await syncDomain(c, { name: "mail.acme.com", enableRouting: true }, { prev: null, mailboxes: ["support@mail.acme.com"], worker, queue: eventsQueue });
// d.status: "pending" until Email Service finishes onboarding (a minute or two): sync again with { prev: d }.
// d.records: the DNS records involved; d.notes: what is missing or needs the zone owner.
await destroyDomain(c, d); // rules, event subscription, and the sending domain if this created it
```

What it does:

- **Sending:** it onboards the domain in Email Service. Cloudflare manages its records (bounce MX/SPF, DKIM, DMARC).
- **Receiving:** it checks Email Routing. For the zone apex, routing must already be on, because turning it on
  rewrites the zone's MX. For a subdomain, `enableRouting: true` creates the routing subdomain. No API removes a
  routing subdomain, so removal is a dashboard step.
- **Mailboxes:** it adds one literal rule per mailbox address on the domain → your Worker. It never changes a rule
  that routes somewhere else.
- **Events:** it adds an `email.sending` event subscription → the component's queue.

## Offline replicas: `@freecorps/ember-email/schema`

`emailSchema`: the component's tables only (no postal-mime), for clients composing a local replica schema.

## Example

[`examples/email-lite`](https://github.com/freecorps/ember/tree/main/examples/email-lite) is the smallest app on the
component (mailboxes, send, inbound). [freecorps/mail](https://github.com/freecorps/mail) is a full email service
built on it (Resend-style HTTP API, inbox, mobile app).

All the component's state lives in one shard (`config.shard`, default `global:main`).

See `docs/PLAN.md` §16 and `docs/design/contracts.md` ("Email") in the repository.

License: MIT.
