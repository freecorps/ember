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
  - It threads messages by token, then by `In-Reply-To` (DMARC pass, same contact), then by subject.
  - It handles spam per sender per hour and auto-replies without loops.
  - Your `onInbound` hook runs in the same transaction (tickets, push).
- **Inbox queries** for dashboards and mobile apps: `threads`, `thread`, `unread` (aggregate), `search`
  (`searchIndex`), `reply`, `note`, `markRead`, `markUnread`, `setStatus`, `assign`, `compose` (a new conversation
  from the mailbox, answers join it by token) and `recent` (latest threads with their messages, for offline replicas).

All the component's state lives in one shard (`config.shard`, default `global:main`).

See `docs/PLAN.md` §16 and `docs/design/contracts.md` ("Email") in the repository.

License: MIT.
